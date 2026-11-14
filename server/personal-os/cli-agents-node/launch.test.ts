import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LaunchError,
  PENDING_NATIVE_ID,
  SAFE_ARG,
  buildArgv,
  cliArgs,
  cliVersion,
  clearCliCache,
  launchEnv,
  planLaunch,
  resolveCli,
  terminalLabels,
  terminalName,
  validateCwd,
} from "./launch.ts";

const UUID = "3f2b8c1e-7a4d-4e0b-9c55-0d1e2f3a4b5c";
const onWindows = process.platform === "win32";

let root: string;
beforeEach(() => {
  clearCliCache();
  root = mkdtempSync(path.join(os.tmpdir(), "nexbot-launch-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function touch(file: string, content = "", executable = true): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (executable) chmodSync(file, 0o755);
  return file;
}

describe("cliArgs", () => {
  it("builds the Claude and Codex invocations", () => {
    expect(cliArgs("claude", "new", { nativeId: UUID })).toEqual(["--session-id", UUID]);
    expect(cliArgs("claude", "resume", { nativeId: UUID })).toEqual(["--resume", UUID]);
    expect(cliArgs("codex", "new")).toEqual([]);
    expect(cliArgs("codex", "resume", { nativeId: UUID })).toEqual(["resume", UUID]);
  });

  it("requires an id where the CLI needs one", () => {
    expect(() => cliArgs("claude", "new")).toThrow(LaunchError);
    expect(() => cliArgs("claude", "resume", {})).toThrow(/session id/);
    expect(() => cliArgs("codex", "resume")).toThrow(/session id/);
  });

  it("refuses ids that are not plain tokens or look like flags", () => {
    for (const bad of ["a b", "x;rm", "x&y", 'x"y', "x`y", "$(id)", "x|y", "a\nb", "", "--dangerously-skip-permissions", "-x"]) {
      expect(() => cliArgs("claude", "resume", { nativeId: bad }), bad).toThrow(LaunchError);
      expect(() => cliArgs("codex", "resume", { nativeId: bad }), bad).toThrow(LaunchError);
    }
  });

  it("rejects an unknown engine", () => {
    expect(() => cliArgs("vim" as never, "new")).toThrow(/unknown engine/);
  });

  it("only allows the documented argument alphabet", () => {
    expect(SAFE_ARG.test("a-b_c.d:e/f=g")).toBe(true);
    expect(SAFE_ARG.test("a,b")).toBe(false);
    expect(SAFE_ARG.test("with space")).toBe(false);
  });
});

describe("buildArgv", () => {
  it("runs a plain executable directly", () => {
    expect(buildArgv("claude", "new", { nativeId: UUID }, "C:\\bin\\claude.exe", { platform: "win32" })).toEqual([
      "C:\\bin\\claude.exe",
      "--session-id",
      UUID,
    ]);
    expect(buildArgv("codex", "resume", { nativeId: UUID }, "/usr/local/bin/codex", { platform: "darwin" })).toEqual([
      "/usr/local/bin/codex",
      "resume",
      UUID,
    ]);
  });

  it("passes .cmd and .bat shims to herdr-core directly (verified in the spike)", () => {
    for (const shim of ["C:\\npm\\claude.cmd", "C:\\Program Files\\npm\\CLAUDE.BAT"]) {
      expect(buildArgv("claude", "resume", { nativeId: UUID }, shim, { platform: "win32", env: {} })).toEqual([shim, "--resume", UUID]);
    }
  });

  it("can wrap a shim in cmd.exe /d /s /c when asked", () => {
    const env = { ComSpec: "C:\\Windows\\System32\\cmd.exe" };
    for (const shim of ["C:\\npm\\claude.cmd", "C:\\npm\\CLAUDE.BAT"]) {
      expect(buildArgv("claude", "resume", { nativeId: UUID }, shim, { platform: "win32", env, wrapCmd: true })).toEqual([
        "C:\\Windows\\System32\\cmd.exe",
        "/d",
        "/s",
        "/c",
        shim,
        "--resume",
        UUID,
      ]);
    }
    expect(buildArgv("codex", "new", {}, "C:\\npm\\codex.cmd", { platform: "win32", env: {}, wrapCmd: true })[0]).toBe("cmd.exe");
  });

  it("never wraps a .cmd name outside Windows", () => {
    expect(buildArgv("codex", "new", {}, "/tmp/codex.cmd", { platform: "linux" })).toEqual(["/tmp/codex.cmd"]);
  });

  it("refuses a shim path that cmd.exe would interpret", () => {
    for (const shim of ["C:\\a&b\\claude.cmd", "C:\\100%\\claude.cmd", 'C:\\a"b\\claude.cmd', "C:\\a^b\\claude.cmd"]) {
      expect(() => buildArgv("claude", "new", { nativeId: UUID }, shim, { platform: "win32", env: {} })).toThrow(/cmd\.exe/);
    }
  });

  it("allows spaces in the executable path (it is its own argv element)", () => {
    const argv = buildArgv("claude", "new", { nativeId: UUID }, "C:\\Program Files\\x\\claude.exe", { platform: "win32" });
    expect(argv[0]).toBe("C:\\Program Files\\x\\claude.exe");
  });

  it("reports a missing executable", () => {
    expect(() => buildArgv("claude", "new", { nativeId: UUID }, "")).toThrow(/not found/);
  });
});

describe("validateCwd", () => {
  it("accepts an existing absolute directory", async () => {
    await expect(validateCwd(root)).resolves.toBe(path.resolve(root));
  });

  it("rejects relative, missing and non-directory paths", async () => {
    await expect(validateCwd("relative/dir")).rejects.toMatchObject({ kind: "invalid_cwd" });
    await expect(validateCwd("")).rejects.toMatchObject({ kind: "invalid_cwd" });
    await expect(validateCwd(path.join(root, "missing"))).rejects.toMatchObject({ kind: "invalid_cwd" });
    const file = touch(path.join(root, "file.txt"), "x", false);
    await expect(validateCwd(file)).rejects.toThrow(/not a directory/);
  });

  it("applies the Windows or POSIX notion of absolute for the given platform", async () => {
    await expect(validateCwd("C:\\work", { platform: "linux" })).rejects.toMatchObject({ kind: "invalid_cwd" });
    await expect(validateCwd("\\\\.\\pipe\\x", { platform: "linux" })).rejects.toMatchObject({ kind: "invalid_cwd" });
  });
});

describe("resolveCli", () => {
  it("finds the first PATH hit using PATHEXT order (Windows)", async () => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    touch(path.join(first, "claude.cmd"));
    touch(path.join(second, "claude.exe"));
    const env = { PATH: [first, second].join(";"), PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    // Directory order wins over extension order, like where.exe.
    await expect(resolveCli("claude", { platform: "win32", env })).resolves.toBe(path.join(first, "claude.cmd"));
  });

  it("prefers earlier PATHEXT entries inside one directory", async () => {
    const dir = path.join(root, "bin");
    touch(path.join(dir, "codex.cmd"));
    touch(path.join(dir, "codex.exe"));
    const env = { PATH: dir, PATHEXT: ".EXE;.CMD" };
    await expect(resolveCli("codex", { platform: "win32", env })).resolves.toBe(path.join(dir, "codex.exe"));
  });

  it("matches the Path variable case-insensitively on Windows and ignores non-absolute entries", async () => {
    const dir = path.join(root, "bin");
    touch(path.join(dir, "claude.exe"));
    const env = { Path: `relative;${dir}`, PathExt: ".EXE" };
    await expect(resolveCli("claude", { platform: "win32", env })).resolves.toBe(path.join(dir, "claude.exe"));
  });

  it("returns null when absent, and skips directories named like the CLI", async () => {
    const dir = path.join(root, "bin");
    mkdirSync(path.join(dir, "claude.exe"), { recursive: true });
    const env = { PATH: dir, PATHEXT: ".EXE" };
    await expect(resolveCli("claude", { platform: "win32", env })).resolves.toBeNull();
  });

  it.skipIf(onWindows)("requires the executable bit on POSIX", async () => {
    const dir = path.join(root, "bin");
    touch(path.join(dir, "codex"), "#!/bin/sh\n", false);
    const env = { PATH: dir };
    await expect(resolveCli("codex", { platform: "linux", env })).resolves.toBeNull();
    clearCliCache();
    chmodSync(path.join(dir, "codex"), 0o755);
    await expect(resolveCli("codex", { platform: "linux", env })).resolves.toBe(path.join(dir, "codex"));
  });

  it("caches per PATH until cleared", async () => {
    const dir = path.join(root, "bin");
    mkdirSync(dir);
    const env = { PATH: dir, PATHEXT: ".EXE" };
    await expect(resolveCli("claude", { platform: "win32", env })).resolves.toBeNull();
    touch(path.join(dir, "claude.exe"));
    await expect(resolveCli("claude", { platform: "win32", env })).resolves.toBeNull();
    clearCliCache();
    await expect(resolveCli("claude", { platform: "win32", env })).resolves.toBe(path.join(dir, "claude.exe"));
    // A changed PATH is a different cache key.
    await expect(resolveCli("claude", { platform: "win32", env: { ...env, PATH: root }, cache: true })).resolves.toBeNull();
    await expect(resolveCli("claude", { platform: "win32", env, cache: false })).resolves.toBe(path.join(dir, "claude.exe"));
  });
});

describe("cliVersion", () => {
  it("reads the first line of --version from a real program", async () => {
    const script = touch(path.join(root, "fake-cli.mjs"), 'console.log("\\n 1.2.3 (Fake CLI)\\nsecond line");', false);
    const wrapper = onWindows
      ? touch(path.join(root, "fake-cli.cmd"), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, false)
      : touch(path.join(root, "fake-cli.sh"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await expect(cliVersion(wrapper)).resolves.toBe("1.2.3 (Fake CLI)");
  });

  it.runIf(onWindows)("runs a .cmd with spaces in its path through cmd.exe /d /s /c", async () => {
    const dir = path.join(root, "with space");
    const shim = touch(path.join(dir, "tool.cmd"), "@echo off\r\necho tool 9.9\r\n", false);
    await expect(cliVersion(shim)).resolves.toBe("tool 9.9");
  });

  it("returns null for a failing, missing or slow program", async () => {
    await expect(cliVersion(path.join(root, "nope.exe"))).resolves.toBeNull();
    const slow = touch(path.join(root, "slow.mjs"), "setTimeout(() => {}, 5000);", false);
    const wrapper = onWindows
      ? touch(path.join(root, "slow.cmd"), `@echo off\r\n"${process.execPath}" "${slow}"\r\n`, false)
      : touch(path.join(root, "slow.sh"), `#!/bin/sh\nexec "${process.execPath}" "${slow}"\n`);
    const started = Date.now();
    await expect(cliVersion(wrapper, { timeoutMs: 300 })).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe("labels and names", () => {
  it("marks terminals as ours", () => {
    expect(terminalLabels("claude", UUID)).toEqual({ nexbot: "1", "nexbot.engine": "claude", "nexbot.native": UUID });
    expect(terminalName("codex", UUID)).toBe("nexbot-codex-3f2b8c1e");
    expect(terminalName("claude", "")).toBe("nexbot-claude-session");
  });
});

describe("launchEnv", () => {
  it("adds nothing for the default or unset config home", () => {
    expect(launchEnv("claude", { platform: "linux", env: {}, homedir: "/home/u" })).toEqual({});
    expect(launchEnv("claude", { platform: "linux", env: { CLAUDE_CONFIG_DIR: "/home/u/.claude" }, homedir: "/home/u" })).toEqual({});
    expect(launchEnv("codex", { platform: "linux", env: { CODEX_HOME: "/home/u/.codex/" }, homedir: "/home/u" })).toEqual({});
    expect(launchEnv("codex", { platform: "win32", env: { CODEX_HOME: "c:\\users\\u\\.CODEX" }, homedir: "C:\\Users\\u" })).toEqual({});
  });

  it("passes a relocated config home to the terminal, per engine", () => {
    expect(launchEnv("claude", { platform: "linux", env: { CLAUDE_CONFIG_DIR: "/data/claude" }, homedir: "/home/u" })).toEqual({
      CLAUDE_CONFIG_DIR: "/data/claude",
    });
    expect(launchEnv("codex", { platform: "linux", env: { CODEX_HOME: "/data/codex", CLAUDE_CONFIG_DIR: "/x" }, homedir: "/home/u" })).toEqual({
      CODEX_HOME: "/data/codex",
    });
    expect(launchEnv("claude", { platform: "win32", env: { claude_config_dir: "D:\\cc" }, homedir: "C:\\Users\\u" })).toEqual({
      CLAUDE_CONFIG_DIR: "D:\\cc",
    });
  });
});

describe("planLaunch", () => {
  it("combines validation, resolution, argv, labels and env", async () => {
    const dir = path.join(root, "bin");
    const exe = touch(path.join(dir, onWindows ? "claude.exe" : "claude"));
    const work = path.join(root, "work");
    mkdirSync(work);
    const plan = await planLaunch(
      { engine: "claude", mode: "new", nativeId: UUID, cwd: work },
      { platform: "win32", env: { PATH: dir, PATHEXT: ".EXE", CLAUDE_CONFIG_DIR: "D:\\cc" }, homedir: "C:\\Users\\u" },
    );
    expect(plan.argv).toEqual([exe, "--session-id", UUID]);
    expect(plan.cwd).toBe(path.resolve(work));
    expect(plan.env).toEqual({ CLAUDE_CONFIG_DIR: "D:\\cc" });
    expect(plan.labels).toEqual(terminalLabels("claude", UUID));
    expect(plan.name).toBe("nexbot-claude-3f2b8c1e");
  });

  it("uses a placeholder label and the session key for a new Codex session", async () => {
    const plan = await planLaunch(
      { engine: "codex", mode: "new", key: "abc12345-ffff", cwd: root, executable: "/opt/codex" },
      { env: {} },
    );
    expect(plan.argv).toEqual(["/opt/codex"]);
    expect(plan.labels["nexbot.native"]).toBe(PENDING_NATIVE_ID);
    expect(plan.name).toBe("nexbot-codex-abc12345");
  });

  it("fails clearly when the CLI or directory is missing", async () => {
    await expect(planLaunch({ engine: "codex", mode: "new", cwd: root }, { env: { PATH: path.join(root, "none") } })).rejects.toMatchObject({
      kind: "cli_not_found",
    });
    await expect(
      planLaunch({ engine: "codex", mode: "new", cwd: path.join(root, "missing"), executable: "/opt/codex" }, { env: {} }),
    ).rejects.toMatchObject({ kind: "invalid_cwd" });
  });
});
