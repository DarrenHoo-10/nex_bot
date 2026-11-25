// "Open on this computer" (plan 3.7): a window attached to the same
// herdr-core terminal. Windows writes `attach-<address>.cmd` and starts it in
// Windows Terminal (or a plain console). macOS writes `attach-<address>.command`
// and opens it in Terminal. Command construction is pure so it can be tested
// without opening a window.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export class OpenLocalError extends Error {
  readonly code: "invalid" | "hc_unavailable";
  constructor(code: "invalid" | "hc_unavailable", message: string) {
    super(message);
    this.name = "OpenLocalError";
    this.code = code;
  }
}

/** Terminal addresses are plain tokens; anything else never reaches a command file. */
const SAFE_ADDRESS = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** Characters cmd.exe would treat as syntax, even inside quotes (`%`, `!`) or around them. */
const CMD_UNSAFE = /[&|<>^%!"\r\n]/;
/** Control characters never belong in a shell script value (they include newlines). */
// eslint-disable-next-line no-control-regex
const SH_UNSAFE = /[\u0000-\u001f\u007f]/;

export interface OpenLocalInput {
  /** the terminal address from herdr-core */
  address: string;
  /** absolute path of the herdr-core executable */
  binary: string;
  session: string;
  socket: string;
  /** where the attach file is written */
  dir: string;
  platform?: NodeJS.Platform;
  /** whether `wt.exe` can be started */
  hasWindowsTerminal?: boolean;
}

export interface OpenLocalPlan {
  file: string;
  /** text of the command file (CRLF on Windows, LF on macOS) */
  content: string;
  command: string;
  args: string[];
  /** file mode for the command file; only the owner may run it on macOS */
  mode?: number;
}

export function attachFileName(address: string, platform: NodeJS.Platform = "win32"): string {
  return `attach-${address.replace(/[^A-Za-z0-9._-]/g, "_")}.${platform === "darwin" ? "command" : "cmd"}`;
}

/** POSIX single-quote escaping: the value is taken literally by `sh`. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Builds the command file and the launch command line; touches no file. */
export function planOpenLocal(input: OpenLocalInput): OpenLocalPlan {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin") throw new OpenLocalError("invalid", "opening on this computer is available on Windows and macOS only");
  if (!SAFE_ADDRESS.test(input.address)) throw new OpenLocalError("invalid", "the terminal address is not valid");
  const unsafe = platform === "darwin" ? SH_UNSAFE : CMD_UNSAFE;
  for (const [name, value] of [["herdr-core path", input.binary], ["session", input.session], ["socket", input.socket], ["directory", input.dir]] as const) {
    if (!value || unsafe.test(value)) throw new OpenLocalError("invalid", `the ${name} cannot be used in a command file`);
  }
  if (platform === "darwin") {
    const file = path.posix.join(input.dir, attachFileName(input.address, platform));
    const content =
      [
        "#!/bin/sh",
        `export HC_SESSION=${shQuote(input.session)}`,
        `export HC_SOCKET=${shQuote(input.socket)}`,
        `exec ${shQuote(input.binary)} attach ${input.address}`,
        "",
      ].join("\n");
    return { file, content, command: "/usr/bin/open", args: ["-a", "Terminal", file], mode: 0o700 };
  }
  const file = path.win32.join(input.dir, attachFileName(input.address));
  const content =
    [
      "@echo off",
      "chcp 65001 >nul",
      `set "HC_SESSION=${input.session}"`,
      `set "HC_SOCKET=${input.socket}"`,
      `"${input.binary}" attach ${input.address}`,
      "",
    ].join("\r\n");
  // wt.exe splits its command line on `;`, so such a path takes the plain route.
  if (input.hasWindowsTerminal && !file.includes(";")) {
    return { file, content, command: "wt.exe", args: ["-w", "new", "cmd.exe", "/d", "/k", file] };
  }
  return { file, content, command: "cmd.exe", args: ["/d", "/c", "start", "", "cmd.exe", "/d", "/k", file] };
}

/** `wt.exe` is a per-user app-execution alias, so look in PATH and the alias folder. */
export function findWindowsTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  const dirs = (env.PATH ?? env.Path ?? "").split(";").filter(Boolean);
  if (env.LOCALAPPDATA) dirs.push(path.win32.join(env.LOCALAPPDATA, "Microsoft", "WindowsApps"));
  return dirs.some((dir) => existsSync(path.win32.join(dir, "wt.exe")));
}

/** Writes the command file and starts the window. Resolves once it was started. */
export async function openLocal(input: OpenLocalInput, launcher: (plan: OpenLocalPlan) => Promise<void> = defaultLauncher): Promise<OpenLocalPlan> {
  const platform = input.platform ?? process.platform;
  const plan = planOpenLocal({ ...input, hasWindowsTerminal: input.hasWindowsTerminal ?? (platform === "win32" && findWindowsTerminal()) });
  mkdirSync(input.dir, { recursive: true });
  writeFileSync(plan.file, plan.content, { encoding: "utf8", ...(plan.mode ? { mode: plan.mode } : {}) });
  // `mode` is ignored when the file already exists, so set it explicitly.
  if (plan.mode) chmodSync(plan.file, plan.mode);
  await launcher(plan);
  return plan;
}

function defaultLauncher(plan: OpenLocalPlan): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", (error) => reject(new OpenLocalError("hc_unavailable", `could not open a window: ${error.message}`)));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
