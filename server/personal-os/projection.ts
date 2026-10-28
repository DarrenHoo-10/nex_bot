import { DatabaseSync } from "node:sqlite";
import type { FileEntry } from "@earendil-works/pi-coding-agent";

// Pi context is a rebuildable adapter-owned projection, never business state.
// One row per entry, seq 0 being the session header. Pi only appends, so a save
// inserts the new tail; entries that were removed or re-parented (stale system
// entries) rewrite the rows from the first difference on, in the same transaction.
// The legacy `projections` blob table is copied once and never modified or deleted
// afterwards (clear() aside): it is the rollback copy. An older release reads it and
// sees each conversation as it was at migration; agent_messages originals are untouched.
// Rolling forward again does not re-import, since those runtimes already have rows.
export class ProjectionStore {
  readonly db: DatabaseSync;
  /** Runtimes whose legacy blob could not be copied and verified; they stay served from the blob. */
  readonly migrationFailures: string[] = [];
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS projections(id TEXT PRIMARY KEY, entries TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS projection_entries(runtime_id TEXT NOT NULL, seq INTEGER NOT NULL, entry_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(runtime_id, seq)) STRICT; CREATE UNIQUE INDEX IF NOT EXISTS projection_entry_id ON projection_entries(runtime_id, entry_id);");
    this.migrate();
  }
  private atomically<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = work(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private insert(runtimeId: string, entries: FileEntry[], json: string[], from: number) {
    const insert = this.db.prepare("INSERT INTO projection_entries VALUES(?,?,?,?)");
    for (let seq = from; seq < json.length; seq++) insert.run(runtimeId, seq, entries[seq].id, json[seq]);
  }
  private migrate() {
    for (const { id } of this.db.prepare("SELECT id FROM projections WHERE NOT EXISTS(SELECT 1 FROM projection_entries e WHERE e.runtime_id=projections.id)").all()) {
      try {
        this.atomically(() => {
          const entries = JSON.parse(String(this.db.prepare("SELECT entries FROM projections WHERE id=?").get(id)!.entries)) as FileEntry[];
          if (entries[0]?.type !== "session") throw new Error("Invalid Pi projection header");
          const json = entries.map((entry) => JSON.stringify(entry));
          this.insert(String(id), entries, json, 0);
          const rows = this.db.prepare("SELECT json FROM projection_entries WHERE runtime_id=? ORDER BY seq").all(id);
          if (rows.length !== entries.length || "[" + rows.map((row) => row.json).join(",") + "]" !== JSON.stringify(entries)) throw new Error("Projection migration mismatch");
        });
      } catch (error) { this.migrationFailures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  load(runtimeId: string): FileEntry[] | undefined {
    const rows = this.db.prepare("SELECT json FROM projection_entries WHERE runtime_id=? ORDER BY seq").all(runtimeId);
    if (rows.length) return rows.map((row) => JSON.parse(String(row.json)) as FileEntry);
    const legacy = this.db.prepare("SELECT entries FROM projections WHERE id=?").get(runtimeId);
    return legacy ? JSON.parse(String(legacy.entries)) as FileEntry[] : undefined;
  }
  /** One original entry (never the session header) without loading the projection. */
  entry(runtimeId: string, entryId: string): FileEntry | undefined {
    const row = this.db.prepare("SELECT json FROM projection_entries WHERE runtime_id=? AND entry_id=? AND seq>0").get(runtimeId, entryId);
    if (row) return JSON.parse(String(row.json)) as FileEntry;
    if (this.db.prepare("SELECT 1 FROM projection_entries WHERE runtime_id=? LIMIT 1").get(runtimeId)) return undefined;
    return this.load(runtimeId)?.find((entry) => entry.type !== "session" && entry.id === entryId);
  }
  save(runtimeId: string, entries: FileEntry[]) {
    if (entries[0]?.type !== "session") throw new Error("Invalid Pi projection header");
    const json = entries.map((entry) => JSON.stringify(entry));
    const stored = this.db.prepare("SELECT json FROM projection_entries WHERE runtime_id=? ORDER BY seq").all(runtimeId);
    // Stored rows equal the list up to `common`; same id and same content, in the same order.
    let common = 0;
    while (common < stored.length && common < json.length && stored[common].json === json[common]) common++;
    if (common === stored.length && common === json.length) return;
    this.atomically(() => {
      if (common < stored.length) this.db.prepare("DELETE FROM projection_entries WHERE runtime_id=? AND seq>=?").run(runtimeId, common);
      this.insert(runtimeId, entries, json, common);
    });
  }
  clear(runtimeId: string) {
    this.atomically(() => {
      this.db.prepare("DELETE FROM projection_entries WHERE runtime_id=?").run(runtimeId);
      this.db.prepare("DELETE FROM projections WHERE id=?").run(runtimeId);
    });
  }
  close() { this.db.close(); }
}
