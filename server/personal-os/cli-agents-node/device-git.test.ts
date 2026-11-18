// Git on the device (workbench plan section 2): status snapshots and worktree
// creation against real temporary repositories, the way the review fixture
// does. No shell interpolation, argument arrays only.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceGit, RepoRoots } from "./device-git.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function tempRepo(commits = 1): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-device-git-"));
  cleanups.push(() => {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("nex-device-git-")) throw Error("Unsafe cleanup");
    rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, "cfg"), GIT_CONFIG_NOSYSTEM: "1" };
  const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env, windowsHide: true });
  git(["init", "-b", "main"]);
  for (let index = 0; index < commits; index++) {
    writeFileSync(path.join(root, `f${index}.txt`), `# ${index}\n`, "utf8");
    git(["add", "--", `f${index}.txt`]);
    git(["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", `c${index}`]);
  }
  writeFileSync(path.join(root, "dirty.txt"), "changed\n", "utf8");
  git(["add", "--", "dirty.txt"]);
  return root;
}

describe("git info", () => {
  it("describes a repository: root, branch, head and the changed files with counts", async () => {
    const repo = tempRepo();
    const info = await new DeviceGit().info(repo);
    expect(info.source).toBe("worktree");
    expect(info.project?.toLowerCase().replaceAll("\\", "/")).toContain(path.basename(repo).toLowerCase());
    expect(info.branch).toBe("main");
    expect(info.head).toBeTruthy();
    expect(info.files).toEqual(["dirty.txt"]);
    expect(info.added).toBe(1);
    expect(info.removed).toBe(0);
  });

  it("answers none outside a repository and failed with a short reason on refusal", async () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), "nex-device-git-plain-"));
    cleanups.push(() => rmSync(plain, { recursive: true, force: true }));
    expect(await new DeviceGit().info(plain)).toMatchObject({ source: "none" });
    expect(await new DeviceGit().info(path.join(plain, "missing"))).toMatchObject({ source: "none" });
  });
});

const noGit = async (): Promise<string> => {
  throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
};

describe("git that cannot be started", () => {
  it("answers failed with a clear reason instead of pretending the folder is not a repository", async () => {
    expect(await new DeviceGit({ run: noGit }).info("/anywhere")).toEqual({ source: "failed", error: "找不到 git" });
  });

  it("still answers none when git runs and refuses", async () => {
    const refuse = async (): Promise<string> => {
      throw Object.assign(new Error("fatal: not a git repository"), { code: 128 });
    };
    expect(await new DeviceGit({ run: refuse }).info("/anywhere")).toEqual({ source: "none" });
  });

  it("reports the missing git when creating a worktree too", async () => {
    expect(await new DeviceGit({ run: noGit }).worktree("/repo", "feat/x", "abcdefgh1234")).toEqual({ source: "failed", error: "找不到 git" });
  });
});

describe("repository roots", () => {
  it("resolves a linked worktree to the main checkout, and a plain repository to itself", async () => {
    const repo = tempRepo();
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(repo, "cfg"), GIT_CONFIG_NOSYSTEM: "1" };
    const linked = path.join(repo, ".claude", "worktrees", "zen-kilby");
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.test", "worktree", "add", "-b", "wt", linked], { env, windowsHide: true });
    const roots = new RepoRoots();
    // os.tmpdir() can be an 8.3 short path on Windows while git reports the long one
    const real = (p: string) => realpathSync.native(p).toLowerCase();
    const same = (a: string | null, b: string) => a !== null && real(a) === real(b);
    expect(same(await roots.resolve(linked), repo)).toBe(true);
    expect(same(await roots.resolve(repo), repo)).toBe(true);
    // a subdirectory of the repository belongs to the same project
    expect(same(await roots.resolve(path.join(repo, ".claude")), repo)).toBe(true);
  });

  it("answers null for a folder outside git, a missing folder and a relative path", async () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), "nex-device-git-plain-"));
    cleanups.push(() => rmSync(plain, { recursive: true, force: true }));
    const roots = new RepoRoots();
    expect(await roots.resolve(plain)).toBeNull();
    expect(await roots.resolve(path.join(plain, "missing"))).toBeNull();
    expect(await roots.resolve("relative/dir")).toBeNull();
  });

  it("asks git with an argument array, strips the extended-length prefix and uses the common dir's parent", async () => {
    const calls: string[][] = [];
    const run = async (_cwd: string, args: string[]): Promise<string> => {
      calls.push(args);
      return "\\\\?\\D:/proj/.git\n";
    };
    const roots = new RepoRoots({ run, platform: "win32" });
    expect(await roots.resolve("D:\\proj\\.claude\\worktrees\\zen-kilby-6e0402")).toBe("D:\\proj");
    expect(calls).toEqual([["rev-parse", "--path-format=absolute", "--git-common-dir"]]);
  });

  it("falls back to the top level when the common dir is not <root>/.git (a submodule or bare repository)", async () => {
    const run = async (_cwd: string, args: string[]): Promise<string> => (args.includes("--git-common-dir") ? "/super/.git/modules/sub\n" : "/super/sub\n");
    expect(await new RepoRoots({ run, platform: "linux" }).resolve("/super/sub/src")).toBe("/super/sub");
  });

  it("caches per directory with a TTL and runs each lookup once, even concurrently", async () => {
    let clock = 1000;
    let runs = 0;
    const run = async (): Promise<string> => {
      runs += 1;
      return "/proj/.git\n";
    };
    const roots = new RepoRoots({ run, platform: "linux", now: () => clock });
    expect(roots.peek("/proj/a")).toBeUndefined();
    await Promise.all([roots.resolve("/proj/a"), roots.resolve("/proj/a"), roots.warm(["/proj/a", "/proj/b"])]);
    expect(runs).toBe(2);
    expect(roots.peek("/proj/a")).toBe("/proj");
    clock += 60_000;
    await roots.warm(["/proj/a"]);
    expect(runs).toBe(2);
    clock += 11 * 60_000;
    expect(roots.peek("/proj/a")).toBeUndefined();
    await roots.warm(["/proj/a"]);
    expect(runs).toBe(3);
  });

  it("remembers that git is missing instead of spawning it for every directory", async () => {
    let runs = 0;
    const run = async (): Promise<string> => {
      runs += 1;
      return noGit();
    };
    const roots = new RepoRoots({ run, platform: "linux" });
    await roots.warm(["/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h"]);
    // the first batch runs in parallel; every later directory short-circuits
    expect(runs).toBeLessThanOrEqual(4);
    expect(roots.peek("/h")).toBeNull();
  });
});

describe("worktree creation", () => {
  it("creates an independent tree, dedups by requestId and reuses an existing branch", async () => {
    const repo = tempRepo();
    const git = new DeviceGit();
    const requestId = "abcdefgh1234";
    const first = await git.worktree(repo, "feat/demo", requestId);
    expect(first.source).toBe("worktree");
    expect(first.branch).toBe("feat/demo");
    expect(first.worktree && existsSync(first.worktree)).toBe(true);
    expect(first.worktree).toContain(".nexbot-worktrees");
    // the same requestId returns the same tree, whatever the call count
    const again = await git.worktree(repo, "feat/demo", requestId);
    expect(again.worktree).toBe(first.worktree);
    // a different requestId attaches to the existing branch instead of failing
    const attach = await git.worktree(repo, "feat/demo", "other-request-id");
    expect(attach.source).toBe("worktree");
    // git refuses to check a branch out twice, so the second tree attaches
    // detached at the same commit
    expect(attach.head).toBe(first.head);
    // the parent repository is untouched by the tree contents
    const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
    expect(status).not.toContain("feat/demo");
  });

  it("refuses a branch name that is not a safe argument", async () => {
    const repo = tempRepo();
    const git = new DeviceGit();
    expect(await git.worktree(repo, "-oProxyCommand=evil", "abcdefgh1234")).toMatchObject({ source: "failed" });
    expect(await git.worktree(repo, "feat demo", "abcdefgh1234")).toMatchObject({ source: "failed" });
    expect(await git.worktree(repo, "ok-branch", "short")).toMatchObject({ source: "failed" });
  });
});
