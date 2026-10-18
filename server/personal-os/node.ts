import { mkdirSync, readFileSync, realpathSync, readdirSync, statSync, openSync, fstatSync, closeSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { isIP } from "node:net";
import { WebSocket } from "ws";
import { hash, now, text, type CoreStore } from "./store.ts";
import os from "node:os";
import { ComputerExecutor } from "./computer.ts";
import { DEVICE_LEASE_MS } from "./devices.ts";

/** A call whose absolute lease is staler than this means the device clock is badly wrong, not merely drifting. */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;

export function confined(root: string, relative: string) {
  if (path.isAbsolute(relative) || relative.includes("\0") || /^[a-zA-Z]:/.test(relative)) throw new Error("路径须相对授权目录");
  const actualRoot = realpathSync(root), candidate = realpathSync(path.resolve(actualRoot, relative));
  const difference = path.relative(actualRoot, candidate);
  if (difference === ".." || difference.startsWith(".." + path.sep) || path.isAbsolute(difference)) throw new Error("路径超出授权目录（含符号链接）");
  return candidate;
}
interface NodeConfig { origin: string; token: string; root: string; exec: boolean; computer?: boolean; policyVersion: number }
function stopOwnedCommand(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else {
    // POSIX commands get their own group; stop shell descendants as well.
    // Otherwise inherited output pipes stay open after the shell is killed.
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL"); }
  }
}
export class DeviceNode {
  readonly journal: DatabaseSync;
  socket?: WebSocket;
  config?: NodeConfig;
  timer?: NodeJS.Timeout;
  stopping = false;
  status = "未连接";
  binding?: { coreId: string; deviceId: string; ownerId: string };
  executing = false;
  activeCall?: { bindingId: string; callId: string; digest: string; controller: AbortController };
  readonly operations = new Set<Promise<void>>();
  readonly commands = new Set<ChildProcess>();
  readonly computer = new ComputerExecutor();
  identity() { return { hostname: os.hostname(), platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux", os: os.type(), release: os.release(), architecture: os.arch(), supported: ["device.info", "device.list", "device.read", "device.exec", ...(this.computer.available() ? ["device.computer"] : [])] }; }
  constructor(readonly store: Pick<CoreStore, "dir" | "get" | "run" | "encrypt" | "decrypt">, readonly changed: () => void, enabled = true) {
    const dir = path.join(store.dir, "node"); mkdirSync(dir, { recursive: true });
    this.journal = new DatabaseSync(path.join(dir, "node.db"));
    if (!this.journal.prepare("SELECT name FROM sqlite_master WHERE name='node_bindings'").get()) this.journal.exec(readFileSync(new URL("./node-schema.sql", import.meta.url), "utf8"));
    this.journal.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.journal.prepare("UPDATE node_calls SET status='unknown' WHERE status IN ('running','received')").run();
    const saved = store.get("SELECT ciphertext FROM secrets WHERE id='node-config'");
    if (saved && enabled) { this.config = JSON.parse(store.decrypt(String(saved.ciphertext))); this.connect(); }
  }
  publicState() { return { status: this.status, origin: this.config?.origin ?? "", root: this.config?.root ?? "", exec: this.config?.exec ?? false, computer: this.config?.computer ?? false, computerSupported: this.computer.available(), deviceId: this.binding?.deviceId ?? "", connected: this.socket?.readyState === WebSocket.OPEN, unknownCalls: this.journal.prepare("SELECT call_id,capability,arguments_json,version FROM node_calls WHERE status='unknown'").all() }; }
  configure(data: Record<string, unknown>) {
    if (this.executing) throw new Error("设备执行中，请等调用结束再更改授权");
    const origin = new URL(text(data.origin, 2048));
    const privateHost = (isIP(origin.hostname) === 4 && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(origin.hostname)) || origin.hostname === "localhost";
    if (origin.username || origin.password || origin.search || origin.hash || (origin.protocol !== "https:" && !(origin.protocol === "http:" && privateHost))) throw new Error("Core 地址须为 HTTPS 或私有网络 HTTP");
    const root = typeof data.root === "string" && data.root.trim() ? realpathSync(text(data.root, 4096)) : "";
    if (root && !statSync(root).isDirectory()) throw new Error("请选择一个文件夹");
    const exec = data.exec !== false, computer = data.computer === undefined ? this.computer.available() : data.computer === true;
    if (data.computer === true && !this.computer.available()) throw new Error("本机 computer use 运行时不可用");
    const token = typeof data.token === "string" && data.token.trim() ? text(data.token, 200) : this.config?.token;
    if (!token) throw new Error("请输入 Core 生成的设备配对令牌");
    this.socket?.close(); clearTimeout(this.timer);
    const changedPolicy = !this.config || this.config.root !== root || this.config.token !== token || this.config.exec !== exec || (this.config.computer ?? false) !== computer;
    this.config = { origin: origin.origin, root, token, exec, computer, policyVersion: (this.config?.policyVersion ?? 0) + (changedPolicy ? 1 : 0) };
    this.store.run("INSERT INTO secrets VALUES('node-config',?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext", this.store.encrypt(JSON.stringify(this.config)));
    this.connect(); return this.publicState();
  }
  connect() {
    if (this.stopping || !this.config) return;
    const endpoint = new URL(this.config.origin); endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:"; endpoint.pathname = "/dcp/v1/connect";
    const ws = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${this.config.token}` }, maxPayload: 8 * 1024 * 1024, handshakeTimeout: 10_000 });
    this.socket = ws; this.status = "连接中"; this.changed();
    ws.on("open", () => { if (this.socket !== ws || this.stopping) return; ws.send(JSON.stringify({ type: "hello", policyVersion: this.config!.policyVersion, read: !!this.config!.root, exec: this.config!.exec, computer: this.config!.computer === true && this.computer.available(), identity: this.identity(), platform: this.identity().platform })); });
    ws.on("message", (raw) => { try { const operation = this.message(ws, JSON.parse(raw.toString())).catch(() => ws.close(1008, "Invalid command")); this.operations.add(operation); void operation.finally(() => this.operations.delete(operation)); } catch { ws.close(1008, "Invalid message"); } });
    ws.on("error", () => { if (this.socket !== ws || this.stopping) return; this.status = "连接失败，检查 Core 地址和配对令牌"; this.changed(); });
    ws.on("close", () => {
      if (this.socket !== ws || this.stopping) return;
      this.status = "离线，正在重连"; this.changed(); this.timer = setTimeout(() => this.connect(), 5000);
    });
  }
  async message(ws: WebSocket, event: Record<string, unknown>) {
    if (ws !== this.socket || this.stopping) return;
    if (event.type === "bound") {
      const coreId = text(event.coreId, 100), deviceId = text(event.deviceId, 100), ownerId = text(event.ownerId, 100), bindingId = coreId + ":" + deviceId;
      this.journal.exec("BEGIN IMMEDIATE");
      try {
        this.journal.prepare("UPDATE node_bindings SET status='revoked' WHERE id!=?").run(bindingId);
        this.journal.prepare("INSERT INTO node_bindings VALUES(?,?,?,?,?,NULL,'active',?) ON CONFLICT(id) DO UPDATE SET status='active',core_origin=excluded.core_origin").run(bindingId, coreId, deviceId, ownerId, this.config!.origin, now());
        this.journal.prepare("INSERT INTO local_grants VALUES(?,'shared',?,?,?,'active',?) ON CONFLICT(binding_id,id) DO UPDATE SET policy_version=excluded.policy_version,scope_json=excluded.scope_json,root_mapping_ref=excluded.root_mapping_ref,status='active',updated_at=excluded.updated_at").run(bindingId, this.config!.policyVersion, JSON.stringify({ info: true, read: !!this.config!.root, exec: this.config!.exec, computer: this.config!.computer === true }), this.config!.root, now());
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
    if (event.type === "cancel") {
      if (!this.binding || ws !== this.socket) throw new Error("Device is not bound");
      const bindingId = this.binding.coreId + ":" + this.binding.deviceId;
      const callId = text(event.callId, 100);
      const row = this.journal.prepare("SELECT * FROM node_calls WHERE binding_id=? AND call_id=?").get(bindingId, callId);
      // Reconciliation will acknowledge a command absent from the journal;
      // cancellation itself must never create or execute a missing command.
      if (!row) return;
      if (row.argument_hash !== event.argumentHash) throw new Error("Cancellation identity conflict");
      if (this.activeCall?.bindingId === bindingId && this.activeCall.callId === callId && this.activeCall.digest === event.argumentHash) this.activeCall.controller.abort();
      else this.deliver(ws, row);
      return;
    }
    if (event.type !== "call") return;
    if (!this.binding || !this.config || ws !== this.socket) throw new Error("Device is not bound");
    const callId = text(event.callId, 100), envelope = text(event.canonicalEnvelope, 100_000), digest = hash(envelope), source = JSON.parse(envelope) as Record<string, unknown>;
    if (event.argumentHash !== digest || source.callId !== callId || source.targetId !== this.binding.deviceId) throw new Error("DCP identity conflict");
    const bindingId = this.binding.coreId + ":" + this.binding.deviceId;
    const old = this.journal.prepare("SELECT * FROM node_calls WHERE binding_id=? AND call_id=?").get(bindingId, callId);
    if (old) { if (old.argument_hash !== digest || old.canonical_envelope !== envelope) throw new Error("Immutable call conflict"); this.deliver(ws, old); return; }
    // Past this point the call is not in the journal, so each refusal is answered
    // with a confirmed "not executed". Dropping the socket instead would hide the
    // reason and leave Core waiting out its timeout and a reconnect.
    if (Number(event.localPolicyVersion) !== this.config.policyVersion) return this.refuse(ws, callId, digest, "设备本地权限版本已变化，未执行");
    if (this.executing || this.journal.prepare("SELECT call_id FROM node_calls WHERE binding_id=? AND status IN ('received','running','unknown')").get(bindingId)) return this.refuse(ws, callId, digest, "设备正在执行其他调用或有未核实的调用，未执行");
    // The lease is a duration counted from receipt. Core's wall clock and this
    // device's drift apart (an unsynced PC is ahead or behind by seconds), so the
    // absolute `leaseExpiresAt` is only checked for being wildly stale.
    const received = now(), expires = Number(event.leaseExpiresAt), deadline = Number(event.deadlineAt), leaseSeq = Number(event.leaseSeq);
    const leaseMs = event.leaseMs === undefined ? DEVICE_LEASE_MS : Number(event.leaseMs);
    if (!Number.isSafeInteger(expires) || !Number.isSafeInteger(deadline) || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > DEVICE_LEASE_MS || deadline < expires || !Number.isSafeInteger(leaseSeq) || leaseSeq < 1) return this.refuse(ws, callId, digest, "执行租约无效，未启动操作");
    if (expires < received - CLOCK_SKEW_TOLERANCE_MS) return this.refuse(ws, callId, digest, "设备系统时钟与 Core 相差超过 5 分钟，请校准系统时间；未启动操作");
    const leaseEnd = received + leaseMs;
    const capability = text(source.capability, 50), args = source.arguments as Record<string, unknown>;
    if (!["device.info", "device.list", "device.read", "device.exec", "device.computer"].includes(capability)) return this.refuse(ws, callId, digest, "设备不支持该能力，未执行");
    this.journal.prepare("INSERT INTO node_calls(binding_id,call_id,local_grant_id,local_policy_version,capability,arguments_json,canonical_envelope,argument_hash,status,lease_seq,lease_expires_at,deadline_at,received_at) VALUES(?,?,'shared',?,?,?,?,?,'received',?,?,?,?)").run(bindingId, callId, this.config.policyVersion, capability, JSON.stringify(args), envelope, digest, leaseSeq, expires, deadline, received);
    this.executing = true;
    const controller = new AbortController();
    this.activeCall = { bindingId, callId, digest, controller };
    this.journal.prepare("UPDATE node_calls SET status='running' WHERE binding_id=? AND call_id=?").run(bindingId, callId);
    let result: unknown, failed = false;
    try {
      const root = this.config.root;
      if (now() >= leaseEnd) throw new Error("执行租约已过期，未启动操作");
      if (capability === "device.info") result = { ...this.identity(), granted: { info: true, read: !!root, exec: this.config.exec, computer: this.config.computer === true } };
      else if (capability === "device.computer") {
        if (!this.config.computer) throw new Error("目标设备未提供屏幕控制执行器");
        result = await this.computer.execute(text(args.operation, 80), args.parameters as Record<string, unknown> ?? {}, Math.min(20_000, leaseEnd - now()), controller.signal);
        failed = (result as { isError?: boolean }).isError === true;
      } else if (capability === "device.exec") {
        if (!this.config.exec) throw new Error("设备未授权终端");
        result = await this.command(text(args.command, 8192), root || os.homedir(), Math.min(20_000, leaseEnd - now()), controller.signal);
        failed = !!(result as { error?: string }).error;
      } else {
        if (!root) throw new Error("设备未授权文件目录");
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
    finally { this.executing = false; this.activeCall = undefined; }
    if (capability === "device.computer" && (result as { unknown?: boolean })?.unknown) {
      this.journal.prepare("UPDATE node_calls SET status='unknown',version=version+1 WHERE binding_id=? AND call_id=?").run(bindingId, callId);
      this.deliver(ws, this.journal.prepare("SELECT * FROM node_calls WHERE binding_id=? AND call_id=?").get(bindingId, callId)!); this.changed(); return;
    }
    const json = JSON.stringify(result);
    this.journal.prepare("UPDATE node_calls SET status=?,result_json=?,result_hash=?,finished_at=?,version=version+1 WHERE binding_id=? AND call_id=?").run(failed ? "failed" : "succeeded", json, hash(json), now(), bindingId, callId);
    this.deliver(ws, this.journal.prepare("SELECT * FROM node_calls WHERE binding_id=? AND call_id=?").get(bindingId, callId)!);
    this.changed();
  }
  /** Answers a call that never reached the journal; Core fails it immediately instead of timing out. */
  refuse(ws: WebSocket, callId: string, argumentHash: string, error: string) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const result = { error, rejected: true, outcome: "confirmed_not_executed" };
    ws.send(JSON.stringify({ type: "result", callId, argumentHash, resultHash: hash(JSON.stringify(result)), result, failed: true }));
  }
  deliver(ws: WebSocket, row: Record<string, unknown>) {
    // An owned operation can finish after its transport reconnects. Deliver
    // the durable receipt to the current socket only for the same binding.
    if (this.socket && ws !== this.socket && this.binding && row.binding_id === this.binding.coreId + ":" + this.binding.deviceId) ws = this.socket;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (row.status === "unknown") ws.send(JSON.stringify({ type: "unknown", callId: row.call_id }));
    else if (row.result_json) ws.send(JSON.stringify({ type: "result", callId: row.call_id, argumentHash: row.argument_hash, resultHash: row.result_hash, result: JSON.parse(String(row.result_json)), failed: row.status === "failed" }));
  }
  command(command: string, root: string, timeout: number, signal?: AbortSignal): Promise<unknown> {
    // Terminal authority is explicit and covers all OS rights of this user;
    // cwd is convenience, never described as a shell security sandbox.
    return new Promise((resolve) => {
      if (signal?.aborted) { resolve({ error: "用户停止了终端执行", cancelled: true }); return; }
      const child = process.platform === "win32" ? spawn("powershell.exe", ["-NoLogo", "-NonInteractive", "-NoProfile", "-Command", command], { cwd: root, windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP } }) : spawn("/bin/sh", ["-c", command], { cwd: root, detached: true, env: { PATH: process.env.PATH } });
      this.commands.add(child);
      let stdout = "", stderr = "", timedOut = false, cancelled = false;
      const kill = () => stopOwnedCommand(child);
      const abort = () => { cancelled = true; kill(); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on("data", (data: Buffer) => { stdout = (stdout + data.toString()).slice(0, 50_000); });
      child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(0, 10_000); });
      const timer = setTimeout(() => { timedOut = true; kill(); }, Math.max(1, timeout));
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.commands.delete(child); };
      child.once("error", (e) => { cleanup(); resolve({ error: e.message }); });
      child.once("close", (code) => { cleanup(); resolve({ stdout, stderr, code, timedOut, ...(cancelled ? { cancelled: true, error: "用户停止了终端执行" } : {}) }); });
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
    this.activeCall?.controller.abort();
    for (const child of this.commands) stopOwnedCommand(child);
    await Promise.allSettled(this.operations); await this.computer.close(); this.journal.close();
  }
}
