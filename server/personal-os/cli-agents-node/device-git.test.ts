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

  it("reports the main checkout as project and the linked worktree path as worktree", async () => {
    const repo = tempRepo();
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(repo, "cfg"), GIT_CONFIG_NOSYSTEM: "1" };
    const linked = path.join(repo, ".claude", "worktrees", "feature-tree");
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.test", "worktree", "add", "-b", "feat/tree", linked], { env, windowsHide: true });
    const info = await new DeviceGit().info(linked);
    const real = (p: string) => realpathSync.native(p).toLowerCase();
    expect(info.source).toBe("worktree");
    expect(info.branch).toBe("feat/tree");
    expect(info.project && real(info.project)).toBe(real(repo));
    expect(info.worktree && real(info.worktree)).toBe(real(linked));
    expect(info.project && info.worktree && real(info.project) !== real(info.worktree)).toBe(true);
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

  it("creates a worktree from an explicit baseBranch and fails if baseBranch does not exist", async () => {
    const repo = tempRepo();
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(repo, "cfg"), GIT_CONFIG_NOSYSTEM: "1" };
    const run = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env, windowsHide: true }).trim();
    run(["checkout", "-b", "release"]);
    writeFileSync(path.join(repo, "rel.txt"), "release\n", "utf8");
    run(["add", "--", "rel.txt"]);
    run(["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "release commit"]);
    const releaseHead = run(["rev-parse", "--short", "HEAD"]);
    run(["checkout", "main"]);
    const mainHead = run(["rev-parse", "--short", "HEAD"]);
    expect(releaseHead).not.toBe(mainHead);

    const git = new DeviceGit();
    const created = await git.worktree(repo, "feat/from-release", "basebranch1", { baseBranch: "release" });
    expect(created.source).toBe("worktree");
    expect(created.branch).toBe("feat/from-release");
    expect(created.head).toBe(releaseHead);
    expect(created.worktree && existsSync(path.join(created.worktree, "rel.txt"))).toBe(true);

    const missing = await git.worktree(repo, "feat/missing-base", "basebranch2", { baseBranch: "no-such-branch" });
    expect(missing).toEqual({ source: "failed", error: "找不到基准分支 no-such-branch" });
  });
});

describe("branch listing and in-place switch", () => {
  it("lists local branches with current first and reports dirty state", async () => {
    const repo = tempRepo();
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(repo, "cfg"), GIT_CONFIG_NOSYSTEM: "1" };
    const run = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env, windowsHide: true });
    run(["branch", "dev"]);
    run(["branch", "feature/a"]);
    const git = new DeviceGit();
    const dirtyInfo = await git.branches(repo);
    expect(dirtyInfo.git).toBe(true);
    expect(dirtyInfo.current).toBe("main");
    expect(dirtyInfo.dirty).toBe(true);
    expect(dirtyInfo.branches[0]).toBe("main");
    expect(dirtyInfo.branches).toEqual(expect.arrayContaining(["main", "dev", "feature/a"]));

    const plain = mkdtempSync(path.join(os.tmpdir(), "nex-device-git-plain-"));
    cleanups.push(() => rmSync(plain, { recursive: true, force: true }));
    expect(await git.branches(plain)).toEqual({ git: false, branches: [] });
  });

  it("blocks switching when dirty, allows staying on current branch, and switches when clean", async () => {
    const repo = tempRepo();
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(repo, "cfg"), GIT_CONFIG_NOSYSTEM: "1" };
    const run = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env, windowsHide: true }).trim();
    run(["branch", "dev"]);
    const git = new DeviceGit();

    // already on main: allowed even when dirty
    expect(await git.switchBranch(repo, "main")).toEqual({ ok: true });
    // switching to another branch while dirty: blocked
    expect(await git.switchBranch(repo, "dev")).toEqual({ ok: false, error: "当前目录有未提交改动，请先提交或改用 Worktree" });

    // commit pending change so working tree is clean
    run(["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "clean"]);
    expect((await git.branches(repo)).dirty).toBeUndefined();
    expect(await git.switchBranch(repo, "missing")).toEqual({ ok: false, error: "找不到本地分支 missing" });
    expect(await git.switchBranch(repo, "dev")).toEqual({ ok: true });
    expect(run(["branch", "--show-current"])).toBe("dev");

    // branch already checked out in another worktree: clear error
    const other = path.join(repo, ".claude", "worktrees", "busy-wt");
    run(["worktree", "add", "-b", "busy", other]);
    const busyResult = await git.switchBranch(repo, "busy");
    expect(busyResult.ok).toBe(false);
    if (!busyResult.ok) expect(busyResult.error).toContain("已在其他工作树中检出");
  });
});
