import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAppDb, latestDb } from "./codex-app-db.ts";
import { CodexScanner, isExcludedCodexSession } from "./codex.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const ID = "019a0000-0000-7000-8000-000000000001";
const ID2 = "019a0000-0000-7000-8000-000000000002";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "nex-codex-app-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface Thread {
  id: string;
  title?: string;
  name?: string;
  rollout_path?: string;
  cwd?: string;
  archived?: number;
  recency_at_ms?: number;
  originator?: string;
  source?: string;
  agent_role?: string;
  git_branch?: string;
  model?: string;
}

function makeState(n: number, threads: Thread[], extraColumns = ""): void {
  const db = new DatabaseSync(path.join(home, `state_${n}.sqlite`));
  db.exec(
    `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, name TEXT, archived INTEGER, recency_at_ms INTEGER, originator TEXT, source TEXT, agent_role TEXT, git_branch TEXT, model TEXT${extraColumns})`,
  );
  const insert = db.prepare(
    "INSERT INTO threads (id, rollout_path, cwd, title, name, archived, recency_at_ms, originator, source, agent_role, git_branch, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const t of threads) {
    insert.run(
      t.id,
      t.rollout_path ?? "",
      t.cwd ?? "D:/work",
      t.title ?? "",
      t.name ?? null,
      t.archived ?? 0,
      t.recency_at_ms ?? NOW - 1000,
      t.originator ?? "Codex Desktop",
      t.source ?? "vscode",
      t.agent_role ?? null,
      t.git_branch ?? null,
      t.model ?? null,
    );
  }
  db.close();
}

interface ItemRow {
  turn: string;
  id: string;
  ordinal: number;
  json: unknown;
  type?: string;
}

function makeHistory(n: number, threadId: string, turns: Array<{ id: string; status: string; startedAt: number; completedAt: number | null }>, items: ItemRow[]): void {
  const db = new DatabaseSync(path.join(home, `thread_history_${n}.sqlite`));
  db.exec("CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, error_json TEXT, started_at INTEGER, completed_at INTEGER, rollout_end_ordinal INTEGER)");
  db.exec("CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER, created_at_ms INTEGER, item_json TEXT, item_type TEXT, updated_at_ordinal INTEGER)");
  const turnInsert = db.prepare("INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)");
  turns.forEach((turn, index) => turnInsert.run(threadId, turn.id, index, turn.status, turn.startedAt, turn.completedAt));
  const itemInsert = db.prepare("INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type, updated_at_ordinal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const item of items) itemInsert.run(threadId, item.turn, item.id, item.ordinal, NOW - 5000 + item.ordinal, JSON.stringify(item.json), item.type ?? null, item.ordinal);
  db.close();
}

const exclude = isExcludedCodexSession;

describe("latestDb", () => {
  it("picks the highest number and ignores other names", async () => {
    for (const name of ["state_2.sqlite", "state_10.sqlite", "state_9.sqlite", "state_x.sqlite", "state_3.sqlite-wal", "thread_history_1.sqlite"]) writeFileSync(path.join(home, name), "");
    expect(await latestDb(home, "state")).toBe(path.join(home, "state_10.sqlite"));
    expect(await latestDb(home, "thread_history")).toBe(path.join(home, "thread_history_1.sqlite"));
    expect(await latestDb(path.join(home, "missing"), "state")).toBeNull();
  });
});

describe("CodexAppDb.scan", () => {
  it("lists chats without a rollout file as idle desktop sessions", async () => {
    makeState(5, [
      { id: ID, title: "Old title", name: "Renamed chat", cwd: "D:/app", git_branch: "main", model: "gpt-5" },
      { id: ID2, title: "Second", recency_at_ms: NOW - 5000 },
    ]);
    const rows = await new CodexAppDb(home, { exclude }).scan(NOW);
    expect(rows.map((row) => row.nativeId)).toEqual([ID, ID2]);
    expect(rows[0]).toMatchObject({
      engine: "codex",
      title: "Renamed chat",
      cwd: "D:/app",
      state: "idle",
      liveIn: "desktop",
      transcript: "",
      gitBranch: "main",
      model: "gpt-5",
      appChat: { home, threadId: ID },
    });
    expect(rows[1].title).toBe("Second");
  });

  it("leaves out archived, subagent, exec, child, old and rollout-backed threads", async () => {
    const rollout = path.join(home, "rollout-x.jsonl");
    writeFileSync(rollout, "{}\n");
    makeState(1, [
      { id: "a1", title: "archived", archived: 1 },
      { id: "a2", title: "exec", originator: "codex_exec" },
      { id: "a3", title: "child", agent_role: "worker" },
      { id: "a4", title: "old", recency_at_ms: NOW - 40 * 86_400_000 },
      { id: "a5", title: "has rollout", rollout_path: rollout },
      { id: "a6", title: "rollout gone", rollout_path: path.join(home, "gone.jsonl") },
      { id: "a7", title: "kept", originator: "Codex Desktop" },
    ]);
    const rows = await new CodexAppDb(home, { exclude }).scan(NOW);
    expect(rows.map((row) => row.nativeId)).toEqual(["a6", "a7"]);
  });

  it("reads only the highest state file and never writes it", async () => {
    makeState(1, [{ id: "old1", title: "from state 1" }]);
    makeState(2, [{ id: "new2", title: "from state 2" }]);
    const rows = await new CodexAppDb(home, { exclude }).scan(NOW);
    expect(rows.map((row) => row.nativeId)).toEqual(["new2"]);
    // opened read-only: a write through the same API fails
    const db = new DatabaseSync(path.join(home, "state_2.sqlite"), { readOnly: true });
    expect(() => db.exec("DELETE FROM threads")).toThrow();
    db.close();
  });

  it("returns nothing for a missing, empty or foreign database", async () => {
    expect(await new CodexAppDb(home, { exclude }).scan(NOW)).toEqual([]);
    writeFileSync(path.join(home, "state_1.sqlite"), "not a database");
    expect(await new CodexAppDb(home, { exclude }).scan(NOW)).toEqual([]);
    const db = new DatabaseSync(path.join(home, "state_2.sqlite"));
    db.exec("CREATE TABLE other (x TEXT)");
    db.close();
    expect(await new CodexAppDb(home, { exclude }).scan(NOW)).toEqual([]);
  });

  it("copes with a schema that lacks optional columns", async () => {
    const db = new DatabaseSync(path.join(home, "state_1.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT, title TEXT, updated_at INTEGER)");
    db.prepare("INSERT INTO threads (id, title, updated_at) VALUES (?, ?, ?)").run(ID, "Plain", Math.floor((NOW - 1000) / 1000));
    db.close();
    const rows = await new CodexAppDb(home, { exclude }).scan(NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nativeId: ID, title: "Plain", cwd: "" });
    expect(rows[0].lastActivityAt).toBe(NOW - 1000);
  });
});

describe("CodexAppDb.page", () => {
  it("maps turns and thread items in order and pages backwards", async () => {
    makeHistory(
      1,
      ID,
      [
        { id: "t1", status: "completed", startedAt: NOW - 9000, completedAt: NOW - 8000 },
        { id: "t2", status: "interrupted", startedAt: NOW - 7000, completedAt: NOW - 6000 },
      ],
      [
        { turn: "t1", id: "i1", ordinal: 1, json: { type: "userMessage", id: "i1", content: [{ type: "text", text: "Hello" }] } },
        { turn: "t1", id: "i2", ordinal: 2, json: { type: "agentMessage", id: "i2", text: "Hi there" } },
        { turn: "t2", id: "i3", ordinal: 3, json: { id: "i3", content: [{ type: "text", text: "Again" }] }, type: "userMessage" },
      ],
    );
    const db = new CodexAppDb(home, { exclude });
    const all = await db.page(ID, { limit: 50 });
    expect(all.more).toBe(false);
    expect(all.items.map((item) => item.kind)).toEqual(["turn", "user", "assistant", "turn", "turn", "user", "turn"]);
    expect(all.items.flatMap((item) => (item.kind === "turn" ? [item.phase] : []))).toEqual(["started", "ended", "started", "aborted"]);
    const texts = all.items.flatMap((item) => (item.kind === "user" || item.kind === "assistant" ? [item.text] : []));
    expect(texts).toEqual(["Hello", "Hi there", "Again"]);

    const newest = await db.page(ID, { limit: 2 });
    expect(newest.more).toBe(true);
    expect(newest.items).toHaveLength(2);
    const older = await db.page(ID, { limit: 50, before: newest.items[0].id });
    expect(older.items.length + newest.items.length).toBe(all.items.length);
    expect(older.more).toBe(false);
  });

  it("is empty for an unknown chat or a missing history database", async () => {
    const db = new CodexAppDb(home, { exclude });
    expect(await db.page(ID)).toEqual({ items: [], more: false });
    makeHistory(1, ID, [], []);
    expect(await db.page("other")).toEqual({ items: [], more: false });
  });

  it("changes its marker when the chat gets a new item", async () => {
    makeHistory(1, ID, [{ id: "t1", status: "completed", startedAt: NOW, completedAt: NOW }], [{ turn: "t1", id: "i1", ordinal: 1, json: { type: "agentMessage", id: "i1", text: "x" } }]);
    const db = new CodexAppDb(home, { exclude });
    const first = await db.marker(ID);
    expect(first).not.toBe("");
    expect(await db.marker(ID)).toBe(first);
    const writer = new DatabaseSync(path.join(home, "thread_history_1.sqlite"));
    writer.prepare("INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type, updated_at_ordinal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(ID, "t1", "i2", 2, NOW, JSON.stringify({ type: "agentMessage", id: "i2", text: "y" }), null, 2);
    writer.close();
    expect(await db.marker(ID)).not.toBe(first);
  });
});

describe("CodexScanner with App chats", () => {
  it("adds database-only chats after the rollout sessions", async () => {
    makeState(1, [{ id: ID, title: "Only in the App" }]);
    const scanner = new CodexScanner(home);
    const rows = await scanner.scan({ now: NOW });
    expect(rows.map((row) => row.nativeId)).toEqual([ID]);
    expect(rows[0].liveIn).toBe("desktop");
    expect(scanner.appDb.home).toBe(home);
  });
});
