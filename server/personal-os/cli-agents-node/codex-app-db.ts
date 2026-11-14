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
const TURN_ROWS = 300;
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
    const { items, older } = await this.load(threadId);
    const limit = Math.max(1, options.limit ?? PAGE_SIZE);
    let end = items.length;
    if (options.before) {
      const index = items.findIndex((item) => item.id === options.before);
      if (index >= 0) end = index;
    }
    const start = Math.max(0, end - limit);
    return { items: items.slice(start, end), more: start > 0 || (end === items.length && older) };
  }

  private async load(threadId: string): Promise<{ items: CliItem[]; older: boolean }> {
    const file = await latestDb(this.home, "thread_history");
    if (!file) return { items: [], older: false };
    try {
      const db = openReadOnly(file);
      try {
        return mapHistory(db, threadId);
      } finally {
        db.close();
      }
    } catch {
      return { items: [], older: false };
    }
  }
}

function mapHistory(db: DatabaseSync, threadId: string): { items: CliItem[]; older: boolean } {
  const turnColumns = columnsOf(db, "thread_turns");
  const itemColumns = columnsOf(db, "thread_items");
  if (!itemColumns.has("item_json") || !itemColumns.has("item_id")) return { items: [], older: false };
  const turnOrder = turnColumns.has("rollout_ordinal") ? "rollout_ordinal" : "rowid";
  const turns = turnColumns.has("turn_id")
    ? (db
        .prepare(
          `SELECT turn_id, ${turnColumns.has("status") ? "status" : "NULL AS status"}, ${turnColumns.has("started_at") ? "started_at" : "NULL AS started_at"}, ${turnColumns.has("completed_at") ? "completed_at" : "NULL AS completed_at"} FROM thread_turns WHERE thread_id = ? ORDER BY ${turnOrder} DESC LIMIT ${TURN_ROWS + 1}`,
        )
        .all(threadId) as Row[])
    : [];
  const older = turns.length > TURN_ROWS;
  const kept = turns.slice(0, TURN_ROWS).reverse();
  const itemOrder = itemColumns.has("rollout_ordinal") ? "rollout_ordinal" : "rowid";
  const rows = db
    .prepare(
      `SELECT item_id, ${itemColumns.has("turn_id") ? "turn_id" : "NULL AS turn_id"}, ${itemColumns.has("rollout_ordinal") ? "rollout_ordinal" : "NULL AS rollout_ordinal"}, ${itemColumns.has("created_at_ms") ? "created_at_ms" : "NULL AS created_at_ms"}, item_json, ${itemColumns.has("item_type") ? "item_type" : "NULL AS item_type"} FROM thread_items WHERE thread_id = ? ORDER BY ${itemOrder} ASC`,
    )
    .all(threadId) as Row[];

  const byTurn = new Map<string, Row[]>();
  const loose: Row[] = [];
  for (const row of rows) {
    const turn = text(row.turn_id);
    if (!turn) {
      loose.push(row);
      continue;
    }
    const list = byTurn.get(turn);
    if (list) list.push(row);
    else byTurn.set(turn, [row]);
  }

  const out: CliItem[] = [];
  const emit = (row: Row, fallbackTs: number): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(row.item_json));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const item = { ...(parsed as Row) };
    if (typeof item.type !== "string") {
      const kind = text(row.item_type);
      if (kind) item.type = kind;
    }
    if (typeof item.id !== "string") item.id = String(row.item_id);
    const ts = epochMs(row.created_at_ms) ?? fallbackTs;
    const ordinal = num(row.rollout_ordinal) ?? 0;
    out.push(...codexThreadItemToItems(item, { segment: threadId, offset: ordinal }, ts));
  };

  // items without a turn come first; items of turns older than the kept ones are left out
  if (!older) for (const row of loose) emit(row, 0);
  for (const turn of kept) {
    const turnId = text(turn.turn_id);
    if (!turnId) continue;
    const startedAt = epochMs(turn.started_at) ?? 0;
    const completedAt = epochMs(turn.completed_at) ?? startedAt;
    out.push({ kind: "turn", id: `${turnId}:started`, ts: startedAt, phase: "started" });
    for (const row of byTurn.get(turnId) ?? []) emit(row, startedAt);
    const status = text(turn.status);
    if (status === "completed" || status === "failed") out.push({ kind: "turn", id: `${turnId}:ended`, ts: completedAt, phase: "ended" });
    else if (status === "interrupted") out.push({ kind: "turn", id: `${turnId}:aborted`, ts: completedAt, phase: "aborted" });
  }
  return { items: out, older };
}
