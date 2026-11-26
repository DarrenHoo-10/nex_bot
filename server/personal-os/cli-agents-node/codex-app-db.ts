// Codex App chats that exist only in the App's own database. The App keeps its
// threads in `<CODEX_HOME>/state_<n>.sqlite` (table `threads`) and their turns and
// items in `thread_history_<n>.sqlite` (`thread_turns`, `thread_items`); a chat
// without a rollout file is invisible to the rollout scan. Both files are opened
// read-only, the highest `<n>` of each, and nothing is ever written.
//
// The schema is the App's and changes between versions: only columns that exist are
// selected, and a database that cannot be opened or read yields no rows.
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CLI_LIMITS, HISTORY_DAYS, MAX_SESSIONS, PAGE_SIZE, isCliNativeId, type CliItem } from "../../../shared/cli-agents.ts";
import { clipUnits, codexThreadItemToItems, type LocalSession } from "./items.ts";

const DAY_MS = 86_400_000;
const TITLE_CHARS = 60;
const THREAD_ROWS = 500;
const CACHE_MS = 30_000;

type Row = Record<string, unknown>;

const THREAD_COLUMNS = [
  "id",
  "rollout_path",
  "cwd",
  "title",
  "name",
  "preview",
  "first_user_message",
  "git_branch",
  "model",
  "cli_version",
  "originator",
  "source",
  "thread_source",
  "archived",
  "agent_role",
  "attached_thread_parent_id",
  "updated_at",
  "updated_at_ms",
  "recency_at_ms",
] as const;

/** The file with the highest `<n>` in `state_<n>.sqlite` style names, or null. */
export async function latestDb(home: string, prefix: "state" | "thread_history"): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(home);
  } catch {
    return null;
  }
  const pattern = new RegExp(`^${prefix}_(\\d+)\\.sqlite$`);
  let best: { n: number; name: string } | null = null;
  for (const name of names) {
    const match = pattern.exec(name);
    if (!match) continue;
    const n = Number(match[1]);
    if (!best || n > best.n) best = { n, name };
  }
  return best ? path.join(home, best.name) : null;
}

function openReadOnly(file: string): DatabaseSync {
  return new DatabaseSync(file, { readOnly: true });
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Epoch seconds or milliseconds to milliseconds. */
function epochMs(value: unknown): number | undefined {
  const n = num(value);
  if (n === undefined || n <= 0) return undefined;
  return Math.round(n < 1e11 ? n * 1000 : n);
}

function sourceOf(value: unknown): unknown {
  const raw = text(value);
  if (!raw || !raw.trim().startsWith("{")) return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function shortTitle(raw: string): string {
  return Array.from(raw.replace(/\s+/g, " ").trim()).slice(0, TITLE_CHARS).join("");
}

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  const names = new Set<string>();
  for (const column of db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Row[]) {
    if (typeof column.name === "string") names.add(column.name);
  }
  return names;
}

export interface CodexAppDbOptions {
  /** true for subagent, exec and SDK threads, which are no user chats */
  exclude?: (meta: { id: string; originator?: string; source?: unknown; threadSource?: string }) => boolean;
  historyDays?: number;
  maxSessions?: number;
  /** a rollout path that exists marks a chat the rollout scan already covers; tests may replace the check */
  fileExists?: (file: string) => boolean;
}

export class CodexAppDb {
  private cache: { key: string; at: number; rows: LocalSession[] } | null = null;

  constructor(
    readonly home: string,
    private readonly options: CodexAppDbOptions = {},
  ) {}

  /** The chats of the last HISTORY_DAYS days that have no rollout file, newest first. */
  async scan(now: number = Date.now()): Promise<LocalSession[]> {
    const file = await latestDb(this.home, "state");
    if (!file) {
      this.cache = null;
      return [];
    }
    const key = await this.signature(file);
    if (this.cache && this.cache.key === key && now - this.cache.at < CACHE_MS) return this.cache.rows;
    let rows: LocalSession[] = [];
    try {
      rows = this.read(file, now);
    } catch {
      // a locked or unknown database is left alone
      rows = [];
    }
    this.cache = { key, at: now, rows };
    return rows;
  }

  private async signature(file: string): Promise<string> {
    const parts: string[] = [file];
    for (const name of [file, `${file}-wal`]) {
      try {
        const info = await stat(name);
        parts.push(`${info.size}:${Math.round(info.mtimeMs)}`);
      } catch {
        parts.push("-");
      }
    }
    return parts.join("|");
  }

  private read(file: string, now: number): LocalSession[] {
    const db = openReadOnly(file);
    try {
      const present = columnsOf(db, "threads");
      if (!present.has("id")) return [];
      const selected = THREAD_COLUMNS.filter((name) => present.has(name));
      const order = present.has("recency_at_ms") ? "recency_at_ms" : present.has("updated_at_ms") ? "updated_at_ms" : present.has("updated_at") ? "updated_at" : "id";
      const where = present.has("archived") ? "WHERE archived IS NULL OR archived = 0" : "";
      const found = db.prepare(`SELECT ${selected.map((name) => `"${name}"`).join(", ")} FROM threads ${where} ORDER BY "${order}" DESC LIMIT ${THREAD_ROWS}`).all() as Row[];
      const exists = this.options.fileExists ?? existsSync;
      const cutoff = now - (this.options.historyDays ?? HISTORY_DAYS) * DAY_MS;
      const out: LocalSession[] = [];
      for (const row of found) {
        const id = text(row.id);
        if (!id || !isCliNativeId(id)) continue;
        if (text(row.agent_role) || text(row.attached_thread_parent_id)) continue;
        const meta = { id, originator: text(row.originator), source: sourceOf(row.source), threadSource: text(row.thread_source) };
        if (this.options.exclude?.(meta)) continue;
        const rollout = text(row.rollout_path);
        if (rollout && exists(rollout)) continue; // the rollout scan has it
        const at = epochMs(row.recency_at_ms) ?? epochMs(row.updated_at_ms) ?? epochMs(row.updated_at) ?? 0;
        if (at < cutoff) continue;
        const title = text(row.name) ?? text(row.title) ?? text(row.preview) ?? text(row.first_user_message) ?? "";
        const session: LocalSession = {
          engine: "codex",
          nativeId: id,
          configDir: clipUnits(this.home, CLI_LIMITS.configDir),
          cwd: clipUnits(text(row.cwd) ?? "", CLI_LIMITS.cwd),
          title: clipUnits(shortTitle(title), CLI_LIMITS.title),
          // the App owns the chat: not stopped, and nex_bot never continues it in a terminal of its own
          state: "idle",
          lastActivityAt: at,
          liveIn: "desktop",
          transcript: "",
          appChat: { home: this.home, threadId: id },
        };
        const branch = text(row.git_branch);
        if (branch) session.gitBranch = clipUnits(branch, CLI_LIMITS.gitBranch);
        const model = text(row.model);
        if (model) session.model = clipUnits(model, CLI_LIMITS.model);
        const version = text(row.cli_version);
        if (version) session.cliVersion = clipUnits(version, CLI_LIMITS.cliVersion);
        out.push(session);
        if (out.length >= (this.options.maxSessions ?? MAX_SESSIONS)) break;
      }
      return out;
    } finally {
      db.close();
    }
  }

  /** Latest in-progress turns, looked up through the per-thread history index. */
  async activeTurns(threadIds: readonly string[]): Promise<Map<string, number | undefined>> {
    const active = new Map<string, number | undefined>();
    if (!threadIds.length) return active;
    const file = await latestDb(this.home, "thread_history");
    if (!file) return active;
    try {
      const db = openReadOnly(file);
      try {
        const columns = columnsOf(db, "thread_turns");
        if (!columns.has("thread_id") || !columns.has("status")) return active;
        const order = columns.has("rollout_ordinal") ? "rollout_ordinal" : "rowid";
        const started = columns.has("started_at") ? "started_at" : "NULL AS started_at";
        const latest = db.prepare(`SELECT status, ${started} FROM thread_turns WHERE thread_id = ? ORDER BY ${order} DESC LIMIT 1`);
        for (const id of threadIds) {
          const turn = latest.get(id);
          if (turn?.status === "inProgress") active.set(id, epochMs(turn.started_at));
        }
      } finally {
        db.close();
      }
    } catch {
      // The rollout still provides state when the history database is unavailable.
    }
    return active;
  }

  /** A cheap value that changes when the chat gets new turns or items. */
  async marker(threadId: string): Promise<string> {
    const file = await latestDb(this.home, "thread_history");
    if (!file) return "";
    try {
      const db = openReadOnly(file);
      try {
        const items = db.prepare("SELECT COUNT(*) AS n, MAX(updated_at_ordinal) AS u, MAX(rollout_ordinal) AS r FROM thread_items WHERE thread_id = ?").get(threadId) as Row | undefined;
        const turns = db.prepare("SELECT COUNT(*) AS n, MAX(completed_at) AS c, MAX(rollout_end_ordinal) AS e FROM thread_turns WHERE thread_id = ?").get(threadId) as Row | undefined;
        return JSON.stringify([items?.n, items?.u, items?.r, turns?.n, turns?.c, turns?.e].map((value) => (typeof value === "bigint" ? Number(value) : (value ?? null))));
      } finally {
        db.close();
      }
    } catch {
      return "";
    }
  }

  /** One page of the chat, newest last; `before` is an item id and the page ends right before it. */
  async page(threadId: string, options: { before?: string; limit?: number } = {}): Promise<{ items: CliItem[]; more: boolean }> {
    const file = await latestDb(this.home, "thread_history");
    if (!file) return { items: [], more: false };
    const limit = Math.max(1, options.limit ?? PAGE_SIZE);
    try {
      const db = openReadOnly(file);
      try {
        const items: CliItem[] = [];
        let seeking = options.before;
        for (const item of historyBackwards(db, threadId, seeking)) {
          if (seeking !== undefined) {
            if (item.id === seeking) seeking = undefined;
          } else if (items.length === limit) return { items: items.reverse(), more: true };
          else items.push(item);
        }
        return { items: items.reverse(), more: false };
      } finally {
        db.close();
      }
    } catch {
      return { items: [], more: false };
    }
  }
}

/** Walk the same turn/record order as the App, stopping as soon as the caller
 * has a page plus one item. A long thread isn't a reason to cut off history. */
function* historyBackwards(db: DatabaseSync, threadId: string, before?: string): Generator<CliItem> {
  const turnCols = columnsOf(db, "thread_turns"), itemCols = columnsOf(db, "thread_items");
  if (!itemCols.has("item_json") || !itemCols.has("item_id")) return;
  const optional = (cols: Set<string>, name: string) => cols.has(name) ? name : `NULL AS ${name}`;
  const order = (cols: Set<string>, key: "turn_id" | "item_id") => cols.has("rollout_ordinal") ? `rollout_ordinal DESC, ${key} DESC` : "rowid DESC";
  const itemQuery = `SELECT item_id, item_json, ${["item_type", "rollout_ordinal", "created_at_ms"].map(k => optional(itemCols, k)).join(", ")} FROM thread_items WHERE thread_id=?`;
  function* mapped(rows: Iterable<Row>, fallbackTs: number) {
    for (const row of rows) {
      let item: Row;
      try { item = JSON.parse(String(row.item_json)); } catch { continue; }
      if (!item || typeof item !== "object") continue;
      if (typeof item.type !== "string") item.type = text(row.item_type);
      if (typeof item.id !== "string") item.id = String(row.item_id);
      yield* codexThreadItemToItems(item, { segment: threadId, offset: num(row.rollout_ordinal) ?? 0 }, epochMs(row.created_at_ms) ?? fallbackTs).reverse();
    }
  }
  if (turnCols.has("turn_id")) {
    const perTurn = itemCols.has("turn_id") ? db.prepare(`${itemQuery} AND turn_id=? ORDER BY ${order(itemCols, "item_id")}`) : null;
    // Jump to the anchor's turn when possible. Still match the emitted id
    // below: markers are synthetic, and older schemas may supply an id in JSON.
    const anchorTurn = before && (text(perTurn && db.prepare("SELECT turn_id FROM thread_items WHERE thread_id=? AND item_id=?").get(threadId, before)?.turn_id) ?? /^(.*):(?:started|ended|aborted)$/.exec(before)?.[1]);
    const ordinal = turnCols.has("rollout_ordinal") ? "COALESCE(rollout_ordinal,-1)" : "rowid";
    const boundary = anchorTurn && db.prepare(`SELECT ${ordinal} AS ord,turn_id FROM thread_turns WHERE thread_id=? AND turn_id=?`).get(threadId, anchorTurn);
    const turns = db.prepare(`SELECT turn_id, ${["status", "started_at", "completed_at"].map(k => optional(turnCols, k)).join(", ")} FROM thread_turns WHERE thread_id=? ${boundary ? `AND (${ordinal},turn_id)<=(?,?)` : ""} ORDER BY ${order(turnCols, "turn_id")}`);
    for (const turn of turns.iterate(threadId, ...(boundary ? [boundary.ord, boundary.turn_id] : []))) {
      const turnId = text(turn.turn_id);
      if (!turnId) continue;
      const start = epochMs(turn.started_at) ?? 0;
      const phase = turn.status === "interrupted" ? "aborted" : turn.status === "completed" || turn.status === "failed" ? "ended" : null;
      if (phase) yield { kind: "turn", id: `${turnId}:${phase}`, ts: epochMs(turn.completed_at) ?? start, phase };
      if (perTurn) yield* mapped(perTurn.iterate(threadId, turnId), start);
      yield { kind: "turn", id: `${turnId}:started`, ts: start, phase: "started" };
    }
  }
  // Items without a turn precede all turns in the forward timeline.
  const loose = db.prepare(`${itemQuery} ${itemCols.has("turn_id") ? "AND (turn_id IS NULL OR turn_id='')" : ""} ORDER BY ${order(itemCols, "item_id")}`);
  yield* mapped(loose.iterate(threadId), 0);
}
