// Claude Code session discovery (plan 3.3): live sessions from
// `<configDir>/sessions/<pid>.json` and history from
// `<configDir>/projects/*/<sessionId>.jsonl`, merged by session id.
//
// Never reads `*.key` files (inbox tokens): scanning only notes where a live
// session's inbox is. `inbox.ts` opens the one key of the session it sends to, at
// send time. The module keeps no timers; the SessionDiscovery owns the schedule.
import { cp, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CLI_LIMITS, MAX_SESSIONS, isCliNativeId, unwrapPastedContent, type CliLiveIn, type CliSessionState } from "../../../shared/cli-agents.ts";
import { claudeUsed, claudeWindow } from "./context-usage.ts";
import { deleteClaudeDesktopEntries, desktopHides, EMPTY_DESKTOP_INDEX, setClaudeDesktopArchived, type DesktopIndex, type DesktopSessionState } from "./claude-desktop.ts";
import { clipUnits, type LocalSession } from "./items.ts";
import { isPidAlive, processStartTimes, sameProcessStart, type ProcessStartOptions } from "./liveness.ts";

const EDGE_BYTES = 64 * 1024;
const TITLE_CHARS = 60;
const DAY_MS = 86_400_000;
const SOCKET_PATH_MAX = 512;
/** The only inbox protocol version this module speaks. */
export const INBOX_PEER_PROTOCOL = 1;

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
  /** where the session's inbox listens (named pipe or unix socket); device only */
  messagingSocketPath?: string;
  /** the inbox protocol version the session speaks */
  peerProtocol?: number;
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
    const socket = text(file.messagingSocketPath);
    if (socket && socket.length <= SOCKET_PATH_MAX) session.messagingSocketPath = socket;
    if (typeof file.peerProtocol === "number" && Number.isInteger(file.peerProtocol)) session.peerProtocol = file.peerProtocol;
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
  /** the last entrypoint the transcript's tail names: a session can move between clients */
  lastEntrypoint?: string;
  version?: string;
  model?: string;
  mode?: string;
  customTitle?: string;
  agentName?: string;
  /** first user text, whitespace collapsed, at most 60 characters */
  firstUser?: string;
  /** epoch ms of the last record that has a timestamp */
  lastTimestamp?: number;
  /** epoch ms the transcript file was created (mtime where the file system has no birth time) */
  bornMs?: number;
  /** the session id the transcript itself names as its fork parent (`forkedFrom`), when it does */
  forkedFrom?: string;
  /** tokens the last main-thread request carried */
  contextUsed?: number;
  /** true when read from `<configDir>/archived-projects/` */
  archived?: boolean;
}

/** A claude an SDK runs (`sdk-ts`, `sdk-py`, `sdk-cli`): while it runs it belongs to
 * its host, so it is not listed as a running session of the user's. */
export function isSdkEntrypoint(entrypoint: string | undefined): boolean {
  return typeof entrypoint === "string" && /^sdk/i.test(entrypoint);
}

/** A program's one-shot `claude -p` run (`sdk-cli` from its first entrypoint to its
 * last): not a conversation to list. The Agent SDKs' runs (`sdk-ts`, `sdk-py`) are
 * listed, since interactive hosts run the user's sessions through them, and so is a
 * session that was also used from a terminal or the app, either way round. */
export function isClaudeOneShot(entry: Pick<ClaudeHistoryEntry, "entrypoint" | "lastEntrypoint">): boolean {
  return entry.entrypoint === "sdk-cli" && (entry.lastEntrypoint === undefined || entry.lastEntrypoint === "sdk-cli");
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

/** Transcripts under `projects/*` (and archived transcripts under `archived-projects/*`),
 * newest first, at most MAX_SESSIONS, plus any `include`d session ids. When
 * `historyDays` is omitted there is no age cutoff. Files whose (size, mtimeMs)
 * did not change are not read again. */
export async function scanHistory(configDir: string, options: ScanHistoryOptions = {}): Promise<ClaudeHistoryEntry[]> {
  const now = options.now ?? Date.now();
  const cache = options.cache ?? defaultCache;
  const cutoff = options.historyDays === undefined ? Number.NEGATIVE_INFINITY : now - options.historyDays * DAY_MS;
  const max = options.maxSessions ?? MAX_SESSIONS;
  const projects = path.join(configDir, "projects");
  const archivedProjects = path.join(configDir, "archived-projects");
  type Candidate = { file: string; sessionId: string; size: number; mtimeMs: number; bornMs: number; archived: boolean };
  const found: Candidate[] = [];
  const archivedFound: Candidate[] = [];
  const include = new Set(options.include ?? []);
  const wanted: Candidate[] = [];
  const scanRoot = async (rootDir: string, archived: boolean): Promise<void> => {
    let dirs: string[];
    try {
      dirs = (await readdir(rootDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => path.join(rootDir, d.name));
    } catch {
      return;
    }
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
            const entry: Candidate = { file, sessionId, size: info.size, mtimeMs: info.mtimeMs, bornMs: info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs, archived };
            if (archived) archivedFound.push(entry);
            else if (info.mtimeMs >= cutoff) found.push(entry);
            else if (include.has(sessionId)) wanted.push(entry);
          }
        }),
      );
    }
  };
  await Promise.all([scanRoot(projects, false), scanRoot(archivedProjects, true)]);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  archivedFound.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const load = async (f: Candidate): Promise<ClaudeHistoryEntry | null> => {
    const cached = cache.get(f.file);
    if (cached && cached.size === f.size && cached.mtimeMs === f.mtimeMs) {
      return cached.entry ? { ...cached.entry, ...(f.archived ? { archived: true } : {}) } : null;
    }
    const entry = await parseTranscriptEdges(f.file, f.sessionId, f.size, f.mtimeMs, f.bornMs);
    cache.set(f.file, { size: f.size, mtimeMs: f.mtimeMs, entry });
    return entry ? { ...entry, ...(f.archived ? { archived: true } : {}) } : null;
  };
  // Newest first, until `max` sessions that count: sidechain and SDK transcripts
  // are parsed (once, then cached as excluded) but never use up the cap, so a
  // pile of automation runs cannot push real conversations out of the list.
  const out: ClaudeHistoryEntry[] = [];
  const visited = new Set<string>();
  const ids = new Set<string>();
  let next = 0;
  while (next < found.length && out.length < max) {
    const batch = found.slice(next, next + 8);
    next += batch.length;
    const entries = await Promise.all(batch.map(load));
    batch.forEach((f, i) => {
      visited.add(f.file);
      const entry = entries[i];
      // a live session (`include`) is kept even when the batch it was parsed in overshoots the cap
      if (entry && (out.length < max || include.has(f.sessionId))) {
        out.push(entry);
        ids.add(f.sessionId);
      }
    });
  }
  // live sessions beyond the cap and transcripts outside the window are still wanted
  const extra = [...found.slice(next).filter((f) => include.has(f.sessionId)), ...wanted].filter((f) => !ids.has(f.sessionId));
  for (let i = 0; i < extra.length; i += 8) {
    const batch = extra.slice(i, i + 8);
    const entries = await Promise.all(batch.map(load));
    batch.forEach((f, j) => {
      visited.add(f.file);
      const entry = entries[j];
      if (entry && !ids.has(f.sessionId)) {
        out.push(entry);
        ids.add(f.sessionId);
      }
    });
  }
  // archived CLI transcripts fill up to `max` total without evicting active sessions
  for (let i = 0; i < archivedFound.length && out.length < max; i += 8) {
    const batch = archivedFound.slice(i, i + 8);
    const entries = await Promise.all(batch.map(load));
    batch.forEach((f, j) => {
      visited.add(f.file);
      const entry = entries[j];
      if (entry && !ids.has(f.sessionId) && out.length < max) {
        out.push(entry);
        ids.add(f.sessionId);
      }
    });
  }
  for (const key of cache.keys()) if (!visited.has(key) && (key.startsWith(projects) || key.startsWith(archivedProjects))) cache.delete(key);
  return out;
}

const NOISE = /^\s*<(command-name|command-message|command-args|local-command-|system-reminder|ide_|user-prompt-submit-hook|agent-message|cross-session-message|teammate-message)/;

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
  return unwrapPastedContent(kept.join("\n")) || undefined;
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
  bornMs: number = mtimeMs,
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
  const entry: ClaudeHistoryEntry = { sessionId, transcript: file, mtimeMs, size, bornMs };
  for (const rec of head) {
    if (!entry.forkedFrom) {
      const parent = asRec(rec.forkedFrom)?.sessionId;
      if (typeof parent === "string" && parent !== sessionId && isCliNativeId(parent)) entry.forkedFrom = parent;
    }
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
    if (text(rec.entrypoint)) entry.lastEntrypoint = text(rec.entrypoint);
    if (rec.type === "custom-title" && typeof rec.customTitle === "string") entry.customTitle = rec.customTitle.trim() || undefined;
    else if (rec.type === "agent-name" && typeof rec.agentName === "string") entry.agentName = rec.agentName.trim() || undefined;
    else if (rec.type === "mode" && typeof rec.mode === "string") entry.mode = rec.mode;
    else if (rec.type === "assistant") {
      const model = text(asRec(rec.message)?.model);
      if (model && model !== "<synthetic>") entry.model = model;
      // a subagent's request counts against its own context, not the session's
      const used = rec.isSidechain === true ? 0 : claudeUsed(asRec(rec.message)?.usage);
      if (used) entry.contextUsed = used;
    }
    if (typeof rec.timestamp === "string") {
      const ts = Date.parse(rec.timestamp);
      if (Number.isFinite(ts)) lastTs = ts;
    }
    if (!entry.cwd && text(rec.cwd)) entry.cwd = text(rec.cwd);
    if (!entry.gitBranch && text(rec.gitBranch)) entry.gitBranch = text(rec.gitBranch);
  }
  if (lastTs !== undefined) entry.lastTimestamp = lastTs;
  if (isClaudeOneShot(entry)) return null;
  return entry;
}

// ---------------------------------------------------------------------------
// Merge

/** customTitle, then the live file's name (unless derived), then agentName, then
 * the desktop app's sidebar title, then the first user text. */
export function claudeTitle(entry: ClaudeHistoryEntry | undefined, live: LiveClaudeSession | undefined, sidebarTitle?: string): string {
  const liveName = live?.name && live.nameSource !== "derived" ? live.name : undefined;
  return clipUnits(entry?.customTitle || liveName || entry?.agentName || sidebarTitle || entry?.firstUser || "", CLI_LIMITS.title);
}

/** One row per session id. A session without a live process is `stopped`; a
 * live session without a transcript yet has an empty `transcript`. */
export function mergeClaude(
  configDir: string,
  live: readonly LiveClaudeSession[],
  history: readonly ClaudeHistoryEntry[],
  options: { desktop?: DesktopIndex; now?: number } = {},
): LocalSession[] {
  const desktop = options.desktop ?? EMPTY_DESKTOP_INDEX;
  const now = options.now ?? Date.now();
  // a claude an SDK runs belongs to its host while it runs: its transcript is listed, not the process
  const liveById = new Map(live.filter((l) => !isSdkEntrypoint(l.entrypoint)).map((l) => [l.sessionId, l]));
  const mtimes = new Map(history.map((e) => [e.sessionId, e.mtimeMs]));
  const listed = new Set([...mtimes.keys(), ...liveById.keys()]);
  const rows: LocalSession[] = [];
  const seen = new Set<string>();
  const kept: ClaudeHistoryEntry[] = [];
  for (const entry of history) {
    if (seen.has(entry.sessionId)) continue;
    seen.add(entry.sessionId);
    const liveRow = liveById.get(entry.sessionId);
    // the desktop app's sidebar: archived, an earlier transcript of a session listed by its
    // current one, or a session deleted in the app. A running session always stays.
    const hidden = desktopHides(desktop, entry.sessionId, {
      entrypoint: entry.lastEntrypoint ?? entry.entrypoint,
      mtimeMs: entry.mtimeMs,
      running: !!liveRow,
      now,
      listed,
      mtimeOf: (id) => mtimes.get(id),
    });
    if (hidden === "earlier" || hidden === "deleted") continue;
    // Prior transcripts of an archived desktop session stay hidden; only the session's current transcript is shown as archived.
    if (hidden === "archived" && !desktop.sessions.has(entry.sessionId)) continue;
    const archived = !liveRow && (hidden === "archived" || entry.archived === true);
    kept.push(entry);
    rows.push(row(configDir, entry.sessionId, entry, liveRow, desktop.sessions.get(entry.sessionId), archived));
  }
  for (const l of liveById.values()) {
    if (seen.has(l.sessionId)) continue;
    seen.add(l.sessionId);
    rows.push(row(configDir, l.sessionId, undefined, l, desktop.sessions.get(l.sessionId), false));
  }
  const visible = new Set(rows.map((r) => r.nativeId));
  const { forks, sides } = claudeLineage(kept, visible, desktop);
  for (const r of rows) {
    const side = sides.get(r.nativeId);
    if (side) r.sideOf = side;
    else {
      const parent = forks.get(r.nativeId);
      if (parent) r.forkOf = parent;
    }
  }
  return rows;
}

/** Which session each one came from, only among `visible` ids so a parent is always
 * a row the caller can find. Only what is recorded counts, never a guess from copied
 * history (a resume or a rewind copies it too): the desktop app's index
 * (`spawnedFrom`, else `forkedFromSessionId`), else the `forkedFrom` a transcript
 * names. A /btw question is a side chat of its parent (`sides`), the rest are
 * children (`forks`). */
export function claudeLineage(
  entries: readonly ClaudeHistoryEntry[],
  visible: ReadonlySet<string>,
  desktop: DesktopIndex = EMPTY_DESKTOP_INDEX,
): { forks: Map<string, string>; sides: Map<string, string> } {
  const parents = new Map<string, string>();
  const sides = new Map<string, string>();
  const byId = new Map(entries.map((e) => [e.sessionId, e]));
  const ids = new Set([...byId.keys(), ...visible]);
  for (const id of ids) {
    const recorded = desktop.sessions.get(id);
    const entry = byId.get(id);
    const parent = recorded?.parent ?? entry?.forkedFrom;
    if (!parent || parent === id || !visible.has(parent) || !visible.has(id)) continue;
    if (recorded?.parent && recorded.side) sides.set(id, parent);
    else parents.set(id, parent);
  }
  // recorded ids could still loop (a hand-edited index): a loop links nothing
  for (const id of parents.keys()) {
    const seen = new Set<string>([id]);
    for (let at = parents.get(id); at; at = parents.get(at)) {
      if (seen.has(at)) {
        parents.delete(id);
        break;
      }
      seen.add(at);
    }
  }
  return { forks: parents, sides };
}

function row(
  rawConfigDir: string,
  sessionId: string,
  entry: ClaudeHistoryEntry | undefined,
  live: LiveClaudeSession | undefined,
  sidebar?: DesktopSessionState,
  archived = false,
): LocalSession {
  const configDir = clipUnits(rawConfigDir, CLI_LIMITS.configDir);
  const base = entry?.lastTimestamp ?? entry?.mtimeMs ?? 0;
  const result: LocalSession = {
    engine: "claude",
    nativeId: sessionId,
    configDir,
    cwd: clipUnits(live?.cwd || entry?.cwd || sidebar?.cwd || "", CLI_LIMITS.cwd),
    title: claudeTitle(entry, live, sidebar?.title),
    state: live ? live.state : "stopped",
    lastActivityAt: Math.max(0, Math.round(live ? Math.max(base, live.updatedAt) : base)),
    transcript: entry?.transcript ?? "",
  };
  if (archived) result.archived = true;
  if (entry?.gitBranch) result.gitBranch = clipUnits(entry.gitBranch, CLI_LIMITS.gitBranch);
  if (live?.waitingFor) result.waitingFor = live.waitingFor;
  if (live?.liveIn) result.liveIn = live.liveIn;
  // a live session of the user's own terminal or the desktop app takes messages through its inbox
  if (live?.messagingSocketPath && live.peerProtocol === INBOX_PEER_PROTOCOL) {
    result.sendVia = "inbox";
    result.route = { via: "inbox", configDir: rawConfigDir, pid: live.pid, socketPath: live.messagingSocketPath, sessionId };
  }
  if (entry?.model) result.model = clipUnits(entry.model, CLI_LIMITS.model);
  if (entry?.contextUsed) result.context = { used: entry.contextUsed, window: claudeWindow(rawConfigDir, entry.model, entry.contextUsed, process.env, sidebar?.model) };
  const version = live?.version ?? entry?.version;
  if (version) result.cliVersion = clipUnits(version, CLI_LIMITS.cliVersion);
  return result;
}

async function movePath(src: string, dst: string): Promise<void> {
  await mkdir(path.dirname(dst), { recursive: true });
  try {
    await rename(src, dst);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(src, dst, { recursive: true, force: true });
    await rm(src, { recursive: true, force: true });
  }
}

async function findClaudeTranscripts(rootDir: string, sessionId: string): Promise<Array<{ projectDir: string; file: string; subdir: string }>> {
  const matches: Array<{ projectDir: string; file: string; subdir: string }> = [];
  let dirs: string[];
  try {
    dirs = (await readdir(rootDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return matches;
  }
  for (const projectDir of dirs) {
    const file = path.join(rootDir, projectDir, `${sessionId}.jsonl`);
    const info = await stat(file).catch(() => null);
    if (info?.isFile()) {
      matches.push({ projectDir, file, subdir: path.join(rootDir, projectDir, sessionId) });
    }
  }
  return matches;
}

/** Natively archives or restores a Claude Code session. For Claude Desktop sessions this toggles
 * `isArchived` in `local_<uuid>.json`; for pure CLI sessions it moves the transcript between
 * `<configDir>/projects/<project>/` and `<configDir>/archived-projects/<project>/` so `claude --resume`
 * genuinely hides/restores it. */
export async function archiveClaudeSession(
  configDir: string,
  sessionId: string,
  archived: boolean,
  desktopRoots: readonly string[] = [],
): Promise<boolean> {
  if (!isCliNativeId(sessionId)) return false;
  const projects = path.join(configDir, "projects");
  const archivedProjects = path.join(configDir, "archived-projects");
  const desktopHit = desktopRoots.length ? await setClaudeDesktopArchived(desktopRoots, sessionId, archived) : false;
  if (desktopHit) {
    if (!archived) {
      const moved = await findClaudeTranscripts(archivedProjects, sessionId);
      for (const m of moved) {
        await movePath(m.file, path.join(projects, m.projectDir, `${sessionId}.jsonl`));
        if ((await stat(m.subdir).catch(() => null))?.isDirectory()) {
          await movePath(m.subdir, path.join(projects, m.projectDir, sessionId));
        }
        defaultCache.delete(m.file);
      }
    }
    return true;
  }
  const fromRoot = archived ? projects : archivedProjects;
  const toRoot = archived ? archivedProjects : projects;
  const hits = await findClaudeTranscripts(fromRoot, sessionId);
  if (hits.length) {
    for (const m of hits) {
      await movePath(m.file, path.join(toRoot, m.projectDir, `${sessionId}.jsonl`));
      if ((await stat(m.subdir).catch(() => null))?.isDirectory()) {
        await movePath(m.subdir, path.join(toRoot, m.projectDir, sessionId));
      }
      defaultCache.delete(m.file);
    }
    return true;
  }
  // Idempotent when already in the requested state.
  const already = await findClaudeTranscripts(toRoot, sessionId);
  return already.length > 0;
}

/** Permanently deletes a Claude Code / Claude Desktop session's native transcript and sidebar entry. */
export async function deleteClaudeSession(
  configDir: string,
  sessionId: string,
  desktopRoots: readonly string[] = [],
): Promise<boolean> {
  if (!isCliNativeId(sessionId)) return false;
  let removed = desktopRoots.length ? await deleteClaudeDesktopEntries(desktopRoots, sessionId) : false;
  for (const rootDir of [path.join(configDir, "projects"), path.join(configDir, "archived-projects")]) {
    const hits = await findClaudeTranscripts(rootDir, sessionId);
    for (const m of hits) {
      await rm(m.file, { force: true });
      await rm(m.subdir, { recursive: true, force: true });
      defaultCache.delete(m.file);
      removed = true;
    }
  }
  return removed;
}
