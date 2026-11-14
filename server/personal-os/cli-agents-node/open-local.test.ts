import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OpenLocalError, attachFileName, openLocal, planOpenLocal, type OpenLocalPlan } from "./open-local.ts";

const base = {
  address: "t-12",
  binary: "C:\\Apps\\herdr-core\\herdr-core.exe",
  session: "nexbot-1a2b3c4d",
  socket: "\\\\.\\pipe\\nexbot-hc-1a2b3c4d",
  dir: "C:\\Users\\me\\AppData\\Roaming\\nexbot",
  platform: "win32" as const,
};

describe("planOpenLocal", () => {
  it("writes a command file that attaches to the same session and starts it in Windows Terminal", () => {
    const plan = planOpenLocal({ ...base, hasWindowsTerminal: true });
    expect(plan.file).toBe("C:\\Users\\me\\AppData\\Roaming\\nexbot\\attach-t-12.cmd");
    expect(plan.content.split("\r\n")).toEqual([
      "@echo off",
      "chcp 65001 >nul",
      'set "HC_SESSION=nexbot-1a2b3c4d"',
      'set "HC_SOCKET=\\\\.\\pipe\\nexbot-hc-1a2b3c4d"',
      '"C:\\Apps\\herdr-core\\herdr-core.exe" attach t-12',
      "",
    ]);
    expect(plan.command).toBe("wt.exe");
    expect(plan.args).toEqual(["-w", "new", "cmd.exe", "/d", "/k", plan.file]);
  });

  it("falls back to a plain console window", () => {
    const plan = planOpenLocal({ ...base, hasWindowsTerminal: false });
    expect(plan.command).toBe("cmd.exe");
    expect(plan.args).toEqual(["/d", "/c", "start", "", "cmd.exe", "/d", "/k", plan.file]);
  });

  it("avoids wt.exe for a path with a semicolon", () => {
    const plan = planOpenLocal({ ...base, dir: "C:\\a;b", hasWindowsTerminal: true });
    expect(plan.command).toBe("cmd.exe");
  });

  it("refuses addresses and paths that could inject commands", () => {
    for (const address of ["t-1 & calc", "../x", "", 'a"b', "t 1"]) {
      expect(() => planOpenLocal({ ...base, address })).toThrow(OpenLocalError);
    }
    for (const binary of ["C:\\a&b\\hc.exe", "C:\\%PATH%\\hc.exe", 'C:\\a"b\\hc.exe']) {
      expect(() => planOpenLocal({ ...base, binary })).toThrow(/cannot be used/);
    }
    expect(() => planOpenLocal({ ...base, session: "x\r\ncalc" })).toThrow(OpenLocalError);
  });

  it("is Windows only", () => {
    expect(() => planOpenLocal({ ...base, platform: "linux" })).toThrowError(expect.objectContaining({ code: "invalid" }));
  });

  it("sanitises the file name", () => {
    expect(attachFileName("a:b")).toBe("attach-a_b.cmd");
  });
});

describe("openLocal", () => {
  it("writes the file and hands the plan to the launcher", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "open-local-"));
    try {
      const launched: OpenLocalPlan[] = [];
      const plan = await openLocal({ ...base, dir: dir.replace(/\//g, "\\"), hasWindowsTerminal: false }, async (p) => void launched.push(p));
      expect(launched).toEqual([plan]);
      expect(readFileSync(plan.file, "utf8")).toBe(plan.content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
