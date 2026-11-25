// Process liveness for Agent mode session discovery (plan 3.3).
//
// Claude writes `procStart` (`ps -o lstart=` text under LC_ALL=C TZ=UTC) on
// macOS/Linux and `procStartFt` (a FILETIME, 100 ns ticks since 1601 UTC, as a
// decimal string) on Windows. processStartTimes() returns the same unit so the
// caller can compare with `sameProcessStart`.
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";

export type CommandRunner = (
  file: string,
  args: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string }>;

export const defaultRunner: CommandRunner = (file, args, options) =>
  new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { timeout: options.timeoutMs, windowsHide: true, env: options.env ?? process.env, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
          resolve({ code, stdout: String(stdout ?? "") });
        },
      );
    } catch {
      resolve({ code: 1, stdout: "" });
    }
  });

/** `process.kill(pid, 0)`: EPERM means alive but not ours, ESRCH means gone. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ProcessStartOptions {
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  timeoutMs?: number;
  /** cache lifetime for a pid's start time; a pid's start time never changes while it lives */
  ttlMs?: number;
  now?: () => number;
}

const startCache = new Map<string, { at: number; value: string | null }>();

/** Clears the per-pid cache (tests). */
export function resetProcessStartCache(): void {
  startCache.clear();
}

function validPids(pids: readonly number[]): number[] {
  return [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
}

/** Batched start times, one command for all pids. A pid that is gone or could
 * not be read maps to null; a failed command maps every uncached pid to null
 * (the caller reports `unverified`). Results are cached per pid. */
export async function processStartTimes(
  pids: readonly number[],
  options: ProcessStartOptions = {},
): Promise<Map<number, string | null>> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRunner;
  const now = (options.now ?? Date.now)();
  const ttl = options.ttlMs ?? 5 * 60_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const result = new Map<number, string | null>();
  const missing: number[] = [];
  for (const pid of validPids(pids)) {
    const cached = startCache.get(`${platform}:${pid}`);
    if (cached && now - cached.at < (cached.value === null ? 5000 : ttl)) result.set(pid, cached.value);
    else missing.push(pid);
  }
  if (missing.length === 0) return result;
  const fetched = platform === "win32" ? await windowsStarts(missing, run, timeoutMs) : await unixStarts(missing, run, timeoutMs);
  for (const pid of missing) {
    const value = fetched?.get(pid) ?? null;
    result.set(pid, value);
    // a null (gone or failed) is cached only 5 s, so the next scan retries
    startCache.set(`${platform}:${pid}`, { at: now, value });
  }
  return result;
}

async function windowsStarts(pids: number[], run: CommandRunner, timeoutMs: number): Promise<Map<number, string> | null> {
  const list = pids.join(",");
  const script =
    `$ids=@(${list}); Get-CimInstance Win32_Process | Where-Object { $ids -contains [int]$_.ProcessId } | ` +
    `ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CreationDate.ToFileTimeUtc() }`;
  try {
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs });
    if (out.code !== 0) return null;
    const map = new Map<number, string>();
    for (const line of out.stdout.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d{10,})\s*$/.exec(line);
      if (match) map.set(Number(match[1]), match[2]);
    }
    return map;
  } catch {
    return null;
  }
}

async function unixStarts(
  pids: number[],
  run: CommandRunner,
  timeoutMs: number,
): Promise<Map<number, string> | null> {
  const env = { ...process.env, LC_ALL: "C", TZ: "UTC" };
  const map = new Map<number, string>();
  try {
    // `ps -o pid=,lstart= -p a,b,c` works on macOS and procps; a gone pid is simply absent
    const out = await run("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], { timeoutMs, env });
    if (out.code === 0 || out.stdout.trim()) {
      for (const line of out.stdout.split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
        if (match) map.set(Number(match[1]), match[2].replace(/\s+/g, " "));
      }
      return map;
    }
    // exit 1 with no output: none of the pids exist (still a successful answer)
    if (out.code === 1) return map;
    return null;
  } catch {
    return null;
  }
}

export type StartMatch = "match" | "mismatch" | "unverified";

/** Compares what Claude recorded with the live process. Both sides are
 * normalised: whitespace in `lstart` text, and for FILETIME values a 2 s slack
 * (the writer and the reader may round differently). Anything unreadable on
 * either side is `unverified`, never a mismatch. */
export function sameProcessStart(recorded: unknown, actual: string | null | undefined): StartMatch {
  if (typeof recorded === "number" && Number.isFinite(recorded)) recorded = String(recorded);
  if (typeof recorded !== "string" || recorded.trim() === "" || !actual) return "unverified";
  const a = recorded.trim().replace(/\s+/g, " ");
  const b = actual.trim().replace(/\s+/g, " ");
  if (a === b) return "match";
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    const FLAVOR = 300_000_000_000_000_000n; // FILETIME (1601) vs .NET ticks (0001)
    if (x > FLAVOR !== y > FLAVOR) return "unverified";
    const diff = x > y ? x - y : y - x;
    return diff <= 20_000_000n ? "match" : "mismatch";
  }
  return "mismatch";
}

// ---------------------------------------------------------------------------
// Codex writer detection

export type CodexWriter = "yes" | "no" | "unknown";

export interface CodexWriterOptions {
  now?: number;
  /** how recent a rollout write counts as an active writer */
  recentMs?: number;
}

/** Best effort: a writer lock file `thread-writer-locks/<id>.lock` whose
 * owner pid (when it holds one) is alive, or a rollout written very recently.
 * No lock directory and no recent write is `no` only when the directory
 * exists (so we know the CLI keeps locks); otherwise `unknown`. */
export function codexWriter(home: string, threadId: string, options: CodexWriterOptions = {}): CodexWriter {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(threadId)) return "unknown";
  const now = options.now ?? Date.now();
  const recentMs = options.recentMs ?? 60_000;
  const locks = path.join(home, "thread-writer-locks");
  try {
    const lock = path.join(locks, `${threadId}.lock`);
    if (existsSync(lock)) {
      const pid = lockPid(lock);
      if (pid === null) return statSync(lock).mtimeMs > now - 10 * 60_000 ? "yes" : "unknown";
      return isPidAlive(pid) ? "yes" : "no";
    }
  } catch (error) {
    // On Windows Codex holds this file with an exclusive handle. A stale lock
    // can be read, but reading a held one fails with a sharing violation (EBUSY).
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EBUSY") return "yes";
    return "unknown";
  }
  try {
    if (recentRollout(home, threadId, now - recentMs)) return "yes";
  } catch {
    return "unknown";
  }
  return existsSync(locks) ? "no" : "unknown";
}

function lockPid(file: string): number | null {
  // owner pid is a small JSON or plain number; anything else is "no pid"
  const text = readSmall(file);
  const json = /"pid"\s*:\s*(\d+)/.exec(text) ?? /^\s*(\d+)\s*$/.exec(text);
  return json ? Number(json[1]) : null;
}

function readSmall(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, 512, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function recentRollout(home: string, threadId: string, since: number): boolean {
  const root = path.join(home, "sessions");
  const today = new Date();
  for (let back = 0; back < 2; back += 1) {
    const day = new Date(today.getTime() - back * 86_400_000);
    const dir = path.join(
      root,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0"),
    );
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.includes(threadId) || !name.endsWith(".jsonl")) continue;
      if (statSync(path.join(dir, name)).mtimeMs >= since) return true;
    }
  }
  return false;
}
