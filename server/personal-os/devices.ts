import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { Server } from "node:http";
import { CoreStore, hash, id, now, text, type Row } from "./store.ts";

export class DeviceGateway {
  readonly sockets = new Map<string, WebSocket>();
  readonly pending = new Map<string, { resolve: (result: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout; deviceId: string }>();
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 3 * 1024 * 1024 });
  constructor(readonly store: CoreStore, server: Server, readonly changed: () => void) {
    server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/dcp/v1/connect") { socket.destroy(); return; }
      const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const credential = store.get("SELECT * FROM device_credentials WHERE access_hash=? AND status='active' AND access_expires_at>?", hash(token), now());
      const device = credential && store.get("SELECT id FROM devices WHERE id=? AND status='bound'", credential.device_id);
      if (!device || !credential) { socket.destroy(); return; }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.connect(String(credential.device_id), ws));
    });
    store.run("UPDATE device_calls SET status='unknown' WHERE status IN ('delivered','running')");
  }
  pair(name: string) {
    const deviceId = id(), token = randomBytes(32).toString("base64url");
    this.store.transaction(() => {
      this.store.insert("devices", { id: deviceId, ...this.store.scope(), name: text(name, 80), platform: "windows", protocol_version: "dcp/1", status: "bound", capabilities_json: "[]", created_at: now() });
      this.store.insert("device_credentials", { id: id(), device_id: deviceId, family_id: id(), generation: 1, access_hash: hash(token), refresh_hash: hash(randomBytes(32).toString("hex")), status: "active", issued_at: now(), access_expires_at: now() + 365 * 86_400_000, refresh_idle_expires_at: now() + 365 * 86_400_000, family_expires_at: now() + 365 * 86_400_000 });
      this.store.audit("device.pair", "device", deviceId, { name });
    });
    this.changed(); return { deviceId, token };
  }
  connect(deviceId: string, ws: WebSocket) {
    const old = this.sockets.get(deviceId);
    if (old) old.close();
    this.sockets.set(deviceId, ws);
    ws.on("message", (raw) => {
      try {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (event.type === "hello") {
          const version = Number(event.policyVersion);
          if (!Number.isSafeInteger(version) || version < 1) throw new Error("Invalid local policy");
          const scope = { root: "shared", read: true, exec: event.exec === true };
          this.store.run("UPDATE devices SET capabilities_json=?,last_seen_at=?,platform=? WHERE id=?", JSON.stringify(scope.exec ? ["device.read", "device.list", "device.exec"] : ["device.read", "device.list"]), now(), ["windows", "macos", "linux"].includes(String(event.platform)) ? String(event.platform) : "windows", deviceId);
          this.store.run("INSERT INTO device_local_grants(device_id,local_grant_id,workspace_id,owner_user_id,policy_version,scope_json,status,reported_at) VALUES(?,'shared',?,?,?,?, 'active',?) ON CONFLICT(device_id,local_grant_id) DO UPDATE SET policy_version=excluded.policy_version,scope_json=excluded.scope_json,status='active',reported_at=excluded.reported_at", deviceId, this.store.workspace, this.store.owner, version, JSON.stringify(scope), now());
          this.store.run("UPDATE device_grants SET status='stale' WHERE device_id=? AND local_policy_version!=?", deviceId, version);
          ws.send(JSON.stringify({ type: "bound", coreId: this.store.get("SELECT core_id FROM workspaces")!.core_id, deviceId, ownerId: this.store.owner }));
          const unresolved = this.store.all("SELECT d.id,t.argument_hash FROM device_calls d JOIN tool_calls t ON t.id=d.id WHERE d.device_id=? AND d.status='unknown'", deviceId);
          if (unresolved.length) ws.send(JSON.stringify({ type: "reconcile", calls: unresolved }));
          this.changed();
        }
        if (event.type === "result") {
          const callId = text(event.callId, 100), call = this.store.get("SELECT d.*,t.argument_hash FROM device_calls d JOIN tool_calls t ON t.id=d.id WHERE d.id=? AND d.device_id=?", callId, deviceId);
          if (!call || event.argumentHash !== call.argument_hash) throw new Error("Result source mismatch");
          const json = JSON.stringify(event.result), resultHash = hash(json);
          if (event.resultHash !== resultHash) throw new Error("Result digest mismatch");
          if (call.result_hash && call.result_hash !== resultHash) throw new Error("Immutable result conflict");
          this.store.transaction(() => {
            if (call.status === "unknown" && event.result && typeof event.result === "object" && (event.result as { reconciled?: boolean }).reconciled) this.store.insert("call_reconciliations", { id: id(), tool_call_id: callId, ...this.store.scope(), argument_hash: call.argument_hash, decision_key: resultHash, expected_call_version: call.version, source: "device_result", outcome: (event.result as { outcome?: string }).outcome === "confirmed_not_executed" ? "confirmed_not_executed" : "confirmed_stopped", evidence_json: json, created_at: now() });
            this.store.run("UPDATE device_calls SET status=?,result_json=?,result_hash=?,received_at=?,version=version+1 WHERE id=?", event.failed === true ? "failed" : "succeeded", json, resultHash, now(), callId);
            this.store.run("UPDATE tool_calls SET status=?,result_json=?,result_hash=?,version=version+1 WHERE id=? AND status IN ('executing','unknown','ready')", event.failed === true ? "failed" : "succeeded", json, resultHash, callId);
            this.store.run("UPDATE tasks SET status='queued' WHERE id=(SELECT task_id FROM tool_calls WHERE id=?) AND status='needs_reconciliation'", callId);
          });
          ws.send(JSON.stringify({ type: "ack", callId, resultHash }));
          const pending = this.pending.get(callId);
          if (pending) { clearTimeout(pending.timer); this.pending.delete(callId); pending.resolve(event.result); }
          this.changed();
        }
        if (event.type === "unknown") {
          const callId = text(event.callId, 100);
          this.store.run("UPDATE device_calls SET status='unknown' WHERE id=? AND device_id=?", callId, deviceId);
          this.store.run("UPDATE tool_calls SET status='unknown' WHERE id=? AND target_id=?", callId, deviceId);
          const pending = this.pending.get(callId);
          if (pending) { clearTimeout(pending.timer); this.pending.delete(callId); pending.reject(new Error("设备运行中断，执行结果未知；请在设备上核实")); }
          this.changed();
        }
      } catch { ws.close(1008, "Invalid DCP message"); }
    });
    ws.on("close", () => { if (this.sockets.get(deviceId) === ws) this.sockets.delete(deviceId); this.changed(); });
  }
  async execute(call: Row, args: Record<string, unknown>) {
    const deviceId = String(call.target_id), ws = this.sockets.get(deviceId), local = this.store.get("SELECT * FROM device_local_grants WHERE device_id=? AND local_grant_id='shared' AND status='active'", deviceId);
    if (!ws || ws.readyState !== WebSocket.OPEN || !local) throw new Error("设备离线或没有本地授权");
    if (local.policy_version !== JSON.parse(String(call.authorization_snapshot_json)).localPolicyVersion) throw new Error("设备本地权限版本已变化，旧批准无效");
    if (call.tool_name === "device.exec" && !JSON.parse(String(local.scope_json)).exec) throw new Error("设备未启用终端能力");
    const old = this.store.get("SELECT * FROM device_calls WHERE id=?", call.id);
    if (old?.result_json) return JSON.parse(String(old.result_json));
    if (old?.status === "unknown") { this.store.run("UPDATE tool_calls SET status='unknown' WHERE id=?", call.id); throw new Error("设备执行结果未知，禁止重放"); }
    if (this.store.get("SELECT id FROM device_calls WHERE device_id=? AND status IN ('delivered','running','unknown') AND id!=?", deviceId, call.id)) throw new Error("设备存在运行中或不确定的调用");
    const deadline = now() + 30_000, grantId = id();
    if (!old) this.store.transaction(() => {
      this.store.insert("device_grants", { id: grantId, ...this.store.scope(), bot_id: call.bot_id, device_id: deviceId, local_grant_id: "shared", local_policy_version: local.policy_version, scope_json: local.scope_json, status: "active", created_at: now(), expires_at: deadline });
      this.store.insert("device_calls", { id: call.id, ...this.store.scope(), bot_id: call.bot_id, device_id: deviceId, grant_id: grantId, local_grant_id: "shared", grant_version: 1, local_policy_version: local.policy_version, status: "delivered", delivery_count: 1, lease_seq: 1, lease_issued_at: now(), lease_expires_at: deadline, deadline_at: deadline, created_at: now() - 1 });
    });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(call.id));
        this.store.run("UPDATE device_calls SET status='unknown' WHERE id=? AND result_json IS NULL", call.id);
        this.store.run("UPDATE tool_calls SET status='unknown' WHERE id=? AND result_json IS NULL", call.id);
        reject(new Error("设备未返回确认，结果未知；不会自动再次执行"));
      }, 35_000);
      this.pending.set(String(call.id), { resolve, reject, timer, deviceId });
      ws.send(JSON.stringify({ type: "call", callId: call.id, canonicalEnvelope: call.canonical_envelope, argumentHash: call.argument_hash, localPolicyVersion: local.policy_version, leaseSeq: 1, leaseExpiresAt: deadline, deadlineAt: deadline, args }));
    });
  }
  revoke(deviceId: string) {
    this.store.transaction(() => {
      this.store.run("UPDATE devices SET status='revoked',revoked_at=? WHERE id=?", now(), deviceId);
      this.store.run("UPDATE device_credentials SET status='revoked' WHERE device_id=?", deviceId);
      this.store.run("UPDATE device_grants SET status='revoked' WHERE device_id=?", deviceId);
      this.store.run("UPDATE device_local_grants SET status='revoked' WHERE device_id=?", deviceId);
    });
    this.sockets.get(deviceId)?.close(); this.changed();
  }
  close() { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Core shutting down")); } this.pending.clear(); for (const ws of this.sockets.values()) ws.terminate(); this.wss.close(); }
}
