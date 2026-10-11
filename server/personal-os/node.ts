import { mkdirSync, readFileSync, realpathSync, readdirSync, statSync, openSync, fstatSync, closeSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { isIP } from "node:net";
import { WebSocket } from "ws";
import { hash, now, text, type CoreStore } from "./store.ts";

export function confined(root: string, relative: string) {
  if (path.isAbsolute(relative) || relative.includes("\0") || /^[a-zA-Z]:/.test(relative)) throw new Error("路径须相对授权目录");
  const actualRoot = realpathSync(root), candidate = realpathSync(path.resolve(actualRoot, relative));
  const difference = path.relative(actualRoot, candidate);
  if (difference === ".." || difference.startsWith(".." + path.sep) || path.isAbsolute(difference)) throw new Error("路径超出授权目录（含符号链接）");
  return candidate;
}
interface NodeConfig { origin: string; token: string; root: string; exec: boolean; policyVersion: number }
export class DeviceNode {
  readonly journal: DatabaseSync;
  socket?: WebSocket;
  config?: NodeConfig;
  timer?: NodeJS.Timeout;
  stopping = false;
  status = "未连接";
  binding?: { coreId: string; deviceId: string; ownerId: string };
  executing = false;
  readonly operations = new Set<Promise<void>>();
  readonly commands = new Set<ChildProcess>();
  constructor(readonly store: Pick<CoreStore, "dir" | "get" | "run" | "encrypt" | "decrypt">, readonly changed: () => void) {
    const dir = path.join(store.dir, "node"); mkdirSync(dir, { recursive: true });
    this.journal = new DatabaseSync(path.join(dir, "node.db"));
    if (!this.journal.prepare("SELECT name FROM sqlite_master WHERE name='node_bindings'").get()) this.journal.exec(readFileSync(new URL("./node-schema.sql", import.meta.url), "utf8"));
    this.journal.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.journal.prepare("UPDATE node_calls SET status='unknown' WHERE status IN ('running','received')").run();
    const saved = store.get("SELECT ciphertext FROM secrets WHERE id='node-config'");
    if (saved) { this.config = JSON.parse(store.decrypt(String(saved.ciphertext))); this.connect(); }
  }
  publicState() { return { status: this.status, origin: this.config?.origin ?? "", root: this.config?.root ?? "", exec: this.config?.exec ?? false, connected: this.socket?.readyState === WebSocket.OPEN, unknownCalls: this.journal.prepare("SELECT call_id,capability,arguments_json,version FROM node_calls WHERE status='unknown'").all() }; }
  configure(data: Record<string, unknown>) {
    if (this.executing) throw new Error("设备执行中，请等调用结束再更改授权");
    const origin = new URL(text(data.origin, 2048));
    const privateHost = (isIP(origin.hostname) === 4 && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(origin.hostname)) || origin.hostname === "localhost";
    if (origin.username || origin.password || origin.search || origin.hash || (origin.protocol !== "https:" && !(origin.protocol === "http:" && privateHost))) throw new Error("Core 地址须为 HTTPS 或私有网络 HTTP");
    const root = realpathSync(text(data.root, 4096));
    if (!statSync(root).isDirectory()) throw new Error("请选择一个文件夹");
    const token = typeof data.token === "string" && data.token.trim() ? text(data.token, 200) : this.config?.token;
    if (!token) throw new Error("请输入 Core 生成的设备配对令牌");
    this.socket?.close(); clearTimeout(this.timer);
    this.config = { origin: origin.origin, root, token, exec: data.exec === true, policyVersion: (this.config?.policyVersion ?? 0) + 1 };
    this.store.run("INSERT INTO secrets VALUES('node-config',?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext", this.store.encrypt(JSON.stringify(this.config)));
    this.connect(); return this.publicState();
  }
  connect() {
    if (this.stopping || !this.config) return;
    const endpoint = new URL(this.config.origin); endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:"; endpoint.pathname = "/dcp/v1/connect";
    const ws = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${this.config.token}` }, maxPayload: 3 * 1024 * 1024, handshakeTimeout: 10_000 });
    this.socket = ws; this.status = "连接中"; this.changed();
    ws.on("open", () => { ws.send(JSON.stringify({ type: "hello", policyVersion: this.config!.policyVersion, exec: this.config!.exec, platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux" })); });
    ws.on("message", (raw) => { try { const operation = this.message(ws, JSON.parse(raw.toString())).catch(() => ws.close(1008, "Invalid command")); this.operations.add(operation); void operation.finally(() => this.operations.delete(operation)); } catch { ws.close(1008, "Invalid message"); } });
    ws.on("error", () => { this.status = "连接失败，检查 Core 地址和配对令牌"; this.changed(); });
    ws.on("close", () => {
      if (this.socket !== ws || this.stopping) return;
      this.status = "离线，正在重连"; this.changed(); this.timer = setTimeout(() => this.connect(), 5000);
    });
  }
  async message(ws: WebSocket, event: Record<string, unknown>) {
    if (event.type === "bound") {
      const coreId = text(event.coreId, 100), deviceId = text(event.deviceId, 100), ownerId = text(event.ownerId, 100), bindingId = coreId + ":" + deviceId;
      this.journal.exec("BEGIN IMMEDIATE");
      try {
        this.journal.prepare("UPDATE node_bindings SET status='revoked' WHERE id!=?").run(bindingId);
        this.journal.prepare("INSERT INTO node_bindings VALUES(?,?,?,?,?,NULL,'active',?) ON CONFLICT(id) DO UPDATE SET status='active',core_origin=excluded.core_origin").run(bindingId, coreId, deviceId, ownerId, this.config!.origin, now());
        this.journal.prepare("INSERT INTO local_grants VALUES(?,'shared',?,?,?,'active',?) ON CONFLICT(binding_id,id) DO UPDATE SET policy_version=excluded.policy_version,scope_json=excluded.scope_json,root_mapping_ref=excluded.root_mapping_ref,status='active',updated_at=excluded.updated_at").run(bindingId, this.config!.policyVersion, JSON.stringify({ read: true, exec: this.config!.exec }), this.config!.root, now());
        this.journal.exec("COMMIT");
      } catch (e) { this.journal.exec("ROLLBACK"); throw e; }
      this.binding = { coreId, deviceId, ownerId }; this.status = "已连接"; this.changed();
      for (const row of this.journal.prepare("SELECT * FROM node_calls WHERE binding_id=? AND result_acknowledged_at IS NULL").all(bindingId)) this.deliver(ws, row);
    }
    if (event.type === "ack" && this.binding) this.journal.prepare("UPDATE node_calls SET result_acknowledged_at=? WHERE binding_id=? AND call_id=? AND result_hash=?").run(now(), this.binding.coreId + ":" + this.binding.deviceId, String(event.callId), String(event.resultHash));
    if (event.type === "reconcile" && this.binding && ws === this.socket && Array.isArray(event.calls)) {
      const bindingId = this.binding.coreId + ":" + this.binding.deviceId;
      for (const call of event.calls.slice(0, 100) as Array<{ id: string; argument_hash: string }>) {
        const row = this.journal.prepare("SELECT * FROM node_calls WHERE binding_id=? AND call_id=?").get(bindingId, call.id);
        if (row) this.deliver(ws, row);
        else {
          const result = { error: "设备持久日志确认未收到该调用，未执行", reconciled: true, outcome: "confirmed_not_executed" };
          ws.send(JSON.stringify({ type: "result", callId: call.id, argumentHash: call.argument_hash, resultHash: hash(JSON.stringify(result)), result, failed: true }));
        }
      }
    }
    if (event.type !== "call") return;
    if (!this.binding || !this.config || ws !== this.socket) throw new Error("Device is not bound");
    const callId = text(event.callId, 100), envelope = text(event.canonicalEnvelope, 100_000), digest = hash(envelope), source = JSON.parse(envelope) as Record<string, unknown>;
    if (event.argumentHash !== digest || source.callId !== callId || source.targetId !== this.binding.deviceId || Number(event.localPolicyVersion) !== this.config.policyVersion) throw new Error("DCP identity/policy conflict");
    const bindingId = this.binding.coreId + ":" + this.binding.deviceId;
    const old = this.journal.prepare("SELECT * FROM node_calls WHERE binding_id=? AND call_id=?").get(bindingId, callId);
    if (old) { if (old.argument_hash !== digest || old.canonical_envelope !== envelope) throw new Error("Immutable call conflict"); this.deliver(ws, old); return; }
    if (this.executing || this.journal.prepare("SELECT call_id FROM node_calls WHERE binding_id=? AND status IN ('received','running','unknown')").get(bindingId)) throw new Error("A call is running or unresolved");
    const expires = Number(event.leaseExpiresAt), deadline = Number(event.deadlineAt), leaseSeq = Number(event.leaseSeq);
    if (!Number.isSafeInteger(expires) || expires <= now() || expires > now() + 30_000 || deadline < expires || !Number.isSafeInteger(leaseSeq) || leaseSeq < 1) throw new Error("Lease expired");
    const capability = text(source.capability, 50), args = source.arguments as Record<string, unknown>;
    if (!["device.list", "device.read", "device.exec"].includes(capability)) throw new Error("Unsupported capability");
    this.journal.prepare("INSERT INTO node_calls(binding_id,call_id,local_grant_id,local_policy_version,capability,arguments_json,canonical_envelope,argument_hash,status,lease_seq,lease_expires_at,deadline_at,received_at) VALUES(?,?,'shared',?,?,?,?,?,'received',?,?,?,?)").run(bindingId, callId, this.config.policyVersion, capability, JSON.stringify(args), envelope, digest, leaseSeq, expires, deadline, now());
    this.executing = true;
    this.journal.prepare("UPDATE node_calls SET status='running' WHERE binding_id=? AND call_id=?").run(bindingId, callId);
    let result: unknown, failed = false;
    try {
      const root = this.config.root;
      if (now() >= expires) throw new Error("执行租约已过期，未启动操作");
      if (capability === "device.exec") {
        if (!this.config.exec) throw new Error("设备未授权终端");
        result = await this.command(text(args.command, 8192), root, Math.min(20_000, expires - now()));
      } else {
        const file = confined(root, typeof args.path === "string" ? args.path : ".");
        if (capability === "device.list") result = { path: args.path ?? ".", entries: readdirSync(file, { withFileTypes: true }).slice(0, 300).map((f) => ({ name: f.name, directory: f.isDirectory(), link: f.isSymbolicLink() })) };
        else {
          // Revalidate the opened handle so a replaced junction cannot silently
          // expand the grant. Root remains immutable during execution.
          const handle = openSync(file, "r");
          try {
            const stat = fstatSync(handle);
            if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error("只支持 20 MB 以内的文件");
            confined(root, path.relative(root, file));
            const buffer = readFileSync(handle);
            if (/\.pdf$/i.test(file)) {
              const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
              const loading = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: false });
              const pdf = await loading.promise;
              let extracted = "";
              try { for (let page = 1; page <= Math.min(pdf.numPages, 100); page++) { const content = await (await pdf.getPage(page)).getTextContent(); extracted += `\n[Page ${page}]\n` + content.items.map((item) => "str" in item ? item.str : "").join(" "); if (extracted.length > 80_000) break; } }
              finally { await loading.destroy(); }
              result = { path: args.path, text: extracted.slice(0, 80_000), truncated: extracted.length > 80_000, pages: pdf.numPages };
            } else result = { path: args.path, text: buffer.toString("utf8").slice(0, 80_000), truncated: buffer.length > 80_000 };
          } finally { closeSync(handle); }
        }
      }
    } catch (error) { failed = true; result = { error: error instanceof Error ? error.message : "执行失败" }; }
    finally { this.executing = false; }
    const json = JSON.stringify(result);
    this.journal.prepare("UPDATE node_calls SET status=?,result_json=?,result_hash=?,finished_at=?,version=version+1 WHERE binding_id=? AND call_id=?").run(failed ? "failed" : "succeeded", json, hash(json), now(), bindingId, callId);
    this.deliver(ws, this.journal.prepare("SELECT * FROM node_calls WHERE binding_id=? AND call_id=?").get(bindingId, callId)!);
    this.changed();
  }
  deliver(ws: WebSocket, row: Record<string, unknown>) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (row.status === "unknown") ws.send(JSON.stringify({ type: "unknown", callId: row.call_id }));
    else if (row.result_json) ws.send(JSON.stringify({ type: "result", callId: row.call_id, argumentHash: row.argument_hash, resultHash: row.result_hash, result: JSON.parse(String(row.result_json)), failed: row.status === "failed" }));
  }
  command(command: string, root: string, timeout: number): Promise<unknown> {
    // Terminal authority is explicit and covers all OS rights of this user;
    // cwd is convenience, never described as a shell security sandbox.
    return new Promise((resolve) => {
      const child = process.platform === "win32" ? spawn("powershell.exe", ["-NoLogo", "-NonInteractive", "-NoProfile", "-Command", command], { cwd: root, windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP } }) : spawn("/bin/sh", ["-c", command], { cwd: root, env: { PATH: process.env.PATH } });
      this.commands.add(child);
      let stdout = "", stderr = "", timedOut = false;
      child.stdout.on("data", (data: Buffer) => { stdout = (stdout + data.toString()).slice(0, 50_000); });
      child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(0, 10_000); });
      const timer = setTimeout(() => { timedOut = true; if (process.platform === "win32" && child.pid) spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); else child.kill("SIGKILL"); }, Math.max(1, timeout));
      child.once("error", (e) => { clearTimeout(timer); this.commands.delete(child); resolve({ error: e.message }); });
      child.once("close", (code) => { clearTimeout(timer); this.commands.delete(child); resolve({ stdout, stderr, code, timedOut }); });
    });
  }
  reconcile(callId: string, version: number) {
    if (this.executing) throw new Error("仍有调用在执行中");
    const row = this.journal.prepare("SELECT * FROM node_calls WHERE call_id=? AND status='unknown' AND version=?").get(callId, version);
    if (!row) throw new Error("调用状态已变化");
    const json = JSON.stringify({ error: "设备用户已核实此调用停止；结果不可恢复，未再次执行", reconciled: true });
    this.journal.prepare("UPDATE node_calls SET status='failed',result_json=?,result_hash=?,finished_at=?,version=version+1 WHERE binding_id=? AND call_id=? AND status='unknown' AND version=?").run(json, hash(json), now(), row.binding_id, callId, version);
    if (this.socket) this.deliver(this.socket, this.journal.prepare("SELECT * FROM node_calls WHERE binding_id=? AND call_id=?").get(row.binding_id, callId)!);
    this.changed();
  }
  async close() {
    this.stopping = true; clearTimeout(this.timer); this.socket?.terminate();
    for (const child of this.commands) { if (process.platform === "win32" && child.pid) spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); else child.kill("SIGKILL"); }
    await Promise.allSettled(this.operations); this.journal.close();
  }
}
