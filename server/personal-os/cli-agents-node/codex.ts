// Codex session discovery (plan 3.3): `session_index.jsonl` for names and
// `sessions/YYYY/MM/DD/rollout-*.jsonl` for the sessions themselves. A rollout
// is identified by its first line (`session_meta`) and its tail; the middle of
// the file is never read here.
import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CLI_LIMITS, HISTORY_DAYS, MAX_SESSIONS, isCliNativeId, type CliContextUsage, type CliLiveIn } from "../../../shared/cli-agents.ts";
import { codexContext } from "./context-usage.ts";
import { CodexAppDb } from "./codex-app-db.ts";
import { codexPromptTitle, emptyCodexTitle, isNexAgentCodexTitle } from "./codex-title.ts";
import { clipUnits, type LocalSession } from "./items.ts";
import { codexWriter, type CodexWriter } from "./liveness.ts";

const DAY_MS = 86_400_000;
const HEAD_BYTES = 256 * 1024;
const FIRST_LINE_MAX = 4 * 1024 * 1024;
const TAIL_BYTES = 64 * 1024;
const RUNNING_WINDOW_MS = 60_000;

/** `~/.codex` plus `CODEX_HOME`, without duplicates. */
export function codexHomes(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string[] {
  const dirs = [path.resolve(home, ".codex")];
  const extra = env.CODEX_HOME?.trim();
  if (extra) dirs.push(path.resolve(extra));
  const seen = new Set<string>();
  return dirs.filter((dir) => {
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// ---------------------------------------------------------------------------
// session_meta

export interface CodexMeta {
  id: string;
  cwd?: string;
  originator?: string;
  source?: unknown;
  threadSource?: string;
  gitBranch?: string;
  cliVersion?: string;
  /** `forked_from_id` of a thread made by `codex fork` or the app's fork */
  forkedFrom?: string;
}

/** The cases that are not user conversations: subagents (including Guardian),
 * `codex exec` and SDK runs. */
export function isExcludedCodexSession(meta: CodexMeta): boolean {
  if (meta.threadSource === "subagent") return true;
  const source = meta.source;
  if (source === "exec") return true;
  const sourceRec = asRec(source);
  if (sourceRec && "subagent" in sourceRec && sourceRec.subagent) return true;
  if (typeof source === "string" && source.startsWith("subagent")) return true;
  const originator = meta.originator;
  if (originator === "codex_exec" || originator?.startsWith("codex_sdk_")) return true;
  return false;
}

/** Where the session is open, from the originator and source. */
export function codexLiveIn(meta: CodexMeta): CliLiveIn | undefined {
  if (meta.originator === "Codex Desktop" || meta.originator === "codex_work_desktop") return "desktop";
  const originator = meta.originator ?? "";
  if (meta.source === "cli" || /^(codex_cli|codex-tui|codex_tui|codex_exec)/.test(originator)) return "terminal";
  return undefined;
}

function parseMeta(record: Rec): CodexMeta | null {
  if (record.type !== "session_meta") return null;
  const payload = asRec(record.payload);
  const id = text(payload?.id);
  if (!payload || !id || !isCliNativeId(id)) return null;
  const git = asRec(payload.git);
  const forked = text(payload.forked_from_id);
  return {
    id,
    forkedFrom: forked && forked !== id && isCliNativeId(forked) ? forked : undefined,
    cwd: text(payload.cwd),
    originator: text(payload.originator),
    source: payload.source,
    threadSource: text(payload.thread_source),
    gitBranch: text(git?.branch),
    cliVersion: text(payload.cli_version),
  };
}

// ---------------------------------------------------------------------------
// reading helpers

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

function jsonLines(lines: string[]): Rec[] {
  const out: Rec[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const rec = asRec(JSON.parse(trimmed));
      if (rec) out.push(rec);
    } catch {
      // cut or half-written
    }
  }
  return out;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    const b = asRec(block);
    if (b && (b.type === "input_text" || b.type === "text") && typeof b.text === "string") parts.push(b.text);
  }
  return parts.length ? parts.join("\n") : undefined;
}

function firstUserText(records: Rec[]): string | undefined {
  for (const rec of records) {
    const payload = asRec(rec.payload);
    if (!payload) continue;
    let value: string | undefined;
    if (rec.type === "event_msg" && payload.type === "user_message") value = text(payload.message);
    else if (rec.type === "response_item" && payload.type === "message" && payload.role === "user") value = contentText(payload.content);
    else if (rec.type === "event_msg" && payload.type === "item_completed") {
      const item = asRec(payload.item);
      if (item?.type === "UserMessage") value = contentText(item.content);
    }
    const title = codexPromptTitle(value);
    if (title) return title;
  }
  return undefined;
}

interface HeadInfo {
  size: number;
  meta: CodexMeta | null;
  firstUser?: string;
  model?: string;
}

async function parseHead(file: string, size: number): Promise<HeadInfo> {
  let handle;
  try {
    handle = await open(file, "r");
    let length = Math.min(size, HEAD_BYTES);
    let buf = await readRange(handle, 0, length);
    // session_meta can carry large instructions: grow until the first line is whole
    while (buf.indexOf(10) < 0 && length < Math.min(size, FIRST_LINE_MAX)) {
      length = Math.min(size, FIRST_LINE_MAX, length * 2);
      buf = await readRange(handle, 0, length);
    }
    const lines = buf.toString("utf8").split("\n");
    const complete = buf.length < size ? lines.slice(0, -1) : lines;
    const records = jsonLines(complete);
    const meta = records.length > 0 ? parseMeta(records[0]) : null;
    const info: HeadInfo = { size, meta };
    const user = firstUserText(records);
    if (user) info.firstUser = user;
    for (const rec of records) {
      if (rec.type === "turn_context") {
        const model = text(asRec(rec.payload)?.model);
        if (model) info.model = model;
        break;
      }
    }
    return info;
  } catch {
    return { size, meta: null };
  } finally {
    await handle?.close().catch(() => {});
  }
}

interface TailInfo {
  size: number;
  mtimeMs: number;
  /** undefined when the tail contains neither a start nor an end */
  open?: boolean;
  lastTimestamp?: number;
  model?: string;
  context?: CliContextUsage;
}

const TURN_START = new Set(["task_started", "turn_started"]);
const TURN_END = new Set(["task_complete", "turn_complete", "turn_aborted"]);

async function parseTail(file: string, size: number, mtimeMs: number): Promise<TailInfo> {
  const info: TailInfo = { size, mtimeMs };
  let handle;
  try {
    handle = await open(file, "r");
    const from = Math.max(0, size - TAIL_BYTES);
    const buf = await readRange(handle, from, size - from);
    const lines = buf.toString("utf8").split("\n");
    if (from > 0) lines.shift();
    for (const rec of jsonLines(lines)) {
      if (typeof rec.timestamp === "string") {
        const ts = Date.parse(rec.timestamp);
        if (Number.isFinite(ts)) info.lastTimestamp = ts;
      }
      const payload = asRec(rec.payload);
      if (rec.type === "event_msg") {
        const kind = payload?.type;
        if (typeof kind === "string") {
          if (TURN_START.has(kind)) info.open = true;
          else if (TURN_END.has(kind)) info.open = false;
          else if (kind === "token_count") info.context = codexContext(payload) ?? info.context;
        }
      } else if (rec.type === "turn_context") {
        const model = text(payload?.model);
        if (model) info.model = model;
      }
    }
  } catch {
    // an unreadable tail leaves the defaults
  } finally {
    await handle?.close().catch(() => {});
  }
  return info;
}

// ---------------------------------------------------------------------------
// scanner

export interface CodexScannerOptions {
  historyDays?: number;
  maxSessions?: number;
  /** defaults to liveness.codexWriter */
  writer?: (home: string, threadId: string, now: number) => CodexWriter;
  /** tests: decides whether a rollout path from the App database exists */
  appDbFileExists?: (file: string) => boolean;
  updateNames?: (home: string, names: ReadonlyMap<string, string>) => Promise<void>;
}

interface RolloutFile {
  file: string;
  size: number;
  mtimeMs: number;
}

export class CodexScanner {
  readonly home: string;
  private readonly options: CodexScannerOptions;

  private indexOffset = 0;
  private indexPartial = Buffer.alloc(0);
  private readonly names = new Map<string, string>();
  private readonly renameAttempts = new Map<string, { title: string; retryAt: number }>();
  private renaming = false;

  private readonly heads = new Map<string, HeadInfo>();
  private readonly tails = new Map<string, TailInfo>();

  constructor(home: string, options: CodexScannerOptions = {}) {
    this.home = home;
    this.options = options;
    this.appDb = new CodexAppDb(home, {
      exclude: isExcludedCodexSession,
      historyDays: options.historyDays,
      maxSessions: options.maxSessions,
      ...(options.appDbFileExists ? { fileExists: options.appDbFileExists } : {}),
    });
  }

  /** All sessions of the last HISTORY_DAYS days, newest first. */
  async scan(options: { now?: number } = {}): Promise<LocalSession[]> {
    const now = options.now ?? Date.now();
    await this.readIndex();
    const files = await this.listRollouts(now);
    const keep = new Set(files.map((f) => f.file));
    for (const key of this.heads.keys()) if (!keep.has(key)) this.heads.delete(key);
    for (const key of this.tails.keys()) if (!keep.has(key)) this.tails.delete(key);

    // one row per thread id; the newest segment file wins
    const byId = new Map<string, { file: RolloutFile; head: HeadInfo; meta: CodexMeta }>();
    for (let i = 0; i < files.length; i += 8) {
      const batch = await Promise.all(files.slice(i, i + 8).map(async (f) => ({ file: f, head: await this.head(f) })));
      for (const { file, head } of batch) {
        const meta = head.meta;
        if (!meta || isExcludedCodexSession(meta)) continue;
        const previous = byId.get(meta.id);
        if (!previous || file.mtimeMs > previous.file.mtimeMs) byId.set(meta.id, { file, head, meta });
      }
    }
    const chosen = [...byId.values()].sort((a, b) => b.file.mtimeMs - a.file.mtimeMs).slice(0, this.options.maxSessions ?? MAX_SESSIONS);
    const rollouts: Array<(typeof chosen)[number] & { tail: TailInfo }> = [];
    for (const entry of chosen) rollouts.push({ ...entry, tail: await this.tail(entry.file) });
    const appChats = (await this.appDb.scan(now)).filter((chat) => !byId.has(chat.nativeId));
    const activeTurns = await this.appDb.activeTurns([
      ...rollouts.filter(({ tail }) => tail.open === undefined).map(({ meta }) => meta.id),
      ...appChats.map((chat) => chat.nativeId),
    ]);
    const writer = this.options.writer ?? ((home, id, at) => codexWriter(home, id, { now: at }));
    const rows = rollouts.map(({ file, head, meta, tail }) => this.row(file, head, meta, tail, activeTurns.has(meta.id), now, writer));
    // chats that exist only in the App's database
    const limit = this.options.maxSessions ?? MAX_SESSIONS;
    for (const chat of appChats) {
      if (rows.length >= limit) break;
      const startedAt = activeTurns.get(chat.nativeId);
      const recent = startedAt !== undefined && now - startedAt <= RUNNING_WINDOW_MS;
      const running = activeTurns.has(chat.nativeId) && (recent || writer(this.home, chat.nativeId, now) === "yes");
      rows.push(running ? { ...chat, state: "running", lastActivityAt: Math.max(chat.lastActivityAt, startedAt ?? 0) } : chat);
    }
    this.syncNames(rows, byId, now);
    return rows;
  }

  private syncNames(rows: LocalSession[], sources: ReadonlyMap<string, { meta: CodexMeta }>, now: number): void {
    const update = this.options.updateNames;
    if (!update || this.renaming) return;
    const batch = new Map<string, string>();
    for (const [id, attempt] of this.renameAttempts) if (attempt.retryAt <= now) this.renameAttempts.delete(id);
    for (const row of rows) {
      const id = row.nativeId;
      const stored = this.appDb.nexagentNames.get(id);
      if (!stored && sources.get(id)?.meta.originator !== "nexbot") continue;
      const name = this.names.get(id) ?? stored?.name;
      if (!isNexAgentCodexTitle(id, name) || name === row.title || !row.title || this.renameAttempts.get(id)?.title === row.title) continue;
      batch.set(id, row.title);
      this.renameAttempts.set(id, { title: row.title, retryAt: now + 60_000 });
      if (batch.size === 8) break;
    }
    if (!batch.size) return;
    // A slow or unavailable CLI must not delay discovery, history or message delivery.
    this.renaming = true;
    void update(this.home, batch).catch(() => {}).finally(() => { this.renaming = false; });
  }

  /** The App-database reader of this home, for the bridge to read a chat's items. */
  readonly appDb: CodexAppDb;

  private row(
    file: RolloutFile,
    head: HeadInfo,
    meta: CodexMeta,
    tail: TailInfo,
    historyActive: boolean,
    now: number,
    writer: (home: string, threadId: string, now: number) => CodexWriter,
  ): LocalSession {
    let state: LocalSession["state"];
    let writerUnknown = false;
    const open = tail.open ?? historyActive;
    if (open && now - file.mtimeMs <= RUNNING_WINDOW_MS) state = "running";
    else {
      const who = writer(this.home, meta.id, now);
      if (who === "yes") state = open ? "running" : "idle";
      else {
        state = "stopped";
        writerUnknown = who === "unknown";
      }
    }
    const stored = this.appDb.nexagentNames.get(meta.id);
    const name = this.names.get(meta.id) ?? stored?.name;
    const title = isNexAgentCodexTitle(meta.id, name) && (stored || meta.originator === "nexbot")
      ? head.firstUser ?? stored?.title ?? emptyCodexTitle(meta.id) : name ?? head.firstUser ?? "";
    const row: LocalSession = {
      engine: "codex",
      nativeId: meta.id,
      configDir: clipUnits(this.home, CLI_LIMITS.configDir),
      cwd: clipUnits(meta.cwd ?? "", CLI_LIMITS.cwd),
      title: clipUnits(title, CLI_LIMITS.title),
      state,
      lastActivityAt: Math.max(0, Math.round(tail.lastTimestamp ?? file.mtimeMs)),
      transcript: file.file,
    };
    if (meta.gitBranch) row.gitBranch = clipUnits(meta.gitBranch, CLI_LIMITS.gitBranch);
    const liveIn = state === "stopped" ? undefined : codexLiveIn(meta);
    if (liveIn) row.liveIn = liveIn;
    const model = tail.model ?? head.model;
    if (model) row.model = clipUnits(model, CLI_LIMITS.model);
    if (meta.cliVersion) row.cliVersion = clipUnits(meta.cliVersion, CLI_LIMITS.cliVersion);
    if (tail.context) row.context = tail.context;
    // discovery keeps it only when that thread is in the list too
    if (meta.forkedFrom) row.forkOf = meta.forkedFrom;
    if (writerUnknown) row.writerUnknown = true;
    return row;
  }

  private async head(f: RolloutFile): Promise<HeadInfo> {
    const cached = this.heads.get(f.file);
    // the first line never changes; a missing title or meta is looked at again when the file grew
    if (cached && (cached.firstUser || cached.size === f.size)) return cached;
    const info = await parseHead(f.file, f.size);
    this.heads.set(f.file, info);
    return info;
  }

  private async tail(f: RolloutFile): Promise<TailInfo> {
    const cached = this.tails.get(f.file);
    if (cached && cached.size === f.size && cached.mtimeMs === f.mtimeMs) return cached;
    const info = await parseTail(f.file, f.size, f.mtimeMs);
    // With overlapping reads a large tool result can displace the last marker
    // from the tail, without changing the turn state seen in the earlier scan.
    if (info.open === undefined && cached && f.size >= cached.size && f.size - cached.size < TAIL_BYTES) info.open = cached.open;
    this.tails.set(f.file, info);
    return info;
  }

  private async listRollouts(now: number): Promise<RolloutFile[]> {
    const root = path.join(this.home, "sessions");
    const days = this.options.historyDays ?? HISTORY_DAYS;
    const cutoff = now - days * DAY_MS;
    // directory names are local dates; one day of slack covers time zones
    const dirCutoff = cutoff - 2 * DAY_MS;
    const dirs: string[] = [];
    for (const year of await numericDirs(root, 4)) {
      for (const month of await numericDirs(path.join(root, year), 2)) {
        for (const day of await numericDirs(path.join(root, year, month), 2)) {
          const date = Date.UTC(Number(year), Number(month) - 1, Number(day));
          if (date >= dirCutoff) dirs.push(path.join(root, year, month, day));
        }
      }
    }
    const out: RolloutFile[] = [];
    for (const dir of dirs) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
        const file = path.join(dir, name);
        try {
          const info = await stat(file);
          if (info.isFile() && info.mtimeMs >= cutoff) out.push({ file, size: info.size, mtimeMs: info.mtimeMs });
        } catch {
          // removed while scanning
        }
      }
    }
    return out;
  }

  /** Incremental read of session_index.jsonl: a later line for an id wins. */
  private async readIndex(): Promise<void> {
    const file = path.join(this.home, "session_index.jsonl");
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      this.indexOffset = 0;
      this.indexPartial = Buffer.alloc(0);
      this.names.clear();
      return;
    }
    if (size < this.indexOffset + this.indexPartial.length) {
      this.indexOffset = 0;
      this.indexPartial = Buffer.alloc(0);
      this.names.clear();
    }
    const from = this.indexOffset + this.indexPartial.length;
    if (size === from) return;
    let handle;
    try {
      handle = await open(file, "r");
      const fresh = await readRange(handle, from, size - from);
      const data = Buffer.concat([this.indexPartial, fresh]);
      const last = data.lastIndexOf(10);
      if (last < 0) {
        this.indexPartial = data;
        return;
      }
      this.indexPartial = Buffer.from(data.subarray(last + 1));
      this.indexOffset += last + 1;
      for (const rec of jsonLines(data.toString("utf8", 0, last).split("\n"))) {
        const id = text(rec.id);
        const name = text(rec.thread_name)?.trim();
        if (id && name) this.names.set(id, name);
      }
    } catch {
      // retried by the next scan
    } finally {
      await handle?.close().catch(() => {});
    }
  }
}

async function numericDirs(dir: string, digits: number): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && new RegExp(`^\\d{${digits}}$`).test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
