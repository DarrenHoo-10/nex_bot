import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { CoreStore, text, id } from "./store.ts";
import { TaskRuntime } from "./runtime.ts";
import { DeviceGateway } from "./devices.ts";
import { DeviceNode } from "./node.ts";
import { AgentModule } from "./agents.ts";
import { RoutineModule } from "./routines.ts";
import { directory } from "./policy.ts";
import { HindsightClient } from "./hindsight.ts";
import { ManagedMemoryService, bundledMemoryRuntime, type MemoryRuntimeOptions } from "./memory-service.ts";

export interface AppOptions { dir: string; key: Buffer; token: string; port?: number; host?: string; uiDir?: string; hindsight?: { endpoint: string; token: string }; memoryRuntime?: MemoryRuntimeOptions }
export async function createPersonalApp(options: AppOptions) {
  const store = new CoreStore(options.dir, options.key, options.token);
  const streams = new Set<ServerResponse>();
  let closing = false;
  const changed = () => { if (closing) return; for (const response of streams) response.write("event: change\ndata: {}\n\n"); };
  const runtime = new TaskRuntime(store, changed);
  const memoryService = new ManagedMemoryService(store, runtime.memory.ledger, options.hindsight ? undefined : options.memoryRuntime ?? bundledMemoryRuntime());
  const agents = new AgentModule(store, runtime);
  const routines = new RoutineModule(store, agents);
  agents.onPublished = (botId) => {
    if (closing) return;
    const unread = agents.contacts().reduce((count, bot) => count + Number(bot.unread_count), 0);
    process.send?.({ type: "inbox", unread, botId, name: store.get("SELECT name FROM bots WHERE id=?", botId)?.name });
  };
  let origin = "";
  const server = createServer((request, response) => { void route(request, response).catch((error: unknown) => {
    if (response.headersSent) { response.end(); return; }
    json(response, 400, { error: error instanceof Error ? error.message : "请求失败" });
  }); });
  const gateway = new DeviceGateway(store, server, () => { if (closing) return; runtime.completeDelegations(); runtime.startRecovered(); changed(); });
  runtime.deviceExecutor = (call, args) => gateway.execute(call, args);
  const node = new DeviceNode(store, changed);
  function json(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(value));
  }
  async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0; const buffers: Buffer[] = [];
    for await (const raw of request) { const buffer = Buffer.from(raw as Uint8Array); size += buffer.length; if (size > 256_000) throw new Error("请求过大"); buffers.push(buffer); }
    const parsed = JSON.parse(Buffer.concat(buffers).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid request");
    return parsed as Record<string, unknown>;
  }
  const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  async function route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", origin);
    // Browser requests must address this exact local server, preventing DNS
    // rebinding; Device Nodes authenticate at the dedicated upgrade endpoint.
    if (request.headers.host !== new URL(origin).host && request.headers.host !== `localhost:${new URL(origin).port}`) { json(response, 403, { error: "Invalid host" }); return; }
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (url.pathname === "/health") { json(response, 200, { app: "NexBot", backend: "personal-os", runtime: "pi/1.0.4" }); return; }
    const mutating = request.method !== "GET" && request.method !== "HEAD";
    if (mutating && request.headers.origin && request.headers.origin !== origin) { json(response, 403, { error: "Invalid origin" }); return; }
    if (url.pathname === "/api/session" && request.method === "POST") {
      const data = await body(request);
      if (!equal(String(data.token ?? ""), options.token)) { json(response, 401, { error: "Unauthorized" }); return; }
      response.setHeader("Set-Cookie", `nex=${options.token}; HttpOnly; SameSite=Strict; Path=/`);
      json(response, 200, { owner: "local", protocol: "local" }); return;
    }
    if (url.pathname.startsWith("/api/")) {
      const bearer = request.headers.authorization?.replace(/^Bearer /, "");
      const cookie = request.headers.cookie?.split(";").map((v) => v.trim()).find((v) => v.startsWith("nex="))?.slice(4);
      if (!equal(bearer ?? cookie ?? "", options.token)) { json(response, 401, { error: "Unauthorized" }); return; }
      if (url.pathname === "/api/events") {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        streams.add(response); response.write("event: change\ndata: {}\n\n"); request.once("close", () => streams.delete(response)); return;
      }
      if (url.pathname === "/api/state") { json(response, 200, { ...store.state(), memoryEngine: { ...runtime.memory.ledger.status(), service: memoryService.state }, bots: agents.contacts().map((bot) => ({ ...bot, ...store.get("SELECT version policy_version,policy_json FROM bot_policies WHERE bot_id=?", bot.id), ...store.get("SELECT expertise_json FROM bot_public_profiles WHERE bot_id=?", bot.id) })), directory: directory(store), routines: routines.list(), occurrences: routines.occurrences(), journal: store.all("SELECT * FROM agent_journal ORDER BY created_at DESC LIMIT 100"), onlineDevices: [...gateway.sockets.keys()], node: node.publicState(), dataDir: store.dir, runtime: "Pi 1.0.4", address: origin, lanEnabled: options.host === "0.0.0.0" }); return; }
      if (url.pathname === "/api/agents/messages" && request.method === "GET") {
        const botId = text(url.searchParams.get("bot"), 100), before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined;
        if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) throw new Error("消息位置无效");
        json(response, 200, { messages: agents.messages(botId, before), streaming: [...runtime.workers.values()].filter((w) => store.get("SELECT bot_id FROM tasks WHERE id=?", w.taskId)?.bot_id === botId).map((w) => ({ taskId: w.taskId, text: w.streaming })) }); return;
      }
      if (url.pathname === "/api/messages" && request.method === "GET") {
        const conv = text(url.searchParams.get("conversation"), 100);
        json(response, 200, { messages: store.all("SELECT * FROM transcript WHERE conversation_id=? ORDER BY created_at,rowid", conv), streaming: [...runtime.workers.values()].filter((w) => store.get("SELECT conversation_id FROM tasks WHERE id=?", w.taskId)?.conversation_id === conv).map((w) => ({ taskId: w.taskId, text: w.streaming })) }); return;
      }
      if (!mutating) { json(response, 404, { error: "Not found" }); return; }
      const data = await body(request);
      if (url.pathname === "/api/agents/input") { json(response, 202, agents.send(text(data.botId, 100), text(data.text), text(data.clientId, 200))); return; }
      if (url.pathname === "/api/agents/read") { agents.read(text(data.botId, 100), Number(data.seq)); changed(); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/routines") { json(response, 200, routines.save(data)); return; }
      if (url.pathname === "/api/routines/toggle") { if (typeof data.enabled !== "boolean") throw new Error("启用状态无效"); routines.toggle(text(data.id, 100), Number(data.version), data.enabled); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/routines/run") { routines.runNow(text(data.id, 100), text(data.clientId, 100)); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/config") { if (runtime.workers.size || memoryService.gateway.busy) throw new Error("请先等待模型请求结束再修改模型"); store.saveConfig(data); memoryService.start(); changed(); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/bots") { const botId = store.createBot(text(data.name, 80), data.instructions); agents.ensure(botId); changed(); json(response, 200, { id: botId }); return; }
      if (url.pathname === "/api/bots/update") {
        agents.updateProfile(data); json(response, 200, { ok: true }); return;
      }
      if (url.pathname === "/api/bots/policy") { agents.updatePolicy(data); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/bots/archive") { agents.archive(data); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/conversations") { const conversationId = store.createConversation(text(data.botId, 100)); changed(); json(response, 200, { id: conversationId }); return; }
      if (url.pathname === "/api/input") { const taskId = runtime.input(text(data.conversationId, 100), text(data.text), typeof data.clientId === "string" ? data.clientId : id()); json(response, 202, { taskId }); return; }
      if (url.pathname === "/api/cancel") { runtime.cancel(text(data.taskId, 100)); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/resume") { runtime.resume(text(data.taskId, 100)); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/approvals") { runtime.decide(text(data.id, 100), text(data.hash, 100), data.allow === true); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/memory") { const result = runtime.memory.write(text(data.botId, 100), data); changed(); json(response, 200, result); return; }
      if (url.pathname === "/api/memory/delete") { runtime.memory.remove(text(data.id, 100), Number(data.version)); changed(); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/devices") { json(response, 200, gateway.pair(text(data.name, 80))); return; }
      if (url.pathname === "/api/devices/revoke") { gateway.revoke(text(data.id, 100)); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/node") { json(response, 200, node.configure(data)); return; }
      if (url.pathname === "/api/node/reconcile") { node.reconcile(text(data.callId, 100), Number(data.version)); json(response, 200, { ok: true }); return; }
      json(response, 404, { error: "Not found" }); return;
    }
    if (!options.uiDir) { response.writeHead(404); response.end(); return; }
    const root = path.resolve(options.uiDir), file = path.resolve(root, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
    const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
    response.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" }); response.end(readFileSync(file));
  }
  const listen = (port: number) => new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, options.host ?? "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  try { await listen(options.port ?? 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && options.host !== "0.0.0.0") await listen(0);
    else { await runtime.close(); await node.close(); gateway.close(); store.close(); throw error; }
  }
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Server address unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  if (options.hindsight) runtime.memory.ledger.client = new HindsightClient(options.hindsight.endpoint, options.hindsight.token);
  if (store.config()) memoryService.start();
  runtime.memory.ledger.start();
  runtime.startRecovered();
  routines.start();
  return { server, store, runtime, agents, routines, gateway, node, memoryService, origin, async close() {
    closing = true;
    routines.close();
    await runtime.memory.ledger.close();
    await memoryService.close();
    gateway.close(); await node.close(); for (const response of streams) response.end();
    await runtime.close(); await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); store.close();
  } };
}

// Desktop owns credentials and sends them over its private child IPC, never argv.
if (process.send) {
  process.once("message", (message: { type: string; dir: string; key: string; token: string; uiDir: string; host?: string; port?: number }) => {
    if (message.type !== "boot") return;
    void createPersonalApp({ ...message, key: Buffer.from(message.key, "base64") }).then((app) => {
      process.send?.({ type: "ready", origin: app.origin });
      let closing = false;
      const close = () => { if (closing) return; closing = true; void app.close().finally(() => process.exit(0)); };
      process.once("disconnect", close); process.on("message", (m: { type?: string }) => { if (m.type === "quit") close(); });
    }).catch((e: unknown) => { process.send?.({ type: "error", error: e instanceof Error ? e.message : "启动失败" }); process.exit(1); });
  });
}
