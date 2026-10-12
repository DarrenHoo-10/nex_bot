import { createServer, type Server } from "node:http";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { CoreStore, id, now, type Row } from "./store.ts";
import { policyTools } from "./policy.ts";

type Json = Record<string, unknown>;
// Hindsight receives only this ephemeral service credential. The paid provider
// credential stays in Core's vault and never enters the daemon, argv or logs.
export class MemoryModelGateway {
  readonly token = randomBytes(32).toString("hex");
  readonly server: Server;
  origin = "";
  busy = false;
  closing = false;
  readonly controllers = new Map<AbortController, string>();
  authorize?: (task?: Row) => Promise<boolean>;
  constructor(readonly store: CoreStore) {
    this.server = createServer((request, response) => {
      const send = (status: number, value: unknown) => { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); };
      void (async () => {
        const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
        if (bearer.length !== this.token.length || !timingSafeEqual(Buffer.from(bearer), Buffer.from(this.token))) { send(401, { error: { message: "Unauthorized" } }); return; }
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") { send(404, { error: { message: "Not found" } }); return; }
        let bytes = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) { bytes += chunk.length; if (bytes > 256_000) throw new Error("request_too_large"); chunks.push(Buffer.from(chunk)); }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json;
        const bank = String(request.headers["x-nex-bank"] ?? ""), operation = String(request.headers["x-nex-operation"] ?? ""), purpose = String(request.headers["x-nex-purpose"] ?? "");
        const taskId = String(request.headers["x-nex-task-id"] ?? "");
        if (this.authorize && !await this.authorize(taskId ? store.get("SELECT * FROM tasks WHERE id=?", taskId) : undefined)) { send(401, { error: { message: "owner_login_required" } }); return; }
        if (this.closing || this.busy || (!taskId && store.get("SELECT id FROM tasks WHERE status='running' AND ended_at IS NULL"))) { send(429, { error: { message: "foreground_or_background_busy" } }); return; }
        if (!/^[0-9a-f-]{36}$/i.test(operation) || !["retain", "consolidate", "reflect"].includes(purpose) || !Array.isArray(body.messages) || body.stream === true) throw new Error("unattributed_memory_model_request");
        const binding = store.get("SELECT * FROM memory_bank_bindings WHERE provider_bank_id=? AND state!='deleted'", bank);
        if (!binding || (binding.bot_id && store.get("SELECT status FROM bots WHERE id=?", binding.bot_id)?.status !== "active")) throw new Error("bank_not_authorized");
        if (taskId) {
          const task = store.get("SELECT * FROM tasks WHERE id=? AND ended_at IS NULL AND status='running'", taskId);
          if (purpose !== "reflect" || !task || (binding.bot_id && binding.bot_id !== task.bot_id) || store.get("SELECT task_id FROM memory_forgotten_tasks WHERE task_id=?", taskId)) throw new Error("task_not_authorized");
          const policy = store.get("SELECT * FROM bot_policies WHERE bot_id=?", task.bot_id)!;
          if (!policyTools(policy).includes("memory.reflect") || !policyTools(policy).includes("memory.search")) throw new Error("memory_policy_revoked");
        }
        const model = store.modelConfig(), maximum = Math.min(8192, Number(body.max_completion_tokens ?? body.max_tokens ?? 4096));
        if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("invalid_token_reservation");
        const reserved = Buffer.byteLength(JSON.stringify(body), "utf8") + maximum;
        const startOfDay = Math.floor(now() / 86_400_000) * 86_400_000;
        const invoice = id();
        store.transaction(() => {
          const daily = store.get("SELECT COUNT(*) calls,COALESCE(SUM(reserved_tokens),0) tokens FROM memory_model_invocations WHERE task_id IS NULL AND created_at>=?", startOfDay)!;
          const own = store.get("SELECT COUNT(*) calls,COALESCE(SUM(reserved_tokens),0) tokens FROM memory_model_invocations WHERE task_id IS NULL AND bank_id=? AND created_at>=?", binding.id, startOfDay)!;
          // Failed/unknown requests keep their reservation; usage absence is
          // never interpreted as free. Each native retry has a separate row.
          // Automatic background maintenance retains its own daily allowance.
          // User-requested task reflection has no cumulative execution quota.
          if (!taskId && (Number(daily.calls) >= 100 || Number(daily.tokens) + reserved > 300_000 || Number(own.calls) >= 30 || Number(own.tokens) + reserved > 100_000)) throw new Error("memory_daily_budget_exhausted");
          store.insert("memory_model_invocations", { id: invoice, bank_id: binding.id, engine_operation_id: operation, purpose, task_id: taskId || null, reserved_tokens: reserved, status: "in_flight", created_at: now() });
        });
        this.busy = true;
        const controller = new AbortController(); this.controllers.set(controller, taskId);
        const timeout = setTimeout(() => controller.abort(), 90_000);
        try {
          // Drop attribution and caller credentials before forwarding. Only the
          // configured model/address may be selected by the daemon.
          const { user: _bank, model: _model, stream: _stream, ...clean } = body;
          void _bank; void _model; void _stream;
          let payload: Json = { ...clean, model: model.model, max_tokens: maximum, stream: false };
          delete payload.max_completion_tokens;
          let suffix = "/chat/completions", headers: Record<string, string> = { Authorization: `Bearer ${model.apiKey}`, "Content-Type": "application/json" };
          if (model.provider === "anthropic") {
            payload = toAnthropic(payload);
            suffix = new URL(model.endpoint).pathname.replace(/\/$/, "").endsWith("/v1") ? "/messages" : "/v1/messages";
            headers = { "x-api-key": model.apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
          }
          const upstream = await fetch(model.endpoint.replace(/\/$/, "") + suffix, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal, redirect: "error" });
          if (!upstream.ok) { await upstream.body?.cancel(); throw new Error(`provider_http_${upstream.status}`); }
          const raw = await upstream.text(); if (raw.length > 4_000_000) throw new Error("provider_response_too_large");
          let result = JSON.parse(raw) as Json;
          if (model.provider === "anthropic") result = fromAnthropic(result, body);
          const usage = result.usage as Json | undefined;
          const input = Number(usage?.prompt_tokens), output = Number(usage?.completion_tokens);
          store.run("UPDATE memory_model_invocations SET status='succeeded',input_tokens=?,output_tokens=?,finished_at=? WHERE id=?", Number.isSafeInteger(input) && input >= 0 ? input : null, Number.isSafeInteger(output) && output >= 0 ? output : null, now(), invoice);
          // Retired banks cannot receive a late model answer after correction.
          if (store.get("SELECT provider_bank_id FROM memory_bank_bindings WHERE id=?", binding.id)?.provider_bank_id !== bank || (taskId && !store.get("SELECT id FROM tasks WHERE id=? AND ended_at IS NULL AND status='running'", taskId))) throw new Error("bank_visibility_changed");
          send(200, result);
        } catch {
          store.run("UPDATE memory_model_invocations SET status='unknown',finished_at=? WHERE id=? AND status='in_flight'", now(), invoice);
          send(502, { error: { message: "memory_provider_request_failed" } });
        } finally { clearTimeout(timeout); this.controllers.delete(controller); this.busy = false; }
      })().catch((error: unknown) => { const quota = error instanceof Error && error.message === "memory_daily_budget_exhausted"; send(quota ? 429 : 403, { error: { message: quota ? "memory_daily_budget_exhausted" : "memory_request_denied" } }); });
    });
  }
  async start() {
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", () => { this.server.off("error", reject); resolve(); }); });
    const address = this.server.address(); if (!address || typeof address === "string") throw new Error("Gateway address unavailable");
    this.origin = `http://127.0.0.1:${address.port}`; return this.origin;
  }
  async close() {
    this.closing = true; for (const controller of this.controllers.keys()) controller.abort();
    await new Promise<void>((resolve) => { this.server.close(() => resolve()); this.server.closeAllConnections(); });
  }
  cancelTask(taskId: string) { for (const [controller, task] of this.controllers) if (task === taskId) controller.abort(); }
}

export function toAnthropic(body: Json): Json {
  const system: string[] = [], messages: Json[] = [];
  for (const item of body.messages as Json[]) {
    if (item.role === "system") { system.push(String(item.content ?? "")); continue; }
    if (item.role === "tool") { messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: item.tool_call_id, content: typeof item.content === "string" ? item.content : JSON.stringify(item.content) }] }); continue; }
    if (!["user", "assistant"].includes(String(item.role))) throw new Error("Unsupported background message");
    const content: Json[] = item.content ? [{ type: "text", text: String(item.content) }] : [];
    if (Array.isArray(item.tool_calls)) for (const call of item.tool_calls as Json[]) { const fn = call.function as Json; content.push({ type: "tool_use", id: call.id, name: fn.name, input: JSON.parse(String(fn.arguments)) }); }
    messages.push({ role: item.role, content: content.length ? content : [{ type: "text", text: " " }] });
  }
  const payload: Json = { model: body.model, system: system.join("\n\n"), messages, max_tokens: body.max_tokens };
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (Array.isArray(body.tools)) payload.tools = (body.tools as Json[]).map((tool) => { const fn = tool.function as Json; return { name: fn.name, description: fn.description, input_schema: fn.parameters }; });
  const format = body.response_format as Json | undefined;
  const schema = format?.json_schema as Json | undefined;
  if (schema?.schema) {
    payload.tools = [{ name: "memory_result", description: "Return the structured memory result", input_schema: schema.schema }];
    payload.tool_choice = { type: "tool", name: "memory_result" };
  } else if (format?.type === "json_object") payload.system = `${payload.system}\nReturn only a valid JSON object.`;
  return payload;
}
export function fromAnthropic(response: Json, request: Json): Json {
  if (!Array.isArray(response.content)) throw new Error("Invalid provider response");
  const structured = Boolean((request.response_format as Json | undefined)?.json_schema);
  const content = (response.content as Json[]).filter((p) => structured ? p.type === "tool_use" && p.name === "memory_result" : p.type === "text").map((p) => structured ? JSON.stringify(p.input) : String(p.text)).join("");
  const usage = response.usage as Json | undefined;
  const tools = structured ? [] : (response.content as Json[]).filter((p) => p.type === "tool_use").map((p) => ({ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input) } }));
  return { id: response.id, model: response.model, object: "chat.completion", created: Math.floor(now() / 1000), choices: [{ index: 0, message: { role: "assistant", content, ...(tools.length ? { tool_calls: tools } : {}) }, finish_reason: tools.length ? "tool_calls" : response.stop_reason === "max_tokens" ? "length" : "stop" }], usage: { prompt_tokens: usage?.input_tokens, completion_tokens: usage?.output_tokens } };
}
