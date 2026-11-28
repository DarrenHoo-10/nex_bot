// ZCode harness adapter & runtime: discovery from the local database (`db/db.sqlite`),
// auxiliary task filtering, rich transcript parts, artifact image resolution,
// host channel contract, and full `ZcodeRuntime` bidirectional app-server lifecycle.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { CliTurnReason, DeviceCliMessage } from "../../../shared/cli-agents.ts";
import { ZcodeDb, ZcodeScanner, zcodeHomeExists, pidAlive, readZcodeProviderMeta } from "./zcode.ts";
import { ZcodeRuntime } from "./zcode-runtime.ts";
import { harnessFor, allHarnesses } from "./harness.ts";

const FIXTURE = fileURLToPath(new URL("./testdata/zcode-app-server-fixture.mjs", import.meta.url));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempHome(
  sessions: Array<Record<string, unknown>> = [],
  presence: Array<[string, number]> = [],
  options: { legacyLayout?: boolean } = {},
): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-zcode-"));
  cleanups.push(() => {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("nex-zcode-")) throw Error("Unsafe cleanup");
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
  const dbDir = options.legacyLayout ? home : path.join(home, "db");
  mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, "db.sqlite"));
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT,
    version TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, time_deleted INTEGER, task_type TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
    CREATE TABLE session_runtime_presence (session_id TEXT, owner_id TEXT, process_id INTEGER);`);
  for (const session of sessions as Array<Record<string, string | number | null>>) {
    db.prepare(
      "INSERT INTO session (id, directory, title, version, time_created, time_updated, time_archived, time_deleted, parent_id, task_type) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(
      session.id as string,
      session.directory ?? "D:/proj",
      session.title ?? "标题",
      session.version ?? "0.18.0",
      session.timeCreated ?? 1000,
      session.timeUpdated ?? 1000,
      session.timeArchived ?? null,
      session.timeDeleted ?? null,
      session.parentId ?? null,
      session.taskType ?? "interactive",
    );
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
  it("reports live, older and archived sessions without a 14-day cutoff, carries forkOf, and skips subagents and deleted rows", async () => {
    const host = tempHome(
      [
        {
          id: "sess_live",
          timeUpdated: stamp(1000),
          messages: [{ id: "m_live", sessionId: "sess_live", sequence: 0, data: { role: "assistant", time: { created: 1000 } } }],
        },
        {
          id: "sess_viewed",
          timeUpdated: stamp(1200),
          messages: [{ id: "m_done", sessionId: "sess_viewed", sequence: 0, data: { role: "assistant", time: { created: 1000, completed: 2000 }, finish: "stop" } }],
        },
        { id: "sess_old", timeUpdated: stamp(60 * 86_400_000), parentId: "sess_live" },
        { id: "sess_sub", timeUpdated: stamp(1500), taskType: "subagent_child" },
        { id: "sess_archived", timeUpdated: stamp(3000), timeArchived: stamp(3500) },
        { id: "sess_deleted", timeUpdated: stamp(4000), timeDeleted: stamp(4500) },
      ],
      [["sess_live", 4242], ["sess_viewed", 4242]],
    );
    expect(await zcodeHomeExists(host)).toBe(true);
    const scanner = new ZcodeScanner(host, { pidAlive: alive, host: { submit: async () => ({ accepted: true }), interrupt: async () => ({ outcome: "ok" }) } });
    const rows = await scanner.scan();
    expect(rows.map((row) => [row.nativeId, row.state, row.liveIn, row.sendVia, row.archived ?? false, row.forkOf])).toEqual([
      ["sess_live", "running", "desktop", "host", false, undefined],
      ["sess_viewed", "idle", "desktop", "host", false, undefined],
      ["sess_archived", "stopped", undefined, undefined, true, undefined],
      ["sess_old", "stopped", undefined, undefined, false, "sess_live"],
    ]);
    expect(rows.every((row) => row.engine === "zcode" && row.cwd === "D:/proj")).toBe(true);
    expect(rows[0]!.route).toEqual({ via: "host", home: host, sessionId: "sess_live" });
    scanner.close();
  });

  it("treats ZCode Desktop sessions opened merely for viewing as idle rather than running, honoring task_status and tool state", async () => {
    const host = tempHome(
      [
        {
          id: "sess_view_only",
          timeUpdated: stamp(100),
          messages: [{ id: "m1", sessionId: "sess_view_only", sequence: 0, data: { role: "assistant", time: { created: 1000, completed: 2000 }, finish: "stop" } }],
        },
        {
          id: "sess_interrupted_tool",
          timeUpdated: stamp(200),
          messages: [{
            id: "m2", sessionId: "sess_interrupted_tool", sequence: 0,
            data: { role: "assistant", time: { created: 1000, completed: 2000 }, finish: "tool-calls" },
            parts: [{ type: "tool", tool: "Read", state: { status: "completed", output: "ok" } }],
          }],
        },
        {
          id: "sess_running_tool",
          timeUpdated: stamp(300),
          messages: [{
            id: "m3", sessionId: "sess_running_tool", sequence: 0,
            data: { role: "assistant", time: { created: 1000, completed: 2000 }, finish: "tool-calls" },
            parts: [{ type: "tool", tool: "Bash", state: { status: "running" } }],
          }],
        },
        { id: "sess_waiting_task", timeUpdated: stamp(400) },
        { id: "sess_empty_tab", timeUpdated: stamp(500) },
      ],
      [
        ["sess_view_only", 5000],
        ["sess_interrupted_tool", 5000],
        ["sess_running_tool", 5000],
        ["sess_waiting_task", 5000],
        ["sess_empty_tab", 5000],
      ],
    );
    const v2Dir = path.join(path.dirname(host), "v2");
    mkdirSync(v2Dir, { recursive: true });
    const tdb = new DatabaseSync(path.join(v2Dir, "tasks-index.sqlite"));
    tdb.exec("CREATE TABLE tasks (task_id TEXT PRIMARY KEY, task_status TEXT, archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0)");
    tdb.prepare("INSERT INTO tasks (task_id, task_status, archived, deleted) VALUES (?, ?, 0, 0)").run("sess_view_only", "completed");
    tdb.prepare("INSERT INTO tasks (task_id, task_status, archived, deleted) VALUES (?, ?, 0, 0)").run("sess_interrupted_tool", "interrupted");
    tdb.prepare("INSERT INTO tasks (task_id, task_status, archived, deleted) VALUES (?, ?, 0, 0)").run("sess_waiting_task", "waiting_for_input");
    tdb.close();

    const scanner = new ZcodeScanner(host, { pidAlive: alive });
    const rows = await scanner.scan();
    expect(rows.map((r) => [r.nativeId, r.state, r.liveIn])).toEqual([
      ["sess_view_only", "idle", "desktop"],
      ["sess_interrupted_tool", "idle", "desktop"],
      ["sess_running_tool", "running", "desktop"],
      ["sess_waiting_task", "waiting", "desktop"],
      ["sess_empty_tab", "idle", "desktop"],
    ]);
    scanner.close();
  });

  it("natively archives, restores and deletes sessions across db.sqlite and sibling v2/tasks-index.sqlite", async () => {
    const host = tempHome([{ id: "sess_target", timeUpdated: stamp(45 * 86_400_000) }]);
    const v2Dir = path.join(path.dirname(host), "v2");
    mkdirSync(v2Dir, { recursive: true });
    const tasksFile = path.join(v2Dir, "tasks-index.sqlite");
    const tdb = new DatabaseSync(tasksFile);
    tdb.exec("CREATE TABLE tasks (task_id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, cli_deleted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)");
    tdb.prepare("INSERT INTO tasks (task_id, archived, deleted, cli_deleted, updated_at) VALUES (?, 0, 0, 0, 1000)").run("sess_target");
    tdb.close();

    const db = new ZcodeDb(host, { pidAlive: dead });
    expect(db.setArchived("sess_target", true)).toBe(true);
    expect(db.scan().find((r) => r.id === "sess_target")?.archived).toBe(true);
    const check1 = new DatabaseSync(tasksFile, { readOnly: true });
    expect(check1.prepare("SELECT archived, deleted FROM tasks WHERE task_id=?").get("sess_target")).toEqual({ archived: 1, deleted: 0 });
    check1.close();

    expect(db.setArchived("sess_target", false)).toBe(true);
    expect(db.scan().find((r) => r.id === "sess_target")?.archived).toBe(false);

    expect(db.deleteSession("sess_target")).toBe(true);
    expect(db.scan()).toEqual([]);
    const check2 = new DatabaseSync(tasksFile, { readOnly: true });
    expect(check2.prepare("SELECT deleted, cli_deleted FROM tasks WHERE task_id=?").get("sess_target")).toEqual({ deleted: 1, cli_deleted: 1 });
    check2.close();
    db.close();
  });

  it("supports legacy flat db.sqlite layout as fallback", async () => {
    const host = tempHome([{ id: "sess_legacy", timeUpdated: stamp(100) }], [], { legacyLayout: true });
    expect(await zcodeHomeExists(host)).toBe(true);
    const scanner = new ZcodeScanner(host, { pidAlive: dead });
    const rows = await scanner.scan();
    expect(rows.map((row) => [row.nativeId, row.state])).toEqual([["sess_legacy", "stopped"]]);
    scanner.close();
  });

  it("keeps external running sessions read-only without a host channel", async () => {
    const host = tempHome(
      [{
        id: "sess_a",
        timeUpdated: stamp(100),
        messages: [{ id: "m_a", sessionId: "sess_a", sequence: 0, data: { role: "user", time: { created: 1000 } } }],
      }],
      [["sess_a", 99]],
    );
    const scanner = new ZcodeScanner(host, { pidAlive: alive });
    const rows = await scanner.scan();
    expect(rows[0]!.state).toBe("running");
    expect(rows[0]!.liveIn).toBe("desktop");
    expect(rows[0]!.sendVia).toBeUndefined();
    expect(rows[0]!.route).toBeUndefined();
    scanner.close();
  });

  it("yields no rows when the database is missing or unreadable", async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "nex-zcode-empty-"));
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
    const scanner = new ZcodeScanner(empty);
    expect(await scanner.scan()).toEqual([]);
    expect(await zcodeHomeExists(empty)).toBe(false);
  });

  it("treats a dead presence pid or ignored managed pid as stopped", async () => {
    const host = tempHome([{ id: "sess_x", timeUpdated: stamp(100) }], [["sess_x", 4242]]);
    const scanner = new ZcodeScanner(host, { pidAlive: dead });
    expect((await scanner.scan())[0]!.state).toBe("stopped");
    scanner.close();

    const db = new ZcodeDb(host, { pidAlive: alive });
    expect(db.isRunningExternally("sess_x", new Set([4242]))).toBe(false);
    expect(db.isRunningExternally("sess_x", new Set([9999]))).toBe(true);
    db.close();
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

  it("assigns distinct stable IDs to interleaved assistant text and tools and supports before pagination", async () => {
    const home = tempHome([
      {
        id: "sess_t", timeUpdated: stamp(100),
        messages: [
          user("m1", "第一条", 0),
          { id: "m3", sessionId: "sess_t", sequence: 1, data: { role: "user", visibility: "model-only" }, parts: [{ type: "text", text: "隐藏1" }] },
          { id: "m3b", sessionId: "sess_t", sequence: 2, data: { role: "user", metadata: { visibility: "model-only" } }, parts: [{ type: "text", text: "隐藏2" }] },
          { id: "m4", sessionId: "sess_t", sequence: 3, data: { role: "user", metadata: { runtimeMessage: { source: "environment" } } }, parts: [{ type: "text", text: "环境" }] },
          {
            id: "m5", sessionId: "sess_t", sequence: 4, timeCreated: 3000,
            data: { role: "assistant", time: { created: 3000 } },
            parts: [
              { type: "text", text: "先看下文件" },
              { type: "tool", callID: "c1", tool: "Read", state: { status: "completed", input: { file_path: "a.ts" }, output: "ok" } },
              { type: "reasoning", text: "再分析结果" },
              { type: "text", text: "回复二" },
            ],
          },
        ],
      },
    ]);
    const db = new ZcodeDb(home);
    const page = await db.page("sess_t", { limit: 40 });
    expect(page.items.map((item) => [item.kind, "text" in item ? item.text : item.kind === "tool" ? `${item.name}:${item.status}` : ""])).toEqual([
      ["user", "第一条"],
      ["assistant", "先看下文件"],
      ["tool", "Read:ok"],
      ["thinking", "再分析结果"],
      ["assistant", "回复二"],
    ]);
    // Every item ID must be unique (text flush before tool must never collide with tool ID)
    expect(new Set(page.items.map((item) => item.id)).size).toBe(page.items.length);
    expect(page.more).toBe(false);

    const older = await db.page("sess_t", { before: page.items[2]!.id, limit: 2 });
    expect(older.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(older.more).toBe(false);
    // Unknown `before` cursor returns empty page rather than wrapping to sequence 0
    expect(await db.page("sess_t", { before: "nonexistent", limit: 10 })).toEqual({ items: [], more: false });
    db.close();
  });

  it("resolves prefixed zcode-artifact:// image .txt data URLs via imageSource", async () => {
    const home = tempHome([
      {
        id: "sess_img", timeUpdated: stamp(100),
        messages: [
          {
            id: "m1", sessionId: "sess_img", sequence: 0, timeCreated: 1000,
            data: { role: "user", time: { created: 1000 } },
            parts: [
              { type: "text", text: "看图" },
              { type: "file", mime: "image/png", url: "zcode-artifact://sess_img/tool-result-abc123" },
            ],
          },
        ],
      },
    ]);
    const artDir = path.join(home, "artifacts", "sess_img");
    mkdirSync(artDir, { recursive: true });
    writeFileSync(path.join(artDir, "prompt-attachment-upload-01-tool-result-abc123.txt"), "data:image/png;base64,iVBORw0KGgo=");
    const db = new ZcodeDb(home);
    const page = await db.page("sess_img", { limit: 10 });
    const item = page.items[0];
    expect(item?.kind).toBe("user");
    const locator = item?.kind === "user" ? item.images?.[0] : undefined;
    expect(locator).toBeTruthy();
    expect(db.imageSource("sess_img", "m1", locator!)).toEqual({ kind: "inline", value: "iVBORw0KGgo=" });
    db.close();
  });

  it("changes the marker when the session gains messages or activity", async () => {
    const home = tempHome([{ id: "sess_m", timeUpdated: stamp(1), messages: [user("m1", "你好", 0)] }]);
    const db = new ZcodeDb(home);
    const before = await db.marker("sess_m");
    expect(before).not.toBe("");
    const fresh = new DatabaseSync(path.join(home, "db", "db.sqlite"));
    fresh.prepare("UPDATE session SET time_updated=999 WHERE id='sess_m'").run();
    fresh.close();
    expect(await db.marker("sess_m")).not.toBe(before);
    db.close();
  });
});

describe("ZcodeRuntime app-server lifecycle", () => {
  function setupRuntime(home: string, extraEnv: NodeJS.ProcessEnv = {}, launchable = true) {
    const emitted: DeviceCliMessage[] = [];
    const ended: Array<{ id: string; turn: number; reason: CliTurnReason; error?: string }> = [];
    const runtime = new ZcodeRuntime({
      ...(extraEnv.ZCODE_SESSION_DB_PATH ? {} : { homes: [home] }),
      platform: process.platform,
      env: { ...process.env, ...extraEnv },
      homedir: path.dirname(home),
      resolveLaunch: async () =>
        launchable
          ? {
              command: process.execPath,
              argsPrefix: [FIXTURE],
              env: { ZCODE_SESSION_DB_PATH: extraEnv.ZCODE_SESSION_DB_PATH ?? path.join(home, "db", "db.sqlite") },
              version: "0.18.0",
            }
          : null,
      origin: () => "http://127.0.0.1:8799",
      changed: () => {},
      emit: (msg) => emitted.push(msg),
      ended: (id, turn, reason, error) => ended.push({ id, turn, reason, error }),
    });
    cleanups.push(() => runtime.close());
    return { runtime, emitted, ended };
  }

  async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("does not advertise ZCode as startable when only a leftover database exists", async () => {
    const home = tempHome([{ id: "sess_leftover", timeUpdated: stamp(1000) }]);
    const { runtime } = setupRuntime(home, {}, false);
    expect(await runtime.probe()).toEqual({ available: false, version: null });
    await runtime.scan();
    expect(runtime.rows().map((r) => r.nativeId)).toEqual(["sess_leftover"]);
  });

  it("honors ZCODE_SESSION_DB_PATH so scanner and app-server share the same custom DB", async () => {
    const home = tempHome([{ id: "sess_custom", timeUpdated: stamp(1000) }]);
    const customDb = path.join(home, "db", "db.sqlite");
    const { runtime } = setupRuntime(home, { ZCODE_SESSION_DB_PATH: customDb });
    expect(await runtime.probe()).toEqual({ available: true, version: "0.18.0" });
    await runtime.scan();
    expect(runtime.rows().map((r) => r.nativeId)).toEqual(["sess_custom"]);
  });

  it("probes, lists models and skills, runs multiple turns cleanly, rejects failed steer and interrupts", async () => {
    const home = tempHome();
    const { runtime, ended } = setupRuntime(home);
    expect(await runtime.probe()).toEqual({ available: true, version: "0.18.0" });

    const catalog = await runtime.models();
    expect(catalog.models.map((m) => [m.id, m.efforts])).toEqual([
      ["magpie/zcode/GLM-5.3-Flash", ["low", "medium", "high"]],
      ["bigmodel/glm-5", []],
    ]);
    expect(catalog.current).toBe("magpie/zcode/GLM-5.3-Flash");

    const skills = await runtime.skills(path.dirname(home));
    expect(skills.skills.map((s) => s.name)).toEqual(["zcode-review", "zcode-fix"]);

    const id = await runtime.start(path.dirname(home), {
      model: "magpie/zcode/GLM-5.3-Flash",
      effort: "high",
      permissions: "edits",
    });
    expect(runtime.rows().find((r) => r.nativeId === id)).toMatchObject({
      engine: "zcode",
      state: "idle",
      sendVia: "host",
      liveIn: "background",
      model: "magpie/zcode/GLM-5.3-Flash",
    });

    const sent = await runtime.send(id, "hello zcode");
    expect(sent).toEqual({ turn: 1, started: true });
    await waitUntil(() => ended.length >= 1);
    expect(ended[0]).toMatchObject({ id, turn: 1, reason: "end" });
    expect(runtime.rows().find((r) => r.nativeId === id)?.state).toBe("idle");
    const page = await runtime.page(id);
    expect(page.items.some((item) => item.kind === "assistant" && item.text.includes("echo: hello zcode [edit/zcode/GLM-5.3-Flash/high]"))).toBe(true);

    // Mid-turn steer rejected by v4/command must throw rather than reporting accepted
    await runtime.send(id, "wait forever");
    await expect(runtime.send(id, "reject me", true)).rejects.toThrow();

    // Valid mid-turn steer via v4/command succeeds
    const steered = await runtime.send(id, "change course", true);
    expect(steered).toEqual({ turn: 2, started: false, accepted: true });
    await waitUntil(() => ended.length >= 2);
    expect(ended[1]).toMatchObject({ id, turn: 2, reason: "end" });
    const page2 = await runtime.page(id);
    expect(page2.items.some((item) => item.kind === "assistant" && item.text.includes("steered: change course"))).toBe(true);

    // Interrupt via session/stop
    await runtime.send(id, "wait forever");
    expect(await runtime.interrupt(id)).toEqual({ outcome: "sent" });
    await waitUntil(() => ended.length >= 3);
    expect(ended[2]).toMatchObject({ id, turn: 3, reason: "interrupted" });
  });

  it("deduplicates re-announced permissions, hashes long arguments, maps plan approval values, and handles restoreWarning", async () => {
    const home = tempHome([
      { id: "sess_account_only", directory: path.dirname(os.tmpdir()), timeUpdated: stamp(1000), title: "Account Session" },
    ]);
    const work = path.dirname(home);
    const db = new DatabaseSync(path.join(home, "db", "db.sqlite"));
    db.prepare("UPDATE session SET directory=? WHERE id='sess_account_only'").run(work);
    db.close();

    const { runtime, emitted, ended } = setupRuntime(home);
    await runtime.probe();
    await runtime.scan();
    expect(runtime.rows().find((r) => r.nativeId === "sess_account_only")?.state).toBe("stopped");

    await runtime.resume({ nativeId: "sess_account_only", cwd: work, configDir: home }, { permissions: "ask" });

    // Re-announced permission request with same requestId must produce only ONE card
    await runtime.send("sess_account_only", "ask reannounce");
    await waitUntil(() => emitted.some((m) => m.type === "cli.request" && m.kind === "permission"));
    await new Promise((r) => setTimeout(r, 40));
    const permCards = emitted.filter((m): m is Extract<DeviceCliMessage, { type: "cli.request" }> => m.type === "cli.request" && m.kind === "permission");
    expect(permCards).toHaveLength(1);
    await runtime.answer({ id: permCards[0]!.id, decision: "allow" });
    await waitUntil(() => ended.length >= 1);

    // Long-argument permission approved with `always` must NOT auto-approve a different long argument for the same tool
    await runtime.send("sess_account_only", "ask long first-cmd");
    await waitUntil(() => emitted.filter((m) => m.type === "cli.request" && m.kind === "permission").length >= 2);
    const long1 = emitted.filter((m): m is Extract<DeviceCliMessage, { type: "cli.request" }> => m.type === "cli.request" && m.kind === "permission")[1]!;
    await runtime.answer({ id: long1.id, decision: "allow", always: true });
    await waitUntil(() => ended.length >= 2);

    await runtime.send("sess_account_only", "ask long second-cmd");
    await waitUntil(() => emitted.filter((m) => m.type === "cli.request" && m.kind === "permission").length >= 3);
    const long2 = emitted.filter((m): m is Extract<DeviceCliMessage, { type: "cli.request" }> => m.type === "cli.request" && m.kind === "permission")[2]!;
    await runtime.answer({ id: long2.id, decision: "deny" });
    await waitUntil(() => ended.length >= 3);
    expect((await runtime.page("sess_account_only")).items.some((i) => i.kind === "assistant" && i.text.includes("permission denied"))).toBe(true);

    // Plan approval maps label "Approve" -> protocol value "approve"
    await runtime.send("sess_account_only", "ask plan approval");
    await waitUntil(() => emitted.some((m) => m.type === "cli.request" && m.kind === "question"));
    const planQ = emitted.find((m): m is Extract<DeviceCliMessage, { type: "cli.request" }> => m.type === "cli.request" && m.kind === "question")!;
    await runtime.answer({ id: planQ.id, decision: "allow", answers: { "Approve plan?": "Approve" } });
    await waitUntil(() => ended.length >= 4);
    expect((await runtime.page("sess_account_only")).items.some((i) => i.kind === "assistant" && i.text.includes("plan approved"))).toBe(true);
  });

  it("classifies ZCode plans and API providers, skips disabled models, and parses object thoughtLevel", async () => {
    const home = tempHome();
    const providerConfig = path.join(path.dirname(home), "provider_config.json");
    writeFileSync(
      providerConfig,
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "coding-key-1",
                providerName: "我的智谱",
                config: {
                  access: { type: "zhipu-coding-plan-api-key", apiKey: "secret-should-never-leak" },
                  api: { type: "anthropic-messages", baseUrl: "https://open.bigmodel.cn/api/anthropic" },
                },
              },
            ],
          },
        },
      }),
    );
    const meta = readZcodeProviderMeta(providerConfig);
    expect(meta.get("coding-key-1")).toEqual({
      providerId: "coding-key-1",
      providerName: "我的智谱",
      accessType: "zhipu-coding-plan-api-key",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
    });

    const { runtime } = setupRuntime(home, {
      ZCODE_FIXTURE_PLANS: "1",
      ZCODE_FIXTURE_OBJECT_THOUGHT: "1",
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerConfig,
    });
    await runtime.probe();
    const catalog = await runtime.models();
    expect(catalog.currentEffort).toBe("medium");
    expect(catalog.models.map((m) => [m.id, m.providerLabel, m.providerBadge, m.providerKind])).toEqual([
      ["account:bigmodel-individual-coding-plan/GLM-5.3", "BigModel", "个人", "plan"],
      ["account:bigmodel-start-plan/GLM-5.3-Flash", "Start Plan", "免费", "plan"],
      ["coding-key-1/GLM-5.3", "我的智谱", "套餐", "plan"],
      ["magpie/zcode/GLM-5.3-Flash", "Magpie", "API", "api"],
      ["bigmodel/glm-5", "智谱", "API", "api"],
    ]);
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
