// A computer's folders for the new-session picker: the sub-folders of one folder, or the roots (drives on
// Windows, `/` elsewhere, and the home folder). Only names and whether each is a Git repository go back.
import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CLI_DIR_LIMIT, type CliDirListing } from "../../../shared/cli-agents.ts";

export interface DirOptions { platform?: NodeJS.Platform; homedir?: string }

const api = (platform: NodeJS.Platform) => (platform === "win32" ? path.win32 : path.posix);

function isGit(dir: string): boolean {
  // a checkout has a .git folder, a linked worktree a .git file
  return existsSync(path.join(dir, ".git"));
}

function parentOf(dir: string, platform: NodeJS.Platform): string | undefined {
  const p = api(platform);
  const up = p.dirname(dir);
  return up && up !== dir ? up : undefined;
}

export async function listDirs(target: string, options: DirOptions = {}): Promise<CliDirListing> {
  const platform = options.platform ?? process.platform;
  const p = api(platform);
  if (!target) {
    const home = options.homedir ?? os.homedir();
    const roots = platform === "win32"
      ? [..."CDEFGHIJKLMNOPQRSTUVWXYZ"].map((letter) => `${letter}:\\`).filter((drive) => existsSync(drive))
      : ["/"];
    const all = [...new Set([...roots, home])];
    return { path: "", exists: true, entries: all.map((dir) => ({ name: dir, path: dir, ...(isGit(dir) ? { git: true } : {}) })) };
  }
  const dir = p.resolve(target);
  const parent = parentOf(dir, platform);
  let names: string[];
  try {
    if (!(await stat(dir)).isDirectory()) return { path: dir, ...(parent ? { parent } : {}), exists: false, entries: [] };
    // a repository's own .git folder is never where a session runs
    names = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== ".git").map((entry) => entry.name);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { path: dir, ...(parent ? { parent } : {}), exists: false, entries: [] };
    throw error;
  }
  names.sort((a, b) => a.localeCompare(b, "zh-CN", { sensitivity: "base" }));
  const shown = names.slice(0, CLI_DIR_LIMIT);
  return {
    path: dir,
    ...(parent ? { parent } : {}),
    exists: true,
    ...(isGit(dir) ? { git: true } : {}),
    entries: shown.map((name) => { const child = p.join(dir, name); return { name, path: child, ...(isGit(child) ? { git: true } : {}) }; }),
    ...(names.length > shown.length ? { more: true } : {}),
  };
}

/** Makes `dir` and its missing parents; an existing folder is fine, a file in the way is not. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (!(await stat(dir)).isDirectory()) throw new Error("not a folder");
}
