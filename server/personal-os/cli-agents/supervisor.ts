// Agent mode supervisor (design section 9, plan 7.3): reacts to the end of a
// turn on a device and, only where the user turned it on for that workspace,
// sends one fixed message, "继续", to the session. Three cases are handled:
//   retry        a transient error (overload, rate limit, network): backoff
//                15 s doubling, at most 5 in a row, rate limits wait 4x as
//                long, never longer than 30 minutes. On by default.
//   usage_limit  the error names a reset time: continue shortly after it. Off.
//   wakeup       the assistant's last text explicitly says it is waiting for a
//                stated time ("等待 10 分钟"): continue then. Off.
// The text is a constant, so nothing a session says can steer what is sent.
//
// Safety: nothing is sent when the last assistant text, the wait or the error
// mentions pushing, deploying, merging, messaging people, deleting or paying.
// Immediately before every action the session is read again: it must still be
// at the same turn, not running or waiting, have no pending request and no
// recent input from the user, and live in a nex_bot terminal or none. Anything
// else records a skip. Each turn gets at most one action row, so a repeated
// cli.turn or a restart cannot send twice.
//
// Not built: a model that triages a finished turn ("doing / waiting for a
// precondition / done"). It would spend the user's tokens on every turn and
// has no safe rule-based form, so `triage` below is the documented extension
// point: a hook that may return a delay for a "wakeup" and is otherwise unused.
import { randomUUID } from "node:crypto";
import type { CliItem } from "../../../shared/cli-agents.ts";
import type { CoreStore, Row } from "../store.ts";
import { CliOpError, type CliAgentHub, type CliTurnEvent } from "./hub.ts";

export const CONTINUE_TEXT = "继续";
export const SUPERVISOR_ACTOR = "supervisor";

export interface SupervisionSettings {
  transientRetry: boolean;
  usageLimit: boolean;
  wakeup: boolean;
}

export const DEFAULT_SUPERVISION: Readonly<SupervisionSettings> = { transientRetry: true, usageLimit: false, wakeup: false };
export const SUPERVISION_KEYS = ["transientRetry", "usageLimit", "wakeup"] as const;

export const RETRY_BASE_MS = 15_000;
export const RETRY_MAX = 5;
export const RATE_LIMIT_FACTOR = 4;
export const RETRY_CAP_MS = 30 * 60_000;
/** After a usage-limit reset, wait this long before continuing. */
export const RESET_SETTLE_MS = 60_000;
export const USAGE_LIMIT_MAX_MS = 24 * 3_600_000;
export const WAKEUP_MIN_MS = 30_000;
export const WAKEUP_MAX_MS = 6 * 3_600_000;
/** How long after the turn the cache gets to receive the last assistant text before a wakeup is decided. */
export const WAKEUP_SETTLE_MS = 2000;
/** A user message this recent means someone is at the keyboard. */
export const LOCAL_INPUT_MS = 120_000;
/** Pending actions older than this when Core starts are dropped instead of run. */
export const STALE_MS = 10 * 60_000;

export interface SupervisorClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: SupervisorClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export type ActionKind = "retry" | "usage_limit" | "wakeup";
export type ActionStatus = "pending" | "sent" | "recovered" | "skipped" | "failed" | "cancelled";

export interface SupervisionAction {
  id: string;
  key: string;
  turn: number;
  endedAt: number;
  kind: ActionKind;
  attempt: number;
  dueAt: number;
  status: ActionStatus;
  reason?: string;
  createdAt: number;
  finishedAt?: number;
}

/** Extension point for a model based judgement of a finished turn. It runs for
 * turns that ended normally with `wakeup` on and may return how long to wait
 * before continuing; it never sends anything itself. Unset by default. */
export type TriageHook = (input: { key: string; cwd: string; lastAssistantText: string }) => Promise<{ waitMs: number } | null>;

// ---------------------------------------------------------------------------
// Rules

/** Anything here in the last assistant text, the wait or the error ends automation for the turn. */
export const BOUNDARY_RE =
  /push|deploy|部署|发布|上线|merge|合并|发消息|回复|评论|发送|删除|购买|付费|续费|充值|生产|production|publish|release|delete|purchase|payment|\bprod\b/i;

const NON_TRANSIENT_RE =
  /unauthori[sz]ed|\b40[123]\b|invalid[\s_-]?api[\s_-]?key|authentication|credit balance|billing|insufficient|prompt is too long|context (?:length|window)|content policy|permission denied|余额|欠费|鉴权|认证|无效|上下文/i;
const TRANSIENT_RE =
  /overloaded|rate[\s_-]?limit|too many requests|\b429\b|\b5\d\d\b|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|socket|connection (?:error|reset|closed|lost)|temporar|unavailable|service error|api error|internal server error|server error|限流|频率|超时|网络|连接|暂时|繁忙|过载/i;
const RATE_LIMIT_RE = /rate[\s_-]?limit|too many requests|\b429\b|限流|频率/i;
const USAGE_LIMIT_RE =
  /usage limit|limit reached|(?:reached|hit) your .{0,30}limit|quota|(?:5|five)[\s-]hour limit|weekly limit|额度|用量|使用上限|次数上限/i;

export type ErrorClass = "usage_limit" | "rate_limit" | "transient" | "other";

export function classifyError(error: string | undefined): ErrorClass {
  if (!error) return "other";
  if (USAGE_LIMIT_RE.test(error)) return "usage_limit";
  if (NON_TRANSIENT_RE.test(error)) return "other";
  if (RATE_LIMIT_RE.test(error)) return "rate_limit";
  return TRANSIENT_RE.test(error) ? "transient" : "other";
}

/** Delay before retry number `attempt` (1 based). */
export function retryDelayMs(attempt: number, rateLimited: boolean): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (Math.max(1, attempt) - 1) * (rateLimited ? RATE_LIMIT_FACTOR : 1));
}

function zoneOffsetMs(ts: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(new Date(ts));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(ts / 1000) * 1000;
}

/** Epoch ms of a wall clock time in an IANA zone, or null for an unknown zone. */
function zonedEpoch(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number | null {
  try {
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    const first = guess - zoneOffsetMs(guess, timeZone);
    return guess - zoneOffsetMs(first, timeZone);
  } catch { return null; }
}

/** When an error text says its limit resets, as epoch ms; null when it names no usable time. */
export function parseResetTime(text: string, at: number): number | null {
  const stamp = /\|\s*(\d{10}|\d{13})(?!\d)/.exec(text);
  if (stamp) return stamp[1].length === 10 ? Number(stamp[1]) * 1000 : Number(stamp[1]);
  const iso = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/.exec(text);
  if (iso) {
    const parsed = Date.parse(iso[0].replace(" ", "T"));
    if (Number.isFinite(parsed)) return parsed;
  }
  const relative = /(?:\bin\b|\bafter\b)\s*(?:(\d+)\s*(?:hours?|hrs?|h)\b)?\s*(?:and\s*)?(?:(\d+)\s*(?:minutes?|mins?|m)\b)?/i.exec(text)
    ?? /(?:(\d+)\s*小时)?\s*(?:(\d+)\s*分钟?)?\s*后/.exec(text);
  if (relative && (relative[1] || relative[2])) return at + (Number(relative[1] ?? 0) * 60 + Number(relative[2] ?? 0)) * 60_000;
  const clock = /(?:reset|resets|resetting|重置|恢复)[^\d]{0,20}?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_+-]+(?:\/[A-Za-z_+-]+)*)\))?/i.exec(text);
  if (clock && (clock[2] !== undefined || clock[3] !== undefined)) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
    }
    if (hour > 23 || minute > 59) return null;
    const zone = clock[4];
    const today = new Date(at);
    const build = (dayOffset: number): number | null => {
      if (zone) {
        const shifted = new Date(at + dayOffset * 86_400_000);
        let parts: Intl.DateTimeFormatPart[];
        try {
          parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(shifted);
        } catch { return null; }
        const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
        return zonedEpoch(get("year"), get("month"), get("day"), hour, minute, zone);
      }
      return new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, hour, minute).getTime();
    };
    const first = build(0);
    if (first === null) return null;
    if (first > at) return first;
    return build(1);
  }
  return null;
}

const WAIT_RE =
  /(?:等待|等(?:一下|一会|上)?|稍后|过|隔|wait(?:ing)?(?:\s+for)?|check(?:ing)?\s+back\s+in|sleep(?:ing)?(?:\s+for)?|resume\s+in|try\s+again\s+in)\s*(\d+(?:\.\d+)?)\s*(秒钟?|分钟|分|小时|seconds?|secs?|minutes?|mins?|hours?|hrs?)/i;

/** An explicit "waiting N minutes" in the closing text of a turn, as ms. A
 * question to the user is a decision for the user, not a wait. */
export function detectWait(text: string): number | null {
  const tail = text.slice(-400);
  if (/[?？]/.test(tail)) return null;
  const match = WAIT_RE.exec(tail);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const ms = /^(秒|sec)/.test(unit) ? amount * 1000 : /^(分|min)/.test(unit) ? amount * 60_000 : amount * 3_600_000;
  if (!Number.isFinite(ms) || ms < WAKEUP_MIN_MS || ms > WAKEUP_MAX_MS) return null;
  return Math.round(ms);
}

/** Folder identity for settings: separators folded, trailing slash dropped, Windows paths case folded. */
export function workspaceScope(cwd: string): string {
  let value = cwd.replace(/\\/g, "/");
  if (value.length > 1 && value.endsWith("/")) value = value.replace(/\/+$/, "") || "/";
  return /^[A-Za-z]:/.test(value) || value.startsWith("//") ? value.toLowerCase() : value;
}

export function parseSettings(value: unknown): Partial<SupervisionSettings> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const out: Partial<SupervisionSettings> = {};
  for (const key of Object.keys(record)) {
    if (!(SUPERVISION_KEYS as readonly string[]).includes(key) || typeof record[key] !== "boolean") return null;
    out[key as keyof SupervisionSettings] = record[key] as boolean;
  }
  return out;
}

const GLOBAL_SCOPE = "*";

// ---------------------------------------------------------------------------

export class CliAgentSupervisor {
  private readonly timers = new Map<string, unknown>();
  private readonly settling = new Map<string, unknown>();
  private readonly running = new Set<string>();
  private readonly off: () => void;
  private closed = false;
  triage: TriageHook | null = null;

  constructor(
    private readonly hub: CliAgentHub,
    private readonly store: CoreStore,
    private readonly clock: SupervisorClock = systemClock,
  ) {
    this.off = hub.onTurnEnd((event) => this.onTurn(event));
    this.rearm();
  }

  close() {
    this.closed = true;
    this.off();
    for (const handle of this.timers.values()) this.clock.clearTimeout(handle);
    for (const handle of this.settling.values()) this.clock.clearTimeout(handle);
    this.timers.clear();
    this.settling.clear();
  }

  // -------------------------------------------------------------------------
  // Settings

  /** The effective switches for a workspace folder. */
  settings(cwd?: string): SupervisionSettings {
    const merged: SupervisionSettings = { ...DEFAULT_SUPERVISION, ...this.stored(GLOBAL_SCOPE) };
    if (cwd) Object.assign(merged, this.stored(workspaceScope(cwd)));
    return merged;
  }

  private stored(scope: string): Partial<SupervisionSettings> {
    const row = this.store.get("SELECT settings_json FROM cli_agent_supervision WHERE scope=?", scope);
    if (!row) return {};
    return parseSettings((JSON.parse(String(row.settings_json)) as { settings?: unknown }).settings) ?? {};
  }

  /** Overrides for one workspace folder (or all, without `cwd`); `null` removes a workspace override. */
  put(cwd: string | undefined, settings: Partial<SupervisionSettings> | null) {
    const scope = cwd ? workspaceScope(cwd) : GLOBAL_SCOPE;
    if (settings === null) {
      if (scope !== GLOBAL_SCOPE) this.store.run("DELETE FROM cli_agent_supervision WHERE scope=?", scope);
      else this.store.run("DELETE FROM cli_agent_supervision WHERE scope=?", GLOBAL_SCOPE);
    } else {
      const next = { ...this.stored(scope), ...settings };
      this.store.run(
        "INSERT INTO cli_agent_supervision(scope,settings_json,updated_at) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET settings_json=excluded.settings_json,updated_at=excluded.updated_at",
        scope, JSON.stringify({ ...(cwd ? { cwd } : {}), settings: next }), this.clock.now(),
      );
    }
    this.store.audit("cli.supervision", "cli_supervision", scope, { settings });
    // a switch that was turned off stops what is waiting for it
    for (const row of this.store.all("SELECT id,session_key,kind FROM cli_agent_supervision_actions WHERE status='pending'")) {
      const session = this.hub.session(String(row.session_key));
      if (!session) continue;
      const kind = String(row.kind) as ActionKind;
      if (!this.enabled(kind, this.settings(session.cwd))) this.finish(String(row.id), "cancelled", "disabled");
    }
  }

  overview(): { defaults: SupervisionSettings; global: Partial<SupervisionSettings>; workspaces: Array<{ cwd: string; settings: Partial<SupervisionSettings> }>; actions: SupervisionAction[] } {
    const workspaces: Array<{ cwd: string; settings: Partial<SupervisionSettings> }> = [];
    for (const row of this.store.all("SELECT scope,settings_json FROM cli_agent_supervision WHERE scope!=? ORDER BY scope", GLOBAL_SCOPE)) {
      const parsed = JSON.parse(String(row.settings_json)) as { cwd?: string; settings?: unknown };
      workspaces.push({ cwd: parsed.cwd ?? String(row.scope), settings: parseSettings(parsed.settings) ?? {} });
    }
    return { defaults: { ...DEFAULT_SUPERVISION }, global: this.stored(GLOBAL_SCOPE), workspaces, actions: this.actions(20) };
  }

  actions(limit = 50, key?: string): SupervisionAction[] {
    const rows = key
      ? this.store.all("SELECT * FROM cli_agent_supervision_actions WHERE session_key=? ORDER BY created_at DESC,rowid DESC LIMIT ?", key, limit)
      : this.store.all("SELECT * FROM cli_agent_supervision_actions ORDER BY created_at DESC,rowid DESC LIMIT ?", limit);
    return rows.map((row) => this.action(row));
  }

  private action(row: Row): SupervisionAction {
    return {
      id: String(row.id), key: String(row.session_key), turn: Number(row.turn), endedAt: Number(row.ended_at), kind: row.kind as ActionKind,
      attempt: Number(row.attempt), dueAt: Number(row.due_at), status: row.status as ActionStatus,
      ...(row.reason !== null ? { reason: String(row.reason) } : {}), createdAt: Number(row.created_at),
      ...(row.finished_at !== null ? { finishedAt: Number(row.finished_at) } : {}),
    };
  }

  private enabled(kind: ActionKind, settings: SupervisionSettings): boolean {
    return kind === "retry" ? settings.transientRetry : kind === "usage_limit" ? settings.usageLimit : settings.wakeup;
  }

  // -------------------------------------------------------------------------
  // Turn ends

  private onTurn(event: CliTurnEvent) {
    if (this.closed) return;
    // A different turn than the one an action waits for means someone or something moved on.
    for (const row of this.store.all("SELECT id,turn,ended_at FROM cli_agent_supervision_actions WHERE session_key=? AND status='pending'", event.key)) {
      if (Number(row.turn) !== event.turn || Number(row.ended_at) !== event.endedAt) this.finish(String(row.id), "cancelled", "newer_turn");
    }
    const handle = this.settling.get(event.key);
    if (handle !== undefined) { this.clock.clearTimeout(handle); this.settling.delete(event.key); }
    if (event.reason === "end" || event.reason === "interrupted") {
      // the turn our earlier "继续" started ended without an error: the run of retries is over
      this.store.run("UPDATE cli_agent_supervision_actions SET status='recovered',finished_at=? WHERE session_key=? AND status='sent'", this.clock.now(), event.key);
    }
    const session = this.hub.session(event.key);
    if (!session) return;
    const settings = this.settings(session.cwd);
    if (event.reason === "error") this.onError(event, settings);
    else if (event.reason === "end" && settings.wakeup) {
      // the cache needs a moment to receive the closing text
      this.settling.set(event.key, this.clock.setTimeout(() => {
        this.settling.delete(event.key);
        void this.onEnd(event).catch(() => undefined);
      }, WAKEUP_SETTLE_MS));
    }
  }

  private onError(event: CliTurnEvent, settings: SupervisionSettings) {
    const kind = classifyError(event.error);
    if (kind === "usage_limit") {
      if (!settings.usageLimit) return;
      const reset = parseResetTime(event.error ?? "", this.clock.now());
      if (reset === null) { this.record(event, "usage_limit", 1, this.clock.now(), "skipped", "no_reset_time"); return; }
      if (reset - this.clock.now() > USAGE_LIMIT_MAX_MS) { this.record(event, "usage_limit", 1, this.clock.now(), "skipped", "reset_too_far"); return; }
      this.schedule(event, "usage_limit", Math.max(this.clock.now(), reset) + RESET_SETTLE_MS);
      return;
    }
    if (!settings.transientRetry) return;
    if (kind === "other") { this.record(event, "retry", 1, this.clock.now(), "skipped", "not_transient"); return; }
    this.schedule(event, "retry", null, kind === "rate_limit");
  }

  private async onEnd(event: CliTurnEvent) {
    if (this.closed) return;
    const session = this.hub.session(event.key);
    if (!session || !this.settings(session.cwd).wakeup) return;
    const text = this.lastAssistantText(this.hub.recentItems(event.key, 20));
    if (!text) return;
    let waitMs = detectWait(text);
    if (waitMs === null && this.triage) {
      const verdict = await this.triage({ key: event.key, cwd: session.cwd, lastAssistantText: text });
      if (verdict && verdict.waitMs >= WAKEUP_MIN_MS && verdict.waitMs <= WAKEUP_MAX_MS) waitMs = Math.round(verdict.waitMs);
    }
    if (waitMs === null) return;
    this.schedule(event, "wakeup", Math.max(this.clock.now(), event.endedAt + waitMs));
  }

  /** Inserts the action row for this turn (once) and arms its timer. */
  private schedule(event: CliTurnEvent, kind: ActionKind, dueAt: number | null, rateLimited = false) {
    const attempt = this.nextAttempt(event.key);
    if (attempt > RETRY_MAX) { this.record(event, kind, attempt, this.clock.now(), "skipped", "max_attempts"); return; }
    const due = dueAt ?? this.clock.now() + retryDelayMs(attempt, rateLimited);
    const id = this.record(event, kind, attempt, due, "pending");
    if (id) this.arm(id, due);
  }

  /** 1, or one more than the unbroken run of continues already sent for this session. */
  private nextAttempt(key: string): number {
    const last = this.store.get("SELECT attempt FROM cli_agent_supervision_actions WHERE session_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1", key);
    const sent = this.store.get("SELECT attempt FROM cli_agent_supervision_actions WHERE session_key=? AND status='sent' ORDER BY created_at DESC,rowid DESC LIMIT 1", key);
    // only an unbroken run counts: the latest row must itself be a sent continue
    const latest = this.store.get("SELECT status FROM cli_agent_supervision_actions WHERE session_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1", key);
    if (!last || !sent || latest?.status !== "sent") return 1;
    return Number(sent.attempt) + 1;
  }

  private record(event: CliTurnEvent, kind: ActionKind, attempt: number, dueAt: number, status: ActionStatus, reason?: string): string | null {
    const id = randomUUID();
    const at = this.clock.now();
    const inserted = this.store.run(
      "INSERT OR IGNORE INTO cli_agent_supervision_actions(id,session_key,turn,ended_at,kind,attempt,due_at,status,reason,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      id, event.key, event.turn, event.endedAt, kind, attempt, dueAt, status, reason ?? null, at, status === "pending" ? null : at,
    );
    return Number(inserted.changes) ? id : null;
  }

  private arm(id: string, dueAt: number) {
    const old = this.timers.get(id);
    if (old !== undefined) this.clock.clearTimeout(old);
    this.timers.set(id, this.clock.setTimeout(() => {
      this.timers.delete(id);
      void this.run(id).catch(() => undefined);
    }, Math.max(0, dueAt - this.clock.now())));
  }

  private rearm() {
    for (const row of this.store.all("SELECT id,due_at FROM cli_agent_supervision_actions WHERE status='pending'")) {
      if (this.clock.now() - Number(row.due_at) > STALE_MS) this.finish(String(row.id), "cancelled", "stale");
      else this.arm(String(row.id), Number(row.due_at));
    }
  }

  private finish(id: string, status: ActionStatus, reason?: string) {
    const timer = this.timers.get(id);
    if (timer !== undefined) { this.clock.clearTimeout(timer); this.timers.delete(id); }
    this.store.run("UPDATE cli_agent_supervision_actions SET status=?,reason=?,finished_at=? WHERE id=? AND status IN ('pending','sent')", status, reason ?? null, this.clock.now(), id);
  }

  // -------------------------------------------------------------------------
  // Running an action

  private lastAssistantText(newestFirst: CliItem[]): string {
    for (const item of newestFirst) if (item.kind === "assistant" && item.text.trim()) return item.text;
    return "";
  }

  /** Why this action must not run, or null. Reads the session fresh from the device. */
  private async reread(row: Row): Promise<string | null> {
    const key = String(row.session_key);
    const session = this.hub.session(key);
    if (!session) return "gone";
    if (!session.online) return "offline";
    const last = this.hub.lastTurn(key);
    if (last && (last.turn !== Number(row.turn) || last.endedAt !== Number(row.ended_at))) return "newer_turn";
    if (session.state === "running") return "running";
    if (session.state === "waiting") return "waiting";
    if (session.liveIn === "terminal" || session.liveIn === "desktop") return "local_session";
    if (this.hub.requests(key).length) return "pending_request";
    let page: { items: CliItem[] };
    try { page = await this.hub.items(SUPERVISOR_ACTOR, key); } catch { return "read_failed"; }
    const newestFirst = [...page.items].reverse();
    const endedAt = Number(row.ended_at);
    const at = this.clock.now();
    for (const item of newestFirst) {
      if (item.kind === "user" && at - item.ts < LOCAL_INPUT_MS) return "recent_input";
      if (item.ts <= endedAt + 1000) continue;
      if (item.kind === "user" || item.kind === "tool" || item.kind === "assistant" || (item.kind === "turn" && item.phase === "started")) return "activity_after_turn";
    }
    const text = this.lastAssistantText(newestFirst) || this.lastAssistantText(this.hub.recentItems(key, 20));
    const turnError = this.hub.lastTurn(key)?.error ?? "";
    if (BOUNDARY_RE.test(`${text}\n${session.waitingFor ?? ""}\n${turnError}`)) return "boundary";
    return null;
  }

  private async run(id: string) {
    if (this.closed || this.running.has(id)) return;
    const row = this.store.get("SELECT * FROM cli_agent_supervision_actions WHERE id=? AND status='pending'", id);
    if (!row) return;
    this.running.add(id);
    try {
      const key = String(row.session_key);
      const session = this.hub.session(key);
      if (!session) { this.finish(id, "skipped", "gone"); return; }
      if (!this.enabled(String(row.kind) as ActionKind, this.settings(session.cwd))) { this.finish(id, "cancelled", "disabled"); return; }
      const reason = await this.reread(row);
      if (this.closed) return;
      // the row may have been cancelled while the device was being read
      if (!this.store.get("SELECT id FROM cli_agent_supervision_actions WHERE id=? AND status='pending'", id)) return;
      if (reason) { this.finish(id, "skipped", reason); return; }
      // claim before sending: a second run of this row finds it no longer pending
      this.store.run("UPDATE cli_agent_supervision_actions SET status='sent',finished_at=? WHERE id=? AND status='pending'", this.clock.now(), id);
      this.store.audit("cli.supervise", "cli_session", key, { kind: row.kind, turn: Number(row.turn), attempt: Number(row.attempt) });
      try {
        await this.hub.send(SUPERVISOR_ACTOR, key, CONTINUE_TEXT);
      } catch (error) {
        if (error instanceof CliOpError && error.code !== "unknown") {
          this.store.run("UPDATE cli_agent_supervision_actions SET status='failed',reason=?,finished_at=? WHERE id=?", error.code, this.clock.now(), id);
        } else {
          // the device may have acted: stays `sent`, and is never repeated
          this.store.run("UPDATE cli_agent_supervision_actions SET reason='unknown' WHERE id=?", id);
        }
      }
    } finally {
      this.running.delete(id);
    }
  }
}
