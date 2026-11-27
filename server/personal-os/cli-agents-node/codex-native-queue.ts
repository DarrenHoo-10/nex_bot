import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { DaemonError } from "./codex-daemon.ts";

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACK = /^Queued message (\S+) for thread ([\da-f-]+)\.$/i;

export interface CodexQueueTarget {
  file: string;
  home: string;
  threadId: string;
  text: string;
  cwd?: string;
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

type Run = (file: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; windowsHide: boolean; shell: false }) => Promise<{ stdout: string }>;
const run: Run = (file, args, options) => exec(file, args, options);

function queueOptions(target: CodexQueueTarget, timeout: number) {
  const env = { ...(target.env ?? process.env) };
  for (const key of Object.keys(env)) if (key.toUpperCase() === "CODEX_HOME") delete env[key];
  env.CODEX_HOME = target.home;
  return { cwd: target.cwd, env, timeout, maxBuffer: 64 * 1024, windowsHide: true, shell: false as const };
}

export async function enqueueCodexText(target: CodexQueueTarget, execute: Run = run, timeout = 8_000): Promise<string> {
  if (!UUID.test(target.threadId) || !target.text || target.text.includes("\0")) throw new DaemonError("invalid", "Codex 队列消息无效");
  // CreateProcess quotes argv in at most 32767 UTF-16 units. Never hand the text to cmd.exe.
  if (target.platform === "win32" && 2 * (target.text.length + target.file.length) + 256 >= 32767) throw new DaemonError("too_large", "消息超出 Codex 队列长度限制");
  try {
    const { stdout } = await execute(target.file, ["queue", "--thread", target.threadId, "--message=" + target.text], queueOptions(target, timeout));
    return stdout;
  } catch {
    // The queue entry can be durable before the command exits or prints its receipt.
    throw new DaemonError("unknown", "Codex 队列的投递结果待确认");
  }
}

/** Older runtimes can store a queue entry without watching for external writers. */
export function canConsumeCodexQueue(version: string | undefined): boolean {
  const stable = /^(\d+)\.(\d+)\.\d+$/.exec(version ?? "");
  return !!stable && (Number(stable[1]) > 0 || Number(stable[2]) >= 172);
}

export async function tryManagedCodexQueue(target: CodexQueueTarget & { version: string }, beforeWrite: () => Promise<number>, execute: Run = run): Promise<boolean> {
  const paths = target.platform === "win32" ? path.win32 : path.posix;
  if (!canConsumeCodexQueue(target.version) || !UUID.test(target.threadId) || !paths.isAbsolute(target.home) || !paths.isAbsolute(target.file) ||
    (target.platform === "win32" && !target.file.toLowerCase().endsWith(".exe"))) return false;
  const probe = queueOptions(target, 3_000);
  let version: string, help: string;
  try {
    const results = await Promise.all([execute(target.file, ["--version"], probe), execute(target.file, ["queue", "--help"], probe)]);
    [version, help] = results.map((result) => result.stdout);
  } catch { return false; }
  if (version.trim() !== `codex-cli ${target.version}` || !/\bcodex queue\b[^\n]*--thread <THREAD>[^\n]*--message <TEXT>/.test(help)) return false;
  const timeout = await beforeWrite();
  const stdout = await enqueueCodexText(target, execute, timeout);
  if (ACK.exec(stdout.trim())?.[2] !== target.threadId) throw new DaemonError("unknown", "Codex 未确认目标会话的队列收件");
  return true;
}
