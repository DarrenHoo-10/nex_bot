// Claude Code session discovery (plan 3.3): live sessions from
// `<configDir>/sessions/<pid>.json` and history from
// `<configDir>/projects/*/<sessionId>.jsonl`, merged by session id.
//
// Never reads `*.key` files (inbox tokens). The module keeps no timers; the
// SessionDiscovery owns the schedule.
import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CLI_LIMITS, HISTORY_DAYS, MAX_SESSIONS, isCliNativeId, type CliLiveIn, type CliSessionState } from "../../../shared/cli-agents.ts";
import { clipUnits, type LocalSession } from "./items.ts";
import { isPidAlive, processStartTimes, sameProcessStart, type ProcessStartOptions } from "./liveness.ts";

const EDGE_BYTES = 64 * 1024;
const TITLE_CHARS = 60;
const DAY_MS = 86_400_000;

/** `~/.claude` plus `CLAUDE_CONFIG_DIR`, without duplicates. */
export function claudeConfigDirs(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string[] {
  const dirs = [path.resolve(home, ".claude")];
  const extra = env.CLAUDE_CONFIG_DIR?.trim();
  if (extra) dirs.push(path.resolve(extra));
  const seen = new Set<string>();
  return dirs.filter((dir) => {
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Live sessions

export interface LiveClaudeSession {
  sessionId: string;
  pid: number;
  cwd: string;
  kind?: string;
  entrypoint?: string;
  state: CliSessionState;
  waitingFor?: string;
  name?: string;
  nameSource?: string;
  version?: string;
  /** epoch ms */
  updatedAt: number;
  /** liveIn derived from kind/entrypoint; the nex_bot terminal table is applied later */
  liveIn?: CliLiveIn;
  /** the process start time could not be compared (query failed or unknown format) */
  unverified: boolean;
}

export interface ScanLiveOptions {
  /** defaults to process.kill(pid, 0) */
  isAlive?: (pid: number) => boolean;
  /** passed to processStartTimes (platform, runner, cache clock) */
  start?: ProcessStartOptions;
}

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** sessions/*.json status to the row state. */
export function claudeState(status: unknown): CliSessionState {
  switch (status) {
    case "busy":
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    default:
      return "idle"; // idle, shell and anything new
  }
}

/** entrypoint/kind to where the session is open. A background job is not in a
 * terminal even when it was started from the CLI, so the kind wins. */
export function claudeLiveIn(entrypoint: string | undefined, kind: string | undefined): CliLiveIn | undefined {
  if (kind && /^(bg|background|daemon)/i.test(kind)) return "background";
  if (entrypoint === "cli") return "terminal";
  if (entrypoint?.startsWith("claude-desktop")) return "desktop";
  return undefined;
}

function epochMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
}

/** Pid files in `<configDir>/sessions`, with dead and reused pids removed. */
export async function scanLive(configDir: string, options: ScanLiveOptions = {}): Promise<LiveClaudeSession[]> {
  const dir = path.join(configDir, "sessions");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const isAlive = options.isAlive ?? isPidAlive;
  const candidates: { file: Rec; pid: number; sessionId: string }[] = [];
  for (const name of names) {
    // `<pid>.json` only: `*.key` holds inbox tokens and is never opened
    if (!/^\d+\.json$/.test(name)) continue;
    let file: Rec | null;
    try {
      file = asRec(JSON.parse(await readUtf8(path.join(dir, name))));
    } catch {
      continue;
    }
    if (!file) continue;
    const pid = typeof file.pid === "number" ? file.pid : Number(name.slice(0, -5));
    const sessionId = text(file.sessionId);
    if (!Number.isInteger(pid) || pid <= 0 || !sessionId || !isCliNativeId(sessionId)) continue;
    if (!isAlive(pid)) continue;
    candidates.push({ file, pid, sessionId });
  }
  if (candidates.length === 0) return [];
  let starts: Map<number, string | null>;
  try {
    starts = await processStartTimes(
      candidates.map((c) => c.pid),
      options.start,
    );
  } catch {
    starts = new Map();
  }
  const platform = options.start?.platform ?? process.platform;
  const bySession = new Map<string, LiveClaudeSession>();
  for (const { file, pid, sessionId } of candidates) {
    const recorded = recordedStart(file, platform);
    const verdict = sameProcessStart(recorded, starts.get(pid));
    if (verdict === "mismatch") continue; // the pid now belongs to another process
    const entrypoint = text(file.entrypoint);
    const kind = text(file.kind);
    const state = claudeState(file.status);
    const nameSource = text(file.nameSource);
    const session: LiveClaudeSession = {
      sessionId,
      pid,
      cwd: clipUnits(text(file.cwd) ?? "", CLI_LIMITS.cwd),
      state,
      updatedAt: epochMs(file.updatedAt),
      unverified: verdict === "unverified",
    };
    if (kind) session.kind = kind;
    if (entrypoint) session.entrypoint = entrypoint;
    if (state === "waiting") {
      const waitingFor = text(file.waitingFor);
      if (waitingFor) session.waitingFor = clipUnits(waitingFor, CLI_LIMITS.waitingFor);
    }
    const name = text(file.name);
    if (name) session.name = name;
    if (nameSource) session.nameSource = nameSource;
    const version = text(file.version);
    if (version) session.version = clipUnits(version, CLI_LIMITS.cliVersion);
    const liveIn = claudeLiveIn(entrypoint, kind);
    if (liveIn) session.liveIn = liveIn;
    const previous = bySession.get(sessionId);
    if (!previous || session.updatedAt >= previous.updatedAt) bySession.set(sessionId, session);
  }
  return [...bySession.values()];
}

/** The start time Claude recorded for this platform's flavour, or undefined
 * when only the other flavour is present (never compared across flavours). */
function recordedStart(file: Rec, platform: NodeJS.Platform): unknown {
  if (platform === "win32") {
    const ft = file.procStartFt;
    if (typeof ft === "number" || (typeof ft === "string" && /^\d+$/.test(ft.trim()))) return ft;
    return undefined;
  }
  const lstart = file.procStart;
  return typeof lstart === "string" && !/^\d+$/.test(lstart.trim()) ? lstart : undefined;
}

async function readUtf8(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    const size = Math.min(info.size, 256 * 1024);
    const buf = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buf, 0, size, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// History

export interface ClaudeHistoryEntry {
  sessionId: string;
  transcript: string;
  mtimeMs: number;
  size: number;
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  version?: string;
  model?: string;
  mode?: string;
  customTitle?: string;
  agentName?: string;
  /** first user text, whitespace collapsed, at most 60 characters */
  firstUser?: string;
  /** epoch ms of the last record that has a timestamp */
  lastTimestamp?: number;
}

export interface HistoryCache {
  get(file: string): { size: number; mtimeMs: number; entry: ClaudeHistoryEntry | null } | undefined;
  set(file: string, value: { size: number; mtimeMs: number; entry: ClaudeHistoryEntry | null }): void;
  delete(file: string): void;
  keys(): IterableIterator<string>;
}

const defaultCache = new Map<string, { size: number; mtimeMs: number; entry: ClaudeHistoryEntry | null }>();

/** Clears the process-wide parse cache (tests). */
export function resetClaudeHistoryCache(): void {
  defaultCache.clear();
}

export interface ScanHistoryOptions {
  now?: number;
  /** session ids that must be found even when older than the window or beyond the cap (live sessions) */
  include?: Iterable<string>;
  cache?: HistoryCache;
  maxSessions?: number;
  historyDays?: number;
}

/** Transcripts under `projects/*` modified within HISTORY_DAYS, newest first,
 * at most MAX_SESSIONS, plus any `include`d session ids. Files whose
 * (size, mtimeMs) did not change are not read again. */
export async function scanHistory(configDir: string, options: ScanHistoryOptions = {}): Promise<ClaudeHistoryEntry[]> {
  const now = options.now ?? Date.now();
  const cache = options.cache ?? defaultCache;
  const cutoff = now - (options.historyDays ?? HISTORY_DAYS) * DAY_MS;
  const max = options.maxSessions ?? MAX_SESSIONS;
  const projects = path.join(configDir, "projects");
  let dirs: string[];
  try {
    dirs = (await readdir(projects, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => path.join(projects, d.name));
  } catch {
    return [];
  }
  const found: { file: string; sessionId: string; size: number; mtimeMs: number }[] = [];
  const include = new Set(options.include ?? []);
  const wanted: { file: string; sessionId: string; size: number; mtimeMs: number }[] = [];
  for (let i = 0; i < dirs.length; i += 16) {
    await Promise.all(
      dirs.slice(i, i + 16).map(async (dir) => {
        let names: string[];
        try {
          names = await readdir(dir);
        } catch {
          return;
        }
        for (const name of names) {
          // top-level files only: `<sessionId>/subagents/*.jsonl` lives one level deeper
          if (!name.endsWith(".jsonl")) continue;
          const sessionId = name.slice(0, -6);
          if (!isCliNativeId(sessionId)) continue;
          const file = path.join(dir, name);
          let info;
          try {
            info = await stat(file);
          } catch {
            continue;
          }
          if (!info.isFile()) continue;
          const entry = { file, sessionId, size: info.size, mtimeMs: info.mtimeMs };
          if (info.mtimeMs >= cutoff) found.push(entry);
          else if (include.has(sessionId)) wanted.push(entry);
        }
      }),
    );
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const chosen = found.slice(0, max);
  const chosenIds = new Set(chosen.map((f) => f.sessionId));
  for (const f of found.slice(max)) if (include.has(f.sessionId)) chosen.push(f);
  for (const f of wanted) if (!chosenIds.has(f.sessionId)) chosen.push(f);
  const keep = new Set(chosen.map((f) => f.file));
  for (const key of cache.keys()) if (!keep.has(key) && key.startsWith(projects)) cache.delete(key);
  const out: ClaudeHistoryEntry[] = [];
  for (let i = 0; i < chosen.length; i += 8) {
    const batch = await Promise.all(
      chosen.slice(i, i + 8).map(async (f) => {
        const cached = cache.get(f.file);
        if (cached && cached.size === f.size && cached.mtimeMs === f.mtimeMs) return cached.entry;
        const entry = await parseTranscriptEdges(f.file, f.sessionId, f.size, f.mtimeMs);
        cache.set(f.file, { size: f.size, mtimeMs: f.mtimeMs, entry });
        return entry;
      }),
    );
    for (const entry of batch) if (entry) out.push(entry);
  }
  return out;
}

const NOISE = /^\s*<(command-name|command-message|command-args|local-command-|system-reminder|ide_|user-prompt-submit-hook)/;

function userText(record: Rec): string | undefined {
  const message = asRec(record.message);
  const content = message?.content;
  const parts: string[] = [];
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      const b = asRec(block);
      if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  const kept = parts.filter((p) => p.trim() !== "" && !NOISE.test(p));
  if (kept.length === 0) return undefined;
  return kept.join("\n");
}

function shortTitle(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return Array.from(collapsed).slice(0, TITLE_CHARS).join("");
}

async function readRange(handle: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buf, read, length - read, position + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return buf.subarray(0, read);
}

function jsonLines(buf: Buffer, dropFirst: boolean): Rec[] {
  const lines = buf.toString("utf8").split("\n");
  if (dropFirst) lines.shift();
  const out: Rec[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const rec = asRec(JSON.parse(trimmed));
      if (rec) out.push(rec);
    } catch {
      // a cut or half-written line
    }
  }
  return out;
}

/** Head 64 KB and tail 64 KB of one transcript. Null for a sidechain file. */
export async function parseTranscriptEdges(
  file: string,
  sessionId: string,
  size: number,
  mtimeMs: number,
): Promise<ClaudeHistoryEntry | null> {
  let head: Rec[] = [];
  let tail: Rec[] = [];
  let handle;
  try {
    handle = await open(file, "r");
    const headBuf = await readRange(handle, 0, Math.min(size, EDGE_BYTES));
    head = jsonLines(headBuf, false);
    if (size > EDGE_BYTES) {
      const from = Math.max(0, size - EDGE_BYTES);
      tail = jsonLines(await readRange(handle, from, size - from), from > 0);
    } else tail = head;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
  if (head[0]?.isSidechain === true) return null;
  const entry: ClaudeHistoryEntry = { sessionId, transcript: file, mtimeMs, size };
  for (const rec of head) {
    if (!entry.cwd && text(rec.cwd)) entry.cwd = text(rec.cwd);
    if (!entry.gitBranch && text(rec.gitBranch)) entry.gitBranch = text(rec.gitBranch);
    if (!entry.entrypoint && text(rec.entrypoint)) entry.entrypoint = text(rec.entrypoint);
    if (!entry.version && text(rec.version)) entry.version = text(rec.version);
    if (!entry.firstUser && rec.type === "user" && rec.isMeta !== true && rec.isSidechain !== true) {
      const t = userText(rec);
      if (t) entry.firstUser = shortTitle(t);
    }
    if (rec.type === "custom-title" && typeof rec.customTitle === "string") entry.customTitle = rec.customTitle.trim() || undefined;
  }
  let lastTs: number | undefined;
  for (const rec of tail) {
    if (rec.type === "custom-title" && typeof rec.customTitle === "string") entry.customTitle = rec.customTitle.trim() || undefined;
    else if (rec.type === "agent-name" && typeof rec.agentName === "string") entry.agentName = rec.agentName.trim() || undefined;
    else if (rec.type === "mode" && typeof rec.mode === "string") entry.mode = rec.mode;
    else if (rec.type === "assistant") {
      const model = text(asRec(rec.message)?.model);
      if (model && model !== "<synthetic>") entry.model = model;
    }
    if (typeof rec.timestamp === "string") {
      const ts = Date.parse(rec.timestamp);
      if (Number.isFinite(ts)) lastTs = ts;
    }
    if (!entry.cwd && text(rec.cwd)) entry.cwd = text(rec.cwd);
    if (!entry.gitBranch && text(rec.gitBranch)) entry.gitBranch = text(rec.gitBranch);
  }
  if (lastTs !== undefined) entry.lastTimestamp = lastTs;
  return entry;
}

// ---------------------------------------------------------------------------
// Merge

/** customTitle, then the live file's name (unless derived), then agentName,
 * then the first user text. */
export function claudeTitle(entry: ClaudeHistoryEntry | undefined, live: LiveClaudeSession | undefined): string {
  const liveName = live?.name && live.nameSource !== "derived" ? live.name : undefined;
  return clipUnits(entry?.customTitle || liveName || entry?.agentName || entry?.firstUser || "", CLI_LIMITS.title);
}

/** One row per session id. A session without a live process is `stopped`; a
 * live session without a transcript yet has an empty `transcript`. */
export function mergeClaude(configDir: string, live: readonly LiveClaudeSession[], history: readonly ClaudeHistoryEntry[]): LocalSession[] {
  const liveById = new Map(live.map((l) => [l.sessionId, l]));
  const rows: LocalSession[] = [];
  const seen = new Set<string>();
  const dirText = clipUnits(configDir, CLI_LIMITS.configDir);
  for (const entry of history) {
    if (seen.has(entry.sessionId)) continue;
    seen.add(entry.sessionId);
    rows.push(row(dirText, entry.sessionId, entry, liveById.get(entry.sessionId)));
  }
  for (const l of live) {
    if (seen.has(l.sessionId)) continue;
    seen.add(l.sessionId);
    rows.push(row(dirText, l.sessionId, undefined, l));
  }
  return rows;
}

function row(configDir: string, sessionId: string, entry: ClaudeHistoryEntry | undefined, live: LiveClaudeSession | undefined): LocalSession {
  const base = entry?.lastTimestamp ?? entry?.mtimeMs ?? 0;
  const result: LocalSession = {
    engine: "claude",
    nativeId: sessionId,
    configDir,
    cwd: clipUnits(live?.cwd || entry?.cwd || "", CLI_LIMITS.cwd),
    title: claudeTitle(entry, live),
    state: live ? live.state : "stopped",
    lastActivityAt: Math.max(0, Math.round(live ? Math.max(base, live.updatedAt) : base)),
    transcript: entry?.transcript ?? "",
  };
  if (entry?.gitBranch) result.gitBranch = clipUnits(entry.gitBranch, CLI_LIMITS.gitBranch);
  if (live?.waitingFor) result.waitingFor = live.waitingFor;
  if (live?.liveIn) result.liveIn = live.liveIn;
  if (entry?.model) result.model = clipUnits(entry.model, CLI_LIMITS.model);
  const version = live?.version ?? entry?.version;
  if (version) result.cliVersion = clipUnits(version, CLI_LIMITS.cliVersion);
  return result;
}
