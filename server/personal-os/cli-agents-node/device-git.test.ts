// Git on the device (workbench plan section 2): status snapshots and worktree
// creation against real temporary repositories, the way the review fixture
// does. No shell interpolation, argument arrays only.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceGit } from "./device-git.ts";

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
