import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ConnectorTool } from "../../shared/personal-connectors.ts";
import { ClientIdentity } from "./clients.ts";
import { connectorAccess } from "./connectors.ts";
import { IdentityError } from "./identity-provider.ts";
import { hash, id, now, type CoreStore, type Row } from "./store.ts";

export interface StockConnection { url: string; token: string; instanceId: string; coreId: string; managedAppId?: string }
export interface StockReport { instanceId: string; reportId: string; version: string; kind: string; tradingDay: string | null; reportDate?: string; views: Array<{audience: "public" | "private"; content: string; verified: boolean}> }
export interface StockGrant { issuer: string; subject: string; instanceId: string; coreId: string; delegationId: string; delegationToken: string; refreshToken: string; expiresAt: number }
interface ExchangeResult { token: string; expiresAt: number; botId: string }
type Document = Record<string, unknown>;

export function stockConnectionFromEnv(): StockConnection | undefined {
  const { NEX_CORE_STOCK_URL: url, NEX_CORE_STOCK_TOKEN: token, NEX_CORE_STOCK_INSTANCE: instanceId, NEX_CORE_STOCK_CORE_ID: coreId } = process.env;
  if (![url, token, instanceId, coreId].some(Boolean)) return undefined;
  if (!url || !token || !instanceId || !coreId || token.length < 32) throw new Error("请完整配置 Stock 服务地址、实例、Core 标识和服务凭据");
  return { url, token, instanceId, coreId, managedAppId: process.env.NEX_CORE_STOCK_FEISHU_APP_ID?.trim() };
}
function object(value: unknown): value is Document { return !!value && typeof value === "object" && !Array.isArray(value); }
function field(value: unknown, max = 250): string {
  if (typeof value !== "string" || !value || value.length > max || Array.from(value).some(char => char.charCodeAt(0) < 32)) throw new IdentityError(502, "Stock 返回的字段无效");
  return value;
}
function validTools(result: Document): ConnectorTool[] {
  if (!Array.isArray(result.tools) || !result.tools.length) throw new IdentityError(502, "Stock 工具目录无效");
  const names = new Set<string>();
  return result.tools.map((tool: unknown) => {
    if (!object(tool) || !object(tool.inputSchema)) throw new IdentityError(502, "Stock 工具定义无效");
    const name = field(tool.name, 200);
    if (names.has(name)) throw new IdentityError(502, "Stock 工具名称重复");
    names.add(name);
    return { name, description: typeof tool.description === "string" ? tool.description : "", inputSchema: tool.inputSchema,
      ...(object(tool.annotations) ? { annotations: { readOnlyHint: tool.annotations.readOnlyHint === true, destructiveHint: tool.annotations.destructiveHint === true } } : {}) };
  });
}

export class StockFinance {
  onHistorySession?: (sessionId:string)=>void;
  routeGrant?: (grant: StockGrant) => Promise<ExchangeResult>;
  private readonly aborters = new Map<string, Set<AbortController>>();
  private readonly inFlightVerification = new Map<string, Promise<void>>();
  private readonly renewals = new Map<string, Promise<Row>>();
  private reportPoll?: Promise<void>;
  reportStatus: { checkedAt: number; error?: string } = { checkedAt: 0 };
  private reportTimer?: ReturnType<typeof setInterval>;
  private readonly stopping = new AbortController();
  private readonly origin?: string;
  constructor(readonly store: CoreStore, readonly clients: ClientIdentity, readonly config?: StockConnection) {
    if (config) {
      const url = new URL(config.url);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password || url.pathname !== "/" || url.hash || url.search || config.token.length < 32) throw new Error("Stock 连接需要受信任的服务根地址和凭据");
      this.origin = url.origin;
    }
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS stock_finance_bindings (
        instance_id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, grant_id TEXT NOT NULL,
        lease TEXT NOT NULL, expires_at INTEGER NOT NULL, connector_id TEXT NOT NULL, auto_grant INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE TABLE IF NOT EXISTS stock_finance_sessions (
        session_id TEXT PRIMARY KEY REFERENCES user_sessions(id), instance_id TEXT NOT NULL REFERENCES stock_finance_bindings(instance_id),
        grant_id TEXT NOT NULL, lease TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS stock_report_cursors (instance_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL) STRICT;`);
    if (!store.all("PRAGMA table_info(stock_finance_bindings)").some(row => row.name === "renewal")) {
      store.db.exec("ALTER TABLE stock_finance_bindings ADD COLUMN renewal TEXT");
    }
    store.db.exec("CREATE TABLE IF NOT EXISTS stock_public_report_cursors (instance_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL) STRICT");
  }
  private async request(path: string, options: { method?: string; body?: Document; grant?: string; subscription?: string; audience?: string; signal?: AbortSignal } = {}) {
    if (!this.config || !this.origin) throw new IdentityError(503, "此 Core 尚未配置 Stock 连接");
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), this.stopping.signal]);
    let response: Response;
    try {
      response = await fetch(this.origin + "/api/v1/finance/" + path, {
        method: options.method ?? "POST", redirect: "error", signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
        headers: { Accept: "application/json", Authorization: "Bearer " + this.config.token,
          ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.grant ? { "X-Finance-Delegation": options.grant } : {}),
          ...(options.audience ? { "X-Finance-Audience": options.audience } : {}),
          ...(options.subscription ? { "X-Finance-Subscription": options.subscription } : {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (cause) { throw new IdentityError(503, cause instanceof Error && cause.name === "AbortError" ? "Stock 请求已取消" : "Stock 服务连接中断"); }
    if (!response.ok) {
      let code = "";
      try {
        const error: unknown = await response.json();
        const val = object(error) && object(error.detail) ? error.detail.error : object(error) ? error.error : undefined;
        if (typeof val === "string" && /^[\w-]{1,100}$/.test(val)) code = " " + val;
      } catch { code = ""; }
      throw new IdentityError(response.status, "Stock 请求失败 " + response.status + code);
    }
    const result: unknown = await response.json();
    if (!object(result)) throw new IdentityError(502, "Stock 返回了无效数据");
    return result;
  }
  private checkSubject(data: Document, expected?: { issuer: string; subject: string; delegationId: string }) {
    const issuer = field(data.issuer, 2048), subject = field(data.subject), delegationId = field(data.delegationId);
    const provider = this.store.get("SELECT base_url FROM identity_provider WHERE id=1");
    if (!this.config || data.coreId !== this.config.coreId || data.instanceId !== this.config.instanceId || issuer !== provider?.base_url ||
        (expected && (expected.issuer !== issuer || expected.subject !== subject || expected.delegationId !== delegationId))) throw new IdentityError(403, "金融委托与当前账号或服务不匹配");
    if (!Number.isSafeInteger(data.expiresAt) || Number(data.expiresAt) <= now()) throw new IdentityError(401, "金融委托已过期");
    return { issuer, subject, delegationId, expiresAt: Number(data.expiresAt), instanceId: this.config.instanceId, coreId: this.config.coreId };
  }
  async exchange(auth: string | undefined, data: Document, defaultBot: () => string) {
    if (!this.config) throw new IdentityError(503, "此 Core 尚未连接 Stock");
    if (!timingSafeEqual(Buffer.from(hash(auth ?? "")), Buffer.from(hash("Bearer " + this.config.token)))) throw new IdentityError(401, "Stock 服务凭据无效");
    if (data.instanceId !== this.config.instanceId) throw new IdentityError(403, "Stock 实例不匹配");
    const result = await this.request("session-exchanges/redeem", { body: { code: field(data.code, 512), coreId: this.config.coreId } });
    const grant: StockGrant = { ...this.checkSubject(result), delegationToken: field(result.delegationToken, 1024), refreshToken: field(result.refreshToken, 1024) };
    return this.routeGrant ? this.routeGrant(grant) : this.accept(grant, defaultBot, false);
  }
  async accept(grant: StockGrant, defaultBot: () => string, mayProvision: boolean): Promise<ExchangeResult> {
    this.checkSubject({ ...grant });
    const tools = validTools(await this.request("tools", { method: "GET", grant: grant.delegationToken }));
    const starts = await this.initialReportCursors(grant);
    const token = "stock_" + randomBytes(32).toString("base64url"), sessionId = id(), storedLease = this.store.encrypt(grant.delegationToken);
    this.store.transaction(() => {
      const provider = this.store.get("SELECT * FROM identity_provider WHERE id=1")!;
      const owner = this.store.get("SELECT * FROM external_identities WHERE id=? AND status='active'", provider.external_identity_id);
      if (!owner) {
        if (provider.connected || !mayProvision) throw new IdentityError(403, "请先在此个人工作区关联同一用户中心账号");
        const externalId = id();
        this.store.insert("external_identities", { id: externalId, user_id: this.store.owner, protocol: "native-v1", issuer: grant.issuer, subject: grant.subject, status: "active", created_at: now() });
        this.store.run("UPDATE identity_provider SET connected=1,external_identity_id=?,version=version+1 WHERE id=1", externalId);
      } else if (owner.issuer !== grant.issuer || owner.subject !== grant.subject || owner.user_id !== this.store.owner) throw new IdentityError(403, "Stock 用户与此工作区不匹配");
    });
    const botId = defaultBot();
    this.store.transaction(() => {
      const previous = this.store.get("SELECT * FROM stock_finance_bindings WHERE instance_id=?", grant.instanceId);
      if (previous && (previous.issuer !== grant.issuer || previous.subject !== grant.subject)) throw new IdentityError(403, "金融实例绑定了其他用户");
      const connectorId = String(previous?.connector_id ?? id());
      if (!previous || (!this.store.get("SELECT id FROM personal_connectors WHERE id=?", connectorId) && previous.grant_id !== grant.delegationId)) {
        this.store.insert("personal_connectors", { id: connectorId, ...this.store.scope(), name: "nex_stock 金融服务", url: this.origin!, transport: "http", kind: "stock-finance", enabled: 1, created_at: now() });
      }
      this.store.run(`INSERT INTO stock_finance_bindings(instance_id,issuer,subject,grant_id,lease,expires_at,connector_id) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(instance_id) DO UPDATE SET grant_id=excluded.grant_id,lease=excluded.lease,expires_at=excluded.expires_at`, grant.instanceId, grant.issuer, grant.subject, grant.delegationId, storedLease, grant.expiresAt, connectorId);
      this.store.run("UPDATE stock_finance_bindings SET renewal=? WHERE instance_id=?", this.store.encrypt(grant.refreshToken), grant.instanceId);
      this.saveDirectory(connectorId, botId, tools);
      for (const [table, cursor] of starts) {
        this.store.run(`INSERT OR IGNORE INTO ${table}(instance_id,cursor) VALUES(?,?)`, grant.instanceId, cursor);
      }
      this.store.insert("user_sessions", { id: sessionId, workspace_id: this.store.workspace, user_id: this.store.owner, token_hash: hash(token), protocol: "local", revocation_mode: "local", created_at: now(), expires_at: grant.expiresAt });
      this.store.insert("stock_finance_sessions", { session_id: sessionId, instance_id: grant.instanceId, grant_id: grant.delegationId, lease: storedLease });
    });
    this.onHistorySession?.(sessionId);
    return { token, expiresAt: grant.expiresAt, botId };
  }
  private saveDirectory(connectorId: string, botId: string, tools: ConnectorTool[]) {
    const row = this.store.get("SELECT tools_json FROM personal_connectors WHERE id=?", connectorId);
    if (!row) return;
    const json = JSON.stringify(tools);
    if (row.tools_json !== json) this.store.run("UPDATE personal_connectors SET tools_json=?,checked_at=?,version=version+1 WHERE id=?", json, now(), connectorId);
    const role = this.store.get("SELECT bot_id FROM agent_roles WHERE workspace_id=? AND owner_user_id=? AND role='finance_assistant'", this.store.workspace, this.store.owner);
    if (role?.bot_id !== botId || this.store.get("SELECT auto_grant FROM stock_finance_bindings WHERE connector_id=?", connectorId)?.auto_grant !== 1) return;
    this.store.run("INSERT INTO personal_connector_grants(connector_id,bot_id,tools_json) VALUES(?,?,?) ON CONFLICT(connector_id,bot_id) DO UPDATE SET tools_json=excluded.tools_json", connectorId, botId, JSON.stringify(tools.map(tool => tool.name)));
  }
  private sessionLease(sessionId: string) {
    return this.store.get(`SELECT b.issuer,b.subject,b.grant_id,s.lease FROM stock_finance_sessions s JOIN stock_finance_bindings b ON b.instance_id=s.instance_id AND b.grant_id=s.grant_id WHERE s.session_id=?`, sessionId);
  }
  async historyScope(sessionId: string) {
    const session=this.clients.authenticateTokenSession(sessionId);
    if(!session||session.user_id!==this.store.owner)throw new IdentityError(401,'历史账号会话无效');
    const binding=this.store.get('SELECT b.* FROM stock_finance_bindings b JOIN personal_connectors c ON c.id=b.connector_id WHERE b.instance_id=? AND c.enabled=1 AND c.workspace_id=? AND c.owner_user_id=?',this.config?.instanceId??'',this.store.workspace,this.store.owner);
    if(!binding)throw new IdentityError(401,'Stock 历史未绑定');
    const scoped=this.sessionLease(sessionId);
    if(this.hasSession(sessionId)&&!scoped)throw new IdentityError(401,'历史委托已撤销');
    const provider=this.store.get("SELECT e.issuer,e.subject FROM identity_provider p JOIN external_identities e ON e.id=p.external_identity_id WHERE p.id=1 AND e.status='active'");
    if(!provider||provider.issuer!==binding.issuer||provider.subject!==binding.subject)throw new IdentityError(403,'历史工作区主体不匹配');
    await this.verify(await this.liveBinding(binding));
    return {instanceId:String(binding.instance_id),issuer:String(binding.issuer),subject:String(binding.subject)};
  }
  async historyPage(sessionId:string,after:number,limit:number) {
    const scope=await this.historyScope(sessionId);
    const binding=await this.liveBinding(this.store.get('SELECT * FROM stock_finance_bindings WHERE instance_id=?',this.config!.instanceId)!);
    let result:Document;
    try{result=await this.request(`history?after=${after}&limit=${limit}`,{method:'GET',grant:this.store.decrypt(String(binding.lease)),audience:'private'});}
    catch(error){if(error instanceof IdentityError&&error.status===404)throw new IdentityError(502,'Stock 历史接口不可用');throw error;}
    const current=await this.historyScope(sessionId);
    if(scope.instanceId!==current.instanceId||scope.issuer!==current.issuer||scope.subject!==current.subject)throw new IdentityError(403,'历史主体在请求时已变化');
    return result;
  }
  hasSession(sessionId: string) { return !!this.store.get("SELECT 1 AS ok FROM stock_finance_sessions WHERE session_id=?", sessionId); }
  hasBinding() { return !!this.config && !!this.store.get("SELECT 1 AS ok FROM stock_finance_bindings WHERE instance_id=?", this.config.instanceId); }
  async authorizeBoundOwner() {
    if (!this.config) return false;
    const binding = this.store.get(`SELECT b.* FROM stock_finance_bindings b
      JOIN identity_provider p ON p.connected=1
      JOIN external_identities e ON e.id=p.external_identity_id AND e.status='active' AND e.issuer=b.issuer AND e.subject=b.subject
      JOIN memberships m ON m.user_id=e.user_id AND m.workspace_id=? AND m.status='active'
      JOIN users u ON u.id=e.user_id AND u.status='active'
      JOIN workspaces w ON w.id=m.workspace_id AND w.status='active'
      WHERE b.instance_id=? AND e.user_id=?`, this.store.workspace, this.config.instanceId, this.store.owner);
    if (!binding) return false;
    await this.verify(await this.liveBinding(binding));
    return true;
  }
  locallyAllowed(token: string) {
    const session = this.clients.authenticate(token);
    return session && this.sessionLease(String(session.id)) ? session : undefined;
  }
  private async verify(row: Row) {
    const key = String(row.lease);
    let pending = this.inFlightVerification.get(key);
    if (!pending) {
      pending = (async () => {
        const lease = this.store.decrypt(key);
        const result = await this.request("delegations/verify", { body: {}, grant: lease });
        this.checkSubject(result, { issuer: String(row.issuer), subject: String(row.subject), delegationId: String(row.grant_id) });
      })().finally(() => this.inFlightVerification.delete(key));
      this.inFlightVerification.set(key, pending);
    }
    await pending;
  }
  async authorizeSession(sessionId: string) {
    const row = this.sessionLease(sessionId);
    if (!row || !this.clients.authenticateTokenSession(sessionId)) return false;
    try { await this.verify(row); } catch (error) {
      if (error instanceof IdentityError && [401,403].includes(error.status)) this.store.run("UPDATE user_sessions SET revoked_at=?,version=version+1 WHERE id=? AND revoked_at IS NULL", now(), sessionId);
      throw error;
    }
    return !!this.sessionLease(sessionId) && !!this.clients.authenticateTokenSession(sessionId);
  }
  private liveBinding(row: Row) {
    const grantId = String(row.grant_id);
    if (Number(row.expires_at) > now() + 5_000) return Promise.resolve(row);
    let pending = this.renewals.get(grantId);
    if (!pending) {
      pending = this.renewBinding(row).finally(() => this.renewals.delete(grantId));
      this.renewals.set(grantId, pending);
    }
    return pending;
  }
  private async renewBinding(row: Row) {
    if (!row.renewal) throw new IdentityError(401, "请在 Stock 重新连接金融助手");
    const result = await this.request("delegations/renew", {
      body: {delegationId: String(row.grant_id), refreshToken: this.store.decrypt(String(row.renewal))},
    });
    const renewed = this.checkSubject(result, { issuer: String(row.issuer), subject: String(row.subject), delegationId: String(row.grant_id) });
    const token = field(result.delegationToken, 1024);
    this.store.run("UPDATE stock_finance_bindings SET lease=?,expires_at=? WHERE instance_id=? AND grant_id=? AND lease=?",
      this.store.encrypt(token), renewed.expiresAt, row.instance_id, row.grant_id, row.lease);
    const current = this.store.get("SELECT * FROM stock_finance_bindings WHERE instance_id=? AND grant_id=?", row.instance_id, row.grant_id);
    if (!current || Number(current.expires_at) <= now()) throw new IdentityError(401, "金融授权已变更");
    return current;
  }
  async authorizeTask(sessionId: string) {
    // The originating web session remains short-lived. An accepted task may continue
    // on the same explicit binding only while Stock can verify the owner upstream.
    const row = this.store.get(`SELECT b.* FROM stock_finance_bindings b
      JOIN stock_finance_sessions f ON f.instance_id=b.instance_id AND f.grant_id=b.grant_id
      JOIN user_sessions s ON s.id=f.session_id AND s.revoked_at IS NULL
      JOIN memberships m ON m.workspace_id=s.workspace_id AND m.user_id=s.user_id AND m.status='active'
      JOIN users u ON u.id=s.user_id AND u.status='active'
      JOIN workspaces w ON w.id=s.workspace_id AND w.status='active'
      WHERE s.id=? AND s.workspace_id=? AND s.user_id=?`, sessionId, this.store.workspace, this.store.owner);
    if (!row) return false;
    await this.verify(await this.liveBinding(row));
    return true;
  }
  async authenticate(token: string) {
    const session = this.locallyAllowed(token);
    return session && await this.authorizeSession(String(session.id)) ? session : undefined;
  }
  handles(args: Document) { return typeof args.connectorId === "string" && this.store.get("SELECT kind FROM personal_connectors WHERE id=?", args.connectorId)?.kind === "stock-finance"; }
  async testConnector(connectorId: string, version: unknown, authorize: () => Promise<void>) {
    const binding = this.store.get(`SELECT b.*,c.version,c.enabled FROM stock_finance_bindings b
      JOIN personal_connectors c ON c.id=b.connector_id WHERE c.id=? AND c.workspace_id=? AND c.owner_user_id=?`, connectorId, this.store.workspace, this.store.owner);
    if (!binding || binding.version !== version || !binding.enabled) throw new IdentityError(409, "请刷新已启用的金融连接器");
    await authorize();
    const lease = this.store.decrypt(String((await this.liveBinding(binding)).lease));
    const tools = validTools(await this.request("tools", {method: "GET", grant: lease}));
    await authorize();
    const role = this.store.get("SELECT bot_id FROM agent_roles WHERE workspace_id=? AND owner_user_id=? AND role='finance_assistant'", this.store.workspace, this.store.owner);
    this.store.transaction(() => {
      const current = this.store.get("SELECT version FROM personal_connectors WHERE id=? AND enabled=1", connectorId);
      if (current?.version !== version || !role) throw new IdentityError(409, "金融连接器已变化");
      this.saveDirectory(connectorId, String(role.bot_id), tools);
      this.store.run("UPDATE personal_connectors SET checked_at=?,error=NULL WHERE id=?", now(), connectorId);
    });
    return {ok: true, count: tools.length};
  }
  async execute(call: Row, args: Document, authorize: () => Promise<void>, audience: "private" | "public") {
    const row = connectorAccess(this.store, String(call.bot_id), args);
    const binding = this.store.get("SELECT * FROM stock_finance_bindings WHERE connector_id=?", row.id);
    if (!binding) throw new IdentityError(401, "金融服务未绑定");
    const task = this.store.get("SELECT conversation_id FROM tasks WHERE id=?", call.task_id);
    if (!task) throw new IdentityError(403, "金融任务已失效");
    const taskId = String(call.task_id), controller = new AbortController();
    const active = this.aborters.get(taskId) ?? new Set<AbortController>(); this.aborters.set(taskId, active); active.add(controller);
    try {
      await authorize();
      const lease = this.store.decrypt(String((await this.liveBinding(binding)).lease));
      if (args.action === "connector.tools") {
        const tools = validTools(await this.request("tools", { method: "GET", grant: lease, audience, signal: controller.signal }));
        if (audience === "private") this.store.transaction(() => this.saveDirectory(String(row.id), String(call.bot_id), tools));
        const current = connectorAccess(this.store, String(call.bot_id), args);
        const allowed = JSON.parse(String(current.allowed_tools)) as string[];
        return { connectorId: row.id, connectorVersion: current.version, tools: tools.filter(tool => allowed.includes(tool.name)) };
      }
      const answer = await this.request("tools/call", { body: { name: args.tool, arguments: args.parameters ?? {}, operationId: String(call.id) }, grant: lease, audience, signal: controller.signal });
      await authorize();
      connectorAccess(this.store, String(call.bot_id), args);
      return { text: JSON.stringify(answer), structured: answer, isError: answer.ok === false };
    } finally {
      active.delete(controller);
      if (!active.size) this.aborters.delete(taskId);
    }
  }
  async channelOwnership() {
    if (!this.config?.managedAppId) throw new IdentityError(409, "此工作区尚未指定受管金融飞书应用");
    const state = await this.request("channels/feishu", { method: "GET" });
    if (state.managed !== true || state.appId !== this.config.managedAppId) throw new IdentityError(409, "Stock 与 Core 的受管飞书应用不一致");
    return state;
  }
  async mayUseChannel(appId: string) { return appId !== this.config?.managedAppId || (await this.channelOwnership()).owner === "core"; }
  async changeChannel(expectedVersion: unknown, owner: unknown) {
    if (!Number.isSafeInteger(expectedVersion) || !["stock", "paused", "core"].includes(String(owner))) throw new IdentityError(400, "通道状态或版本无效");
    const state = await this.channelOwnership();
    if (state.version !== expectedVersion) throw new IdentityError(409, "通道版本已变化，请刷新");
    return this.request("channels/feishu", { body: { expectedVersion, owner, appId: this.config!.managedAppId } });
  }
  pollReports(deliver: (report: StockReport) => {durable: boolean}) {
    if (this.reportPoll) return this.reportPoll;
    this.reportPoll = this.consumeReports(deliver).finally(() => { this.reportPoll = undefined; });
    return this.reportPoll;
  }
  private async initialReportCursors(grant: StockGrant) {
    const feeds = [
      {table: "stock_report_cursors", path: "reports/events", auth: {grant: grant.delegationToken}},
      {table: "stock_public_report_cursors", path: "reports/public-events", auth: {subscription: grant.refreshToken}},
    ];
    return Promise.all(feeds.filter(feed => !this.store.get(`SELECT cursor FROM ${feed.table} WHERE instance_id=?`, grant.instanceId)).map(async feed => {
      const head = await this.request(feed.path + "?head=true", {method: "GET", ...feed.auth});
      if (!Number.isSafeInteger(head.nextCursor) || Number(head.nextCursor) < 0) throw new IdentityError(502, "Stock 初始报告游标无效");
      return [feed.table, Number(head.nextCursor)] as const;
    }));
  }
  private async consumeReports(deliver: (report: StockReport) => {durable: boolean}) {
    if (!this.config || this.stopping.signal.aborted) return;
    const row = this.store.get("SELECT * FROM stock_finance_bindings WHERE instance_id=?", this.config.instanceId);
    if (!row) return;
    const pages = await Promise.allSettled([this.consumeFeed(row, "public", deliver), this.consumeFeed(row, "private", deliver)]);
    this.reportStatus = { checkedAt: now() };
    for (const page of pages) {
      if (page.status === "rejected") {
        this.reportStatus.error = page.reason instanceof IdentityError ? page.reason.message : "报告状态等待恢复";
        throw page.reason;
      }
    }
  }
  private async consumeFeed(row: Row, audience: "public" | "private", deliver: (report: StockReport) => {durable: boolean}) {
    const isPublic = audience === "public";
    const table = isPublic ? "stock_public_report_cursors" : "stock_report_cursors";
    const stored = this.store.get(`SELECT cursor FROM ${table} WHERE instance_id=?`, row.instance_id);
    if (!stored) return;
    const after = Number(stored.cursor);
    const path = isPublic ? "reports/public-events" : "reports/events";
    const auth = isPublic ? { subscription: this.store.decrypt(String(row.renewal)) }
                          : { grant: this.store.decrypt(String((await this.liveBinding(row)).lease)) };
    const result = await this.request(path + "?after=" + after, { method: "GET", ...auth });
    if (this.stopping.signal.aborted) return;
    if (!Array.isArray(result.events) || !Number.isSafeInteger(result.nextCursor) || Number(result.nextCursor) < after) throw new IdentityError(502, "Stock 报告游标无效");
    let last = after;
    for (const event of result.events) {
      if (!object(event) || event.instanceId !== this.config!.instanceId || !Number.isSafeInteger(event.cursor) || Number(event.cursor) <= last || Number(event.cursor) > Number(result.nextCursor) || !Array.isArray(event.views)) throw new IdentityError(502, "Stock 报告事件归属无效");
      const views = event.views.map((view: unknown) => {
        if (!object(view) || view.verified !== true || (view.audience !== "public" && view.audience !== "private") || typeof view.content !== "string") throw new IdentityError(502, "Stock 报告视图无效");
        return { audience: view.audience as "public" | "private", content: view.content, verified: true };
      });
      if (isPublic && views.some(view => view.audience !== "public")) throw new IdentityError(502, "公开报告返回了私人视图");
      const matching = views.filter(view => view.audience === audience);
      if (matching.length) {
        const receipt = deliver({instanceId: this.config!.instanceId, reportId: field(event.reportId), version: field(event.version), kind: field(event.kind), tradingDay: event.tradingDay == null ? null : field(event.tradingDay), ...(event.reportDate == null ? {} : {reportDate: field(event.reportDate)}), views: matching});
        if (!receipt.durable) throw new Error("报告投递尚未入账");
      }
      last = Number(event.cursor);
    }
    this.store.run(`UPDATE ${table} SET cursor=MAX(cursor,?) WHERE instance_id=?`, Number(result.nextCursor), row.instance_id);
  }
  startReports(deliver: (report: StockReport) => {durable: boolean}) {
    if (!this.config || this.reportTimer) return;
    const poll = () => { void this.pollReports(deliver).catch(() => { /* The persisted cursor is retried on the next tick. */ }); };
    this.reportTimer = setInterval(poll, 30_000); this.reportTimer.unref(); poll();
  }
  cancelTask(taskId: string) { for (const controller of this.aborters.get(taskId) ?? []) controller.abort(); }
  async close() { clearInterval(this.reportTimer); this.stopping.abort(); for (const id of this.aborters.keys()) this.cancelTask(id); await this.reportPoll?.catch(() => {}); }
}
