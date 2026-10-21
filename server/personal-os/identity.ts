import { randomBytes } from "node:crypto";
import { CoreStore, hash, id, now, text, type Row } from "./store.ts";
import { ClientIdentity } from "./clients.ts";
import { identityBase, IdentityError, NexUserProvider, NEX_USER_ORIGIN, type UpstreamSession } from "./identity-provider.ts";

/** Longest a Core login lives without a refresh; the upstream session can end it sooner. */
export const SESSION_MAX_MS = 7 * 24 * 60 * 60_000;

interface LoginSecret { account: string; name: string; nonce: string; version: number; purpose: "login" | "link"; operator?: string }
export class CoreIdentity {
  private readonly controller = new AbortController();
  private readonly checked = new Map<string, { version: number; wall: number; mono: number }>();
  private readonly checking = new Map<string, Promise<Row | undefined>>();
  onSessionLost?: (sessionId: string) => void;
  /** Server-owned routing after successful upstream password/session verification. */
  routeVerified?: (session: UpstreamSession, name: string) => Promise<ReturnType<CoreIdentity["acceptVerified"]>>;
  private closed = false;
  private revoking?: Promise<void>;
  constructor(readonly store: CoreStore, readonly clients: ClientIdentity, readonly fixtureOrigin?: string) {
    const base = fixtureOrigin ? identityBase(fixtureOrigin, true) : NEX_USER_ORIGIN;
    if (fixtureOrigin && (new URL(base).protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname))) throw new Error("Identity fixture must be loopback HTTP");
    store.run("INSERT OR IGNORE INTO identity_provider(id,type,base_url,display_name) VALUES(1,'nex-user',?,'NexorAI 账号')", base);
    if (this.configuration()?.base_url !== base) throw new Error("用户中心地址与这个 Core 的身份绑定不一致");
  }
  configuration() { return this.store.get("SELECT * FROM identity_provider WHERE id=1"); }
  connected() { return this.configuration()?.connected === 1; }
  private provider(config = this.configuration()) {
    if (!config) throw new IdentityError(503, "用户中心配置不可用");
    return new NexUserProvider(identityBase(config.base_url, !!this.fixtureOrigin), this.controller.signal);
  }
  publicConfiguration() {
    const row = this.configuration();
    return { mode: "connected", loginRequired: true, initialized: this.connected(), provider: { type: "nex-user", name: row?.display_name, baseUrl: row?.base_url } };
  }
  locallyAllowed(token: string) {
    const session = this.clients.authenticate(token);
    if (!session) return undefined;
    if (!this.connected()) return undefined;
    const config = this.configuration()!;
    return session.protocol === "native-v1" && session.external_identity_id === config.external_identity_id && this.store.get("SELECT id FROM external_identities WHERE id=? AND status='active'", session.external_identity_id) ? session : undefined;
  }
  async authenticate(token: string) {
    const session = this.locallyAllowed(token);
    return session?.protocol === "native-v1" ? this.verify(session) : session;
  }
  async status(token: string, bootstrap?: Row) {
    const session = await this.authenticate(token);
    return { ...this.publicConfiguration(), version: 1, coreId: this.clients.coreId(), authenticated: !!session, canInitialize: !this.connected() && bootstrap?.id === this.store.session, ...(session ? { sessionId: session.id, expiresAt: session.expires_at, account: { displayName: this.store.get("SELECT display_name FROM users WHERE id=?", session.user_id)?.display_name, protocol: session.protocol, deviceName: session.client_name } } : {}) };
  }
  start(data: Record<string, unknown>, operator?: Row) {
    const config = this.configuration();
    if (!config) throw new IdentityError(409, "请先在主设备设置用户中心地址");
    const purpose = this.connected() ? "login" : "link";
    if (purpose === "link" && (this.connected() || operator?.id !== this.store.session)) throw new IdentityError(403, "账号关联必须由主设备 owner 发起");
    if (purpose === "login" && !this.connected()) throw new IdentityError(409, "请先在主设备关联账号");
    this.prune();
    if (Number(this.store.get("SELECT COUNT(*) n FROM login_transactions WHERE status='pending'")?.n) >= 1000) throw new IdentityError(429, "登录事务过多，请稍后重试");
    const transactionId = id(), secretRef = `identity-login:${transactionId}`, bindingToken = randomBytes(32).toString("base64url"), stepId = id(), nonce = randomBytes(32).toString("base64url"), expiresAt = now() + 5 * 60_000;
    const secret: LoginSecret = { account: text(data.account, 254), name: text(data.name ?? "这台设备", 80), version: Number(config.version), nonce, purpose, ...(operator ? { operator: String(operator.id) } : {}) };
    this.store.transaction(() => {
      this.store.insert("secrets", { id: secretRef, ciphertext: this.store.encrypt(JSON.stringify(secret)) });
      this.store.insert("login_transactions", { id: transactionId, provider_id: "1", protocol: "native-v1", client_binding_hash: hash(bindingToken), nonce_hash: hash(nonce), status: "pending", secret_ref: secretRef, challenge_json: JSON.stringify({ type: "password", stepId }), created_at: now(), expires_at: expiresAt });
    });
    return { transactionId, bindingToken, stepId, challenge: "password", expiresAt };
  }
  async respond(data: Record<string, unknown>, operator?: Row) {
    const transactionId = text(data.transactionId, 100), binding = text(data.bindingToken, 100), step = text(data.stepId, 100);
    const transaction = this.store.get("SELECT * FROM login_transactions WHERE id=? AND status='pending' AND expires_at>?", transactionId, now());
    if (!transaction || transaction.client_binding_hash !== hash(binding) || JSON.parse(String(transaction.challenge_json)).stepId !== step) throw new IdentityError(401, "登录事务无效或已过期，请重新登录");
    const encrypted = this.store.get("SELECT ciphertext FROM secrets WHERE id=?", transaction.secret_ref);
    if (!encrypted) throw new IdentityError(401, "登录事务已失效，请重新登录");
    const secret = JSON.parse(this.store.decrypt(String(encrypted.ciphertext))) as LoginSecret;
    const config = this.configuration();
    if (!config || config.version !== secret.version || hash(secret.nonce) !== transaction.nonce_hash) throw new IdentityError(409, "用户中心配置已变化，请重新登录");
    if (secret.purpose === "link" && (this.connected() || operator?.id !== this.store.session || operator.id !== secret.operator)) throw new IdentityError(403, "关联操作的本机登录已失效");
    if (typeof data.password !== "string" || !data.password.length || data.password.length > 4096) throw new IdentityError(400, "请输入有效密码");
    // Consume before network I/O: a dropped response never retries a password,
    // creates a second upstream session, or reuses a one-step challenge.
    this.store.transaction(() => {
      const update = this.store.run("UPDATE login_transactions SET status='denied',secret_ref=NULL,attempts=attempts+1,version=version+1 WHERE id=? AND status='pending'", transactionId);
      if (Number(update.changes) !== 1) throw new IdentityError(401, "登录事务已使用，请重新登录");
      this.store.run("DELETE FROM secrets WHERE id=?", transaction.secret_ref);
    });
    const provider = this.provider(config), upstream = await provider.login(secret.account, data.password);
    try {
      if (this.routeVerified && secret.purpose === "login") {
        if (this.closed || this.configuration()?.version !== secret.version || Number(transaction.expires_at) <= now()) throw new IdentityError(409, "登录事务已失效，请重新登录");
        const login = await this.routeVerified(upstream, secret.name);
        this.store.run("UPDATE login_transactions SET status='consumed',consumed_at=? WHERE id=?", now(), transactionId);
        return login;
      }
      return this.issueVerified(upstream, secret, operator, transactionId, Number(transaction.expires_at));
    } catch (error) { await provider.revoke(upstream).catch(() => {}); throw error; }
  }
  /** Internal provisioning only; caller must have verified NexUserProvider.login. Never an HTTP route. */
  acceptVerified(upstream: UpstreamSession, name: string) {
    const config = this.configuration()!;
    const operator = this.store.get("SELECT * FROM user_sessions WHERE id=?", this.store.session);
    return this.issueVerified(upstream, { account: "", name, nonce: "", version: Number(config.version), purpose: this.connected() ? "login" : "link" }, operator);
  }
  private issueVerified(upstream: UpstreamSession, secret: LoginSecret, operator?: Row, transactionId?: string, expiresAtLimit = Infinity) {
    const config = this.configuration()!;
    const sessionId = id();
    const token = randomBytes(32).toString("base64url"), expiresAt = Math.min(upstream.expiresAt, now() + SESSION_MAX_MS);
    const ref = `identity-session:${sessionId}`;
    this.store.transaction(() => {
      const current = this.configuration();
      if (this.closed || !current || current.version !== secret.version || expiresAtLimit <= now()) throw new IdentityError(409, "登录事务已失效，请重新登录");
      let externalId = current.external_identity_id;
      if (secret.purpose === "link") {
        if (current.connected || !operator || !this.clients.authenticateTokenSession(String(operator.id))) throw new IdentityError(403, "本机登录已失效");
        externalId = id();
        this.store.insert("external_identities", { id: externalId, user_id: this.store.owner, protocol: "native-v1", issuer: config.base_url, subject: upstream.subject, status: "active", created_at: now() });
        this.store.run("UPDATE identity_provider SET external_identity_id=?,connected=1,version=version+1 WHERE id=1", externalId);
        this.store.run("UPDATE user_sessions SET revoked_at=?,version=version+1 WHERE protocol='local' AND id<>? AND revoked_at IS NULL", now(), this.store.session);
        this.store.run("UPDATE client_invites SET consumed_at=? WHERE consumed_at IS NULL", now());
      } else {
        const identity = this.store.get("SELECT * FROM external_identities WHERE id=? AND user_id=? AND protocol='native-v1' AND status='active'", externalId, this.store.owner);
        if (!current.connected || !identity || identity.issuer !== config.base_url || identity.subject !== upstream.subject) throw new IdentityError(403, "此账号未获准访问这个 Core");
      }
      this.store.run("DELETE FROM client_sessions WHERE session_id IN (SELECT id FROM user_sessions WHERE revoked_at IS NOT NULL OR expires_at<=?)", now());
      this.store.insert("secrets", { id: ref, ciphertext: this.store.encrypt(JSON.stringify(upstream)) });
      this.store.insert("user_sessions", { id: sessionId!, workspace_id: this.store.workspace, user_id: this.store.owner, token_hash: hash(token), protocol: "native-v1", external_identity_id: externalId!, upstream_session_ref: ref, revocation_mode: "native_status", status_checked_at: now(), created_at: now(), expires_at: expiresAt });
      this.store.insert("client_sessions", { session_id: sessionId!, name: secret.name, last_seen_at: now() });
      this.store.run("UPDATE users SET display_name=?,version=version+1 WHERE id=?", upstream.displayName, this.store.owner);
      if (transactionId) this.store.run("UPDATE login_transactions SET status='consumed',consumed_at=? WHERE id=?", now(), transactionId);
      this.store.audit(secret.purpose === "link" ? "identity.link" : "identity.login", "session", sessionId!, { protocol: "native-v1", providerType: "nex-user" });
    });
    this.checked.set(sessionId, { version: 1, wall: now(), mono: performance.now() });
    return { token, sessionId, expiresAt, coreId: this.clients.coreId(), protocol: "native-v1", version: 1 };
  }
  private async verify(session: Row): Promise<Row | undefined> {
    const sessionId = String(session.id), cached = this.checked.get(sessionId);
    if (cached?.version === session.version && now() >= cached.wall && now() - cached.wall < 60_000 && performance.now() >= cached.mono && performance.now() - cached.mono < 60_000) return session;
    const pending = this.checking.get(sessionId); if (pending) return pending;
    const check = (async () => {
      const encrypted = this.store.get("SELECT ciphertext FROM secrets WHERE id=?", session.upstream_session_ref);
      if (!encrypted) { this.revokeLocal(sessionId); return undefined; }
      const upstream = JSON.parse(this.store.decrypt(String(encrypted.ciphertext))) as UpstreamSession;
      try {
        const user = await this.provider().status(upstream);
        if (this.closed) return undefined;
        if (user.subject !== upstream.subject || !this.store.get("SELECT id FROM external_identities WHERE id=? AND subject=? AND status='active'", session.external_identity_id, user.subject)) { this.revokeLocal(sessionId); return undefined; }
        const current = this.clients.authenticateTokenSession(sessionId);
        if (!current || current.version !== session.version || !this.connected()) return undefined;
        this.checked.set(sessionId, { version: Number(session.version), wall: now(), mono: performance.now() });
        this.store.run("UPDATE user_sessions SET status_checked_at=? WHERE id=?", now(), sessionId);
        return current;
      } catch (error) {
        if (this.closed) return undefined;
        if (error instanceof IdentityError && error.status === 401) { this.revokeLocal(sessionId); return undefined; }
        this.onSessionLost?.(sessionId); throw error;
      }
    })();
    this.checking.set(sessionId, check);
    try { return await check; } finally { this.checking.delete(sessionId); }
  }
  private revokeLocal(sessionId: string) {
    this.store.run("UPDATE user_sessions SET revoked_at=?,version=version+1 WHERE id=? AND revoked_at IS NULL", now(), sessionId);
    this.checked.delete(sessionId); this.onSessionLost?.(sessionId);
  }
  async revoke(sessionId: string) {
    const session = this.store.get("SELECT s.* FROM user_sessions s JOIN client_sessions c ON c.session_id=s.id WHERE s.id=? AND s.workspace_id=? AND s.user_id=?", sessionId, this.store.workspace, this.store.owner);
    if (!session) throw new IdentityError(404, "客户端会话不存在");
    this.revokeLocal(sessionId);
    this.store.audit("identity.logout", "session", sessionId, {});
    if (session.upstream_session_ref) {
      const encrypted = this.store.get("SELECT ciphertext FROM secrets WHERE id=?", session.upstream_session_ref);
      if (encrypted) this.store.run("INSERT OR IGNORE INTO identity_revocations(session_id,secret_ref,next_attempt_at,expires_at) VALUES(?,?,?,?)", sessionId, session.upstream_session_ref, now(), JSON.parse(this.store.decrypt(String(encrypted.ciphertext))).expiresAt);
      await this.retryRevocations();
    }
  }
  async retryRevocations() {
    if (this.closed) return;
    if (this.revoking) return this.revoking;
    this.revoking = (async () => {
      for (const row of this.store.all("SELECT * FROM identity_revocations WHERE next_attempt_at<=? ORDER BY next_attempt_at LIMIT 1", now())) {
        const encrypted = this.store.get("SELECT ciphertext FROM secrets WHERE id=?", row.secret_ref);
        let done = !encrypted || Number(row.expires_at) <= now() || Number(row.attempts) >= 3;
        if (!done) try { await this.provider().revoke(JSON.parse(this.store.decrypt(String(encrypted!.ciphertext))) as UpstreamSession); done = true; } catch { /* local revocation already enforced */ }
        if (this.closed) return;
        this.store.transaction(() => {
          if (done || Number(row.attempts) >= 2) { this.store.run("DELETE FROM identity_revocations WHERE session_id=?", row.session_id); this.store.run("DELETE FROM secrets WHERE id=?", row.secret_ref); }
          else this.store.run("UPDATE identity_revocations SET attempts=attempts+1,next_attempt_at=? WHERE session_id=?", now() + 60_000, row.session_id);
        });
      }
    })();
    try { await this.revoking; } finally { this.revoking = undefined; }
  }
  async logout(token: string) {
    const session = this.store.get("SELECT id FROM user_sessions WHERE token_hash=? AND workspace_id=? AND user_id=?", hash(token), this.store.workspace, this.store.owner);
    if (session && session.id !== this.store.session) await this.revoke(String(session.id));
  }
  /**
   * Extend one already-authenticated client session without asking for the
   * password again. This is what lets a phone keep working past the eight-hour
   * local session without storing a password.
   *
   * The presented bearer is rotated, so a copy taken from a backup stops
   * working the next time the real device refreshes. The upstream session is
   * rechecked first through the same `authenticate` path every request uses,
   * which means a revoked account cannot refresh its way past local
   * revocation, and an outage fails closed with 503 instead of extending.
   * Expiry still follows the original rule: never beyond the upstream session
   * and never beyond `SESSION_MAX_MS` from now.
   */
  async refresh(token: string) {
    const session = await this.authenticate(token);
    if (!session) throw new IdentityError(401, "登录已失效，请重新登录");
    const encrypted = this.store.get("SELECT ciphertext FROM secrets WHERE id=?", session.upstream_session_ref);
    if (!encrypted) throw new IdentityError(401, "登录已失效，请重新登录");
    const upstream = JSON.parse(this.store.decrypt(String(encrypted.ciphertext))) as UpstreamSession;
    const upstreamExpiry = Number(upstream.expiresAt);
    if (!Number.isSafeInteger(upstreamExpiry)) throw new IdentityError(409, "账号会话信息不完整，请重新登录");
    const at = now(), expiresAt = Math.min(upstreamExpiry, at + SESSION_MAX_MS);
    if (expiresAt <= at) throw new IdentityError(401, "登录已失效，请重新登录");
    const next = randomBytes(32).toString("base64url");
    const rotated = this.store.transaction(() => {
      // The old hash is part of the predicate: two concurrent refreshes cannot
      // both win, and one of them is told to use the token it already got.
      const update = this.store.run("UPDATE user_sessions SET token_hash=?,expires_at=?,status_checked_at=?,version=version+1 WHERE id=? AND token_hash=? AND revoked_at IS NULL AND expires_at>?", hash(next), expiresAt, at, session.id, hash(token), at);
      if (Number(update.changes) !== 1) return false;
      this.store.run("UPDATE client_sessions SET last_seen_at=? WHERE session_id=?", at, session.id);
      this.store.audit("identity.refresh", "session", String(session.id), { protocol: "native-v1" });
      return true;
    });
    if (!rotated) {
      // Either another refresh won the rotation (send the client back to the
      // token it already received) or the row expired between the read and the
      // write (nothing can be extended any more).
      if (!this.clients.authenticateTokenSession(String(session.id))) throw new IdentityError(401, "登录已失效，请重新登录");
      throw new IdentityError(409, "登录已刷新，请使用新凭据");
    }
    const current = this.clients.authenticateTokenSession(String(session.id));
    if (current) this.checked.set(String(session.id), { version: Number(current.version), wall: at, mono: performance.now() });
    return { token: next, sessionId: String(session.id), expiresAt, coreId: this.clients.coreId(), protocol: "native-v1", version: 1 };
  }
  async authorizeTask(task: Row) {
    const sessionId = String(task.authorized_session_id);
    if (!this.connected()) return false;
    if (sessionId === this.store.session) {
      // Core-owned routines have no browser principal. They still need a live
      // associated owner session; one client's logout does not revoke another.
      for (const candidate of this.store.all("SELECT * FROM user_sessions WHERE protocol='native-v1' AND external_identity_id=? AND workspace_id=? AND user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC", this.configuration()!.external_identity_id, this.store.workspace, this.store.owner, now())) if (this.clients.authenticateTokenSession(String(candidate.id)) && await this.verify(candidate)) return true;
      return false;
    }
    const session = this.clients.authenticateTokenSession(sessionId);
    if (!session) return false;
    if (session.protocol !== "native-v1" || session.external_identity_id !== this.configuration()!.external_identity_id) return false;
    return session.protocol !== "native-v1" || !!await this.verify(session);
  }
  prune() {
    for (const txn of this.store.all("SELECT id,secret_ref FROM login_transactions WHERE status='pending' AND expires_at<=?", now())) {
      this.store.transaction(() => { this.store.run("UPDATE login_transactions SET status='expired',secret_ref=NULL WHERE id=?", txn.id); if (txn.secret_ref) this.store.run("DELETE FROM secrets WHERE id=?", txn.secret_ref); });
    }
  }
  async close() { this.closed = true; this.controller.abort(); await Promise.allSettled([...this.checking.values(), ...(this.revoking ? [this.revoking] : [])]); }
}
