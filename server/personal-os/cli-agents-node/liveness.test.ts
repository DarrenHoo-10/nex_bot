import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  codexWriter,
  isPidAlive,
  processStartTimes,
  resetProcessStartCache,
  sameProcessStart,
  type CommandRunner,
} from "./liveness.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "cli-liveness-"));
  resetProcessStartCache();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("isPidAlive", () => {
  it("is true for this process and false for invalid or gone pids", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-5)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
    expect(isPidAlive(2_000_000_000)).toBe(false);
  });
});

describe("processStartTimes", () => {
  it("runs one PowerShell query on Windows and returns FILETIME strings", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (file, args) => {
      calls.push([file, ...args]);
      return { code: 0, stdout: "100 133800000000000000\r\n200 133800000010000000\r\n" };
    };
    const map = await processStartTimes([100, 200, 300], { platform: "win32", run });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("powershell.exe");
    expect(calls[0].join(" ")).toContain("Win32_Process");
    expect(calls[0].join(" ")).toContain("100,200,300");
    expect(map.get(100)).toBe("133800000000000000");
    expect(map.get(200)).toBe("133800000010000000");
    expect(map.get(300)).toBeNull();
  });

  it("uses ps lstart in a C locale on unix and normalises whitespace", async () => {
    let seen: { file: string; args: string[]; env?: NodeJS.ProcessEnv } | null = null;
    const run: CommandRunner = async (file, args, options) => {
      seen = { file, args, env: options.env };
      return { code: 0, stdout: "  41 Sat Nov  15 12:00:00 2026\n" };
    };
    const map = await processStartTimes([41], { platform: "linux", run });
    expect(seen!.file).toBe("ps");
    expect(seen!.args).toEqual(["-o", "pid=,lstart=", "-p", "41"]);
    expect(seen!.env?.LC_ALL).toBe("C");
    expect(seen!.env?.TZ).toBe("UTC");
    expect(map.get(41)).toBe("Sat Nov 15 12:00:00 2026");
  });

  it("caches per pid and only asks for the missing ones", async () => {
    const asked: string[] = [];
    const run: CommandRunner = async (_file, args) => {
      asked.push(args[args.length - 1]);
      return { code: 0, stdout: args[args.length - 1].split(",").map((pid) => `${pid} Mon Jan 1 00:00:00 2026`).join("\n") };
    };
    await processStartTimes([1000], { platform: "linux", run });
    await processStartTimes([1000, 1001], { platform: "linux", run });
    await processStartTimes([1000, 1001], { platform: "linux", run });
    expect(asked).toEqual(["1000", "1001"]);
  });

  it("maps every pid to null when the command fails or throws", async () => {
    const failing: CommandRunner = async () => ({ code: 5, stdout: "" });
    expect((await processStartTimes([7], { platform: "win32", run: failing })).get(7)).toBeNull();
    resetProcessStartCache();
    const throwing: CommandRunner = async () => {
      throw new Error("spawn failed");
    };
    expect((await processStartTimes([8], { platform: "darwin", run: throwing })).get(8)).toBeNull();
  });

  it("retries a failed lookup after the short negative TTL", async () => {
    let t = 1_000_000;
    let ok = false;
    const run: CommandRunner = async () => (ok ? { code: 0, stdout: "9 Mon Jan 1 00:00:00 2026" } : { code: 3, stdout: "" });
    expect((await processStartTimes([9], { platform: "linux", run, now: () => t })).get(9)).toBeNull();
    ok = true;
    t += 6000;
    expect((await processStartTimes([9], { platform: "linux", run, now: () => t })).get(9)).toBe("Mon Jan 1 00:00:00 2026");
  });
});

describe("sameProcessStart", () => {
  it("matches equal text and tolerates 2 s of FILETIME slack", () => {
    expect(sameProcessStart("Sat Nov 15 12:00:00 2026", "Sat Nov 15 12:00:00 2026")).toBe("match");
    expect(sameProcessStart("133800000000000000", "133800000010000000")).toBe("match");
    expect(sameProcessStart("133800000000000000", "133800000500000000")).toBe("mismatch");
  });
  it("reports a different start as a mismatch (pid reuse)", () => {
    expect(sameProcessStart("Sat Nov 15 12:00:00 2026", "Sun Nov 16 01:00:00 2026")).toBe("mismatch");
  });
  it("is unverified when either side is missing or the formats are different flavours", () => {
    expect(sameProcessStart(undefined, "x")).toBe("unverified");
    expect(sameProcessStart("", "x")).toBe("unverified");
    expect(sameProcessStart("x", null)).toBe("unverified");
    expect(sameProcessStart("133800000000000000", "639000000000000000")).toBe("unverified");
  });
});

describe("codexWriter", () => {
  it("is yes when the lock file names a live pid and no when the pid is gone", () => {
    mkdirSync(path.join(dir, "thread-writer-locks"));
    writeFileSync(path.join(dir, "thread-writer-locks", "t1.lock"), JSON.stringify({ pid: process.pid }));
    writeFileSync(path.join(dir, "thread-writer-locks", "t2.lock"), JSON.stringify({ pid: 2_000_000_000 }));
    expect(codexWriter(dir, "t1")).toBe("yes");
    expect(codexWriter(dir, "t2")).toBe("no");
  });

  it("treats a lock without a pid as yes only while it is fresh", () => {
    mkdirSync(path.join(dir, "thread-writer-locks"));
    const file = path.join(dir, "thread-writer-locks", "t3.lock");
    writeFileSync(file, "locked");
    expect(codexWriter(dir, "t3")).toBe("yes");
    expect(codexWriter(dir, "t3", { now: Date.now() + 3_600_000 })).toBe("unknown");
  });

  it("is yes for a recently written rollout and unknown without a lock directory", () => {
    const day = new Date();
    const folder = path.join(
      dir,
      "sessions",
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0"),
    );
    mkdirSync(folder, { recursive: true });
    const rollout = path.join(folder, "rollout-2026-11-15T10-00-00-abc.jsonl");
    writeFileSync(rollout, "{}\n");
    expect(codexWriter(dir, "abc")).toBe("yes");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(rollout, old, old);
    expect(codexWriter(dir, "abc")).toBe("unknown");
    mkdirSync(path.join(dir, "thread-writer-locks"));
    expect(codexWriter(dir, "abc")).toBe("no");
  });

  it("rejects a thread id that is not a plain token", () => {
    expect(codexWriter(dir, "../x")).toBe("unknown");
  });
});
