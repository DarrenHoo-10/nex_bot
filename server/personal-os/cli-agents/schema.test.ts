// Migration 55: the sessions table loses the fixed engine CHECK, the copy
// keeps every row, and the workbench tables take a ZCode row. The rebuild SQL
// runs against a database in the pre-53 shape, so the upgrade path itself is
// what is under test — not just a fresh install.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { cliAgentSchema, cliAgentSessionsRebuild, cliAgentWorkbenchSchema } from "./schema.ts";

describe("engine CHECK migration", () => {
  it("copies every row and accepts a third engine afterwards", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(cliAgentSchema); // the migration-50 shape, CHECK and all
    db.prepare(
      "INSERT INTO cli_agent_sessions (key,device_id,engine,native_id,config_dir,cwd,title,state,last_activity_at,hidden,first_seen_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("d:claude:a", "d", "claude", "a", "c", "w", "t", "idle", 1, 0, 1, 1);
    db.prepare(
      "INSERT INTO cli_agent_sessions (key,device_id,engine,native_id,config_dir,cwd,title,state,last_activity_at,hidden,first_seen_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("d:codex:b", "d", "codex", "b", "c", "w", "t2", "idle", 2, 0, 1, 1);
    db.exec(cliAgentSessionsRebuild);
    const rows = db.prepare("SELECT key,engine FROM cli_agent_sessions ORDER BY key").all() as Array<{ key: string; engine: string }>;
    expect(rows).toEqual([
      { key: "d:claude:a", engine: "claude" },
      { key: "d:codex:b", engine: "codex" },
    ]);
    // the CHECK is gone: a registered Harness id beyond the first two stores
    db.prepare(
      "INSERT INTO cli_agent_sessions (key,device_id,engine,native_id,config_dir,cwd,title,state,last_activity_at,hidden,first_seen_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("d:zcode:c", "d", "zcode", "c", "c", "w", "t3", "idle", 3, 0, 1, 1);
    expect(db.prepare("SELECT COUNT(*) n FROM cli_agent_sessions").get()?.n).toBe(3);
    db.close();
  });

  it("keeps the state CHECK and the items foreign key working", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(cliAgentSchema);
    db.prepare(
      "INSERT INTO cli_agent_sessions (key,device_id,engine,native_id,config_dir,cwd,title,state,last_activity_at,hidden,first_seen_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("d:claude:a", "d", "claude", "a", "c", "w", "t", "idle", 1, 0, 1, 1);
    db.exec(cliAgentSessionsRebuild);
    let stateRejected = false;
    try {
      db.prepare(
        "INSERT INTO cli_agent_sessions (key,device_id,engine,native_id,config_dir,cwd,title,state,last_activity_at,hidden,first_seen_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run("d:claude:b", "d", "claude", "b", "c", "w", "t", "sprinting", 1, 0, 1, 1);
    } catch {
      stateRejected = true;
    }
    expect(stateRejected).toBe(true);
    // a foreign key still cascades: items follow their session
    db.exec("PRAGMA foreign_keys=ON");
    db.prepare("INSERT INTO cli_agent_items (session_key,item_id,ts,body) VALUES (?,?,?,?)").run("d:claude:a", "i1", 1, "{}");
    db.prepare("DELETE FROM cli_agent_sessions WHERE key='d:claude:a'").run();
    expect(db.prepare("SELECT COUNT(*) n FROM cli_agent_items").get()?.n).toBe(0);
    db.close();
  });
});

describe("workbench tables", () => {
  it("takes a ZCode logical session with a queue and an outbox entry", () => {
    const fresh = new DatabaseSync(":memory:");
    fresh.exec("CREATE TABLE cli_agent_sessions (key TEXT PRIMARY KEY, device_id TEXT NOT NULL, engine TEXT NOT NULL, native_id TEXT NOT NULL, config_dir TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', git_branch TEXT, state TEXT NOT NULL, waiting_for TEXT, live_in TEXT, terminal TEXT, model TEXT, cli_version TEXT, last_activity_at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;");
    fresh.exec(cliAgentWorkbenchSchema);
    fresh.prepare("INSERT INTO cli_agent_workbench (id,session_key,device_id,engine,cwd,parent_id,kind,title,archived,deleted_at,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("wb1", "d:zcode:c", "d", "zcode", "w", null, "main", "", 0, null, 1, 1, 1);
    fresh.prepare("INSERT INTO cli_agent_outbox (id,workbench_id,session_key,seq,client_message_id,request_id,body,revises_message_id,delivery,status,error_code,op_id,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("e1", "wb1", "d:zcode:c", 1, "cm1", "rq1", "enc", null, "queue", "pending", null, null, 1, 1, 1);
    const entry = fresh.prepare("SELECT workbench_id,client_message_id,status FROM cli_agent_outbox WHERE id='e1'").get();
    expect(entry).toMatchObject({ workbench_id: "wb1", client_message_id: "cm1", status: "pending" });
    // the client_message_id is unique per logical session
    let duplicateRejected = false;
    try {
      fresh.prepare("INSERT INTO cli_agent_outbox (id,workbench_id,session_key,seq,client_message_id,request_id,body,delivery,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("e2", "wb1", "d:zcode:c", 2, "cm1", "rq2", "enc", "queue", "pending", 1, 2, 2);
    } catch {
      duplicateRejected = true;
    }
    expect(duplicateRejected).toBe(true);
    fresh.close();
  });
});
