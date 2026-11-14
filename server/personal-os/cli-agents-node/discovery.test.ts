import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_SESSIONS, parseCliSessionWire, type CliSessionRef } from "../../../shared/cli-agents.ts";
import { resetClaudeHistoryCache } from "./claude.ts";
import { SessionDiscovery, type SessionDiscoveryOptions, type SessionsDiff } from "./discovery.ts";
import { resetProcessStartCache, type CommandRunner } from "./liveness.ts";

let claudeDir: string;
let codexHome: string;
const started: SessionDiscovery[] = [];

beforeEach(() => {
  claudeDir = mkdtempSync(path.join(os.tmpdir(), "cli-disc-claude-"));
  codexHome = mkdtempSync(path.join(os.tmpdir(), "cli-disc-codex-"));
  resetProcessStartCache();
  resetClaudeHistoryCache();
});
afterEach(() => {
  for (const d of started.splice(0)) d.stop();
  rmSync(claudeDir, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
});

const CID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const XID = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const LSTART = "Sun Nov 15 09:00:00 2026";

const run: CommandRunner = async (_file, args) => {
  const pids = args[args.length - 1].split(",");
  return { code: 0, stdout: pids.map((p) => `${p} ${LSTART}`).join("\n") };
};

function claudeTranscript(id: string, text: string, ageMs = 1000, dir = claudeDir): string {
  const folder = path.join(dir, "projects", "proj");
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${id}.jsonl`);
  writeFileSync(
    file,
    JSON.stringify({ type: "user", timestamp: new Date(Date.now() - ageMs).toISOString(), cwd: "/work/demo", message: { role: "user", content: text } }) + "\n",
  );
  const mtime = new Date(Date.now() - ageMs);
  utimesSync(file, mtime, mtime);
  return file;
}

function claudeLive(pid: number, id: string, status: string, dir = claudeDir): void {
  mkdirSync(path.join(dir, "sessions"), { recursive: true });
  writeFileSync(
    path.join(dir, "sessions", `${pid}.json`),
    JSON.stringify({ pid, sessionId: id, cwd: "/work/demo", entrypoint: "cli", status, procStart: LSTART, updatedAt: Date.now() }),
  );
}

function codexRollout(id: string, text: string, ageMs = 3_600_000): string {
  const day = new Date(Date.now() - ageMs);
  const folder = path.join(
    codexHome,
    "sessions",
    String(day.getUTCFullYear()),
    String(day.getUTCMonth() + 1).padStart(2, "0"),
    String(day.getUTCDate()).padStart(2, "0"),
  );
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `rollout-2026-11-15T10-00-00-${id}.jsonl`);
  writeFileSync(
    file,
    [
      JSON.stringify({ timestamp: new Date(Date.now() - ageMs).toISOString(), type: "session_meta", payload: { id, cwd: "/work/codex", originator: "codex_cli_rs", source: "cli", cli_version: "0.99.0" } }),
      JSON.stringify({ timestamp: new Date(Date.now() - ageMs).toISOString(), type: "event_msg", payload: { type: "user_message", message: text } }),
    ].join("\n") + "\n",
  );
  const mtime = new Date(Date.now() - ageMs);
  utimesSync(file, mtime, mtime);
  return file;
}

function make(extra: Partial<SessionDiscoveryOptions> = {}) {
  const diffs: SessionsDiff[] = [];
  const errors: unknown[] = [];
  const discovery = new SessionDiscovery({
    claudeDirs: [claudeDir],
    codexHomes: [codexHome],
    claudeLive: { isAlive: () => true, start: { platform: "linux", run } },
    codex: { writer: () => "no" },
    coalesceMs: 0,
    onChange: (diff) => diffs.push(diff),
    onError: (error) => errors.push(error),
    ...extra,
  });
  started.push(discovery);
  return { discovery, diffs, errors };
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("SessionDiscovery snapshot", () => {
  it("combines Claude and Codex rows, newest first, without the transcript path", async () => {
    claudeTranscript(CID(1), "claude old", 5000);
    codexRollout(XID(1), "codex newer", 2000);
    claudeTranscript(CID(2), "claude newest", 500);
    const { discovery, diffs } = make();
    await discovery.start();
    const rows = discovery.snapshot();
    expect(rows.map((r) => `${r.engine}:${r.nativeId}`)).toEqual([`claude:${CID(2)}`, `codex:${XID(1)}`, `claude:${CID(1)}`]);
    for (const row of rows) {
      expect("transcript" in row).toBe(false);
      expect(parseCliSessionWire(row)).not.toBeNull();
    }
    expect(diffs).toHaveLength(1);
    expect(diffs[0].full).toBe(true);
    expect(diffs[0].upserts).toEqual(rows);
    expect(diffs[0].removes).toEqual([]);
  });

  it("resolves transcriptFor by ref", async () => {
    const claudeFile = claudeTranscript(CID(1), "hi");
    const codexFile = codexRollout(XID(1), "hello");
    const { discovery } = make();
    await discovery.start();
    expect(discovery.transcriptFor(`claude:${CID(1)}`)).toBe(claudeFile);
    expect(discovery.transcriptFor(`codex:${XID(1)}`)).toBe(codexFile);
    expect(discovery.transcriptFor("claude:nope")).toBeNull();
    expect(discovery.transcriptFor("garbage")).toBeNull();
  });

  it("returns null for a live session that has no transcript yet", async () => {
    claudeLive(11, CID(1), "busy");
    const { discovery } = make();
    await discovery.start();
    expect(discovery.snapshot()).toHaveLength(1);
    expect(discovery.snapshot()[0]).toMatchObject({ state: "running", liveIn: "terminal" });
    expect(discovery.transcriptFor(`claude:${CID(1)}`)).toBeNull();
  });

  it("keeps one row for the same session in two config dirs, preferring the newer", async () => {
    const other = mkdtempSync(path.join(os.tmpdir(), "cli-disc-claude2-"));
    try {
      claudeTranscript(CID(1), "older copy", 60_000);
      claudeTranscript(CID(1), "newer copy", 1000, other);
      const { discovery } = make({ claudeDirs: [claudeDir, other] });
      await discovery.start();
      const rows = discovery.snapshot();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ title: "newer copy", configDir: other });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("never drops a live session because of the cap", async () => {
    for (let i = 1; i <= MAX_SESSIONS + 5; i += 1) claudeTranscript(CID(i), `s${i}`, 1000 + i * 10);
    // the oldest transcript belongs to a live process
    const oldest = CID(MAX_SESSIONS + 5);
    claudeLive(21, oldest, "busy");
    const { discovery } = make();
    await discovery.start();
    const rows = discovery.snapshot();
    expect(rows).toHaveLength(MAX_SESSIONS);
    expect(rows.some((r) => r.nativeId === oldest && r.state === "running")).toBe(true);
  }, 30_000);
});

describe("SessionDiscovery diffs", () => {
  it("reports adds, field changes and removals, and nothing when nothing changed", async () => {
    const c1 = claudeTranscript(CID(1), "one");
    claudeTranscript(CID(2), "two");
    const { discovery, diffs } = make();
    await discovery.start();
    diffs.length = 0;

    await discovery.refresh({ flush: true });
    expect(diffs).toHaveLength(0);

    claudeTranscript(CID(3), "three");
    claudeLive(31, CID(1), "busy");
    await discovery.refresh({ flush: true });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].full).toBe(false);
    expect(diffs[0].upserts.map((r) => r.nativeId).sort()).toEqual([CID(1), CID(3)].sort());
    expect(diffs[0].upserts.find((r) => r.nativeId === CID(1))).toMatchObject({ state: "running", liveIn: "terminal" });
    expect(diffs[0].removes).toEqual([]);

    rmSync(c1);
    rmSync(path.join(claudeDir, "sessions", "31.json"));
    await discovery.refresh({ flush: true });
    expect(diffs).toHaveLength(2);
    expect(diffs[1].upserts).toEqual([]);
    expect(diffs[1].removes).toEqual([`claude:${CID(1)}`]);
  });

  it("reports a Codex session turning from running to idle", async () => {
    const file = codexRollout(XID(1), "work", 10_000);
    appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "task_started" } }) + "\n");
    const { discovery, diffs } = make({ codex: { writer: () => "yes" } });
    await discovery.start();
    expect(discovery.snapshot()[0].state).toBe("running");
    diffs.length = 0;
    appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "task_complete" } }) + "\n");
    await discovery.refresh({ flush: true });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].upserts[0]).toMatchObject({ nativeId: XID(1), state: "idle" });
  });

  it("resync sends a full report again", async () => {
    claudeTranscript(CID(1), "one");
    const { discovery, diffs } = make();
    await discovery.start();
    diffs.length = 0;
    discovery.resync();
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ full: true, removes: [] });
    expect(diffs[0].upserts).toHaveLength(1);
  });

  it("folds changes made inside the coalescing window into one later report", async () => {
    claudeTranscript(CID(1), "one");
    const { discovery, diffs } = make({ coalesceMs: 150 });
    await discovery.start();
    expect(diffs).toHaveLength(1);
    claudeTranscript(CID(2), "two");
    await discovery.refresh();
    claudeTranscript(CID(3), "three");
    await discovery.refresh();
    expect(diffs).toHaveLength(1);
    await waitFor(() => diffs.length === 2);
    expect(diffs[1].upserts.map((r) => r.nativeId).sort()).toEqual([CID(2), CID(3)].sort());
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(diffs).toHaveLength(2);
  });

  it("does not report a change that was undone inside the window", async () => {
    claudeTranscript(CID(1), "one");
    const { discovery, diffs } = make({ coalesceMs: 100 });
    await discovery.start();
    claudeLive(41, CID(1), "busy");
    await discovery.refresh();
    rmSync(path.join(claudeDir, "sessions", "41.json"));
    await discovery.refresh();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(diffs).toHaveLength(1);
  });
});

describe("SessionDiscovery nexbot terminals", () => {
  it("marks sessions in a nex_bot terminal and keeps them from being stopped", async () => {
    claudeTranscript(CID(1), "claude in terminal");
    codexRollout(XID(1), "codex in terminal");
    claudeTranscript(CID(2), "plain");
    const terminals = new Map<CliSessionRef, string>([
      [`claude:${CID(1)}`, "term-a"],
      [`codex:${XID(1)}`, "term-b"],
    ]);
    const { discovery } = make({ nexbotTerminals: () => terminals });
    await discovery.start();
    const by = Object.fromEntries(discovery.snapshot().map((r) => [r.nativeId, r]));
    expect(by[CID(1)]).toMatchObject({ liveIn: "nexbot", terminal: "term-a", state: "idle" });
    expect(by[XID(1)]).toMatchObject({ liveIn: "nexbot", terminal: "term-b", state: "idle" });
    expect(by[XID(1)].writerUnknown).toBeUndefined();
    expect(by[CID(2)]).toMatchObject({ state: "stopped" });
    expect(by[CID(2)].terminal).toBeUndefined();

    terminals.delete(`claude:${CID(1)}`);
    await discovery.refresh({ flush: true });
    expect(discovery.snapshot().find((r) => r.nativeId === CID(1))).toMatchObject({ state: "stopped" });
  });

  it("keeps a live Claude session as running while it is in a nex_bot terminal", async () => {
    claudeTranscript(CID(1), "x");
    claudeLive(51, CID(1), "waiting");
    const { discovery } = make({ nexbotTerminals: () => new Map([[`claude:${CID(1)}`, "term-z"]]) });
    await discovery.start();
    expect(discovery.snapshot()[0]).toMatchObject({ state: "waiting", liveIn: "nexbot", terminal: "term-z" });
  });

  it("survives a throwing terminal table", async () => {
    claudeTranscript(CID(1), "x");
    const { discovery, errors } = make({
      nexbotTerminals: () => {
        throw new Error("table unavailable");
      },
    });
    await discovery.start();
    expect(discovery.snapshot()).toHaveLength(1);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("SessionDiscovery timers", () => {
  it("picks up a new live session and its transcript on the timers, then stops cleanly", async () => {
    const { discovery, diffs } = make({ liveMs: 20, historyMs: 40 });
    await discovery.start();
    expect(discovery.snapshot()).toEqual([]);

    claudeLive(61, CID(1), "busy");
    await waitFor(() => diffs.some((d) => d.upserts.some((r) => r.nativeId === CID(1))));
    expect(discovery.transcriptFor(`claude:${CID(1)}`)).toBeNull();

    const file = claudeTranscript(CID(1), "now with words");
    await waitFor(() => discovery.transcriptFor(`claude:${CID(1)}`) === file);
    expect(discovery.snapshot()[0]).toMatchObject({ title: "now with words", state: "running" });

    discovery.stop();
    const count = diffs.length;
    claudeTranscript(CID(2), "after stop");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(diffs).toHaveLength(count);
  });

  it("reports a scan failure through onError and keeps the last good result", async () => {
    claudeTranscript(CID(1), "one");
    const { discovery, errors } = make({ claudeLive: { isAlive: () => { throw new Error("boom"); }, start: { platform: "linux", run } } });
    claudeLive(71, CID(1), "busy");
    await discovery.start();
    expect(errors.length).toBeGreaterThan(0);
    expect(discovery.snapshot()).toHaveLength(1);
    expect(discovery.snapshot()[0].state).toBe("stopped");
  });
});
