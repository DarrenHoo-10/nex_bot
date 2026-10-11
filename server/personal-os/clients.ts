import { randomBytes, randomUUID } from "node:crypto";
import { CoreStore, hash, now, text } from "./store.ts";

// Client identity is separate from the DCP execution credential. Local-owner
// mode is an adapter to the same user_sessions contract as future native login.
export class ClientIdentity {
  constructor(readonly store: CoreStore) {}
  coreId() { return String(this.store.get("SELECT core_id FROM workspaces WHERE id=?", this.store.workspace)!.core_id); }
  authenticate(token: string) {
    if (!token || token.length > 200) return undefined;
    const session = this.store.get("SELECT s.*,c.name client_name FROM user_sessions s LEFT JOIN client_sessions c ON c.session_id=s.id JOIN memberships m ON m.workspace_id=s.workspace_id AND m.user_id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.workspace_id=? AND s.user_id=? AND m.status='active'", hash(token), now(), this.store.workspace, this.store.owner);
    if (session?.client_name) this.store.run("UPDATE client_sessions SET last_seen_at=? WHERE session_id=? AND last_seen_at<?", now(), session.id, now() - 60_000);
    return session;
  }
  invite(name: unknown) {
    const token = randomBytes(24).toString("base64url"), inviteId = randomUUID(), expiresAt = now() + 10 * 60_000;
    this.store.insert("client_invites", { id: inviteId, token_hash: hash(token), name: text(name, 80), expires_at: expiresAt, created_at: now() });
    return { id: inviteId, code: token, expiresAt, coreId: this.coreId() };
  }
  login(code: unknown, name: unknown) {
    const token = randomBytes(32).toString("base64url"), sessionId = randomUUID(), expiresAt = now() + 30 * 86_400_000;
    this.store.transaction(() => {
      const invite = this.store.get("SELECT * FROM client_invites WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?", hash(text(code, 100)), now());
      if (!invite) throw new Error("连接码无效或已过期，请在主设备重新生成");
      this.store.run("UPDATE client_invites SET consumed_at=? WHERE id=?", now(), invite.id);
      this.store.insert("user_sessions", { id: sessionId, workspace_id: this.store.workspace, user_id: this.store.owner, token_hash: hash(token), protocol: "local", revocation_mode: "local", created_at: now(), expires_at: expiresAt });
      this.store.insert("client_sessions", { session_id: sessionId, name: text(name ?? invite.name, 80), last_seen_at: now() });
    });
    return { token, sessionId, expiresAt, coreId: this.coreId(), protocol: "local", version: 1 };
  }
  list() { return this.store.all("SELECT c.*,s.created_at,s.expires_at,s.revoked_at FROM client_sessions c JOIN user_sessions s ON s.id=c.session_id ORDER BY s.created_at DESC"); }
  revoke(sessionId: string) {
    if (!this.store.get("SELECT session_id FROM client_sessions WHERE session_id=?", sessionId)) throw new Error("客户端会话不存在");
    this.store.run("UPDATE user_sessions SET revoked_at=?,version=version+1 WHERE id=? AND revoked_at IS NULL", now(), sessionId);
  }
}
