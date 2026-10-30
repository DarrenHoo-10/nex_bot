import { Readable } from "node:stream";
import { HTML_PREVIEW_CSP, htmlPreviewShell } from '../../shared/html-preview-shell.mjs';
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
import { TodoModule, TodoConflict } from "./todos.ts";
import { RoutineModule } from "./routines.ts";
import { ClientIdentity } from "./clients.ts";
import { CoreIdentity } from "./identity.ts";
import { IdentityError } from "./identity-provider.ts";
import { ClientSync } from "./sync.ts";
import { directory } from "./policy.ts";
import { HindsightClient } from "./hindsight.ts";
import { ExternalMemoryPlugin } from "./memory-plugin.ts";
import { ConnectorModule } from "./connectors.ts";
import { FeishuModule, type RegisterAppFn } from "./feishu/module.ts";
import { sdkRegisterApp, wsTransportFactory, type TransportFactory } from "./feishu/transport.ts";
import { GOOGLE_CALLBACK, type GmailConfiguration } from "./gmail-provider.ts";
import type { AttachmentObjects } from './attachment-objects.ts';
export { OssAttachmentObjects } from './attachment-objects.ts';
import { ChatFiles } from "./chat-files.ts";
import { requestBody as body } from "./http-body.ts";
import { modelLimitScope, type ModelCatalogConfig } from "./model-limits.ts";
import { ClientDownloadsSource, type ClientDownloadsOptions } from "./client-downloads.ts";
import { approvalRuleLabel, approvalRuleScope, approvalRules, revokeApprovalRule } from "./approval-rules.ts";
import { ClientUpdateSource, type OssReleaseMirror } from "./client-updates.ts";
import type { RetrievalDefaults } from "./retrieval-config.ts";

export interface AppOptions { /** Server-wide defaults for memory retrieval models (from the environment); a user's own settings win. */ retrieval?: RetrievalDefaults; gmail?: GmailConfiguration; attachmentObjects?: AttachmentObjects; releaseMirror?: Pick<OssReleaseMirror, "manifest" | "signedUrl">; modelCatalog?: ModelCatalogConfig; clientDownloads?: ClientDownloadsOptions; accountWorkspaces?: boolean; publicCoreId?: string; serviceOrigin?: string; listen?: false; hostDevice?: false; dir: string; key: Buffer; token: string; port?: number; strictPort?: boolean; host?: string; publicOrigin?: string; /** Set only when a trusted local reverse proxy overwrites X-Forwarded-For with the real client address. */ trustProxy?: boolean; uiDir?: string; hindsight?: { endpoint: string; token: string }; memoryRuntime?: false; /** Only direct disposable test fixtures may opt out. Production service CLI never disables identity. */ identity?: false | { fixtureOrigin: string }; /** Only disposable test fixtures may inject a fake Feishu registration or transport. */ feishu?: { registerApp: RegisterAppFn; transport?: TransportFactory; fetchImpl?: typeof fetch } }

export async function createPersonalApp(options: AppOptions) {
  if (options.publicOrigin) { const publicUrl = new URL(options.publicOrigin); if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) throw new Error("公共 Core 地址须为 HTTPS 根地址"); }
  const store = new CoreStore(options.dir, options.key, options.token, options.modelCatalog);
  store.attachmentObjects = options.attachmentObjects;
  const clients = new ClientIdentity(store, options.publicCoreId), sync = new ClientSync(store);
  const downloads = new ClientDownloadsSource(options.clientDownloads), updates = new ClientUpdateSource(options.releaseMirror);
  const identity = options.identity === false ? undefined : new CoreIdentity(store, clients, options.identity?.fixtureOrigin);
  const authenticate = async (token: string) => {
    const session = identity ? await identity.authenticate(token) : clients.authenticate(token);
    return session;
  };
  const streams = new Map<ServerResponse, string>();
  let closing = false;
  let feishu!: FeishuModule;
  const changed = () => {
    if (closing) return;
    sync.prune(); const snapshot = sync.snapshot();
    for (const [response, token] of streams) {
      if (!(identity ? identity.locallyAllowed(token) : clients.authenticate(token))) { response.write("event: revoked\ndata: {}\n\n"); response.end(); streams.delete(response); }
      else response.write(`id: ${snapshot.cursor}\nevent: change\ndata: ${JSON.stringify(snapshot)}\n\n`);
    }
    feishu?.scanApprovals();
  };
  const runtime = new TaskRuntime(store, changed);
  runtime.memory.retrieval.config.defaults = options.retrieval ?? {};
  const connectors = new ConnectorModule(store, changed, options.gmail);
  runtime.connectorExecutor = (call, args, authorize) => feishu?.handles(args) ? feishu.execute(call, args, authorize) : connectors.execute(call, args, authorize);
  runtime.connectorDirectory = (botId) => connectors.directory(botId);
  if (identity) {
    runtime.authorizeTask = (task) => identity.authorizeTask(task);
    identity.onSessionLost = (sessionId) => {
      connectors.oauth.cancelSession(sessionId);
      for (const task of store.all("SELECT id FROM tasks WHERE authorized_session_id=? AND ended_at IS NULL", sessionId)) runtime.cancel(String(task.id), "登录失效或无法验证，任务已停止");
      if (!store.get("SELECT id FROM user_sessions WHERE protocol='native-v1' AND revoked_at IS NULL AND expires_at>?", Date.now())) {
        for (const worker of runtime.workers.values()) if (store.get("SELECT authorized_session_id FROM tasks WHERE id=?", worker.taskId)?.authorized_session_id === store.session) runtime.cancel(worker.taskId, "登录失效或无法验证，任务已停止");
      }
      changed();
    };
  }
  if (identity) {
    runtime.memory.ledger.authorizeWork = () => identity.authorizeTask({ authorized_session_id: store.session });
    runtime.memory.personal.authorize = () => identity.authorizeTask({ authorized_session_id: store.session });
  }
  const memoryPlugin = new ExternalMemoryPlugin(store, runtime.memory.ledger, changed);

  const agents = new AgentModule(store, runtime);
  runtime.memory.retrieval.resolveEntry = (botId, entryId) => {
    const [entry] = agents.search(botId, `entry:${entryId}`) as Array<{ id?: string; content?: unknown }>;
    return entry && typeof entry.content === "string" ? { id: entryId, content: entry.content } : undefined;
  };
  const files = new ChatFiles(store);
  const routines = new RoutineModule(store, agents);
  const todos = new TodoModule(store, agents);
  runtime.todoExecutor = (call, args) => todos.tool(call, args);
  runtime.routineExecutor = (call, args) => routines.tool(call, args);
  runtime.agentExecutor = (call, args) => agents.tool(call, args);
  // A change of who may see a topic is told in the conversation where the user asked for it.
  runtime.memory.personal.tree.notify = (botId, taskId, text, key) => agents.publish(botId, "system", "activity", text, key, taskId);
  feishu = new FeishuModule(store, changed, agents, runtime, {
    ...(options.feishu ?? { registerApp: sdkRegisterApp, transport: wsTransportFactory }),
    grantTools: (connectorId, version, botId, tools) => { connectors.grant({ id: connectorId, version, botId, tools }); },
  });
  if (identity) identity.channelAuthorize = (task) => feishu.channelAuthorize(task);
  agents.onPublished = (botId) => {
    if (closing) return;
    feishu.onPublished(botId);
    const unread = agents.contacts().reduce((count, bot) => count + Number(bot.unread_count), 0);
    process.send?.({ type: "inbox", unread, botId, name: store.get("SELECT name FROM bots WHERE id=?", botId)?.name });
  };
  let origin = "";
  let requestRouter: ((request: IncomingMessage, response: ServerResponse) => Promise<boolean>) | undefined;
  const server = createServer((request, response) => { void (async () => { if (!await requestRouter?.(request, response)) await route(request, response); })().catch((error: unknown) => {
    if (response.headersSent) { response.end(); return; }
    json(response, error instanceof IdentityError || error instanceof TodoConflict ? error.status : 400, { error: error instanceof Error ? error.message : "请求失败", ...(error instanceof IdentityError && error.status === 503 ? { code: "identity_unavailable" } : {}) });
  }); });
  const gateway = new DeviceGateway(store, server, () => { if (closing) return; runtime.completeDelegations(); runtime.startRecovered(); changed(); });
  runtime.deviceExecutor = (call, args) => gateway.execute(call, args);
  runtime.onCancel = (taskId) => { gateway.cancelTask(taskId); connectors.cancelTask(taskId); feishu?.cancelTask(taskId); runtime.memory.ledger.client?.cancelTask(taskId); };
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
      connectors: connectors.list(), connectorCatalog: connectors.catalog(),
      feishu: feishu.state(),
      sync: sync.snapshot(),
      hostDeviceId: gateway.hostDeviceId,
      memoryEngine: { ...runtime.memory.ledger.status(), service: memoryPlugin.status().status },
      memoryPlugin: memoryPlugin.status(),
      bots: agents.contacts().map((bot) => ({ ...bot, ...store.botModelSelection(String(bot.id)), approval_setting: store.get("SELECT mode FROM agent_approval_settings WHERE bot_id=?", bot.id)?.mode ?? "standard", approval_setting_version: store.get("SELECT version FROM agent_approval_settings WHERE bot_id=?", bot.id)?.version ?? 0, ...agents.policyView(String(bot.id)), ...store.get("SELECT expertise_json FROM bot_public_profiles WHERE bot_id=?", bot.id) })),
      approvalRules: approvalRules(store),
      approvals: base.approvals.map((approval) => ({ ...approval, remember_label: approvalRuleLabel(store, approvalRuleScope(JSON.parse(String(approval.arguments_json)))) })),
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
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (url.pathname === '/html-preview.html' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': HTML_PREVIEW_CSP + "; sandbox allow-scripts; frame-ancestors 'self'" });
      response.end(htmlPreviewShell()); return;
    }
    if (url.pathname === "/health") { json(response, 200, { app: "NexBot", backend: "personal-os", runtime: "pi/1.0.4", attachmentStorage: options.attachmentObjects ? "oss" : "database", ...(options.accountWorkspaces ? { accountWorkspaces: true } : {}) }); return; }
    const mutating = request.method !== "GET" && request.method !== "HEAD";
    if (mutating && request.headers.origin && request.headers.origin !== requestOrigin) { json(response, 403, { error: "Invalid origin" }); return; }
    const cookieValue = (name: string) => request.headers.cookie?.split(";").map((v) => v.trim()).find((v) => v.startsWith(name + "="))?.slice(name.length + 1) ?? "";
    const token = request.headers.authorization?.replace(/^Bearer /, "") ?? cookieValue("nex");
    if (url.pathname === GOOGLE_CALLBACK && request.method === "GET") {
      let connected = false;
      try { await connectors.oauth.callback(url.searchParams); connected = true; } catch { /* Details are available only to the initiating authenticated client. */ }
      response.writeHead(connected ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gmail · NexBot</title><body style="font:16px system-ui;margin:80px auto;padding:24px;max-width:480px"><h1>${connected ? "Gmail 已连接" : "连接未完成"}</h1><p>请返回 NexBot${connected ? " 选择可使用邮件的 Agent。" : " 查看连接状态并重试。"}</p></body></html>`);
      return;
    }
    if (url.pathname.startsWith("/api/connectors/") && mutating && (!request.headers["content-type"]?.startsWith("application/json") || request.headers["sec-fetch-site"] === "cross-site")) { json(response, 403, { error: "Invalid connector request" }); return; }
    const socketAddress = (request.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    // Behind a local reverse proxy every socket is loopback. Only when the operator declares that proxy trusted
    // do we read the last X-Forwarded-For hop it appended; otherwise the header is attacker-controlled.
    const forwarded = options.trustProxy && ["127.0.0.1", "::1"].includes(socketAddress) ? String(request.headers["x-forwarded-for"] ?? "").split(",").pop()?.trim().replace(/^::ffff:/, "") : undefined;
    const remoteAddress = forwarded || socketAddress;
    const loopback = ["127.0.0.1", "::1"].includes(remoteAddress);
    const privateRemote = loopback || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(remoteAddress);
    const bootstrap = loopback ? clients.authenticate(cookieValue("nex-bootstrap")) : undefined;
    if (url.pathname.startsWith("/api/auth/") && mutating && (!request.headers["content-type"]?.startsWith("application/json") || request.headers["sec-fetch-site"] === "cross-site")) { json(response, 403, { error: "Invalid login request" }); return; }
    // The OSS mirror, when configured, replaces GitHub links: installers download reliably in China.
    if (url.pathname === "/api/client/downloads" && request.method === "GET") { json(response, 200, { ...await downloads.current(), ...await updates.downloads(requestOrigin) }); return; }
    if (url.pathname === "/api/client/update" && request.method === "GET") { json(response, 200, await updates.check(url.searchParams.get("platform") ?? "", url.searchParams.get("version") ?? "", requestOrigin)); return; }
    const installer = /^\/api\/client\/installer\/(android|ios)\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
    if (installer && request.method === "GET") {
      let found: Awaited<ReturnType<typeof updates.installer>>;
      try { found = await updates.installer(installer[1], installer[2]); } catch { json(response, 502, { error: "安装包暂时无法下载" }); return; }
      if (!found || !found.response.body) { json(response, 404, { error: "安装包不存在" }); return; }
      response.writeHead(200, { "Content-Type": found.type, "Content-Length": found.entry.size, "Content-Disposition": `attachment; filename="${found.entry.file}"`, "Cache-Control": "no-store" });
      Readable.fromWeb(found.response.body as import("node:stream/web").ReadableStream).on("error", () => response.destroy()).pipe(response);
      return;
    }
    if (url.pathname === "/api/client/identity" && request.method === "GET") { json(response, 200, identity ? { ...identity.publicConfiguration(), version: 1, coreId: clients.coreId(), loginMethods: ["password"] } : { version: 1, coreId: clients.coreId(), mode: "local-owner", loginMethods: ["one-time-code"] }); return; }
    if (identity && url.pathname === "/api/auth/status" && request.method === "GET") { json(response, 200, await identity.status(token, bootstrap)); return; }
    if (identity && ["/api/auth/logout", "/api/client/logout"].includes(url.pathname) && request.method === "POST") {
      const session = identity.locallyAllowed(token); if (session) connectors.oauth.cancelSession(String(session.id));
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
      if (url.pathname.startsWith("/api/connectors/") && session.user_id !== store.owner) { json(response, 403, { error: "此账号没有管理连接器的权限" }); return; }
      if (url.pathname === "/api/connectors/oauth/status" && request.method === "GET") { json(response, 200, connectors.oauth.status(text(url.searchParams.get("id"), 100), String(session.id))); return; }
      if (request.method === "GET" && url.pathname.startsWith("/api/attachments/")) {
        const { row, bytes } = await files.file(text(url.pathname.slice("/api/attachments/".length), 100));
        if (!await authenticate(token)) { json(response, 401, { error: 'Unauthorized' }); return; }
        const preview = url.searchParams.get('preview') === '1' && ['image/png', 'image/jpeg', 'image/webp'].includes(String(row.mime));
        response.writeHead(200, { "Content-Type": preview ? String(row.mime) : "application/octet-stream", "Content-Disposition": `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(String(row.name))}`, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Length": bytes.length }); response.end(bytes); return;
      }
      if (url.pathname === "/api/events") {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        const event = sync.event(Number(request.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0));
        streams.set(response, token); response.write(`id: ${event.cursor}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`); request.once("close", () => streams.delete(response)); return;
      }
      if (url.pathname === "/api/clients" && request.method === "GET") { json(response, 200, { sessions: clients.list(), currentSessionId: session.id }); return; }
      if (url.pathname === "/api/memory/retrieval" && request.method === "GET") {
        if (session.user_id !== store.owner) { json(response, 403, { error: "此账号没有读取记忆检索设置的权限" }); return; }
        json(response, 200, runtime.memory.retrieval.config.view()); return;
      }
      if (url.pathname === "/api/memory/core" && request.method === "GET") {
        if (session.user_id !== store.owner) { json(response, 403, { error: "此账号没有读取核心记忆的权限" }); return; }
        json(response, 200, runtime.memory.core.view(text(url.searchParams.get("botId"), 100))); return;
      }
      if (url.pathname.startsWith("/api/todos")) {
        if (session.user_id !== store.owner) { json(response,403,{error:"此账号没有管理待办的权限"});return; }
        if (url.pathname === "/api/todos" && request.method === "GET") { json(response,200,{items:todos.list()});return; }
      }
      if (url.pathname === "/api/state") {
        const view = url.searchParams.get("view") === "summary" ? "summary" : "full";
        json(response, 200, stateBody(view, requestOrigin)); return;
      }
      if (url.pathname === "/api/agents/search" && request.method === "GET") {
        if(session.user_id!==store.owner){json(response,403,{error:'此账号没有搜索会话的权限'});return;}
        const result=agents.searchConversations(text(url.searchParams.get('q'),200),url.searchParams.has('before')?Number(url.searchParams.get('before')):undefined);
        json(response,200,{...result,sync:sync.snapshot()});return;
      }
      if (url.pathname === "/api/agents/messages" && request.method === "GET") {
        const botId = text(url.searchParams.get("bot"), 100), before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined;
        if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) throw new Error("消息位置无效");
        const after = url.searchParams.has("after") ? Number(url.searchParams.get("after")) : undefined;
        if (after !== undefined && (!Number.isSafeInteger(after) || after < 0 || before !== undefined)) throw new Error("消息位置无效");
        const around=url.searchParams.get('around');
        if(around&&(before!==undefined||after!==undefined))throw new Error('消息位置无效');
        const messages = around ? agents.messagesAround(botId,text(around,100)) : after === undefined ? agents.messages(botId, before) : agents.messagesAfter(botId, after);
        json(response, 200, { sync: sync.snapshot(), messages, hasMore: after !== undefined && messages.length === 200, streaming: [...runtime.workers.values()].filter((w) => store.get("SELECT t.bot_id FROM tasks t JOIN agent_task_links l ON l.task_id=t.id WHERE t.id=? AND l.origin='owner'", w.taskId)?.bot_id === botId).map((w) => ({ taskId: w.taskId, text: w.streaming })) }); return;
      }
      if (url.pathname === "/api/routines/occurrence" && request.method === "GET") {
        json(response, 200, routines.occurrence(text(url.searchParams.get("id"), 256))); return;
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

      if (url.pathname === "/api/client/logout") { connectors.oauth.cancelSession(String(session.id)); if (session.id !== store.session) clients.revoke(String(session.id)); response.setHeader("Set-Cookie", "nex=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"); changed(); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/connectors/oauth/start") {
        if (data.provider !== "gmail") throw new Error("不支持此连接器");
        json(response, 200, connectors.oauth.begin(data, requestOrigin, String(session.id), async () => { const current = await authenticate(token); if (!current || current.id !== session.id || current.user_id !== store.owner) throw new IdentityError(401, "登录已失效"); })); return;
      }
      if (url.pathname === "/api/connectors/oauth/cancel") { json(response, 200, connectors.oauth.cancel(text(data.id, 100), String(session.id))); return; }
      if (url.pathname === "/api/connectors/save") { json(response, 200, connectors.save(data)); return; }
      if (url.pathname === "/api/connectors/test") { json(response, 200, await connectors.test(data, async () => { if (!await authenticate(token)) throw new IdentityError(401, "登录已失效"); })); return; }
      if (url.pathname === "/api/connectors/grant") { json(response, 200, connectors.grant(data)); return; }
      if (url.pathname === "/api/connectors/toggle") { json(response, 200, connectors.toggle(data)); return; }
      if (url.pathname === "/api/connectors/delete") { json(response, 200, await connectors.remove(data)); return; }
      if (url.pathname === "/api/feishu/register/start") { json(response, 200, feishu.startRegister(data)); return; }
      if (url.pathname === "/api/feishu/register/cancel") { feishu.cancelRegister(); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/feishu/save") { json(response, 200, feishu.save(data)); return; }
      if (url.pathname === "/api/feishu/bind/start") { json(response, 200, feishu.bindStart(data)); return; }
      if (url.pathname === "/api/feishu/user-auth/start") { json(response, 200, feishu.startUserAuth(data)); return; }
      if (url.pathname === "/api/feishu/user-auth/cancel") { feishu.cancelUserAuth(); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/feishu/toggle") { json(response, 200, await feishu.toggle(data)); return; }
      if (url.pathname === "/api/feishu/delete") { json(response, 200, await feishu.remove(data)); return; }
      if (url.pathname === "/api/models/images") {
        if (session.user_id !== store.owner) { json(response, 403, { error: '此账号没有修改模型选择的权限' }); return; }
        const result = store.saveImageModelSelection(data);
        changed(); json(response, 200, result); return;
      }
      if (url.pathname === '/api/image-models/save' || url.pathname === '/api/image-models/delete') {
        json(response, 410, { error: '请刷新页面，从现有模型列表选择生图模型' }); return;
      }
      if (url.pathname === "/api/attachments") { const file = files.upload(data, String(session.id)); await files.persist(file.id); if (!await authenticate(token)) { json(response, 401, { error: "Unauthorized" }); return; } json(response, 200, file); return; }
      if (url.pathname === "/api/agents/input") {
        const botId = text(data.botId, 100), clientId = text(data.clientId, 200), attachments = data.attachments ?? [];
        const links = files.references(botId, attachments, String(session.id));
        const content = text(`${typeof data.text === "string" ? data.text.trim() : ""}${links ? "\n\n" + links : ""}`);
        const result = store.transaction(() => { const sent = agents.send(botId, content, clientId, String(session.id)); files.bind(attachments as string[], botId, clientId); return sent; });
        json(response, 202, result); return;
      }
      if (url.pathname === "/api/agents/read") { agents.read(text(data.botId, 100), Number(data.seq)); changed(); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/agents/topic") { json(response, 200, agents.newTopic(text(data.botId, 100))); return; }
      if (url.pathname === "/api/agents/messages/image/delete") {
        const result = await files.deleteMessageImage(text(data.botId, 100), text(data.messageId, 100), text(data.attachmentId, 100));
        changed(); json(response, 200, result); return;
      }
      if (url.pathname === "/api/todos/save") { json(response,200,todos.save(data));return; }
      if (url.pathname === "/api/todos/action") { json(response,200,todos.action(data,String(session.id)));return; }
      if (url.pathname === "/api/routines") { json(response, 200, routines.save(data)); return; }
      if (url.pathname === "/api/routines/toggle") { if (typeof data.enabled !== "boolean") throw new Error("启用状态无效"); routines.toggle(text(data.id, 100), Number(data.version), data.enabled); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/routines/run") { routines.runNow(text(data.id, 100), text(data.clientId, 100)); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/routines/delete") { routines.remove(text(data.id, 100), Number(data.version)); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/models/limits" || url.pathname === "/api/models/limits/refresh") {
        if (session.user_id !== store.owner) { json(response, 403, { error: "此账号没有读取模型配置的权限" }); return; }
        const scope = modelLimitScope(data);
        const refresh = url.pathname.endsWith("/refresh") ? await store.modelLimits.catalog.refresh({ force: data.force === true }) : undefined;
        if (!await authenticate(token)) throw new IdentityError(401, "登录已失效，请重新登录");
        const automatic = store.modelLimits.resolve(scope, { contextWindow: null, maxOutputTokens: null, contextBudget: null });
        json(response, 200, { ...store.modelLimitSettings(scope), automatic, refresh }); return;
      }
      if (url.pathname === "/api/models/visibility") {
        if (session.user_id !== store.owner) { json(response, 403, { error: "此账号没有修改模型配置的权限" }); return; }
        const result = store.saveModelVisibility(data); changed(); json(response, 200, result); return;
      }
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
      if (url.pathname === "/api/bots/model") { agents.updateModel(data); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/bots/policy") { agents.updatePolicy(data); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/bots/approval-mode") { agents.updateApprovalMode(data); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/bots/archive") { agents.archive(data); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/conversations") { const conversationId = store.createConversation(text(data.botId, 100)); changed(); json(response, 200, { id: conversationId }); return; }
      if (url.pathname === "/api/input") { const taskId = runtime.input(text(data.conversationId, 100), text(data.text), typeof data.clientId === "string" ? data.clientId : id(), String(session.id)); json(response, 202, { taskId }); return; }
      if (url.pathname === "/api/cancel") { runtime.cancel(text(data.taskId, 100)); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/resume") { runtime.resume(text(data.taskId, 100)); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/approvals") {
        if (typeof data.allow !== "boolean" || (data.remember !== undefined && typeof data.remember !== "boolean")) throw new Error("审批选项无效");
        runtime.decide(text(data.id, 100), text(data.hash, 100), data.allow, String(session.id), data.remember === true);
        json(response, 200, { ok: true }); return;
      }
      if (url.pathname === "/api/approvals/revoke") { revokeApprovalRule(store, text(data.id, 100), text(data.botId, 100)); changed(); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/memory") { const result = runtime.memory.write(text(data.botId, 100), data); changed(); json(response, 200, result); return; }
      if(url.pathname==='/api/memory/settings'){
        if(session.user_id!==store.owner){json(response,403,{error:'此账号没有修改记忆设置的权限'});return;}
        if(data.botId){throw new Error('记忆已改为统一开关，请更新客户端后设置');}
        json(response,200,runtime.memory.personal.saveGlobal(data));return;
      }
      if(url.pathname==='/api/memory/retrieval'){
        if(session.user_id!==store.owner){json(response,403,{error:'此账号没有修改记忆检索设置的权限'});return;}
        const saved=await runtime.memory.retrieval.config.save(data,async()=>{const current=await authenticate(token);if(!current||current.user_id!==store.owner)throw new IdentityError(401,'登录已失效，请重新登录');});
        changed();json(response,200,saved);return;
      }
      if(url.pathname==='/api/memory/core'){
        if(session.user_id!==store.owner){json(response,403,{error:'此账号没有修改核心记忆的权限'});return;}
        // The owner replaces one scope's two lists; the same version check and 1500-token cap as the model's patch.
        const botId=text(data.botId,100);
        runtime.memory.core.replace(data.scope==='workspace'?'workspace':'bot',botId,{about:data.about,topics:data.topics},data.version);
        changed();json(response,200,runtime.memory.core.view(botId));return;
      }
      if(url.pathname==='/api/memory/summary'){
        if(session.user_id!==store.owner){json(response,403,{error:'此账号没有读取记忆用量的权限'});return;}
        json(response,200,runtime.memory.personal.summary());return;
      }
      if(url.pathname==='/api/memory/monitor'){json(response,200,runtime.memory.personal.monitor(text(data.botId,100),[1,7,30].includes(Number(data.days))?Number(data.days):7));return;}
      if(url.pathname==='/api/memory/import'){if(data.fromTime!==undefined)runtime.memory.personal.importDates(text(data.botId,100),Number(data.fromTime),Number(data.toTime));else runtime.memory.personal.importHistory(text(data.botId,100),Number(data.from),Number(data.to));json(response,200,{queued:true});return;}
      if(url.pathname==='/api/history/search'){json(response,200,agents.search(text(data.botId,100),text(data.query,200)));return;}
      if (url.pathname === "/api/memory/delete") { runtime.memory.remove(text(data.id, 100), Number(data.version)); changed(); json(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/memory/reflect") { const result = await runtime.memory.reflect(text(data.botId, 100), text(data.query, 1000)); json(response, 200, result); return; }
      if (url.pathname === "/api/memory/recall") { json(response, 200, await runtime.memory.recall(text(data.botId, 100), text(data.query, 200))); return; }
      if (url.pathname === "/api/memory/expand") { json(response, 200, runtime.memory.expand(text(data.botId, 100), text(data.ref, 100))); return; }
      if (url.pathname === "/api/memory/publish") { json(response, 200, runtime.memory.publish(text(data.botId, 100), text(data.ref, 100), text(data.sourceHash, 100), text(data.intent, 200))); changed(); return; }
      if (url.pathname === "/api/memory/forget-preview") { json(response, 200, runtime.memory.privacy.preview(text(data.botId, 100), data)); return; }
      if (url.pathname === "/api/memory/forget") { json(response, 200, runtime.memory.forget(text(data.botId, 100), data, text(data.revision, 100))); changed(); return; }
      if (url.pathname === "/api/devices") { json(response, 200, gateway.pair(text(data.name, 80), String(session.id))); return; }
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
    else { clearInterval(heartbeat); await identity?.close(); await feishu.close(); await connectors.close(); await memoryPlugin.close(); await runtime.close(); await node.close(); gateway.close(); store.close(); throw error; }
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
  runtime.memory.personal.start();
  runtime.startRecovered();
  runtime.scheduleStartupMaintenance();
  routines.start();
  let archiveJob: Promise<unknown> | undefined;
  const archive = () => {
    if (closing || !options.attachmentObjects || archiveJob) return;
    archiveJob = files.migrate(() => closing).catch(() => { console.warn("Attachment archive migration will retry"); }).finally(() => { archiveJob = undefined; });
  };
  const archiveTimer = options.attachmentObjects ? setInterval(archive, 60000) : undefined;
  archiveTimer?.unref(); archive();
  return { server, store, runtime, agents, routines, gateway, node, memoryPlugin, identity, connectors, origin, handleRequest: route, changed, setRequestRouter(router: typeof requestRouter) { requestRouter = router; }, async close() {

    closing = true; clearInterval(heartbeat); clearInterval(archiveTimer); await archiveJob;
    await identity?.close();
    await heartbeatJob;
    routines.close();
    await feishu.close(); await connectors.close(); await memoryPlugin.close();
    await runtime.memory.personal.close();
    await runtime.memory.ledger.close();
    gateway.close(); await node.close(); for (const response of streams.keys()) response.end();
    await runtime.close(); await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); await Promise.allSettled(store.attachmentJobs.values()); store.close();
  } };
}
