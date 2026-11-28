// What the Claude desktop app itself knows about its Code sessions: the index
// behind its sidebar. Besides the CLI transcripts under `<configDir>/projects`,
// the app keeps one small file per session at
// `<appData>/<Claude|Claude-3p>/claude-code-sessions/<account>/<org>/local_<uuid>.json`.
// The list follows that sidebar (the same rules as nwverse/persona's
// `node/claudedesktop.go`, measured on the same app):
//
// - `cliSessionId` is the transcript the session runs now; `priorCliSessionIds`
//   are the transcripts it ran before (a resume or a rewind went on in a new
//   one). One sidebar session is one row: an earlier transcript is left out once
//   the one it runs now is listed and is not older than it.
// - `isArchived`: the sidebar's archive. Its transcripts, current and earlier,
//   leave the list unless a process runs them.
// - A session deleted in the app leaves its transcript behind. The app writes
//   `deleted_<uuid>` markers for it, and no entry names its transcripts any more:
//   a transcript the desktop app ran (`entrypoint` `claude-desktop…`) that no
//   readable entry names and nothing unreadable mentions is a deleted session's,
//   after a grace period (the app may not have written a new session's entry yet).
// - Lineage: `spawnedFrom.sessionId` (a side question, a task another session
//   started, a fork made with the app's Fork), else `forkedFromSessionId`.
//   `lineageDetached` (moved to the sidebar's top level) means no parent. A /btw
//   question (`spawnedFrom.btw`) is a side chat of its parent; the rest are
//   children in the tree.
//
// Read-only: only these session files are read, never the app's config file
// (it holds credentials). A file is parsed again only when its (size, mtime)
// changed.
import { open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isCliNativeId } from "../../../shared/cli-agents.ts";

const FILE_MAX_BYTES = 4 * 1024 * 1024;
/** how much of an unreadable entry is searched for the session ids it mentions */
const MENTION_BYTES = 64 * 1024;
const MAX_FILES = 2000;
const DIR_PARALLEL = 8;
/** how long a desktop transcript may go without an entry naming it before it counts as deleted */
export const DESKTOP_ENTRY_GRACE_MS = 2 * 60_000;
/** unarchived sessions listed whatever their age, newest first */
export const DESKTOP_ALWAYS_LISTED = 100;

/** One sidebar session, keyed by the transcript it runs now. */
export interface DesktopSessionState {
  archived: boolean;
  /** CLI session id of the session this one was spawned or forked from, when the app recorded it */
  parent?: string;
  /** a /btw question: a side chat of `parent`, not a row of its own */
  side?: boolean;
  /** the sidebar's title and folder, for a transcript that has none yet */
  title?: string;
  cwd?: string;
  /** the folder the session was started in (a worktree's main checkout) */
  originCwd?: string;
  lastActivityAt?: number;
  /** the model the app runs the session with, `[1m]` included (the transcript drops the suffix) */
  model?: string;
}

export interface DesktopIndex {
  /** readable entries; with none, nothing is taken for deleted */
  readable: number;
  /** by the CLI session id each session runs now */
  sessions: ReadonlyMap<string, DesktopSessionState>;
  /** an earlier transcript's id to the id its session runs now */
  priorOf: ReadonlyMap<string, string>;
  /** ids an unreadable entry mentions: never taken for deleted */
  mentioned: ReadonlySet<string>;
  /** ids the app's `deleted_<uuid>` markers name */
  deleted: ReadonlySet<string>;
}

export const EMPTY_DESKTOP_INDEX: DesktopIndex = { readable: 0, sessions: new Map(), priorOf: new Map(), mentioned: new Set(), deleted: new Set() };

/** App-data folders that can hold `claude-desktop`'s session store: the stock
 * app and the third-party build (`Claude-3p`), on the platform's usual roots. */
export function claudeDesktopRoots(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string[] {
  const names = ["Claude", "Claude-3p"];
  const bases: string[] = [];
  if (platform === "win32") {
    for (const base of [env.APPDATA, env.LOCALAPPDATA]) if (base) bases.push(base);
  } else if (platform === "darwin") {
    bases.push(path.posix.join(home, "Library", "Application Support"));
  } else {
    bases.push(env.XDG_CONFIG_HOME || path.posix.join(home, ".config"));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const base of bases) {
    for (const name of names) {
      const dir = platform === "win32" ? path.win32.join(base, name) : path.posix.join(base, name);
      const key = platform === "win32" ? dir.toLowerCase() : dir;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(dir);
      }
    }
  }
  return out;
}

type Rec = Record<string, unknown>;

interface Entry {
  cliId: string;
  localId: string;
  archived: boolean;
  prior: string[];
  parentLocalId?: string;
  btw?: boolean;
  title?: string;
  cwd?: string;
  originCwd?: string;
  lastActivityAt?: number;
  model?: string;
}

type Parsed = { entry: Entry } | { mentions: string[] } | null;

interface CachedFile {
  size: number;
  mtimeMs: number;
  parsed: Parsed;
}

/** `local_<uuid>` to the uuid; the app names its session ids that way. */
function stripLocal(id: string): string | undefined {
  const bare = id.startsWith("local_") ? id.slice(6) : id;
  return isCliNativeId(bare) ? bare : undefined;
}

export class ClaudeDesktopSessions {
  private readonly files = new Map<string, CachedFile>();

  constructor(private readonly roots: readonly string[]) {}

  /** The app's index as it stands. Never throws. */
  async scan(): Promise<DesktopIndex> {
    const present = new Set<string>();
    const parsed: Parsed[] = [];
    const deleted = new Set<string>();
    for (const root of this.roots) {
      let listing: { sessions: string[]; deleted: string[] };
      try {
        listing = await sessionFiles(path.join(root, "claude-code-sessions"));
      } catch {
        continue;
      }
      for (const id of listing.deleted) deleted.add(id);
      const list = listing.sessions;
      for (let i = 0; i < list.length && present.size < MAX_FILES; i += DIR_PARALLEL) {
        const batch = await Promise.all(list.slice(i, i + DIR_PARALLEL).map((file) => this.read(file)));
        for (let j = 0; j < batch.length; j++) {
          present.add(list[i + j]);
          parsed.push(batch[j]);
        }
      }
    }
    for (const key of this.files.keys()) if (!present.has(key)) this.files.delete(key);
    return buildIndex(parsed, deleted);
  }

  private async read(file: string): Promise<Parsed> {
    let info;
    try {
      info = await stat(file);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;
    const cached = this.files.get(file);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.parsed;
    let result: Parsed = null;
    try {
      const handle = await open(file, "r");
      try {
        // an entry too big to trust is only searched for the ids it mentions
        const length = info.size > FILE_MAX_BYTES ? MENTION_BYTES : info.size;
        const buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, 0);
        const raw = buf.toString("utf8", 0, bytesRead);
        result = (info.size > FILE_MAX_BYTES ? null : parseEntry(raw)) ?? { mentions: mentionedIds(raw.slice(0, MENTION_BYTES)) };
      } finally {
        await handle.close().catch(() => {});
      }
    } catch {
      result = null;
    }
    this.files.set(file, { size: info.size, mtimeMs: info.mtimeMs, parsed: result });
    return result;
  }
}

/** Builds the index from parsed entries (exported for tests). */
export function buildIndex(parsed: readonly Parsed[], deleted: ReadonlySet<string> = new Set()): DesktopIndex {
  const entries: Entry[] = [];
  const mentioned = new Set<string>();
  for (const p of parsed) {
    if (!p) continue;
    if ("entry" in p) entries.push(p.entry);
    else for (const id of p.mentions) mentioned.add(id);
  }
  const byLocal = new Map<string, string>();
  for (const e of entries) byLocal.set(e.localId, e.cliId);
  const sessions = new Map<string, DesktopSessionState>();
  const priorOf = new Map<string, string>();
  for (const e of entries) {
    const state: DesktopSessionState = { archived: e.archived };
    if (e.parentLocalId) {
      const parent = byLocal.get(e.parentLocalId) ?? stripLocal(e.parentLocalId);
      if (parent && parent !== e.cliId) {
        state.parent = parent;
        if (e.btw) state.side = true;
      }
    }
    if (e.title) state.title = e.title;
    if (e.cwd) state.cwd = e.cwd;
    if (e.originCwd) state.originCwd = e.originCwd;
    if (e.lastActivityAt !== undefined) state.lastActivityAt = e.lastActivityAt;
    if (e.model) state.model = e.model;
    // two entries naming one transcript: the unarchived one wins
    const existing = sessions.get(e.cliId);
    if (!existing || (existing.archived && !e.archived)) sessions.set(e.cliId, state);
    for (const id of e.prior) if (id !== e.cliId && !priorOf.has(id)) priorOf.set(id, e.cliId);
  }
  return { readable: entries.length, sessions, priorOf, mentioned, deleted };
}

function parseEntry(raw: string): Parsed {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const rec = o as Rec;
  const cliId = typeof rec.cliSessionId === "string" && isCliNativeId(rec.cliSessionId) ? rec.cliSessionId : undefined;
  if (!cliId) return null;
  const localId = typeof rec.sessionId === "string" && rec.sessionId ? rec.sessionId : `local_${cliId}`;
  const prior = Array.isArray(rec.priorCliSessionIds) ? rec.priorCliSessionIds.filter((id): id is string => typeof id === "string" && isCliNativeId(id)) : [];
  const entry: Entry = { cliId, localId, archived: rec.isArchived === true, prior };
  // moved to the sidebar's top level: the old lineage stays in the file, unnested
  if (rec.lineageDetached !== true) {
    const spawned = rec.spawnedFrom && typeof rec.spawnedFrom === "object" && !Array.isArray(rec.spawnedFrom) ? (rec.spawnedFrom as Rec) : undefined;
    const spawnedFrom = typeof spawned?.sessionId === "string" && spawned.sessionId ? spawned.sessionId : undefined;
    const forkedFrom = typeof rec.forkedFromSessionId === "string" && rec.forkedFromSessionId ? rec.forkedFromSessionId : undefined;
    const parent = spawnedFrom ?? forkedFrom;
    if (parent) {
      entry.parentLocalId = parent;
      if (spawnedFrom && spawned?.btw === true) entry.btw = true;
    }
  }
  if (typeof rec.title === "string" && rec.title.trim()) entry.title = rec.title.trim();
  if (typeof rec.cwd === "string" && rec.cwd) entry.cwd = rec.cwd;
  if (typeof rec.originCwd === "string" && rec.originCwd) entry.originCwd = rec.originCwd;
  if (typeof rec.lastActivityAt === "number" && Number.isFinite(rec.lastActivityAt)) entry.lastActivityAt = rec.lastActivityAt;
  if (typeof rec.model === "string" && rec.model.trim()) entry.model = rec.model.trim().slice(0, 200);
  return { entry };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Session ids an entry that cannot be read mentions (cut short while the app
 * wrote it, too big, another shape): none of them may be taken for deleted. */
export function mentionedIds(raw: string): string[] {
  return [...new Set((raw.match(UUID) ?? []).map((id) => id.toLowerCase()))];
}

/** Whether the list leaves out transcript `id`, as the app's sidebar does.
 * `listed` holds the ids the list shows otherwise (to keep an earlier transcript
 * whose session's current one is missing); a running session is never left out. */
export function desktopHides(
  index: DesktopIndex,
  id: string,
  facts: { entrypoint?: string; mtimeMs: number; running: boolean; now: number; listed: ReadonlySet<string>; mtimeOf(id: string): number | undefined },
): "archived" | "earlier" | "deleted" | null {
  if (facts.running) return null;
  const own = index.sessions.get(id);
  if (own) return own.archived ? "archived" : null;
  const current = index.priorOf.get(id);
  if (current !== undefined) {
    const session = index.sessions.get(current);
    if (session?.archived) return "archived";
    // at worst a session shows twice, never not at all
    if (!facts.listed.has(current)) return null;
    const currentMtime = facts.mtimeOf(current);
    if (currentMtime !== undefined && facts.mtimeMs > currentMtime) return null;
    return "earlier";
  }
  // only a transcript the desktop app ran is judged by its index
  if (!facts.entrypoint?.startsWith("claude-desktop")) return null;
  const lower = id.toLowerCase();
  if (index.mentioned.has(lower)) return null;
  if (index.deleted.has(lower)) return "deleted";
  if (index.readable > 0 && facts.now - facts.mtimeMs > DESKTOP_ENTRY_GRACE_MS) return "deleted";
  return null;
}

/** The transcripts the unarchived sidebar sessions run, newest first: listed whatever their age. */
export function desktopAlwaysListed(index: DesktopIndex, limit = DESKTOP_ALWAYS_LISTED): string[] {
  return [...index.sessions.entries()]
    .filter(([, s]) => !s.archived)
    .sort((a, b) => (b[1].lastActivityAt ?? 0) - (a[1].lastActivityAt ?? 0))
    .slice(0, limit)
    .map(([id]) => id);
}

/** `<store>/<account>/<org>/local_*.json` and `deleted_<uuid>` markers, two levels down. */
async function sessionFiles(store: string): Promise<{ sessions: string[]; deleted: string[] }> {
  const sessions: string[] = [];
  const deleted: string[] = [];
  for (const account of await readdir(store, { withFileTypes: true })) {
    if (!account.isDirectory()) continue;
    let orgs;
    try {
      orgs = await readdir(path.join(store, account.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const org of orgs) {
      if (!org.isDirectory()) continue;
      const dir = path.join(store, account.name, org.name);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (/^local_[A-Za-z0-9._=-]+\.json$/.test(name)) sessions.push(path.join(dir, name));
        else if (name.startsWith("deleted_")) {
          const id = name.slice(8).replace(/^local_/, "").toLowerCase();
          if (isCliNativeId(id)) deleted.push(id);
        }
      }
    }
  }
  return { sessions, deleted };
}

/** Finds all Claude Desktop `local_*.json` entry files whose `cliSessionId` matches `cliSessionId`. */
async function findDesktopEntries(roots: readonly string[], cliSessionId: string): Promise<Array<{ file: string; raw: Rec }>> {
  const matches: Array<{ file: string; raw: Rec }> = [];
  for (const root of roots) {
    let listing: { sessions: string[]; deleted: string[] };
    try {
      listing = await sessionFiles(path.join(root, "claude-code-sessions"));
    } catch {
      continue;
    }
    for (const file of listing.sessions) {
      try {
        const text = await readFile(file, "utf8");
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const rec = parsed as Rec;
        if (rec.cliSessionId === cliSessionId) matches.push({ file, raw: rec });
      } catch {
        // unreadable entry
      }
    }
  }
  return matches;
}

/** Updates `isArchived` on matching Claude Desktop sidebar entries. Returns true if any entry existed. */
export async function setClaudeDesktopArchived(roots: readonly string[], cliSessionId: string, archived: boolean): Promise<boolean> {
  const entries = await findDesktopEntries(roots, cliSessionId);
  if (!entries.length) return false;
  for (const { file, raw } of entries) {
    const next = { ...raw, isArchived: archived };
    const tmp = `${file}.nexbot-${process.pid}-${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
    await rename(tmp, file);
  }
  return true;
}

/** Deletes matching Claude Desktop sidebar entries and writes `deleted_<id>` markers so the app never resurrects them. */
export async function deleteClaudeDesktopEntries(roots: readonly string[], cliSessionId: string): Promise<boolean> {
  const entries = await findDesktopEntries(roots, cliSessionId);
  if (!entries.length) return false;
  for (const { file, raw } of entries) {
    const dir = path.dirname(file);
    const localId = typeof raw.sessionId === "string" && raw.sessionId ? raw.sessionId : `local_${cliSessionId}`;
    await writeFile(path.join(dir, `deleted_${cliSessionId}`), "", "utf8").catch(() => {});
    if (localId !== `local_${cliSessionId}`) {
      await writeFile(path.join(dir, `deleted_${localId.replace(/^local_/, "")}`), "", "utf8").catch(() => {});
    }
    await rm(file, { force: true });
  }
  return true;
}
