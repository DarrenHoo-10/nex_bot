// Git on the device (workbench plan section 2): status snapshots and worktree
// creation against real temporary repositories, the way the review fixture
// does. No shell interpolation, argument arrays only.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

  it("reads the files git writes and runs no git: a .git folder, a worktree's gitdir and commondir, a submodule", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "nex-device-git-layout-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const proj = path.join(root, "proj");
    mkdirSync(path.join(proj, ".git", "worktrees", "zen"), { recursive: true });
    writeFileSync(path.join(proj, ".git", "worktrees", "zen", "commondir"), "../..\n");
    const zen = path.join(proj, ".claude", "worktrees", "zen");
    mkdirSync(path.join(zen, "src"), { recursive: true });
    // git writes forward slashes into the gitdir pointer, on Windows too
    writeFileSync(path.join(zen, ".git"), "gitdir: " + path.join(proj, ".git", "worktrees", "zen").replaceAll("\\", "/") + "\n");
    const sub = path.join(root, "super", "sub");
    mkdirSync(path.join(root, "super", ".git", "modules", "sub"), { recursive: true });
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, ".git"), "gitdir: ../.git/modules/sub\n");
    const roots = new RepoRoots({ home: path.join(root, "home") });
    expect(await roots.resolve(path.join(proj, "a", "b"))).toBe(proj);
    expect(await roots.resolve(path.join(zen, "src"))).toBe(proj);
    // a submodule's gitdir has no commondir back to a main checkout: its own folder is the project
    expect(await roots.resolve(sub)).toBe(sub);
  });

  it("strips the extended-length prefix on Windows", async () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(os.tmpdir(), "nex-device-git-long-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, ".git"));
    expect(await new RepoRoots({ platform: "win32", home: String.raw`C:\nowhere` }).resolve("\\\\?\\" + path.join(root, "x"))).toBe(root);
  });

  it("is no project in the home folder or above it", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "nex-device-git-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(path.join(home, ".git"));
    const roots = new RepoRoots({ home });
    expect(await roots.resolve(path.join(home, "Documents"))).toBeNull();
    expect(await new RepoRoots({ home: path.join(home, "inner") }).resolve(home)).toBeNull();
  });

  it("caches per directory: a hit for 10 minutes, a miss for 2", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "nex-device-git-cache-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    let clock = 1000;
    const roots = new RepoRoots({ home: path.join(root, "home"), now: () => clock });
    const plain = path.join(root, "plain");
    mkdirSync(plain);
    expect(roots.peek(plain)).toBeUndefined();
    await roots.warm([plain, plain]);
    expect(roots.peek(plain)).toBeNull();
    mkdirSync(path.join(plain, ".git"));
    clock += 60_000;
    expect(roots.peek(plain)).toBeNull();
    clock += 2 * 60_000;
    expect(roots.peek(plain)).toBeUndefined();
    await roots.warm([plain]);
    expect(roots.peek(plain)).toBe(plain);
    clock += 9 * 60_000;
    expect(roots.peek(plain)).toBe(plain);
    clock += 2 * 60_000;
    expect(roots.peek(plain)).toBeUndefined();
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
