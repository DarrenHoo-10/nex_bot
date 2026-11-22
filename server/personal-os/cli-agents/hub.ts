/* oxlint-disable unicorn/no-useless-spread -- the copies are deliberate: listeners and entries remove themselves while a loop runs over the collection */
// Agent mode hub: what Core knows about terminal coding-agent sessions on the
// user's devices. Devices push session rows and transcript items over the DCP
// link (`cli.*`); browsers read them through the stream (stream.ts) and the
// HTTP routes (routes.ts). Core is a cache and a router: the device is the
// authority, so a failed device answer is never papered over with cached data
// except for read-only history pages.
//
// Plan: docs/plans/2026-11-15-agent-mode-implementation.md sections 2, 4, 5.
import {
  CLI_ATTACH_MAX_BYTES,
  CLI_ERROR_CODES,
  CLI_ERROR_TEXT,
  CLI_LIMITS,
  CLI_OUTDATED_TEXT,
  CLI_OP_MUTATING,
  CLI_OP_TIMEOUT_MS,
  CORE_ITEM_CACHE,
  completedCliReplies,
  CORE_STREAM_BUFFER_MAX,
  FRAME_PAYLOAD_MAX,
  PAGE_SIZE,
  cliKey,
  cliRef,
  hasCliFeature,
  parseCliKey,
  parseCliOpArgs,
  parseCliOpResult,
  parseDeviceCliMessage,
  type CliAgentsCapability,
  type CliDeviceView,
  type CliEngine,
  type CliErrorCode,
  type CliGitInfo,
  type CliItem,
  type CliLaunchOptions,
  type CliModelCatalog,
  type CliContextUsage,
  type CliDirListing,
  type CliFeature,
  type CliOp,
  type CliOpArgs,
  type CliOpResult,
  type CliRequestQuestion,
  type CliRequestResolvedBy,
  type CliRequestView,
  type CliQueueView,
  type CliSendVia,
  type CliSessionKey,
  type CliSessionRef,
  type CliWorkbenchSessionView,
  type CliSessionView,
  type CliSessionWire,
  type CliTurnReason,
  type DeviceCliMessage,
  type CoreCliMessage,
  type ServerMessage,
} from "../../../shared/cli-agents.ts";
import { TERM_INPUT, TERM_OUTPUT, decodeTermFrame, encodeTermFrame } from "../../../shared/cli-agent-frames.ts";
import { id, now, type CoreStore, type Row } from "../store.ts";

/** What the hub needs from the device gateway. Both throw a CliOpError-like
 * error with `code = "device_offline"` when the device has no usable link. */
export interface CliLink {
  sendCli(deviceId: string, message: CoreCliMessage): void;
  sendCliBinary(deviceId: string, frame: Uint8Array): void;
}

export interface CliHubTuning {
  /** Overrides every per-op timeout (tests). */
  opTimeoutMs?: number;
  /** Extra time Core waits past the deadline it gave the device. */
  graceMs: number;
  /** Bytes of terminal output queued for one browser before the stream is dropped. */
  streamBufferMax: number;
  /** How long a terminal open may wait for the device. */
  streamOpenMs: number;
  /** How often pending requests past their expiry are closed. */
  requestSweepMs: number;
}

/** A turn that ended on a device, as the supervisor and other listeners see it. */
export interface CliTurnEvent {
  key: CliSessionKey;
  deviceId: string;
  turn: number;
  endedAt: number;
  reason: CliTurnReason;
  error?: string;
}

/** What the Git card says when the computer runs an executor without the `git` op. */
export const GIT_UNSUPPORTED = "电脑端版本过旧，升级后可查看更改";
export const FORK_UNSUPPORTED = "电脑端版本过旧，升级后可分叉会话";

export class CliOpError extends Error {
  constructor(
    readonly code: CliErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** A `cli.op` that reached the device and then failed: the operation id rides
 * along, so the outbox can reconcile the entry against the op row. */
export class TrackedOpError extends Error {
  constructor(
    readonly opId: string,
    readonly error: CliOpError,
  ) {
    super(error.message);
  }
}

export type ListDelta = { upserts: CliSessionView[]; removes: CliSessionKey[]; devices?: CliDeviceView[] };

/** One browser socket as the hub sees it. `data` gets a complete binary frame
 * addressed with the browser sid and calls `done` once it has left the socket. */
export interface StreamSink {
  readonly sessionId: string;
  opened(req: string, sid: number, cols: number, rows: number, observe: boolean): void;
  size(sid: number, cols: number, rows: number): void;
  closed(sid: number, reason: string): void;
  error(code: CliErrorCode, req?: string, message?: string): void;
  data(frame: Uint8Array, done: () => void): void;
}

interface Pending {
  opId: string;
  deviceId: string;
  op: CliOp;
  sessionKey: string | null;
  resolve(value: unknown): void;
  reject(error: CliOpError): void;
  timer: NodeJS.Timeout;
}

interface StreamEntry {
  browserSid: number;
  deviceSid: number;
  deviceId: string;
  key: string;
  req: string;
  sink: StreamSink;
  observe: boolean;
  opened: boolean;
  /** payload bytes received from the device */
  forwarded: number;
  /** payload bytes the browser has credited back */
  credited: number;
  /** frame bytes handed to the browser socket and not yet flushed */
  queued: number;
  openTimer: NodeJS.Timeout | null;
}

export const MAX_STREAMS_PER_SINK = 8;
const OPS_RETENTION_MS = 7 * 86_400_000;
/** A request never stays pending longer than this, whatever the device claims. */
const MAX_REQUEST_MS = 2 * 3_600_000;
const SESSION_COLUMNS = [
  "device_id", "engine", "native_id", "config_dir", "cwd", "title", "git_branch", "state", "waiting_for",
  "live_in", "terminal", "model", "cli_version", "last_activity_at",
] as const;

const asKey = (value: string) => value as CliSessionKey;

/** Requests Core itself raises for a session (the supervisor's decision cards) carry a tool name with this prefix.
 * They never reach the device: an answer goes to the handler set with onCoreAnswer, not to the hook. */
export const CORE_REQUEST_PREFIX = "nexbot:";
export type CoreAnswerHandler = (request: CliRequestView, decision: "allow" | "deny", answers: Record<string, string> | undefined, actor: string) => Promise<{ outcome: string }>;

/** The workbench module answers this for the hub: which outbox belongs to a
 * native session key, so a browser that just subscribed gets the queue too. */
export interface WorkbenchSink {
  queueForSessionKey(key: string): CliQueueView | null;
}

export class CliAgentHub {
  readonly tuning: CliHubTuning;
  private readonly caps = new Map<string, CliAgentsCapability>();
  /** the last capability an offline device reported, for the device list */
  private readonly lastCaps = new Map<string, CliAgentsCapability>();
  private readonly seqs = new Map<string, number>();
  /** Codex `writerUnknown` has no column: it lives and dies with the connection. */
  private readonly writerUnknown = new Set<string>();
  /** `sendVia` has no column either: the device reports it again on every connection. */
  private readonly sendVia = new Map<string, CliSendVia>();
  /** `repoRoot` and `forkOf` have no column either (no migration): same lifetime as `sendVia`. */
  private readonly placement = new Map<string, { repoRoot?: string; forkOf?: string; sideOf?: string }>();
  /** what each session's last request carried; it changes every turn, so it is kept here and not in the table */
  private readonly contexts = new Map<string, CliContextUsage>();
  private readonly pending = new Map<string, Pending>();
  private readonly busyKeys = new Set<string>();
  private readonly watchers = new Map<string, Set<(message: ServerMessage) => void>>();
  private readonly listListeners = new Set<(delta: ListDelta) => void>();
  private readonly summaryListeners = new Set<(summary: { waiting: number; running: number }) => void>();
  private lastSummary = { waiting: 0, running: 0 };
  private readonly requestListeners = new Set<(message: ServerMessage) => void>();
  private readonly turnListeners = new Set<(event: CliTurnEvent) => void>();
  private readonly deviceOnlineListeners = new Set<(deviceId: string) => void>();
  /** Set by the workbench module; queue snapshots ride on session subscribes. */
  workbench: WorkbenchSink | null = null;
  private coreAnswer: CoreAnswerHandler | null = null;
  private readonly queueListeners = new Set<(message: ServerMessage) => void>();
  private readonly workbenchListeners = new Set<(message: ServerMessage) => void>();
  private readonly lastTurns = new Map<string, CliTurnEvent>();
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly byBrowser = new Map<number, StreamEntry>();
  private readonly byDevice = new Map<string, Map<number, StreamEntry>>();
  private nextBrowserSid = 1;
  private nextDeviceSid = 1;
  private readonly pruneTimer: NodeJS.Timeout;
  private closed = false;
  /** Invalid `cli.*` payloads from capable devices; they are dropped, not fatal. */
  invalidMessages = 0;
  /** Exceptions while handling a valid message (a Core bug, not the device's fault): swallowed so the device's other calls keep working. */
  internalErrors = 0;

  constructor(
    readonly store: CoreStore,
    readonly link: CliLink,
    readonly changed: () => void,
    tuning: Partial<CliHubTuning> = {},
  ) {
    this.tuning = { graceMs: 1000, streamBufferMax: CORE_STREAM_BUFFER_MAX, streamOpenMs: 15_000, requestSweepMs: 30_000, ...tuning };
    // A restart loses every in-flight answer; the device may or may not have acted.
    store.run("UPDATE cli_agent_ops SET status='unknown',finished_at=? WHERE status='sent'", now());
    this.prune();
    this.pruneTimer = setInterval(() => this.prune(), 3_600_000);
    this.pruneTimer.unref();
    this.sweepTimer = setInterval(() => this.expireRequests(), this.tuning.requestSweepMs);
    this.sweepTimer.unref();
  }

  private prune() {
    this.store.run("DELETE FROM cli_agent_ops WHERE created_at<?", now() - OPS_RETENTION_MS);
    this.store.run("DELETE FROM cli_agent_requests WHERE status!='pending' AND created_at<?", now() - OPS_RETENTION_MS);
  }

  close() {
    this.closed = true;
    clearInterval(this.pruneTimer);
    clearInterval(this.sweepTimer);
    for (const pending of [...this.pending.values()]) this.settleUnknown(pending, "unknown", "Core shutting down");
    for (const entry of [...this.byBrowser.values()]) {
      this.removeEntry(entry);
      entry.sink.closed(entry.browserSid, "closed");
    }
    this.watchers.clear();
    this.listListeners.clear();
    this.summaryListeners.clear();
    this.requestListeners.clear();
    this.turnListeners.clear();
    this.coreAnswer = null;
  }

  // -------------------------------------------------------------------------
  // Device lifecycle (called by the gateway)

  deviceOnline(deviceId: string, cap: CliAgentsCapability | null) {
    if (this.closed) return;
    if (!cap) { this.deviceOffline(deviceId); return; }
    this.caps.set(deviceId, cap);
    this.lastCaps.set(deviceId, cap);
    this.seqs.delete(deviceId);
    try { this.link.sendCli(deviceId, { type: "cli.resync" }); } catch { /* the link dropped again; the offline path cleans up */ }
    for (const key of this.watchers.keys()) {
      const parsed = parseCliKey(key);
      if (parsed?.deviceId === deviceId) this.watchOp("watch", key);
    }
    this.emitDeviceDelta(deviceId);
    this.refreshSummary();
    for (const listener of [...this.deviceOnlineListeners]) {
      try { listener(deviceId); } catch { /* a broken listener must not stop the others */ }
    }
  }

  deviceOffline(deviceId: string) {
    if (this.closed) return;
    const wasOnline = this.caps.delete(deviceId);
    this.seqs.delete(deviceId);
    for (const key of [...this.writerUnknown]) if (key.startsWith(deviceId + ":")) this.writerUnknown.delete(key);
    for (const key of [...this.sendVia.keys()]) if (key.startsWith(deviceId + ":")) this.sendVia.delete(key);
    for (const key of [...this.placement.keys()]) if (key.startsWith(deviceId + ":")) this.placement.delete(key);
    for (const key of [...this.contexts.keys()]) if (key.startsWith(deviceId + ":")) this.contexts.delete(key);
    for (const pending of [...this.pending.values()]) {
      if (pending.deviceId !== deviceId) continue;
      // A write may have reached the device: its outcome is unknown, never "failed".
      if (CLI_OP_MUTATING.has(pending.op)) this.settleUnknown(pending, "unknown", "device link dropped");
      else this.settleUnknown(pending, "device_offline");
    }
    for (const entry of [...(this.byDevice.get(deviceId)?.values() ?? [])]) {
      this.removeEntry(entry);
      entry.sink.closed(entry.browserSid, "device_offline");
    }
    if (wasOnline) {
      this.emitDeviceDelta(deviceId);
      this.refreshSummary();
    }
  }

  deviceRevoked(deviceId: string) {
    if (this.closed) return;
    this.deviceOffline(deviceId);
    this.lastCaps.delete(deviceId);
    const removes = this.store.all("SELECT key FROM cli_agent_sessions WHERE device_id=?", deviceId).map((row) => asKey(String(row.key)));
    for (const key of [...this.lastTurns.keys()]) if (key.startsWith(deviceId + ":")) this.lastTurns.delete(key);
    for (const row of this.store.all("SELECT DISTINCT session_key FROM cli_agent_requests WHERE substr(session_key,1,?)=? AND status='pending'", deviceId.length + 1, deviceId + ":")) {
      this.resolveRequests(asKey(String(row.session_key)), "gone");
    }
    this.store.transaction(() => {
      this.store.run("DELETE FROM cli_agent_sessions WHERE device_id=?", deviceId);
      this.store.run("DELETE FROM cli_agent_ops WHERE device_id=?", deviceId);
      this.store.run("DELETE FROM cli_agent_requests WHERE substr(session_key,1,?)=?", deviceId.length + 1, deviceId + ":");
    });
    if (removes.length) this.emitList({ upserts: [], removes });
    this.refreshSummary();
  }

  // -------------------------------------------------------------------------
  // Device -> Core

  fromDevice(deviceId: string, raw: unknown) {
    if (this.closed || !this.caps.has(deviceId)) return;
    const message = parseDeviceCliMessage(raw);
    if (!message) { this.invalidMessages++; return; }
    try { this.dispatch(deviceId, message); } catch { this.internalErrors++; }
  }

  private dispatch(deviceId: string, message: DeviceCliMessage) {
    switch (message.type) {
      case "cli.sessions": this.onSessions(deviceId, message); break;
      case "cli.items": this.onItems(deviceId, message); break;
      case "cli.reply": this.onReply(deviceId, message); break;
      case "cli.turn": this.onTurn(deviceId, message); break;
      case "cli.request": this.onRequest(deviceId, message); break;
      case "cli.request.resolved": this.onRequestResolved(deviceId, message); break;
      case "cli.term.opened": {
        const entry = this.byDevice.get(deviceId)?.get(message.sid);
        if (!entry || entry.opened) break;
        entry.opened = true;
        if (entry.openTimer) { clearTimeout(entry.openTimer); entry.openTimer = null; }
        entry.observe = message.observe;
        entry.sink.opened(entry.req, entry.browserSid, message.cols, message.rows, message.observe);
        break;
      }
      case "cli.term.size": {
        const entry = this.byDevice.get(deviceId)?.get(message.sid);
        if (entry) entry.sink.size(entry.browserSid, message.cols, message.rows);
        break;
      }
      case "cli.term.closed": {
        const entry = this.byDevice.get(deviceId)?.get(message.sid);
        if (!entry) break;
        this.removeEntry(entry);
        entry.sink.closed(entry.browserSid, message.reason);
        break;
      }
      case "cli.term.error": {
        const entry = this.byDevice.get(deviceId)?.get(message.sid);
        if (!entry) break;
        if (!entry.opened) {
          this.removeEntry(entry);
          entry.sink.error(message.code, entry.req);
        } else entry.sink.error(message.code, undefined, `sid ${entry.browserSid}`);
        break;
      }
    }
  }

  fromDeviceBinary(deviceId: string, bytes: Uint8Array) {
    if (this.closed || !this.caps.has(deviceId)) return;
    const frame = decodeTermFrame(bytes);
    if (!frame || frame.type !== TERM_OUTPUT) { this.invalidMessages++; return; }
    const entry = this.byDevice.get(deviceId)?.get(frame.sid);
    if (!entry) return;
    const out = encodeTermFrame(TERM_OUTPUT, entry.browserSid, frame.payload);
    entry.forwarded += frame.payload.length;
    entry.queued += out.length;
    if (entry.queued > this.tuning.streamBufferMax) { this.overflow(entry); return; }
    entry.sink.data(out, () => { entry.queued = Math.max(0, entry.queued - out.length); });
    // sink.data may have been synchronous and the sink may have just failed; re-check the bound
    if (entry.queued > this.tuning.streamBufferMax) this.overflow(entry);
  }

  private overflow(entry: StreamEntry) {
    if (!this.byBrowser.has(entry.browserSid)) return;
    this.removeEntry(entry);
    this.tryCloseOnDevice(entry);
    entry.sink.closed(entry.browserSid, "overflow");
  }

  private sessionRow(key: string): Row | undefined {
    return this.store.get("SELECT * FROM cli_agent_sessions WHERE key=?", key);
  }

  private onSessions(deviceId: string, message: Extract<DeviceCliMessage, { type: "cli.sessions" }>) {
    const last = this.seqs.get(deviceId);
    if (!message.full && last !== undefined && message.seq <= last) return;
    this.seqs.set(deviceId, message.seq);
    const upserts: CliSessionKey[] = [], removes: CliSessionKey[] = [];
    this.store.transaction(() => {
      const existing = new Map<string, Row>();
      for (const row of this.store.all("SELECT * FROM cli_agent_sessions WHERE device_id=?", deviceId)) existing.set(String(row.key), row);
      const seen = new Set<string>();
      for (const wire of message.upserts) {
        const key = cliKey(deviceId, cliRef(wire.engine, wire.nativeId));
        seen.add(key);
        const unknown = wire.writerUnknown === true;
        const unknownChanged = unknown !== this.writerUnknown.has(key);
        if (unknown) this.writerUnknown.add(key); else this.writerUnknown.delete(key);
        const via = this.sendVia.get(key);
        const viaChanged = via !== wire.sendVia;
        if (wire.sendVia) this.sendVia.set(key, wire.sendVia); else this.sendVia.delete(key);
        const place = this.placement.get(key);
        const placeChanged = place?.repoRoot !== wire.repoRoot || place?.forkOf !== wire.forkOf || place?.sideOf !== wire.sideOf;
        if (wire.repoRoot || wire.forkOf || wire.sideOf) this.placement.set(key, { ...(wire.repoRoot ? { repoRoot: wire.repoRoot } : {}), ...(wire.forkOf ? { forkOf: wire.forkOf } : {}), ...(wire.sideOf ? { sideOf: wire.sideOf } : {}) });
        else this.placement.delete(key);
        const context = this.contexts.get(key);
        const contextChanged = context?.used !== wire.context?.used || context?.window !== wire.context?.window;
        if (wire.context) this.contexts.set(key, wire.context); else this.contexts.delete(key);
        const values = this.columnsOf(deviceId, wire);
        const previous = existing.get(key);
        if (!previous) {
          this.store.insert("cli_agent_sessions", { key, ...values, hidden: 0, first_seen_at: now(), updated_at: now() });
          upserts.push(key);
        } else if (SESSION_COLUMNS.some((column) => (previous[column] ?? null) !== values[column]) || unknownChanged || viaChanged || placeChanged || contextChanged) {
          this.store.run(
            `UPDATE cli_agent_sessions SET ${SESSION_COLUMNS.map((column) => `${column}=?`).join(",")},updated_at=? WHERE key=?`,
            ...SESSION_COLUMNS.map((column) => values[column]), now(), key,
          );
          upserts.push(key);
        }
      }
      if (message.full) {
        for (const key of existing.keys()) if (!seen.has(key)) removes.push(asKey(key));
      }
      for (const ref of message.removes) {
        const key = cliKey(deviceId, ref);
        if (existing.has(key) && !removes.includes(asKey(key))) removes.push(asKey(key));
      }
      for (const key of removes) { this.store.run("DELETE FROM cli_agent_sessions WHERE key=?", key); this.writerUnknown.delete(key); this.sendVia.delete(key); this.placement.delete(key); this.contexts.delete(key); }
    });
    for (const key of removes) { this.lastTurns.delete(key); this.resolveRequests(key, "gone"); }
    const views = upserts.map((key) => this.viewOf(key)).filter((view): view is CliSessionView => view !== null);
    if (views.length || removes.length) this.emitList({ upserts: views, removes });
    this.refreshSummary();
  }

  private columnsOf(deviceId: string, wire: CliSessionWire) {
    return {
      device_id: deviceId,
      engine: wire.engine,
      native_id: wire.nativeId,
      config_dir: wire.configDir,
      cwd: wire.cwd,
      title: wire.title,
      git_branch: wire.gitBranch ?? null,
      state: wire.state,
      waiting_for: wire.waitingFor ?? null,
      live_in: wire.liveIn ?? null,
      terminal: wire.terminal ?? null,
      model: wire.model ?? null,
      cli_version: wire.cliVersion ?? null,
      last_activity_at: wire.lastActivityAt,
    };
  }

  private onItems(deviceId: string, message: Extract<DeviceCliMessage, { type: "cli.items" }>) {
    const key = cliKey(deviceId, message.ref);
    if (!this.sessionRow(key)) return;
    this.cacheItems(key, message.items, message.reset === true);
    this.notify(key, { type: "items", key: asKey(key), items: message.items, ...(message.reset ? { reset: true } : {}), ...(message.more ? { more: true } : {}) });
  }

  /** Items are encrypted at rest; the cache keeps the newest CORE_ITEM_CACHE per session. */
  private cacheItems(key: string, items: CliItem[], reset: boolean) {
    this.store.transaction(() => {
      if (reset) this.store.run("DELETE FROM cli_agent_items WHERE session_key=?", key);
      for (const item of items) {
        this.store.run(
          "INSERT INTO cli_agent_items(session_key,item_id,ts,body) VALUES(?,?,?,?) ON CONFLICT(session_key,item_id) DO UPDATE SET ts=excluded.ts,body=excluded.body",
          key, item.id, item.ts, this.store.encrypt(JSON.stringify(item)),
        );
      }
      this.store.run(
        "DELETE FROM cli_agent_items WHERE session_key=? AND rowid NOT IN (SELECT rowid FROM cli_agent_items WHERE session_key=? ORDER BY ts DESC,rowid DESC LIMIT ?)",
        key, key, CORE_ITEM_CACHE,
      );
    });
  }

  private cachedPage(key: string, before?: string): { items: CliItem[]; more: boolean } {
    let boundary: { ts: number; rowid: number } | null = null;
    if (before !== undefined) {
      const row = this.store.get("SELECT ts,rowid FROM cli_agent_items WHERE session_key=? AND item_id=?", key, before);
      if (!row) return { items: [], more: false };
      boundary = { ts: Number(row.ts), rowid: Number(row.rowid) };
    }
    const where = boundary ? "AND (ts<? OR (ts=? AND rowid<?))" : "";
    const args = boundary ? [boundary.ts, boundary.ts, boundary.rowid] : [];
    const rows = this.store.all(`SELECT body FROM cli_agent_items WHERE session_key=? ${where} ORDER BY ts DESC,rowid DESC LIMIT ?`, key, ...args, PAGE_SIZE + 1);
    const more = rows.length > PAGE_SIZE;
    const items = rows.slice(0, PAGE_SIZE).reverse().map((row) => JSON.parse(this.store.decrypt(String(row.body))) as CliItem);
    return { items, more };
  }

  // -------------------------------------------------------------------------
  // Turn ends and pending requests

  private onTurn(deviceId: string, message: Extract<DeviceCliMessage, { type: "cli.turn" }>) {
    const key = asKey(cliKey(deviceId, message.ref));
    const event: CliTurnEvent = {
      key, deviceId, turn: message.turn, endedAt: message.endedAt, reason: message.reason,
      ...(message.error !== undefined ? { error: message.error } : {}),
    };
    const last = this.lastTurns.get(key);
    // The device may repeat a turn after a resync; listeners see it once.
    if (last && last.turn === event.turn && last.endedAt === event.endedAt) return;
    this.lastTurns.set(key, event);
    for (const listener of [...this.turnListeners]) {
      try { listener(event); } catch { /* a broken listener must not stop the others */ }
    }
  }

  private onRequest(deviceId: string, message: Extract<DeviceCliMessage, { type: "cli.request" }>) {
    const key = cliKey(deviceId, message.ref);
    const at = now();
    const expiresAt = Math.min(message.expiresAt, at + MAX_REQUEST_MS);
    if (expiresAt <= at) return;
    const existing = this.store.get("SELECT session_key FROM cli_agent_requests WHERE id=?", message.id);
    // A repeat is harmless; an id that belongs to another session is not ours to take over.
    if (existing) { if (existing.session_key !== key) this.invalidMessages++; return; }
    const pending = Number(this.store.get("SELECT COUNT(*) n FROM cli_agent_requests WHERE session_key=? AND status='pending'", key)?.n ?? 0);
    if (pending >= CLI_LIMITS.requestsPerSession) return;
    const extra = message.options !== undefined || message.questions !== undefined
      ? this.store.encrypt(JSON.stringify({ ...(message.options !== undefined ? { options: message.options } : {}), ...(message.questions !== undefined ? { questions: message.questions } : {}) }))
      : null;
    this.store.insert("cli_agent_requests", {
      id: message.id, session_key: key, kind: message.kind, tool: message.tool,
      summary_json: this.store.encrypt(JSON.stringify({ summary: message.summary })), options_json: extra,
      status: "pending", decided_by: null, decision_json: null, created_at: at, expires_at: expiresAt,
    });
    this.emitRequests(key);
    this.refreshSummary();
  }

  private onRequestResolved(deviceId: string, message: Extract<DeviceCliMessage, { type: "cli.request.resolved" }>) {
    const row = this.store.get("SELECT session_key,status FROM cli_agent_requests WHERE id=?", message.id);
    if (!row || row.status !== "pending" || parseCliKey(String(row.session_key))?.deviceId !== deviceId) return;
    this.closeRequest(message.id, String(row.session_key), "resolved", message.by);
  }

  /** Closes one pending request and tells the browsers; the first closer wins. */
  private closeRequest(requestId: string, key: string, status: "resolved" | "expired", by: CliRequestResolvedBy): boolean {
    const changes = Number(this.store.run("UPDATE cli_agent_requests SET status=?,decided_by=? WHERE id=? AND status='pending'", status, by, requestId).changes);
    if (!changes) return false;
    this.emitRequestResolved(asKey(key), requestId, by);
    this.refreshSummary();
    return true;
  }

  private resolveRequests(key: string, by: CliRequestResolvedBy) {
    for (const row of this.store.all("SELECT id FROM cli_agent_requests WHERE session_key=? AND status='pending'", key)) {
      this.closeRequest(String(row.id), key, "resolved", by);
    }
  }

  /** Closes every pending request past its expiry as `timeout`; the CLI gets the prompt back in its terminal. */
  expireRequests(at = now()): number {
    let count = 0;
    for (const row of this.store.all("SELECT id,session_key FROM cli_agent_requests WHERE status='pending' AND expires_at<=?", at)) {
      if (this.closeRequest(String(row.id), String(row.session_key), "expired", "timeout")) count++;
    }
    return count;
  }

  private requestView(row: Row): CliRequestView {
    const summary = (JSON.parse(this.store.decrypt(String(row.summary_json))) as { summary: string }).summary;
    const extra = row.options_json === null ? {} : (JSON.parse(this.store.decrypt(String(row.options_json))) as { options?: string[]; questions?: CliRequestQuestion[] });
    return {
      id: String(row.id), key: asKey(String(row.session_key)), kind: row.kind as CliRequestView["kind"], tool: String(row.tool), summary,
      ...(extra.options ? { options: extra.options } : {}), ...(extra.questions ? { questions: extra.questions } : {}),
      createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
    };
  }

  /** Pending requests, oldest first; one session's when `key` is given. */
  requests(key?: string): CliRequestView[] {
    const rows = key
      ? this.store.all("SELECT * FROM cli_agent_requests WHERE status='pending' AND session_key=? ORDER BY created_at,id", key)
      : this.store.all("SELECT * FROM cli_agent_requests WHERE status='pending' ORDER BY created_at,id");
    return rows.map((row) => this.requestView(row));
  }

  /** Pending requests grouped by session, for a browser that just subscribed to the list. */
  requestsByKey(): Map<CliSessionKey, CliRequestView[]> {
    const groups = new Map<CliSessionKey, CliRequestView[]>();
    for (const view of this.requests()) {
      const list = groups.get(view.key) ?? [];
      list.push(view);
      groups.set(view.key, list);
    }
    return groups;
  }

  /** Answers a pending request on the device. The request is claimed first, so
   * two answers cannot both reach the device; a definite failure gives it back,
   * an unknown outcome keeps it closed (the device may have acted). */
  async answer(actor: string, requestId: string, decision: "allow" | "deny", answers?: Record<string, string>, message?: string): Promise<{ outcome: string }> {
    const row = this.store.get("SELECT * FROM cli_agent_requests WHERE id=?", requestId);
    if (!row) throw new CliOpError("not_found");
    const key = String(row.session_key);
    const parsed = this.requireKey(key);
    if (row.status !== "pending") throw new CliOpError("not_found", "request is closed");
    if (Number(row.expires_at) <= now()) { this.expireRequests(); throw new CliOpError("not_found", "request expired"); }
    const view = this.requestView(row);
    const core = view.tool.startsWith(CORE_REQUEST_PREFIX);
    if (core && !this.coreAnswer) throw new CliOpError("not_found", "nothing handles this request");
    let chosen: Record<string, string> | undefined;
    if (view.kind === "question" && decision === "allow") {
      chosen = answers;
      if (!chosen || !Object.keys(chosen).length) throw new CliOpError("invalid");
      for (const question of view.questions ?? []) if (typeof chosen[question.question] !== "string") throw new CliOpError("invalid");
    }
    const claimed = Number(this.store.run(
      "UPDATE cli_agent_requests SET status='answered',decided_by='nexbot',decision_json=? WHERE id=? AND status='pending'",
      this.store.encrypt(JSON.stringify({ decision, ...(chosen ? { answers: chosen } : {}), ...(message ? { message } : {}) })), requestId,
    ).changes);
    if (!claimed) throw new CliOpError("not_found", "request is closed");
    try {
      const result = core
        ? await this.coreAnswer!(view, decision, chosen, actor)
        : await this.op(actor, parsed.deviceId, key, "answer", {
          id: requestId, decision, ...(chosen ? { answers: chosen } : {}), ...(message ? { message } : {}),
        });
      this.emitRequestResolved(asKey(key), requestId, "nexbot");
      this.refreshSummary();
      return result;
    } catch (error) {
      if (error instanceof CliOpError && error.code !== "unknown") {
        this.store.run("UPDATE cli_agent_requests SET status='pending',decided_by=NULL,decision_json=NULL WHERE id=? AND status='answered'", requestId);
      } else {
        this.emitRequestResolved(asKey(key), requestId, "nexbot");
        this.refreshSummary();
      }
      throw error;
    }
  }

  /** Raises a request of Core's own for a known session; null when the session is unknown or has too many pending. */
  addCoreRequest(key: string, input: { tool: string; summary: string; questions: CliRequestQuestion[]; expiresAt: number }): string | null {
    if (!parseCliKey(key) || !this.sessionRow(key) || !input.tool.startsWith(CORE_REQUEST_PREFIX)) return null;
    const pending = Number(this.store.get("SELECT COUNT(*) n FROM cli_agent_requests WHERE session_key=? AND status='pending'", key)?.n ?? 0);
    if (pending >= CLI_LIMITS.requestsPerSession) return null;
    const requestId = id();
    this.store.insert("cli_agent_requests", {
      id: requestId, session_key: key, kind: "question", tool: input.tool,
      summary_json: this.store.encrypt(JSON.stringify({ summary: input.summary })), options_json: this.store.encrypt(JSON.stringify({ questions: input.questions })),
      status: "pending", decided_by: null, decision_json: null, created_at: now(), expires_at: input.expiresAt,
    });
    this.emitRequests(key);
    this.refreshSummary();
    return requestId;
  }

  /** Closes the pending requests of Core's own for a session (the question went stale). */
  closeCoreRequests(key: string, by: CliRequestResolvedBy): number {
    let count = 0;
    for (const row of this.store.all("SELECT id FROM cli_agent_requests WHERE session_key=? AND status='pending' AND tool LIKE ?", key, CORE_REQUEST_PREFIX + "%")) {
      if (this.closeRequest(String(row.id), key, "resolved", by)) count++;
    }
    return count;
  }

  /** The one handler answers to Core's own requests go to; returns how to remove it. */
  onCoreAnswer(handler: CoreAnswerHandler): () => void {
    this.coreAnswer = handler;
    return () => { if (this.coreAnswer === handler) this.coreAnswer = null; };
  }

  onRequests(listener: (message: ServerMessage) => void): () => void {
    this.requestListeners.add(listener);
    return () => { this.requestListeners.delete(listener); };
  }

  onTurnEnd(listener: (event: CliTurnEvent) => void): () => void {
    this.turnListeners.add(listener);
    return () => { this.turnListeners.delete(listener); };
  }

  /** The queue consumer retries paused sends when a device comes back. */
  onDeviceOnline(listener: (deviceId: string) => void): () => void {
    this.deviceOnlineListeners.add(listener);
    return () => { this.deviceOnlineListeners.delete(listener); };
  }

  /** Whether a mutating operation is in flight for the session; the queue
   * consumer waits for it instead of racing a dispatch the user just made. */
  busy(key: string): boolean {
    return this.busyKeys.has(key);
  }

  /** The workbench pushes one session's queue to its watchers and to listeners. */
  notifyQueue(queue: CliQueueView) {
    this.notify(queue.sessionKey, { type: "queue", queue });
    for (const listener of [...this.queueListeners]) {
      try { listener({ type: "queue", queue }); } catch { /* ignore a broken listener */ }
    }
  }

  /** The workbench pushes the whole tree after a rename, archive, fork or delete. */
  notifyWorkbench(sessions: CliWorkbenchSessionView[]) {
    const message: ServerMessage = { type: "workbench", sessions };
    for (const listener of [...this.workbenchListeners]) {
      try { listener(message); } catch { /* ignore a broken listener */ }
    }
  }

  onQueue(listener: (message: ServerMessage) => void): () => void {
    this.queueListeners.add(listener);
    return () => { this.queueListeners.delete(listener); };
  }

  /** The stream forwards tree snapshots to the browsers on the list channel. */
  onWorkbench(listener: (message: ServerMessage) => void): () => void {
    this.workbenchListeners.add(listener);
    return () => { this.workbenchListeners.delete(listener); };
  }

  /** The latest turn end Core saw for a session since it started. */
  lastTurn(key: string): CliTurnEvent | undefined {
    return this.lastTurns.get(key);
  }

  /** Newest first. Reads the encrypted cache only; the device is not asked. */
  recentItems(key: string, limit = PAGE_SIZE): CliItem[] {
    const rows = this.store.all("SELECT body FROM cli_agent_items WHERE session_key=? ORDER BY ts DESC,rowid DESC LIMIT ?", key, limit);
    return rows.map((row) => JSON.parse(this.store.decrypt(String(row.body))) as CliItem);
  }

  private emitRequests(key: string) {
    this.emitRequestMessage(key, { type: "requests", key: asKey(key), requests: this.requests(key) });
  }

  private emitRequestResolved(key: CliSessionKey, requestId: string, by: CliRequestResolvedBy) {
    this.emitRequestMessage(key, { type: "request.resolved", key, id: requestId, by });
  }

  private emitRequestMessage(key: string, message: ServerMessage) {
    this.notify(key, message);
    for (const listener of [...this.requestListeners]) {
      try { listener(message); } catch { /* ignore a broken listener */ }
    }
  }

  private onReply(deviceId: string, message: Extract<DeviceCliMessage, { type: "cli.reply" }>) {
    const pending = this.pending.get(message.opId);
    if (pending && pending.deviceId === deviceId) {
      clearTimeout(pending.timer);
      this.release(pending);
      if (message.ok) {
        const result = parseCliOpResult(pending.op, message.result ?? {});
        if (!result) {
          this.markOp(pending.opId, "unknown", "invalid_result");
          pending.reject(new CliOpError("unknown", "device answer was malformed"));
        } else {
          this.markOp(pending.opId, "succeeded");
          pending.resolve(result);
        }
      } else {
        const code = message.error?.code ?? "unknown";
        this.markOp(pending.opId, "failed", code);
        pending.reject(new CliOpError(code, message.error?.message));
      }
      return;
    }
    // A late answer to an op Core already gave up on settles the record only.
    const row = this.store.get("SELECT status FROM cli_agent_ops WHERE id=? AND device_id=?", message.opId, deviceId);
    if (row?.status !== "unknown") return;
    if (message.ok) this.markOp(message.opId, "succeeded");
    else this.markOp(message.opId, "failed", message.error?.code ?? "unknown");
  }

  private markOp(opId: string, status: "succeeded" | "failed" | "unknown", errorCode?: string) {
    this.store.run("UPDATE cli_agent_ops SET status=?,error_code=?,finished_at=? WHERE id=?", status, errorCode ?? null, now(), opId);
  }

  private release(pending: Pending) {
    this.pending.delete(pending.opId);
    if (pending.sessionKey && CLI_OP_MUTATING.has(pending.op)) this.busyKeys.delete(pending.sessionKey);
  }

  private settleUnknown(pending: Pending, code: CliErrorCode, message?: string) {
    if (!this.pending.has(pending.opId)) return;
    clearTimeout(pending.timer);
    this.release(pending);
    if (CLI_OP_MUTATING.has(pending.op)) this.markOp(pending.opId, "unknown", code);
    pending.reject(new CliOpError(code, message));
  }

  // -------------------------------------------------------------------------
  // Operations (Core -> device)

  /** Sends one operation to a device and waits for its answer. A mutating
   * operation is sent once: a timeout or a dropped link ends as `unknown` and
   * is never retried, so a retry can only be the user's decision. */
  op<K extends CliOp>(actor: string, deviceId: string, sessionKey: string | null, op: K, args: unknown): Promise<CliOpResult[K]> {
    return this.beginOp(actor, deviceId, sessionKey, op, args).promise;
  }

  /** Like `op`, but the operation id comes back with the answer, so a caller
   * that records dispatches (the outbox) can reconcile an uncertain outcome
   * against the op row. */
  async opTracked<K extends CliOp>(actor: string, deviceId: string, sessionKey: string | null, op: K, args: unknown): Promise<{ opId: string; result: CliOpResult[K] }> {
    const begun = this.beginOp(actor, deviceId, sessionKey, op, args);
    try {
      return { opId: begun.opId, result: await begun.promise };
    } catch (error) {
      if (begun.opId && error instanceof CliOpError) throw new TrackedOpError(begun.opId, error);
      throw error;
    }
  }

  private beginOp<K extends CliOp>(actor: string, deviceId: string, sessionKey: string | null, op: K, args: unknown): { opId: string; promise: Promise<CliOpResult[K]> } {
    const mutating = CLI_OP_MUTATING.has(op);
    if (this.closed || !this.caps.has(deviceId)) return { opId: "", promise: Promise.reject(new CliOpError("device_offline")) };
    const parsed = parseCliOpArgs(op, args) as CliOpArgs[K] | null;
    if (!parsed) return { opId: "", promise: Promise.reject(new CliOpError("invalid")) };
    if (mutating && sessionKey && this.busyKeys.has(sessionKey)) return { opId: "", promise: Promise.reject(new CliOpError("busy")) };
    const opId = id();
    const timeout = this.tuning.opTimeoutMs ?? CLI_OP_TIMEOUT_MS[op];
    if (mutating) {
      // Message text stays out of the record: the transcript is the place for it.
      const recorded = op === "send" || op === "steer"
        ? { ref: (parsed as CliOpArgs["send"]).ref, length: (parsed as CliOpArgs["send"]).text.length }
        : op === "answer"
          ? { id: (parsed as CliOpArgs["answer"]).id, decision: (parsed as CliOpArgs["answer"]).decision }
          : parsed;
      this.store.insert("cli_agent_ops", {
        id: opId, device_id: deviceId, session_key: sessionKey, op, args_json: JSON.stringify(recorded),
        status: "sent", error_code: null, created_by: actor, created_at: now(), finished_at: null,
      });
    }
    const promise = new Promise<CliOpResult[K]>((resolve, reject) => {
      const pending: Pending = {
        opId, deviceId, op, sessionKey, resolve: resolve as (value: unknown) => void, reject,
        timer: setTimeout(() => this.settleUnknown(pending, "unknown", "device did not answer"), timeout + this.tuning.graceMs),
      };
      pending.timer.unref?.();
      this.pending.set(opId, pending);
      if (mutating && sessionKey) this.busyKeys.add(sessionKey);
      try {
        this.link.sendCli(deviceId, { type: "cli.op", opId, op, args: parsed, deadlineMs: timeout } as CoreCliMessage);
      } catch {
        // Nothing left the socket, so this is a plain failure and not an unknown outcome.
        clearTimeout(pending.timer);
        this.release(pending);
        if (mutating) this.markOp(opId, "failed", "device_offline");
        reject(new CliOpError("device_offline"));
      }
    });
    return { opId, promise };
  }

  /** `forkFrom` starts the session from that session's context. An executor that does not list the
   * engine in `forkEngines` would ignore the field and open a blank session, so it is refused here. */
  async start(actor: string, deviceId: string, engine: "claude" | "codex" | "zcode", cwd: string, forkFrom?: CliSessionRef, launch: CliLaunchOptions = {}, createDir = false): Promise<{ key: CliSessionKey; terminal: string; cwd?: string }> {
    if (forkFrom) {
      const caps = this.caps.get(deviceId);
      if (caps && !caps.forkEngines?.includes(engine)) throw new CliOpError("invalid", FORK_UNSUPPORTED);
    }
    if (createDir) this.requireFeature(deviceId, "dirs");
    const options = this.launchOptions(deviceId, launch);
    const result = await this.op(actor, deviceId, null, "start", { engine, cwd, ...(forkFrom ? { forkFrom } : {}), ...(createDir ? { createDir: true } : {}), ...options });
    return { key: cliKey(deviceId, result.ref), terminal: result.terminal, ...(result.cwd ? { cwd: result.cwd } : {}) };
  }

  /** Starts a session inside a fresh worktree of the repository at `cwd`; the
   * device dedups by requestId, so a retry reuses the tree it built. */
  async startWorktree(actor: string, deviceId: string, engine: CliEngine, cwd: string, branch: string, requestId: string, launch: CliLaunchOptions = {}): Promise<{ key: CliSessionKey; terminal: string; cwd?: string }> {
    const options = this.launchOptions(deviceId, launch);
    const result = await this.op(actor, deviceId, null, "start", { engine, cwd, worktree: { branch, requestId }, ...options });
    return { key: cliKey(deviceId, result.ref), terminal: result.terminal, ...(result.cwd ? { cwd: result.cwd } : {}) };
  }

  /** Model and effort only go to an executor that lists `launchOptions`: an older
   * one would drop them from the args and start with its defaults unasked. */
  private launchOptions(deviceId: string, launch: CliLaunchOptions): CliLaunchOptions {
    const options: CliLaunchOptions = {
      ...(launch.model !== undefined ? { model: launch.model } : {}),
      ...(launch.effort !== undefined ? { effort: launch.effort } : {}),
    };
    if (!Object.keys(options).length) return options;
    const caps = this.caps.get(deviceId);
    if (caps && !hasCliFeature(caps, "launchOptions")) throw new CliOpError("invalid", CLI_OUTDATED_TEXT);
    return options;
  }

  /** Content search across the online computers that can search, in parallel. A
   * computer that fails or runs out of time adds nothing; hits for sessions Core
   * does not list are dropped. Newest activity first. */
  async search(actor: string, query: string, limit?: number): Promise<Array<{ key: CliSessionKey; snippet: string }>> {
    const devices = [...this.caps.entries()].filter(([, caps]) => hasCliFeature(caps, "search")).map(([deviceId]) => deviceId);
    const answers = await Promise.allSettled(devices.map(async (deviceId) => {
      const result = await this.op(actor, deviceId, null, "search", { query, ...(limit ? { limit } : {}) });
      return result.hits.map((hit) => ({ key: asKey(cliKey(deviceId, hit.ref)), snippet: hit.snippet }));
    }));
    const hits: Array<{ key: CliSessionKey; snippet: string; at: number }> = [];
    const seen = new Set<string>();
    for (const answer of answers) {
      if (answer.status !== "fulfilled") continue;
      for (const hit of answer.value) {
        const row = seen.has(hit.key) ? undefined : this.sessionRow(hit.key);
        if (!row) continue;
        seen.add(hit.key);
        hits.push({ ...hit, at: Number(row.last_activity_at) });
      }
    }
    return hits.sort((a, b) => b.at - a.at).map(({ key, snippet }) => ({ key, snippet }));
  }

  /** The sub-folders of a folder on a computer ("" for its drives and home folder). */
  async dirs(actor: string, deviceId: string, path: string): Promise<CliDirListing> {
    this.requireFeature(deviceId, "dirs");
    return this.op(actor, deviceId, null, "dirs", { path });
  }

  /** An executor that does not list `feature` would ignore or refuse it: say it needs an update instead. */
  private requireFeature(deviceId: string, feature: CliFeature): void {
    const caps = this.caps.get(deviceId);
    if (caps && !hasCliFeature(caps, feature)) throw new CliOpError("invalid", CLI_OUTDATED_TEXT);
  }

  /** The model picker rows of one CLI on a computer; an executor without `models` is refused (the page keeps its own list). */
  async models(actor: string, deviceId: string, engine: CliEngine): Promise<CliModelCatalog> {
    const caps = this.caps.get(deviceId);
    if (caps && !hasCliFeature(caps, "models")) throw new CliOpError("invalid", CLI_OUTDATED_TEXT);
    return this.op(actor, deviceId, null, "models", { engine });
  }

  /** Puts a file on the session's computer for the CLI to read; the answer is its absolute path there. */
  async attach(actor: string, key: string, name: string, bytes: Uint8Array): Promise<{ path: string }> {
    const parsed = this.requireKey(key);
    if (bytes.length > CLI_ATTACH_MAX_BYTES) throw new CliOpError("too_large", "附件不能超过 8 MB");
    const caps = this.caps.get(parsed.deviceId);
    if (caps && !hasCliFeature(caps, "attach")) throw new CliOpError("invalid", CLI_OUTDATED_TEXT);
    return this.op(actor, parsed.deviceId, key, "attach", { ref: parsed.ref, name, data: Buffer.from(bytes).toString("base64") });
  }

  /** The Git snapshot of a session's repository, gathered on the device that
   * owns it. An offline device answers "failed" instead of failing the page. */
  async git(actor: string, key: string): Promise<CliGitInfo> {
    const parsed = this.requireKey(key);
    try {
      return await this.op(actor, parsed.deviceId, key, "git", { ref: parsed.ref, action: "info" });
    } catch (error) {
      if (error instanceof CliOpError && (error.code === "device_offline" || error.code === "unknown")) {
        return { source: "failed", error: CLI_ERROR_TEXT[error.code] };
      }
      // Core builds these arguments itself, so `invalid` means the executor
      // predates the `git` op: an answer to show, not a request error.
      if (error instanceof CliOpError && error.code === "invalid") {
        return { source: "failed", error: GIT_UNSUPPORTED };
      }
      throw error;
    }
  }

  async continueSession(actor: string, key: string, launch: CliLaunchOptions = {}): Promise<{ key: CliSessionKey; terminal: string }> {
    const parsed = this.requireKey(key);
    const options = this.launchOptions(parsed.deviceId, launch);
    const result = await this.op(actor, parsed.deviceId, key, "continue", { ref: parsed.ref, ...options });
    return { key: cliKey(parsed.deviceId, result.ref), terminal: result.terminal };
  }

  send(actor: string, key: string, text: string) {
    const parsed = this.requireKey(key);
    return this.op(actor, parsed.deviceId, key, "send", { ref: parsed.ref, text });
  }

  interrupt(actor: string, key: string) {
    const parsed = this.requireKey(key);
    return this.op(actor, parsed.deviceId, key, "interrupt", { ref: parsed.ref });
  }

  openLocal(actor: string, key: string) {
    const parsed = this.requireKey(key);
    return this.op(actor, parsed.deviceId, key, "open_local", { ref: parsed.ref });
  }

  private requireKey(key: string) {
    const parsed = parseCliKey(key);
    if (!parsed) throw new CliOpError("invalid");
    if (!this.store.get("SELECT id FROM devices WHERE id=? AND status!='revoked'", parsed.deviceId)) throw new CliOpError("not_found");
    return parsed;
  }

  /** One page of a transcript. Online, the device answers; offline or unknown,
   * the cached page does. Any other device error propagates. */
  async items(actor: string, key: string, before?: string): Promise<{ items: CliItem[]; more: boolean }> {
    const parsed = this.requireKey(key);
    try {
      const result = await this.op(actor, parsed.deviceId, key, "read", { ref: parsed.ref, ...(before ? { before } : {}), limit: PAGE_SIZE });
      if (this.sessionRow(key)) this.cacheItems(key, result.items, false);
      return result;
    } catch (error) {
      if (error instanceof CliOpError && (error.code === "device_offline" || error.code === "unknown")) return this.cachedPage(key, before);
      throw error;
    }
  }

  /** The client names its message and version. Only this workspace's completed
   * cached assistant output can be sent to the configured translation provider. */
  translationSource(key: string, itemId: string, source: string): string | null {
    this.requireKey(key);
    const session = this.sessionRow(key);
    if (!session) return null;
    const row = this.store.get("SELECT body,ts,rowid FROM cli_agent_items WHERE session_key=? AND item_id=?", key, itemId);
    if (!row) return null;
    const decode = (body: unknown) => JSON.parse(this.store.decrypt(String(body))) as CliItem;
    const item = decode(row.body);
    if (item.kind !== "assistant" || item.text !== source) return null;
    const following = this.store.all(
      "SELECT body FROM cli_agent_items WHERE session_key=? AND (ts>? OR (ts=? AND rowid>?)) ORDER BY ts,rowid",
      key, Number(row.ts), Number(row.ts), Number(row.rowid),
    ).map(entry => decode(entry.body));
    const active = session.state === "running" || session.state === "waiting";
    return completedCliReplies([item, ...following], active).has(item.id) ? item.text : null;
  }

  /** The listener gets `items` messages for the session. The first listener
   * starts a device watch, the last one stops it; a reconnect re-sends it. The
   * session's outbox queue rides along on the first subscribe. */
  subscribe(key: string, listener: (message: ServerMessage) => void): () => void {
    const parsed = parseCliKey(key);
    if (!parsed) throw new CliOpError("invalid");
    let set = this.watchers.get(key);
    if (!set) { set = new Set(); this.watchers.set(key, set); }
    set.add(listener);
    if (set.size === 1) {
      this.watchOp("watch", key);
      const queue = this.workbench?.queueForSessionKey(key);
      if (queue) listener({ type: "queue", queue });
    }
    return () => {
      const current = this.watchers.get(key);
      if (!current?.delete(listener) || current.size) return;
      this.watchers.delete(key);
      this.watchOp("unwatch", key);
    };
  }

  private watchOp(op: "watch" | "unwatch", key: string) {
    const parsed = parseCliKey(key);
    if (!parsed || !this.caps.has(parsed.deviceId)) return;
    void this.op("system", parsed.deviceId, key, op, { ref: parsed.ref }).catch(() => undefined);
  }

  private notify(key: string, message: ServerMessage) {
    for (const listener of [...(this.watchers.get(key) ?? [])]) {
      try { listener(message); } catch { /* one broken listener must not starve the others */ }
    }
  }

  // -------------------------------------------------------------------------
  // Reading state

  private viewOf(key: string): CliSessionView | null {
    const row = this.sessionRow(key);
    return row ? this.view(row) : null;
  }

  private view(row: Row): CliSessionView {
    const key = asKey(String(row.key)), deviceId = String(row.device_id);
    const view: CliSessionView = {
      key, deviceId,
      engine: row.engine as CliSessionView["engine"],
      nativeId: String(row.native_id),
      configDir: String(row.config_dir),
      cwd: String(row.cwd),
      title: String(row.title),
      state: row.state as CliSessionView["state"],
      lastActivityAt: Number(row.last_activity_at),
      hidden: row.hidden === 1,
      online: this.caps.has(deviceId),
    };
    if (row.git_branch !== null) view.gitBranch = String(row.git_branch);
    if (row.waiting_for !== null) view.waitingFor = String(row.waiting_for);
    if (row.live_in !== null) view.liveIn = row.live_in as CliSessionView["liveIn"];
    if (row.terminal !== null) view.terminal = String(row.terminal);
    if (row.model !== null) view.model = String(row.model);
    if (row.cli_version !== null) view.cliVersion = String(row.cli_version);
    const via = this.sendVia.get(key);
    if (via) view.sendVia = via;
    const place = this.placement.get(key);
    if (place?.repoRoot) view.repoRoot = place.repoRoot;
    if (place?.forkOf) view.forkOf = place.forkOf;
    if (place?.sideOf) view.sideOf = place.sideOf;
    if (this.writerUnknown.has(key)) view.writerUnknown = true;
    const context = this.contexts.get(key);
    if (context) view.context = { ...context };
    return view;
  }

  private deviceView(deviceId: string): CliDeviceView | null {
    const row = this.store.get("SELECT id,name FROM devices WHERE id=? AND status!='revoked'", deviceId);
    if (!row) return null;
    const online = this.caps.has(deviceId);
    return { id: deviceId, name: String(row.name), online, cliAgents: this.caps.get(deviceId) ?? this.lastCaps.get(deviceId) ?? null };
  }

  list(): { devices: CliDeviceView[]; sessions: CliSessionView[] } {
    const rows = this.store.all("SELECT * FROM cli_agent_sessions ORDER BY last_activity_at DESC,key LIMIT 5000");
    const sessions = rows.map((row) => this.view(row));
    const ids = new Set<string>([...this.caps.keys(), ...sessions.map((session) => session.deviceId)]);
    const devices: CliDeviceView[] = [];
    for (const row of this.store.all("SELECT id FROM devices WHERE status!='revoked' ORDER BY created_at,id")) {
      if (!ids.has(String(row.id))) continue;
      const view = this.deviceView(String(row.id));
      if (view) devices.push(view);
    }
    return { devices, sessions };
  }

  session(key: string): CliSessionView | null {
    return parseCliKey(key) ? this.viewOf(key) : null;
  }

  hide(key: string, hidden: boolean): boolean {
    if (!parseCliKey(key)) return false;
    const changes = Number(this.store.run("UPDATE cli_agent_sessions SET hidden=? WHERE key=?", hidden ? 1 : 0, key).changes);
    if (!changes) return false;
    const view = this.viewOf(key);
    if (view) this.emitList({ upserts: [view], removes: [] });
    this.refreshSummary();
    return true;
  }

  /** Sessions waiting for the user or running, on devices that are online and
   * not hidden. Counts only: the sidebar badge needs nothing else. */
  summary(): { waiting: number; running: number } {
    let waiting = 0, running = 0;
    // A session with a pending permission or question is waiting for the user whatever state the file says.
    const asked = new Set(this.store.all("SELECT DISTINCT session_key FROM cli_agent_requests WHERE status='pending'").map((row) => String(row.session_key)));
    for (const row of this.store.all("SELECT key,device_id,state FROM cli_agent_sessions WHERE hidden=0 AND (state IN ('waiting','running') OR key IN (SELECT session_key FROM cli_agent_requests WHERE status='pending'))")) {
      if (!this.caps.has(String(row.device_id))) continue;
      if (row.state === "waiting" || asked.has(String(row.key))) waiting++; else running++;
    }
    return { waiting, running };
  }

  /** `changed()` fires only when a count moves, so a busy session does not wake every client. */
  private refreshSummary() {
    if (this.closed) return;
    const next = this.summary();
    if (next.waiting === this.lastSummary.waiting && next.running === this.lastSummary.running) return;
    this.lastSummary = next;
    for (const listener of [...this.summaryListeners]) {
      try { listener(next); } catch { /* ignore a broken listener */ }
    }
    this.changed();
  }

  onList(listener: (delta: ListDelta) => void): () => void {
    this.listListeners.add(listener);
    return () => { this.listListeners.delete(listener); };
  }

  onSummary(listener: (summary: { waiting: number; running: number }) => void): () => void {
    this.summaryListeners.add(listener);
    return () => { this.summaryListeners.delete(listener); };
  }

  private emitList(delta: ListDelta) {
    for (const listener of [...this.listListeners]) {
      try { listener(delta); } catch { /* ignore a broken listener */ }
    }
  }

  /** A device went online or offline: its sessions flip `online` and its row in the device list changes. */
  private emitDeviceDelta(deviceId: string) {
    const upserts = this.store.all("SELECT * FROM cli_agent_sessions WHERE device_id=?", deviceId).map((row) => this.view(row));
    const device = this.deviceView(deviceId);
    this.emitList({ upserts, removes: [], ...(device ? { devices: [device] } : {}) });
  }

  // -------------------------------------------------------------------------
  // Terminal streams

  openStream(sink: StreamSink, key: string, req: string, cols: number, rows: number, observe: boolean) {
    const parsed = parseCliKey(key);
    if (!parsed) { sink.error("invalid", req); return; }
    if (!this.caps.has(parsed.deviceId)) { sink.error("device_offline", req); return; }
    let owned = 0;
    for (const entry of this.byBrowser.values()) if (entry.sink === sink) owned++;
    if (owned >= MAX_STREAMS_PER_SINK) { sink.error("busy", req); return; }
    const entry: StreamEntry = {
      browserSid: this.nextBrowserSid++, deviceSid: this.nextDeviceSid++, deviceId: parsed.deviceId, key, req, sink, observe,
      opened: false, forwarded: 0, credited: 0, queued: 0, openTimer: null,
    };
    // The device is the authority on whether the session has a terminal, so there is no precheck here.
    try {
      this.link.sendCli(parsed.deviceId, { type: "cli.term.open", sid: entry.deviceSid, ref: parsed.ref, cols, rows, observe });
    } catch { sink.error("device_offline", req); return; }
    this.byBrowser.set(entry.browserSid, entry);
    let perDevice = this.byDevice.get(parsed.deviceId);
    if (!perDevice) { perDevice = new Map(); this.byDevice.set(parsed.deviceId, perDevice); }
    perDevice.set(entry.deviceSid, entry);
    entry.openTimer = setTimeout(() => {
      if (!this.byBrowser.has(entry.browserSid) || entry.opened) return;
      this.removeEntry(entry);
      this.tryCloseOnDevice(entry);
      sink.error("unknown", req, "terminal open timed out");
    }, this.tuning.streamOpenMs);
    entry.openTimer.unref?.();
    if (!observe) this.store.audit("cli.term.control", "cli_session", key, { sessionId: sink.sessionId });
  }

  private owned(sink: StreamSink, sid: number): StreamEntry | undefined {
    const entry = this.byBrowser.get(sid);
    return entry && entry.sink === sink ? entry : undefined;
  }

  streamInput(sink: StreamSink, sid: number, payload: Uint8Array) {
    const entry = this.owned(sink, sid);
    if (!entry || !entry.opened) return;
    if (entry.observe) { sink.error("read_only", undefined, `sid ${sid}`); return; }
    if (payload.length > FRAME_PAYLOAD_MAX) return;
    try { this.link.sendCliBinary(entry.deviceId, encodeTermFrame(TERM_INPUT, entry.deviceSid, payload)); } catch { this.linkFailed(entry); }
  }

  streamResize(sink: StreamSink, sid: number, cols: number, rows: number) {
    const entry = this.owned(sink, sid);
    if (!entry || !entry.opened || entry.observe) return;
    try { this.link.sendCli(entry.deviceId, { type: "cli.term.resize", sid: entry.deviceSid, cols, rows }); } catch { this.linkFailed(entry); }
  }

  /** The browser acknowledges bytes it has drawn. Core forwards at most what it has delivered and not yet credited. */
  streamCredit(sink: StreamSink, sid: number, bytes: number) {
    const entry = this.owned(sink, sid);
    if (!entry) return;
    const allowed = Math.min(bytes, entry.forwarded - entry.credited);
    if (allowed <= 0) return;
    entry.credited += allowed;
    try { this.link.sendCli(entry.deviceId, { type: "cli.term.credit", sid: entry.deviceSid, bytes: allowed }); } catch { this.linkFailed(entry); }
  }

  /** The browser closes its own stream; nothing is echoed back. */
  streamClose(sink: StreamSink, sid: number) {
    const entry = this.owned(sink, sid);
    if (!entry) return;
    this.removeEntry(entry);
    this.tryCloseOnDevice(entry);
  }

  closeSink(sink: StreamSink) {
    for (const entry of [...this.byBrowser.values()]) {
      if (entry.sink !== sink) continue;
      this.removeEntry(entry);
      this.tryCloseOnDevice(entry);
    }
  }

  streamCount(): number {
    return this.byBrowser.size;
  }

  private linkFailed(entry: StreamEntry) {
    if (!this.byBrowser.has(entry.browserSid)) return;
    this.removeEntry(entry);
    entry.sink.closed(entry.browserSid, "device_offline");
  }

  private tryCloseOnDevice(entry: StreamEntry) {
    try { this.link.sendCli(entry.deviceId, { type: "cli.term.close", sid: entry.deviceSid }); } catch { /* the device is gone; its terminal side cleans itself up */ }
  }

  private removeEntry(entry: StreamEntry) {
    if (entry.openTimer) { clearTimeout(entry.openTimer); entry.openTimer = null; }
    this.byBrowser.delete(entry.browserSid);
    const perDevice = this.byDevice.get(entry.deviceId);
    perDevice?.delete(entry.deviceSid);
    if (perDevice && !perDevice.size) this.byDevice.delete(entry.deviceId);
  }
}

/** Error codes that make sense to show a user; anything else becomes `unknown`. */
export function errorCodeOf(error: unknown): CliErrorCode {
  if (error instanceof CliOpError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (CLI_ERROR_CODES as readonly string[]).includes(code) ? (code as CliErrorCode) : "unknown";
}
