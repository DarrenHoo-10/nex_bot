// Git on the device that owns the repository (workbench plan section 2, P7).
// Core never runs git: the executor answers the `git` op for a session's cwd
// with a status snapshot, and creates an independent worktree for the
// new-session dialog. Every call is `git --no-optional-locks -C <dir>` with an
// argument array — no shell — and results never carry absolute paths.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CLI_BRANCH_LIMIT, isCliBranchName, isSafeCliArg } from "../../../shared/cli-agents.ts";
import type { CliGitBranches, CliGitInfo } from "../../../shared/cli-agents.ts";

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
      const [head, branch, changes, stats, toplevel, commonDir] = await Promise.all([
        soft(this.run(cwd, ["rev-parse", "--short", "HEAD"])),
        soft(this.run(cwd, ["branch", "--show-current"])),
        soft(this.run(cwd, ["status", "--porcelain=v1", "--no-renames", "-z", "--untracked-files=all"])),
        soft(this.run(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", "HEAD", "--"])),
        soft(this.run(cwd, ["rev-parse", "--show-toplevel"])),
        soft(this.run(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
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
      const platform = this.options.platform ?? process.platform;
      const pathApi = platform === "win32" ? path.win32 : path.posix;
      const worktree = toplevel.trim() || cwd;
      let project: string | undefined = toplevel.trim() || undefined;
      const commonRaw = commonDir.trim();
      if (commonRaw) {
        const resolvedCommon = pathApi.isAbsolute(commonRaw) ? pathApi.normalize(commonRaw) : pathApi.resolve(worktree, commonRaw);
        if (/^\.git$/i.test(pathApi.basename(resolvedCommon))) project = pathApi.dirname(resolvedCommon);
      }
      return {
        source: "worktree",
        worktree,
        ...(project ? { project } : {}),
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

  /** Local branches and working-tree cleanliness of `cwd`, for the new-session options panel. */
  async branches(cwd: string): Promise<CliGitBranches> {
    const soft = (work: Promise<string>): Promise<string> =>
      work.catch((error) => {
        if (isGitMissing(error)) throw error;
        return "";
      });
    try {
      const [inside, currentRaw, refsRaw, statusRaw] = await Promise.all([
        soft(this.run(cwd, ["rev-parse", "--is-inside-work-tree"])),
        soft(this.run(cwd, ["branch", "--show-current"])),
        soft(this.run(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"])),
        soft(this.run(cwd, ["status", "--porcelain=v1", "--no-renames", "--untracked-files=all"])),
      ]);
      if (inside.trim() !== "true") return { git: false, branches: [] };
      const current = isCliBranchName(currentRaw.trim()) ? currentRaw.trim() : undefined;
      const rawNames = refsRaw.split(/\r?\n/).map((line) => line.trim()).filter(isCliBranchName);
      const ordered: string[] = [];
      const add = (name: string | undefined) => {
        if (name && !ordered.includes(name) && ordered.length < CLI_BRANCH_LIMIT) ordered.push(name);
      };
      if (current && rawNames.includes(current)) add(current);
      for (const preferred of ["main", "master"]) if (rawNames.includes(preferred)) add(preferred);
      for (const name of rawNames) add(name);
      return {
        git: true,
        ...(current ? { current } : {}),
        ...(statusRaw.trim() ? { dirty: true } : {}),
        branches: ordered,
      };
    } catch {
      return { git: false, branches: [] };
    }
  }

  /** Switches `cwd` to an existing local branch when the working tree is clean.
   * Already being on `branch` is a no-op even when there are uncommitted changes. */
  async switchBranch(cwd: string, branch: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isCliBranchName(branch) || !isSafeCliArg(branch)) return { ok: false, error: "分支名不合法" };
    try {
      const current = (await this.run(cwd, ["branch", "--show-current"]).catch((error) => {
        if (isGitMissing(error)) throw error;
        return "";
      })).trim();
      if (current === branch) return { ok: true };
      const status = await this.run(cwd, ["status", "--porcelain=v1", "--no-renames", "--untracked-files=all"]);
      if (status.trim()) return { ok: false, error: "当前目录有未提交改动，请先提交或改用 Worktree" };
      const exists = await this.run(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(
        () => true,
        (error) => {
          if (isGitMissing(error)) throw error;
          return false;
        },
      );
      if (!exists) return { ok: false, error: `找不到本地分支 ${branch}` };
      await this.run(cwd, ["switch", branch]);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already used by worktree/i.test(message)) {
        return { ok: false, error: `分支 ${branch} 已在其他工作树中检出，请改用其他分支或新建 Worktree` };
      }
      return { ok: false, error: shortReason(error) };
    }
  }

  /** Creates an independent worktree of the repository at `repoCwd`, deduped
   * by requestId: a retry returns the tree the first attempt built. The trees
   * live next to the repository under `.nexbot-worktrees/<repo>/`. */
  async worktree(repoCwd: string, branch: string, requestId: string, options: { platform?: NodeJS.Platform; baseBranch?: string } = {}): Promise<CliGitInfo> {
    const pathApi = (options.platform ?? this.options.platform ?? process.platform) === "win32" ? path.win32 : path.posix;
    if (!isCliBranchName(branch) || !isSafeCliArg(branch)) return { source: "failed", error: "分支名不合法" };
    if (options.baseBranch !== undefined && (!isCliBranchName(options.baseBranch) || !isSafeCliArg(options.baseBranch))) {
      return { source: "failed", error: "基准分支名不合法" };
    }
    if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId)) return { source: "failed", error: "创建请求无效" };
    const base = pathApi.join(pathApi.dirname(repoCwd), ".nexbot-worktrees", pathApi.basename(repoCwd));
    const slug = branch.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60);
    const target = pathApi.join(base, `${slug}-${requestId.slice(0, 8)}`);
    const startPoint = options.baseBranch ? `refs/heads/${options.baseBranch}` : "HEAD";
    try {
      if (!existsSync(target)) {
        try {
          // -b: the branch must not exist yet; a taken name is retried with it
          await this.run(repoCwd, ["worktree", "add", "-b", branch, target, startPoint]);
        } catch {
          if (options.baseBranch) {
            const baseExists = await this.run(repoCwd, ["show-ref", "--verify", "--quiet", startPoint]).then(
              () => true,
              (error) => {
                if (isGitMissing(error)) throw error;
                return false;
              },
            );
            if (!baseExists) return { source: "failed", error: `找不到基准分支 ${options.baseBranch}` };
          }
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
const ROOT_CACHE_MAX = 2000;
const ROOT_PARALLEL = 8;
/** how many folders up a lookup walks before it gives up */
const ROOT_MAX_DEPTH = 64;

export interface RepoRootsOptions {
  platform?: NodeJS.Platform;
  now?: () => number;
  /** the user's home folder: it, and any folder above it, is no project */
  home?: string;
}

/** The main-worktree path of the repository a directory belongs to, for grouping
 * sessions by project (a linked worktree such as `.claude/worktrees/<name>`
 * reports the checkout it was made from). It reads the repository's own files and
 * runs no git: the nearest `.git` going up from the directory is either the main
 * checkout's folder, or a linked worktree's file whose `gitdir` (and that folder's
 * `commondir`) leads back to the main checkout's `.git`; a submodule's file leads
 * elsewhere, and its own folder is the project. The home folder, or one above it,
 * is no project. Answers are cached per directory. */
/** What discovery needs of a repository-root lookup (a fake in tests). */
export interface RepoRootLookup {
  peek(cwd: string): string | null | undefined;
  warm(cwds: Iterable<string>): Promise<void>;
}

export class RepoRoots implements RepoRootLookup {
  private readonly cache = new Map<string, { root: string | null; at: number }>();
  private readonly inflight = new Map<string, Promise<string | null>>();

  constructor(private readonly options: RepoRootsOptions = {}) {}

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
    const platform = this.options.platform ?? process.platform;
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    const bare = cwd.replace(/^\\\\\?\\(?!UNC\\)/i, "");
    if (!bare || !pathApi.isAbsolute(bare)) return null;
    let dir = pathApi.normalize(bare);
    for (let depth = 0; depth < ROOT_MAX_DEPTH; depth++) {
      const dotGit = pathApi.join(dir, ".git");
      const info = await stat(dotGit).catch(() => null);
      if (info?.isDirectory()) return this.project(dir, pathApi);
      if (info?.isFile()) {
        const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, "utf8").catch(() => ""));
        if (pointer) {
          const gitdir = pathApi.resolve(dir, pointer[1]);
          const commondir = (await readFile(pathApi.join(gitdir, "commondir"), "utf8").catch(() => "")).trim();
          if (commondir) {
            const common = pathApi.resolve(gitdir, commondir);
            if (/^\.git$/i.test(pathApi.basename(common))) return this.project(pathApi.dirname(common), pathApi);
          }
        }
        // a submodule, or a layout this does not know: its own folder is the project
        return this.project(dir, pathApi);
      }
      const parent = pathApi.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    return null;
  }

  /** `root`, unless it is the home folder or one above it. */
  private project(root: string, pathApi: typeof path.posix): string | null {
    const home = pathApi.normalize(this.options.home ?? os.homedir());
    const fold = (value: string) => (pathApi === path.win32 ? value.toLowerCase() : value);
    const relative = pathApi.relative(fold(root), fold(home));
    // home is root itself or inside it
    if (relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative))) return null;
    return root;
  }
}

function shortReason(error: unknown): string {
  if (isGitMissing(error)) return GIT_MISSING;
  const message = error instanceof Error ? error.message : String(error);
  const first = message.split(/\r?\n/).find((line) => line.trim());
  return (first ?? "git 执行失败").slice(0, 200);
}
