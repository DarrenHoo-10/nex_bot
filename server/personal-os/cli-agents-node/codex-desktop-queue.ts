import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DaemonError } from "./codex-daemon.ts";
import { cliVersion } from "./launch.ts";
import { enqueueCodexText } from "./codex-native-queue.ts";

const exec = promisify(execFile);
const REFRESH_MS = 60_000;
const VERSION = /^codex-cli (\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/;

interface DesktopQueueOptions {
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}

async function installedDesktopCodex(options: DesktopQueueOptions): Promise<string[]> {
  if (options.platform === "darwin") {
    const home = options.homedir ?? os.homedir();
    return ["/Applications", path.join(home, "Applications")].flatMap((dir) =>
      ["ChatGPT.app", "Codex.app"].map((app) => path.join(dir, app, "Contents", "Resources", "codex")),
    );
  }
  if (options.platform !== "win32") return [];
  const env = options.env ?? process.env;
  const powershell = path.join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "Get-AppxPackage -Name OpenAI.Codex | ForEach-Object { $_.InstallLocation }";
  const { stdout } = await exec(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    env, timeout: 5_000, windowsHide: true, maxBuffer: 16 * 1024,
  });
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => path.isAbsolute(line))
    .map((dir) => path.join(dir, "app", "resources", "codex.exe"));
}

/** Codex Desktop consumes its own message queue. Match the runtime published
 * by the thread: an older CLI may accept a write without waking the app. */
export class CodexDesktopQueue {
  private paths = new Map<string, string>();
  private refreshAt = 0;
  private refreshing: Promise<void> | undefined;

  constructor(private readonly options: DesktopQueueOptions) {}

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (Date.now() < this.refreshAt) return Promise.resolve();
    this.refreshing = this.read().finally(() => {
      this.refreshAt = Date.now() + REFRESH_MS;
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async read(): Promise<void> {
    // An unavailable or updated package is picked up on the next refresh.
    const paths = await installedDesktopCodex(this.options).catch(() => []);
    const versions = await Promise.all(paths.map(async (file) => {
      try {
        await access(file);
        const version = VERSION.exec(await cliVersion(file, this.options) ?? "")?.[1];
        return version ? [version, file] as const : null;
      } catch {
        return null;
      }
    }));
    this.paths = new Map(versions.filter((entry) => entry !== null));
  }

  supports(version: string): boolean {
    return this.paths.has(version);
  }

  async send(input: { home: string; threadId: string; version: string; text: string }): Promise<void> {
    const file = this.paths.get(input.version);
    if (!file) throw new DaemonError("read_only", "此 Codex App 会话没有匹配的本地版本");
    await enqueueCodexText({ ...input, file, platform: this.options.platform, env: this.options.env });
  }
}
