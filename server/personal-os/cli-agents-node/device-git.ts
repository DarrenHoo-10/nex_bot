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

const GIT_MISSING = "找不到 git";

/** git could not be started at all (not installed or not on PATH), as opposed
 * to git running and refusing. */
function isGitMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

function gitRunner(options: DeviceGitOptions): (cwd: string, args: string[]) => Promise<string> {
  return (
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
      }))
  );
}

export class DeviceGit {
  private readonly run: (cwd: string, args: string[]) => Promise<string>;

  constructor(private readonly options: DeviceGitOptions = {}) {
    this.run = gitRunner(options);
  }

  /** The status snapshot of `cwd`, or `source: "none"` when it is not a
   * repository. A failing git answers `source: "failed"` with a short reason. */
  async info(cwd: string): Promise<CliGitInfo> {
    // git refusing (not a repository, no commits yet) is an answer; git not
    // starting at all is a failure the user can act on
    const soft = (work: Promise<string>): Promise<string> =>
      work.catch((error) => {
        if (isGitMissing(error)) throw error;
        return "";
      });
    try {
      const [head, branch, changes, stats, root] = await Promise.all([
        soft(this.run(cwd, ["rev-parse", "--short", "HEAD"])),
        soft(this.run(cwd, ["branch", "--show-current"])),
        soft(this.run(cwd, ["status", "--porcelain=v1", "--no-renames", "-z", "--untracked-files=all"])),
        soft(this.run(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", "HEAD", "--"])),
        soft(this.run(cwd, ["rev-parse", "--show-toplevel"])),
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

const ROOT_TTL_MS = 10 * 60_000;
/** a miss (not a repository, directory gone, git missing) is looked at again sooner */
const ROOT_MISS_TTL_MS = 2 * 60_000;
const ROOT_TIMEOUT_MS = 3000;
const ROOT_CACHE_MAX = 2000;
const ROOT_PARALLEL = 4;

export interface RepoRootsOptions extends DeviceGitOptions {
  now?: () => number;
}

/** The main-worktree path of the repository a directory belongs to, for grouping
 * sessions by project (a linked worktree such as `.claude/worktrees/<name>`
 * reports the checkout it was made from). Discovery asks for every session's cwd
 * on every scan, so answers are cached per cwd, a burst of distinct directories
 * runs a few git processes at a time, and a missing git is remembered instead of
 * being spawned once per directory. */
export class RepoRoots {
  private readonly run: (cwd: string, args: string[]) => Promise<string>;
  private readonly cache = new Map<string, { root: string | null; at: number }>();
  private readonly inflight = new Map<string, Promise<string | null>>();
  private gitMissingAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: RepoRootsOptions = {}) {
    this.run = gitRunner({ ...options, timeoutMs: options.timeoutMs ?? ROOT_TIMEOUT_MS });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The cached answer: a path, null for a known miss, undefined when never asked or expired. */
  peek(cwd: string): string | null | undefined {
    const hit = this.cache.get(cwd);
    if (!hit) return undefined;
    return this.now() - hit.at < (hit.root ? ROOT_TTL_MS : ROOT_MISS_TTL_MS) ? hit.root : undefined;
  }

  /** Resolves every directory that has no fresh answer, a few at a time. Never rejects. */
  async warm(cwds: Iterable<string>): Promise<void> {
    const todo = [...new Set(cwds)].filter((cwd) => cwd && this.peek(cwd) === undefined);
    for (let i = 0; i < todo.length; i += ROOT_PARALLEL) {
      await Promise.all(todo.slice(i, i + ROOT_PARALLEL).map((cwd) => this.resolve(cwd)));
    }
  }

  /** The repository root of `cwd`, or null. Never rejects. */
  resolve(cwd: string): Promise<string | null> {
    const fresh = this.peek(cwd);
    if (fresh !== undefined) return Promise.resolve(fresh);
    const pending = this.inflight.get(cwd);
    if (pending) return pending;
    const work = this.lookup(cwd)
      .catch(() => null)
      .then((root) => {
        if (this.cache.size >= ROOT_CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
        this.cache.set(cwd, { root, at: this.now() });
        return root;
      })
      .finally(() => this.inflight.delete(cwd));
    this.inflight.set(cwd, work);
    return work;
  }

  private async lookup(cwd: string): Promise<string | null> {
    if (this.now() - this.gitMissingAt < ROOT_MISS_TTL_MS) return null;
    const platform = this.options.platform ?? process.platform;
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    if (!cwd || !pathApi.isAbsolute(cwd)) return null;
    try {
      const common = clean(await this.run(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
      let root: string | undefined;
      if (common && /^\.git$/i.test(pathApi.basename(pathApi.normalize(common)))) root = pathApi.dirname(pathApi.normalize(common));
      // a submodule's or bare repository's common dir is not `<root>/.git`: its own top level is the project
      if (!root) root = clean(await this.run(cwd, ["rev-parse", "--show-toplevel"]));
      if (!root) return null;
      const normalized = pathApi.normalize(root);
      return pathApi.isAbsolute(normalized) ? normalized : null;
    } catch (error) {
      if (isGitMissing(error)) this.gitMissingAt = this.now();
      return null;
    }
  }
}

/** First line of git's answer, without the `\\?\` extended-length prefix. */
function clean(output: string): string {
  const line = output.split(/\r?\n/).find((entry) => entry.trim()) ?? "";
  return line.trim().replace(/^\\\\\?\\(?!UNC\\)/i, "");
}

function shortReason(error: unknown): string {
  if (isGitMissing(error)) return GIT_MISSING;
  const message = error instanceof Error ? error.message : String(error);
  const first = message.split(/\r?\n/).find((line) => line.trim());
  return (first ?? "git 执行失败").slice(0, 200);
}
