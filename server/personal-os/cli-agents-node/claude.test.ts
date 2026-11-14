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
