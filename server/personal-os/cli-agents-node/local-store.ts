// Local state of the Agent bridge (plan 3.8): `<data dir>/cli-agents.db`, next to
// node.db and independent of its migrations. Three small tables:
//   scan_files  per-session-file parse results, so a restart does not re-read every transcript
//   terminals   the herdr-core terminals Agent mode started, and how they ended
//   ops         results of Core's operations, so a re-sent opId is answered, not repeated
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Operation rows older than this are deleted. */
export const OPS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scan_files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
  engine TEXT NOT NULL, native_id TEXT NOT NULL, head_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS terminals (address TEXT PRIMARY KEY, engine TEXT NOT NULL, native_id TEXT NOT NULL,
  cwd TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER, exit_code INTEGER) STRICT;
CREATE TABLE IF NOT EXISTS ops (op_id TEXT PRIMARY KEY, op TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  result_json TEXT, created_at INTEGER NOT NULL) STRICT;
`;

export interface ScanFileRow {
  path: string;
  size: number;
  mtimeMs: number;
  engine: string;
  nativeId: string;
  head: unknown;
  updatedAt: number;
}

export interface TerminalRow {
  address: string;
  engine: string;
  nativeId: string;
  cwd: string;
  createdAt: number;
  endedAt: number | null;
  exitCode: number | null;
}

/** What a finished operation answered; stored and replayed as is. */
export interface StoredReply {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message?: string };
}

export type OpEntry =
  | { state: "new" }
  /** the row says running but nobody is working on it: the process died in between */
  | { state: "running"; op: string }
  | { state: "done"; op: string; reply: StoredReply };

type Row = Record<string, unknown>;

export class CliLocalStore {
  private readonly db: DatabaseSync;
  private closed = false;

  /** `file` is the database path, or ":memory:". */
  constructor(file: string, private readonly clock: () => number = Date.now) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    this.db.exec(SCHEMA);
    // A row still `running` at open belongs to a process that no longer exists.
    const fail = JSON.stringify({ ok: false, error: { code: "unknown", message: "the device restarted during the operation" } });
    this.db.prepare("UPDATE ops SET status='failed', result_json=? WHERE status='running'").run(fail);
    this.pruneOps();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  // -- ops ------------------------------------------------------------------

  /** Claims `opId`. `{state: "new"}` means the caller must run it (and later call
   * finishOp); anything else is the earlier outcome. */
  beginOp(opId: string, op: string): OpEntry {
    const insert = this.db.prepare("INSERT OR IGNORE INTO ops(op_id, op, status, created_at) VALUES (?, ?, 'running', ?)").run(opId, op, this.clock());
    if (Number(insert.changes) === 1) return { state: "new" };
    return this.opEntry(opId) ?? { state: "new" };
  }

  opEntry(opId: string): OpEntry | null {
    const row = this.db.prepare("SELECT op, status, result_json FROM ops WHERE op_id=?").get(opId) as Row | undefined;
    if (!row) return null;
    if (row.status === "running") return { state: "running", op: String(row.op) };
    try {
      return { state: "done", op: String(row.op), reply: JSON.parse(String(row.result_json)) as StoredReply };
    } catch {
      return { state: "done", op: String(row.op), reply: { ok: false, error: { code: "unknown" } } };
    }
  }

  finishOp(opId: string, reply: StoredReply): void {
    this.db.prepare("UPDATE ops SET status=?, result_json=? WHERE op_id=?").run(reply.ok ? "succeeded" : "failed", JSON.stringify(reply), opId);
  }

  /** The operation never reached a side effect (rejected up front): forget it so a re-send runs again. */
  forgetOp(opId: string): void {
    this.db.prepare("DELETE FROM ops WHERE op_id=? AND status='running'").run(opId);
  }

  pruneOps(): number {
    return Number(this.db.prepare("DELETE FROM ops WHERE created_at<?").run(this.clock() - OPS_RETENTION_MS).changes);
  }

  opCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) n FROM ops").get() as Row).n);
  }

  // -- terminals ------------------------------------------------------------

  upsertTerminal(row: { address: string; engine: string; nativeId: string; cwd: string; createdAt?: number }): void {
    this.db
      .prepare(
        `INSERT INTO terminals(address, engine, native_id, cwd, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET engine=excluded.engine, native_id=excluded.native_id, cwd=excluded.cwd, ended_at=NULL, exit_code=NULL`,
      )
      .run(row.address, row.engine, row.nativeId, row.cwd, row.createdAt ?? this.clock());
  }

  /** A Codex terminal learns its session id once the rollout shows up. */
  setNativeId(address: string, nativeId: string): void {
    this.db.prepare("UPDATE terminals SET native_id=? WHERE address=?").run(nativeId, address);
  }

  endTerminal(address: string, exitCode?: number | null): void {
    this.db
      .prepare("UPDATE terminals SET ended_at=COALESCE(ended_at, ?), exit_code=COALESCE(?, exit_code) WHERE address=?")
      .run(this.clock(), exitCode ?? null, address);
  }

  terminal(address: string): TerminalRow | null {
    const row = this.db.prepare("SELECT * FROM terminals WHERE address=?").get(address) as Row | undefined;
    return row ? toTerminal(row) : null;
  }

  openTerminals(): TerminalRow[] {
    return (this.db.prepare("SELECT * FROM terminals WHERE ended_at IS NULL ORDER BY created_at").all() as Row[]).map(toTerminal);
  }

  // -- scan files -----------------------------------------------------------

  putScanFile(row: ScanFileRow): void {
    this.db
      .prepare(
        `INSERT INTO scan_files(path, size, mtime_ms, engine, native_id, head_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, engine=excluded.engine,
           native_id=excluded.native_id, head_json=excluded.head_json, updated_at=excluded.updated_at`,
      )
      .run(row.path, row.size, row.mtimeMs, row.engine, row.nativeId, JSON.stringify(row.head ?? null), row.updatedAt);
  }

  scanFile(file: string): ScanFileRow | null {
    const row = this.db.prepare("SELECT * FROM scan_files WHERE path=?").get(file) as Row | undefined;
    if (!row) return null;
    let head: unknown = null;
    try {
      head = JSON.parse(String(row.head_json));
    } catch {
      // an unreadable cache row is a cache miss
      return null;
    }
    return {
      path: String(row.path),
      size: Number(row.size),
      mtimeMs: Number(row.mtime_ms),
      engine: String(row.engine),
      nativeId: String(row.native_id),
      head,
      updatedAt: Number(row.updated_at),
    };
  }

  /** Drops every cached file that is not in `keep`. */
  pruneScanFiles(keep: Iterable<string>): number {
    const wanted = new Set(keep);
    let removed = 0;
    for (const row of this.db.prepare("SELECT path FROM scan_files").all() as Row[]) {
      const file = String(row.path);
      if (wanted.has(file)) continue;
      this.db.prepare("DELETE FROM scan_files WHERE path=?").run(file);
      removed += 1;
    }
    return removed;
  }
}

function toTerminal(row: Row): TerminalRow {
  return {
    address: String(row.address),
    engine: String(row.engine),
    nativeId: String(row.native_id),
    cwd: String(row.cwd),
    createdAt: Number(row.created_at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
    exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
  };
}
