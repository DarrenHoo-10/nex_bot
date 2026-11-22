// Folders on one of the user's computers, for the new-session directory picker. The picker only
// knows this interface: the preview feeds it a mock tree, production will read the computer.
import { listDirs } from "./api";

export interface DirEntry { name: string; path: string; git?: boolean }

export interface DirListing {
  /** the folder listed; for the roots view, "" */
  path: string;
  /** one level up; null at a drive or `/` (and for the roots view) */
  parent: string | null;
  exists: boolean;
  /** the folder itself is a Git repository */
  git?: boolean;
  entries: DirEntry[];
}

export interface DirectorySource {
  /** "" lists the roots (drives and the home folder) */
  list(path: string): Promise<DirListing>;
}

const isWindows = (path: string) => /^[A-Za-z]:([\\/]|$)/.test(path) || path.startsWith("\\\\");
export const pathSep = (path: string) => (isWindows(path) ? "\\" : "/");

/** Drive paths keep their trailing separator (`D:\`); anything else loses it. */
export function cleanPath(path: string): string {
  const trimmed = path.trim();
  if (/^[A-Za-z]:[\\/]?$/.test(trimmed)) return trimmed.slice(0, 2) + "\\";
  if (trimmed === "/") return "/";
  return trimmed.replace(/[\\/]+$/, "");
}

export function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path) || path.startsWith("/") || path.startsWith("\\\\");
}

export function parentPath(path: string): string | null {
  const clean = cleanPath(path);
  if (/^[A-Za-z]:\\$/.test(clean) || clean === "/" || !clean) return null;
  const at = Math.max(clean.lastIndexOf("\\"), clean.lastIndexOf("/"));
  if (at < 0) return null;
  const up = clean.slice(0, at);
  if (/^[A-Za-z]:$/.test(up)) return up + "\\";
  return up || "/";
}

export function joinPath(base: string, name: string): string {
  const clean = cleanPath(base);
  const sep = pathSep(clean);
  return (clean.endsWith(sep) ? clean : clean + sep) + name.replace(/^[\\/]+|[\\/]+$/g, "").replace(/[\\/]+/g, sep);
}

export function baseName(path: string): string {
  const clean = cleanPath(path);
  if (/^[A-Za-z]:\\$/.test(clean) || clean === "/") return clean;
  return clean.split(/[\\/]/).filter(Boolean).pop() ?? clean;
}

/** What the picker's text box means: a filter on the current folder, or a path to go to (absolute, or below the current folder). */
export function readQuery(query: string, current: string): { kind: "filter"; text: string } | { kind: "path"; path: string } {
  const text = query.trim();
  if (!text) return { kind: "filter", text: "" };
  if (isAbsolutePath(text)) return { kind: "path", path: cleanPath(text) };
  if (/[\\/]/.test(text) && current) return { kind: "path", path: joinPath(current, text) };
  return { kind: "filter", text };
}

/** A folder name a computer accepts: no separators, reserved characters or trailing dot or space. */
export function validFolderName(name: string): boolean {
  return !!name && name.length <= 120 && !/[<>:"|?*\\/]/.test(name) && ![...name].some((ch) => ch.charCodeAt(0) < 32) && !/[. ]$/.test(name);
}

/** An in-memory tree, for the preview and tests. Keys are absolute paths, values their sub-folders. */
export function mockDirectorySource(tree: Record<string, readonly string[]>, options: { roots: readonly string[]; git?: readonly string[]; delayMs?: number }): DirectorySource {
  const norm = (path: string) => cleanPath(path).toLowerCase();
  const byPath = new Map(Object.entries(tree).map(([path, children]) => [norm(path), { path: cleanPath(path), children }]));
  const git = new Set((options.git ?? []).map(norm));
  return {
    async list(path) {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (!path) return { path: "", parent: null, exists: true, entries: options.roots.map((root) => ({ name: root, path: cleanPath(root), git: git.has(norm(root)) })) };
      const found = byPath.get(norm(path));
      if (!found) return { path: cleanPath(path), parent: parentPath(path), exists: false, entries: [] };
      return {
        path: found.path,
        parent: parentPath(found.path),
        exists: true,
        git: git.has(norm(found.path)),
        entries: [...found.children].sort((a, b) => a.localeCompare(b, "zh-CN")).map((name) => {
          const child = joinPath(found.path, name);
          return { name, path: child, git: git.has(norm(child)) };
        }),
      };
    },
  };
}

/** A computer's folders through Core. An executor without `dirs` lists nothing and takes any typed path as it is. */
export function apiDirectorySource(deviceId: string, features: () => readonly string[] | undefined): DirectorySource {
  return {
    async list(path) {
      if (!features()?.includes("dirs")) return { path, parent: path ? parentPath(path) : null, exists: true, entries: [] };
      const listing = await listDirs(deviceId, path);
      return { path: listing.path, parent: listing.parent ?? null, exists: listing.exists, ...(listing.git ? { git: true } : {}), entries: listing.entries };
    },
  };
}
