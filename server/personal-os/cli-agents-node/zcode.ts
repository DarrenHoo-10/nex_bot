// ZCode harness adapter (workbench plan section 2, P4). ZCode keeps its
// sessions in one SQLite database at `~/.zcode/cli/db/db.sqlite` (tables
// `session`, `message`, `part`, `session_runtime_presence`), so the scanner
// reads it the way the Codex adapter reads the App database: opened
// read-only, nothing written, a database that cannot be read yields no rows.
// The live process list in `session_runtime_presence` says which sessions a
// running Host still has attached; a live pid turns into `running`, otherwise
// the row is `idle`.
//
// Writing to a session goes through a host channel the device provides. The
// wire protocol of the installed Host is a product contract that still needs
// the live verification P0 asks for (docs/verification/), so the channel is
// injectable: without one the sessions report read-only, with one they report
// `sendVia: "host"` and send, steer and interrupt route through it. No part
// of this file starts a process.
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CLI_LIMITS,
  HISTORY_DAYS,
  ITEM_TEXT_MAX,
  MAX_SESSIONS,
  PAGE_SIZE,
  type CliEngine,
  type CliItem,
  type CliSessionState,
} from "../../../shared/cli-agents.ts";
import { buildAssistantItem, buildUserItem, clipUnits, imageLocator, itemHasImage, localImageLinks, type ItemContext, type TranscriptImage, type LocalSession } from "./items.ts";

const DAY_MS = 86_400_000;
const POLL_MS = 30_000;

export interface ZcodeHostChannel {
  /** Puts one message into a live session (a new turn or guidance). */
  submit(sessionId: string, text: string, options?: { steer?: boolean }): Promise<{ accepted: boolean }>;
  /** Stops the session's current turn. */
  interrupt(sessionId: string): Promise<{ outcome: string }>;
}

export interface ZcodeScannerOptions {
  /** which pids are alive; defaults to a signal-0 probe */
  pidAlive?: (pid: number) => boolean;
  /** the host channel, when this device has one */
  host?: ZcodeHostChannel;
  now?: () => number;
  /** raw database open override for tests */
  open?: (file: string) => DatabaseSync;
}

export interface ZcodeSessionRow {
  id: string;
  directory: string;
  title: string;
  version: string | null;
  timeUpdated: number;
  timeCreated: number;
  archived: boolean;
  running: boolean;
  parentId: string | null;
}

export interface ZcodePage {
  items: CliItem[];
  more: boolean;
}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (value: unknown, max: number): string => (typeof value === "string" ? clipUnits(value, max) : "");

/** The default home, like claudeConfigDirs(): `~/.zcode/cli`. */
export function zcodeHomes(homedir?: string): string[] {
  const home = homedir ?? process.env.USERPROFILE ?? process.env.HOME;
  if (!home) return [];
  const dir = path.join(home, ".zcode", "cli");
  return existsSync(dir) ? [dir] : [];
}

/** A cheap liveness probe the way Node does it elsewhere: signal 0 throws when
 * the pid is gone, works on Windows for processes of the same user. */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One read-only handle over `db.sqlite`, with a small cache so the scanners'
 * 2 s and 15 s rounds do not re-read every row. */
export class ZcodeDb {
  private db: DatabaseSync | null = null;
  private openedAt = 0;
  private readonly options: ZcodeScannerOptions;

  constructor(
    readonly home: string,
    options: ZcodeScannerOptions = {},
  ) {
    this.options = options;
  }

  private file(): string {
    return path.join(this.home, "db.sqlite");
  }

  private open(): DatabaseSync | null {
    if (this.db && Date.now() - this.openedAt < POLL_MS) return this.db;
    this.db?.close();
    this.db = null;
    const file = this.file();
    if (!existsSync(file)) return null;
    try {
      this.db = this.options.open ? this.options.open(file) : new DatabaseSync(file, { readOnly: true });
      this.openedAt = Date.now();
      return this.db;
    } catch {
      return null;
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // already closed
    }
    this.db = null;
  }

  /** Every session worth reporting, newest first. Archived and deleted rows
   * are left out; a live pid makes the row `running`, everything else `idle`. */
  scan(): ZcodeSessionRow[] {
    const db = this.open();
    if (!db) return [];
    const alive = this.options.pidAlive ?? pidAlive;
    try {
      const presence = new Map<string, boolean>();
      for (const row of db.prepare("SELECT session_id, process_id FROM session_runtime_presence").all() as Array<Rec>) {
        const session = str(row.session_id, 200);
        if (!session) continue;
        presence.set(session, presence.get(session) === true || alive(Number(row.process_id)));
      }
      const rows = db
        .prepare(
          `SELECT id, directory, title, version, time_created, time_updated, time_archived, time_deleted, parent_id
           FROM session WHERE time_deleted IS NULL AND time_archived IS NULL ORDER BY time_updated DESC LIMIT ?`,
        )
        .all(MAX_SESSIONS) as Array<Rec>;
      return rows
        .map((row) => {
          const id = str(row.id, 200);
          const timeUpdated = Number(row.time_updated);
          if (!id || !Number.isSafeInteger(timeUpdated)) return null;
          return {
            id,
            directory: str(row.directory, CLI_LIMITS.cwd),
            title: str(row.title, CLI_LIMITS.title),
            version: row.version === null || row.version === undefined ? null : str(row.version, CLI_LIMITS.cliVersion),
            timeCreated: Number(row.time_created) || timeUpdated,
            timeUpdated,
            archived: row.time_archived !== null && row.time_archived !== undefined,
            running: presence.get(id) === true,
            parentId: row.parent_id === null || row.parent_id === undefined ? null : str(row.parent_id, 200),
          } satisfies ZcodeSessionRow;
        })
        .filter((row): row is ZcodeSessionRow => row !== null);
    } catch {
      return [];
    }
  }

  /** One transcript page, oldest last. `before` is the item id the page ends
   * right before, like the file readers' paging: the newest `limit` items
   * strictly older than it, and `more` when even older ones exist. Messages
   * that carry no chat text (model-only context, environment snapshots) are
   * skipped; the walk stops once one item past the page exists. */
  async page(sessionId: string, options: { before?: string; limit?: number } = {}): Promise<ZcodePage> {
    const limit = Math.min(Math.max(1, options.limit ?? PAGE_SIZE), PAGE_SIZE);
    const db = this.open();
    if (!db) return { items: [], more: false };
    try {
      const collected: CliItem[] = [];
      const boundary = options.before
        ? (db.prepare("SELECT COALESCE(MIN(sequence), 0) s FROM message WHERE id=? AND session_id=?").get(options.before, sessionId) as { s: number | null } | undefined)?.s
        : null;
      if (options.before && boundary === undefined) return { items: [], more: false };
      const step = 120;
      let floor = Number.MAX_SAFE_INTEGER;
      for (;;) {
        const rows = (
          boundary === null
            ? db.prepare("SELECT id, time_created, data, sequence FROM message WHERE session_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?").all(sessionId, floor, step)
            : db.prepare("SELECT id, time_created, data, sequence FROM message WHERE session_id=? AND sequence<? AND sequence<? ORDER BY sequence DESC LIMIT ?").all(sessionId, boundary as number, floor, step)
        ) as Array<Rec>;
        if (!rows.length) break;
        floor = Math.min(...rows.map((row) => Number(row.sequence)));
        const parts = this.partsOf(rows.map((row) => String(row.id)));
        for (const row of rows) {
          const data = isRec(row.data) ? row.data : safeJson(row.data);
          if (!data) continue;
          const role = data.role === "assistant" ? "assistant" : data.role === "user" ? "user" : null;
          if (!role) continue;
          if (isRec(data.metadata) && isRec(data.metadata.runtimeMessage)) continue;
          if (data.visibility === "model-only") continue;
          const messageParts = parts.get(String(row.id)) ?? [];
          const ts = Number((isRec(data.time) ? data.time : {}).created) || Number(row.time_created) || 0;
          // the message id doubles as the page boundary, so it stays whole
          const item = zcodeItem(role, String(row.id), ts, messageParts, imageLocator);
          if (item) collected.push(item);
        }
        if (collected.length > limit) break;
      }
      const more = collected.length > limit;
      const items = collected.slice(0, limit);
      items.reverse();
      return { items, more };
    } catch {
      return { items: [], more: false };
    }
  }

  imageSource(sessionId: string, itemId: string, locator: string): TranscriptImage | undefined {
    const row = this.open()?.prepare("SELECT data FROM message WHERE id=? AND session_id=?").get(itemId, sessionId);
    const data = safeJson(row?.data);
    if (!data || data.visibility === "model-only" || (isRec(data.metadata) && isRec(data.metadata.runtimeMessage))) return;
    if (data.role !== "user" && data.role !== "assistant") return;
    let source: TranscriptImage | undefined;
    const item = zcodeItem(data.role, itemId, 0, this.partsOf([itemId]).get(itemId) ?? [], (offset, candidate) => {
      const ref = imageLocator(offset, candidate);
      if (ref === locator) source = candidate;
      return ref;
    });
    if (item && itemHasImage(item, itemId, locator)) return source;
  }

  /** The text parts of a batch of messages, in sequence order. */
  private partsOf(messageIds: string[]): Map<string, Rec[]> {
    const grouped = new Map<string, Rec[]>();
    if (!messageIds.length) return grouped;
    const db = this.open();
    if (!db) return grouped;
    const placeholders = messageIds.map(() => "?").join(",");
    try {
      const rows = db
        .prepare(`SELECT message_id, data, sequence FROM part WHERE message_id IN (${placeholders}) ORDER BY sequence`)
        .all(...messageIds) as Array<Rec>;
      for (const row of rows) {
        const id = String(row.message_id);
        const data = isRec(row.data) ? row.data : safeJson(row.data);
        if (!data) continue;
        const list = grouped.get(id) ?? [];
        list.push(data);
        grouped.set(id, list);
      }
    } catch {
      // no parts readable: the page comes back textless
    }
    return grouped;
  }

  /** What the poll-based watch compares; any change means "page again". */
  async marker(sessionId: string): Promise<string> {
    const row = this.scan().find((session) => session.id === sessionId);
    if (!row) return "";
    const count = this.messageCount(sessionId);
    return `${row.timeUpdated}:${count}`;
  }

  private messageCount(sessionId: string): number {
    const db = this.open();
    if (!db) return 0;
    try {
      return Number(db.prepare("SELECT COUNT(*) n FROM message WHERE session_id=?").get(sessionId)?.n ?? 0);
    } catch {
      return 0;
    }
  }
}

function safeJson(value: unknown): Rec | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return isRec(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The text of one message: its text parts in order, skipping synthetic ones.
 * Tool parts and separators are not chat text. */
function zcodeItem(role: "user" | "assistant", id: string, ts: number, parts: Rec[], imageRef: NonNullable<ItemContext["imageRef"]>): CliItem | undefined {
  const text = messageText(parts);
  const images: string[] = [];
  for (const part of parts) {
    if (part.type !== "file" || part.synthetic === true || typeof part.url !== "string" || images.length >= 20) continue;
    if (typeof part.mime !== "string" || !part.mime.startsWith("image/")) continue;
    const prefix = /^data:image\/[\w.+-]+;base64,/i.exec(part.url);
    if (prefix) images.push(imageRef(0, { kind: "inline", value: part.url.slice(prefix[0].length) }));
    else if (part.url.startsWith("file://")) {
      try { images.push(imageRef(0, { kind: "file", value: fileURLToPath(part.url) })); } catch { /* invalid file URL */ }
    }
  }
  if (!text && !images.length) return;
  const ctx = { segment: id, offset: 0, imageRef };
  if (role === "assistant") {
    const caption = [text, ...images.map(ref => `![图片](${ref})`)].filter(Boolean).join("\n\n");
    return localImageLinks(buildAssistantItem({ id, ts, text: caption }), ctx);
  }
  return localImageLinks(buildUserItem({ id, ts, text, ...(images.length ? { images } : {}) }), ctx);
}

function messageText(parts: Rec[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type !== "text") continue;
    if (part.synthetic === true) continue;
    const text = str(part.text, ITEM_TEXT_MAX);
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n");
}

export class ZcodeScanner {
  readonly home: string;
  readonly db: ZcodeDb;
  private readonly options: ZcodeScannerOptions;
  private cached: { at: number; rows: LocalSession[] } | null = null;

  constructor(home: string, options: ZcodeScannerOptions = {}) {
    this.home = home;
    this.options = options;
    this.db = new ZcodeDb(home, options);
  }

  /** The wire rows for this machine's ZCode sessions. The config dir is the
   * database home; when the device has a host channel the live sessions take
   * messages through it, otherwise they are read-only. */
  async scan(options: { now?: () => number } = {}): Promise<LocalSession[]> {
    const at = (options.now ?? this.options.now ?? Date.now)();
    if (this.cached && at - this.cached.at < 2000) return this.cached.rows;
    const host = this.options.host;
    const cutoff = at - HISTORY_DAYS * DAY_MS;
    const rows = this.db
      .scan()
      .filter((row) => row.running || row.timeUpdated >= cutoff)
      .slice(0, MAX_SESSIONS)
      .map<LocalSession>((row) => {
        const state: CliSessionState = row.running ? "running" : "idle";
        const session: LocalSession = {
          engine: "zcode",
          nativeId: row.id,
          configDir: this.home,
          cwd: row.directory || this.home,
          title: row.title,
          state,
          liveIn: row.running ? "desktop" : undefined,
          lastActivityAt: row.timeUpdated,
          transcript: "",
        };
        if (row.version) session.cliVersion = row.version;
        if (row.running && host) {
          session.sendVia = "host";
          session.route = { via: "host", home: this.home, sessionId: row.id };
        }
        return session;
      });
    this.cached = { at, rows };
    return rows;
  }

  close(): void {
    this.db.close();
  }
}

/** Exists and is a file, for the bridge's capability probe. */
export async function zcodeHomeExists(home: string): Promise<boolean> {
  try {
    return (await stat(path.join(home, "db.sqlite"))).isFile();
  } catch {
    return false;
  }
}

export const ZCODE_ENGINE: CliEngine = "zcode";
