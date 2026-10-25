import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/** Refresh the login when it has this long left, as the Apple and Android clients do. */
export const REFRESH_LEAD_MS = 30 * 60_000;

// Only a rejected login stops this computer's executor; a network or server
// hiccup keeps it running and the next check retries.
const loginRejected = (error) => error?.status === 401 || error?.status === 403;
const rejected = (message) => Object.assign(new Error(message), { status: 401 });

export function consentScope(session) {
  return createHash("sha256").update(JSON.stringify([session.origin, session.coreId, session.workspaceId || session.sessionId])).digest("hex");
}

// The controller holds credentials in the main process. Renderers receive only
// public state and cannot select a Core, token, device identity or command.
export class ClientDevice {
  // `sessionRefreshed` opts in to refreshing the login here; it must save the
  // rotated token, because the old one stops working. Hosts that refresh the
  // login themselves leave it out so two refreshers never rotate each other out.
  constructor({ directory, safeStorage, request, createNode, changed = () => {}, interval = 15_000, sessionRefreshed }) {
    Object.assign(this, { directory, safeStorage, request, createNode, changed, interval, sessionRefreshed });
    this.generation = 0; this.queue = Promise.resolve(); this.status = "未连接"; this.refreshAfter = 0;
  }
  enqueue(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  state() {
    const local = this.runtime?.node.publicState();
    return { available: true, name: this.session?.name ?? "此电脑", status: this.error || local?.status || this.status,
      connected: !!local?.connected, deviceId: local?.deviceId || this.record?.deviceId || "",
      authorized: !!this.consent?.allowed, paused: !!this.consent?.paused,
      root: this.record?.root || "", exec: !!this.record?.exec, computer: !!this.record?.computer,
      computerSupported: this.runtime?.node.computer.available() ?? process.platform === "win32",
      unknownCalls: local?.unknownCalls ?? [] };
  }
  read(file) { return JSON.parse(this.safeStorage.decryptString(readFileSync(file))); }
  write(file, value) { writeFileSync(file, this.safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 }); }
  valid(epoch) { return epoch === this.generation && !!this.session; }
  async closeRuntime() { const runtime = this.runtime; this.runtime = undefined; if (runtime) await runtime.close(); }
  async verify(session) {
    if (session.expiresAt <= Date.now()) throw rejected("登录已过期");
    const result = await this.request(session.origin, "/api/session", { token: session.token });
    if (!result.authenticated || result.sessionId !== session.sessionId || result.coreId !== session.coreId) throw rejected("登录已失效");
  }
  async refreshSession(epoch) {
    const session = this.session, at = Date.now();
    if (!this.sessionRefreshed || !this.valid(epoch) || session.expiresAt - at > REFRESH_LEAD_MS || at < this.refreshAfter) return;
    // A failed refresh keeps the current token; retry at most once a minute until it expires.
    this.refreshAfter = at + 60_000;
    let next;
    try { next = await this.request(session.origin, "/api/auth/refresh", {}, session.token); } catch { return; }
    if (typeof next?.token !== "string" || !next.token || next.sessionId !== session.sessionId || next.coreId !== session.coreId || !(next.expiresAt > Date.now())) return;
    if (this.session === session) this.session = { ...session, token: next.token, expiresAt: next.expiresAt };
    // Save the rotated token even if this login stopped meanwhile: the old one is already dead.
    try { await this.sessionRefreshed(next); } catch {}
  }
  start(session) {
    const epoch = ++this.generation;
    clearTimeout(this.timer);
    this.session = { ...session }; this.error = ""; this.status = "正在连接此电脑";
    return this.enqueue(async () => {
      await this.closeRuntime();
      if (!this.valid(epoch)) return;
      this.consent = undefined; this.record = undefined;
      try { await this.connect(epoch); } catch { this.error = "此电脑连接失败，正在重试"; await this.closeRuntime(); }
      if (this.valid(epoch)) { this.changed(); this.schedule(epoch); }
    });
  }
  async connect(epoch) {
    const session = this.session;
    await this.verify(session);
    if (!this.valid(epoch)) return;
    const state = await this.request(session.origin, "/api/state", undefined, session.token);
    if (!this.valid(epoch)) return;
    // The authenticated snapshot has a persistent per-workspace Core ID.
    // Public service IDs and display names are shared and cannot scope consent.
    this.consentFile = path.join(this.directory, `consent-${consentScope({ ...session, workspaceId: state.sync?.coreId })}.bin`);
    this.consent = existsSync(this.consentFile) ? this.read(this.consentFile) : undefined;
    this.useFolder(session, state.sync?.coreId);
    if (this.record && !state.devices.some(d => d.id === this.record.deviceId && d.status === "bound")) {
      // Within one login, revocation must not be undone by silently
      // registering a replacement. A new login may register this computer again.
      if (!this.record.sessionId || this.record.sessionId === session.sessionId) { this.error = "此电脑已被撤销，请重新登录后连接"; return; }
      this.record = undefined;
    }
    if (!this.record) {
      const pair = await this.request(session.origin, "/api/devices", { name: session.name }, session.token);
      if (!this.valid(epoch)) {
        await this.request(session.origin, "/api/devices/revoke", { id: pair.deviceId }, session.token).catch(() => {}); return;
      }
      this.record = { deviceId: pair.deviceId, token: pair.token, sessionId: session.sessionId, root: "", exec: false, computer: false };
      this.write(this.recordFile, this.record);
    }
    // Login enables this device. Migrate old declined grants, retaining an
    // explicit pause for this workspace across updates and fresh logins.
    if (!this.consent?.allowed) {
      this.consent = { allowed: true, paused: this.consent?.paused === true };
      this.write(this.consentFile, this.consent);
    }
    if (this.consent.paused) { this.status = "已暂停控制"; this.error = ""; return; }
    const keyFile = path.join(this.folder, "key.bin");
    const key = existsSync(keyFile) ? Buffer.from(this.read(keyFile), "base64") : randomBytes(32);
    if (!existsSync(keyFile)) this.write(keyFile, key.toString("base64"));
    this.runtime = this.createNode(this.folder, key, this.changed, session.origin, { autoConnect: false });
    this.record = { ...this.record, sessionId: session.sessionId, root: this.consent.allowed ? os.homedir() : "", exec: this.consent.allowed, computer: this.consent.allowed && this.runtime.node.computer.available() };
    this.write(this.recordFile, this.record);
    this.runtime.node.configure({ ...this.record, origin: session.origin, computer: this.record.computer && this.runtime.node.computer.available() });
    this.error = "";
  }
  /**
   * One device identity per computer and account workspace, so signing in
   * again keeps the same device instead of leaving the old one offline.
   * Older Cores without a workspace ID keep the per-login scope.
   */
  useFolder(session, workspaceId) {
    const scope = (parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
    const legacy = path.join(this.directory, scope([session.origin, session.coreId, session.sessionId]));
    this.folder = workspaceId ? path.join(this.directory, scope([session.origin, session.coreId, "workspace", workspaceId])) : legacy;
    // Carry this login's existing device over once instead of registering a new one.
    if (this.folder !== legacy && !existsSync(this.folder) && existsSync(path.join(legacy, "binding.bin"))) renameSync(legacy, this.folder);
    mkdirSync(this.folder, { recursive: true });
    this.recordFile = path.join(this.folder, "binding.bin");
    this.record = existsSync(this.recordFile) ? this.read(this.recordFile) : undefined;
  }
  schedule(epoch) {
    this.timer = setTimeout(() => {
      void this.enqueue(async () => {
        if (!this.valid(epoch)) return;
        try {
          await this.refreshSession(epoch);
          if (!this.valid(epoch)) return;
          await this.verify(this.session);
          if (!this.valid(epoch)) return;
          if (!this.runtime) await this.connect(epoch);
          this.error = this.runtime ? "" : this.error;
        } catch (error) {
          if (loginRejected(error)) { await this.closeRuntime(); this.error = "登录已失效，已暂停本机操作"; }
          else if (!this.runtime) this.error = "网络暂不可用，正在重试";
        }
        if (this.valid(epoch)) { this.changed(); this.schedule(epoch); }
      });
    }, this.interval);
    this.timer.unref?.();
  }
  configure(update) {
    const epoch = this.generation;
    return this.enqueue(async () => {
      if (!this.valid(epoch) || !this.runtime) throw new Error("请等待此电脑连接后重试");
      try { await this.verify(this.session); }
      catch (error) {
        if (!loginRejected(error)) throw new Error("网络暂不可用，请稍后重试");
        await this.closeRuntime(); this.error = "登录已失效，已暂停本机操作"; this.changed(); throw new Error(this.error);
      }
      if (!this.valid(epoch) || !this.runtime) throw new Error("登录已变化");
      const next = { ...this.record, ...update };
      this.runtime.node.configure({ ...next, origin: this.session.origin });
      this.record = next; this.write(this.recordFile, next); this.changed(); return this.state();
    });
  }
  setPaused(paused) {
    const epoch = this.generation;
    // Stop immediately, including a command that is currently running.
    const closing = paused ? this.closeRuntime() : Promise.resolve();
    return this.enqueue(async () => {
      await closing;
      if (paused) await this.closeRuntime();
      if (!this.valid(epoch) || !this.consent) throw new Error("请等待此电脑完成登录");
      if (!paused) {
        await this.verify(this.session);
        if (!this.valid(epoch)) throw new Error("登录已变化");

      }
      this.consent.paused = paused; this.write(this.consentFile, this.consent);
      this.status = paused ? "已暂停控制" : "正在连接此电脑"; this.error = "";
      if (!paused) { await this.closeRuntime(); await this.connect(epoch); }
      this.changed(); return this.state();
    });
  }
  reconcile(callId, version) {
    return this.enqueue(async () => {
      if (!this.runtime) throw new Error("此电脑未连接");
      this.runtime.node.reconcile(callId, version); return this.state();
    });
  }
  stop({ revoke = false } = {}) {
    ++this.generation; clearTimeout(this.timer);
    const session = this.session;
    this.session = undefined;
    // Cut off new input immediately, even while an earlier network check waits.
    const closing = this.closeRuntime();
    return this.enqueue(async () => {
      await closing;
      if (revoke && session && this.record) await this.request(session.origin, "/api/devices/revoke", { id: this.record.deviceId }, session.token).catch(() => {});
      this.record = undefined; this.consent = undefined; this.status = "未连接"; this.error = ""; this.changed();
    });
  }
}
