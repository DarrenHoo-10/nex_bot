import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliDirListing } from "../../../shared/cli-agents.ts";
import { ensureDir, listDirs } from "./dirs.ts";

const dirs: string[] = [];
function tree(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "cli-dirs-"));
  dirs.push(root);
  for (const sub of ["beta", "Alpha/.git", "Alpha/src", "worktree"]) mkdirSync(path.join(root, sub), { recursive: true });
  writeFileSync(path.join(root, "worktree", ".git"), "gitdir: elsewhere\n");
  writeFileSync(path.join(root, "notes.txt"), "a file, not a folder");
  return root;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("a computer's folders", () => {
  it("lists sub-folders by name, marks Git checkouts and linked worktrees, and leaves files out", async () => {
    const root = tree();
    const listing = await listDirs(root);
    expect(listing.exists).toBe(true);
    expect(listing.parent).toBe(path.dirname(root));
    expect(listing.entries.map((entry) => [entry.name, !!entry.git])).toEqual([["Alpha", true], ["beta", false], ["worktree", true]]);
    expect(listing.entries[0].path).toBe(path.join(root, "Alpha"));
    // what Core and the page accept back
    expect(parseCliDirListing(listing)).toEqual(listing);
    expect((await listDirs(path.join(root, "Alpha"))).git).toBe(true);
  });

  it("says a missing folder does not exist instead of failing", async () => {
    const root = tree();
    const missing = await listDirs(path.join(root, "nope", "deeper"));
    expect(missing).toMatchObject({ exists: false, entries: [], parent: path.join(root, "nope") });
    expect((await listDirs(path.join(root, "notes.txt"))).exists).toBe(false);
  });

  it("lists the roots with the home folder", async () => {
    const home = tree();
    const roots = await listDirs("", { homedir: home });
    expect(roots.path).toBe("");
    expect(roots.entries.some((entry) => entry.path === home)).toBe(true);
    expect(roots.entries.length).toBeGreaterThan(1);
  });

  it("creates a missing folder with its parents, and refuses a file in the way", async () => {
    const root = tree();
    const target = path.join(root, "new", "project");
    await ensureDir(target);
    expect(existsSync(target) && statSync(target).isDirectory()).toBe(true);
    await ensureDir(target);
    await expect(ensureDir(path.join(root, "notes.txt"))).rejects.toThrow();
  });
});
