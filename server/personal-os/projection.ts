import { DatabaseSync } from "node:sqlite";
import type { FileEntry } from "@earendil-works/pi-coding-agent";

// Pi context is a rebuildable adapter-owned projection, never business state.
export class ProjectionStore {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS projections(id TEXT PRIMARY KEY, entries TEXT NOT NULL) STRICT;");
  }
  load(runtimeId: string): FileEntry[] | undefined {
    const row = this.db.prepare("SELECT entries FROM projections WHERE id=?").get(runtimeId);
    return row ? JSON.parse(String(row.entries)) as FileEntry[] : undefined;
  }
  save(runtimeId: string, entries: FileEntry[]) {
    if (entries[0]?.type !== "session") throw new Error("Invalid Pi projection header");
    this.db.prepare("INSERT INTO projections VALUES(?,?) ON CONFLICT(id) DO UPDATE SET entries=excluded.entries").run(runtimeId, JSON.stringify(entries));
  }
  clear(runtimeId: string) { this.db.prepare("DELETE FROM projections WHERE id=?").run(runtimeId); }
  close() { this.db.close(); }
}
