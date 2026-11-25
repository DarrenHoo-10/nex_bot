import { createHash, randomBytes } from "node:crypto";
import type { ConnectorOAuthView } from "../../shared/personal-connectors.ts";
import { GMAIL_API, GmailAuthorizationError, GmailProvider, GmailProviderError, type OAuthCredential } from "./gmail-provider.ts";
import { GITHUB_API, GithubAuthorizationError, GithubProvider, GithubProviderError } from "./github-provider.ts";
import { hash, id, now, text, type CoreStore, type Row } from "./store.ts";

type Authorize = () => Promise<void>;
type OAuthProvider = GmailProvider | GithubProvider;
interface Attempt extends ConnectorOAuthView {
  stateHash: string;
  sessionId: string;
  provider: "gmail" | "github";
  target?: Row;
  verifier: string;
  redirectUri: string;
  authorize: Authorize;
  controller: AbortController;
  device?: { deviceCode: string; intervalMs: number; userCode: string; verificationUri: string };
}
const safeError = (provider: "gmail" | "github", error: unknown) => provider === "github"
  ? error instanceof GithubProviderError ? error.message : "GitHub 连接失败，请重试"
  : error instanceof GmailProviderError ? error.message : "Gmail 连接失败，请重试";
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/** Account linking and token lifecycle, separate from provider-specific mail operations. */
export class ConnectorOAuth {
  private readonly attempts = new Map<string, Attempt>();
  private readonly refreshes = new Map<string, Promise<OAuthCredential>>();
  private readonly revoking = new Set<string>();
  private readonly active = new Map<AbortController, { connectorId?: string; taskId?: string }>();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  constructor(private readonly store: CoreStore, private readonly changed: () => void, readonly provider?: GmailProvider, readonly github?: GithubProvider) {}

  private prune() {
    for (const [key, attempt] of this.attempts) if (attempt.expiresAt <= now()) { attempt.controller.abort(); this.attempts.delete(key); }
  }
  private current(row: Row, providerId: string) {
    if (this.closed) throw new Error("连接器正在关闭");
    const current = this.store.get("SELECT * FROM personal_connectors WHERE id=? AND workspace_id=? AND owner_user_id=?", row.id, this.store.workspace, this.store.owner);
    if (!current || current.provider !== providerId || current.version !== row.version) throw new Error("连接器已变化，请刷新后重试");
    return current;
  }
  private ready(providerId: "gmail" | "github") {
    if (providerId === "github") { if (!this.github) throw new Error("GitHub 连接不可用"); return this.github; }
    if (this.closed || !this.provider) throw new Error("服务端尚未配置 Google 登录");
    return this.provider;
  }
  private credential(row: Row, providerId: "gmail" | "github"): OAuthCredential {
    if (!row.credential) throw providerId === "github" ? new GithubAuthorizationError() : new GmailAuthorizationError();
    const plain = this.store.decrypt(String(row.credential));
    if (providerId === "github") {
      // PAT rows store the bare token; OAuth and device rows store the JSON credential.
      try {
        const parsed = JSON.parse(plain) as OAuthCredential;
        if (parsed && typeof parsed.accessToken === "string") return { ...parsed, refreshToken: parsed.refreshToken ?? "", expiresAt: parsed.expiresAt ?? Date.now() + 180 * 86_400_000 };
      } catch { /* bare token */ }
      return { accessToken: plain, refreshToken: "", expiresAt: Date.now() + 180 * 86_400_000, scope: "" };
    }
    return JSON.parse(plain) as OAuthCredential;
  }
  private async track<T>(controller: AbortController, connectorId: string | undefined, taskId: string | undefined, operation: (signal: AbortSignal) => Promise<T>, timeoutMs = 45_000): Promise<T> {
    if (this.closed) throw new Error("连接器正在关闭");
    this.active.set(controller, { connectorId, taskId });
    const pending = operation(AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]));
    this.pending.add(pending);
    try { return await pending; } finally { this.pending.delete(pending); this.active.delete(controller); }
  }
  private guard(attempt: Attempt, signal: AbortSignal) {
    return async () => {
      signal.throwIfAborted();
      if ((attempt.status !== "pending" && attempt.status !== "exchanging") || attempt.expiresAt <= now() || this.closed) throw new Error("连接请求已失效");
      await attempt.authorize();
      signal.throwIfAborted();
      if (attempt.expiresAt <= now()) throw new Error("连接请求已过期");
      if (attempt.target) this.current(attempt.target, attempt.provider);
    };
  }
  /** Commits a exchanged credential: identity, duplicates, row upsert and audit. Shared by the web callback and the device poll. */
  private async commit(attempt: Attempt, provider: OAuthProvider, credential: OAuthCredential, signal: AbortSignal) {
    const guard = this.guard(attempt, signal);
    await guard();
    const account = await provider.account(credential, signal);
    await guard();
    if (this.revoking.has(account.toLowerCase())) throw new Error("正在断开该账号，请稍后重新连接");
    if (attempt.target?.account && String(attempt.target.account).toLowerCase() !== account.toLowerCase()) {
      throw new Error(attempt.provider === "github" ? "请选择原账号重新授权，其他账号请添加为新连接" : "请选择原邮箱重新授权，其他邮箱请添加为新连接");
    }
    for (const row of this.store.all("SELECT id, account FROM personal_connectors WHERE provider=? AND id!=?", attempt.provider, attempt.target?.id ?? "")) {
      if (String(row.account ?? "").toLowerCase() === account.toLowerCase()) throw new Error(attempt.provider === "github" ? "此账号已连接，请在已有连接中重新授权" : "此邮箱已连接，请在已有连接中重新授权");
    }
    const connectorId = attempt.target ? String(attempt.target.id) : id();
    this.store.transaction(() => {
      const encrypted = this.store.encrypt(JSON.stringify(credential)), tools = JSON.stringify(provider.tools);
      if (attempt.target) this.store.run("UPDATE personal_connectors SET credential=?,account=?,tools_json=?,checked_at=?,error=NULL,version=version+1 WHERE id=? AND version=?", encrypted, account, tools, now(), connectorId, attempt.target!.version);
      else this.store.insert("personal_connectors", { id: connectorId, ...this.store.scope(), name: attempt.provider === "github" ? "GitHub" : "Gmail", provider: attempt.provider, account, url: attempt.provider === "github" ? GITHUB_API : GMAIL_API, transport: "http", credential: encrypted, tools_json: tools, checked_at: now(), created_at: now() });
      this.store.audit("connector.connect", "connector", connectorId, { provider: attempt.provider });
    });
    attempt.connectorId = connectorId; attempt.status = "connected";
    this.changed(); return { ok: true };
  }
  async begin(data: Record<string, unknown>, origin: string, sessionId: string, authorize: Authorize) {
    const providerId: "gmail" | "github" = data.provider === "github" ? "github" : "gmail";
    const provider = this.ready(providerId);
    this.prune();
    if (this.revoking.size) throw new Error("正在断开连接，请稍后重试");
    const target = data.id ? this.store.get("SELECT * FROM personal_connectors WHERE id=? AND provider=? AND workspace_id=? AND owner_user_id=?", text(data.id, 100), providerId, this.store.workspace, this.store.owner) : undefined;
    if (data.id && (!target || target.version !== data.version)) throw new Error("连接器已变化，请刷新后重试");
    for (const attempt of this.attempts.values()) if (attempt.sessionId === sessionId && attempt.provider === providerId && attempt.target?.id === target?.id && ["pending", "exchanging"].includes(attempt.status)) this.cancelAttempt(attempt);
    if (this.attempts.size >= 20) throw new Error("连接请求过多，请稍后重试");
    const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url"), attemptId = id();
    const attempt: Attempt = { id: attemptId, status: "pending", expiresAt: now() + 10 * 60_000, stateHash: hash(state), sessionId, provider: providerId, target, verifier, redirectUri: "", authorize, controller: new AbortController() };
    this.attempts.set(attemptId, attempt);
    if (providerId === "github" && !this.github!.webFlowConfigured) {
      const github = this.github!;
      try {
        const device = await github.deviceBegin(AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(15_000)]));
        attempt.device = { deviceCode: device.deviceCode, intervalMs: device.intervalMs, userCode: device.userCode, verificationUri: device.verificationUri };
        attempt.expiresAt = Math.min(attempt.expiresAt, device.expiresAt);
        void this.track(attempt.controller, undefined, undefined, async (signal) => {
          let wait = device.intervalMs;
          for (;;) {
            await sleep(wait, signal);
            const guard = this.guard(attempt, signal);
            await guard();
            const result = await github.devicePoll(device.deviceCode, signal);
            if (result.credential) { await this.commit(attempt, github, result.credential, signal); return; }
            if (result.slowDownMs) wait = Math.min(wait + result.slowDownMs, 30_000);
          }
        }, Math.max(attempt.expiresAt - now() + 5_000, 1_000)).catch((error) => {
          if ((attempt.status as string) !== "cancelled") { attempt.status = "error"; attempt.error = safeError("github", error); }
        });
        return { id: attemptId, expiresAt: attempt.expiresAt, userCode: device.userCode, verificationUri: device.verificationUri };
      } catch (error) {
        this.attempts.delete(attemptId);
        throw error instanceof GithubProviderError ? error : new Error("GitHub 连接失败，请重试");
      }
    }
    const redirectUri = provider.redirectUri(origin);
    attempt.redirectUri = redirectUri;
    return { id: attemptId, expiresAt: attempt.expiresAt, authorizationUrl: provider.authorizationUrl(state, createHash("sha256").update(verifier).digest("base64url"), redirectUri) };
  }
  ownsState(state: string) { this.prune(); return state.length <= 200 && [...this.attempts.values()].some((attempt) => attempt.stateHash === hash(state)); }
  status(attemptId: string, sessionId: string): ConnectorOAuthView {
    this.prune();
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.sessionId !== sessionId) throw new Error("连接请求已过期，请重试");
    return { id: attempt.id, status: attempt.status, expiresAt: attempt.expiresAt, ...(attempt.connectorId ? { connectorId: attempt.connectorId } : {}), ...(attempt.error ? { error: attempt.error } : {}), ...(attempt.device ? { userCode: attempt.device.userCode, verificationUri: attempt.device.verificationUri } : {}) };
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
    if (!attempt || attempt.status !== "pending" || attempt.device || parameters.getAll("state").length !== 1) throw new Error("连接请求无效或已过期，请返回 NexBot 重试");
    attempt.status = "exchanging";
    try {
      return await this.track(attempt.controller, attempt.target ? String(attempt.target.id) : undefined, undefined, async (signal) => {
        const provider = this.ready(attempt.provider);
        await this.guard(attempt, signal)();
        if (parameters.has("error")) throw new (attempt.provider === "github" ? GithubProviderError : GmailProviderError)(`${attempt.provider === "github" ? "GitHub" : "Google"} 授权未完成，请重试`);
        if (parameters.getAll("code").length !== 1) throw new (attempt.provider === "github" ? GithubProviderError : GmailProviderError)(`${attempt.provider === "github" ? "GitHub" : "Google"} 授权码无效，请重试`);
        const code = text(parameters.get("code"), 8192);
        const credential = await provider.exchange(code, attempt.verifier, attempt.redirectUri, signal);
        return await this.commit(attempt, provider, credential, signal);
      });
    } catch (error) {
      if ((attempt.status as string) !== "cancelled") { attempt.status = "error"; attempt.error = safeError(attempt.provider, error); }
      throw new Error(attempt.error ?? "连接已取消，请返回 NexBot");
    } finally { attempt.verifier = ""; }
  }
  private refresh(row: Row, authorize: Authorize) {
    const key = String(row.id) + ":" + row.version;
    const pending = this.refreshes.get(key); if (pending) return pending;
    const gmail = this.ready("gmail") as GmailProvider;
    const job = this.track(new AbortController(), String(row.id), undefined, async (signal) => {
      await authorize();
      const current = this.current(row, "gmail"), credential = await gmail.refresh(this.credential(current, "gmail"), signal);
      await authorize(); signal.throwIfAborted(); this.current(row, "gmail");
      this.store.run("UPDATE personal_connectors SET credential=? WHERE id=? AND version=?", this.store.encrypt(JSON.stringify(credential)), row.id, row.version);
      return credential;
    });
    this.refreshes.set(key, job);
    void job.finally(() => { this.refreshes.delete(key); }).catch(() => {});
    return job;
  }
  async withCredential<T>(row: Row, taskId: string | undefined, authorize: Authorize, operation: (provider: OAuthProvider, credential: OAuthCredential, signal: AbortSignal) => Promise<T>): Promise<T> {
    const providerId: "gmail" | "github" = String(row.provider) === "github" ? "github" : "gmail";
    const provider = this.ready(providerId);
    return this.track(new AbortController(), String(row.id), taskId, async (signal) => {
      try {
        await authorize(); signal.throwIfAborted();
        let credential = this.credential(this.current(row, providerId), providerId);
        if (providerId === "gmail" && credential.expiresAt <= now() + 60_000) credential = await this.refresh(row, authorize);
        await authorize(); signal.throwIfAborted(); this.current(row, providerId);
        let result: T;
        try { result = await operation(provider, credential, signal); }
        catch (error) {
          if (!(error instanceof GmailAuthorizationError) && !(error instanceof GithubAuthorizationError)) throw error;
          if (providerId === "github") throw error; // GitHub 的 token 无法刷新：失效只能重新连接。
          credential = await this.refresh(row, authorize);
          await authorize(); signal.throwIfAborted(); this.current(row, providerId);
          result = await operation(provider, credential, signal);
        }
        await authorize(); signal.throwIfAborted(); this.current(row, providerId);
        return result;
      } catch (error) {
        if ((error instanceof GmailAuthorizationError || error instanceof GithubAuthorizationError) && !signal.aborted && !this.closed) {
          const updated = this.store.run("UPDATE personal_connectors SET credential=NULL,error=?,version=version+1 WHERE id=? AND version=?", error.message, row.id, row.version);
          if (updated.changes) { this.abortConnector(String(row.id)); this.changed(); }
        }
        if (providerId === "github" ? error instanceof GithubProviderError : error instanceof GmailProviderError) throw error;
        throw new Error(signal.aborted ? (providerId === "github" ? "GitHub 操作已取消" : "Gmail 操作已取消") : (providerId === "github" ? "GitHub 请求失败或授权已变化，请重试" : "Gmail 请求失败或授权已变化，请重试"));
      }
    });
  }
  async disconnect(row: Row) {
    const providerId: "gmail" | "github" = String(row.provider) === "github" ? "github" : "gmail";
    if (!row.credential || (providerId === "gmail" && !this.provider) || (providerId === "github" && !this.github)) return { ok: true };
    const provider = providerId === "github" ? this.github! : this.provider!;
    const accountKey = String(row.account ?? "").toLowerCase();
    this.revoking.add(accountKey);
    try {
      await this.track(new AbortController(), undefined, undefined, (signal) => provider.revoke(this.credential(row, providerId), AbortSignal.any([signal, AbortSignal.timeout(10_000)])));
      return { ok: true };
    } catch {
      return { ok: true, warning: providerId === "github" ? "已断开本地连接；GitHub 授权暂未自动撤销，可在 GitHub 设置的 Applications 中移除。" : "已断开本地连接；Google 授权暂未撤销，可在 Google 账号中移除 NexBot 访问权限。" };
    } finally { this.revoking.delete(accountKey); }
  }
  abortConnector(connectorId: string) {
    for (const attempt of this.attempts.values()) if (attempt.target?.id === connectorId && ["pending", "exchanging"].includes(attempt.status)) this.cancelAttempt(attempt);
    for (const [controller, active] of this.active) if (active.connectorId === connectorId) controller.abort();
  }
  cancelTask(taskId: string) { for (const [controller, active] of this.active) if (active.taskId === taskId) controller.abort(); }
  async close() { this.closed = true; for (const attempt of this.attempts.values()) this.cancelAttempt(attempt); for (const controller of this.active.keys()) controller.abort(); await Promise.allSettled(this.pending); this.attempts.clear(); }
}
