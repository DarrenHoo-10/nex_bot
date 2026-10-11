import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import os from "node:os";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { CoreStore, text, id } from "./store.ts";
import { TaskRuntime } from "./runtime.ts";
import { DeviceGateway } from "./devices.ts";
import { DeviceNode } from "./node.ts";
import { AgentModule } from "./agents.ts";
import { RoutineModule } from "./routines.ts";
import { ClientIdentity } from "./clients.ts";
import { ClientSync } from "./sync.ts";
import { directory } from "./policy.ts";
import { HindsightClient } from "./hindsight.ts";
import { ManagedMemoryService, bundledMemoryRuntime, type MemoryRuntimeOptions } from "./memory-service.ts";

export interface AppOptions { dir: string; key: Buffer; token: string; port?: number; host?: string; publicOrigin?: string; uiDir?: string; hindsight?: { endpoint: string; token: string }; memoryRuntime?: MemoryRuntimeOptions | false }
export async function createPersonalApp(options: AppOptions) {
  if (options.publicOrigin) { const publicUrl = new URL(options.publicOrigin); if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) throw new Error("公共 Core 地址须为 HTTPS 根地址"); }
  const store = new CoreStore(options.dir, options.key, options.token);
  const clients = new ClientIdentity(store), sync = new ClientSync(store);
  const streams = new Map<ServerResponse, string>();
  let closing = false;
  const changed = () => {
    if (closing) return;
    sync.prune(); const snapshot = sync.snapshot();
    for (const [response, token] of streams) {
      if (!clients.authenticate(token)) { response.write("event: revoked\ndata: {}\n\n"); response.end(); streams.delete(response); }
      else response.write(`id: ${snapshot.cursor}\nevent: change\ndata: ${JSON.stringify(snapshot)}\n\n`);
    }
  };
  const runtime = new TaskRuntime(store, changed);
  const memoryService = new ManagedMemoryService(store, runtime.memory.ledger, options.hindsight || options.memoryRuntime === false ? undefined : options.memoryRuntime ?? bundledMemoryRuntime());
  const agents = new AgentModule(store, runtime);
  const routines = new RoutineModule(store, agents);
  runtime.routineExecutor = (call, args) => routines.tool(call, args);
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
  runtime.deviceDirectory = () => gateway.inventory();
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
  const loginAttempts = new Map<string, { count: number; at: number }>();
  const heartbeat = setInterval(changed, 15_000); heartbeat.unref();
  function setCookie(response: ServerResponse, token: string, requestOrigin: string, expiresAt: number) {
    const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
    response.setHeader("Set-Cookie", `nex=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${requestOrigin.startsWith("https:") ? "; Secure" : ""}`);
  }
  async function route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", origin);
    // Browser requests must address this exact local server, preventing DNS
    // rebinding; Device Nodes authenticate at the dedicated upgrade endpoint.
    const hosts = new Set([new URL(origin).host, `localhost:${new URL(origin).port}`]);
    if (options.host === "0.0.0.0") for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) hosts.add(`${entry.family === "IPv6" ? `[${entry.address}]` : entry.address}:${new URL(origin).port}`);
    if (options.publicOrigin) hosts.add(new URL(options.publicOrigin).host);
    if (!request.headers.host || !hosts.has(request.headers.host)) { json(response, 403, { error: "Invalid host" }); return; }
    const requestOrigin = options.publicOrigin && request.headers.host === new URL(options.publicOrigin).host ? new URL(options.publicOrigin).origin : `http://${request.headers.host}`;
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (url.pathname === "/health") { json(response, 200, { app: "NexBot", backend: "personal-os", runtime: "pi/1.0.4" }); return; }
    const mutating = request.method !== "GET" && request.method !== "HEAD";
    if (mutating && request.headers.origin && request.headers.origin !== requestOrigin) { json(response, 403, { error: "Invalid origin" }); return; }
    if (url.pathname === "/api/client/identity" && request.method === "GET") { json(response, 200, { version: 1, coreId: clients.coreId(), mode: "local-owner", loginMethods: ["one-time-code"] }); return; }
    if (url.pathname === "/api/client/login" && request.method === "POST") {
      const address = request.socket.remoteAddress ?? "unknown", at = Date.now();
      for (const [key, attempt] of loginAttempts) if (at - attempt.at > 60_000) loginAttempts.delete(key);
      const attempt = loginAttempts.get(address) ?? { count: 0, at };
      if (attempt.count >= 10 || (!loginAttempts.has(address) && loginAttempts.size >= 1000)) { json(response, 429, { error: "连接尝试过多，请稍后重试" }); return; }
      attempt.count++; loginAttempts.set(address, attempt);
      const data = await body(request), session = clients.login(data.code, data.name);
      setCookie(response, session.token, requestOrigin, session.expiresAt); changed(); json(response, 200, session); return;
    }
    if (url.pathname === "/api/session" && request.method === "POST") {
      const data = await body(request);
      const session = clients.authenticate(String(data.token ?? ""));
      if (!session) { json(response, 401, { error: "Unauthorized" }); return; }
      setCookie(response, String(data.token), requestOrigin, Number(session.expires_at));
      json(response, 200, { owner: "local", protocol: session.protocol, sessionId: session.id, coreId: clients.coreId() }); return;
    }
    if (url.pathname.startsWith("/api/")) {
      const bearer = request.headers.authorization?.replace(/^Bearer /, "");
      const cookie = request.headers.cookie?.split(";").map((v) => v.trim()).find((v) => v.startsWith("nex="))?.slice(4);
      const token = bearer ?? cookie ?? "", session = clients.authenticate(token);
      if (!session) { json(response, 401, { error: "Unauthorized" }); return; }
      if (url.pathname === "/api/events") {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        const event = sync.event(Number(request.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0));
        streams.set(response, token); response.write(`id: ${event.cursor}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`); request.once("close", () => streams.delete(response)); return;
      }
      if (url.pathname === "/api/clients" && request.method === "GET") { json(response, 200, { sessions: clients.list(), currentSessionId: session.id }); return; }
      if (url.pathname === "/api/state") { json(response, 200, { ...store.state(), sync: sync.snapshot(), hostDeviceId: gateway.hostDeviceId, memoryEngine: { ...runtime.memory.ledger.status(), service: memoryService.state }, bots: agents.contacts().map((bot) => ({ ...bot, ...store.get("SELECT version policy_version,policy_json FROM bot_policies WHERE bot_id=?", bot.id), ...store.get("SELECT expertise_json FROM bot_public_profiles WHERE bot_id=?", bot.id) })), directory: directory(store), routines: routines.list(), occurrences: routines.occurrences(), journal: store.all("SELECT * FROM agent_journal ORDER BY created_at DESC LIMIT 100"), onlineDevices: [...gateway.sockets.keys()], node: node.publicState(), dataDir: store.dir, runtime: "Pi 1.0.4", address: requestOrigin, lanEnabled: options.host === "0.0.0.0" }); return; }
      if (url.pathname === "/api/agents/messages" && request.method === "GET") {
        const botId = text(url.searchParams.get("bot"), 100), before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined;
        if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) throw new Error("消息位置无效");
        const after = url.searchParams.has("after") ? Number(url.searchParams.get("after")) : undefined;
        if (after !== undefined && (!Number.isSafeInteger(after) || after < 0 || before !== undefined)) throw new Error("消息位置无效");
        const messages = after === undefined ? agents.messages(botId, before) : agents.messagesAfter(botId, after);
        json(response, 200, { sync: sync.snapshot(), messages, hasMore: after !== undefined && messages.length === 200, streaming: [...runtime.workers.values()].filter((w) => store.get("SELECT bot_id FROM tasks WHERE id=?", w.taskId)?.bot_id === botId).map((w) => ({ taskId: w.taskId, text: w.streaming })) }); return;
      }
      if (url.pathname === "/api/messages" && request.method === "GET") {
        const conv = text(url.searchParams.get("conversation"), 100);
        json(response, 200, { messages: store.all("SELECT * FROM transcript WHERE conversation_id=? ORDER BY created_at,rowid", conv), streaming: [...runtime.workers.values()].filter((w) => store.get("SELECT conversation_id FROM tasks WHERE id=?", w.taskId)?.conversation_id === conv).map((w) => ({ taskId: w.taskId, text: w.streaming })) }); return;
      }
      if (!mutating) { json(response, 404, { error: "Not found" }); return; }
      const data = await body(request);
      if (url.pathname === "/api/clients/invite") { json(response, 200, clients.invite(data.name)); changed(); return; }
      if (url.pathname === "/api/clients/revoke") { clients.revoke(text(data.sessionId, 100)); changed(); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/client/logout") { if (session.id !== store.session) clients.revoke(String(session.id)); response.setHeader("Set-Cookie", "nex=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"); changed(); json(response, 200, { ok: true }); return; }
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
      if (url.pathname === "/api/approvals") { runtime.decide(text(data.id, 100), text(data.hash, 100), data.allow === true, String(session.id)); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/memory") { const result = runtime.memory.write(text(data.botId, 100), data); changed(); json(response, 200, result); return; }
      if (url.pathname === "/api/memory/delete") { runtime.memory.remove(text(data.id, 100), Number(data.version)); changed(); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/memory/reflect") { const result = await runtime.memory.reflect(text(data.botId, 100), text(data.query, 1000)); json(response, 200, result); return; }
      if (url.pathname === "/api/memory/recall") { json(response, 200, await runtime.memory.recall(text(data.botId, 100), text(data.query, 200))); return; }
      if (url.pathname === "/api/memory/expand") { json(response, 200, runtime.memory.expand(text(data.botId, 100), text(data.ref, 100))); return; }
      if (url.pathname === "/api/memory/publish") { json(response, 200, runtime.memory.publish(text(data.botId, 100), text(data.ref, 100), text(data.sourceHash, 100), text(data.intent, 200))); changed(); return; }
      if (url.pathname === "/api/memory/forget-preview") { json(response, 200, runtime.memory.privacy.preview(text(data.botId, 100), data)); return; }
      if (url.pathname === "/api/memory/forget") { json(response, 200, runtime.memory.forget(text(data.botId, 100), data, text(data.revision, 100))); changed(); return; }
      if (url.pathname === "/api/devices") { json(response, 200, gateway.pair(text(data.name, 80))); return; }
      if (url.pathname === "/api/devices/revoke") { gateway.revoke(text(data.id, 100)); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/node" || url.pathname === "/api/node/reconcile") {
        if (session.id !== store.session || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) { json(response, 403, { error: "请在这台电脑本机授权设备能力；远程客户端使用自己的 Device Node" }); return; }
        if (url.pathname === "/api/node") json(response, 200, node.configure({ ...node.config, ...data }));
        else { node.reconcile(text(data.callId, 100), Number(data.version)); json(response, 200, { ok: true }); }
        return;
      }
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
  // Register metadata without granting a root, shell or screen. Stable device
  // credentials are encrypted and independent of owner/client login tokens.
  const savedHost = store.get("SELECT ciphertext FROM secrets WHERE id='host-node-pair'");
  const hostPair = savedHost ? JSON.parse(store.decrypt(String(savedHost.ciphertext))) as { deviceId: string; token: string } : undefined;
  if (!node.config || (hostPair && node.config.token === hostPair.token)) {
    const pair = hostPair && store.get("SELECT id FROM devices WHERE id=? AND status='bound'", hostPair.deviceId) ? hostPair : gateway.pair(os.hostname());
    gateway.hostDeviceId = pair.deviceId;
    store.run("INSERT INTO secrets VALUES('host-node-pair',?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext", store.encrypt(JSON.stringify(pair)));
    node.configure({ origin, token: pair.token, root: node.config?.root ?? "", exec: true, computer: node.computer.available() });
  }
  if (options.hindsight) runtime.memory.ledger.client = new HindsightClient(options.hindsight.endpoint, options.hindsight.token);
  if (store.config()) memoryService.start();
  runtime.memory.ledger.start();
  runtime.startRecovered();
  routines.start();
  return { server, store, runtime, agents, routines, gateway, node, memoryService, origin, async close() {
    closing = true; clearInterval(heartbeat);
    routines.close();
    await runtime.memory.ledger.close();
    await memoryService.close();
    gateway.close(); await node.close(); for (const response of streams.keys()) response.end();
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
