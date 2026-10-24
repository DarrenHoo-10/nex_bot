import { createHash, randomBytes } from "node:crypto";
import type { ConnectorOAuthView } from "../../shared/personal-connectors.ts";
import { GMAIL_API, GmailAuthorizationError, GmailProvider, GmailProviderError, type OAuthCredential } from "./gmail-provider.ts";
import { hash, id, now, text, type CoreStore, type Row } from "./store.ts";

type Authorize = () => Promise<void>;
interface Attempt extends ConnectorOAuthView {
  stateHash: string;
  sessionId: string;
  target?: Row;
  verifier: string;
  redirectUri: string;
  authorize: Authorize;
  controller: AbortController;
}
const safeError = (error: unknown) => error instanceof GmailProviderError ? error.message : "Gmail 连接失败，请重试";

/** Account linking and token lifecycle, separate from provider-specific mail operations. */
export class ConnectorOAuth {
  private readonly attempts = new Map<string, Attempt>();
  private readonly refreshes = new Map<string, Promise<OAuthCredential>>();
  private readonly revoking = new Set<string>();
  private readonly active = new Map<AbortController, { connectorId?: string; taskId?: string }>();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  constructor(private readonly store: CoreStore, private readonly changed: () => void, readonly provider?: GmailProvider) {}

  private prune() {
    for (const [key, attempt] of this.attempts) if (attempt.expiresAt <= now()) { attempt.controller.abort(); this.attempts.delete(key); }
  }
  private current(row: Row) {
    if (this.closed) throw new Error("连接器正在关闭");
    const current = this.store.get("SELECT * FROM personal_connectors WHERE id=? AND workspace_id=? AND owner_user_id=?", row.id, this.store.workspace, this.store.owner);
    if (!current || current.provider !== "gmail" || current.version !== row.version) throw new Error("连接器已变化，请刷新后重试");
    return current;
  }
  private ready() {
    if (this.closed || !this.provider) throw new Error("服务端尚未配置 Google 登录");
    return this.provider;
  }
  private credential(row: Row): OAuthCredential {
    if (!row.credential) throw new GmailAuthorizationError();
    return JSON.parse(this.store.decrypt(String(row.credential))) as OAuthCredential;
  }
  private async track<T>(controller: AbortController, connectorId: string | undefined, taskId: string | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("连接器正在关闭");
    this.active.set(controller, { connectorId, taskId });
    const pending = operation(AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]));
    this.pending.add(pending);
    try { return await pending; } finally { this.pending.delete(pending); this.active.delete(controller); }
  }
  begin(data: Record<string, unknown>, origin: string, sessionId: string, authorize: Authorize) {
    const provider = this.ready(); this.prune();
    if (this.revoking.size) throw new Error("正在断开邮箱，请稍后连接");
    const target = data.id ? this.store.get("SELECT * FROM personal_connectors WHERE id=? AND provider='gmail' AND workspace_id=? AND owner_user_id=?", text(data.id, 100), this.store.workspace, this.store.owner) : undefined;
    if (data.id && (!target || target.version !== data.version)) throw new Error("连接器已变化，请刷新后重试");
    for (const attempt of this.attempts.values()) if (attempt.sessionId === sessionId && attempt.target?.id === target?.id && ["pending", "exchanging"].includes(attempt.status)) this.cancelAttempt(attempt);
    if (this.attempts.size >= 20) throw new Error("连接请求过多，请稍后重试");
    const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url"), attemptId = id();
    const redirectUri = provider.redirectUri(origin);
    const attempt: Attempt = { id: attemptId, status: "pending", expiresAt: now() + 10 * 60_000, stateHash: hash(state), sessionId, target, verifier, redirectUri, authorize, controller: new AbortController() };
    this.attempts.set(attemptId, attempt);
    return { id: attemptId, expiresAt: attempt.expiresAt, authorizationUrl: provider.authorizationUrl(state, createHash("sha256").update(verifier).digest("base64url"), redirectUri) };
  }
  ownsState(state: string) { this.prune(); return state.length <= 200 && [...this.attempts.values()].some((attempt) => attempt.stateHash === hash(state)); }
  status(attemptId: string, sessionId: string): ConnectorOAuthView {
    this.prune();
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.sessionId !== sessionId) throw new Error("连接请求已过期，请重试");
    return { id: attempt.id, status: attempt.status, expiresAt: attempt.expiresAt, ...(attempt.connectorId ? { connectorId: attempt.connectorId } : {}), ...(attempt.error ? { error: attempt.error } : {}) };
  }
  private cancelAttempt(attempt: Attempt) { attempt.controller.abort(); attempt.status = "cancelled"; attempt.verifier = ""; }
  cancel(attemptId: string, sessionId: string) {
    this.status(attemptId, sessionId);
    const attempt = this.attempts.get(attemptId)!;
    if (["pending", "exchanging"].includes(attempt.status)) this.cancelAttempt(attempt);
    return { ok: true };
  }
  cancelSession(sessionId: string) { for (const attempt of this.attempts.values()) if (attempt.sessionId === sessionId && ["pending", "exchanging"].includes(attempt.status)) this.cancelAttempt(attempt); }
  async callback(parameters: URLSearchParams) {
    this.prune();
    const state = parameters.get("state") ?? "";
    const attempt = state.length <= 200 ? [...this.attempts.values()].find((item) => item.stateHash === hash(state)) : undefined;
    if (!attempt || attempt.status !== "pending" || parameters.getAll("state").length !== 1) throw new Error("连接请求无效或已过期，请返回 NexBot 重试");
    attempt.status = "exchanging";
    try {
      return await this.track(attempt.controller, attempt.target ? String(attempt.target.id) : undefined, undefined, async (signal) => {
        const guard = async () => {
          signal.throwIfAborted();
          if (attempt.status !== "exchanging" || attempt.expiresAt <= now() || this.closed) throw new Error("连接请求已失效");
          await attempt.authorize();
          signal.throwIfAborted();
          if (attempt.expiresAt <= now()) throw new Error("连接请求已过期");
          if (attempt.target) this.current(attempt.target);
        };
        await guard();
        if (parameters.has("error")) throw new GmailProviderError("Google 授权未完成，请重试");
        if (parameters.getAll("code").length !== 1) throw new GmailProviderError("Google 授权码无效，请重试");
        const code = text(parameters.get("code"), 8192), provider = this.ready();
        const credential = await provider.exchange(code, attempt.verifier, attempt.redirectUri, signal);
        await guard();
        const account = await provider.account(credential, signal);
        await guard();
        if (this.revoking.has(account)) throw new GmailProviderError("邮箱正在断开，请稍后重新连接");
        if (attempt.target && attempt.target.account !== account) throw new GmailProviderError("请选择原邮箱重新授权，其他邮箱请添加为新连接");
        if (this.store.get("SELECT id FROM personal_connectors WHERE provider='gmail' AND account=? AND id!=?", account, attempt.target?.id ?? "")) throw new GmailProviderError("此邮箱已连接，请在已有连接中重新授权");
        const connectorId = attempt.target ? String(attempt.target.id) : id();
        this.store.transaction(() => {
          const encrypted = this.store.encrypt(JSON.stringify(credential)), tools = JSON.stringify(provider.tools);
          if (attempt.target) this.store.run("UPDATE personal_connectors SET credential=?,tools_json=?,checked_at=?,error=NULL,version=version+1 WHERE id=? AND version=?", encrypted, tools, now(), connectorId, attempt.target.version);
          else this.store.insert("personal_connectors", { id: connectorId, ...this.store.scope(), name: "Gmail", provider: "gmail", account, url: GMAIL_API, transport: "http", credential: encrypted, tools_json: tools, checked_at: now(), created_at: now() });
          this.store.audit("connector.connect", "connector", connectorId, { provider: "gmail" });
        });
        attempt.connectorId = connectorId; attempt.status = "connected";
        this.changed(); return { ok: true };
      });
    } catch (error) {
      if ((attempt.status as string) !== "cancelled") { attempt.status = "error"; attempt.error = safeError(error); }
      throw new Error(attempt.error ?? "连接已取消，请返回 NexBot");
    } finally { attempt.verifier = ""; }
  }
  private refresh(row: Row, authorize: Authorize) {
    const key = String(row.id) + ":" + row.version;
    const pending = this.refreshes.get(key); if (pending) return pending;
    const job = this.track(new AbortController(), String(row.id), undefined, async (signal) => {
      await authorize();
      const current = this.current(row), credential = await this.ready().refresh(this.credential(current), signal);
      await authorize(); signal.throwIfAborted(); this.current(row);
      this.store.run("UPDATE personal_connectors SET credential=? WHERE id=? AND version=?", this.store.encrypt(JSON.stringify(credential)), row.id, row.version);
      return credential;
    });
    this.refreshes.set(key, job);
    void job.finally(() => { this.refreshes.delete(key); }).catch(() => {});
    return job;
  }
  async withCredential<T>(row: Row, taskId: string | undefined, authorize: Authorize, operation: (provider: GmailProvider, credential: OAuthCredential, signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.track(new AbortController(), String(row.id), taskId, async (signal) => {
      try {
        await authorize(); signal.throwIfAborted();
        let credential = this.credential(this.current(row));
        if (credential.expiresAt <= now() + 60_000) credential = await this.refresh(row, authorize);
        await authorize(); signal.throwIfAborted(); this.current(row);
        let result: T;
        try { result = await operation(this.ready(), credential, signal); }
        catch (error) {
          if (!(error instanceof GmailAuthorizationError)) throw error;
          credential = await this.refresh(row, authorize);
          await authorize(); signal.throwIfAborted(); this.current(row);
          result = await operation(this.ready(), credential, signal);
        }
        await authorize(); signal.throwIfAborted(); this.current(row);
        return result;
      } catch (error) {
        if (error instanceof GmailAuthorizationError && !signal.aborted && !this.closed) {
          const updated = this.store.run("UPDATE personal_connectors SET credential=NULL,error=?,version=version+1 WHERE id=? AND version=?", error.message, row.id, row.version);
          if (updated.changes) { this.abortConnector(String(row.id)); this.changed(); }
        }
        if (error instanceof GmailProviderError) throw error;
        throw new Error(signal.aborted ? "Gmail 操作已取消" : "Gmail 请求失败或授权已变化，请重试");
      }
    });
  }
  async disconnect(row: Row) {
    if (!row.credential || !this.provider) return { ok: true };
    this.revoking.add(String(row.account));
    try {
      await this.track(new AbortController(), undefined, undefined, (signal) => this.ready().revoke(this.credential(row), AbortSignal.any([signal, AbortSignal.timeout(10_000)])));
      return { ok: true };
    } catch { return { ok: true, warning: "已断开本地连接；Google 授权暂未撤销，可在 Google 账号中移除 NexBot 访问权限。" }; }
    finally { this.revoking.delete(String(row.account)); }
  }
  abortConnector(connectorId: string) {
    for (const attempt of this.attempts.values()) if (attempt.target?.id === connectorId && ["pending", "exchanging"].includes(attempt.status)) this.cancelAttempt(attempt);
    for (const [controller, active] of this.active) if (active.connectorId === connectorId) controller.abort();
  }
  cancelTask(taskId: string) { for (const [controller, active] of this.active) if (active.taskId === taskId) controller.abort(); }
  async close() { this.closed = true; for (const attempt of this.attempts.values()) this.cancelAttempt(attempt); for (const controller of this.active.keys()) controller.abort(); await Promise.allSettled(this.pending); this.attempts.clear(); }
}
