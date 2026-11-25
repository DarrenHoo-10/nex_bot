import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { defaultAppearance, parseAppearance } from "../../../shared/personal-appearance.ts";
import { now, text, id, hash, canonical, type CoreStore, type Row } from "../store.ts";
import type { AgentModule } from "../agents.ts";
import type { TaskRuntime } from "../runtime.ts";
import { connectorAccess } from "../connectors.ts";
import { feishuOrigins, FeishuApi, FeishuApiError, missingScope, type Brand, type UserTokenGrant } from "./api.ts";
import { wsTransportFactory, type FeishuTransport, type TransportFactory, type RegisterAppFn, normalizeFeishuEvent } from "./transport.ts";
import { feishuTools, parseToolCall, queryString } from "./tools.ts";
import { ensureFeishuDeliverySchema, postWindowExpired, retryAt, FEISHU_UUID_WINDOW_MS } from "./delivery.ts";
import manifest from "./lark-scopes.json" with { type: "json" };

export type { RegisterAppFn };

class DeliveryCancelled extends Error {}
class DeliveryNeedsReconciliation extends Error {}
const appConsumers = new Map<string, FeishuModule>();
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

/** A job report fits one Feishu message: generated images stay in the app, and anything left out says so. */
export function reportBody(content: string, limit = 3400) {
  let body = content.replace(/!\[[^\]]*\]\(\/api\/attachments\/[\w-]+\)|\[下载图片\]\(\/api\/attachments\/[\w-]+\)/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const partial = body !== content.trim() || body.length > limit;
  if (body.length > limit) body = body.slice(0, limit).trimEnd();
  return partial ? `${body}\n\n完整结果在 App 中查看` : body;
}

function splitChunks(text: string, limit = 3500, max = 5): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let at = 0;
  while (at < text.length && parts.length < max) { parts.push(text.slice(at, at + limit)); at += limit; }
  if (at < text.length) parts[parts.length - 1] += "\n（内容过长已截断，请在 NexBot 查看完整回复）";
  return parts;
}

const groupCacheMs = 5 * 60_000;
const maxGroupAvatarBytes = 512 * 1024;
type GroupAvatar = { bytes: Buffer; mime: string };
function groupAvatarSource(value?: string) {
  if (!value || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    const cdn = [".feishucdn.com", ".larksuitecdn.com", ".larkofficecdn.com"].some(domain => url.hostname.endsWith(domain));
    if (cdn && url.protocol === "https:" && !url.port && !url.username && !url.password) return url.href;
  } catch { /* Feishu may omit the avatar field. */ }
  return undefined;
}

interface RegisterJob {
  stage: "preparing" | "qr" | "done" | "error";
  botId: string;
  url?: string;
  scanToken?: string;
  expiresAt?: number;
  error?: string;
  controller: AbortController;
}

export const feishuScanPrefix = "/feishu/s/";
export function feishuScanToken(pathname: string) {
  if (!pathname.startsWith(feishuScanPrefix)) return undefined;
  const token = pathname.slice(feishuScanPrefix.length);
  return /^[A-Za-z0-9_-]{22}$/.test(token) ? token : undefined;
}

function officialRegistrationUrl(value: string) {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.port
    && /(?:^|\.)(?:feishu\.cn|larksuite\.com)$/.test(url.hostname);
}

export interface FeishuModuleOptions { registerApp: RegisterAppFn; transport?: TransportFactory; fetchImpl?: typeof fetch; devicePollMs?: number;
  profileAssets?: { uiDir: string; publicOrigin?: string };
  routeInbound?: (appId: string, event: unknown, kind: "message" | "card") => void | Promise<unknown>;
  sharedApp?: (appId: string) => Row | undefined;
  ownershipAllowed?: (appId:string,operation:"receive"|"send"|"bind"|"connect")=>Promise<boolean>;
  destinationAllowed?: (appId:string,actor:string,chatId:string,audience:string)=>boolean;
  authorizeActor?: (appId:string,actor:string,chatId:string,chatType:string)=>Promise<boolean>;
  sendRequest?: (appId: string, method: "GET" | "POST" | "PUT" | "PATCH", path: string, body?: unknown, beforeSend?:()=>void) => Promise<Record<string, unknown>>;
}

/**
 * 飞书连接器：一个自建应用接入一个助手。消息经官方长连接进出，
 * 回复与审批用卡片；凭据只存 vault，不进状态、日志或模型上下文。
 */
export class FeishuModule {
  private readonly api: FeishuApi;
  private readonly transportFactory: TransportFactory;
  private job: RegisterJob | undefined;
  private userAuth?: { id: string; stage: "polling" | "done" | "error"; url?: string; expiresAt?: number; error?: string; controller: AbortController };
  private readonly transports = new Map<string, FeishuTransport>();
  private readonly active = new Map<AbortController, string>();
  private readonly refreshing = new Map<string, Promise<UserTokenGrant | null>>();
  private scanning = false;
  private closed = false;
  private draining = false;
  private recovering = false;
  private readonly quiesced = new Set<string>();
  private readonly drainWaiters = new Set<()=>void>();
  private readonly recoverWaiters = new Set<()=>void>();
  private readonly recovery: ReturnType<typeof setInterval>;
  private readonly connecting = new Set<string>();
  private syncingProfiles = false;

  constructor(private readonly store: CoreStore, readonly changed: () => void, private readonly agents: AgentModule, private readonly runtime: TaskRuntime, private readonly options: FeishuModuleOptions) {
    ensureFeishuDeliverySchema(store);
    // A process may have died after sending but before persisting the provider response.
    store.run("UPDATE feishu_delivery_parts SET state='pending' WHERE state='sending'");
    this.expireUnknownDeliveries();
    this.recovery = setInterval(() => { if (!this.closed) { this.recoverInbound(); this.onPublished(); void this.flushOutbox(); void this.flushProfiles(); } }, 1000);
    this.recovery.unref();
    this.api = new FeishuApi(options.fetchImpl);
    this.transportFactory = options.transport ?? wsTransportFactory;
  }

  state() {
    return {
      ...(this.job ? { job: { stage: this.job.stage, ...(this.job.url ? { url: this.job.url } : {}), ...(this.job.stage === "qr" && this.job.scanToken ? { scanPath: feishuScanPrefix + this.job.scanToken } : {}), ...(this.job.expiresAt ? { expiresAt: this.job.expiresAt } : {}), ...(this.job.error ? { error: this.job.error } : {}) } } : {}),
      ...(this.userAuth ? { userAuth: { id: this.userAuth.id, stage: this.userAuth.stage, ...(this.userAuth.url ? { url: this.userAuth.url } : {}), ...(this.userAuth.expiresAt ? { expiresAt: this.userAuth.expiresAt } : {}), ...(this.userAuth.error ? { error: this.userAuth.error } : {}) } } : {}),
      apps: this.store.all("SELECT a.connector_id AS id, a.app_id, a.brand, a.connection AS status, a.error, a.owner_open_id, a.bot_id, a.bot_name, a.bot_avatar, a.profile_status, a.user_token, a.user_scopes_json, a.user_token_expires_at, c.enabled, c.version FROM personal_feishu_apps a JOIN personal_connectors c ON c.id=a.connector_id WHERE a.bot_id NOT IN (SELECT id FROM bots WHERE status='deleted') ORDER BY a.created_at")
        .map((row) => ({
          id: String(row.id), appId: String(row.app_id), brand: String(row.brand), status: String(row.status), error: row.error === null ? null : String(row.error),
          ownerBound: !!row.owner_open_id, botId: String(row.bot_id), botName: String(this.store.get("SELECT name FROM bots WHERE id=?", String(row.bot_id))?.name ?? ""),
          enabled: row.enabled === 1, version: Number(row.version),
          name: row.bot_name ? String(row.bot_name) : null, avatarUrl: row.bot_avatar ? String(row.bot_avatar) : null,
          profileStatus: row.profile_status ?? null,
          groupCount: Number(this.store.get("SELECT COUNT(*) n FROM feishu_group_settings WHERE app_id=? AND in_group=1", row.app_id)?.n ?? 0),
          userAuthorized: !!row.user_token, userScopes: JSON.parse(String(row.user_scopes_json ?? "[]")) as string[], userExpiresAt: row.user_token_expires_at === null ? null : Number(row.user_token_expires_at),
        })),
    };
  }

  /** 飞书来源的任务以连接为授权锚点：连接开启即允许执行。主对话派出的后台任务沿用派发它的那条飞书消息。 */
  hasSource(taskId:string) {return !!this.mappingFor(taskId);}

  async channelAuthorize(task: Row): Promise<boolean> {
    const mapping = this.mappingFor(String(task.id));
    if (!mapping) return false;
    const app = this.app(String(mapping.app_id));
    if (!app || app.enabled !== 1 || !await this.channelAvailable(String(mapping.app_id),"receive") || this.options.authorizeActor && !await this.options.authorizeActor(String(mapping.app_id),String(mapping.sender_open_id),String(mapping.chat_id),String(mapping.chat_type))) return false;
    if (mapping.chat_type === "p2p") return app.private_enabled !== 0 && !!app.owner_open_id && mapping.sender_open_id === app.owner_open_id;
    return !!this.store.get("SELECT chat_id FROM feishu_destinations WHERE app_id=? AND chat_id=? AND enabled=1", mapping.app_id, mapping.chat_id);
  }

  /**
   * 任务对应的飞书来源会话：任务本身来自飞书消息；或者它是后台任务（含其委派子任务），派发它的主人任务来自飞书。
   * 飞书里直接回复回报消息时，后台任务这一轮本身就有映射。
   */
  private mappingFor(taskId: string): Row | undefined {
    const select = "SELECT m.* FROM personal_feishu_messages m WHERE m.task_id=? ORDER BY m.created_at DESC LIMIT 1";
    const direct = this.store.get(select, taskId);
    if (direct) return direct;
    // Queued inputs retain the source receipt until their task is accepted.
    const input = this.store.get("SELECT client_id FROM agent_topic_inputs WHERE task_id=?", taskId);
    if (input) {
      const candidate = this.store.all("SELECT * FROM personal_feishu_messages WHERE state='routed' AND task_id IS NULL").find((m) => `feishu:${hash(`${m.app_id}:${m.chat_id}:${m.message_id}`)}` === input.client_id);
      if (candidate) { this.store.run("UPDATE personal_feishu_messages SET task_id=? WHERE app_id=? AND chat_id=? AND message_id=?", taskId,candidate.app_id,candidate.chat_id,candidate.message_id); return { ...candidate, task_id:taskId }; }
    }
    const root = this.runtime.taskRoot(taskId), job = this.jobOf(taskId);
    if (!job) return undefined;
    return (root !== taskId ? this.store.get(select, root) : undefined) ?? (job.origin_task_id ? this.store.get(select, String(job.origin_task_id)) : undefined);
  }

  /** 后台任务这一轮的标题；不是后台任务时为空。 */
  private jobOf(taskId: string): Row | undefined {
    return this.store.get("SELECT j.* FROM agent_jobs j JOIN tasks t ON t.conversation_id=j.conversation_id WHERE t.id=?", this.runtime.taskRoot(taskId));
  }

  startRegister(data: Record<string, unknown>) {
    const botId = text(data.botId, 100);
    if (!this.store.get("SELECT id FROM bots WHERE id=? AND status='active' AND workspace_id=? AND owner_user_id=?", botId, this.store.workspace, this.store.owner)) throw new Error("Agent 不存在");
    if (this.job && this.job.stage !== "done" && this.job.stage !== "error") throw new Error("已有进行中的扫码，请先取消");
    const controller = new AbortController();
    const job: RegisterJob = { stage: "preparing", botId, controller };
    this.job = job;
    this.changed();
    void this.registerFlow(job);
    return { started: true };
  }

  registrationTarget(token: string) {
    const job = this.job;
    if (this.closed || job?.stage !== "qr" || job.scanToken !== token || !job.expiresAt || job.expiresAt <= now()) return undefined;
    return job.url;
  }

  cancelRegister() {
    if (!this.job) return;
    this.job.controller.abort();
    this.job = undefined;
    this.changed();
  }

  private assistantProfile(botId: string) {
    const bot = this.store.get("SELECT b.name, a.appearance_json FROM bots b LEFT JOIN bot_appearance a ON a.bot_id=b.id WHERE b.id=? AND b.status='active'", botId);
    if (!bot) return undefined;
    const appearance = bot.appearance_json ? parseAppearance(JSON.parse(String(bot.appearance_json))) :
      defaultAppearance(botId, String(this.agents.contacts()[0]?.id ?? ""));
    const key = appearance.kind === "companion" ? `companion-${appearance.shape}-${appearance.color}` : `${appearance.kind}-${appearance.id}`;
    const assetPath = `/feishu-avatars/${key}.png`;
    const assets = this.options.profileAssets;
    const file = assets && path.join(assets.uiDir, assetPath);
    return { name: String(bot.name), file: file && existsSync(file) ? file : undefined, assetPath };
  }

  queueProfile(botId: string) {
    this.store.run("UPDATE personal_feishu_apps SET profile_revision=profile_revision+1,profile_status='pending' WHERE bot_id=?", botId);
  }

  private async flushProfiles() {
    if (this.syncingProfiles || this.closed) return;
    this.syncingProfiles = true;
    try {
      const pending = this.store.all("SELECT a.* FROM personal_feishu_apps a JOIN personal_connectors c ON c.id=a.connector_id JOIN bots b ON b.id=a.bot_id WHERE a.profile_status='pending' AND c.enabled=1 AND b.status='active'");
      for (const app of pending) {
        if (this.closed) break;
        const isCurrent = () => !this.closed && !!this.store.get("SELECT 1 FROM personal_feishu_apps a JOIN personal_connectors c ON c.id=a.connector_id WHERE a.connector_id=? AND a.profile_revision=? AND a.profile_status='pending' AND c.enabled=1", app.connector_id, app.profile_revision);
        try {
          if (!isCurrent()) continue;
          const profile = this.assistantProfile(String(app.bot_id));
          if (!profile) continue;
          const avatar = profile.file ? new Uint8Array(await readFile(profile.file)) : undefined;
          await this.api.updateAppProfile(this.credentials(app), { name: profile.name, avatar }, () => {
            if (!isCurrent()) throw new Error("飞书资料已变化");
          });
          if (isCurrent()) this.store.run("UPDATE personal_feishu_apps SET profile_status='publication' WHERE connector_id=?", app.connector_id);
        } catch (error) {
          if (isCurrent()) this.store.run("UPDATE personal_feishu_apps SET profile_status=? WHERE connector_id=?", error instanceof FeishuApiError && error.code === 210021 ? "unsupported" : "error", app.connector_id);
        }
        if (!this.closed) this.changed();
      }
    } finally { this.syncingProfiles = false; }
  }

  private async registerFlow(job: RegisterJob) {
    const profile = this.assistantProfile(job.botId);
    const avatar = profile?.file && this.options.profileAssets?.publicOrigin
      ? new URL(profile.assetPath, this.options.profileAssets.publicOrigin).href : undefined;
    try {
      const result = await this.options.registerApp({
        source: "nexbot", createOnly: true,
        appPreset: { name: profile?.name ?? "NexBot", desc: "NexBot 个人助手", ...(avatar ? { avatar } : {}) },
        addons: { scopes: scopeManifest.scopes, events: { items: { tenant: [...baselineEvents] } }, callbacks: { items: ["card.action.trigger"] } },
        onQRCodeReady: (info) => {
          if (job.controller.signal.aborted) return;
          job.stage = "qr"; job.url = info.url;
          job.expiresAt = now() + Math.max(0, Math.min(info.expireIn ?? 300, 900)) * 1000;
          job.scanToken = officialRegistrationUrl(info.url) ? randomBytes(16).toString("base64url") : undefined;
          this.changed();
        },
        signal: job.controller.signal,
      });
      if (job.controller.signal.aborted || this.closed) return;
      if (this.store.get("SELECT connector_id FROM personal_feishu_apps WHERE app_id=?", result.client_id)) throw new Error("该应用已添加");
      const currentProfile = this.assistantProfile(job.botId);
      if (!currentProfile) throw new Error("助手不存在");
      const connectorId = this.persistApp({ appId: result.client_id, appSecret: result.client_secret, brand: result.user_info?.tenant_brand === "lark" ? "lark" : "feishu", ownerOpenId: typeof result.user_info?.open_id === "string" ? result.user_info.open_id : null, botId: job.botId });
      if (currentProfile.name !== profile?.name || currentProfile.assetPath !== profile.assetPath) {
        this.store.run("UPDATE personal_feishu_apps SET profile_revision=1,profile_status='pending' WHERE connector_id=?", connectorId);
      }
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
    const appId = text(data.appId, 100), appSecret = text(data.appSecret, 300), botId = text(data.botId, 100);
    const brand: Brand = data.brand === "lark" ? "lark" : "feishu";
    if (!appId.startsWith("cli_")) throw new Error("App ID 无效");
    if (this.store.get("SELECT connector_id FROM personal_feishu_apps WHERE app_id=?", appId)) throw new Error("该应用已添加");
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
    this.userAuth = { id: String(app.connector_id), stage: "polling", controller };
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
        this.userAuth = { id: connectorId, stage: "done", controller };
        this.changed();
        return;
      }
      throw new Error("设备授权已过期，请重新发起");
    } catch (error) {
      if (controller.signal.aborted) return;
      this.userAuth = { id: connectorId, stage: "error", controller, error: safe(error) };
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
    const row = connectorAccess(this.store, args);
    if (args.action === "connector.tools") return { connectorId: row.id, connectorVersion: row.version, tools: feishuTools };
    if (args.tool === "feishu_delivery") {
      await authorize();
      const mapping = this.mappingFor(String(call.task_id ?? ""));
      if (mapping && (mapping.chat_type !== "p2p" || mapping.sender_open_id !== this.app(String(mapping.app_id))?.owner_open_id)) throw new Error("投递设置仅在本人私人话题操作");
      const params = record(args.parameters);
      const value = this.manageDelivery(call,params);
      return { text: JSON.stringify(value), images: [] };
    }
    let request: ReturnType<typeof parseToolCall>;
    try { request = parseToolCall(String(args.tool ?? ""), record(args.parameters)); }
    catch (error) { return { text: `参数无效：${error instanceof Error ? error.message : "参数无效"}`, images: [], isError: true }; }
    const controller = new AbortController();
    this.active.set(controller, String(call.task_id ?? ""));
    let dispatched = false;
    try {
      await authorize();
      connectorAccess(this.store, args);
      if (controller.signal.aborted) throw new Error("已取消");
      // Generic message/file/webhook writes have no verified public content view. Managed delivery uses the ledger.
      if (request.method !== "GET" && /^\/open-apis\/(im|bot|application)\//.test(request.path)) throw new Error("消息投递必须使用已核实内容和目的地的投递通道");
      const origin = this.mappingFor(String(call.task_id ?? ""));
      if (origin?.chat_type === "group" && request.as === "user") throw new Error("群话题不能使用主人的私人飞书授权");
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
      connectorAccess(this.store, args);
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

  destinations() {return this.store.all("SELECT app_id,chat_id,chat_type,enabled,version FROM feishu_destinations ORDER BY app_id,chat_id");}

  private expireUnknownDeliveries() {
    this.store.run("UPDATE feishu_delivery_parts SET state='needs_reconciliation',error='uuid_window_expired' WHERE state='pending' AND operation='send' AND first_post_at IS NOT NULL AND (first_post_at>? OR first_post_at<=?)", now(), now()-FEISHU_UUID_WINDOW_MS);
  }

  /** This list is exposed only in the authenticated owner's private settings, never to the model. */
  deliveries() {
    this.expireUnknownDeliveries();
    return this.store.all("SELECT * FROM feishu_delivery_parts ORDER BY created_at DESC,source_key,part").filter(part=>this.canReconcile(part)).map(part=>({
      ...part,
      dedupUntil: part.first_post_at == null ? null : Number(part.first_post_at)+FEISHU_UUID_WINDOW_MS,
      reconciliation: this.store.all("SELECT action,actor,evidence,message_id,recorded_at FROM feishu_delivery_reconciliations WHERE part_id=? ORDER BY recorded_at",part.id),
    }));
  }

  private canReconcile(part:Row) {
    const app=this.app(String(part.app_id));
    const destination=this.store.get("SELECT actor_open_id FROM feishu_destinations WHERE app_id=? AND chat_id=?",part.app_id,part.chat_id);
    return !!app?.owner_open_id && destination?.actor_open_id===app.owner_open_id;
  }

  private recordDelivered(part:Row, messageId:string) {
    this.store.transaction(()=>{
      const existing=this.store.get("SELECT conversation_id FROM feishu_topic_aliases WHERE app_id=? AND chat_id=? AND alias=?",part.app_id,part.chat_id,messageId);
      if(existing && existing.conversation_id!==part.conversation_id)throw new DeliveryNeedsReconciliation("provider_alias_conflict");
      this.store.run("UPDATE feishu_delivery_parts SET state='sent',message_id=?,root_id=?,error=NULL WHERE id=?",messageId,part.root_id??null,part.id);
      this.store.run("UPDATE personal_feishu_outbound SET message_id=COALESCE(message_id,?) WHERE source_key=? AND app_id=? AND chat_id=?",messageId,part.source_key,part.app_id,part.chat_id);
      this.store.run("INSERT OR REPLACE INTO feishu_topic_aliases(app_id,chat_id,alias,conversation_id,root_id,job_id) VALUES(?,?,?,?,?,?)",part.app_id,part.chat_id,messageId,part.conversation_id,part.root_id??messageId,part.job_id??null);
    });
  }

  async reconcileDelivery(data:Record<string,unknown>, actor:string, authorize?:()=>Promise<void>) {
    this.expireUnknownDeliveries();
    const part=this.store.get("SELECT * FROM feishu_delivery_parts WHERE id=?",text(data.id,100));
    if(!part || !this.canReconcile(part))throw new Error("没有管理此投递的权限");
    if(part.state!=="needs_reconciliation")throw new Error("此分段当前无需对账，请刷新状态");
    const evidence=text(data.evidence,2000);
    if(!evidence)throw new Error("请记录人工核对依据");
    const action=text(data.action,40);
    let messageId:string|null=null;
    if(action==="delivered") {
      // Older workers derived later report roots only in memory. Recover that exact root from its receipt.
      if(Number(part.part)>0 && !part.root_id) {
        const first=this.store.get("SELECT state,message_id FROM feishu_delivery_parts WHERE source_key=? AND app_id=? AND chat_id=? AND part=0",part.source_key,part.app_id,part.chat_id);
        if(first?.state!=="sent" || !first.message_id)throw new Error("首段尚未确认送达，无法核验后续分段话题");
        part.root_id=first.message_id;
      }
      messageId=text(data.messageId,200);
      if(!messageId || !/^om_[A-Za-z0-9_-]+$/.test(messageId))throw new Error("请输入有效的飞书 message_id");
      const result=await this.requestForApp(String(part.app_id),"GET",`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}?card_msg_content_type=user_card_content`);
      const items=record(result.data).items;
      const message=Array.isArray(items)&&items.length===1 ? record(items[0]) : {};
      const sender=record(message.sender);
      const receivedContent=record(message.body).content;
      let sameContent=false;
      try {sameContent=typeof receivedContent==="string" && canonical(JSON.parse(receivedContent))===canonical(JSON.parse(String(part.content)));} catch { /* Malformed or transformed cards cannot establish delivery. */ }
      if(message.message_id!==messageId || message.chat_id!==part.chat_id || message.msg_type!=="interactive" || message.deleted===true || sender.sender_type!=="app" || sender.id_type!=="app_id" || sender.id!==part.app_id || !sameContent || (part.root_id && message.root_id!==part.root_id && message.parent_id!==part.root_id))throw new Error("飞书消息的应用、群、发送者、话题或完整卡片内容不匹配，未登记");
    } else if(action!=="not_delivered" || data.confirmedNotDelivered!==true) {
      throw new Error("必须明确核实未送达后才能重试");
    }
    if(action==="not_delivered" && !await this.channelAvailable(String(part.app_id),"send"))throw new Error("当前通道未允许 NexBot 发送，不能重试");
    await authorize?.();
    this.store.transaction(()=>{
      const current=this.store.get("SELECT * FROM feishu_delivery_parts WHERE id=?",part.id);
      if(!current || current.state!=="needs_reconciliation" || current.uuid!==part.uuid || !this.canReconcile(current))throw new Error("投递状态或权限已改变，请刷新");
      if(action==="delivered")this.recordDelivered({...current,root_id:current.root_id??part.root_id},messageId!);
      else {
        if(!this.deliveryAllowed(current))throw new Error("当前投递规则不允许重试，请先核对目的地与订阅");
        this.store.run("UPDATE feishu_delivery_parts SET state='pending',uuid=?,first_post_at=NULL,post_tracking_version=1,next_at=0,error=NULL WHERE id=?",id(),part.id);
      }
      this.store.insert("feishu_delivery_reconciliations",{id:id(),part_id:part.id,action,actor,evidence,message_id:messageId,previous_uuid:part.uuid,first_post_at:part.first_post_at??null,recorded_at:now()});
    });
    this.changed();
    void this.flushOutbox();
    return {id:part.id,state:action==="delivered"?"sent":"pending"};
  }

  subscriptions() {
    return this.store.all("SELECT * FROM feishu_subscriptions ORDER BY updated_at DESC").map((r) => ({ ...r, kinds: safeJson(r.kinds_json), scenarios: safeJson(r.scenarios_json) }));
  }

  updateSubscription(data: Record<string, unknown>) {
    const appId = text(data.appId,100), chatId = text(data.chatId,200), instanceId = text(data.instanceId,200);
    const app = this.app(appId), destination = this.store.get("SELECT * FROM feishu_destinations WHERE app_id=? AND chat_id=? AND enabled=1", appId,chatId);
    if (!app || app.enabled !== 1 || !app.owner_open_id || !destination || destination.actor_open_id !== app.owner_open_id) throw new Error("目的地尚未由本人绑定");
    const audience = data.audience === "public" ? "public" : "private";
    if (destination.chat_type === "group" && audience !== "public") throw new Error("群目的地只允许已核实的公开视图");
    const kinds = Array.isArray(data.kinds) ? [...new Set(data.kinds.map((v) => text(v,100)))].sort() : [];
    const scenarios = Array.isArray(data.scenarios) ? [...new Set(data.scenarios.map((v) => text(v,100)))].sort() : ["proactive"];
    if (!kinds.length && data.enabled !== false) throw new Error("请选择投递内容类型");
    const key = hash(`${appId}:${chatId}:${instanceId}`);
    this.store.transaction(() => {
      const old = this.store.get("SELECT * FROM feishu_subscriptions WHERE id=?", key);
      if (old && Number(data.version) !== Number(old.version)) throw new Error("订阅已变化，请回读后重试");
      this.store.run("INSERT INTO feishu_subscriptions(id,app_id,chat_id,instance_id,kinds_json,scenarios_json,audience,enabled,version,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET kinds_json=excluded.kinds_json,scenarios_json=excluded.scenarios_json,audience=excluded.audience,enabled=excluded.enabled,version=version+1,updated_at=excluded.updated_at",key,appId,chatId,instanceId,JSON.stringify(kinds),JSON.stringify(scenarios),audience,data.enabled === false ? 0 : 1,now());
    });
    this.changed();
    return this.store.get("SELECT * FROM feishu_subscriptions WHERE id=?",key)!;
  }

  /** Called only after Stock's per-user grant has verified the event and fetched a permitted view. */
  ingestReport(report: { instanceId: string; reportId: string; version: string; kind: string; tradingDay: string | null; reportDate?: string; scenario?: string; conversationId?: string; views: Array<{ audience: "public" | "private"; content: string; verified: boolean }> }) {
    const source = `report:${hash(`${report.instanceId}:${report.reportId}:${report.version}`)}`;
    let queued = 0;
    this.store.transaction(() => {
      for (const subscription of this.store.all("SELECT * FROM feishu_subscriptions WHERE instance_id=? AND enabled=1",report.instanceId)) {
        if (!(safeJson(subscription.kinds_json) as string[]).includes(report.kind) || !(safeJson(subscription.scenarios_json) as string[]).some(s=>s==="all"||s===(report.scenario ?? "proactive"))) continue;
        const view = report.views.find((v) => v.verified && v.audience === subscription.audience);
        if (!view) continue;
        const app = this.app(String(subscription.app_id));
        if (!app?.owner_open_id) continue;
        if (this.store.get("SELECT id FROM feishu_delivery_parts WHERE source_key=? AND app_id=? AND chat_id=?",source,subscription.app_id,subscription.chat_id)) continue;
        const conversationId = report.conversationId ?? this.agents.createTopic(String(app.bot_id), { title: [report.tradingDay ?? report.reportDate, report.kind].filter(Boolean).join(" "), audience: subscription.audience === "public" ? "public" : "private", sourceContext: { instanceId: report.instanceId, reportId: report.reportId, version:report.version, tradingDay:report.tradingDay, ...(report.reportDate ? {reportDate: report.reportDate} : {}), kind:report.kind } }).id;
        const publicationKey=`feishu-report:${source}:${hash(`${subscription.app_id}:${subscription.chat_id}`)}`;
        this.agents.publish(String(app.bot_id),"assistant","message",view.content,publicationKey,null,null,now(),conversationId);
        if(!this.store.get("SELECT id FROM transcript WHERE source_key=?",publicationKey)) this.store.insert("transcript",{id:id(),conversation_id:conversationId,task_id:null,role:"assistant",content:view.content,source_key:publicationKey,created_at:now()});
        splitChunks(view.content).forEach((chunk,part) => this.enqueuePart({ source,appId:String(subscription.app_id),chatId:String(subscription.chat_id),conversationId,content:markdownCard(chunk),actor:String(app.owner_open_id),audience:String(subscription.audience),part,subscriptionId:String(subscription.id),subscriptionVersion:Number(subscription.version),contentKind:report.kind,scenario:report.scenario??"proactive" }));
        queued++;
      }
    });
    void this.flushOutbox();
    return { durable: true, queued };
  }

  private credentials(row: Row) {
    return { appId: String(row.app_id), appSecret: this.store.decrypt(String(row.app_secret)), brand: row.brand as Brand };
  }

  async connect(connectorId: string) {
    const app = this.store.get("SELECT a.*,c.enabled FROM personal_feishu_apps a JOIN personal_connectors c ON c.id=a.connector_id WHERE a.connector_id=?", connectorId);
    if (!app || app.enabled !== 1 || this.connecting.has(connectorId) || this.transports.has(connectorId)) return;
    if (appConsumers.has(String(app.app_id)) && appConsumers.get(String(app.app_id)) !== this) {
      this.store.run("UPDATE personal_feishu_apps SET connection='busy' WHERE connector_id=?",connectorId); return;
    }
    appConsumers.set(String(app.app_id),this);
    this.connecting.add(connectorId);
    if(!await this.channelAvailable(String(app.app_id),"connect")){this.connecting.delete(connectorId);appConsumers.delete(String(app.app_id));return;}
    const credentials = this.credentials(app);
    // 同一应用只允许一个长连接消费者：其它实例在线时不连接。
    try {
      if (await this.api.onlineInstances(credentials) > 0) {
        this.store.run("UPDATE personal_feishu_apps SET connection='busy',error=NULL WHERE connector_id=?", connectorId);
        this.changed(); this.connecting.delete(connectorId); appConsumers.delete(String(app.app_id));
        return;
      }
    } catch { this.connecting.delete(connectorId); appConsumers.delete(String(app.app_id)); return; }
    if (this.transports.has(connectorId)) return;
    try {
      void this.api.botInfo(credentials).then((info) => {
        if (!this.closed && (info.openId || info.name || info.avatarUrl)) { this.store.run("UPDATE personal_feishu_apps SET bot_open_id=COALESCE(?,bot_open_id),bot_name=COALESCE(?,bot_name),bot_avatar=COALESCE(?,bot_avatar) WHERE connector_id=?", info.openId ?? null, info.name ?? null, info.avatarUrl ?? null, connectorId); this.changed(); }
      }).catch(() => {});
      const transport = await this.transportFactory({ appId: credentials.appId, appSecret: credentials.appSecret, brand: credentials.brand }, {
        onMessage: (event) => this.options.routeInbound ? Promise.resolve(this.options.routeInbound(credentials.appId, event, "message")).then(() => {}) : this.receiveMessage(credentials.appId, event),
        onCardAction: (event) => this.options.routeInbound ? Promise.resolve(this.options.routeInbound(credentials.appId, event, "card")) : this.handleCardAction(credentials.appId, event),
      });
      if (this.closed || !this.store.get("SELECT 1 FROM personal_feishu_apps WHERE connector_id=?",connectorId)) { this.connecting.delete(connectorId); await transport.close().catch(() => {}); return; }
      this.transports.set(connectorId, transport);
      this.store.run("UPDATE personal_feishu_apps SET connection='connected',error=NULL WHERE connector_id=?", connectorId);
      this.store.audit("feishu.connect", "connector", connectorId, {});
    } catch (error) {
      appConsumers.delete(String(app.app_id));
      this.store.run("UPDATE personal_feishu_apps SET connection='error',error=? WHERE connector_id=?", safe(error), connectorId);
    }
    this.connecting.delete(connectorId);
    this.changed();
  }

  detachDeleted(ids:string[]) {
    for(const [app,consumer] of appConsumers)if(consumer===this && !this.store.get("SELECT 1 FROM personal_feishu_apps WHERE app_id=?",app)) appConsumers.delete(app);
    for(const connector of ids)void this.disconnect(connector,"disabled");
  }
  private async disconnect(connectorId: string, status: "idle" | "disabled") {
    const app = this.store.get("SELECT app_id FROM personal_feishu_apps WHERE connector_id=?",connectorId);
    if (app && appConsumers.get(String(app.app_id)) === this) appConsumers.delete(String(app.app_id));
    const transport = this.transports.get(connectorId);
    this.transports.delete(connectorId);
    try { await transport?.close(); } catch { /* 关闭失败不阻断状态更新 */ }
    this.store.run("UPDATE personal_feishu_apps SET connection=?,error=NULL WHERE connector_id=?", status, connectorId);
  }

  changeReceiver(data: Record<string, unknown>) {
    const id = text(data.id, 100), botId = text(data.botId, 100);
    const app = this.store.get("SELECT a.bot_id,c.version FROM personal_feishu_apps a JOIN personal_connectors c ON c.id=a.connector_id WHERE c.id=? AND c.kind='feishu'", id);
    if (!app || app.version !== Number(data.version)) throw new Error("连接器已变化，请刷新后重试");
    if (!this.store.get("SELECT 1 FROM bots WHERE id=? AND status='active' AND workspace_id=? AND owner_user_id=?", botId, this.store.workspace, this.store.owner)) throw new Error("助手不存在");
    if (app.bot_id === botId) return { ok: true };
    this.store.transaction(() => {
      this.store.run("UPDATE personal_feishu_apps SET bot_id=?,profile_revision=profile_revision+1,profile_status='pending' WHERE connector_id=?", botId, id);
      this.store.run("UPDATE personal_connectors SET version=version+1 WHERE id=?", id);
      this.store.audit("feishu.receiver.change", "connector", id, { botId });
    });
    this.changed();
    return { ok: true };
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
    this.groupLists.delete(String(row.app_id));
    this.store.transaction(() => {
      this.store.run("DELETE FROM personal_feishu_messages WHERE app_id=?", row.app_id);
      this.store.run("DELETE FROM personal_feishu_outbound WHERE app_id=?", row.app_id);
      this.store.run("DELETE FROM feishu_group_settings WHERE app_id=?", row.app_id);
      this.store.run("DELETE FROM personal_connectors WHERE id=?", row.id);
      this.store.audit("feishu.remove", "connector", String(row.id), {});
    });
    this.changed();
    return { ok: true };
  }

  setOwnershipGuard(guard:FeishuModuleOptions["ownershipAllowed"]) {this.options.ownershipAllowed=guard;}
  async channelAvailable(appId:string,operation:"receive"|"send"|"bind"|"connect") {
    if(this.quiesced.has(appId))return false;
    try {return !this.options.ownershipAllowed || await this.options.ownershipAllowed(appId,operation)===true;}
    catch {return false;}
  }
  manageDelivery(call:Row,args:Record<string,unknown>) {
    const mapping=this.mappingFor(String(call.task_id??""));
    if(mapping&&(mapping.chat_type!=="p2p"||mapping.sender_open_id!==this.app(String(mapping.app_id))?.owner_open_id)) throw new Error("投递设置仅在本人私人话题操作");
    if(args.operation==="list")return this.subscriptions();
    if(args.operation!=="upsert")throw new Error("未知投递设置操作");
    return this.store.transaction(()=>{
      const digest=hash(canonical(args)),prior=this.store.get("SELECT * FROM feishu_subscription_receipts WHERE call_id=?",call.id);
      if(prior){if(prior.request_hash!==digest)throw new Error("操作标识内容冲突");return safeJson(prior.result_json);}
      const result=this.updateSubscription(args);
      this.store.insert("feishu_subscription_receipts",{call_id:String(call.id),request_hash:digest,result_json:JSON.stringify(result)});
      return result;
    });
  }

  setRouting(options: Pick<FeishuModuleOptions,"routeInbound"|"sharedApp"|"sendRequest"|"authorizeActor"|"destinationAllowed">) { Object.assign(this.options,options); }

  private app(appId: string): Row | undefined {
    return this.options.sharedApp?.(appId) ?? this.store.get("SELECT a.*,c.enabled FROM personal_feishu_apps a JOIN personal_connectors c ON c.id=a.connector_id WHERE a.app_id=?", appId);
  }

  /** Synchronous commit is the ACK boundary. Model work runs only after this returns. */
  receiveMessage(appId: string, raw: unknown) {
    const event = normalizeFeishuEvent(raw), envelope = record(event.message), sender = record(event.sender);
    const messageId = pick(envelope, ["message_id"]), chatId = pick(envelope, ["chat_id"]);
    const actor = pick(record(sender.sender_id), ["open_id"]), app = this.app(appId);
    if (!app || app.enabled !== 1 || !messageId || !chatId || !actor || sender.sender_type !== "user") return;
    const tenant = pick(sender, ["tenant_key"]);
    if (app.tenant_key && tenant !== app.tenant_key) return;
    const wrappedApp = pick(record(record(raw).header), ["app_id"]);
    if (wrappedApp && wrappedApp !== appId) return;
    this.store.run("INSERT OR IGNORE INTO personal_feishu_messages(message_id,app_id,chat_id,chat_type,sender_open_id,created_at,payload) VALUES(?,?,?,?,?,?,?)", messageId, appId, chatId, envelope.chat_type === "group" ? "group" : "p2p", actor, now(), JSON.stringify(event));
    queueMicrotask(() => this.recoverInbound());
  }

  private async recoverInbound() {
    if (this.closed || this.recovering) return;
    this.recovering=true;
    try {
    for (const row of this.store.all("SELECT * FROM personal_feishu_messages WHERE state IN ('pending','retry') AND payload IS NOT NULL AND next_at<=? ORDER BY created_at,rowid", now())) {
      try {
        if(!await this.channelAvailable(String(row.app_id),"receive") || this.closed)continue;
        if(row.chat_type==="group")await this.ensureGroupInfo(String(row.app_id),String(row.chat_id));
        if(!this.closed)this.routeMessage(row);
      }
      catch (error) {
        if(this.closed)break;
        this.store.run("UPDATE personal_feishu_messages SET state='retry',attempts=attempts+1,next_at=?,error=? WHERE app_id=? AND chat_id=? AND message_id=?", retryAt(Number(row.attempts)), safe(error), row.app_id, row.chat_id, row.message_id);
      }
    }
    void this.flushOutbox();
    } finally {this.recovering=false;for(const resolve of this.recoverWaiters)resolve();this.recoverWaiters.clear();}
  }

  private routeMessage(row: Row) {
    const appId = String(row.app_id), chatId = String(row.chat_id), messageId = String(row.message_id), actor = String(row.sender_open_id);
    const app = this.app(appId);
    const ignore = () => this.store.run("UPDATE personal_feishu_messages SET state='ignored' WHERE app_id=? AND chat_id=? AND message_id=?", appId, chatId, messageId);
    if (!app || app.enabled !== 1) { ignore(); return; }
    const event = record(safeJson(row.payload)), envelope = record(event.message);
    let content = extractText(envelope).trim();
    if (!content) { ignore(); return; }
    const owner = actor === String(app.owner_open_id ?? "");
    if (row.chat_type === "p2p" && (!owner || app.private_enabled === 0)) {
      if (!app.owner_open_id && app.bind_code && app.bind_code === hash(content) && Number(app.bind_expires_at) > now()) {
        this.store.run("UPDATE personal_feishu_apps SET owner_open_id=?,bind_code=NULL,bind_expires_at=NULL WHERE connector_id=? AND owner_open_id IS NULL", actor, app.connector_id);
        void this.send(app, chatId, "已绑定主人。").catch(()=>{});
      }
      ignore(); return;
    }
    const refs = [pick(envelope, ["parent_id"]), pick(envelope, ["root_id"]), pick(envelope, ["thread_id"] )].filter((v): v is string => !!v);
    const threadId = pick(envelope, ["thread_id"]);
    const lookup = (ref: string) => this.store.get("SELECT * FROM feishu_topic_aliases WHERE app_id=? AND chat_id=? AND alias=?", appId, chatId, ref);
    const group = row.chat_type === "group" ? this.groupSetting(appId, chatId) : undefined;
    // p2p and topic groups keep one NexBot topic per Feishu thread; regular groups follow their session mode.
    const session = group && group.kind !== "topic" ? String(group.session) : "new-topic";
    // shared: the group's own long-running topic, answered inline instead of in a Feishu thread.
    const shared = session === "chat" || (session === "chat-topic" && !threadId);
    let alias: Row | undefined;
    if (session === "chat-topic" && !shared) {
      alias = [threadId!, ...refs].map(lookup).find((v): v is Row => !!v && v.conversation_id !== group?.conversation_id);
    } else if (!shared) {
      const aliases = [...refs,messageId].map(lookup).filter((v): v is Row => !!v);
      if (new Set(aliases.map((v) => v.conversation_id)).size > 1) throw new Error("conflicting_topic_aliases");
      alias = aliases[0];
    }
    const existing = alias ? this.store.get("SELECT bot_id,status FROM conversations WHERE id=?", alias.conversation_id) : undefined;
    if (existing?.status === "deleted") { ignore(); return; }
    const receiver = String(existing?.bot_id ?? app.bot_id);
    const destination = this.store.get("SELECT * FROM feishu_destinations WHERE app_id=? AND chat_id=? AND enabled=1", appId, chatId);
    if (row.chat_type === "group") {
      // An unclaimed group cannot execute in the owner's workspace.
      if (!destination) {
        if (!owner) { ignore(); return; }
        this.claimGroup({ appId, chatId, actorOpenId: actor });
      }
      const botOpenId = String(app.bot_open_id ?? "");
      const mentions = Array.isArray(envelope.mentions) ? envelope.mentions : [];
      const mentioned = !!botOpenId && mentions.some((entry) => pick(record(record(entry).id), ["open_id"]) === botOpenId);
      // A reply to a message the bot has already seen or sent counts as joining that conversation.
      const participated = !!alias || refs.some((ref) => !!lookup(ref));
      const trigger = String(group?.trigger ?? "topic");
      const respond = mentioned || trigger === "never" || (trigger === "topic" && participated) || (trigger === "ambient" && mentions.length === 0);
      if (!respond) { ignore(); return; }
      content = this.stripMentions(envelope, content, botOpenId).trim();
      if (!content) { ignore(); return; }
    } else {
      this.store.run("INSERT OR IGNORE INTO feishu_destinations(app_id,chat_id,chat_type,actor_open_id) VALUES(?,?,'p2p',?)", appId, chatId, actor);
    }
    // Child-before-root claims the trusted external root now. Later root events reuse it.
    const rootId = shared ? messageId : alias ? String(alias.root_id) : pick(envelope, ["root_id", "thread_id"]) ?? messageId;
    const clientId = `feishu:${hash(appId + ":" + chatId + ":" + messageId)}`;
    const chatName = typeof group?.name === "string" && group.name ? group.name : undefined;
    this.store.transaction(() => {
      const directJob = !shared && alias?.job_id ? this.store.get("SELECT id FROM agent_jobs WHERE id=? AND bot_id=? AND stopped_at IS NULL", alias.job_id, receiver) : undefined;
      const accepted = directJob && this.agents.jobs && owner
        ? this.agents.jobs.input(String(directJob.id), content, clientId, "direct", this.store.session)
        : shared
          ? this.agents.send(String(app.bot_id), content, clientId, this.store.session, { conversationId: this.groupConversation(app, chatId, chatName, event), audience: "public" })
          : this.agents.send(receiver, content, clientId, this.store.session, {
            ...(alias ? { conversationId: String(alias.conversation_id) } : { newConversation: true }),
            audience: alias ? (this.store.get("SELECT audience FROM agent_topics WHERE conversation_id=?",alias.conversation_id)?.audience === "public" ? "public" : "private") : row.chat_type === "group" ? "public" : "private",
            ...(!alias ? { sourceContext: { channel: "feishu", appId, chatId, chatType: row.chat_type, actorOpenId: actor, tenantKey: event.tenant_key ?? record(event.sender).tenant_key ?? null, ...(chatName ? { chatName } : {}) } } : {}),
          });
      const taskId = accepted.taskId;
      const conversationId = directJob && alias ? String(alias.conversation_id) : "conversationId" in accepted ? String(accepted.conversationId) : String(this.store.get("SELECT conversation_id FROM tasks WHERE id=?", taskId!)?.conversation_id);
      // The first input would title the topic after itself; the group's own topic keeps the group's name.
      if (shared && chatName) this.store.run("UPDATE conversations SET title=? WHERE id=? AND title!=?", chatName, conversationId, chatName);
      if (session === "new-topic") {
        for (const ref of new Set([messageId, rootId, ...refs])) {
          const old = lookup(ref);
          if (old && old.conversation_id !== conversationId) throw new Error("conflicting_topic_aliases");
          this.store.run("INSERT OR IGNORE INTO feishu_topic_aliases(app_id,chat_id,alias,conversation_id,root_id,job_id) VALUES(?,?,?,?,?,?)", appId, chatId, ref, conversationId, rootId, directJob?.id ?? null);
        }
      } else {
        // The group's shared topic and its threads overlap on root messages; only this message and its thread are claimed.
        for (const ref of new Set([messageId, ...(shared ? [] : [threadId!, rootId])]))
          this.store.run("INSERT OR IGNORE INTO feishu_topic_aliases(app_id,chat_id,alias,conversation_id,root_id,job_id) VALUES(?,?,?,?,?,?)", appId, chatId, ref, conversationId, rootId, directJob?.id ?? null);
      }
      this.store.run("UPDATE personal_feishu_messages SET state='routed',task_id=?,conversation_id=?,root_id=?,parent_id=?,thread_id=?,inline=?,error=NULL WHERE app_id=? AND chat_id=? AND message_id=?", taskId, conversationId, rootId, pick(envelope,["parent_id"]) ?? null, threadId ?? null, shared ? 1 : 0, appId, chatId, messageId);
      this.enqueuePart({ source: `placeholder:${appId}:${chatId}:${messageId}`, appId, chatId, conversationId, rootId, content: markdownCard("正在分析…"), actor, audience: row.chat_type === "group" ? "public" : "private", part: 0, inline: shared });
    });
    this.changed();
  }

  private groupSetting(appId: string, chatId: string) {
    return this.store.get("SELECT * FROM feishu_group_settings WHERE app_id=? AND chat_id=?", appId, chatId);
  }

  /** The group's own topic for shared session modes, recreated when deleted or owned by another assistant. */
  private groupConversation(app: Row, chatId: string, chatName: string | undefined, event: Record<string, unknown>) {
    const appId = String(app.app_id), current = this.groupSetting(appId, chatId)?.conversation_id;
    if (current && this.store.get("SELECT p.conversation_id FROM agent_topics p JOIN conversations c ON c.id=p.conversation_id WHERE p.conversation_id=? AND p.bot_id=? AND c.status='open'", current, app.bot_id)) return String(current);
    const { conversationId } = this.agents.createTopic(String(app.bot_id), { title: chatName ?? "飞书群聊", audience: "public",
      sourceContext: { channel: "feishu", appId, chatId, chatType: "group", scope: "group", tenantKey: event.tenant_key ?? record(event.sender).tenant_key ?? null, ...(chatName ? { chatName } : {}) } });
    this.store.run("INSERT INTO feishu_group_settings(app_id,chat_id,conversation_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(app_id,chat_id) DO UPDATE SET conversation_id=excluded.conversation_id", appId, chatId, conversationId, now());
    return conversationId;
  }

  private readonly groupInfoAttempts = new Map<string, number>();
  /** Caches the group's name, member count and whether it is a Feishu topic group. */
  private readonly groupLists = new Map<string, { expiresAt: number; error: string | null }>();
  private readonly pendingGroupLists = new Map<string, Promise<string | null>>();
  private readonly groupAvatars = new Map<string, { expiresAt: number; value: Promise<GroupAvatar | undefined> }>();

  private async refreshGroup(appId: string, chatId: string, name?: string, listAvatar?: string) {
    const result = await this.requestForApp(appId, "GET", `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`);
    const data = record(result.data);
    const topic = data.chat_mode === "topic" || data.group_message_type === "thread";
    const members = Number(data.user_count);
    this.store.run(`INSERT INTO feishu_group_settings(app_id,chat_id,name,kind,members,avatar_url,in_group,refreshed_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)
      ON CONFLICT(app_id,chat_id) DO UPDATE SET name=excluded.name,kind=excluded.kind,members=excluded.members,avatar_url=excluded.avatar_url,in_group=1,refreshed_at=excluded.refreshed_at`,
      appId, chatId, (pick(data, ["name"]) ?? name ?? "").slice(0, 200) || null, topic ? "topic" : "group", data.user_count != null && Number.isFinite(members) ? members : null, groupAvatarSource(pick(data, ["avatar"])) ?? listAvatar ?? null, now(), now());
  }
  /** Routing needs to know whether a group is a topic group. A failed lookup falls back to the defaults and retries later. */
  private async ensureGroupInfo(appId: string, chatId: string) {
    if (this.groupSetting(appId, chatId)?.refreshed_at) return;
    const key = `${appId}:${chatId}`;
    if ((this.groupInfoAttempts.get(key) ?? 0) > now() - 60_000) return;
    this.groupInfoAttempts.set(key, now());
    try { await this.refreshGroup(appId, chatId); }
    catch { this.store.run("INSERT OR IGNORE INTO feishu_group_settings(app_id,chat_id,updated_at) VALUES(?,?,?)", appId, chatId, now()); }
  }

  private groupRows(appId: string, connectorId: string) {
    this.store.run("INSERT OR IGNORE INTO feishu_group_settings(app_id,chat_id,updated_at) SELECT app_id,chat_id,? FROM feishu_destinations WHERE app_id=? AND chat_type='group' AND enabled=1", now(), appId);
    return this.store.all("SELECT s.*,d.chat_id AS claimed FROM feishu_group_settings s LEFT JOIN feishu_destinations d ON d.app_id=s.app_id AND d.chat_id=s.chat_id AND d.chat_type='group' AND d.enabled=1 WHERE s.app_id=? AND s.in_group=1 ORDER BY s.name IS NULL,s.name,s.chat_id", appId)
      .map((row) => ({ chatId: String(row.chat_id), name: row.name ? String(row.name) : null, kind: String(row.kind), members: row.members == null ? null : Number(row.members),
        avatarUrl: row.avatar_url ? `/api/feishu/group-avatar?id=${encodeURIComponent(connectorId)}&chat=${encodeURIComponent(String(row.chat_id))}&v=${hash(String(row.avatar_url)).slice(0, 16)}` : null,
        claimed: !!row.claimed, trigger: String(row.trigger), session: String(row.session), context: String(row.context ?? ""), version: Number(row.version) }));
  }
  private ownApp(connectorId: unknown) {
    const app = this.store.get("SELECT a.*,c.enabled FROM personal_feishu_apps a JOIN personal_connectors c ON c.id=a.connector_id WHERE a.connector_id=?", text(connectorId, 100));
    if (!app) throw new Error("应用不存在");
    return app;
  }

  async groups(data: Record<string, unknown>) {
    const app = this.ownApp(data.id), appId = String(app.app_id);
    let error: string | null = null;
    if (app.enabled === 1 && app.connection === "connected") {
      const cached = this.groupLists.get(appId);
      if (cached && cached.expiresAt > now()) error = cached.error;
      else {
        let pending = this.pendingGroupLists.get(appId);
        if (!pending) {
          pending = this.refreshGroupList(appId).then(error => {
            this.groupLists.set(appId, { error, expiresAt: now() + (error ? 30_000 : groupCacheMs) });
            return error;
          }).finally(() => this.pendingGroupLists.delete(appId));
          this.pendingGroupLists.set(appId, pending);
        }
        error = await pending;
      }
    }
    const remaining = (this.groupLists.get(appId)?.expiresAt ?? 0) - now();
    return { groups: this.groupRows(appId, String(app.connector_id)), error, cacheForMs: Math.max(0, remaining) };
  }

  private async refreshGroupList(appId: string): Promise<string | null> {
    try {
      const seen = new Set<string>();
      let pageToken = "";
      for (let page = 0; page < 10; page++) {
        const result = await this.requestForApp(appId, "GET", `/open-apis/im/v1/chats?page_size=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`);
        const list = record(result.data);
        for (const item of Array.isArray(list.items) ? list.items : []) {
          const chat = record(item), chatId = pick(chat, ["chat_id"]);
          if (!chatId) continue;
          seen.add(chatId);
          const avatar = groupAvatarSource(pick(chat, ["avatar"]));
          const cached = this.groupSetting(appId, chatId);
          if (cached?.refreshed_at && Number(cached.refreshed_at) > now() - groupCacheMs) {
            this.store.run("UPDATE feishu_group_settings SET in_group=1,avatar_url=COALESCE(?,avatar_url) WHERE app_id=? AND chat_id=?", avatar ?? null, appId, chatId);
            continue;
          }
          await this.refreshGroup(appId, chatId, pick(chat, ["name"]), avatar).catch(() => {
            this.store.run(`INSERT INTO feishu_group_settings(app_id,chat_id,name,avatar_url,updated_at) VALUES(?,?,?,?,?)
              ON CONFLICT(app_id,chat_id) DO UPDATE SET in_group=1,avatar_url=COALESCE(excluded.avatar_url,avatar_url)`,
            appId, chatId, pick(chat, ["name"]) ?? null, avatar ?? null, now());
          });
        }
        pageToken = pick(list, ["page_token"]) ?? "";
        if (list.has_more !== true) break;
        if (!pageToken || page === 9) return "群列表未完整加载";
      }
      for (const row of this.store.all("SELECT chat_id FROM feishu_group_settings WHERE app_id=? AND in_group=1", appId))
        if (!seen.has(String(row.chat_id))) this.store.run("UPDATE feishu_group_settings SET in_group=0 WHERE app_id=? AND chat_id=?", appId, row.chat_id);
      return null;
    } catch (e) { return safe(e); }
  }

  async groupAvatar(data: Record<string, unknown>) {
    const app = this.ownApp(data.id), chatId = text(data.chat, 100);
    const group = this.groupSetting(String(app.app_id), chatId);
    const url = group?.in_group === 1 && groupAvatarSource(typeof group.avatar_url === "string" ? group.avatar_url : undefined);
    if (!url || data.v !== hash(url).slice(0, 16)) return undefined;
    const key = `${app.connector_id}:${chatId}:${url}`;
    const cached = this.groupAvatars.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    for (const [old, entry] of this.groupAvatars) if (entry.expiresAt <= now()) this.groupAvatars.delete(old);
    while (this.groupAvatars.size >= 64) this.groupAvatars.delete(this.groupAvatars.keys().next().value!);
    const entry = { expiresAt: now() + groupCacheMs, value: this.fetchGroupAvatar(url) };
    this.groupAvatars.set(key, entry);
    return entry.value;
  }

  private async fetchGroupAvatar(url: string): Promise<GroupAvatar | undefined> {
    try {
      const response = await (this.options.fetchImpl ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(8000) });
      const mime = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (!response.ok || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime) ||
          !response.body || Number(response.headers.get("content-length")) > maxGroupAvatarBytes) {
        await response.body?.cancel();
        return undefined;
      }
      const parts: Uint8Array[] = [];
      let size = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > maxGroupAvatarBytes) return undefined;
          parts.push(part.value);
        }
        return size ? { bytes: Buffer.concat(parts), mime } : undefined;
      } finally { await reader.cancel().catch(() => {}); }
    } catch { return undefined; }
  }

  /** Saves one group's reply mode and context. Saving an unclaimed group lets the bound owner claim it. */
  saveGroup(data: Record<string, unknown>) {
    const app = this.ownApp(data.id), appId = String(app.app_id), chatId = text(data.chatId, 100);
    const trigger = String(data.trigger), session = String(data.session);
    if (!["always", "topic", "ambient", "never"].includes(trigger)) throw new Error("触发方式无效");
    if (!["chat-topic", "chat", "new-topic"].includes(session)) throw new Error("会话方式无效");
    if (typeof data.context !== "string" || data.context.length > 2000) throw new Error("系统上下文最多 2000 字");
    const context = data.context.trim();
    const row = this.groupSetting(appId, chatId);
    if (!row || row.in_group !== 1) throw new Error("群不存在，请刷新");
    if (Number(data.version) !== Number(row.version)) throw new Error("设置已变化，请刷新后重试");
    this.store.transaction(() => {
      if (!this.store.get("SELECT 1 AS ok FROM feishu_destinations WHERE app_id=? AND chat_id=? AND chat_type='group' AND enabled=1", appId, chatId)) {
        if (!app.owner_open_id) throw new Error("请先绑定主人");
        this.claimGroup({ appId, chatId, actorOpenId: String(app.owner_open_id) });
      }
      this.store.run("UPDATE feishu_group_settings SET trigger=?,session=?,context=?,version=version+1,updated_at=? WHERE app_id=? AND chat_id=?", trigger, session, context, now(), appId, chatId);
      this.store.audit("feishu.group.save", "connector", String(app.connector_id), { chatId, trigger, session, context: !!context });
    });
    this.changed();
    return this.groupRows(appId, String(app.connector_id)).find((group) => group.chatId === chatId);
  }

  claimGroup(data: { appId: string; chatId: string; actorOpenId: string }) {
    const app = this.app(data.appId);
    if (!app || app.enabled !== 1 || !app.owner_open_id || data.actorOpenId !== app.owner_open_id) throw new Error("仅已绑定主人可以绑定目的地");
    this.store.run("INSERT INTO feishu_destinations(app_id,chat_id,chat_type,actor_open_id) VALUES(?,?,'group',?) ON CONFLICT(app_id,chat_id) DO UPDATE SET actor_open_id=excluded.actor_open_id,enabled=1,version=version+1", data.appId, data.chatId, data.actorOpenId);
    this.changed();
    return { ok: true };
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

  /** Explicit publication ids avoid racing simultaneous topic completions. Recovery enumerates all unsent publications. */
  onPublished(botId?: string, publication?: { messageId: string }) {
    if (this.closed) return;
    const rows = publication ? this.store.all("SELECT * FROM agent_messages WHERE id=?", publication.messageId) : this.store.all("SELECT * FROM agent_messages WHERE role IN ('assistant','system') AND (kind IN ('message','error') OR source_key LIKE 'job-report:%') AND source_key NOT LIKE 'routine-report:%'" + (botId ? " AND bot_id=?" : ""), ...(botId ? [botId] : []));
    for (const message of rows) {
      if(!["assistant","system"].includes(String(message.role)) || !(message.kind === "message" || message.kind === "error" || String(message.source_key).startsWith("job-report:")) || String(message.source_key).startsWith("routine-report:"))continue;
      const mapping = this.mappingFor(String(message.task_id ?? ""));
      if (!mapping || this.store.get("SELECT id FROM conversations WHERE id=? AND status='deleted'", mapping.conversation_id)) continue;
      this.queueReply(mapping, message);
    }
    void this.flushOutbox();
  }

  private enqueuePart(input: { source: string; appId: string; chatId: string; conversationId: string; rootId?: string; content: string; actor: string; audience: string; part: number; jobId?: string; targetId?: string; subscriptionId?: string; subscriptionVersion?: number; contentKind?: string; scenario?:string; inline?: boolean }) {
    const key = hash(`${input.source}:${input.appId}:${input.chatId}:${input.part}`);
    this.store.run("INSERT OR IGNORE INTO feishu_delivery_parts(id,source_key,app_id,chat_id,conversation_id,root_id,job_id,content,part,operation,target_id,uuid,actor_open_id,audience,subscription_id,subscription_version,content_kind,scenario,created_at,post_tracking_version,inline) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)", key, input.source, input.appId, input.chatId, input.conversationId, input.rootId ?? null, input.jobId ?? null, input.content, input.part, input.targetId ? "patch" : "send", input.targetId ?? null, key.slice(0,32), input.actor, input.audience, input.subscriptionId ?? null, input.subscriptionVersion ?? null, input.contentKind ?? null, input.scenario ?? (input.subscriptionId ? "proactive" : "conversation"), now(), input.inline ? 1 : 0);
  }

  private queueReply(mapping: Row, message: Row) {
    if(mapping.chat_type === "group" && message.role === "system") {
      const source=`feishu-private-error:${message.source_key}`;
      if(this.store.get("SELECT id FROM agent_messages WHERE source_key=?",source))return;
      const app=this.app(String(mapping.app_id));if(!app?.owner_open_id)return;
      this.store.transaction(()=>{
        const conversationId=this.agents.createTopic(String(message.bot_id),{title:"通道通知",audience:"private",sourceContext:{channel:"feishu",appId:mapping.app_id,originConversationId:mapping.conversation_id}}).id;
        this.agents.publish(String(message.bot_id),"system","error",String(message.content),source,null,null,now(),conversationId);
        this.store.insert("transcript",{id:id(),conversation_id:conversationId,task_id:null,role:"system",content:String(message.content),source_key:source,created_at:now()});
        const destination=this.store.get("SELECT chat_id FROM feishu_destinations WHERE app_id=? AND chat_type='p2p' AND actor_open_id=? AND enabled=1",mapping.app_id,app.owner_open_id);
        if(destination)this.enqueuePart({source,appId:String(mapping.app_id),chatId:String(destination.chat_id),conversationId,content:markdownCard(`出错了：${message.content}`),actor:String(app.owner_open_id),audience:"private",part:0});
      });
      return;
    }
    if (String(message.source_key).startsWith("routine-report:")) return;
    const source = `reply:${message.source_key}`, appId = String(mapping.app_id), chatId = String(mapping.chat_id);
    if (this.store.get("SELECT id FROM feishu_delivery_parts WHERE source_key=? AND app_id=? AND chat_id=?", source, appId, chatId)) return;
    const conversationId = String(mapping.conversation_id ?? this.store.get("SELECT conversation_id FROM tasks WHERE id=?", message.task_id)?.conversation_id ?? "");
    const report = String(message.source_key).startsWith("job-report:");
    const pendingPlaceholder = !report ? this.store.get("SELECT state FROM feishu_delivery_parts WHERE source_key=?", `placeholder:${appId}:${chatId}:${mapping.message_id}`) : undefined;
    if (pendingPlaceholder && pendingPlaceholder.state !== "sent" && pendingPlaceholder.state !== "cancelled") return;
    const jobId = report ? this.store.get("SELECT job_id FROM agent_job_reports WHERE id=?", String(message.source_key).slice(11))?.job_id : null;
    const chunks = report ? [reportBody(String(message.content))] : splitChunks(message.role === "system" ? `出错了：${message.content}` : String(message.content));
    this.store.transaction(() => {
      this.store.run("INSERT OR IGNORE INTO personal_feishu_outbound(source_key,app_id,chat_id,created_at,job_id) VALUES(?,?,?,?,?)", source, appId, chatId, now(), jobId ?? null);
      const placeholder = !report ? this.store.get("SELECT message_id FROM feishu_delivery_parts WHERE source_key=? AND state='sent'", `placeholder:${appId}:${chatId}:${mapping.message_id}`) : undefined;
      const context = safeJson(this.store.get("SELECT source_context FROM agent_topics WHERE conversation_id=?",conversationId)?.source_context) as Record<string,unknown>;
      chunks.forEach((chunk, part) => this.enqueuePart({ source, appId, chatId, conversationId, rootId: String(mapping.root_id ?? mapping.message_id), content: markdownCard(chunk), actor: String(mapping.sender_open_id), audience: mapping.chat_type === "group" ? "public" : "private", part, contentKind:typeof context.kind === "string" ? context.kind : undefined, jobId: jobId ? String(jobId) : undefined, inline: mapping.inline === 1 && !report, ...(part === 0 && placeholder?.message_id ? { targetId: String(placeholder.message_id) } : {}) }));
    });
  }

  async requestWithCredentials(appId:string,method:"GET"|"POST"|"PUT"|"PATCH",path:string,body?:unknown,beforeSend?:()=>void):Promise<Record<string,unknown>> {
    const app=this.store.get("SELECT a.*,c.enabled FROM personal_feishu_apps a JOIN personal_connectors c ON c.id=a.connector_id WHERE app_id=?",appId);
    if(!app||app.enabled!==1||!await this.channelAvailable(appId,"send"))throw new Error("应用已停用或通道正在移交");
    return this.api.request(this.credentials(app),method,path,body,()=>{
      const current=this.store.get("SELECT c.enabled FROM personal_feishu_apps a JOIN personal_connectors c ON c.id=a.connector_id WHERE a.app_id=?",appId);
      if(this.closed||this.quiesced.has(appId)||current?.enabled!==1)throw new DeliveryCancelled("channel_changed");
      beforeSend?.();
    });
  }

  async quiesceApp(appId:string) {
    this.quiesced.add(appId);
    const app=this.store.get("SELECT connector_id FROM personal_feishu_apps WHERE app_id=?",appId);
    if(app)await this.disconnect(String(app.connector_id),"idle");
    for(const task of this.store.all("SELECT DISTINCT t.id FROM tasks t JOIN personal_feishu_messages m ON m.task_id=t.id WHERE m.app_id=? AND t.ended_at IS NULL",appId))this.runtime.cancel(String(task.id),"飞书通道正在移交，私人步骤已暂停");
    if(this.draining)await new Promise<void>(resolve=>this.drainWaiters.add(resolve));
  }
  async resumeApp(appId:string) {
    this.quiesced.delete(appId);
    if(!await this.channelAvailable(appId,"connect"))return;
    const app=this.store.get("SELECT connector_id FROM personal_feishu_apps WHERE app_id=?",appId);
    if(app)await this.connect(String(app.connector_id));
    void this.recoverInbound();void this.flushOutbox();
  }

  start() { for(const app of this.store.all("SELECT connector_id FROM personal_feishu_apps")) void this.connect(String(app.connector_id)); }

  async requestForApp(appId: string, method: "GET" | "POST" | "PUT" | "PATCH", path: string, body?: unknown,beforeSend?:()=>void): Promise<Record<string, unknown>> {
    const app = this.app(appId);
    if (!app || app.enabled !== 1 || !await this.channelAvailable(appId,"send")) throw new Error("应用已停用或通道未移交");
    if (!app.app_secret && this.options.sendRequest) return this.options.sendRequest(appId, method, path, body,beforeSend);
    return this.api.request(this.credentials(app), method, path, body,()=>{
      if(this.closed||this.quiesced.has(appId))throw new DeliveryCancelled("channel_changed");
      beforeSend?.();
    });
  }

  /** One synchronous predicate is reused at claim time and immediately before each provider fetch. */
  private deliveryAllowed(part:Row):boolean {
    if (part.conversation_id && this.store.get("SELECT id FROM conversations WHERE id=? AND status='deleted'", part.conversation_id)) return false;
    if(this.closed||this.quiesced.has(String(part.app_id)))return false;
    const app=this.app(String(part.app_id));
    const destination=this.store.get("SELECT * FROM feishu_destinations WHERE app_id=? AND chat_id=? AND enabled=1",part.app_id,part.chat_id);
    if(!app||app.enabled!==1||!destination)return false;
    if(this.options.destinationAllowed&&!this.options.destinationAllowed(String(part.app_id),String(part.actor_open_id),String(part.chat_id),String(part.audience)))return false;
    if(destination.chat_type==='group'&&(part.audience!=='public'||destination.actor_open_id!==app.owner_open_id))return false;
    if(part.audience==='private'&&(app.private_enabled===0||app.owner_open_id!==part.actor_open_id||destination.chat_type!=='p2p'||destination.actor_open_id!==part.actor_open_id))return false;
    if(part.subscription_id){
      const subscription=this.store.get("SELECT * FROM feishu_subscriptions WHERE id=?",part.subscription_id);
      if(!subscription||subscription.enabled!==1||subscription.app_id!==part.app_id||subscription.chat_id!==part.chat_id||subscription.audience!==part.audience)return false;
      const kinds=safeJson(subscription.kinds_json) as string[],scenarios=safeJson(subscription.scenarios_json) as string[];
      if(!kinds.includes(String(part.content_kind))||!scenarios.some(value=>value==='all'||value===(part.scenario??'proactive')))return false;
      if(Number(subscription.version)!==Number(part.subscription_version))this.store.run("UPDATE feishu_delivery_parts SET subscription_version=? WHERE id=?",subscription.version,part.id);
      return true;
    }
    if(destination.chat_type!=='group')return true;
    const rules=this.store.all("SELECT * FROM feishu_subscriptions WHERE app_id=? AND chat_id=? AND enabled=1",part.app_id,part.chat_id).filter(row=>(safeJson(row.scenarios_json) as string[]).some(value=>value==='all'||value==='conversation'));
    return !rules.length||rules.some(row=>row.audience==='public'&&(safeJson(row.kinds_json) as string[]).includes(String(part.content_kind)));
  }

  async flushOutbox() {
    if (this.draining || this.closed) return;
    this.expireUnknownDeliveries();
    this.draining = true;
    try {
      for (const part of this.store.all("SELECT * FROM feishu_delivery_parts WHERE state='pending' AND next_at<=? ORDER BY created_at,part", now())) {
        if (this.closed) break;
        if(!await this.channelAvailable(String(part.app_id),"send"))continue;
        if(!this.deliveryAllowed(part)) {
          this.store.run("UPDATE feishu_delivery_parts SET state=?,error=? WHERE id=? AND state='pending'",part.first_post_at==null?'cancelled':'needs_reconciliation',part.first_post_at==null?null:'rules_changed_unknown_delivery',part.id);continue;
        }
        if(this.options.authorizeActor && !await this.options.authorizeActor(String(part.app_id),String(part.actor_open_id),String(part.chat_id),part.audience === "private" ? "p2p" : "group").catch(()=>false)) {
          if(!this.deliveryAllowed(part))this.store.run("UPDATE feishu_delivery_parts SET state=?,error=? WHERE id=? AND state='pending'",part.first_post_at==null?'cancelled':'needs_reconciliation',part.first_post_at==null?null:'rules_changed_unknown_delivery',part.id);
          else this.store.run("UPDATE feishu_delivery_parts SET next_at=? WHERE id=? AND state='pending'",retryAt(Number(part.attempts)),part.id);
          continue;
        }
        if (Number(part.part) > 0) {
          const previous = this.store.get("SELECT state,message_id FROM feishu_delivery_parts WHERE source_key=? AND app_id=? AND chat_id=? AND part=?",part.source_key,part.app_id,part.chat_id,Number(part.part)-1);
          if (!previous || previous.state !== "sent") continue;
          if (!part.root_id) {
            const first = this.store.get("SELECT message_id FROM feishu_delivery_parts WHERE source_key=? AND app_id=? AND chat_id=? AND part=0",part.source_key,part.app_id,part.chat_id);
            if (!first?.message_id) continue;
            part.root_id = first.message_id;
          }
        }
        if (Number(this.store.run("UPDATE feishu_delivery_parts SET state='sending',root_id=?,attempts=attempts+1 WHERE id=? AND state='pending'", part.root_id??null, part.id).changes) !== 1) continue;
        try {
          const path = part.operation === "patch" ? `/open-apis/im/v1/messages/${encodeURIComponent(String(part.target_id))}` : part.root_id ? `/open-apis/im/v1/messages/${encodeURIComponent(String(part.root_id))}/reply` : "/open-apis/im/v1/messages?receive_id_type=chat_id";
          const result = await this.requestForApp(String(part.app_id), part.operation === "patch" ? "PATCH" : "POST", path, part.operation === "patch" ? { content: part.content } : { receive_id: part.chat_id, msg_type: "interactive", content: part.content, uuid: part.uuid, ...(part.root_id && part.inline !== 1 ? { reply_in_thread: true } : {}) },()=>{
            if(!this.deliveryAllowed(part))throw new DeliveryCancelled("delivery_rules_changed");
            if(part.operation!=="patch") {
              const current=this.store.get("SELECT first_post_at,state,uuid FROM feishu_delivery_parts WHERE id=?",part.id)!;
              if(current.state!=="sending" || current.uuid!==part.uuid)throw new DeliveryCancelled("delivery_state_changed");
              if(postWindowExpired(current))throw new DeliveryNeedsReconciliation("uuid_window_expired");
              this.store.run("UPDATE feishu_delivery_parts SET first_post_at=COALESCE(first_post_at,?),post_tracking_version=1 WHERE id=?",now(),part.id);
            }
          });
          const sent = part.operation === "patch" ? String(part.target_id) : pick(record(result.data), ["message_id"]);
          if (!sent) throw new Error("missing_provider_receipt");
          if (this.closed) break;
          this.recordDelivered(part,sent);
        } catch (error) {
          if (this.closed) break;
          const current=this.store.get("SELECT first_post_at FROM feishu_delivery_parts WHERE id=?",part.id)!;
          if(error instanceof DeliveryNeedsReconciliation || (part.operation!=="patch" && postWindowExpired(current))) {
            this.store.run("UPDATE feishu_delivery_parts SET state='needs_reconciliation',error=? WHERE id=?",error instanceof DeliveryNeedsReconciliation?error.message:"uuid_window_expired",part.id);
            continue;
          }
          if(error instanceof DeliveryCancelled || !this.deliveryAllowed(part)){
            this.store.run("UPDATE feishu_delivery_parts SET state=?,error=? WHERE id=? AND state='sending'",current.first_post_at==null?'cancelled':'needs_reconciliation',current.first_post_at==null?null:'rules_changed_unknown_delivery',part.id);continue;
          }
          // PATCH is idempotent; invalid/deleted placeholders fall back to the same durable reply UUID.
          if (part.operation === "patch" && error instanceof FeishuApiError && error.code===230011) this.store.run("UPDATE feishu_delivery_parts SET state='pending',operation='send',target_id=NULL,next_at=? WHERE id=?", retryAt(Number(part.attempts)), part.id);
          else this.store.run("UPDATE feishu_delivery_parts SET state='pending',next_at=? WHERE id=?", retryAt(Number(part.attempts)), part.id);
        }
      }
    } finally { this.draining = false;for(const resolve of this.drainWaiters)resolve();this.drainWaiters.clear(); }
  }

  /** 有飞书来源任务等待审批时发审批卡片；changed() 触发，去重靠 outbound 表。 */
  scanApprovals() {
    if (this.closed || this.scanning) return;
    this.scanning = true;
    void (async () => {
      try {
        const rows = this.store.all("SELECT a.id approval_id,a.argument_hash,t.tool_name,t.arguments_json,t.task_id FROM approvals a JOIN tool_calls t ON t.id=a.tool_call_id WHERE a.status='pending' AND a.expires_at>? AND NOT EXISTS(SELECT 1 FROM personal_feishu_outbound o WHERE o.source_key='approval:'||a.id) ORDER BY a.created_at", now());
        for (const row of rows) {
          const mapping = this.mappingFor(String(row.task_id));
          if (!mapping) continue;
          const job = this.jobOf(String(row.task_id));
          const sourceKey = `approval:${row.approval_id}`;
          const app = this.app(String(mapping.app_id));
          if (!app || app.enabled !== 1) continue;
          const privateDestination = this.store.get("SELECT * FROM feishu_destinations WHERE app_id=? AND chat_type='p2p' AND actor_open_id=? AND enabled=1",mapping.app_id,app.owner_open_id);
          if (!privateDestination) continue;
          const args = JSON.stringify(record(safeJson(row.arguments_json))).slice(0, 800);
          const card = markdownCard(`${job ? `后台任务「${String(job.title)}」\n` : ""}请求批准：${String(row.tool_name)}\n${args}`, [
            { text: "同意", value: { kind: "approval", id: row.approval_id, hash: row.argument_hash, decision: "allow" }, style: "primary" },
            { text: "拒绝", value: { kind: "approval", id: row.approval_id, hash: row.argument_hash, decision: "deny" } },
            { text: "停止任务", value: { kind: "stop", taskId: row.task_id } },
          ]);
          this.store.run("INSERT OR IGNORE INTO personal_feishu_outbound(source_key,app_id,chat_id,created_at) VALUES(?,?,?,?)",sourceKey,mapping.app_id,privateDestination.chat_id,now());
          this.enqueuePart({source:sourceKey,appId:String(mapping.app_id),chatId:String(privateDestination.chat_id),conversationId:String(mapping.conversation_id),content:card,actor:String(app.owner_open_id),audience:"private",part:0});
          void this.flushOutbox();
        }
      } catch { /* 下次变更再试 */ }
      finally { this.scanning = false; }
    })();
  }

  /** 卡片按钮回调：只信主人本人，decide 校验参数哈希。 */
  async handleCardAction(appId: string, raw: unknown): Promise<unknown> {
    try {
      const event = normalizeFeishuEvent(raw);
      const operator = pick(record(event.operator), ["open_id"]);
      const value = record(record(event.action).value);
      const app = this.app(appId);
      if (!app || app.enabled !== 1) return { toast: { type: "error", content: "应用不存在" } };
      if (!operator || operator !== String(app.owner_open_id ?? "")) return { toast: { type: "error", content: "仅主人可以操作" } };
      if (value.kind === "approval") {
        const approvalId = typeof value.id === "string" ? value.id : "", digest = typeof value.hash === "string" ? value.hash : "";
        const task = this.store.get("SELECT t.task_id FROM approvals a JOIN tool_calls t ON t.id=a.tool_call_id WHERE a.id=?",approvalId);
        const mapping = task ? this.mappingFor(String(task.task_id)) : undefined;
        if (!mapping || mapping.app_id !== appId || !await this.channelAuthorize({id:String(task!.task_id)})) return { toast: {type:"error",content:"授权已变化"} };
        try {
          this.runtime.decide(approvalId, digest, value.decision === "allow", this.store.session);
          this.changed();
          return { toast: { type: "success", content: value.decision === "allow" ? "已同意" : "已拒绝" } };
        } catch (error) { return { toast: { type: "error", content: safe(error) } }; }
      }
      if (value.kind === "stop") {
        const taskId = typeof value.taskId === "string" ? value.taskId : "";
        if (!taskId || this.mappingFor(taskId)?.app_id !== appId || !await this.channelAuthorize({id:taskId})) return { toast: { type: "error", content: "任务不存在" } };
        // A background job is stopped as a whole, so it takes no more input.
        const job = this.store.get("SELECT j.id FROM agent_jobs j JOIN tasks t ON t.conversation_id=j.conversation_id WHERE t.id=?", taskId);
        if (job) this.agents.jobs?.stop(String(job.id), "主人已在飞书停止后台任务");
        else this.runtime.cancel(taskId, "主人已在飞书停止任务");
        this.changed();
        return { toast: { type: "success", content: "已停止" } };
      }
      return { toast: { type: "error", content: "未知操作" } };
    } catch (error) { return { toast: { type: "error", content: safe(error) } }; }
  }

  private async send(app: Row, chatId: string, markdown: string, replyMessageId?: string) {
    for (const chunk of splitChunks(markdown)) await this.sendRaw(app, chatId, markdownCard(chunk), replyMessageId);
  }

  /** Sends one card and returns the Feishu message id ('' when the response carries none). */
  private async sendRaw(app: Row, chatId: string, content: string, replyMessageId?: string) {
    const credentials = this.credentials(app);
    const result = replyMessageId
      ? await this.api.request(credentials, "POST", `/open-apis/im/v1/messages/${encodeURIComponent(replyMessageId)}/reply`, { msg_type: "interactive", content })
      : await this.api.request(credentials, "POST", "/open-apis/im/v1/messages?receive_id_type=chat_id", { receive_id: chatId, msg_type: "interactive", content });
    return pick(record(record(result).data), ["message_id"]) ?? "";
  }

  async close() {
    this.closed = true;
    clearInterval(this.recovery);
    await Promise.all([this.draining?new Promise<void>(r=>this.drainWaiters.add(r)):Promise.resolve(),this.recovering?new Promise<void>(r=>this.recoverWaiters.add(r)):Promise.resolve()]);
    this.job?.controller.abort();
    this.job = undefined;
    this.userAuth?.controller.abort();
    this.userAuth = undefined;
    for (const transport of this.transports.values()) await transport.close().catch(() => {});
    this.transports.clear();
    for (const [appId, owner] of appConsumers) if (owner === this) appConsumers.delete(appId);
  }
}

function safeJson(value: unknown): unknown { try { return JSON.parse(String(value)); } catch { return {}; } }
