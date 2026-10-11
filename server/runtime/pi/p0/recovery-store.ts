import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";

// P0's single trusted conversation, not a replacement for the owner-scoped Core
// schema. Real SQLite transactions model the boundaries the adapter must honor.
export interface InputRecord {
  id: string; task_id: string; seq: number; text: string; hash: string;
  kind: "start" | "steer" | "supplement"; state: "pending" | "applied" | "consumed";
}
export interface CallRecord {
  id: string; session_id: string; entry_id: string; provider_id: string;
  args: string; state: "pending" | "ready" | "succeeded" | "cancelled";
  result: string | null; sdk_entry: string | null;
}
export interface TaskRecord {
  id: string; state: "running" | "awaiting_approval" | "paused" | "succeeded";
  version: number; generation: number; run_state: "released" | "active" | "waiting" | "releasing";
  wait_started: number | null; release_after: number | null;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export class RecoveryStore {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS task (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL,
        state TEXT NOT NULL, version INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
        run_state TEXT NOT NULL DEFAULT 'released', wait_started INTEGER, release_after INTEGER);
      CREATE TABLE IF NOT EXISTS inputs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, seq INTEGER UNIQUE NOT NULL,
        client_id TEXT UNIQUE NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL, request_hash TEXT NOT NULL,
        kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', sdk_entry TEXT);
      CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, entry_id TEXT NOT NULL,
        provider_id TEXT NOT NULL, args TEXT NOT NULL, state TEXT NOT NULL, result TEXT, sdk_entry TEXT,
        UNIQUE(session_id,entry_id,provider_id));
      CREATE TABLE IF NOT EXISTS effects (call_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL,
        input_ids TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'in_flight');
      CREATE TABLE IF NOT EXISTS policy (singleton INTEGER PRIMARY KEY CHECK(singleton=1), requires_approval INTEGER NOT NULL);
      INSERT OR IGNORE INTO policy VALUES(1,0);`);
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  task(): TaskRecord | undefined {
    return this.db.prepare("SELECT * FROM task WHERE singleton=1").get() as unknown as TaskRecord | undefined;
  }
  inputs(): InputRecord[] { return this.db.prepare("SELECT * FROM inputs ORDER BY seq").all() as unknown as InputRecord[]; }
  calls(): CallRecord[] { return this.db.prepare("SELECT * FROM calls ORDER BY rowid").all() as unknown as CallRecord[]; }
  effectCount(): number { return Number(this.db.prepare("SELECT count(*) AS n FROM effects").get()!.n); }
  setApprovalRequired(required: boolean): void {
    if ((this.task()?.generation ?? 0) !== 0) throw new Error("fixture policy must be configured before the first run");
    this.db.prepare("UPDATE policy SET requires_approval=? WHERE singleton=1").run(required ? 1 : 0);
  }
  accept(clientId: string, expectedTask: string | null, text: string): InputRecord {
    const requestHash = hash(JSON.stringify({ expectedTask, text }));
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM inputs WHERE client_id=?").get(clientId) as unknown as InputRecord & { request_hash: string } | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) throw new Error("409 idempotency conflict");
        return existing;
      }
      const task = this.task();
      const activeTask = task?.state === "succeeded" ? null : task?.id ?? null;
      if (expectedTask !== activeTask) throw new Error("409 stale task");
      if (activeTask === null && task && task.run_state !== "released") {
        throw new Error("409 worker has not exited");
      }
      const taskId = activeTask ?? randomUUID();
      const unexecutedCall = this.db.prepare("SELECT 1 FROM calls WHERE state IN ('pending','ready') LIMIT 1").get();
      const kind = !activeTask ? "start" : task?.state === "running" && !unexecutedCall ? "steer" : "supplement";
      if (!activeTask) {
        this.db.prepare(`INSERT INTO task(singleton,id,state,version,generation) VALUES(1,?,'running',1,?)
          ON CONFLICT(singleton) DO UPDATE SET id=excluded.id,state='running',version=task.version+1,
          wait_started=NULL,release_after=NULL`).run(taskId, task?.generation ?? 0);
      } else {
        this.db.prepare("UPDATE task SET version=version+1 WHERE singleton=1").run();
        if (kind === "supplement") {
          this.db.prepare("UPDATE calls SET state='cancelled',result=? WHERE state IN ('pending','ready')")
            .run(JSON.stringify({ cancelled: true, reason: "new input invalidated approval" }));
          this.db.prepare("UPDATE task SET state='paused' WHERE singleton=1").run();
        }
      }
      const seq = Number(this.db.prepare("SELECT coalesce(max(seq),0)+1 AS seq FROM inputs").get()!.seq);
      const id = randomUUID();
      this.db.prepare("INSERT INTO inputs(id,task_id,seq,client_id,text,hash,request_hash,kind) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, taskId, seq, clientId, text, hash(text), requestHash, kind);
      return this.inputs().find((row) => row.id === id)!;
    });
  }
  claimRun(): number {
    return this.transaction(() => {
      const task = this.task();
      if (!task || task.state !== "running" || task.run_state !== "released") throw new Error("run is not claimable");
      this.db.prepare("UPDATE task SET generation=generation+1,run_state='active',wait_started=NULL,release_after=NULL WHERE singleton=1").run();
      return this.task()!.generation;
    });
  }
  assertRun(generation: number): void {
    const task = this.task();
    if (!task || task.generation !== generation || task.run_state !== "active" || task.state !== "running") {
      throw new Error("stale or suspended run");
    }
  }
  // Called only after the supervisor observes the owned process exit.
  exited(generation: number): void {
    this.db.prepare("UPDATE task SET run_state='released' WHERE singleton=1 AND generation=?").run(generation);
  }
  releaseDue(now: number): boolean {
    return this.db.prepare("UPDATE task SET run_state='releasing' WHERE singleton=1 AND run_state='waiting' AND release_after<=?").run(now).changes === 1;
  }
  pendingInputs(): InputRecord[] {
    return this.inputs().filter((row) => row.task_id === this.task()?.id && row.state !== "consumed");
  }
  markApplied(input: InputRecord, entryId: string): void {
    this.db.prepare("UPDATE inputs SET state=CASE WHEN state='consumed' THEN state ELSE 'applied' END,sdk_entry=? WHERE id=? AND hash=?")
      .run(entryId, input.id, input.hash);
  }
  beginRequest(generation: number, ids: string[]): number {
    return this.transaction(() => {
      this.assertRun(generation);
      if (Number(this.db.prepare("SELECT count(*) AS n FROM requests").get()!.n) >= 20) throw new Error("model budget exhausted");
      return Number(this.db.prepare("INSERT INTO requests(generation,input_ids) VALUES(?,?)").run(generation, JSON.stringify(ids)).lastInsertRowid);
    });
  }
  settle(requestId: number, ids: string[], generation: number): void {
    this.transaction(() => {
      this.assertRun(generation);
      const request = this.db.prepare("SELECT input_ids FROM requests WHERE id=?").get(requestId);
      if (!request || request.input_ids !== JSON.stringify(ids)) throw new Error("request input coverage mismatch");
      for (const id of ids) {
        const result = this.db.prepare("UPDATE inputs SET state='consumed' WHERE id=? AND sdk_entry IS NOT NULL").run(id);
        if (result.changes !== 1) throw new Error("cannot consume an unpersisted input");
      }
      this.db.prepare("UPDATE requests SET status='succeeded' WHERE id=?").run(requestId);
    });
  }
  finish(expectedVersion: number, generation: number): boolean {
    return this.transaction(() => {
      this.assertRun(generation);
      return this.db.prepare(`UPDATE task SET state='succeeded',version=version+1 WHERE singleton=1 AND version=?
        AND NOT EXISTS(SELECT 1 FROM inputs WHERE task_id=task.id AND state!='consumed')
        AND NOT EXISTS(SELECT 1 FROM calls WHERE state IN ('pending','ready'))`).run(expectedVersion).changes === 1;
    });
  }
  propose(manager: SessionManager, providerId: string, args: { label: string }, generation: number, now: number, sourceEntryId?: string): CallRecord {
    return this.transaction(() => {
      this.assertRun(generation);
      const approval = this.db.prepare("SELECT requires_approval FROM policy WHERE singleton=1").get()!.requires_approval === 1;
      const entry = manager.getBranch().reverse().find((item) => item.type === "message" && item.message.role === "assistant"
        && (!sourceEntryId || item.id === sourceEntryId)
        && item.message.content.some((part) => part.type === "toolCall" && part.id === providerId));
      if (!entry) throw new Error("tool has no persisted source entry");
      const argsJson = JSON.stringify({ label: args.label });
      const existing = this.calls().find((call) => call.session_id === manager.getSessionId() && call.entry_id === entry.id && call.provider_id === providerId);
      if (existing) {
        if (existing.args !== argsJson) throw new Error("tool source argument conflict");
        return existing;
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO calls(id,session_id,entry_id,provider_id,args,state) VALUES(?,?,?,?,?,?)")
        .run(id, manager.getSessionId(), entry.id, providerId, argsJson, approval ? "pending" : "ready");
      if (approval) {
        this.db.prepare("UPDATE task SET state='awaiting_approval',run_state='waiting',wait_started=?,release_after=? WHERE singleton=1")
          .run(now, now + 60_000);
      }
      return this.calls().find((call) => call.id === id)!;
    });
  }
  approve(id: string, args: string): void {
    this.transaction(() => {
      if (this.task()?.state !== "awaiting_approval") throw new Error("approval is no longer valid");
      if (this.db.prepare("UPDATE calls SET state='ready' WHERE id=? AND args=? AND state='pending'").run(id, args).changes !== 1) {
        throw new Error("approval identity conflict");
      }
      this.db.prepare("UPDATE task SET state='running',version=version+1,run_state=CASE WHEN run_state='waiting' THEN 'active' ELSE run_state END WHERE singleton=1").run();
    });
  }
  execute(id: string, generation: number): CallRecord {
    return this.transaction(() => {
      this.assertRun(generation);
      const call = this.calls().find((row) => row.id === id);
      if (!call || !["ready", "succeeded"].includes(call.state)) throw new Error("call is not authorized");
      if (call.state === "succeeded") return call;
      const result = JSON.stringify({ callId: id, label: JSON.parse(call.args).label, success: true });
      this.db.prepare("INSERT INTO effects(call_id,value) VALUES(?,?)").run(id, result);
      this.db.prepare("UPDATE calls SET state='succeeded',result=? WHERE id=?").run(result, id);
      return this.calls().find((row) => row.id === id)!;
    });
  }
  delivered(id: string, entryId: string): void {
    this.db.prepare("UPDATE calls SET sdk_entry=? WHERE id=? AND result IS NOT NULL").run(entryId, id);
  }
}

// Separate durable projection store exercises Core commit <-> SDK persistence
// crash windows. Only public Pi APIs; no patched SDK methods or synthetic prompts.
export class SessionProjection {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK(id=1), entries TEXT NOT NULL);`);
  }
  load(cwd: string): SessionManager {
    const row = this.db.prepare("SELECT entries FROM snapshot WHERE id=1").get();
    return SessionManager.inMemory(cwd, undefined, row ? JSON.parse(String(row.entries)) as FileEntry[] : undefined);
  }
  save(manager: SessionManager): void {
    const header = manager.getHeader();
    if (!header) throw new Error("session header missing");
    this.db.prepare("INSERT INTO snapshot(id,entries) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET entries=excluded.entries")
      .run(JSON.stringify([header, ...manager.getEntries()]));
  }
  close(): void { this.db.close(); }
}
