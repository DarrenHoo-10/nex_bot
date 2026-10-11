import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type FileEntry } from "@earendil-works/pi-coding-agent";
import type { ModelPermit, RuntimeInput, WorkerConfig, WorkerEvent, WorkerReply } from "./contracts.ts";

let session: AgentSession | undefined;
const replies = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
const projected = new Set<string>();
let activeInvoke: string | undefined;
let purpose: "answer" | "compact" = "answer";
let config: WorkerConfig;
let manager: SessionManager;
let started = false;
function send(event: WorkerEvent) { process.send?.(event); }
function snapshot(): FileEntry[] {
  const header = manager.getHeader();
  if (!header) throw new Error("Session header missing");
  return [header, ...manager.getEntries()];
}
function rpc(event: WorkerEvent): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    replies.set(requestId, { resolve, reject });
    send({ ...event, requestId });
  });
}
function project(input: RuntimeInput, steering: boolean) {
  if (projected.has(input.id)) return;
  projected.add(input.id);
  const entry = manager.getBranch().find((e) => e.type === "custom_message" && e.customType === "nex.input" && (e.details as { inputId?: string } | undefined)?.inputId === input.id);
  if (entry?.type === "custom_message") {
    if (entry.content !== input.text || (entry.details as { hash: string }).hash !== input.hash) throw new Error("Input identity conflict");
    return;
  }
  const details = { inputId: input.id, hash: input.hash, seq: input.seq };
  if (steering && session) session.agent.steer({ role: "custom", customType: "nex.input", content: input.text, display: false, details, timestamp: Date.now() });
  else manager.appendCustomMessageEntry("nex.input", input.text, false, details);
}
async function execute(providerId: string, entryId: string, args: Record<string, unknown>) {
  return rpc({ type: "tool", providerId, entryId, args, entries: snapshot(), inputs: [...projected] });
}
async function main(value: WorkerConfig) {
  config = value;
  mkdirSync(config.dir, { recursive: true });
  const cwd = path.join(config.dir, "work"), agentDir = path.join(config.dir, "pi");
  mkdirSync(cwd, { recursive: true }); mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "auth.json"), "{}", { mode: 0o600 });
  manager = SessionManager.inMemory(cwd, undefined, config.entries);
  const settled = manager.getEntries().at(-1);
  if (settled?.type === "custom" && settled.customType === "nex.settled") {
    const data = settled.data as { inputs: string[]; text: string };
    if (config.inputs.every((input) => data.inputs.includes(input.id))) {
      await rpc({ type: "done", entries: snapshot(), inputs: data.inputs, text: data.text });
      process.disconnect?.(); return;
    }
  }
  // Replay only proposals lacking a result in their original source scope.
  const branch = manager.getBranch();
  for (let index = 0; index < branch.length; index++) {
    const source = branch[index];
    if (source.type !== "message" || source.message.role !== "assistant") continue;
    for (const part of source.message.content) {
      if (part.type !== "toolCall") continue;
      const later = branch.slice(index + 1);
      const next = later.findIndex((e) => e.type === "message" && e.message.role === "assistant" && e.message.content.some((p) => p.type === "toolCall" && p.id === part.id));
      const range = next < 0 ? later : later.slice(0, next);
      if (range.some((e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === part.id)) continue;
      if (part.name !== "broker") throw new Error("Unrecognized recovered tool");
      const result = await execute(part.id, source.id, part.arguments);
      manager.appendMessage({ role: "toolResult", toolCallId: part.id, toolName: "broker", content: [{ type: "text", text: JSON.stringify(result) }], isError: false, timestamp: Date.now() });
    }
  }
  // Public projection API: structured system messages are replayed by the SDK.
  // continue() deliberately skips AgentSession.prompt's prompt preparation.
  manager.appendMessage({ role: "system", content: config.systemPrompt, timestamp: Date.now() });
  for (const input of config.inputs) project(input, false);
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const api = config.provider === "anthropic" ? "anthropic-messages" : "openai-completions";
  runtime.registerProvider("nex", { name: "NexBot API", apiKey: config.apiKey, baseUrl: config.endpoint, api,
    models: [{ id: config.model, name: config.model, api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64_000, maxTokens: 8192 }] });
  const model = runtime.getModel("nex", config.model);
  if (!model) throw new Error("Model registration failed");
  const broker = defineTool({ name: "broker", label: "Core Broker", description: "Use granted Core capabilities. Actions: memory.search (query; own private and workspace shared memory), memory.reflect (query; synthesize own and shared evidence with citations), memory.read (documentId), memory.write (title,content,scope bot,documentId optional,expectedVersion; own private memory only), memory.delete (documentId,expectedVersion; withdraw a note, requiring approval), memory.forget (documentId,expectedVersion; permanently redact original/copies, requiring approval; affected tasks stop), agent.directory (current peer identities and capabilities), agent.delegate (botId,message), device.list (deviceId,path), device.read (deviceId,path), device.exec (deviceId,command). Select peers dynamically from the directory when information or ability is insufficient. Internal A2A, private memory and authorized reads are automatic. Dangerous commands require approval in the executing Agent's contact. Never access files or execute code outside this tool.",
    parameters: Type.Object({ action: Type.String(), query: Type.Optional(Type.String()), documentId: Type.Optional(Type.String()), title: Type.Optional(Type.String()), content: Type.Optional(Type.String()), scope: Type.Optional(Type.String()), expectedVersion: Type.Optional(Type.Integer()), botId: Type.Optional(Type.String()), message: Type.Optional(Type.String()), deviceId: Type.Optional(Type.String()), path: Type.Optional(Type.String()), command: Type.Optional(Type.String()) }),
    execute: async (providerId, args) => {
      const source = manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((p) => p.type === "toolCall" && p.id === providerId));
      if (!source) throw new Error("Tool proposal source missing");
      const result = await execute(providerId, source.id, args);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { source: "core" } };
    } });
  const settings = SettingsManager.inMemory({ defaultTools: [], cacheWarming: "off", defaultProjectTrust: "always", compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: config.systemPrompt });
  await loader.reload();
  session = (await createAgentSession({ cwd, agentDir, model, modelRuntime: runtime, sessionManager: manager, settingsManager: settings, resourceLoader: loader, noTools: "all", tools: ["broker"], customTools: [broker], thinkingLevel: "off" })).session;
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") send({ type: "delta", text: event.assistantMessageEvent.delta });
    if (event.type === "message_end" && event.message.role === "assistant") {
      send({ type: "snapshot", invokeId: activeInvoke, inputTokens: event.message.usage.input, outputTokens: event.message.usage.output, modelStatus: event.message.stopReason === "error" ? "failed" : event.message.stopReason === "aborted" ? "cancelled" : "succeeded" });
    }
  });
  const originalFetch = globalThis.fetch, endpoint = new URL(config.endpoint);
  let httpFailure: { status: number; address: string } | undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== endpoint.origin || url.username || url.password || !url.pathname.startsWith(endpoint.pathname.replace(/\/$/, "") + "/")) throw new Error("Blocked model network destination");
    const permit = await rpc({ type: "request", entries: snapshot(), inputs: [...projected], purpose }) as ModelPermit;
    activeInvoke = permit.invokeId;
    let body = init?.body;
    if (purpose === "answer") {
      if (typeof body !== "string") throw new Error("Unsupported model request body");
      const payload = JSON.parse(body);
      // Refresh at the final request boundary, including continuation after a
      // tool/approval. Replacing old Core system messages also prevents SDK
      // projections/compaction from restoring an obsolete contact identity.
      if (config.provider === "anthropic") payload.system = permit.systemPrompt;
      else {
        if (!Array.isArray(payload.messages)) throw new Error("Invalid model messages");
        const messages = payload.messages as Array<{ role: string }>;
        const role = messages.find((m) => m.role === "system" || m.role === "developer")?.role ?? "system";
        payload.messages = [{ role, content: permit.systemPrompt }, ...messages.filter((m) => m.role !== "system" && m.role !== "developer")];
      }
      body = JSON.stringify(payload);
    }
    httpFailure = undefined;
    const response = await originalFetch(input, { ...init, body, redirect: "error", signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000) });
    if (!response.ok) httpFailure = { status: response.status, address: url.origin + url.pathname };
    return response;
  };
  try {
    if (JSON.stringify(manager.buildSessionContext().messages).length > 160_000) {
      purpose = "compact";
      await session.compact("Preserve user requirements, outstanding task state and tool receipts. Do not infer new permissions. Keep private facts in this conversation only.");
      purpose = "answer";
      // Compaction emits no normal assistant message event; its invocation is
      // recorded but usage remains unknown rather than fabricated.
      send({ type: "snapshot", entries: snapshot(), invokeId: activeInvoke });
    }
    await session.agent.continue();
    const last = manager.buildSessionContext().messages.at(-1);
    if (last?.role !== "assistant" || last.stopReason !== "stop") {
      const detail = last?.role === "assistant" ? last.errorMessage ?? "Model did not finish" : "Model did not finish";
      if (httpFailure?.status === 404) throw new Error(`模型服务返回 404。请求地址：${httpFailure.address}。请检查 API 基础地址（OpenAI 兼容地址通常包含 /v1）、API 协议和模型 ID。服务响应：${detail}`);
      throw new Error(detail);
    }
    const result = last.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    // Only entries actually consumed by the SDK are acknowledged, not the
    // volatile steering queue. New input arriving at this boundary stays pending.
    const inputs = manager.getBranch().filter((e) => e.type === "custom_message" && e.customType === "nex.input").map((e) => (e as { details?: { inputId?: string } }).details?.inputId).filter((x): x is string => typeof x === "string");
    manager.appendCustomEntry("nex.settled", { inputs, text: result });
    // Wait for Core's durable acknowledgement before closing IPC. A large
    // snapshot can otherwise still be buffered when the process disconnects.
    await rpc({ type: "done", entries: snapshot(), inputs, text: result });
  } finally { globalThis.fetch = originalFetch; session.dispose(); }
}
process.on("message", (message: WorkerReply) => {
  if (message.type === "start" && message.config && !started) {
    started = true;
    void main(message.config).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      send({ type: "error", error: config?.apiKey ? detail.split(config.apiKey).join("[redacted]") : detail });
    }).finally(() => process.disconnect?.());
  }
  if (message.type === "reply" && message.requestId) {
    const pending = replies.get(message.requestId); replies.delete(message.requestId);
    if (message.error) pending?.reject(new Error(message.error)); else pending?.resolve(message.result);
  }
  if (message.type === "steer" && message.input) project(message.input, true);
  if (message.type === "stop") { session?.agent.abort(); for (const p of replies.values()) p.reject(new Error("Cancelled")); }
});
process.once("disconnect", () => { session?.agent.abort(); for (const p of replies.values()) p.reject(new Error("Core disconnected")); process.exit(0); });
