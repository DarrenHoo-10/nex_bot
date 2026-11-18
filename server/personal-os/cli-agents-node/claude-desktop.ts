// What the Claude desktop app itself knows about its Code sessions. Besides the
// CLI transcripts under `<configDir>/projects`, the app keeps one small file per
// session at `<appData>/<Claude|Claude-3p>/claude-code-sessions/<account>/<org>/local_<cliSessionId>.json`
// with the user's own state: `isArchived` (the sidebar's archive) and
// `forkedFromSessionId` (the session a "side chat"/fork was made from). Both are
// the app's truth, so discovery prefers them over guessing from transcripts.
//
// Read-only: nothing here writes, and only those two fields (plus the ids that
// tie a file to its CLI session) are looked at. Files are re-read only when
// their (size, mtime) changed.
import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isCliNativeId } from "../../../shared/cli-agents.ts";

const FILE_MAX_BYTES = 256 * 1024;
const MAX_FILES = 2000;
const DIR_PARALLEL = 8;

export interface DesktopSessionState {
  archived: boolean;
  /** CLI session id of the session this one was forked from, when the app recorded it */
  forkedFrom?: string;
}

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

interface CachedFile {
  size: number;
  mtimeMs: number;
  /** null: unreadable or not a session file */
  state: { cliId: string; localId: string; archived: boolean; parentLocalId?: string } | null;
}

/** `local_<uuid>` to the uuid; the app names its session ids that way. */
function stripLocal(id: string): string | undefined {
  const bare = id.startsWith("local_") ? id.slice(6) : id;
  return isCliNativeId(bare) ? bare : undefined;
}

export class ClaudeDesktopSessions {
  private readonly files = new Map<string, CachedFile>();

  constructor(private readonly roots: readonly string[]) {}

  /** The state of every Code session the app knows, by CLI session id. Never throws. */
  async scan(): Promise<Map<string, DesktopSessionState>> {
    const present = new Set<string>();
    const found: CachedFile["state"][] = [];
    for (const root of this.roots) {
      let list: string[];
      try {
        list = await sessionFiles(path.join(root, "claude-code-sessions"));
      } catch {
        continue;
      }
      for (let i = 0; i < list.length && present.size < MAX_FILES; i += DIR_PARALLEL) {
        const batch = await Promise.all(list.slice(i, i + DIR_PARALLEL).map((file) => this.read(file)));
        for (let j = 0; j < batch.length; j++) {
          present.add(list[i + j]);
          if (batch[j]) found.push(batch[j]);
        }
      }
    }
    for (const key of this.files.keys()) if (!present.has(key)) this.files.delete(key);
    const byLocal = new Map<string, string>();
    for (const entry of found) if (entry) byLocal.set(entry.localId, entry.cliId);
    const out = new Map<string, DesktopSessionState>();
    for (const entry of found) {
      if (!entry) continue;
      const state: DesktopSessionState = { archived: entry.archived };
      if (entry.parentLocalId) {
        const parent = byLocal.get(entry.parentLocalId) ?? stripLocal(entry.parentLocalId);
        if (parent && parent !== entry.cliId) state.forkedFrom = parent;
      }
      out.set(entry.cliId, state);
    }
    return out;
  }

  private async read(file: string): Promise<CachedFile["state"]> {
    let info;
    try {
      info = await stat(file);
    } catch {
      return null;
    }
    if (!info.isFile() || info.size > FILE_MAX_BYTES) return null;
    const cached = this.files.get(file);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.state;
    let state: CachedFile["state"] = null;
    try {
      const handle = await open(file, "r");
      try {
        const buf = Buffer.alloc(info.size);
        const { bytesRead } = await handle.read(buf, 0, info.size, 0);
        state = parse(buf.toString("utf8", 0, bytesRead));
      } finally {
        await handle.close().catch(() => {});
      }
    } catch {
      state = null;
    }
    this.files.set(file, { size: info.size, mtimeMs: info.mtimeMs, state });
    return state;
  }
}

function parse(raw: string): CachedFile["state"] {
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
  const parent = typeof rec.forkedFromSessionId === "string" && rec.forkedFromSessionId ? rec.forkedFromSessionId : undefined;
  return { cliId, localId, archived: rec.isArchived === true, ...(parent ? { parentLocalId: parent } : {}) };
}

/** `<store>/<account>/<org>/local_*.json`, two levels down. */
async function sessionFiles(store: string): Promise<string[]> {
  const out: string[] = [];
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
      for (const name of names) if (/^local_[A-Za-z0-9._=-]+\.json$/.test(name)) out.push(path.join(dir, name));
    }
  }
  return out;
}
