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
  permissionFlags,
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

  it("adds each CLI's full-access flag only for permissions full, after the model flags", () => {
    expect(permissionFlags("claude", "full")).toEqual(["--dangerously-skip-permissions"]);
    expect(permissionFlags("codex", "full")).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    expect(permissionFlags("zcode", "full")).toEqual([]);
    expect(permissionFlags("claude", "ask")).toEqual([]);
    expect(permissionFlags("codex", undefined)).toEqual([]);
    expect(cliArgs("claude", "new", { nativeId: UUID, permissions: "full" })).toEqual(["--session-id", UUID, "--dangerously-skip-permissions"]);
    expect(cliArgs("claude", "new", { nativeId: UUID, model: "opus", permissions: "full" })).toEqual(["--session-id", UUID, "--model", "opus", "--dangerously-skip-permissions"]);
    expect(cliArgs("codex", "new", { permissions: "full" })).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    expect(cliArgs("codex", "resume", { nativeId: UUID, permissions: "full" })).toEqual(["resume", UUID, "--dangerously-bypass-approvals-and-sandbox"]);
    expect(cliArgs("codex", "fork", { forkFrom: UUID, permissions: "full" })).toEqual(["fork", UUID, "--dangerously-bypass-approvals-and-sandbox"]);
    expect(cliArgs("codex", "new", { permissions: "ask" })).toEqual([]);
    // ZCode has no such flag and takes the mode without complaint
    expect(cliArgs("zcode", "new", { permissions: "full" })).toEqual([]);
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

  describe("fork", () => {
    const PARENT = "11111111-2222-4333-8444-555555555555";

    it("forks Claude into a session id we choose, and Codex with its own fork command", () => {
      expect(cliArgs("claude", "fork", { nativeId: UUID, forkFrom: PARENT })).toEqual(["--resume", PARENT, "--fork-session", "--session-id", UUID]);
      expect(cliArgs("codex", "fork", { forkFrom: PARENT })).toEqual(["fork", PARENT]);
    });

    it("needs the session to fork, and a new id for Claude", () => {
      expect(() => cliArgs("claude", "fork", { nativeId: UUID })).toThrow(/session to fork/);
      expect(() => cliArgs("codex", "fork", {})).toThrow(/session to fork/);
      expect(() => cliArgs("claude", "fork", { forkFrom: PARENT })).toThrow(/session id/);
    });

    it("refuses a parent id that is not a plain token or looks like a flag", () => {
      for (const bad of ["a b", "x;rm", "$(id)", "--dangerously-skip-permissions", "-x", ""]) {
        expect(() => cliArgs("claude", "fork", { nativeId: UUID, forkFrom: bad }), bad).toThrow(LaunchError);
        expect(() => cliArgs("codex", "fork", { forkFrom: bad }), bad).toThrow(LaunchError);
      }
    });

    it("has no fork for ZCode", () => {
      expect(() => cliArgs("zcode", "fork", { forkFrom: PARENT })).toThrow(LaunchError);
    });

    it("plans a fork launch in the given directory, labelled with the new session id", async () => {
      const plan = await planLaunch({ engine: "claude", mode: "fork", nativeId: UUID, forkFrom: PARENT, cwd: root, executable: "/bin/claude" });
      expect(plan.argv).toEqual(["/bin/claude", "--resume", PARENT, "--fork-session", "--session-id", UUID]);
      expect(plan.cwd).toBe(path.resolve(root));
      expect(plan.labels["nexbot.native"]).toBe(UUID);
    });
  });

  it("only allows the documented argument alphabet", () => {
    expect(SAFE_ARG.test("a-b_c.d:e/f=g")).toBe(true);
    expect(SAFE_ARG.test("a,b")).toBe(false);
    expect(SAFE_ARG.test("with space")).toBe(false);
  });

  describe("model and effort", () => {
    it("adds no flag when none was picked", () => {
      expect(cliArgs("claude", "new", { nativeId: UUID })).toEqual(["--session-id", UUID]);
      expect(cliArgs("codex", "new", {})).toEqual([]);
    });

    it("passes Claude's --model and --effort, in every mode", () => {
      expect(cliArgs("claude", "new", { nativeId: UUID, model: "opus", effort: "xhigh" })).toEqual(["--session-id", UUID, "--model", "opus", "--effort", "xhigh"]);
      expect(cliArgs("claude", "resume", { nativeId: UUID, effort: "low" })).toEqual(["--resume", UUID, "--effort", "low"]);
      expect(cliArgs("claude", "fork", { nativeId: UUID, forkFrom: "parent-1", model: "opus[1m]" })).toEqual(["--resume", "parent-1", "--fork-session", "--session-id", UUID, "--model", "opus[1m]"]);
    });

    it("passes Codex's -m and -c model_reasoning_effort after the subcommand", () => {
      expect(cliArgs("codex", "new", { model: "gpt-6.2-sol", effort: "high" })).toEqual(["-m", "gpt-6.2-sol", "-c", "model_reasoning_effort=high"]);
      expect(cliArgs("codex", "resume", { nativeId: UUID, effort: "minimal" })).toEqual(["resume", UUID, "-c", "model_reasoning_effort=minimal"]);
      expect(cliArgs("codex", "fork", { forkFrom: UUID, model: "gpt-6-astra" })).toEqual(["fork", UUID, "-m", "gpt-6-astra"]);
      // the config override is a plain token: no quoting needed with or without cmd.exe
      expect(SAFE_ARG.test("model_reasoning_effort=high")).toBe(true);
    });

    it("refuses a model that is not a plain name, an effort the engine lacks, and any option for ZCode", () => {
      for (const model of ["--yolo", "-m", "a b", "a;b", "a&b", "x".repeat(101)]) {
        expect(() => cliArgs("claude", "new", { nativeId: UUID, model }), model).toThrow(LaunchError);
      }
      expect(() => cliArgs("claude", "new", { nativeId: UUID, effort: "ultra" })).toThrow(LaunchError);
      expect(() => cliArgs("codex", "new", { effort: "turbo" })).toThrow(LaunchError);
      expect(() => cliArgs("zcode", "new", { model: "opus" })).toThrow(LaunchError);
      expect(() => cliArgs("zcode", "resume", { nativeId: UUID, effort: "low" })).toThrow(LaunchError);
    });

    it("reaches the argv planLaunch builds", async () => {
      const plan = await planLaunch({ engine: "codex", mode: "new", cwd: root, executable: "/usr/bin/codex", model: "gpt-6.1-terra", effort: "ultra" }, { platform: process.platform, env: {} });
      expect(plan.argv).toEqual(["/usr/bin/codex", "-m", "gpt-6.1-terra", "-c", "model_reasoning_effort=ultra"]);
    });
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

  it.skipIf(onWindows)("finds a CLI in the home folders a Mac app's minimal PATH lacks, after the PATH entries", async () => {
    const home = path.join(root, "home");
    const listed = path.join(root, "listed");
    const local = touch(path.join(home, ".local", "bin", "claude"), "#!/bin/sh\n");
    const env = { PATH: `${listed}:/usr/bin`, HOME: home };
    await expect(resolveCli("claude", { platform: "darwin", env })).resolves.toBe(local);
    // A PATH hit still wins over the fallback folders.
    const first = touch(path.join(listed, "claude"), "#!/bin/sh\n");
    await expect(resolveCli("claude", { platform: "darwin", env, cache: false })).resolves.toBe(first);
    // Other platforms never look there.
    await expect(resolveCli("claude", { platform: "linux", env: { PATH: "/usr/bin", HOME: home }, cache: false })).resolves.toBeNull();
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
    // The plan is made for win32 (PATHEXT), so the stand-in is a .exe on every host.
    const exe = touch(path.join(dir, "claude.exe"));
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

describe("hooks in planLaunch", () => {
  const pipe = process.platform === "win32" ? "\\\\.\\pipe\\nexbot-hook-0123456789abcdef" : "/tmp/nexbot-hook-0123456789abcdef.sock";
  const token = `${"a".repeat(64)}.${UUID}`;

  function plugin(complete = true): string {
    const dir = path.join(root, "plugin dir");
    touch(path.join(dir, ".claude-plugin", "plugin.json"), "{}", false);
    touch(path.join(dir, "hooks", "hooks.json"), "{}", false);
    if (complete) touch(path.join(dir, "hooks", "hook.mjs"), "", false);
    return dir;
  }

  it("adds --plugin-dir and the NEXBOT_HOOK variables for Claude, keeping the whitelist for everything else", async () => {
    const dir = plugin();
    const plan = await planLaunch(
      { engine: "claude", mode: "resume", nativeId: UUID, cwd: root, executable: "/opt/claude", hooks: { pluginDir: dir, node: "/opt/node", pipe, token } },
      { env: {} },
    );
    expect(plan.hooked).toBe(true);
    expect(plan.argv).toEqual(["/opt/claude", "--resume", UUID, "--plugin-dir", dir]);
    expect(plan.env).toMatchObject({ NEXBOT_HOOK_NODE: "/opt/node", NEXBOT_HOOK_PIPE: pipe, NEXBOT_HOOK_TOKEN: token });
    // the plugin path is the only argument outside the alphabet
    expect(plan.argv.filter((arg) => !SAFE_ARG.test(arg))).toEqual(onWindows || /[^A-Za-z0-9_./:=@+-]/.test(dir) ? [dir] : []);
  });

  it("leaves Codex alone and goes without hooks when the plugin is missing or incomplete", async () => {
    const dir = plugin();
    const codex = await planLaunch({ engine: "codex", mode: "new", cwd: root, executable: "/opt/codex", hooks: { pluginDir: dir, node: "/opt/node", pipe, token } }, { env: {} });
    expect(codex.hooked).toBe(false);
    expect(codex.argv).toEqual(["/opt/codex"]);
    expect(codex.env.NEXBOT_HOOK_PIPE).toBeUndefined();

    const missing = await planLaunch({ engine: "claude", mode: "new", nativeId: UUID, cwd: root, executable: "/opt/claude", hooks: { pluginDir: path.join(root, "nothing"), node: "/opt/node", pipe, token } }, { env: {} });
    expect(missing).toMatchObject({ hooked: false, argv: ["/opt/claude", "--session-id", UUID] });
    rmSync(dir, { recursive: true, force: true });
    const partial = await planLaunch({ engine: "claude", mode: "new", nativeId: UUID, cwd: root, executable: "/opt/claude", hooks: { pluginDir: plugin(false), node: "/opt/node", pipe, token } }, { env: {} });
    expect(partial.hooked).toBe(false);
  });

  it("refuses a plugin path or hook variable that could be read as something else", async () => {
    const hooks = (extra: Record<string, string>) => ({ pluginDir: plugin(), node: "/opt/node", pipe, token, ...extra });
    const plan = (h: ReturnType<typeof hooks>) => planLaunch({ engine: "claude", mode: "new", nativeId: UUID, cwd: root, executable: "/opt/claude", hooks: h }, { env: {}, platform: process.platform });
    await expect(plan(hooks({ token: "a\nb" }))).rejects.toMatchObject({ kind: "invalid_argument" });
    await expect(plan(hooks({ node: "" }))).rejects.toMatchObject({ kind: "invalid_argument" });
    expect(() => cliArgs("claude", "new", { nativeId: UUID, pluginDir: "relative/dir" })).toThrowError(expect.objectContaining({ kind: "unsafe_path" }));
    expect(() => cliArgs("claude", "new", { nativeId: UUID, pluginDir: "/a\nb" }, { platform: "linux" })).toThrowError(expect.objectContaining({ kind: "unsafe_path" }));
    expect(() => cliArgs("claude", "new", { nativeId: UUID, pluginDir: "C:\\a&b" }, { platform: "win32" })).toThrowError(expect.objectContaining({ kind: "unsafe_path" }));
    expect(() => cliArgs("codex", "new", { pluginDir: "/a" }, { platform: "linux" })).toThrowError(expect.objectContaining({ kind: "invalid_argument" }));
  });
});
