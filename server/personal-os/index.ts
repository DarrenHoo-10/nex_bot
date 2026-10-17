import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import os from "node:os";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { CoreStore, text, id } from "./store.ts";
import { catalogSettings, fetchModelCatalog } from "../../shared/model-catalog.mjs";
import { TaskRuntime } from "./runtime.ts";
import { DeviceGateway } from "./devices.ts";
import { DeviceNode } from "./node.ts";
import { AgentModule } from "./agents.ts";
import { RoutineModule } from "./routines.ts";
import { ClientIdentity } from "./clients.ts";
import { CoreIdentity } from "./identity.ts";
import { IdentityError } from "./identity-provider.ts";
import { ClientSync } from "./sync.ts";
import { directory } from "./policy.ts";
import { HindsightClient } from "./hindsight.ts";
import { ExternalMemoryPlugin } from "./memory-plugin.ts";
import { ConnectorModule } from "./connectors.ts";
import { requestBody as body } from "./http-body.ts";

export interface AppOptions { accountWorkspaces?: boolean; publicCoreId?: string; serviceOrigin?: string; listen?: false; hostDevice?: false; dir: string; key: Buffer; token: string; port?: number; strictPort?: boolean; host?: string; publicOrigin?: string; /** Set only when a trusted local reverse proxy overwrites X-Forwarded-For with the real client address. */ trustProxy?: boolean; uiDir?: string; hindsight?: { endpoint: string; token: string }; memoryRuntime?: false; /** Only direct disposable test fixtures may opt out. Production service CLI never disables identity. */ identity?: false | { fixtureOrigin: string } }

export async function createPersonalApp(options: AppOptions) {
  if (options.publicOrigin) { const publicUrl = new URL(options.publicOrigin); if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) throw new Error("公共 Core 地址须为 HTTPS 根地址"); }
  const store = new CoreStore(options.dir, options.key, options.token);
  const clients = new ClientIdentity(store, options.publicCoreId), sync = new ClientSync(store);
  const identity = options.identity === false ? undefined : new CoreIdentity(store, clients, options.identity?.fixtureOrigin);
  const authenticate = async (token: string) => {
    const session = identity ? await identity.authenticate(token) : clients.authenticate(token);
    return session;
  };
  const streams = new Map<ServerResponse, string>();
  let closing = false;
  const changed = () => {
    if (closing) return;
    sync.prune(); const snapshot = sync.snapshot();
    for (const [response, token] of streams) {
      if (!(identity ? identity.locallyAllowed(token) : clients.authenticate(token))) { response.write("event: revoked\ndata: {}\n\n"); response.end(); streams.delete(response); }
      else response.write(`id: ${snapshot.cursor}\nevent: change\ndata: ${JSON.stringify(snapshot)}\n\n`);
    }
  };
  const runtime = new TaskRuntime(store, changed);
  const connectors = new ConnectorModule(store, changed);
  runtime.connectorExecutor = (call, args, authorize) => connectors.execute(call, args, authorize);
  runtime.connectorDirectory = (botId) => connectors.directory(botId);
  if (identity) {
    runtime.authorizeTask = (task) => identity.authorizeTask(task);
    identity.onSessionLost = (sessionId) => {
      for (const task of store.all("SELECT id FROM tasks WHERE authorized_session_id=? AND ended_at IS NULL", sessionId)) runtime.cancel(String(task.id), "登录失效或无法验证，任务已停止");
      if (!store.get("SELECT id FROM user_sessions WHERE protocol='native-v1' AND revoked_at IS NULL AND expires_at>?", Date.now())) {
        for (const worker of runtime.workers.values()) if (store.get("SELECT authorized_session_id FROM tasks WHERE id=?", worker.taskId)?.authorized_session_id === store.session) runtime.cancel(worker.taskId, "登录失效或无法验证，任务已停止");
      }
      changed();
    };
  }
  if (identity) runtime.memory.ledger.authorizeWork = () => identity.authorizeTask({ authorized_session_id: store.session });
  const memoryPlugin = new ExternalMemoryPlugin(store, runtime.memory.ledger, changed);

  const agents = new AgentModule(store, runtime);
  const routines = new RoutineModule(store, agents);
  runtime.routineExecutor = (call, args) => routines.tool(call, args);
  runtime.agentExecutor = (call, args) => agents.tool(call, args);
  agents.onPublished = (botId) => {
    if (closing) return;
    const unread = agents.contacts().reduce((count, bot) => count + Number(bot.unread_count), 0);
    process.send?.({ type: "inbox", unread, botId, name: store.get("SELECT name FROM bots WHERE id=?", botId)?.name });
  };
  let origin = "";
  let requestRouter: ((request: IncomingMessage, response: ServerResponse) => Promise<boolean>) | undefined;
  const server = createServer((request, response) => { void (async () => { if (!await requestRouter?.(request, response)) await route(request, response); })().catch((error: unknown) => {
    if (response.headersSent) { response.end(); return; }
    json(response, error instanceof IdentityError ? error.status : 400, { error: error instanceof Error ? error.message : "请求失败", ...(error instanceof IdentityError && error.status === 503 ? { code: "identity_unavailable" } : {}) });
  }); });
  const gateway = new DeviceGateway(store, server, () => { if (closing) return; runtime.completeDelegations(); runtime.startRecovered(); changed(); });
  runtime.deviceExecutor = (call, args) => gateway.execute(call, args);
  runtime.onCancel = (taskId) => { gateway.cancelTask(taskId); connectors.cancelTask(taskId); runtime.memory.ledger.client?.cancelTask(taskId); };
  runtime.deviceDirectory = () => gateway.inventory();
  const node = new DeviceNode(store, changed, options.hostDevice !== false);
  function json(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(value));
  }
  /** The client snapshot. `summary` drops the fields a phone never renders
   * while polling — memory bodies and the finished-work journal — and names
   * itself so a client can tell that its request was understood. Everything
   * else, including the default when `view` is absent or unknown, is what
   * every existing client already receives. */
  function stateBody(view: "full" | "summary", requestOrigin: string) {
    const base = store.state();
    return {
      ...base,
      ...(view === "summary" ? { view: "summary", memories: base.memories.map(({ content: _content, ...memory }) => memory) } : {}),
      connectors: connectors.list(),
      sync: sync.snapshot(),
      hostDeviceId: gateway.hostDeviceId,
      memoryEngine: { ...runtime.memory.ledger.status(), service: memoryPlugin.status().status },
      memoryPlugin: memoryPlugin.status(),
      bots: agents.contacts().map((bot) => ({ ...bot, ...store.get("SELECT version policy_version,policy_json FROM bot_policies WHERE bot_id=?", bot.id), ...store.get("SELECT expertise_json FROM bot_public_profiles WHERE bot_id=?", bot.id) })),
      directory: directory(store),
      routines: routines.list(),
      occurrences: routines.occurrences(),
      ...(view === "summary" ? {} : { journal: store.all("SELECT * FROM agent_journal ORDER BY created_at DESC LIMIT 100") }),
      onlineDevices: [...gateway.sockets.keys()],
      node: { ...node.publicState(), hosted: options.hostDevice === false },
      dataDir: store.dir,
      runtime: "Pi 1.0.4",
      address: requestOrigin,
      lanEnabled: options.host === "0.0.0.0",
    };
  }
  const loginAttempts = new Map<string, { count: number; at: number }>();
  /** One budget for every credential exchange: password login and session
   * refresh both spend from it, because both are attempts to turn a secret on
   * the wire into a session. */
  function throttleLogin(remoteAddress: string) {
    const address = remoteAddress || "unknown", at = Date.now();
    for (const [key, attempt] of loginAttempts) if (at - attempt.at > 60_000) loginAttempts.delete(key);
    const attempt = loginAttempts.get(address) ?? { count: 0, at };
    if (attempt.count >= 20 || (!loginAttempts.has(address) && loginAttempts.size >= 1000)) throw new IdentityError(429, "登录尝试过多，请稍后重试");
    attempt.count++; loginAttempts.set(address, attempt);
  }
  let checkingSessions = false;
  let heartbeatJob: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    changed(); if (!identity || checkingSessions || closing) return;
    checkingSessions = true;
    heartbeatJob = (async () => {
      await identity.retryRevocations();
      if (closing) return;
      for (const token of new Set(streams.values())) {
        if (closing) return;
        try { if (await authenticate(token)) continue; } catch { /* fail closed, including upstream outage */ }
        for (const [response, current] of streams) if (current === token) { response.write("event: revoked\ndata: {}\n\n"); response.end(); streams.delete(response); }
      }
      for (const worker of runtime.workers.values()) {
        if (closing) return;
        const task = store.get("SELECT * FROM tasks WHERE id=?", worker.taskId);
        if (task && !await identity.authorizeTask(task).catch(() => false)) runtime.cancel(worker.taskId, "登录失效或无法验证，任务已停止");
      }
    })().catch(() => {}).finally(() => { checkingSessions = false; });
  }, 15_000); heartbeat.unref();
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
    if (url.pathname === "/health") { json(response, 200, { app: "NexBot", backend: "personal-os", runtime: "pi/1.0.4", ...(options.accountWorkspaces ? { accountWorkspaces: true } : {}) }); return; }
    const mutating = request.method !== "GET" && request.method !== "HEAD";
    if (mutating && request.headers.origin && request.headers.origin !== requestOrigin) { json(response, 403, { error: "Invalid origin" }); return; }
    const cookieValue = (name: string) => request.headers.cookie?.split(";").map((v) => v.trim()).find((v) => v.startsWith(name + "="))?.slice(name.length + 1) ?? "";
    const token = request.headers.authorization?.replace(/^Bearer /, "") ?? cookieValue("nex");
    const socketAddress = (request.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    // Behind a local reverse proxy every socket is loopback. Only when the operator declares that proxy trusted
    // do we read the last X-Forwarded-For hop it appended; otherwise the header is attacker-controlled.
    const forwarded = options.trustProxy && ["127.0.0.1", "::1"].includes(socketAddress) ? String(request.headers["x-forwarded-for"] ?? "").split(",").pop()?.trim().replace(/^::ffff:/, "") : undefined;
    const remoteAddress = forwarded || socketAddress;
    const loopback = ["127.0.0.1", "::1"].includes(remoteAddress);
    const privateRemote = loopback || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(remoteAddress);
    const bootstrap = loopback ? clients.authenticate(cookieValue("nex-bootstrap")) : undefined;
    if (url.pathname.startsWith("/api/auth/") && mutating && (!request.headers["content-type"]?.startsWith("application/json") || request.headers["sec-fetch-site"] === "cross-site")) { json(response, 403, { error: "Invalid login request" }); return; }
    if (url.pathname === "/api/client/identity" && request.method === "GET") { json(response, 200, identity ? { ...identity.publicConfiguration(), version: 1, coreId: clients.coreId(), loginMethods: ["password"] } : { version: 1, coreId: clients.coreId(), mode: "local-owner", loginMethods: ["one-time-code"] }); return; }
    if (identity && url.pathname === "/api/auth/status" && request.method === "GET") { json(response, 200, await identity.status(token, bootstrap)); return; }
    if (identity && ["/api/auth/logout", "/api/client/logout"].includes(url.pathname) && request.method === "POST") {
      await identity.logout(token); response.setHeader("Set-Cookie", "nex=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"); changed(); json(response, 200, { ok: true }); return;
    }
    if (identity && url.pathname === "/api/auth/refresh" && request.method === "POST") {
      // Extending an existing bearer is not a password login: the HTTPS rule
      // that protects a password in transit does not apply, but the shared
      // attempt budget does. The response is shaped like /api/auth/respond so a
      // client has one code path for "I now have a token".
      throttleLogin(remoteAddress);
      const login = await identity.refresh(token);
      setCookie(response, login.token, requestOrigin, login.expiresAt); changed(); json(response, 200, login); return;
    }
    if (identity && ["/api/auth/start", "/api/auth/respond"].includes(url.pathname) && request.method === "POST") {
      if (!privateRemote && !requestOrigin.startsWith("https:")) throw new IdentityError(426, "远程账号登录须使用 HTTPS Core 地址");
      throttleLogin(remoteAddress);
      const data = await body(request);
      if (url.pathname.endsWith("/start")) { json(response, 200, identity.start(data, bootstrap)); return; }
      const login = await identity.respond(data, bootstrap);
      setCookie(response, login.token, requestOrigin, login.expiresAt); runtime.startRecovered(); changed(); json(response, 200, login); return;
    }
    if (url.pathname === "/api/client/login" && request.method === "POST") {
      if (identity) throw new IdentityError(410, "请使用 NexorAI 账号登录");
      const address = remoteAddress || "unknown", at = Date.now();
      for (const [key, attempt] of loginAttempts) if (at - attempt.at > 60_000) loginAttempts.delete(key);
      const attempt = loginAttempts.get(address) ?? { count: 0, at };
      if (attempt.count >= 10 || (!loginAttempts.has(address) && loginAttempts.size >= 1000)) { json(response, 429, { error: "连接尝试过多，请稍后重试" }); return; }
      attempt.count++; loginAttempts.set(address, attempt);
      const data = await body(request), session = clients.login(data.code, data.name);
      setCookie(response, session.token, requestOrigin, session.expiresAt); changed(); json(response, 200, session); return;
    }
    if (url.pathname === "/api/session" && request.method === "POST") {
      const data = await body(request);
      const local = clients.authenticate(String(data.token ?? ""));
      if (identity && local?.id === store.session && loopback) {
        response.setHeader("Set-Cookie", `nex-bootstrap=${String(data.token)}; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=28800`);
        json(response, 200, { authenticated: false, coreId: clients.coreId() }); return;
      }
      const session = await authenticate(String(data.token ?? ""));
      if (!session) { json(response, 401, { error: "Unauthorized" }); return; }
      setCookie(response, String(data.token), requestOrigin, Number(session.expires_at));
      json(response, 200, { authenticated: true, protocol: session.protocol, sessionId: session.id, coreId: clients.coreId(), expiresAt: session.expires_at }); return;
    }
    if (url.pathname.startsWith("/api/")) {
      const session = await authenticate(token);
      if (!session) { json(response, 401, { error: "Unauthorized" }); return; }
      if (url.pathname === "/api/events") {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        const event = sync.event(Number(request.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0));
        streams.set(response, token); response.write(`id: ${event.cursor}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`); request.once("close", () => streams.delete(response)); return;
      }
      if (url.pathname === "/api/clients" && request.method === "GET") { json(response, 200, { sessions: clients.list(), currentSessionId: session.id }); return; }
      if (url.pathname === "/api/state") {
        const view = url.searchParams.get("view") === "summary" ? "summary" : "full";
        json(response, 200, stateBody(view, requestOrigin)); return;
      }
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
      if (url.pathname === "/api/preview" && request.method === "GET") {
        if (url.searchParams.has("callId")) {
          const callId = text(url.searchParams.get("callId"), 100);
          const call = store.get("SELECT id,task_id,bot_id,tool_name,target_kind,target_id,arguments_json,result_json,status,created_at FROM tool_calls WHERE id=?", callId);
          if (!call || store.get("SELECT task_id FROM memory_forgotten_tasks WHERE task_id=?", call.task_id)) throw new Error("操作记录不存在或已遗忘");
          let resultPreview = "";
          if (call.result_json) {
            try {
              const parsed = JSON.parse(String(call.result_json));
              const { images: _images, ...rest } = (parsed && typeof parsed === "object" ? parsed : { value: parsed }) as Record<string, unknown>;
              resultPreview = JSON.stringify(rest, null, 2);
            } catch { resultPreview = String(call.result_json); }
          }
          json(response, 200, { kind: "tool", id: call.id, title: call.tool_name, status: call.status, arguments: call.arguments_json, content: resultPreview.slice(0, 24_000), createdAt: call.created_at }); return;
        }
        const targetPath = text(url.searchParams.get("path"), 1024);
        const rootDir = node.config?.root ? path.resolve(node.config.root) : "";
        if (rootDir && existsSync(rootDir)) {
          const resolved = path.resolve(rootDir, targetPath);
          if ((resolved === rootDir || resolved.startsWith(rootDir + path.sep)) && existsSync(resolved) && statSync(resolved).isFile()) {
            const stat = statSync(resolved);
            const content = readFileSync(resolved, "utf8").slice(0, 24_000);
            json(response, 200, { kind: "file", path: targetPath, title: path.basename(targetPath), exists: true, size: stat.size, updatedAt: stat.mtimeMs, content }); return;
          }
        }
        for (const call of store.all("SELECT task_id,arguments_json,result_json,created_at FROM tool_calls WHERE tool_name='device.read' AND status='succeeded' ORDER BY created_at DESC LIMIT 30")) {
          if (store.get("SELECT task_id FROM memory_forgotten_tasks WHERE task_id=?", call.task_id)) continue;
          try {
            const args = JSON.parse(String(call.arguments_json)) as { path?: string };
            if (args.path === targetPath || path.basename(String(args.path ?? "")) === path.basename(targetPath)) {
              const res = JSON.parse(String(call.result_json)) as { content?: string; text?: string };
              const content = String(res.content ?? res.text ?? call.result_json).slice(0, 24_000);
              json(response, 200, { kind: "file", path: targetPath, title: path.basename(targetPath), exists: true, size: Buffer.byteLength(content), updatedAt: call.created_at, content }); return;
            }
          } catch { /* ignore */ }
        }
        json(response, 200, { kind: "file", path: targetPath, title: path.basename(targetPath), exists: false, content: "未在当前授权共享目录或最近读取记录中找到该文件。可在「设备网络」中配置后端允许读取的目录或让 Agent 调用 device.read 读取。" }); return;
      }
      if (!mutating) { json(response, 404, { error: "Not found" }); return; }
      const data = await body(request);
      if (!await authenticate(token)) throw new IdentityError(401, "登录已失效，请重新登录");
      if (url.pathname === "/api/clients/invite") { if (identity) throw new IdentityError(410, "请在其他设备使用同一账号登录"); json(response, 200, clients.invite(data.name)); changed(); return; }
      if (url.pathname === "/api/clients/revoke") { if (identity) await identity.revoke(text(data.sessionId, 100)); else clients.revoke(text(data.sessionId, 100)); changed(); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/plugins/memory" || url.pathname === "/api/plugins/memory/test") {
        if (session.user_id !== store.owner) { json(response, 403, { error: "此账号没有配置记忆插件的权限" }); return; }
        json(response, 200, url.pathname.endsWith("/test") ? await memoryPlugin.test(data) : await memoryPlugin.save(data, async () => {
          const current = await authenticate(token);
          if (!current || current.user_id !== store.owner) throw new IdentityError(401, "登录已失效，请重新登录");
        })); return;
      }

      if (url.pathname === "/api/client/logout") { if (session.id !== store.session) clients.revoke(String(session.id)); response.setHeader("Set-Cookie", "nex=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"); changed(); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/connectors/save") { json(response, 200, connectors.save(data)); return; }
      if (url.pathname === "/api/connectors/test") { json(response, 200, await connectors.test(data, async () => { if (!await authenticate(token)) throw new IdentityError(401, "登录已失效"); })); return; }
      if (url.pathname === "/api/connectors/grant") { json(response, 200, connectors.grant(data)); return; }
      if (url.pathname === "/api/connectors/toggle") { json(response, 200, connectors.toggle(data)); return; }
      if (url.pathname === "/api/connectors/delete") { json(response, 200, connectors.remove(data)); return; }
      if (url.pathname === "/api/agents/input") { json(response, 202, agents.send(text(data.botId, 100), text(data.text), text(data.clientId, 200), String(session.id))); return; }
      if (url.pathname === "/api/agents/read") { agents.read(text(data.botId, 100), Number(data.seq)); changed(); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/routines") { json(response, 200, routines.save(data)); return; }
      if (url.pathname === "/api/routines/toggle") { if (typeof data.enabled !== "boolean") throw new Error("启用状态无效"); routines.toggle(text(data.id, 100), Number(data.version), data.enabled); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/routines/run") { routines.runNow(text(data.id, 100), text(data.clientId, 100)); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/models/list") {
        if (session.user_id !== store.owner) { json(response, 403, { error: "此账号没有读取模型列表的权限" }); return; }
        const settings = catalogSettings(data, store.config() ? store.modelConfig() : undefined);
        const result = await fetchModelCatalog(settings);
        if (!await authenticate(token)) throw new IdentityError(401, "登录已失效，请重新登录");
        json(response, 200, result); return;
      }
      if (url.pathname === "/api/config") { if (runtime.workers.size) throw new Error("请先等待模型请求结束再修改模型"); store.saveConfig(data); changed(); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/bots") { const botId = store.createBot(text(data.name, 80), data.instructions); agents.ensure(botId); changed(); json(response, 200, { id: botId }); return; }
      if (url.pathname === "/api/bots/update") {
        agents.updateProfile(data); json(response, 200, { ok: true }); return;
      }
      if (url.pathname === "/api/bots/appearance") { agents.updateAppearance(data); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/bots/policy") { agents.updatePolicy(data); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/bots/archive") { agents.archive(data); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/conversations") { const conversationId = store.createConversation(text(data.botId, 100)); changed(); json(response, 200, { id: conversationId }); return; }
      if (url.pathname === "/api/input") { const taskId = runtime.input(text(data.conversationId, 100), text(data.text), typeof data.clientId === "string" ? data.clientId : id(), String(session.id)); json(response, 202, { taskId }); return; }
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
        if (options.hostDevice === false || !loopback || (!identity && session.id !== store.session)) { json(response, 403, { error: "此账号没有配置后端设备能力的权限" }); return; }
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
    // Vite names everything under /assets/ by content hash, so those files can be cached indefinitely; the HTML entry must always revalidate.
    const cacheControl = url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    response.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream", "Cache-Control": cacheControl }); response.end(readFileSync(file));
  }
  const listen = (port: number) => new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, options.host ?? "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  try { if (options.listen !== false) await listen(options.port ?? 0); }
  catch (error) {
    if (!options.strictPort && (error as NodeJS.ErrnoException).code === "EADDRINUSE" && options.host !== "0.0.0.0") await listen(0);
    else { clearInterval(heartbeat); await identity?.close(); await connectors.close(); await memoryPlugin.close(); await runtime.close(); await node.close(); gateway.close(); store.close(); throw error; }
  }
  const address = server.address();
  if (options.listen === false && options.serviceOrigin) origin = options.serviceOrigin;
  else {
    if (!address || typeof address === "string") throw new Error("Server address unavailable");
    origin = `http://${options.host === "::1" ? "[::1]" : "127.0.0.1"}:${address.port}`;
  }
  // Register metadata without granting a root, shell or screen. Stable device
  // credentials are encrypted and independent of owner/client login tokens.
  const savedHost = store.get("SELECT ciphertext FROM secrets WHERE id='host-node-pair'");
  const hostPair = savedHost ? JSON.parse(store.decrypt(String(savedHost.ciphertext))) as { deviceId: string; token: string } : undefined;
  if (options.hostDevice !== false && (!node.config || (hostPair && node.config.token === hostPair.token))) {
    const pair = hostPair && store.get("SELECT id FROM devices WHERE id=? AND status='bound'", hostPair.deviceId) ? hostPair : gateway.pair(os.hostname());
    gateway.hostDeviceId = pair.deviceId;
    store.run("INSERT INTO secrets VALUES('host-node-pair',?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext", store.encrypt(JSON.stringify(pair)));
    node.configure({ origin, token: pair.token, root: node.config?.root ?? "", exec: true, computer: node.computer.available() });
  }
  if (options.hindsight) runtime.memory.ledger.client = new HindsightClient(options.hindsight.endpoint, options.hindsight.token);
  if (!options.hindsight) memoryPlugin.start();
  runtime.memory.ledger.start();
  runtime.startRecovered();
  routines.start();
  return { server, store, runtime, agents, routines, gateway, node, memoryPlugin, identity, origin, handleRequest: route, changed, setRequestRouter(router: typeof requestRouter) { requestRouter = router; }, async close() {

    closing = true; clearInterval(heartbeat);
    await identity?.close();
    await heartbeatJob;
    routines.close();
    await connectors.close(); await memoryPlugin.close();
    await runtime.memory.ledger.close();
    gateway.close(); await node.close(); for (const response of streams.keys()) response.end();
    await runtime.close(); await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); store.close();
  } };
}
