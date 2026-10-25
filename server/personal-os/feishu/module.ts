import { now, text, id, hash, type CoreStore, type Row } from "../store.ts";
import type { AgentModule } from "../agents.ts";
import type { TaskRuntime } from "../runtime.ts";
import { connectorAccess } from "../connectors.ts";
import { feishuOrigins, FeishuApi, FeishuApiError, missingScope, type Brand, type UserTokenGrant } from "./api.ts";
import { wsTransportFactory, type FeishuTransport, type TransportFactory, type RegisterAppFn } from "./transport.ts";
import { feishuTools, feishuToolNames, parseToolCall, queryString } from "./tools.ts";
import manifest from "./lark-scopes.json" with { type: "json" };

export type { RegisterAppFn };

const baselineEvents = ["im.message.receive_v1", "im.chat.member.bot.added_v1", "im.chat.member.bot.deleted_v1"];
const scopeManifest = manifest as { scopes: { tenant: string[]; user: string[] } };
const userTokenInvalid = new Set([99991661, 99991663, 99991668, 99991671, 99991676, 99991677]);

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function pick(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) { const value = source[key]; if (typeof value === "string" && value) return value; }
  return undefined;
}
function safe(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 300); }
function sleepAbort(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  });
}

/** 飞书富文本（post）与文本消息的纯文本提取。 */
function extractText(message: Record<string, unknown>): string {
  let payload: unknown;
  try { payload = JSON.parse(String(message.content ?? "{}")); } catch { return ""; }
  const data = record(payload);
  if (pick(message, ["message_type"]) === "text") return typeof data.text === "string" ? data.text : "";
  const out: string[] = [];
  if (typeof data.title === "string" && data.title.trim()) out.push(data.title.trim());
  const walk = (value: unknown, depth = 0) => {
    if (depth > 6) return;
    if (Array.isArray(value)) { value.forEach((item) => walk(item, depth + 1)); return; }
    const node = record(value);
    const tag = typeof node.tag === "string" ? node.tag : "";
    if (tag === "text" || tag === "a") { if (typeof node.text === "string") out.push(node.text); return; }
    if (tag === "at") { out.push(`@${typeof node.user_name === "string" ? node.user_name : "成员"}`); return; }
    if (tag === "img" || tag === "media" || tag === "file") { out.push(tag === "img" ? "[图片]" : tag === "media" ? "[视频]" : "[文件]"); return; }
    for (const child of Object.values(node)) if (child && typeof child === "object") walk(child, depth + 1);
  };
  walk(data.content);
  return out.join(" ").replace(/[ \t]+/g, " ");
}

function markdownCard(markdown: string, actions?: Array<{ text: string; value: Record<string, unknown>; style?: string }>) {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: markdown } },
      ...(actions?.length ? [{ tag: "hr" }, { tag: "action", actions: actions.map((a) => ({ tag: "button", text: { tag: "plain_text", content: a.text }, type: a.style ?? "default", value: a.value })) }] : []),
    ],
  });
}

function splitChunks(text: string, limit = 3500, max = 5): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let at = 0;
  while (at < text.length && parts.length < max) { parts.push(text.slice(at, at + limit)); at += limit; }
  if (at < text.length) parts[parts.length - 1] += "\n（内容过长已截断，请在 NexBot 查看完整回复）";
  return parts;
}

interface RegisterJob {
  stage: "preparing" | "qr" | "done" | "error";
  botId: string;
  url?: string;
  expiresAt?: number;
  error?: string;
  controller: AbortController;
}

export interface FeishuModuleOptions { registerApp: RegisterAppFn; transport?: TransportFactory; fetchImpl?: typeof fetch; grantTools?: (connectorId: string, version: number, botId: string, tools: string[]) => void; devicePollMs?: number }

/**
 * 飞书连接器：一个自建应用接入一个助手。消息经官方长连接进出，
 * 回复与审批用卡片；凭据只存 vault，不进状态、日志或模型上下文。
 */
export class FeishuModule {
  private readonly api: FeishuApi;
  private readonly transportFactory: TransportFactory;
  private job: RegisterJob | undefined;
  private userAuth?: { stage: "polling" | "done" | "error"; url?: string; expiresAt?: number; error?: string; controller: AbortController };
  private readonly transports = new Map<string, FeishuTransport>();
  private readonly active = new Map<AbortController, string>();
  private readonly refreshing = new Map<string, Promise<UserTokenGrant | null>>();
  private scanning = false;
  private closed = false;

  constructor(private readonly store: CoreStore, readonly changed: () => void, private readonly agents: AgentModule, private readonly runtime: TaskRuntime, private readonly options: FeishuModuleOptions) {
    this.api = new FeishuApi(options.fetchImpl);
    this.transportFactory = options.transport ?? wsTransportFactory;
  }

  state() {
    return {
      ...(this.job ? { job: { stage: this.job.stage, ...(this.job.url ? { url: this.job.url } : {}), ...(this.job.expiresAt ? { expiresAt: this.job.expiresAt } : {}), ...(this.job.error ? { error: this.job.error } : {}) } } : {}),
      ...(this.userAuth ? { userAuth: { stage: this.userAuth.stage, ...(this.userAuth.url ? { url: this.userAuth.url } : {}), ...(this.userAuth.expiresAt ? { expiresAt: this.userAuth.expiresAt } : {}), ...(this.userAuth.error ? { error: this.userAuth.error } : {}) } } : {}),
      apps: this.store.all("SELECT a.connector_id AS id, a.app_id, a.brand, a.connection AS status, a.error, a.owner_open_id, a.bot_id, a.user_token, a.user_scopes_json, a.user_token_expires_at, c.enabled, c.version FROM personal_feishu_apps a JOIN personal_connectors c ON c.id=a.connector_id ORDER BY a.created_at")
        .map((row) => ({
          id: String(row.id), appId: String(row.app_id), brand: String(row.brand), status: String(row.status), error: row.error === null ? null : String(row.error),
          ownerBound: !!row.owner_open_id, botId: String(row.bot_id), botName: String(this.store.get("SELECT name FROM bots WHERE id=?", String(row.bot_id))?.name ?? ""),
          enabled: row.enabled === 1, version: Number(row.version),
          userAuthorized: !!row.user_token, userScopes: JSON.parse(String(row.user_scopes_json ?? "[]")) as string[], userExpiresAt: row.user_token_expires_at === null ? null : Number(row.user_token_expires_at),
        })),
    };
  }

  /** 飞书来源的任务以连接为授权锚点：连接开启即允许执行。 */
  channelAuthorize(task: Row): boolean {
    return !!this.store.get("SELECT m.task_id FROM personal_feishu_messages m JOIN personal_feishu_apps a ON a.app_id=m.app_id JOIN personal_connectors c ON c.id=a.connector_id WHERE m.task_id=? AND c.enabled=1", String(task.id));
  }

  startRegister(data: Record<string, unknown>) {
    const botId = text(data.botId, 100);
    if (!this.store.get("SELECT id FROM bots WHERE id=? AND status='active' AND workspace_id=? AND owner_user_id=?", botId, this.store.workspace, this.store.owner)) throw new Error("Agent 不存在");
    if (this.store.get("SELECT connector_id FROM personal_feishu_apps")) throw new Error("已连接飞书应用，请先移除");
    if (this.job && this.job.stage !== "done" && this.job.stage !== "error") throw new Error("已有进行中的扫码，请先取消");
    const controller = new AbortController();
    const job: RegisterJob = { stage: "preparing", botId, controller };
    this.job = job;
    this.changed();
    void this.registerFlow(job);
    return { started: true };
  }

  cancelRegister() {
    if (!this.job) return;
    this.job.controller.abort();
    this.job = undefined;
    this.changed();
  }

  private async registerFlow(job: RegisterJob) {
    const botName = String(this.store.get("SELECT name FROM bots WHERE id=?", job.botId)?.name ?? "NexBot");
    try {
      const result = await this.options.registerApp({
        source: "nexbot", createOnly: true,
        appPreset: { name: botName, desc: "NexBot 个人助手" },
        addons: { scopes: scopeManifest.scopes, events: { items: { tenant: [...baselineEvents] } }, callbacks: { items: ["card.action.trigger"] } },
        onQRCodeReady: (info) => {
          if (job.controller.signal.aborted) return;
          job.stage = "qr"; job.url = info.url; job.expiresAt = now() + Math.max(60, Math.min(info.expireIn || 300, 900)) * 1000;
          this.changed();
        },
        signal: job.controller.signal,
      });
      if (job.controller.signal.aborted || this.closed) return;
      if (this.store.get("SELECT connector_id FROM personal_feishu_apps")) throw new Error("已连接飞书应用");
      const connectorId = this.persistApp({ appId: result.client_id, appSecret: result.client_secret, brand: result.user_info?.tenant_brand === "lark" ? "lark" : "feishu", ownerOpenId: typeof result.user_info?.open_id === "string" ? result.user_info.open_id : null, botId: job.botId });
      job.stage = "done";
      this.changed();
      void this.connect(connectorId);
    } catch (error) {
      if (job.controller.signal.aborted || this.closed) return;
      job.stage = "error";
      job.error = safe(error);
      this.changed();
    }
  }

  /** 使用已有应用（兜底）。主人绑定用绑定码完成。 */
  save(data: Record<string, unknown>) {
    if (this.store.get("SELECT connector_id FROM personal_feishu_apps")) throw new Error("已连接飞书应用，请先移除");
    const appId = text(data.appId, 100), appSecret = text(data.appSecret, 300), botId = text(data.botId, 100);
    const brand: Brand = data.brand === "lark" ? "lark" : "feishu";
    if (!appId.startsWith("cli_")) throw new Error("App ID 无效");
    if (!this.store.get("SELECT id FROM bots WHERE id=? AND status='active' AND workspace_id=? AND owner_user_id=?", botId, this.store.workspace, this.store.owner)) throw new Error("Agent 不存在");
    const connectorId = this.persistApp({ appId, appSecret, brand, ownerOpenId: null, botId });
    void this.connect(connectorId);
    return { id: connectorId };
  }

  private persistApp(input: { appId: string; appSecret: string; brand: Brand; ownerOpenId: string | null; botId: string }) {
    const connectorId = id();
    this.store.transaction(() => {
      this.store.insert("personal_connectors", { id: connectorId, kind: "feishu", ...this.store.scope(), name: "飞书", url: feishuOrigins(input.brand).open, transport: "http", enabled: 1, version: 1, credential: null, tools_json: JSON.stringify(feishuTools), created_at: now() });
      this.store.insert("personal_feishu_apps", { connector_id: connectorId, app_id: input.appId, brand: input.brand, app_secret: this.store.encrypt(input.appSecret), owner_open_id: input.ownerOpenId, bot_id: input.botId, connection: "idle", created_at: now() });
      this.store.audit("feishu.app.save", "connector", connectorId, { appId: input.appId, brand: input.brand });
    });
    // 工具目录自动授权给接收助手；写入仍逐次审批。
    this.options.grantTools?.(connectorId, 1, input.botId, [...feishuToolNames]);
    this.changed();
    return connectorId;
  }

  /** 生成 6 位绑定码，主人私聊机器人发送即完成绑定。只存哈希。 */
  bindStart(data: Record<string, unknown>) {
    const app = this.store.get("SELECT * FROM personal_feishu_apps WHERE connector_id=?", text(data.id, 100));
    if (!app) throw new Error("应用不存在");
    if (app.owner_open_id) throw new Error("已绑定主人");
    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.store.run("UPDATE personal_feishu_apps SET bind_code=?,bind_expires_at=? WHERE connector_id=?", hash(code), now() + 10 * 60_000, app.connector_id);
    this.changed();
    return { code };
  }

  /** 主人身份授权：设备码流。授权账号必须与应用主人一致（未绑定时以它绑定）。 */
  startUserAuth(data: Record<string, unknown>) {
    const app = this.store.get("SELECT * FROM personal_feishu_apps WHERE connector_id=?", text(data.id, 100));
    if (!app) throw new Error("应用不存在");
    if (this.userAuth?.stage === "polling") throw new Error("已有进行中的授权，请先取消");
    const controller = new AbortController();
    this.userAuth = { stage: "polling", controller };
    this.changed();
    void this.userAuthFlow(String(app.connector_id), controller);
    return { started: true };
  }

  cancelUserAuth() {
    if (!this.userAuth) return;
    this.userAuth.controller.abort();
    this.userAuth = undefined;
    this.changed();
  }

  private async userAuthFlow(connectorId: string, controller: AbortController) {
    try {
      const app = this.store.get("SELECT a.*,c.enabled FROM personal_feishu_apps a JOIN personal_connectors c ON c.id=a.connector_id WHERE a.connector_id=?", connectorId);
      if (!app) throw new Error("应用不存在");
      const credentials = this.credentials(app);
      const granted = JSON.parse(String(app.user_scopes_json ?? "[]")) as string[];
      const request = await this.api.deviceAuthorization(credentials, [...new Set([...granted, ...scopeManifest.scopes.user])]);
      if (controller.signal.aborted) return;
      this.userAuth = { ...this.userAuth!, stage: "polling", url: request.verificationUriComplete ?? request.verificationUri, expiresAt: now() + request.expiresIn * 1000, controller };
      this.changed();
      const deadline = now() + request.expiresIn * 1000;
      let waitMs = this.options.devicePollMs ?? request.interval * 1000;
      while (now() < deadline) {
        await sleepAbort(waitMs, controller.signal);
        if (controller.signal.aborted) return;
        const result = await this.api.tokenEndpoint(credentials, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: request.deviceCode });
        if (result.pending === "authorization_pending") continue;
        if (result.pending === "slow_down") { waitMs = Math.min(waitMs + 5000, 60_000); continue; }
        if (result.pending) throw new Error(`授权失败：${result.pending}`);
        const grant = result.access!;
        const info = await this.api.userInfo(credentials, grant.accessToken);
        const owner = String(app.owner_open_id ?? "");
        if (!owner) {
          if (!info.openId) throw new Error("授权成功但无法确认账号身份");
          this.store.run("UPDATE personal_feishu_apps SET owner_open_id=? WHERE connector_id=?", info.openId, connectorId);
        } else if (info.openId !== owner) throw new Error("授权账号与应用主人不一致，已丢弃令牌");
        this.store.run("UPDATE personal_feishu_apps SET user_token=?,user_scopes_json=?,user_token_expires_at=? WHERE connector_id=?", this.store.encrypt(JSON.stringify(grant)), JSON.stringify(grant.scope), grant.expiresAt, connectorId);
        this.store.audit("feishu.user.auth", "connector", connectorId, { scopes: grant.scope.length });
        this.userAuth = { stage: "done", controller };
        this.changed();
        return;
      }
      throw new Error("设备授权已过期，请重新发起");
    } catch (error) {
      if (controller.signal.aborted) return;
      this.userAuth = { stage: "error", controller, error: safe(error) };
      this.changed();
    }
  }

  private clearUserToken(connectorId: string) {
    this.store.run("UPDATE personal_feishu_apps SET user_token=NULL,user_scopes_json='[]',user_token_expires_at=NULL WHERE connector_id=?", connectorId);
    this.changed();
  }

  /** 过期前 5 分钟刷新；同一应用的刷新串行。refresh 失效即清除令牌。 */
  private async userAccessToken(row: Row): Promise<string> {
    const stored = row.user_token ? JSON.parse(this.store.decrypt(String(row.user_token))) as UserTokenGrant : null;
    const connectorId = String(row.connector_id);
    if (!stored?.accessToken || (stored.refreshExpiresAt !== undefined && stored.refreshExpiresAt <= now())) {
      if (stored) this.clearUserToken(connectorId);
      throw Object.assign(new Error("主人尚未完成飞书授权"), { missingUserAuth: true });
    }
    if (stored.expiresAt > now() + 5 * 60_000) return stored.accessToken;
    let pending = this.refreshing.get(connectorId);
    if (!pending) {
      pending = (async () => {
        const result = await this.api.tokenEndpoint(this.credentials(row), { grant_type: "refresh_token", refresh_token: stored.refreshToken });
        if (result.pending || !result.access) { this.clearUserToken(connectorId); return null; }
        const grant = { ...result.access, refreshToken: result.access.refreshToken || stored.refreshToken };
        this.store.run("UPDATE personal_feishu_apps SET user_token=?,user_scopes_json=?,user_token_expires_at=? WHERE connector_id=?", this.store.encrypt(JSON.stringify(grant)), JSON.stringify(grant.scope), grant.expiresAt, connectorId);
        return grant;
      })().finally(() => this.refreshing.delete(connectorId));
      this.refreshing.set(connectorId, pending);
    }
    const refreshed = await pending;
    if (!refreshed) throw Object.assign(new Error("主人尚未完成飞书授权"), { missingUserAuth: true });
    return refreshed.accessToken;
  }

  /** 通用工具是否由本模块执行（按连接器 kind 判断）。 */
  handles(args: Record<string, unknown>): boolean {
    if (args.action !== "connector.call" && args.action !== "connector.tools") return false;
    const row = this.store.get("SELECT kind FROM personal_connectors WHERE id=?", typeof args.connectorId === "string" ? args.connectorId : "");
    return row?.kind === "feishu";
  }

  cancelTask(taskId: string) { for (const [controller, active] of this.active) if (active === taskId) controller.abort(); }

  private async callAs(row: Row, request: ReturnType<typeof parseToolCall>): Promise<Record<string, unknown>> {
    // connectorAccess 返回的是连接器行；app_secret 在应用行里。
    const app = this.store.get("SELECT * FROM personal_feishu_apps WHERE connector_id=?", String(row.id));
    if (!app) throw new Error("飞书应用不存在");
    const credentials = this.credentials(app);
    const path = request.path + queryString(request.query);
    if (request.as === "bot") return await this.api.request(credentials, request.method, path, request.body);
    const attempt = async () => {
      const fresh = this.store.get("SELECT * FROM personal_feishu_apps WHERE connector_id=?", String(row.id))!;
      const token = await this.userAccessToken(fresh);
      return await this.api.userRequest(credentials, token, request.method, path, request.body);
    };
    try { return await attempt(); }
    catch (error) {
      // user token 失效：刷新一次后重试；再失败按未授权返回。
      if (error instanceof FeishuApiError && userTokenInvalid.has(error.code)) {
        this.clearUserToken(String(row.connector_id));
        return await attempt();
      }
      throw error;
    }
  }

  /** connector.call/tools 的飞书实现。授权、版本失效检查复用连接器机制。 */
  async execute(call: Row, args: Record<string, unknown>, authorize: () => Promise<void>) {
    if (this.closed) throw new Error("连接器正在关闭");
    const row = connectorAccess(this.store, String(call.bot_id), args);
    if (args.action === "connector.tools") return { connectorId: row.id, connectorVersion: row.version, tools: feishuTools };
    let request: ReturnType<typeof parseToolCall>;
    try { request = parseToolCall(String(args.tool ?? ""), record(args.parameters)); }
    catch (error) { return { text: `参数无效：${error instanceof Error ? error.message : "参数无效"}`, images: [], isError: true }; }
    const controller = new AbortController();
    this.active.set(controller, String(call.task_id ?? ""));
    let dispatched = false;
    try {
      await authorize();
      connectorAccess(this.store, String(call.bot_id), args);
      if (controller.signal.aborted) throw new Error("已取消");
      dispatched = true;
      let result: Record<string, unknown>;
      try {
        result = await this.callAs(row, request);
      } catch (error) {
        if ((error as { missingUserAuth?: boolean }).missingUserAuth) return { text: JSON.stringify({ error: "missing_scope", layer: "user", hint: "请主人在连接器的飞书卡片完成「授权文档访问」后重试。" }), images: [], isError: true };
        if (error instanceof FeishuApiError) {
          const scope = missingScope(error);
          if (scope?.layer === "app") return { text: JSON.stringify({ error: "missing_scope", layer: "app", scopes: error.scopes, hint: "应用未开通该权限，需在开发者后台开通。" }), images: [], isError: true };
          if (scope?.layer === "user") return { text: JSON.stringify({ error: "missing_scope", layer: "user", scopes: error.scopes, hint: "主人尚未授权该权限，请重新发起「授权文档访问」。" }), images: [], isError: true };
        }
        throw error;
      }
      await authorize();
      connectorAccess(this.store, String(call.bot_id), args);
      const body = JSON.stringify(result);
      return { text: body.length > 24_000 ? body.slice(0, 24_000) + "…（已截断）" : body, images: [] };
    } catch (error) {
      if (error instanceof FeishuApiError) return { text: JSON.stringify({ error: "api", code: error.code, msg: error.message }), images: [], isError: true };
      if (dispatched) {
        this.store.run("UPDATE tool_calls SET status='unknown' WHERE id=? AND status='executing'", call.id);
        throw new Error("飞书调用中断或授权已变化，结果未知；请核实，不会自动重放。");
      }
      throw new Error(`飞书调用失败，未发送请求：${safe(error)}`);
    } finally { this.active.delete(controller); }
  }

  private credentials(row: Row) {
    return { appId: String(row.app_id), appSecret: this.store.decrypt(String(row.app_secret)), brand: row.brand as Brand };
  }

  async connect(connectorId: string) {
    const app = this.store.get("SELECT a.*,c.enabled FROM personal_feishu_apps a JOIN personal_connectors c ON c.id=a.connector_id WHERE a.connector_id=?", connectorId);
    if (!app || app.enabled !== 1) return;
    const credentials = this.credentials(app);
    // 同一应用只允许一个长连接消费者：其它实例在线时不连接。
    try {
      if (await this.api.onlineInstances(credentials) > 0) {
        this.store.run("UPDATE personal_feishu_apps SET connection='busy',error=NULL WHERE connector_id=?", connectorId);
        this.changed();
        return;
      }
    } catch { /* 自检失败不阻断连接 */ }
    if (this.transports.has(connectorId)) return;
    try {
      void this.api.botOpenId(credentials).then((openId) => {
        if (openId && !this.closed) { this.store.run("UPDATE personal_feishu_apps SET bot_open_id=? WHERE connector_id=?", openId, connectorId); this.changed(); }
      }).catch(() => {});
      const transport = await this.transportFactory({ appId: credentials.appId, appSecret: credentials.appSecret, brand: credentials.brand }, {
        onMessage: (event) => { queueMicrotask(() => { void this.handleMessage(credentials.appId, event); }); },
        onCardAction: (event) => this.handleCardAction(credentials.appId, event),
      });
      if (this.closed) { await transport.close().catch(() => {}); return; }
      this.transports.set(connectorId, transport);
      this.store.run("UPDATE personal_feishu_apps SET connection='connected',error=NULL WHERE connector_id=?", connectorId);
      this.store.audit("feishu.connect", "connector", connectorId, {});
    } catch (error) {
      this.store.run("UPDATE personal_feishu_apps SET connection='error',error=? WHERE connector_id=?", safe(error), connectorId);
    }
    this.changed();
  }

  private async disconnect(connectorId: string, status: "idle" | "disabled") {
    const transport = this.transports.get(connectorId);
    this.transports.delete(connectorId);
    try { await transport?.close(); } catch { /* 关闭失败不阻断状态更新 */ }
    this.store.run("UPDATE personal_feishu_apps SET connection=?,error=NULL WHERE connector_id=?", status, connectorId);
  }

  async toggle(data: Record<string, unknown>) {
    const row = this.store.get("SELECT c.*,a.app_id FROM personal_connectors c JOIN personal_feishu_apps a ON a.connector_id=c.id WHERE c.id=? AND c.kind='feishu'", text(data.id, 100));
    if (!row || row.version !== Number(data.version) || typeof data.enabled !== "boolean") throw new Error("连接器已变化，请刷新后重试");
    this.store.run("UPDATE personal_connectors SET enabled=?,version=version+1 WHERE id=?", data.enabled ? 1 : 0, row.id);
    if (data.enabled) await this.connect(String(row.id));
    else await this.disconnect(String(row.id), "disabled");
    this.changed();
    return { ok: true };
  }

  async remove(data: Record<string, unknown>) {
    const row = this.store.get("SELECT c.*,a.app_id FROM personal_connectors c JOIN personal_feishu_apps a ON a.connector_id=c.id WHERE c.id=? AND c.kind='feishu'", text(data.id, 100));
    if (!row || row.version !== Number(data.version)) throw new Error("连接器已变化，请刷新后重试");
    await this.disconnect(String(row.id), "idle");
    this.store.transaction(() => {
      this.store.run("DELETE FROM personal_feishu_messages WHERE app_id=?", row.app_id);
      this.store.run("DELETE FROM personal_feishu_outbound WHERE app_id=?", row.app_id);
      this.store.run("DELETE FROM personal_connectors WHERE id=?", row.id);
      this.store.audit("feishu.remove", "connector", String(row.id), {});
    });
    this.changed();
    return { ok: true };
  }

  private async handleMessage(appId: string, raw: unknown) {
    try {
      const event = record(record(raw).event);
      const envelope = record(event.message), sender = record(event.sender);
      const messageId = pick(envelope, ["message_id"]), chatId = pick(envelope, ["chat_id"]);
      const senderOpenId = pick(record(sender.sender_id), ["open_id"]);
      const chatType = pick(envelope, ["chat_type"]) === "group" ? "group" : "p2p";
      if (!messageId || !chatId || !senderOpenId || pick(sender, ["sender_type"]) !== "user") return;
      const app = this.store.get("SELECT a.*,c.enabled FROM personal_feishu_apps a JOIN personal_connectors c ON c.id=a.connector_id WHERE a.app_id=?", appId);
      if (!app || app.enabled !== 1) return;
      // message_id 主键即去重：飞书重推只处理一次。
      const inserted = this.store.run("INSERT OR IGNORE INTO personal_feishu_messages(message_id,app_id,chat_id,chat_type,sender_open_id,created_at) VALUES(?,?,?,?,?,?)", messageId, appId, chatId, chatType, senderOpenId, now());
      if (Number(inserted.changes) === 0) return;
      let content = extractText(envelope);
      if (chatType === "group") {
        // 群聊只处理 @ 机器人的消息；机器人 open_id 未知时宁可忽略。
        const botOpenId = String(app.bot_open_id ?? "");
        const mentioned = botOpenId && (Array.isArray(envelope.mentions) ? envelope.mentions : []).some((entry) => pick(record(record(entry).id), ["open_id"]) === botOpenId);
        if (!mentioned) return;
        content = this.stripMentions(envelope, content, botOpenId);
      }
      content = content.trim();
      if (!content) return;
      if (String(app.owner_open_id ?? "") !== senderOpenId) {
        const expected = String(app.bind_code ?? "");
        if (!app.owner_open_id && chatType === "p2p" && expected && expected === hash(content) && Number(app.bind_expires_at ?? 0) > now()) {
          this.store.run("UPDATE personal_feishu_apps SET owner_open_id=?,bind_code=NULL,bind_expires_at=NULL WHERE connector_id=?", senderOpenId, app.connector_id);
          await this.send(app, chatId, "已绑定主人。");
          this.changed();
        }
        return;
      }
      let taskId: string;
      try { taskId = this.agents.send(String(app.bot_id), content, `feishu:${messageId}`, this.store.session).taskId; }
      catch (error) { await this.send(app, chatId, `消息未送达：${safe(error)}`).catch(() => {}); return; }
      this.store.run("UPDATE personal_feishu_messages SET task_id=? WHERE message_id=?", taskId, messageId);
      this.changed();
    } catch { /* 单条事件失败不影响通道 */ }
  }

  private stripMentions(message: Record<string, unknown>, content: string, botOpenId: string): string {
    let result = content;
    for (const entry of Array.isArray(message.mentions) ? message.mentions : []) {
      const mention = record(entry), key = pick(mention, ["key"]);
      if (!key) continue;
      result = result.split(key).join(pick(record(mention.id), ["open_id"]) === botOpenId ? "" : `@${pick(mention, ["name"]) ?? ""}`);
    }
    return result;
  }

  /** 助手发布最终回复或错误后，送回来源会话。 */
  onPublished(botId: string) {
    if (this.closed) return;
    const published = this.store.get("SELECT * FROM agent_messages WHERE bot_id=? AND role IN ('assistant','system') AND kind IN ('message','error') ORDER BY seq DESC LIMIT 1", botId);
    if (!published) return;
    const mapping = this.store.get("SELECT m.*,a.app_id FROM personal_feishu_messages m JOIN personal_feishu_apps a ON a.app_id=m.app_id WHERE m.task_id=?", String(published.task_id ?? ""));
    if (!mapping) return;
    void this.deliverReply(String(mapping.app_id), mapping, published);
  }

  private async deliverReply(appId: string, mapping: Row, message: Row) {
    if (this.closed) return;
    let marked: { changes?: number | bigint };
    try { marked = this.store.run("INSERT OR IGNORE INTO personal_feishu_outbound(source_key,app_id,chat_id,created_at) VALUES(?,?,?,?)", `reply:${message.source_key}`, appId, String(mapping.chat_id), now()); }
    catch { return; } // 进程关闭竞态：放弃投递
    if (Number(marked.changes) === 0) return;
    try {
      const app = this.store.get("SELECT a.*,c.enabled FROM personal_feishu_apps a JOIN personal_connectors c ON c.id=a.connector_id WHERE a.app_id=?", appId);
      if (!app || app.enabled !== 1) { if (!this.closed) this.store.run("DELETE FROM personal_feishu_outbound WHERE source_key=?", `reply:${message.source_key}`); return; }
      const body = (message.role === "system" ? `出错了：${message.content}` : String(message.content)).slice(0, 20_000);
      const chunks = splitChunks(body);
      for (const [index, chunk] of chunks.entries()) await this.send(app, String(mapping.chat_id), chunk, index === 0 && mapping.chat_type === "group" ? String(mapping.message_id) : undefined);
      this.changed();
    } catch {
      // 首次发送失败保留重试机会：删除标记，下次变更再投递。
      if (!this.closed) this.store.run("DELETE FROM personal_feishu_outbound WHERE source_key=? AND message_id IS NULL", `reply:${message.source_key}`);
    }
  }

  /** 有飞书来源任务等待审批时发审批卡片；changed() 触发，去重靠 outbound 表。 */
  scanApprovals() {
    if (this.closed || this.scanning) return;
    this.scanning = true;
    void (async () => {
      try {
        const rows = this.store.all("SELECT a.id approval_id,a.argument_hash,t.tool_name,t.arguments_json,t.task_id FROM approvals a JOIN tool_calls t ON t.id=a.tool_call_id WHERE a.status='pending' AND a.expires_at>? AND EXISTS(SELECT 1 FROM personal_feishu_messages m WHERE m.task_id=t.task_id) ORDER BY a.created_at", now());
        for (const row of rows) {
          const mapping = this.store.get("SELECT m.chat_id,m.message_id,m.chat_type,a.app_id FROM personal_feishu_messages m JOIN personal_feishu_apps a ON a.app_id=m.app_id WHERE m.task_id=?", String(row.task_id));
          if (!mapping) continue;
          const sourceKey = `approval:${row.approval_id}`;
          const marked = this.store.run("INSERT OR IGNORE INTO personal_feishu_outbound(source_key,app_id,chat_id,created_at) VALUES(?,?,?,?)", sourceKey, String(mapping.app_id), String(mapping.chat_id), now());
          if (Number(marked.changes) === 0) continue;
          const app = this.store.get("SELECT a.*,c.enabled FROM personal_feishu_apps a JOIN personal_connectors c ON c.id=a.connector_id WHERE a.app_id=?", String(mapping.app_id));
          if (!app || app.enabled !== 1) continue;
          const args = JSON.stringify(record(safeJson(row.arguments_json))).slice(0, 800);
          const card = markdownCard(`请求批准：${String(row.tool_name)}\n${args}`, [
            { text: "同意", value: { kind: "approval", id: row.approval_id, hash: row.argument_hash, decision: "allow" }, style: "primary" },
            { text: "拒绝", value: { kind: "approval", id: row.approval_id, hash: row.argument_hash, decision: "deny" } },
            { text: "停止任务", value: { kind: "stop", taskId: row.task_id } },
          ]);
          await this.sendRaw(app, String(mapping.chat_id), card, mapping.chat_type === "group" ? String(mapping.message_id) : undefined);
        }
      } catch { /* 下次变更再试 */ }
      finally { this.scanning = false; }
    })();
  }

  /** 卡片按钮回调：只信主人本人，decide 校验参数哈希。 */
  async handleCardAction(appId: string, raw: unknown): Promise<unknown> {
    try {
      const event = record(record(raw).event);
      const operator = pick(record(event.operator), ["open_id"]);
      const value = record(record(event.action).value);
      const app = this.store.get("SELECT * FROM personal_feishu_apps WHERE app_id=?", appId);
      if (!app) return { toast: { type: "error", content: "应用不存在" } };
      if (!operator || operator !== String(app.owner_open_id ?? "")) return { toast: { type: "error", content: "仅主人可以操作" } };
      if (value.kind === "approval") {
        const approvalId = typeof value.id === "string" ? value.id : "", digest = typeof value.hash === "string" ? value.hash : "";
        try {
          this.runtime.decide(approvalId, digest, value.decision === "allow", this.store.session);
          this.changed();
          return { toast: { type: "success", content: value.decision === "allow" ? "已同意" : "已拒绝" } };
        } catch (error) { return { toast: { type: "error", content: safe(error) } }; }
      }
      if (value.kind === "stop") {
        const taskId = typeof value.taskId === "string" ? value.taskId : "";
        if (!taskId || !this.store.get("SELECT task_id FROM personal_feishu_messages WHERE task_id=?", taskId)) return { toast: { type: "error", content: "任务不存在" } };
        this.runtime.cancel(taskId, "主人已在飞书停止任务");
        this.changed();
        return { toast: { type: "success", content: "已停止" } };
      }
      return { toast: { type: "error", content: "未知操作" } };
    } catch (error) { return { toast: { type: "error", content: safe(error) } }; }
  }

  private async send(app: Row, chatId: string, markdown: string, replyMessageId?: string) {
    for (const chunk of splitChunks(markdown)) await this.sendRaw(app, chatId, markdownCard(chunk), replyMessageId);
  }

  private async sendRaw(app: Row, chatId: string, content: string, replyMessageId?: string) {
    const credentials = this.credentials(app);
    if (replyMessageId) await this.api.request(credentials, "POST", `/open-apis/im/v1/messages/${encodeURIComponent(replyMessageId)}/reply`, { msg_type: "interactive", content });
    else await this.api.request(credentials, "POST", "/open-apis/im/v1/messages?receive_id_type=chat_id", { receive_id: chatId, msg_type: "interactive", content });
  }

  async close() {
    this.closed = true;
    this.job?.controller.abort();
    this.job = undefined;
    this.userAuth?.controller.abort();
    this.userAuth = undefined;
    for (const transport of this.transports.values()) await transport.close().catch(() => {});
    this.transports.clear();
  }
}

function safeJson(value: unknown): unknown { try { return JSON.parse(String(value)); } catch { return {}; } }
