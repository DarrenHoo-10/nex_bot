// Git on the device that owns the repository (workbench plan section 2, P7).
// Core never runs git: the executor answers the `git` op for a session's cwd
// with a status snapshot, and creates an independent worktree for the
// new-session dialog. Every call is `git --no-optional-locks -C <dir>` with an
// argument array — no shell — and results never carry absolute paths.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { isSafeCliArg } from "../../../shared/cli-agents.ts";
import type { CliGitInfo } from "../../../shared/cli-agents.ts";

export interface DeviceGitOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** test seam */
  run?: (cwd: string, args: string[]) => Promise<string>;
}

const DEFAULT_TIMEOUT = 8000;

function sanitizedEnv(options: DeviceGitOptions): NodeJS.ProcessEnv {
  // the same guards the review fixture uses: no user hooks, no system config
  return {
    ...options.env,
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

export class DeviceGit {
  private readonly run: (cwd: string, args: string[]) => Promise<string>;

  constructor(private readonly options: DeviceGitOptions = {}) {
    this.run =
      options.run ??
      ((cwd, args) =>
        new Promise((resolve, reject) => {
          execFile(
            "git",
            ["--no-optional-locks", "-C", cwd, ...args],
            {
              timeout: options.timeoutMs ?? DEFAULT_TIMEOUT,
              windowsHide: true,
              encoding: "utf8",
              maxBuffer: 4 * 1024 * 1024,
              env: sanitizedEnv(options),
            },
            (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
          );
        }));
  }

  /** The status snapshot of `cwd`, or `source: "none"` when it is not a
   * repository. A failing git answers `source: "failed"` with a short reason. */
  async info(cwd: string): Promise<CliGitInfo> {
    try {
      const [head, branch, changes, stats, root] = await Promise.all([
        this.run(cwd, ["rev-parse", "--short", "HEAD"]).catch(() => ""),
        this.run(cwd, ["branch", "--show-current"]).catch(() => ""),
        this.run(cwd, ["status", "--porcelain=v1", "--no-renames", "-z", "--untracked-files=all"]).catch(() => ""),
        this.run(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", "HEAD", "--"]).catch(() => ""),
        this.run(cwd, ["rev-parse", "--show-toplevel"]).catch(() => ""),
      ]);
      if (!head && !branch) return { source: "none" };
      let added = 0;
      let removed = 0;
      for (const line of stats.split("\0")) {
        const match = /^(\d+)\t(\d+)\t/.exec(line);
        if (match) {
          added += Number(match[1]);
          removed += Number(match[2]);
        }
      }
      return {
        source: "worktree",
        worktree: cwd,
        ...(root ? { project: root.trim() } : {}),
        branch: branch.trim() || "分离 HEAD",
        ...(head ? { head: head.trim() } : {}),
        files: changes.split("\0").filter(Boolean).map((entry) => entry.slice(3)).slice(0, 500),
        added,
        removed,
      };
    } catch (error) {
      return { source: "failed", error: shortReason(error) };
    }
  }

  /** Creates an independent worktree of the repository at `repoCwd`, deduped
   * by requestId: a retry returns the tree the first attempt built. The trees
   * live next to the repository under `.nexbot-worktrees/<repo>/`. */
  async worktree(repoCwd: string, branch: string, requestId: string, options: { platform?: NodeJS.Platform } = {}): Promise<CliGitInfo> {
    const pathApi = (options.platform ?? this.options.platform ?? process.platform) === "win32" ? path.win32 : path.posix;
    if (!isSafeCliArg(branch) || branch.startsWith("-")) return { source: "failed", error: "分支名不合法" };
    if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId)) return { source: "failed", error: "创建请求无效" };
    const base = pathApi.join(pathApi.dirname(repoCwd), ".nexbot-worktrees", pathApi.basename(repoCwd));
    const slug = branch.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60);
    const target = pathApi.join(base, `${slug}-${requestId.slice(0, 8)}`);
    try {
      if (!existsSync(target)) {
        try {
          // -b: the branch must not exist yet; a taken name is retried with it
          await this.run(repoCwd, ["worktree", "add", "-b", branch, target, "HEAD"]);
        } catch {
          // the branch already exists (a retry with a new requestId): git
          // refuses to check a branch out twice, so the tree attaches detached
          await this.run(repoCwd, ["worktree", "add", "--detach", target, branch]);
        }
      }
      return await this.info(target);
    } catch (error) {
      return { source: "failed", error: shortReason(error) };
    }
  }
}

function shortReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const first = message.split(/\r?\n/).find((line) => line.trim());
  return (first ?? "git 执行失败").slice(0, 200);
}
