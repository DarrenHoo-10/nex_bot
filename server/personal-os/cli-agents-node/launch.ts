// How Agent mode starts Claude Code and Codex inside herdr-core (plan 3.5).
//
// Pure planning plus a little disk access: find the CLI like a shell would,
// ask it for its version, and build the argv/env/labels handed to
// `terminal.run`. Nothing here runs the CLI except the 5 s `--version` probe.
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CLI_ENGINES, cliPermissionModes, isCliEffort, isCliModel, type CliEngine, type CliLaunchOptions } from "../../../shared/cli-agents.ts";

export { CLI_ENGINES, type CliEngine };
/** `fork`: a new session that starts from the context of another one (`forkFrom`). */
export type LaunchMode = "new" | "resume" | "fork";

export interface LaunchIds {
  /** The CLI's own session id: chosen by us for a new Claude session, discovered for the rest. */
  nativeId: string;
  /** The session a `fork` starts from. */
  forkFrom: string;
  /** Claude only: nex_bot's own plugin directory (`--plugin-dir`), see validatePluginDir. */
  pluginDir: string;
}

/** What a Claude terminal needs to forward its prompts to the Agent bridge (plan 7.1). */
export interface HookLaunch {
  /** nex_bot's plugin directory, passed as `--plugin-dir` */
  pluginDir: string;
  /** a Node runtime that runs hook.mjs: the executor itself (with ELECTRON_RUN_AS_NODE=1 in the hook command) or node */
  node: string;
  pipe: string;
  token: string;
}

export type LaunchErrorKind = "invalid_argument" | "invalid_cwd" | "cli_not_found" | "unsafe_path";

export class LaunchError extends Error {
  readonly kind: LaunchErrorKind;
  constructor(kind: LaunchErrorKind, message: string) {
    super(message);
    this.name = "LaunchError";
    this.kind = kind;
  }
}

/** Every argument we pass must match this: no spaces, quotes or shell
 * metacharacters, so the same argv is safe whether or not `cmd.exe` is in the way. */
export const SAFE_ARG = /^[A-Za-z0-9._:/=-]+$/;
/** Characters that would be live inside `cmd.exe /s /c` even with quoting. */
const CMD_UNSAFE_PATH = /[&|<>^%!"\r\n]/;
const VERSION_TIMEOUT_MS = 5000;
/** Label value until the CLI's own session id is known. */
export const PENDING_NATIVE_ID = "pending";

export interface PlatformOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function isWindows(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

function envValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (!isWindows(platform)) return env[key];
  const match = Object.keys(env).find((name) => name.toLowerCase() === key.toLowerCase());
  return match ? env[match] : undefined;
}

export function isCmdScript(file: string): boolean {
  return /\.(cmd|bat)$/i.test(file);
}

// ---------------------------------------------------------------------------
// Finding the CLI

const resolveCache = new Map<string, string | null>();

/** Where macOS users commonly install `claude` and `codex` (Homebrew, npm, bun, volta, the native installer). */
export function macFallbackDirectories(home: string): string[] {
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(home && path.posix.isAbsolute(home) ? [".local/bin", ".bun/bin", ".npm-global/bin", ".volta/bin"].map((rest) => path.posix.join(home, rest)) : []),
  ];
}

export function clearCliCache(): void {
  resolveCache.clear();
}

async function isExecutable(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    if (!isWindows(platform)) await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Looks `engine` up on PATH the way `where.exe` (Windows, honouring PATHEXT)
 * or `which` (elsewhere) would. Returns the absolute path, or null. The result
 * is cached per PATH/PATHEXT so a re-scan after the user installs the CLI is
 * one `clearCliCache()` away. */
export async function resolveCli(engine: CliEngine, options: PlatformOptions & { cache?: boolean } = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathValue = envValue(env, "PATH", platform) ?? "";
  const pathExt = isWindows(platform) ? (envValue(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD") : "";
  const home = platform === "darwin" ? (envValue(env, "HOME", platform) || os.homedir()) : "";
  const key = `${platform}\n${engine}\n${pathValue}\n${pathExt}\n${home}`;
  const useCache = options.cache !== false;
  if (useCache && resolveCache.has(key)) return resolveCache.get(key) ?? null;

  const extensions = pathExt
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  const directories = pathValue
    .split(isWindows(platform) ? ";" : ":")
    .map((directory) => directory.trim().replace(/^"(.*)"$/, "$1"))
    .filter((directory) => directory && path.isAbsolute(directory));
  // A Mac app does not start from a login shell, so PATH can lack the folders
  // the CLIs install into. They are tried after the PATH entries, never before.
  if (platform === "darwin") {
    for (const directory of macFallbackDirectories(home)) if (!directories.includes(directory)) directories.push(directory);
  }
  const strategy = launchStrategyFor(engine);
  if (isWindows(platform) && strategy) {
    for (const extra of strategy.windowsExtraDirs?.(env) ?? []) {
      if (extra && !directories.includes(extra)) directories.push(extra);
    }
    if (strategy.preferWindowsExe) {
      // The official Windows installer can also put a .cmd in ~/.local/bin.
      // Prefer the real CLI so long-running processes need no shell.
      for (const directory of directories) {
        const executable = path.join(directory, `${engine}.exe`);
        if (await isExecutable(executable, platform)) {
          if (useCache) resolveCache.set(key, executable);
          return executable;
        }
      }
    }
  }

  let found: string | null = null;
  search: for (const directory of directories) {
    const candidates = isWindows(platform) ? extensions.map((extension) => path.join(directory, `${engine}${extension}`)) : [path.join(directory, engine)];
    for (const candidate of candidates) {
      if (await isExecutable(candidate, platform)) {
        found = candidate;
        break search;
      }
    }
  }
  if (useCache) resolveCache.set(key, found);
  return found;
}

/** The CLI's own `--version`, first line, or null when it cannot answer in 5 s.
 * `.cmd`/`.bat` shims go through `cmd.exe /d /s /c`, as Node refuses to spawn them directly. */
export async function cliVersion(file: string, options: PlatformOptions & { timeoutMs?: number } = {}): Promise<string | null> {
  const output = await cliOutput(file, ["--version"], options);
  return output?.split(/\r?\n/).find((text) => text.trim())?.trim().slice(0, 200) ?? null;
}

/** The terminal uses a private backend when the CLI supports the switch. Older builds use private backends by default. */
export async function codexHasNoDaemonFlag(file: string, options: PlatformOptions = {}): Promise<boolean> {
  const help = await cliOutput(file, ["resume", "--help"], options);
  return /(?:^|\s)--no-daemon(?:\s|$)/.test(help ?? "");
}

function cliOutput(file: string, cliArgs: string[], options: PlatformOptions & { timeoutMs?: number }): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const timeout = options.timeoutMs ?? VERSION_TIMEOUT_MS;
  let command = file;
  let args = cliArgs;
  let verbatim = false;
  if (isWindows(platform) && isCmdScript(file)) {
    if (CMD_UNSAFE_PATH.test(file)) return Promise.resolve(null);
    command = envValue(env, "ComSpec", platform) ?? "cmd.exe";
    // /s strips the outer pair of quotes, leaving the quoted path intact.
    args = ["/d", "/s", "/c", `""${file}" ${cliArgs.join(" ")}"`];
    verbatim = true;
  }
  return new Promise<string | null>((resolve) => {
    execFile(
      command,
      args,
      { timeout, windowsHide: true, windowsVerbatimArguments: verbatim, env, maxBuffer: 64 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Argv, cwd, labels, env

function assertSafeId(id: string, what: string): void {
  if (!SAFE_ARG.test(id) || id.startsWith("-")) {
    throw new LaunchError("invalid_argument", `${what} is not a valid session id`);
  }
}

/** The one argument that is not a plain token: the plugin directory is a path we
 * generate (often with spaces and backslashes), passed as a single argv element and
 * never through a shell. It must be absolute and free of control characters, and on
 * Windows of the characters `cmd.exe` would still interpret when the CLI is a `.cmd` shim. */
export function validatePluginDir(dir: string, platform: NodeJS.Platform = process.platform): string {
  const absolute = typeof dir === "string" && (isWindows(platform) ? path.win32.isAbsolute(dir) : path.posix.isAbsolute(dir));
  // eslint-disable-next-line no-control-regex
  if (!absolute || dir.length > 1024 || /[\u0000-\u001f\u007f]/.test(dir) || (isWindows(platform) && CMD_UNSAFE_PATH.test(dir))) {
    throw new LaunchError("unsafe_path", "the plugin directory is not a safe absolute path");
  }
  return dir;
}

/** What `cliArgs` takes: the ids plus the model and effort the user picked. */
export type LaunchArgs = Partial<LaunchIds> & CliLaunchOptions;

/** The model and effort flags: Claude Code 2.1 `--model <m> --effort <level>`,
 * Codex 0.163 `-m <m> -c model_reasoning_effort=<level>` (after `resume <id>` /
 * `fork <id>`, whose subcommands take the same options). A model name may carry
 * `[` `]` (`opus[1m]`): it is checked against CLI_MODEL_RE instead of SAFE_ARG;
 * neither bracket means anything to cmd.exe, and it can never start with `-`. */
/** Extensible per-harness CLI argument & permission strategy. */
export interface HarnessLaunchStrategy {
  readonly acceptsPluginDir?: boolean;
  readonly startupFlags?: readonly string[];
  readonly preferWindowsExe?: boolean;
  windowsExtraDirs?(env: NodeJS.ProcessEnv): string[];
  modeArgs(mode: LaunchMode, ids: LaunchArgs): string[];
  optionFlags?(options: CliLaunchOptions): string[];
  permissionFlags?(mode: NonNullable<CliLaunchOptions["permissions"]>): string[];
}

/** Codex's TUI checks for a newer release on startup and, when it finds one, opens an
 * "Update available" menu before the chat with "Update now" preselected. A session
 * started from another device sits on that menu, and any Enter there runs the
 * installer and quits the TUI ("Please restart Codex"). Terminals started here skip
 * the check; the user's own `codex` keeps their config (checked on Codex 0.172). */
export const CODEX_STARTUP_FLAGS: readonly string[] = ["-c", "check_for_update_on_startup=false"];

const LAUNCH_STRATEGIES = new Map<string, HarnessLaunchStrategy>([
  [
    "claude",
    {
      acceptsPluginDir: true,
      modeArgs(mode, ids) {
        if (!ids.nativeId) throw new LaunchError("invalid_argument", "a Claude session needs a session id");
        assertSafeId(ids.nativeId, "the Claude session");
        // a real context fork: the CLI copies the parent's history into the new id we choose
        return mode === "new"
          ? ["--session-id", ids.nativeId]
          : mode === "fork"
            ? ["--resume", ids.forkFrom as string, "--fork-session", "--session-id", ids.nativeId]
            : ["--resume", ids.nativeId];
      },
      optionFlags({ model, effort }) {
        const flags: string[] = [];
        if (model !== undefined) flags.push("--model", model);
        if (effort !== undefined) flags.push("--effort", effort);
        return flags;
      },
      permissionFlags(mode) {
        if (mode === "full") return ["--dangerously-skip-permissions"];
        return ["--permission-mode", mode === "ask" ? "default" : mode === "edits" ? "acceptEdits" : mode];
      },
    },
  ],
  [
    "codex",
    {
      startupFlags: CODEX_STARTUP_FLAGS,
      modeArgs(mode, ids) {
        if (mode === "new") return [];
        if (mode === "fork") return ["fork", ids.forkFrom as string];
        if (!ids.nativeId) throw new LaunchError("invalid_argument", "resuming Codex needs a session id");
        assertSafeId(ids.nativeId, "the Codex session");
        return ["resume", ids.nativeId];
      },
      optionFlags({ model, effort }) {
        const flags: string[] = [];
        if (model !== undefined) flags.push("-m", model);
        if (effort !== undefined) flags.push("-c", `model_reasoning_effort=${effort}`);
        return flags;
      },
      permissionFlags(mode) {
        if (mode === "full") return ["--dangerously-bypass-approvals-and-sandbox"];
        return ["-c", `sandbox_mode=${mode === "readonly" ? "read-only" : "workspace-write"}`, "-c", "approval_policy=on-request"];
      },
    },
  ],
  [
    "agy",
    {
      preferWindowsExe: true,
      windowsExtraDirs(env) {
        const local = envValue(env, "LOCALAPPDATA", "win32");
        return local && path.isAbsolute(local) ? [path.join(local, "Microsoft", "WinGet", "Links"), path.join(local, "agy", "bin")] : [];
      },
      modeArgs(mode, ids) {
        if (mode !== "resume" || !ids.nativeId) throw new LaunchError("invalid_argument", "Antigravity terminal requires an existing session");
        assertSafeId(ids.nativeId, "the Antigravity session");
        return ["--conversation", ids.nativeId];
      },
      optionFlags({ model, effort }) {
        const flags: string[] = [];
        if (model !== undefined) flags.push("-m", model);
        if (effort !== undefined) flags.push("-c", `model_reasoning_effort=${effort}`);
        return flags;
      },
    },
  ],
  [
    "zcode",
    {
      modeArgs(mode, ids) {
        if (mode === "fork") throw new LaunchError("invalid_argument", "ZCode cannot fork a session");
        if (mode === "new") return [];
        if (!ids.nativeId) throw new LaunchError("invalid_argument", "resuming ZCode needs a session id");
        assertSafeId(ids.nativeId, "the ZCode session");
        return ["--resume", ids.nativeId];
      },
      optionFlags() {
        throw new LaunchError("invalid_argument", "ZCode cannot choose a model or effort");
      },
    },
  ],
]);

export function launchStrategyFor(engine: CliEngine | string): HarnessLaunchStrategy | null {
  return LAUNCH_STRATEGIES.get(engine) ?? null;
}

/** Registers a launch strategy for a harness; returns a disposer. */
export function registerLaunchStrategy(engine: CliEngine | string, strategy: HarnessLaunchStrategy): () => void {
  const previous = LAUNCH_STRATEGIES.get(engine);
  LAUNCH_STRATEGIES.set(engine, strategy);
  return () => {
    if (LAUNCH_STRATEGIES.get(engine) !== strategy) return;
    if (previous) LAUNCH_STRATEGIES.set(engine, previous);
    else LAUNCH_STRATEGIES.delete(engine);
  };
}

function launchFlags(engine: CliEngine, options: CliLaunchOptions): string[] {
  const strategy = launchStrategyFor(engine);
  const { model, effort } = options;
  const access = permissionFlags(engine, options.permissions);
  if (model === undefined && effort === undefined) return access;
  if (!strategy?.optionFlags) throw new LaunchError("invalid_argument", `${engine} cannot choose a model or effort`);
  if (model !== undefined && !isCliModel(model)) throw new LaunchError("invalid_argument", "the model name is not allowed");
  if (effort !== undefined && !isCliEffort(engine, effort)) throw new LaunchError("invalid_argument", `${engine} has no effort ${JSON.stringify(effort)}`);
  const flags = strategy.optionFlags(options);
  for (const flag of flags) {
    if (flag !== model && !SAFE_ARG.test(flag)) throw new LaunchError("invalid_argument", `argument ${JSON.stringify(flag)} is not allowed`);
  }
  return [...flags, ...access];
}

/** Each CLI's own permission mode, dispatched through its launch strategy. */
export function permissionFlags(engine: CliEngine, mode: CliLaunchOptions["permissions"]): string[] {
  const strategy = launchStrategyFor(engine);
  if (mode === undefined || !strategy?.permissionFlags) return [];
  if (!cliPermissionModes(engine).includes(mode)) throw new LaunchError("invalid_argument", `${engine} has no permission mode ${JSON.stringify(mode)}`);
  return strategy.permissionFlags(mode);
}

/** The CLI arguments (without the executable). Dispatched through the harness launch strategy. */
export function cliArgs(engine: CliEngine, mode: LaunchMode, ids: LaunchArgs = {}, options: PlatformOptions = {}): string[] {
  const strategy = launchStrategyFor(engine);
  if (!strategy) throw new LaunchError("invalid_argument", `unknown engine ${String(engine)}`);
  if (mode === "fork") {
    if (!ids.forkFrom) throw new LaunchError("invalid_argument", "a fork needs the session to fork");
    assertSafeId(ids.forkFrom, "the session to fork");
  }
  const args = [...strategy.modeArgs(mode, ids)];
  for (const arg of args) {
    if (!SAFE_ARG.test(arg)) throw new LaunchError("invalid_argument", `argument ${JSON.stringify(arg)} is not allowed`);
  }
  args.push(...launchFlags(engine, ids));
  if (strategy.startupFlags?.length) args.push(...strategy.startupFlags);
  if (ids.pluginDir !== undefined) {
    if (!strategy.acceptsPluginDir) throw new LaunchError("invalid_argument", "only Claude takes a plugin directory");
    args.push("--plugin-dir", validatePluginDir(ids.pluginDir, options.platform ?? process.platform));
  }
  return args;
}

/** Full argv for `terminal.run`. `executable` is what resolveCli returned.
 *
 * herdr-core 0.1.21 starts a `.cmd`/`.bat` shim directly, even from a path with
 * spaces (phase 0 spike, docs/verification/agent-mode-spike-20261115.md), so the
 * default is to pass the shim as argv[0]. Wrapping it in `cmd.exe /d /s /c`
 * (`wrapCmd: true`) is kept as a fallback: it works for paths without spaces and
 * breaks for paths with them, because cmd then splits the unquoted path. */
export function buildArgv(
  engine: CliEngine,
  mode: LaunchMode,
  ids: LaunchArgs,
  executable: string,
  options: PlatformOptions & { wrapCmd?: boolean } = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (!executable) throw new LaunchError("cli_not_found", `${engine} was not found`);
  const args = cliArgs(engine, mode, ids, { platform });
  if (isWindows(platform) && isCmdScript(executable)) {
    if (CMD_UNSAFE_PATH.test(executable)) {
      throw new LaunchError("unsafe_path", `${executable} contains characters cmd.exe would interpret`);
    }
    if (options.wrapCmd) return [envValue(env, "ComSpec", platform) ?? "cmd.exe", "/d", "/s", "/c", executable, ...args];
  }
  return [executable, ...args];
}

async function pluginComplete(dir: string): Promise<boolean> {
  for (const file of [path.join(".claude-plugin", "plugin.json"), path.join("hooks", "hooks.json"), path.join("hooks", "hook.mjs")]) {
    try {
      if (!(await stat(path.join(dir, file))).isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** The working directory must be an absolute path to an existing directory. */
export async function validateCwd(cwd: string, options: PlatformOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const absolute = isWindows(platform) ? path.win32.isAbsolute(cwd) : path.posix.isAbsolute(cwd);
  if (typeof cwd !== "string" || !cwd || !absolute) {
    throw new LaunchError("invalid_cwd", "the working directory must be an absolute path");
  }
  if (cwd.includes("\0")) throw new LaunchError("invalid_cwd", "the working directory is not valid");
  let info;
  try {
    info = await stat(cwd);
  } catch {
    throw new LaunchError("invalid_cwd", `the working directory ${cwd} does not exist`);
  }
  if (!info.isDirectory()) throw new LaunchError("invalid_cwd", `${cwd} is not a directory`);
  return path.resolve(cwd);
}

/** Labels stored on the herdr-core terminal so Agent mode can recognise its own
 * terminals after a restart (events.subscribe filters on `nexbot`). */
export function terminalLabels(engine: CliEngine, nativeId: string): Record<string, string> {
  return { nexbot: "1", "nexbot.engine": engine, "nexbot.native": nativeId };
}

/** A readable, unique-enough terminal name. */
export function terminalName(engine: CliEngine, nativeId: string): string {
  const slug = nativeId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "session";
  return `nexbot-${engine}-${slug}`;
}

const CONFIG_HOME_VARIABLES: Record<CliEngine, { variable: string; fallback: string }> = {
  claude: { variable: "CLAUDE_CONFIG_DIR", fallback: ".claude" },
  codex: { variable: "CODEX_HOME", fallback: ".codex" },
  zcode: { variable: "ZCODE_CONFIG_DIR", fallback: ".zcode" },
  agy: { variable: "ANTIGRAVITY_CLI_CONFIG_DIR", fallback: ".gemini/antigravity-cli" },
};

/** The CLI keeps its sessions in a config home; when the user relocated it
 * (CLAUDE_CONFIG_DIR / CODEX_HOME), the terminal must see the same value even
 * though herdr-core may have been started from a different environment. The
 * default location is never forced, so the CLI keeps behaving as for the user. */
export function launchEnv(engine: CliEngine, options: PlatformOptions & { homedir?: string } = {}): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const { variable, fallback } = CONFIG_HOME_VARIABLES[engine];
  const configured = envValue(env, variable, platform)?.trim();
  if (!configured) return {};
  const pathApi = isWindows(platform) ? path.win32 : path.posix;
  const home = options.homedir ?? os.homedir();
  const normalize = (value: string) => {
    const resolved = pathApi.resolve(value);
    return isWindows(platform) ? resolved.toLowerCase() : resolved;
  };
  if (normalize(configured) === normalize(pathApi.join(home, fallback))) return {};
  return { [variable]: configured };
}

export interface PlannedLaunch {
  /** the terminal forwards prompts and turn ends to nex_bot (the plugin was found) */
  hooked: boolean;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  name: string;
  labels: Record<string, string>;
}

/** Everything `terminal.run` needs for one Agent mode terminal. */
export async function planLaunch(
  input: { engine: CliEngine; mode: LaunchMode; nativeId?: string; forkFrom?: string; key?: string; cwd: string; executable?: string; hooks?: HookLaunch } & CliLaunchOptions,
  options: PlatformOptions & { homedir?: string; wrapCmd?: boolean } = {},
): Promise<PlannedLaunch> {
  const cwd = await validateCwd(input.cwd, options);
  const executable = input.executable ?? (await resolveCli(input.engine, options));
  if (!executable) throw new LaunchError("cli_not_found", `${input.engine} was not found on PATH`);
  // Hooks are an extra: a plugin directory that is missing or incomplete just means no cards.
  const hooks = launchStrategyFor(input.engine)?.acceptsPluginDir && input.hooks && (await pluginComplete(input.hooks.pluginDir)) ? input.hooks : undefined;
  if (hooks) {
    for (const [name, value] of Object.entries({ node: hooks.node, pipe: hooks.pipe, token: hooks.token })) {
      // eslint-disable-next-line no-control-regex
      if (!value || /[\u0000-\u001f\u007f]/.test(value)) throw new LaunchError("invalid_argument", `the hook ${name} is not valid`);
    }
  }
  const argv = buildArgv(
    input.engine,
    input.mode,
    {
      nativeId: input.nativeId,
      ...(input.forkFrom ? { forkFrom: input.forkFrom } : {}),
      ...(hooks ? { pluginDir: hooks.pluginDir } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
    },
    executable,
    options,
  );
  // A brand-new Codex session has no id until the CLI writes its transcript;
  // `key` (the Agent mode session id) keeps its terminal name unique meanwhile.
  const nativeId = input.nativeId ?? PENDING_NATIVE_ID;
  return {
    hooked: hooks !== undefined,
    argv,
    cwd,
    env: {
      ...launchEnv(input.engine, options),
      ...(hooks ? { NEXBOT_HOOK_NODE: hooks.node, NEXBOT_HOOK_PIPE: hooks.pipe, NEXBOT_HOOK_TOKEN: hooks.token } : {}),
    },
    name: terminalName(input.engine, input.key ?? input.nativeId ?? ""),
    labels: terminalLabels(input.engine, nativeId),
  };
}
