import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HISTORY_DAYS, parseCliSessionWire } from "../../../shared/cli-agents.ts";
import { CodexScanner, codexHomes, codexLiveIn, isExcludedCodexSession, type CodexMeta } from "./codex.ts";
import type { CodexWriter } from "./liveness.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "cli-codex-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const DAY = 86_400_000;
const ID = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;

function meta(id: string, extra: Record<string, unknown> = {}) {
  return {
    timestamp: "2026-11-15T10:00:00.000Z",
    type: "session_meta",
    payload: { id, cwd: "/work/demo", originator: "codex_cli_rs", cli_version: "0.99.0", source: "cli", git: { branch: "main" }, ...extra },
  };
}
const event = (type: string, extra: Record<string, unknown> = {}, ts = "2026-11-15T10:00:01.000Z") => ({
  timestamp: ts,
  type: "event_msg",
  payload: { type, ...extra },
});
const userMsg = (message: string) => event("user_message", { message });

interface Written {
  file: string;
}

/** `ageMs` is how long before NOW the file was last written; the directory is named after that day. */
function rollout(id: string, lines: unknown[], options: { ageMs?: number; name?: string; dirAgeMs?: number } = {}): Written {
  const ageMs = options.ageMs ?? 3_600_000;
  const day = new Date(NOW - (options.dirAgeMs ?? ageMs));
  const folder = path.join(
    home,
    "sessions",
    String(day.getUTCFullYear()),
    String(day.getUTCMonth() + 1).padStart(2, "0"),
    String(day.getUTCDate()).padStart(2, "0"),
  );
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, options.name ?? `rollout-2026-11-15T10-00-00-${id}.jsonl`);
  writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  const mtime = new Date(NOW - ageMs);
  utimesSync(file, mtime, mtime);
  return { file };
}

const writerOf = (answer: CodexWriter) => ({ writer: () => answer });
const scan = (scanner: CodexScanner) => scanner.scan({ now: NOW });

describe("codexHomes", () => {
  it("returns ~/.codex and CODEX_HOME once each", () => {
    expect(codexHomes({}, "/home/x")).toEqual([path.resolve("/home/x", ".codex")]);
    expect(codexHomes({ CODEX_HOME: "/data/codex" }, "/home/x")).toHaveLength(2);
    expect(codexHomes({ CODEX_HOME: path.resolve("/home/x", ".codex") }, "/home/x")).toHaveLength(1);
  });
});

describe("exclusions and liveIn", () => {
  const base: CodexMeta = { id: ID(1), originator: "codex_cli_rs", source: "cli" };
  it("excludes subagents, exec, SDK runs and Guardian", () => {
    expect(isExcludedCodexSession(base)).toBe(false);
    expect(isExcludedCodexSession({ ...base, threadSource: "subagent" })).toBe(true);
    expect(isExcludedCodexSession({ ...base, source: { subagent: { thread_spawn: {} } } })).toBe(true);
    expect(isExcludedCodexSession({ ...base, source: { subagent: "guardian" } })).toBe(true);
    expect(isExcludedCodexSession({ ...base, source: "exec" })).toBe(true);
    expect(isExcludedCodexSession({ ...base, originator: "codex_exec" })).toBe(true);
    expect(isExcludedCodexSession({ ...base, originator: "codex_sdk_ts" })).toBe(true);
    expect(isExcludedCodexSession({ ...base, originator: "Codex Desktop", source: "vscode" })).toBe(false);
  });
  it("maps the originator to where the session is open", () => {
    expect(codexLiveIn({ id: "a", originator: "Codex Desktop", source: "vscode" })).toBe("desktop");
    expect(codexLiveIn({ id: "a", originator: "codex_work_desktop" })).toBe("desktop");
    expect(codexLiveIn({ id: "a", originator: "codex_cli_rs", source: "cli" })).toBe("terminal");
    expect(codexLiveIn({ id: "a", source: "cli" })).toBe("terminal");
    expect(codexLiveIn({ id: "a", originator: "something_else", source: "mcp" })).toBeUndefined();
  });
});

describe("CodexScanner fork parent", () => {
  it("maps session_meta.forked_from_id to forkOf, and ignores a missing, self or invalid one", async () => {
    rollout(ID(1), [meta(ID(1)), userMsg("parent")]);
    rollout(ID(2), [meta(ID(2), { forked_from_id: ID(1) }), userMsg("child")]);
    rollout(ID(3), [meta(ID(3), { forked_from_id: ID(3) }), userMsg("self")]);
    rollout(ID(4), [meta(ID(4), { forked_from_id: "bad id with spaces" }), userMsg("bad")]);
    const rows = await scan(new CodexScanner(home, writerOf("no")));
    const forkOf = Object.fromEntries(rows.map((r) => [r.nativeId, r.forkOf]));
    expect(forkOf).toEqual({ [ID(1)]: undefined, [ID(2)]: ID(1), [ID(3)]: undefined, [ID(4)]: undefined });
  });
});

describe("CodexScanner rows", () => {
  it("syncs first prompts and distinct empty names only for NexAgent placeholders", async () => {
    const legacy = "NexAgent 新会话";
    const entries = [
      { id: ID(1), name: legacy, message: "修复侧栏排序" },
      { id: ID(2), name: "NexAgent 新会话 · 00000002", message: "核对下载链接" },
      { id: ID(3), name: "我取的名字", message: "第三条消息" },
      { id: ID(4), name: legacy, message: "" },
      { id: ID(5), name: legacy, message: "" },
    ];
    for (const { id, message } of entries) {
      rollout(id, [meta(id, { originator: "nexbot" }), userMsg("<environment_context>"), ...(message ? [userMsg(message)] : [])]);
    }
    writeFileSync(path.join(home, "session_index.jsonl"), entries.map(e => JSON.stringify({ id: e.id, thread_name: e.name })).join("\n") + "\n");
    const writes: Record<string, string>[] = [];
    const scanner = new CodexScanner(home, { ...writerOf("no"), updateNames: async (_, names) => { writes.push(Object.fromEntries(names)); } });
    const rows = await scan(scanner);
    expect(rows.find(row => row.nativeId === ID(3))?.title).toBe("我取的名字");
    expect(writes).toEqual([{ [ID(1)]: "修复侧栏排序", [ID(2)]: "核对下载链接", [ID(4)]: "NexAgent 新会话 · 00000004", [ID(5)]: "NexAgent 新会话 · 00000005" }]);
    await scan(scanner);
    expect(writes).toHaveLength(1);
  });
  it("builds a row from session_meta, turn_context and the first user message", async () => {
    rollout(ID(1), [
      meta(ID(1)),
      { timestamp: "2026-11-15T10:00:01.000Z", type: "turn_context", payload: { model: "gpt-5-codex" } },
      { timestamp: "2026-11-15T10:00:02.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/x</cwd>\n</environment_context>" }] } },
      userMsg("  Add a   retry\nto the client  "),
      event("task_started", {}, "2026-11-15T10:00:03.000Z"),
      event("task_complete", {}, "2026-11-15T10:30:00.000Z"),
    ]);
    const [row] = await scan(new CodexScanner(home, writerOf("yes")));
    expect(row).toMatchObject({
      engine: "codex",
      nativeId: ID(1),
      configDir: home,
      cwd: "/work/demo",
      title: "Add a retry to the client",
      gitBranch: "main",
      model: "gpt-5-codex",
      cliVersion: "0.99.0",
      state: "idle",
      liveIn: "terminal",
      lastActivityAt: Date.parse("2026-11-15T10:30:00.000Z"),
    });
    expect(row.transcript.endsWith(`${ID(1)}.jsonl`)).toBe(true);
    expect(row.writerUnknown).toBeUndefined();
  });

  it("prefers the session_index name and lets a later line win", async () => {
    rollout(ID(1), [meta(ID(1)), userMsg("fallback words")]);
    writeFileSync(
      path.join(home, "session_index.jsonl"),
      [
        JSON.stringify({ id: ID(1), thread_name: "First name", updated_at: "2026-11-15T09:00:00Z" }),
        JSON.stringify({ id: ID(2), thread_name: "Other", updated_at: "2026-11-15T09:00:00Z" }),
        JSON.stringify({ id: ID(1), thread_name: "Renamed", updated_at: "2026-11-15T09:30:00Z" }),
      ].join("\n") + "\n",
    );
    const [row] = await scan(new CodexScanner(home, writerOf("no")));
    expect(row.title).toBe("Renamed");
  });

  it("reads the index incrementally: partial lines wait, appends apply, truncation resets", async () => {
    rollout(ID(1), [meta(ID(1)), userMsg("fallback")]);
    const index = path.join(home, "session_index.jsonl");
    const scanner = new CodexScanner(home, writerOf("no"));
    const line = JSON.stringify({ id: ID(1), thread_name: "Partial name" });
    writeFileSync(index, line.slice(0, 15));
    expect((await scan(scanner))[0].title).toBe("fallback");
    appendFileSync(index, `${line.slice(15)}\n`);
    expect((await scan(scanner))[0].title).toBe("Partial name");
    appendFileSync(index, JSON.stringify({ id: ID(1), thread_name: "Later name" }) + "\n");
    expect((await scan(scanner))[0].title).toBe("Later name");
    truncateSync(index, 0);
    writeFileSync(index, JSON.stringify({ id: ID(1), thread_name: "After truncation" }) + "\n");
    expect((await scan(scanner))[0].title).toBe("After truncation");
  });

  it("clips a long thread_name to the wire limit and emits rows the parser accepts", async () => {
    rollout(ID(1), [meta(ID(1), { git: undefined })]);
    writeFileSync(path.join(home, "session_index.jsonl"), JSON.stringify({ id: ID(1), thread_name: "t".repeat(1000) }) + "\n");
    const [row] = await scan(new CodexScanner(home, writerOf("unknown")));
    const { transcript: _transcript, ...wire } = row;
    const parsed = parseCliSessionWire(wire);
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toHaveLength(300);
    expect(parsed!.writerUnknown).toBe(true);
  });

  it("finds session_meta when the first line is larger than the head window", async () => {
    rollout(ID(1), [meta(ID(1), { base_instructions: "z".repeat(300 * 1024) }), userMsg("after the big line")]);
    const [row] = await scan(new CodexScanner(home, writerOf("no")));
    expect(row).toMatchObject({ nativeId: ID(1), cwd: "/work/demo" });
  });

  it("skips excluded sessions and files without a valid session_meta", async () => {
    rollout(ID(1), [meta(ID(1))]);
    rollout(ID(2), [meta(ID(2), { thread_source: "subagent" })]);
    rollout(ID(3), [meta(ID(3), { source: { subagent: "review" } })]);
    rollout(ID(4), [meta(ID(4), { source: "exec", originator: "codex_exec" })]);
    rollout(ID(5), [meta(ID(5), { originator: "codex_sdk_ts" })]);
    rollout(ID(6), ["not json at all"]);
    rollout(ID(7), [{ type: "event_msg", payload: { type: "task_started" } }]);
    const rows = await scan(new CodexScanner(home, writerOf("no")));
    expect(rows.map((r) => r.nativeId)).toEqual([ID(1)]);
  });
});

describe("CodexScanner state", () => {
  const open = (id: string) => [meta(id), userMsg("go"), event("task_started")];

  it("is running when a turn is open and the file was written within 60 s", async () => {
    rollout(ID(1), open(ID(1)), { ageMs: 10_000 });
    const [row] = await scan(new CodexScanner(home, writerOf("no")));
    expect(row.state).toBe("running");
    expect(row.liveIn).toBe("terminal");
  });

  it("keeps a quiet open turn running while the writer still holds it", async () => {
    rollout(ID(1), open(ID(1)), { ageMs: 120_000 });
    expect((await scan(new CodexScanner(home, writerOf("yes"))))[0]).toMatchObject({ state: "running", liveIn: "terminal" });
    const stopped = (await scan(new CodexScanner(home, writerOf("no"))))[0];
    expect(stopped.state).toBe("stopped");
    expect(stopped.liveIn).toBeUndefined();
    expect(stopped.writerUnknown).toBeUndefined();
    const unknown = (await scan(new CodexScanner(home, writerOf("unknown"))))[0];
    expect(unknown).toMatchObject({ state: "stopped", writerUnknown: true });
  });

  it("ends the turn on task_complete and on turn_aborted", async () => {
    rollout(ID(1), [...open(ID(1)), event("task_complete")], { ageMs: 5000 });
    rollout(ID(2), [...open(ID(2)), event("turn_aborted", { reason: "interrupted" })], { ageMs: 5000 });
    const rows = await scan(new CodexScanner(home, writerOf("yes")));
    expect(rows.map((r) => r.state)).toEqual(["idle", "idle"]);
  });

  it("reports a new turn after the last completed one", async () => {
    rollout(ID(1), [...open(ID(1)), event("task_complete"), event("task_started")], { ageMs: 5000 });
    expect((await scan(new CodexScanner(home, writerOf("no"))))[0].state).toBe("running");
  });

  it("follows the file: a cached tail is refreshed when the file changes", async () => {
    const { file } = rollout(ID(1), open(ID(1)), { ageMs: 5000 });
    const scanner = new CodexScanner(home, writerOf("yes"));
    expect((await scan(scanner))[0].state).toBe("running");
    appendFileSync(file, JSON.stringify(event("task_complete", {}, "2026-11-15T11:59:59.000Z")) + "\n");
    const later = new Date(NOW - 1000);
    utimesSync(file, later, later);
    const [row] = await scan(scanner);
    expect(row.state).toBe("idle");
    expect(row.lastActivityAt).toBe(Date.parse("2026-11-15T11:59:59.000Z"));
  });

  it("marks desktop sessions with desktop", async () => {
    rollout(ID(1), [meta(ID(1), { originator: "Codex Desktop", source: "vscode" }), event("task_started")], { ageMs: 1000 });
    expect((await scan(new CodexScanner(home, writerOf("no"))))[0]).toMatchObject({ state: "running", liveIn: "desktop" });
  });
});

describe("CodexScanner window and segments", () => {
  it("lists sessions without a time limit by default, honors an explicit historyDays window, and scans archived_sessions", async () => {
    rollout(ID(1), [meta(ID(1))], { ageMs: 2 * DAY });
    rollout(ID(2), [meta(ID(2))], { ageMs: (HISTORY_DAYS - 1) * DAY });
    rollout(ID(3), [meta(ID(3))], { ageMs: (HISTORY_DAYS + 5) * DAY });
    // recent directory, but the file itself has been untouched for longer than the window
    rollout(ID(4), [meta(ID(4))], { ageMs: (HISTORY_DAYS + 1) * DAY, dirAgeMs: DAY });
    // old directory, written recently
    rollout(ID(5), [meta(ID(5))], { ageMs: DAY, dirAgeMs: (HISTORY_DAYS + 20) * DAY });
    const archivedDir = path.join(home, "archived_sessions");
    mkdirSync(archivedDir, { recursive: true });
    writeFileSync(path.join(archivedDir, `rollout-2026-10-01T00-00-00-${ID(6)}.jsonl`), `${JSON.stringify(meta(ID(6)))}\n`, "utf8");

    const all = await scan(new CodexScanner(home, writerOf("no")));
    expect(all.map((r) => r.nativeId).sort()).toEqual([ID(1), ID(2), ID(3), ID(4), ID(5), ID(6)].sort());
    expect(all.find((r) => r.nativeId === ID(6))?.archived).toBe(true);
    expect(all.find((r) => r.nativeId === ID(3))?.archived).toBeUndefined();

    const windowed = await scan(new CodexScanner(home, { ...writerOf("no"), historyDays: HISTORY_DAYS }));
    expect(windowed.filter((r) => !r.archived).map((r) => r.nativeId)).toEqual([ID(1), ID(2)]);
  });

  it("merges continuation segments by session_meta id and keeps the newest", async () => {
    rollout(ID(1), [meta(ID(1)), userMsg("original start")], { ageMs: 2 * DAY, name: `rollout-2026-11-13T10-00-00-${ID(1)}.jsonl` });
    const newest = rollout(ID(1), [meta(ID(1)), userMsg("continued"), event("task_started")], {
      ageMs: 5000,
      name: `rollout-2026-11-15T11-00-00-${ID(1)}_0b0a0000-0000-4000-8000-000000000009.jsonl`,
    });
    rollout(ID(2), [meta(ID(2))], { ageMs: 3 * DAY });
    const rows = await scan(new CodexScanner(home, writerOf("no")));
    expect(rows.map((r) => r.nativeId)).toEqual([ID(1), ID(2)]);
    expect(rows[0].transcript).toBe(newest.file);
    expect(rows[0].state).toBe("running");
  });

  it("returns newest first, capped at maxSessions", async () => {
    for (let i = 1; i <= 5; i += 1) rollout(ID(i), [meta(ID(i))], { ageMs: i * 3_600_000 });
    const rows = await scan(new CodexScanner(home, { ...writerOf("no"), maxSessions: 3 }));
    expect(rows.map((r) => r.nativeId)).toEqual([ID(1), ID(2), ID(3)]);
  });

  it("returns an empty list for a home without sessions", async () => {
    expect(await scan(new CodexScanner(path.join(home, "nope"), writerOf("no")))).toEqual([]);
  });

  it("drops a session whose file was removed and picks up a new one", async () => {
    const first = rollout(ID(1), [meta(ID(1))]);
    const scanner = new CodexScanner(home, writerOf("no"));
    expect((await scan(scanner)).map((r) => r.nativeId)).toEqual([ID(1)]);
    rmSync(first.file);
    rollout(ID(2), [meta(ID(2))]);
    expect((await scan(scanner)).map((r) => r.nativeId)).toEqual([ID(2)]);
  });
});
