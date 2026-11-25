import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI_LIMITS, HISTORY_DAYS, parseCliSessionWire } from "../../../shared/cli-agents.ts";
import {
  claudeConfigDirs,
  claudeLiveIn,
  claudeState,
  mergeClaude,
  resetClaudeHistoryCache,
  scanHistory,
  scanLive,
  type ClaudeHistoryEntry,
  type HistoryCache,
  type LiveClaudeSession,
} from "./claude.ts";
import { resetProcessStartCache, type CommandRunner } from "./liveness.ts";
import type { DesktopIndex, DesktopSessionState } from "./claude-desktop.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "cli-claude-"));
  resetProcessStartCache();
  resetClaudeHistoryCache();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LSTART = "Sun Nov 15 09:00:00 2026";

function writeLive(pid: number, body: Record<string, unknown>): void {
  mkdirSync(path.join(dir, "sessions"), { recursive: true });
  writeFileSync(path.join(dir, "sessions", `${pid}.json`), JSON.stringify({ pid, ...body }));
}

const unixStart = (lstartByPid: Record<number, string>): { platform: NodeJS.Platform; run: CommandRunner } => ({
  platform: "linux",
  run: async (_file, args) => {
    const pids = args[args.length - 1].split(",").map(Number);
    return { code: 0, stdout: pids.filter((p) => lstartByPid[p]).map((p) => `${p} ${lstartByPid[p]}`).join("\n") };
  },
});

function writeTranscript(project: string, id: string, lines: unknown[], mtime?: Date): string {
  const folder = path.join(dir, "projects", project);
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${id}.jsonl`);
  writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
}

const user = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "user",
  timestamp: "2026-11-15T10:00:00.000Z",
  cwd: "/work/demo",
  gitBranch: "main",
  version: "2.1.0",
  entrypoint: "cli",
  message: { role: "user", content: text },
  ...extra,
});

describe("claudeConfigDirs", () => {
  it("returns ~/.claude and CLAUDE_CONFIG_DIR once each", () => {
    expect(claudeConfigDirs({}, "/home/x")).toEqual([path.resolve("/home/x", ".claude")]);
    const dirs = claudeConfigDirs({ CLAUDE_CONFIG_DIR: "/custom/claude" }, "/home/x");
    expect(dirs).toHaveLength(2);
    expect(dirs[1]).toBe(path.resolve("/custom/claude"));
    expect(claudeConfigDirs({ CLAUDE_CONFIG_DIR: path.join("/home/x", ".claude") }, "/home/x")).toHaveLength(1);
  });
});

describe("status and liveIn mapping", () => {
  it("maps busy, waiting, idle and shell", () => {
    expect(claudeState("busy")).toBe("running");
    expect(claudeState("waiting")).toBe("waiting");
    expect(claudeState("idle")).toBe("idle");
    expect(claudeState("shell")).toBe("idle");
    expect(claudeState(undefined)).toBe("idle");
    expect(claudeState("something-new")).toBe("idle");
  });
  it("maps entrypoint and kind", () => {
    expect(claudeLiveIn("cli", "interactive")).toBe("terminal");
    expect(claudeLiveIn("claude-desktop", undefined)).toBe("desktop");
    expect(claudeLiveIn("claude-desktop-local", "interactive")).toBe("desktop");
    expect(claudeLiveIn("cli", "background")).toBe("background");
    expect(claudeLiveIn("cli", "bg")).toBe("background");
    expect(claudeLiveIn("sdk-ts", "interactive")).toBeUndefined();
    expect(claudeLiveIn(undefined, undefined)).toBeUndefined();
  });
});

describe("scanLive", () => {
  it("reads every row of the mapping table", async () => {
    writeLive(101, { sessionId: SID(1), cwd: "/a", kind: "interactive", entrypoint: "cli", status: "busy", procStart: LSTART, updatedAt: 1_700_000_000_000, version: "2.1.1" });
    writeLive(102, { sessionId: SID(2), cwd: "/b", entrypoint: "claude-desktop", status: "waiting", waitingFor: "approve Bash", procStart: LSTART });
    writeLive(103, { sessionId: SID(3), cwd: "/c", kind: "background", entrypoint: "cli", status: "idle", procStart: LSTART });
    writeLive(104, { sessionId: SID(4), cwd: "/d", entrypoint: "cli", status: "shell", procStart: LSTART });
    const live = await scanLive(dir, { isAlive: () => true, start: unixStart({ 101: LSTART, 102: LSTART, 103: LSTART, 104: LSTART }) });
    const by = Object.fromEntries(live.map((l) => [l.sessionId, l]));
    expect(by[SID(1)]).toMatchObject({ pid: 101, state: "running", liveIn: "terminal", cwd: "/a", version: "2.1.1", updatedAt: 1_700_000_000_000, unverified: false });
    expect(by[SID(2)]).toMatchObject({ state: "waiting", waitingFor: "approve Bash", liveIn: "desktop" });
    expect(by[SID(3)]).toMatchObject({ state: "idle", liveIn: "background" });
    expect(by[SID(4)]).toMatchObject({ state: "idle", liveIn: "terminal" });
    expect(by[SID(1)].waitingFor).toBeUndefined();
  });

  it("never reads *.key files, even when they hold session JSON", async () => {
    mkdirSync(path.join(dir, "sessions"), { recursive: true });
    writeFileSync(path.join(dir, "sessions", "555.key"), JSON.stringify({ pid: 555, sessionId: SID(9), cwd: "/secret" }));
    writeFileSync(path.join(dir, "sessions", "notes.json"), JSON.stringify({ pid: 556, sessionId: SID(8) }));
    expect(await scanLive(dir, { isAlive: () => true, start: unixStart({}) })).toEqual([]);
  });

  it("drops a dead pid", async () => {
    writeLive(201, { sessionId: SID(1), status: "idle", procStart: LSTART });
    expect(await scanLive(dir, { isAlive: () => false, start: unixStart({}) })).toEqual([]);
  });

  it("drops a pid that now belongs to another process (reuse)", async () => {
    writeLive(301, { sessionId: SID(1), status: "busy", procStart: LSTART });
    writeLive(302, { sessionId: SID(2), status: "busy", procStart: LSTART });
    const live = await scanLive(dir, { isAlive: () => true, start: unixStart({ 301: "Mon Nov 16 01:00:00 2026", 302: LSTART }) });
    expect(live.map((l) => l.sessionId)).toEqual([SID(2)]);
  });

  it("keeps the session as unverified when the start time cannot be queried", async () => {
    writeLive(401, { sessionId: SID(1), status: "busy", procStart: LSTART });
    const start = { platform: "linux" as const, run: (async () => ({ code: 9, stdout: "" })) satisfies CommandRunner };
    const live = await scanLive(dir, { isAlive: () => true, start });
    expect(live).toHaveLength(1);
    expect(live[0].unverified).toBe(true);
  });

  it("compares procStartFt on Windows and ignores the other flavour", async () => {
    writeLive(501, { sessionId: SID(1), status: "busy", procStartFt: "133800000000000000" });
    writeLive(502, { sessionId: SID(2), status: "busy", procStartFt: "133800000000000000" });
    writeLive(503, { sessionId: SID(3), status: "busy", procStart: LSTART });
    const start = {
      platform: "win32" as const,
      run: (async () => ({ code: 0, stdout: "501 133800000010000000\n502 133900000000000000\n503 133800000000000000\n" })) satisfies CommandRunner,
    };
    const live = await scanLive(dir, { isAlive: () => true, start });
    const by = Object.fromEntries(live.map((l) => [l.sessionId, l]));
    expect(by[SID(1)].unverified).toBe(false);
    expect(by[SID(2)]).toBeUndefined();
    expect(by[SID(3)].unverified).toBe(true);
  });

  it("keeps the newest file when two pids claim one session id and tolerates broken files", async () => {
    writeLive(601, { sessionId: SID(1), status: "idle", updatedAt: 1_700_000_000_000, procStart: LSTART });
    writeLive(602, { sessionId: SID(1), status: "busy", updatedAt: 1_700_000_005_000, procStart: LSTART });
    writeFileSync(path.join(dir, "sessions", "603.json"), "{not json");
    writeLive(604, { sessionId: "../escape", status: "busy" });
    const live = await scanLive(dir, { isAlive: () => true, start: unixStart({ 601: LSTART, 602: LSTART }) });
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ pid: 602, state: "running" });
  });

  it("returns nothing for a missing directory and converts second timestamps", async () => {
    expect(await scanLive(path.join(dir, "nope"))).toEqual([]);
    writeLive(701, { sessionId: SID(1), status: "idle", updatedAt: 1_700_000_000, procStart: LSTART });
    const live = await scanLive(dir, { isAlive: () => true, start: unixStart({ 701: LSTART }) });
    expect(live[0].updatedAt).toBe(1_700_000_000_000);
  });

  it("names the session only from the live file when nameSource is not derived", async () => {
    writeLive(801, { sessionId: SID(1), status: "idle", name: "My work", nameSource: "user", procStart: LSTART });
    const live = await scanLive(dir, { isAlive: () => true, start: unixStart({ 801: LSTART }) });
    expect(live[0]).toMatchObject({ name: "My work", nameSource: "user" });
  });
});

describe("scanHistory", () => {
  it("reads cwd, branch, version, model, first user text and the last timestamp", async () => {
    writeTranscript("proj", SID(1), [
      { type: "queue-operation", operation: "enqueue" },
      user("<system-reminder>ignore</system-reminder>", { isMeta: true }),
      user("<command-name>/clear</command-name>"),
      user("   Fix   the\nfailing test please   "),
      { type: "assistant", timestamp: "2026-11-15T10:05:00.000Z", message: { role: "assistant", model: "claude-opus-4", content: [] } },
      { type: "mode", mode: "plan" },
    ]);
    const [entry] = await scanHistory(dir, { now: Date.now() });
    expect(entry).toMatchObject({
      sessionId: SID(1),
      cwd: "/work/demo",
      gitBranch: "main",
      version: "2.1.0",
      entrypoint: "cli",
      model: "claude-opus-4",
      mode: "plan",
      firstUser: "Fix the failing test please",
    });
    expect(entry.lastTimestamp).toBe(Date.parse("2026-11-15T10:05:00.000Z"));
  });

  it("cuts the fallback title at 60 characters without splitting a surrogate pair", async () => {
    writeTranscript("proj", SID(1), [user("😀".repeat(80))]);
    const [entry] = await scanHistory(dir, { now: Date.now() });
    expect(Array.from(entry.firstUser ?? "")).toHaveLength(60);
    expect(entry.firstUser).toBe("😀".repeat(60));
  });

  it("takes the last customTitle, agentName and mode from the tail of a large file", async () => {
    const filler = Array.from({ length: 400 }, (_, i) => ({ type: "user", timestamp: "2026-11-15T10:00:00.000Z", message: { role: "user", content: `${i} ${"x".repeat(400)}` } }));
    writeTranscript("proj", SID(1), [
      user("first prompt"),
      { type: "custom-title", customTitle: "Old title" },
      ...filler,
      { type: "custom-title", customTitle: "New title" },
      { type: "agent-name", agentName: "reviewer" },
      { type: "mode", mode: "acceptEdits" },
      { type: "system", timestamp: "2026-11-15T12:00:00.000Z" },
    ]);
    const [entry] = await scanHistory(dir, { now: Date.now() });
    expect(entry).toMatchObject({ customTitle: "New title", agentName: "reviewer", mode: "acceptEdits", firstUser: "first prompt" });
    expect(entry.lastTimestamp).toBe(Date.parse("2026-11-15T12:00:00.000Z"));
  });

  it("survives a cut line at the tail boundary", async () => {
    const filler = Array.from({ length: 300 }, () => ({ type: "user", timestamp: "2026-11-15T10:00:00.000Z", message: { role: "user", content: "y".repeat(500) } }));
    writeTranscript("proj", SID(1), [user("hello"), ...filler, '{"type":"custom-title","customTi']);
    const [entry] = await scanHistory(dir, { now: Date.now() });
    expect(entry.firstUser).toBe("hello");
    expect(entry.customTitle).toBeUndefined();
  });

  it("skips subagent transcripts, sidechain files and names that are not session ids", async () => {
    writeTranscript("proj", SID(1), [user("main")]);
    mkdirSync(path.join(dir, "projects", "proj", SID(1), "subagents"), { recursive: true });
    writeFileSync(path.join(dir, "projects", "proj", SID(1), "subagents", "agent-a1.jsonl"), JSON.stringify(user("sub")) + "\n");
    writeTranscript("proj", SID(2), [user("side", { isSidechain: true })]);
    writeTranscript("proj", "has space", [user("odd")]);
    writeFileSync(path.join(dir, "projects", "proj", "notes.txt"), "x");
    const entries = await scanHistory(dir, { now: Date.now() });
    expect(entries.map((e) => e.sessionId)).toEqual([SID(1)]);
  });

  it("keeps only files modified within the window and caps the count, newest first", async () => {
    const now = Date.now();
    const days = (n: number) => new Date(now - n * 86_400_000);
    writeTranscript("a", SID(1), [user("old")], days(HISTORY_DAYS + 1));
    writeTranscript("a", SID(2), [user("edge")], days(HISTORY_DAYS - 1));
    writeTranscript("b", SID(3), [user("new")], days(0));
    writeTranscript("b", SID(4), [user("mid")], days(3));
    const all = await scanHistory(dir, { now });
    expect(all.map((e) => e.sessionId)).toEqual([SID(3), SID(4), SID(2)]);
    const capped = await scanHistory(dir, { now, maxSessions: 2 });
    expect(capped.map((e) => e.sessionId)).toEqual([SID(3), SID(4)]);
  });

  it("still finds an included session id beyond the window and the cap", async () => {
    const now = Date.now();
    writeTranscript("a", SID(1), [user("ancient")], new Date(now - 60 * 86_400_000));
    writeTranscript("a", SID(2), [user("a")], new Date(now - 1000));
    writeTranscript("a", SID(3), [user("b")], new Date(now - 2000));
    const entries = await scanHistory(dir, { now, maxSessions: 1, include: [SID(1), SID(3)] });
    expect(new Set(entries.map((e) => e.sessionId))).toEqual(new Set([SID(1), SID(2), SID(3)]));
  });

  it("does not read a file again while (size, mtime) is unchanged", async () => {
    const mtime = new Date(Date.now() - 5000);
    const file = writeTranscript("proj", SID(1), [user("original")], mtime);
    const sets: string[] = [];
    const store = new Map<string, { size: number; mtimeMs: number; entry: ClaudeHistoryEntry | null }>();
    const cache: HistoryCache = {
      get: (key) => store.get(key),
      set: (key, value) => {
        sets.push(key);
        store.set(key, value);
      },
      delete: (key) => void store.delete(key),
      keys: () => store.keys(),
    };
    expect((await scanHistory(dir, { cache }))[0].firstUser).toBe("original");
    expect((await scanHistory(dir, { cache }))[0].firstUser).toBe("original");
    expect(sets).toEqual([file]);
    // same length, same mtime: served from the cache even though the bytes changed
    writeFileSync(file, JSON.stringify(user("changed!")) .padEnd(JSON.stringify(user("original")).length, " ") + "\n");
    utimesSync(file, mtime, mtime);
    expect((await scanHistory(dir, { cache }))[0].firstUser).toBe("original");
    // a different size is re-read
    writeFileSync(file, JSON.stringify(user("grown and longer")) + "\n");
    expect((await scanHistory(dir, { cache }))[0].firstUser).toBe("grown and longer");
    expect(sets).toHaveLength(2);
  });

  it("returns an empty list when projects is missing", async () => {
    expect(await scanHistory(dir)).toEqual([]);
  });
});

describe("mergeClaude", () => {
  const entry = (extra: Partial<ClaudeHistoryEntry> = {}): ClaudeHistoryEntry => ({
    sessionId: SID(1),
    transcript: "/t/1.jsonl",
    mtimeMs: 2000,
    size: 10,
    cwd: "/hist",
    gitBranch: "dev",
    version: "2.0.0",
    model: "claude-opus-4",
    lastTimestamp: 3000,
    firstUser: "first words",
    ...extra,
  });
  const live = (extra: Partial<LiveClaudeSession> = {}): LiveClaudeSession => ({
    sessionId: SID(1),
    pid: 9,
    cwd: "/live",
    state: "running",
    updatedAt: 5000,
    unverified: false,
    ...extra,
  });

  it("marks a session without a live process stopped", () => {
    const [row] = mergeClaude("/cfg", [], [entry()]);
    expect(row).toMatchObject({
      engine: "claude",
      nativeId: SID(1),
      configDir: "/cfg",
      cwd: "/hist",
      title: "first words",
      state: "stopped",
      gitBranch: "dev",
      model: "claude-opus-4",
      cliVersion: "2.0.0",
      lastActivityAt: 3000,
      transcript: "/t/1.jsonl",
    });
    expect(row.liveIn).toBeUndefined();
    expect(row.waitingFor).toBeUndefined();
  });

  it("overlays the live state, liveIn, waitingFor, version and the later activity time", () => {
    const [row] = mergeClaude("/cfg", [live({ state: "waiting", waitingFor: "approve", liveIn: "desktop", version: "2.2.0" })], [entry()]);
    expect(row).toMatchObject({ state: "waiting", waitingFor: "approve", liveIn: "desktop", cliVersion: "2.2.0", cwd: "/live", lastActivityAt: 5000 });
  });

  it("applies the title priority", () => {
    const title = (e: Partial<ClaudeHistoryEntry>, l?: Partial<LiveClaudeSession>) => mergeClaude("/c", l ? [live(l)] : [], [entry(e)])[0].title;
    expect(title({ customTitle: "Custom", agentName: "agent" }, { name: "live name", nameSource: "user" })).toBe("Custom");
    expect(title({ agentName: "agent" }, { name: "live name", nameSource: "user" })).toBe("live name");
    expect(title({ agentName: "agent" }, { name: "derived name", nameSource: "derived" })).toBe("agent");
    expect(title({ agentName: "agent" }, { name: "live name" })).toBe("live name");
    expect(title({ agentName: "agent" })).toBe("agent");
    expect(title({})).toBe("first words");
    expect(title({ firstUser: undefined })).toBe("");
  });

  it("keeps a live session that has no transcript yet", () => {
    const rows = mergeClaude("/cfg", [live()], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "running", transcript: "", cwd: "/live", lastActivityAt: 5000, title: "" });
  });

  it("emits rows that pass the wire parser, with long fields clipped", () => {
    const rows = mergeClaude("/cfg", [live({ name: "n".repeat(1000), nameSource: "user", waitingFor: undefined })], [entry({ customTitle: undefined, gitBranch: "b".repeat(1000) })]);
    const { transcript: _transcript, ...wire } = rows[0];
    const parsed = parseCliSessionWire(wire);
    expect(parsed).not.toBeNull();
    expect(parsed!.title.length).toBeLessThanOrEqual(CLI_LIMITS.title);
    expect(parsed!.gitBranch!.length).toBeLessThanOrEqual(CLI_LIMITS.gitBranch);
  });
});

describe("SDK and automation sessions", () => {
  it("leaves out a program's one-shot claude -p run (sdk-cli first to last) without using up the cap", async () => {
    const now = Date.now();
    writeTranscript("proj", SID(1), [user("real one", { entrypoint: "cli" })], new Date(now - 5000));
    writeTranscript("proj", SID(3), [user("print mode", { entrypoint: "sdk-cli" })], new Date(now - 2000));
    // the entrypoint is on a later record, after a record that has none (queue operations come first)
    writeTranscript("proj", SID(4), [{ type: "queue-operation", operation: "enqueue" }, user("late", { entrypoint: "sdk-cli" })], new Date(now - 3000));
    const entries = await scanHistory(dir, { now, maxSessions: 1 });
    expect(entries.map((e) => e.sessionId)).toEqual([SID(1)]);
  });

  it("lists the Agent SDKs' runs and a one-shot session later used from a terminal", async () => {
    const now = Date.now();
    writeTranscript("proj", SID(2), [user("a host's session", { entrypoint: "sdk-ts" })], new Date(now - 1000));
    writeTranscript("proj", SID(5), [user("started by a script", { entrypoint: "sdk-cli" }), user("then typed into", { entrypoint: "cli" })], new Date(now - 2000));
    const entries = await scanHistory(dir, { now });
    expect(entries.map((e) => e.sessionId).sort()).toEqual([SID(2), SID(5)]);
  });

  it("does not list a running SDK claude as running: it belongs to its host, its transcript is listed", () => {
    const sdk = { sessionId: SID(9), pid: 9, cwd: "/x", entrypoint: "sdk-ts", state: "running" as const, updatedAt: 1, unverified: false };
    expect(mergeClaude("/cfg", [sdk], [])).toEqual([]);
    const withTranscript: ClaudeHistoryEntry = { sessionId: SID(9), transcript: "/t", mtimeMs: 1, size: 1, entrypoint: "sdk-ts" };
    expect(mergeClaude("/cfg", [sdk], [withTranscript])).toMatchObject([{ nativeId: SID(9), state: "stopped" }]);
  });
});

/** A desktop sidebar index for merge tests. */
function sidebar(sessions: Record<string, DesktopSessionState>, extra: Partial<DesktopIndex> = {}): DesktopIndex {
  return { readable: Object.keys(sessions).length, sessions: new Map(Object.entries(sessions)), priorOf: new Map(), mentioned: new Set(), deleted: new Set(), ...extra };
}
const entryOf = (id: string, extra: Partial<ClaudeHistoryEntry> = {}): ClaudeHistoryEntry => ({ sessionId: id, transcript: `/t/${id}`, mtimeMs: 1000, size: 1, ...extra });
const NOW = 10 * 60_000;

describe("lineage", () => {
  it("never guesses lineage from copied history: a resume or a rewind copies it too", async () => {
    const now = Date.now();
    const msg = (uuid: string) => ({ type: "user", uuid, parentUuid: null, timestamp: "2026-11-15T10:00:00.000Z", cwd: "/work/demo", entrypoint: "cli", message: { role: "user", content: uuid } });
    writeTranscript("proj", SID(1), ["u-1", "u-2", "u-3"].map(msg), new Date(now - 9000));
    writeTranscript("proj", SID(2), ["u-1", "u-2", "u-3", "u-4"].map(msg), new Date(now - 1000));
    const rows = mergeClaude(dir, [], await scanHistory(dir, { now }));
    expect(rows.map((r) => r.forkOf)).toEqual([undefined, undefined]);
  });

  it("takes the parent the index records: a spawned task and a fork are children, a /btw question is a side chat", () => {
    const index = sidebar({
      [SID(1)]: { archived: false },
      [SID(2)]: { archived: false, parent: SID(1) },
      [SID(3)]: { archived: false, parent: SID(1), side: true },
      [SID(4)]: { archived: false, parent: SID(99) },
    });
    const rows = mergeClaude("/cfg", [], [entryOf(SID(1)), entryOf(SID(2)), entryOf(SID(3)), entryOf(SID(4)), entryOf(SID(5), { forkedFrom: SID(1) })], { desktop: index, now: NOW });
    const by = Object.fromEntries(rows.map((r) => [r.nativeId, { forkOf: r.forkOf, sideOf: r.sideOf }]));
    expect(by).toEqual({
      [SID(1)]: { forkOf: undefined, sideOf: undefined },
      [SID(2)]: { forkOf: SID(1), sideOf: undefined },
      [SID(3)]: { forkOf: undefined, sideOf: SID(1) },
      // a parent that is not a row links nothing
      [SID(4)]: { forkOf: undefined, sideOf: undefined },
      // a transcript's own forkedFrom still counts where the index says nothing
      [SID(5)]: { forkOf: SID(1), sideOf: undefined },
    });
  });

  it("never lets recorded parents close a loop", () => {
    const rows = mergeClaude("/cfg", [], [entryOf(SID(1), { forkedFrom: SID(2) }), entryOf(SID(2), { forkedFrom: SID(1) })]);
    expect(rows.map((r) => r.forkOf).filter(Boolean).length).toBeLessThan(2);
  });
});

describe("the desktop app's sidebar", () => {
  const running: LiveClaudeSession = { sessionId: SID(2), pid: 2, cwd: "/x", state: "idle", updatedAt: 1, unverified: false };

  it("hides archived sessions and their earlier transcripts, unless they are running", () => {
    const index = sidebar({ [SID(1)]: { archived: true }, [SID(2)]: { archived: true }, [SID(3)]: { archived: false } }, { priorOf: new Map([[SID(4), SID(1)]]) });
    const rows = mergeClaude("/cfg", [running], [entryOf(SID(1)), entryOf(SID(2)), entryOf(SID(3)), entryOf(SID(4))], { desktop: index, now: NOW });
    expect(rows.map((r) => r.nativeId).sort()).toEqual([SID(2), SID(3)]);
  });

  it("shows one row per session: an earlier transcript leaves once the current one is listed", () => {
    const index = sidebar({ [SID(3)]: { archived: false } }, { priorOf: new Map([[SID(1), SID(3)], [SID(2), SID(3)]]) });
    const rows = mergeClaude("/cfg", [], [entryOf(SID(1), { mtimeMs: 100 }), entryOf(SID(2), { mtimeMs: 200 }), entryOf(SID(3), { mtimeMs: 300 })], { desktop: index, now: NOW });
    expect(rows.map((r) => r.nativeId)).toEqual([SID(3)]);
  });

  it("keeps an earlier transcript when the current one is missing or older: at worst twice, never not at all", () => {
    const index = sidebar({ [SID(3)]: { archived: false }, [SID(6)]: { archived: false } }, { priorOf: new Map([[SID(1), SID(3)], [SID(5), SID(6)]]) });
    const rows = mergeClaude("/cfg", [], [entryOf(SID(1)), entryOf(SID(5), { mtimeMs: 900 }), entryOf(SID(6), { mtimeMs: 100 })], { desktop: index, now: NOW });
    expect(rows.map((r) => r.nativeId).sort()).toEqual([SID(1), SID(5), SID(6)]);
  });

  it("hides a session deleted in the app: a desktop transcript no entry names, after the grace period", () => {
    const desktopEntry = (id: string, mtimeMs: number) => entryOf(id, { entrypoint: "claude-desktop-3p", mtimeMs });
    const index = sidebar({ [SID(1)]: { archived: false } }, { mentioned: new Set([SID(4)]), deleted: new Set([SID(5)]) });
    const rows = mergeClaude(
      "/cfg",
      [],
      [
        desktopEntry(SID(1), 1000),
        desktopEntry(SID(2), 1000), // gone: old and unnamed
        desktopEntry(SID(3), NOW - 30_000), // too new: the app may not have written its entry yet
        desktopEntry(SID(4), 1000), // an unreadable entry mentions it
        desktopEntry(SID(5), NOW - 30_000), // a deleted_ marker names it: gone at once
        entryOf(SID(6), { entrypoint: "cli" }), // another client's transcript is never judged by the index
      ],
      { desktop: index, now: NOW },
    );
    expect(rows.map((r) => r.nativeId).sort()).toEqual([SID(1), SID(3), SID(4), SID(6)]);
  });

  it("hides nothing as deleted when the index has no readable entry", () => {
    const rows = mergeClaude("/cfg", [], [entryOf(SID(2), { entrypoint: "claude-desktop-3p" })], { desktop: sidebar({}), now: NOW });
    expect(rows).toHaveLength(1);
  });

  it("titles a session the sidebar's way before its first message, and takes the sidebar's folder when the transcript has none", () => {
    const index = sidebar({ [SID(1)]: { archived: false, title: "nex_agent开发", cwd: "/work/app" } });
    const [row] = mergeClaude("/cfg", [], [entryOf(SID(1), { firstUser: "/D:/ProgrammingProjects/plan.md" })], { desktop: index, now: NOW });
    expect(row).toMatchObject({ title: "nex_agent开发", cwd: "/work/app" });
    const [named] = mergeClaude("/cfg", [], [entryOf(SID(1), { customTitle: "renamed in the CLI" })], { desktop: index, now: NOW });
    expect(named.title).toBe("renamed in the CLI");
  });
});

describe("scan and merge end to end", () => {
  it("combines live files and transcripts from a temp config dir", async () => {
    writeTranscript("proj", SID(1), [user("running one"), { type: "custom-title", customTitle: "Named" }]);
    writeTranscript("proj", SID(2), [user("finished one")]);
    writeLive(901, { sessionId: SID(1), cwd: "/work/demo", entrypoint: "cli", status: "busy", procStart: LSTART, updatedAt: Date.now() });
    const liveRows = await scanLive(dir, { isAlive: () => true, start: unixStart({ 901: LSTART }) });
    const history = await scanHistory(dir, { include: liveRows.map((l) => l.sessionId) });
    const rows = mergeClaude(dir, liveRows, history);
    const by = Object.fromEntries(rows.map((r) => [r.nativeId, r]));
    expect(by[SID(1)]).toMatchObject({ state: "running", liveIn: "terminal", title: "Named" });
    expect(by[SID(2)]).toMatchObject({ state: "stopped", title: "finished one" });
  });
});

describe("Claude desktop session store", () => {
  it("reads the sidebar index: current and earlier transcripts, archive, lineage, titles and deletion markers", async () => {
    const store = path.join(dir, "Claude-3p", "claude-code-sessions", "acct", "org");
    mkdirSync(store, { recursive: true });
    const put = (name: string, body: unknown) => writeFileSync(path.join(store, name), typeof body === "string" ? body : JSON.stringify(body));
    put("local_a.json", { sessionId: "local_a", cliSessionId: SID(1), isArchived: true, priorCliSessionIds: [SID(10)] });
    put("local_b.json", { sessionId: "local_b", cliSessionId: SID(2), title: "主会话", cwd: "/work/app", originCwd: "/work/app", lastActivityAt: 5, priorCliSessionIds: [SID(11), 42, "bad id"] });
    put("local_c.json", { sessionId: "local_c", cliSessionId: SID(3), spawnedFrom: { sessionId: "local_b", btw: true, sideSession: true } });
    put("local_d.json", { sessionId: "local_d", cliSessionId: SID(4), spawnedFrom: { sessionId: "local_b", userFork: true, sideSession: true } });
    put("local_e.json", { sessionId: "local_e", cliSessionId: SID(5), forkedFromSessionId: "local_b" });
    put("local_f.json", { sessionId: "local_f", cliSessionId: SID(6), spawnedFrom: { sessionId: "local_b", btw: true }, lineageDetached: true });
    put("local_g.json", `{ "cliSessionId": "${SID(7)}", cut short while the app wrote it`);
    put(`deleted_${SID(8)}`, "1795000000000");
    put("archived-sessions.idx", { v: 1, archived: [] });
    const { ClaudeDesktopSessions, desktopAlwaysListed } = await import("./claude-desktop.ts");
    const index = await new ClaudeDesktopSessions([path.join(dir, "Claude-3p"), path.join(dir, "missing")]).scan();
    expect(index.readable).toBe(6);
    expect(Object.fromEntries(index.sessions)).toEqual({
      [SID(1)]: { archived: true },
      [SID(2)]: { archived: false, title: "主会话", cwd: "/work/app", originCwd: "/work/app", lastActivityAt: 5 },
      [SID(3)]: { archived: false, parent: SID(2), side: true },
      [SID(4)]: { archived: false, parent: SID(2) },
      [SID(5)]: { archived: false, parent: SID(2) },
      // moved to the sidebar's top level: no parent, whatever the file still names
      [SID(6)]: { archived: false },
    });
    expect(Object.fromEntries(index.priorOf)).toEqual({ [SID(10)]: SID(1), [SID(11)]: SID(2) });
    expect(index.mentioned.has(SID(7))).toBe(true);
    expect(index.deleted.has(SID(8))).toBe(true);
    expect(desktopAlwaysListed(index)[0]).toBe(SID(2));
    expect(desktopAlwaysListed(index)).not.toContain(SID(1));
  });
});
