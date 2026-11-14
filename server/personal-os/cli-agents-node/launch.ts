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

// TODO(contract): CliEngine / launch modes move to shared/cli-agents.ts.
export type CliEngine = "claude" | "codex";
export type LaunchMode = "new" | "resume";

export const CLI_ENGINES: readonly CliEngine[] = ["claude", "codex"];

export interface LaunchIds {
  /** The CLI's own session id: chosen by us for a new Claude session, discovered for the rest. */
  nativeId: string;
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
  const key = `${platform}\n${engine}\n${pathValue}\n${pathExt}`;
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
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const timeout = options.timeoutMs ?? VERSION_TIMEOUT_MS;
  let command = file;
  let args = ["--version"];
  let verbatim = false;
  if (isWindows(platform) && isCmdScript(file)) {
    if (CMD_UNSAFE_PATH.test(file)) return null;
    command = envValue(env, "ComSpec", platform) ?? "cmd.exe";
    // /s strips the outer pair of quotes, leaving the quoted path intact.
    args = ["/d", "/s", "/c", `""${file}" --version"`];
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
        const line = String(stdout).split(/\r?\n/).find((text) => text.trim());
        resolve(line ? line.trim().slice(0, 200) : null);
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

/** The CLI arguments (without the executable). New Claude sessions get an id we
 * choose so the transcript can be found at once; Codex assigns its own. */
export function cliArgs(engine: CliEngine, mode: LaunchMode, ids: Partial<LaunchIds> = {}): string[] {
  let args: string[];
  if (engine === "claude") {
    if (!ids.nativeId) throw new LaunchError("invalid_argument", "a Claude session needs a session id");
    assertSafeId(ids.nativeId, "the Claude session");
    args = mode === "new" ? ["--session-id", ids.nativeId] : ["--resume", ids.nativeId];
  } else if (engine === "codex") {
    if (mode === "new") {
      args = [];
    } else {
      if (!ids.nativeId) throw new LaunchError("invalid_argument", "resuming Codex needs a session id");
      assertSafeId(ids.nativeId, "the Codex session");
      args = ["resume", ids.nativeId];
    }
  } else {
    throw new LaunchError("invalid_argument", `unknown engine ${String(engine)}`);
  }
  for (const arg of args) {
    if (!SAFE_ARG.test(arg)) throw new LaunchError("invalid_argument", `argument ${JSON.stringify(arg)} is not allowed`);
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
  ids: Partial<LaunchIds>,
  executable: string,
  options: PlatformOptions & { wrapCmd?: boolean } = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (!executable) throw new LaunchError("cli_not_found", `${engine} was not found`);
  const args = cliArgs(engine, mode, ids);
  if (isWindows(platform) && isCmdScript(executable)) {
    if (CMD_UNSAFE_PATH.test(executable)) {
      throw new LaunchError("unsafe_path", `${executable} contains characters cmd.exe would interpret`);
    }
    if (options.wrapCmd) return [envValue(env, "ComSpec", platform) ?? "cmd.exe", "/d", "/s", "/c", executable, ...args];
  }
  return [executable, ...args];
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
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  name: string;
  labels: Record<string, string>;
}

/** Everything `terminal.run` needs for one Agent mode terminal. */
export async function planLaunch(
  input: { engine: CliEngine; mode: LaunchMode; nativeId?: string; key?: string; cwd: string; executable?: string },
  options: PlatformOptions & { homedir?: string; wrapCmd?: boolean } = {},
): Promise<PlannedLaunch> {
  const cwd = await validateCwd(input.cwd, options);
  const executable = input.executable ?? (await resolveCli(input.engine, options));
  if (!executable) throw new LaunchError("cli_not_found", `${input.engine} was not found on PATH`);
  const argv = buildArgv(input.engine, input.mode, { nativeId: input.nativeId }, executable, options);
  // A brand-new Codex session has no id until the CLI writes its transcript;
  // `key` (the Agent mode session id) keeps its terminal name unique meanwhile.
  const nativeId = input.nativeId ?? PENDING_NATIVE_ID;
  return {
    argv,
    cwd,
    env: launchEnv(input.engine, options),
    name: terminalName(input.engine, input.key ?? input.nativeId ?? ""),
    labels: terminalLabels(input.engine, nativeId),
  };
}
