// ZCode harness adapter: discovery from the local database, presence-derived
// state, transcript paging and the host channel contract. The database is the
// shape the installed ZCode keeps (`session`, `message`, `part`,
// `session_runtime_presence`); every test builds one in a temp directory and
// nothing touches the developer's own ~/.zcode.
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ZcodeDb, ZcodeScanner, zcodeHomeExists, pidAlive } from "./zcode.ts";
import { harnessFor, allHarnesses } from "./harness.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function tempHome(sessions: Array<Record<string, unknown>> = [], presence: Array<[string, number]> = []): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-zcode-"));
  cleanups.push(() => {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("nex-zcode-")) throw Error("Unsafe cleanup");
    // windows can hold the sqlite file a beat after close; give it three tries
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt >= 2 || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  });
  const home = path.join(root, "cli");
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(path.join(home, "db.sqlite"));
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT,
    version TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, time_deleted INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
    CREATE TABLE session_runtime_presence (session_id TEXT, owner_id TEXT, process_id INTEGER);`);
  for (const session of sessions as Array<Record<string, string | number | null>>) {
    db.prepare("INSERT INTO session (id, directory, title, version, time_created, time_updated, time_archived, time_deleted, parent_id) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(session.id as string, session.directory ?? "D:/proj", session.title ?? "标题", session.version ?? "0.17.1", session.timeCreated ?? 1000, session.timeUpdated ?? 1000, session.timeArchived ?? null, session.timeDeleted ?? null, session.parentId ?? null);
  }
  for (const message of (sessions as Array<Record<string, unknown> & { messages?: Array<Record<string, unknown>> }>).flatMap((session) => session.messages ?? [])) {
    db.prepare("INSERT INTO message (id, session_id, time_created, data, sequence) VALUES (?,?,?,?,?)")
      .run(message.id as string, message.sessionId as string, (message.timeCreated as number | undefined) ?? 1000, JSON.stringify(message.data), (message.sequence as number | undefined) ?? 0);
    const parts = (message.parts ?? []) as unknown[];
    for (const [index, part] of parts.entries()) {
      db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data, sequence) VALUES (?,?,?,?,?,?)")
        .run(`${message.id as string}-p${index}`, message.id as string, message.sessionId as string, 1000, JSON.stringify(part), index);
    }
  }
  for (const [sessionId, pid] of presence) {
    db.prepare("INSERT INTO session_runtime_presence (session_id, owner_id, process_id) VALUES (?,?,?)").run(sessionId, "owner", pid);
  }
  db.close();
  return home;
}

const alive = () => true;
const dead = () => false;
const NOW = Date.now();
const stamp = (ageMs: number) => NOW - ageMs;

describe("discovery", () => {
  it("reports live sessions as running with a host route, others as read-only idle", async () => {
    const host = tempHome(
      [
        { id: "sess_live", timeUpdated: stamp(1000) },
        { id: "sess_old", timeUpdated: stamp(2000) },
        { id: "sess_archived", timeUpdated: stamp(3000), timeArchived: stamp(3500) },
        { id: "sess_deleted", timeUpdated: stamp(4000), timeDeleted: stamp(4500) },
      ],
      [["sess_live", 4242]],
    );
    const scanner = new ZcodeScanner(host, { pidAlive: alive, host: { submit: async () => ({ accepted: true }), interrupt: async () => ({ outcome: "ok" }) } });
    const rows = await scanner.scan();
    // archived and deleted rows are the host's own lifecycle and stay out
    expect(rows.map((row) => [row.nativeId, row.state, row.sendVia])).toEqual([
      ["sess_live", "running", "host"],
      ["sess_old", "idle", undefined],
    ]);
    expect(rows.every((row) => row.engine === "zcode" && row.cwd === "D:/proj")).toBe(true);
    expect(rows[0].route).toEqual({ via: "host", home: host, sessionId: "sess_live" });
    scanner.close();
  });

  it("keeps sessions read-only without a host channel", async () => {
    const host = tempHome([{ id: "sess_a", timeUpdated: stamp(100) }], [["sess_a", 99]]);
    const scanner = new ZcodeScanner(host, { pidAlive: alive });
    const rows = await scanner.scan();
    expect(rows[0].sendVia).toBeUndefined();
    expect(rows[0].route).toBeUndefined();
    scanner.close();
  });

  it("yields no rows when the database is missing or unreadable", async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "nex-zcode-empty-"));
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
    const scanner = new ZcodeScanner(empty);
    expect(await scanner.scan()).toEqual([]);
    expect(await zcodeHomeExists(empty)).toBe(false);
  });

  it("treats a dead presence pid as idle", async () => {
    const host = tempHome([{ id: "sess_x", timeUpdated: stamp(100) }], [["sess_x", 4242]]);
    const scanner = new ZcodeScanner(host, { pidAlive: dead });
    const rows = await scanner.scan();
    expect(rows[0].state).toBe("idle");
    scanner.close();
  });

  it("pidAlive survives a nonsense pid", () => {
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(Number.NaN)).toBe(false);
  });
});

describe("transcript", () => {
  const user = (id: string, text: string, sequence = 0) => ({
    id, sessionId: "sess_t", timeCreated: 1000, sequence,
    data: { role: "user", time: { created: 1000 } },
    parts: [{ type: "text", text }],
  });
  const assistant = (id: string, text: string, sequence = 1) => ({
    id, sessionId: "sess_t", timeCreated: 2000, sequence,
    data: { role: "assistant", time: { created: 2000 } },
    parts: [{ type: "text", text, time: { start: 2000 } }, { type: "tool", status: "ok" }],
  });

  it("pages user and assistant text oldest last, skipping tool parts and hidden messages", async () => {
    const home = tempHome([
      {
        id: "sess_t", timeUpdated: stamp(100),
        messages: [
          user("m1", "第一条"),
          assistant("m2", "回复一"),
          { id: "m3", sessionId: "sess_t", sequence: 2, data: { role: "user", visibility: "model-only" }, parts: [{ type: "text", text: "隐藏" }] },
          { id: "m4", sessionId: "sess_t", sequence: 3, data: { role: "user", metadata: { runtimeMessage: { source: "environment" } } }, parts: [{ type: "text", text: "环境" }] },
          assistant("m5", "回复二", 4),
        ],
      },
    ]);
    const db = new ZcodeDb(home);
    const page = await db.page("sess_t", { limit: 40 });
    expect(page.items.map((item) => [item.kind, "text" in item ? item.text : ""])).toEqual([
      ["user", "第一条"],
      ["assistant", "回复一"],
      ["assistant", "回复二"],
    ]);
    expect(page.more).toBe(false);
    // older pages end right before the boundary id
    const older = await db.page("sess_t", { before: page.items[2].id, limit: 1 });
    expect(older.items.map((item) => ("text" in item ? item.text : ""))).toEqual(["回复一"]);
    expect(older.more).toBe(true);
    db.close();
  });

  it("changes the marker when the session gains messages or activity", async () => {
    const home = tempHome([{ id: "sess_m", timeUpdated: stamp(1), messages: [user("m1", "你好", 0)] }]);
    const db = new ZcodeDb(home);
    const before = await db.marker("sess_m");
    expect(before).not.toBe("");
    // rewriting the row changes the marker
    const fresh = new DatabaseSync(path.join(home, "db.sqlite"));
    fresh.prepare("UPDATE session SET time_updated=999 WHERE id='sess_m'").run();
    fresh.close();
    expect(await db.marker("sess_m")).not.toBe(before);
    db.close();
  });
});

describe("host channel contract", () => {
  it("routes send, steer and interrupt through the channel the device provides", async () => {
    const home = tempHome([{ id: "sess_c", timeUpdated: stamp(100) }], [["sess_c", 4242]]);
    const calls: Array<[string, string, boolean?]> = [];
    const scanner = new ZcodeScanner(home, {
      pidAlive: alive,
      host: {
        submit: async (sessionId, text, options) => {
          calls.push([sessionId, text, options?.steer]);
          return { accepted: true };
        },
        interrupt: async (sessionId) => {
          calls.push([sessionId, "<interrupt>"]);
          return { outcome: "stopped" };
        },
      },
    });
    const rows = await scanner.scan();
    expect(rows[0].sendVia).toBe("host");
    expect(calls).toEqual([]);
    scanner.close();
  });
});

describe("harness registry", () => {
  const session = (extra: Record<string, unknown>) => ({
    engine: "zcode" as const, nativeId: "n", configDir: "c", cwd: "w", title: "t", state: "idle" as const, lastActivityAt: 1, ...extra,
  });

  it("registers every shipped harness exactly once", () => {
    expect(allHarnesses().map((harness) => harness.id)).toEqual(["claude", "codex", "zcode", "agy"]);
  });

  it("a terminal session of any harness gets every capability", () => {
    for (const engine of ["claude", "codex", "zcode", "agy"] as const) {
      const caps = harnessFor(engine)!.caps(session({ engine, terminal: "hc://x", liveIn: "nexbot" }) as never);
      expect(caps).toMatchObject({ sendVia: "terminal", steer: true, interrupt: true, terminal: true });
    }
  });

  it("zcode host sessions can steer and stop; inbox sessions only send", () => {
    expect(harnessFor("zcode")!.caps(session({ sendVia: "host" }) as never)).toMatchObject({ sendVia: "host", steer: true, interrupt: true });
    expect(harnessFor("claude")!.caps(session({ sendVia: "inbox" }) as never)).toMatchObject({ sendVia: "inbox", steer: true, interrupt: true });
    const readOnly = harnessFor("zcode")!.caps(session({}) as never);
    expect(readOnly.sendVia).toBeUndefined();
    expect(readOnly.steer).toBe(false);
    expect(readOnly.interrupt).toBe(false);
  });
});
