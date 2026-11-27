// ZCode harness storage and installation discovery.
//
// ZCode stores its sessions in one SQLite database at `~/.zcode/cli/db/db.sqlite`
// (tables `session`, `message`, `part`, `session_runtime_presence`). The reader
// opens it read-only, never writes to it, and gracefully yields no rows when
// missing or unreadable. Live PIDs in `session_runtime_presence` (excluding our
// own managed `app-server` PIDs) mark externally running ZCode Desktop sessions
// as `running`; inactive sessions report `stopped` so NexAgent can resume them.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { resolveCli } from "./launch.ts";
import {
  CLI_LIMITS,
  HISTORY_DAYS,
  ITEM_TEXT_MAX,
  MAX_SESSIONS,
  PAGE_SIZE,
  type CliContextUsage,
  type CliEngine,
  type CliItem,
  type CliSessionState,
} from "../../../shared/cli-agents.ts";
import {
  COMPACT_TEXT,
  buildAssistantItem,
  buildNoticeItem,
  buildThinkingItem,
  buildToolItem,
  buildUserItem,
  clipUnits,
  imageLocator,
  itemHasImage,
  localImageLinks,
  type ItemContext,
  type LocalSession,
  type TranscriptImage,
} from "./items.ts";

const DAY_MS = 86_400_000;
const POLL_MS = 30_000;
const REG_TIMEOUT_MS = 3000;
const AUXILIARY_TASK_TYPES = new Set([
  "subagent_child",
  "selection_side_chat",
  "workflow_child",
  "nested_workflow_child",
]);

export interface ZcodeHostChannel {
  /** Puts one message into a live session (a new turn or guidance). */
  submit(sessionId: string, text: string, options?: { steer?: boolean }): Promise<{ accepted: boolean }>;
  /** Stops the session's current turn. */
  interrupt(sessionId: string): Promise<{ outcome: string }>;
}

export interface ZcodeScannerOptions {
  /** explicit SQLite file override (e.g. `ZCODE_SESSION_DB_PATH`) */
  dbFile?: string;
  /** which pids are alive; defaults to a signal-0 probe */
  pidAlive?: (pid: number) => boolean;
  /** managed app-server pids owned by NexAgent, excluded from external presence */
  ignorePids?: () => ReadonlySet<number>;
  /** the host channel, when an external host bridge is injected */
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
  model?: string;
  context?: CliContextUsage;
}

export interface ZcodePage {
  items: CliItem[];
  more: boolean;
}

export interface ZcodeLaunchSpec {
  /** Executable to spawn (ZCode Desktop Electron binary, `node`, or standalone `zcode`). */
  command: string;
  /** Leading args before `app-server` / `skills` (e.g. `[zcode.cjs]` for desktop installs). */
  argsPrefix: string[];
  /** Extra environment variables required by `zcode.cjs` (provider configs, `ELECTRON_RUN_AS_NODE`, `NODE_PATH`). */
  env: Record<string, string>;
  version: string | null;
}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (value: unknown, max: number): string => (typeof value === "string" ? clipUnits(value, max) : "");

/** Default ZCode CLI home directory (`~/.zcode/cli`, or `ZCODE_CLI_HOME`). */
export function defaultZcodeHome(homedir?: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ZCODE_CLI_HOME?.trim();
  if (override) return override;
  const home = homedir ?? env.USERPROFILE ?? env.HOME ?? os.homedir();
  return path.join(home, ".zcode", "cli");
}

/** Existing default ZCode homes, like claudeConfigDirs(): `~/.zcode/cli`. */
export function zcodeHomes(homedir?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = defaultZcodeHome(homedir, env);
  return dir && existsSync(dir) ? [dir] : [];
}

/** Resolves the SQLite database file inside a ZCode home (`db/db.sqlite`, with legacy `db.sqlite` fallback). */
export function resolveZcodeDbPath(home: string): string {
  const nested = path.join(home, "db", "db.sqlite");
  if (existsSync(nested)) return nested;
  const flat = path.join(home, "db.sqlite");
  if (existsSync(flat)) return flat;
  return nested;
}

/** A cheap liveness probe: signal 0 throws when the pid is gone. */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isHiddenMessage(data: Rec): boolean {
  if (data.visibility === "model-only") return true;
  if (isRec(data.metadata)) {
    if (data.metadata.visibility === "model-only") return true;
    if (isRec(data.metadata.runtimeMessage)) return true;
  }
  return false;
}

/** One read-only handle over ZCode's `db.sqlite`, with a small cache so the
 * scanners' 2 s and 15 s rounds do not reopen SQLite on every tick. */
export class ZcodeDb {
  private db: DatabaseSync | null = null;
  private openedAt = 0;
  private hasTaskType: boolean | null = null;
  private readonly options: ZcodeScannerOptions;

  constructor(
    readonly home: string,
    options: ZcodeScannerOptions = {},
  ) {
    this.options = options;
  }

  private file(): string {
    return this.options.dbFile || resolveZcodeDbPath(this.home);
  }

  /** Whether this database file currently exists on disk. */
  async exists(): Promise<boolean> {
    if (this.options.dbFile) {
      try {
        return (await stat(this.options.dbFile)).isFile();
      } catch {
        return false;
      }
    }
    return zcodeHomeExists(this.home);
  }

  private open(): DatabaseSync | null {
    if (this.db && Date.now() - this.openedAt < POLL_MS) return this.db;
    this.db?.close();
    this.db = null;
    this.hasTaskType = null;
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
    this.hasTaskType = null;
  }

  private sessionHasTaskType(db: DatabaseSync): boolean {
    if (this.hasTaskType !== null) return this.hasTaskType;
    try {
      const cols = db.prepare("PRAGMA table_info(session)").all() as Array<Rec>;
      this.hasTaskType = cols.some((col) => col.name === "task_type");
    } catch {
      this.hasTaskType = false;
    }
    return this.hasTaskType;
  }

  /** Whether an external (non-NexAgent) ZCode process currently holds this session. */
  isRunningExternally(sessionId: string, ignorePids?: ReadonlySet<number>): boolean {
    const db = this.open();
    if (!db) return false;
    const alive = this.options.pidAlive ?? pidAlive;
    const ignored = ignorePids ?? this.options.ignorePids?.();
    try {
      const rows = db.prepare("SELECT process_id FROM session_runtime_presence WHERE session_id=?").all(sessionId) as Array<Rec>;
      return rows.some((row) => {
        const pid = Number(row.process_id);
        return (!ignored || !ignored.has(pid)) && alive(pid);
      });
    } catch {
      return false;
    }
  }

  /** Every non-auxiliary session worth reporting, newest first. Archived and
   * deleted rows are left out; a live external pid makes the row `running`. */
  scan(options?: { ignorePids?: ReadonlySet<number> }): ZcodeSessionRow[] {
    const db = this.open();
    if (!db) return [];
    const alive = this.options.pidAlive ?? pidAlive;
    const ignored = options?.ignorePids ?? this.options.ignorePids?.();
    try {
      const presence = new Map<string, boolean>();
      for (const row of db.prepare("SELECT session_id, process_id FROM session_runtime_presence").all() as Array<Rec>) {
        const session = str(row.session_id, 200);
        if (!session) continue;
        const pid = Number(row.process_id);
        if (ignored?.has(pid)) continue;
        presence.set(session, presence.get(session) === true || alive(pid));
      }
      const withTaskType = this.sessionHasTaskType(db);
      const sql = withTaskType
        ? `SELECT id, directory, title, version, time_created, time_updated, time_archived, time_deleted, parent_id, task_type
           FROM session WHERE time_deleted IS NULL AND time_archived IS NULL ORDER BY time_updated DESC LIMIT ?`
        : `SELECT id, directory, title, version, time_created, time_updated, time_archived, time_deleted, parent_id
           FROM session WHERE time_deleted IS NULL AND time_archived IS NULL ORDER BY time_updated DESC LIMIT ?`;
      const rows = db.prepare(sql).all(MAX_SESSIONS * 2) as Array<Rec>;
      const filtered: ZcodeSessionRow[] = [];
      for (const row of rows) {
        if (withTaskType && typeof row.task_type === "string" && AUXILIARY_TASK_TYPES.has(row.task_type)) continue;
        const id = str(row.id, 200);
        const timeUpdated = Number(row.time_updated);
        if (!id || !Number.isSafeInteger(timeUpdated)) continue;
        filtered.push({
          id,
          directory: str(row.directory, CLI_LIMITS.cwd),
          title: str(row.title, CLI_LIMITS.title),
          version: row.version === null || row.version === undefined ? null : str(row.version, CLI_LIMITS.cliVersion),
          timeCreated: Number(row.time_created) || timeUpdated,
          timeUpdated,
          archived: row.time_archived !== null && row.time_archived !== undefined,
          running: presence.get(id) === true,
          parentId: row.parent_id === null || row.parent_id === undefined ? null : str(row.parent_id, 200),
        });
        if (filtered.length >= MAX_SESSIONS) break;
      }
      this.attachMetadata(db, filtered);
      return filtered;
    } catch {
      return [];
    }
  }

  /** Reads latest assistant model & token usage for the scanned sessions in one cheap pass. */
  private attachMetadata(db: DatabaseSync, rows: ZcodeSessionRow[]): void {
    if (!rows.length) return;
    try {
      const stmt = db.prepare(
        `SELECT data FROM message WHERE session_id=? ORDER BY sequence DESC LIMIT 12`,
      );
      for (const row of rows) {
        const messages = stmt.all(row.id) as Array<Rec>;
        for (const msg of messages) {
          const data = isRec(msg.data) ? msg.data : safeJson(msg.data);
          if (!data || data.role !== "assistant") continue;
          const providerId = typeof data.providerId === "string" ? data.providerId.trim() : "";
          const modelId = typeof data.modelId === "string" ? data.modelId.trim() : "";
          if (modelId && !row.model) {
            row.model = clipUnits(providerId ? `${providerId}/${modelId}` : modelId, CLI_LIMITS.model);
          }
          if (!row.context && isRec(data.tokens)) {
            const total = Number(data.tokens.total);
            if (Number.isFinite(total) && total > 0) row.context = { used: Math.trunc(total) };
          }
          if (row.model && row.context) break;
        }
      }
    } catch {
      // metadata is best-effort
    }
  }

  /** One transcript page, oldest first. `before` is the item id the page ends
   * right before. Hidden/model-only messages are skipped; reasoning, tools,
   * compaction notices and images are mapped to wire-safe CliItems. */
  async page(sessionId: string, options: { before?: string; limit?: number } = {}): Promise<ZcodePage> {
    const limit = Math.min(Math.max(1, options.limit ?? PAGE_SIZE), PAGE_SIZE);
    const db = this.open();
    if (!db) return { items: [], more: false };
    try {
      const collected: CliItem[] = [];
      let boundary: number | null = null;
      let boundaryMsgId: string | null = null;
      if (options.before) {
        boundaryMsgId = baseMessageId(options.before);
        const found = db
          .prepare("SELECT sequence s FROM message WHERE id=? AND session_id=? LIMIT 1")
          .get(boundaryMsgId, sessionId) as { s: number | null } | undefined;
        if (!found || found.s === null || found.s === undefined) return { items: [], more: false };
        boundary = Number(found.s);
      }
      const step = 120;
      let floor = boundary === null ? Number.MAX_SAFE_INTEGER : boundary + 1;
      for (;;) {
        const rows = db
          .prepare("SELECT id, time_created, data, sequence FROM message WHERE session_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?")
          .all(sessionId, floor, step) as Array<Rec>;
        if (!rows.length) break;
        floor = Math.min(...rows.map((row) => Number(row.sequence)));
        const parts = this.partsOf(rows.map((row) => String(row.id)));
        for (const row of rows) {
          const msgId = String(row.id);
          const data = isRec(row.data) ? row.data : safeJson(row.data);
          if (!data) continue;
          const role = data.role === "assistant" ? "assistant" : data.role === "user" ? "user" : null;
          if (!role || isHiddenMessage(data)) continue;
          const messageParts = parts.get(msgId) ?? [];
          const ts = Number((isRec(data.time) ? data.time : {}).created) || Number(row.time_created) || 0;
          let items = zcodeMessageItems(role, msgId, ts, data, messageParts, this.home, imageLocator);
          if (boundaryMsgId && msgId === boundaryMsgId && options.before) {
            const cut = items.findIndex((item) => item.id === options.before);
            items = cut >= 0 ? items.slice(0, cut) : [];
          }
          // `collected` accumulates newest-first, then reverses at the end
          for (let i = items.length - 1; i >= 0; i--) collected.push(items[i]!);
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
    const msgId = baseMessageId(itemId);
    const row = this.open()?.prepare("SELECT data FROM message WHERE id=? AND session_id=?").get(msgId, sessionId);
    const data = safeJson(row?.data);
    if (!data || isHiddenMessage(data)) return;
    if (data.role !== "user" && data.role !== "assistant") return;
    let source: TranscriptImage | undefined;
    const items = zcodeMessageItems(data.role, msgId, 0, data, this.partsOf([msgId]).get(msgId) ?? [], this.home, (offset, candidate) => {
      const ref = imageLocator(offset, candidate);
      if (ref === locator) source = candidate;
      return ref;
    });
    if (!source || !items.some((item) => itemHasImage(item, itemId, locator))) return;
    // ZCode stores uploaded image artifacts as `.txt` files containing a `data:image/...;base64,...` URI.
    if (source.kind === "file" && /\.txt$/i.test(source.value)) {
      return readDataUrlArtifact(source.value);
    }
    return source;
  }

  /** The parts of a batch of messages, in sequence order. */
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
    const db = this.open();
    if (!db) return "";
    try {
      const row = db.prepare("SELECT time_updated FROM session WHERE id=? AND time_deleted IS NULL").get(sessionId) as { time_updated?: number } | undefined;
      if (!row || !Number.isSafeInteger(Number(row.time_updated))) return "";
      const count = this.messageCount(sessionId);
      return `${row.time_updated}:${count}`;
    } catch {
      return "";
    }
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

function baseMessageId(itemId: string): string {
  return itemId.replace(/:(?:[pt]\d+|err)$/, "");
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

const ARTIFACT_TEXT_MAX_BYTES = 16 * 1024 * 1024;

function sanitizeArtifactSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

function readDataUrlArtifact(file: string): TranscriptImage | undefined {
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size <= 0 || info.size > ARTIFACT_TEXT_MAX_BYTES) return undefined;
    const raw = readFileSync(file, "utf8").trim();
    const prefix = /^data:image\/[\w.+-]+;base64,/i.exec(raw);
    if (!prefix) return undefined;
    return { kind: "inline", value: raw.slice(prefix[0].length) };
  } catch {
    return undefined;
  }
}

function artifactFile(home: string, uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "zcode-artifact:") return null;
  try {
    const sessionId = decodeURIComponent(url.hostname);
    const artifactId = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (!sessionId || !artifactId || sessionId.includes("..") || artifactId.includes("..") || artifactId.includes("/") || artifactId.includes("\\")) {
      return null;
    }
    const dir = path.join(home, "artifacts", sanitizeArtifactSegment(sessionId));
    const direct = path.join(dir, artifactId);
    if (existsSync(direct)) return direct;
    if (!existsSync(dir)) return null;
    const match = readdirSync(dir).find((entry) => entry.includes(artifactId) && /\.(?:png|jpe?g|webp|txt)$/i.test(entry));
    return match ? path.join(dir, match) : null;
  } catch {
    return null;
  }
}

function extractImageRef(part: Rec, home: string, imageRef: NonNullable<ItemContext["imageRef"]>): string | null {
  if (part.type !== "file" || part.synthetic === true || typeof part.url !== "string") return null;
  if (typeof part.mime !== "string" || !part.mime.startsWith("image/")) return null;
  const prefix = /^data:image\/[\w.+-]+;base64,/i.exec(part.url);
  if (prefix) return imageRef(0, { kind: "inline", value: part.url.slice(prefix[0].length) });
  if (part.url.startsWith("file://")) {
    try {
      return imageRef(0, { kind: "file", value: fileURLToPath(part.url) });
    } catch {
      return null;
    }
  }
  if (part.url.startsWith("zcode-artifact://")) {
    const file = artifactFile(home, part.url);
    if (file) return imageRef(0, { kind: "file", value: file });
  }
  return null;
}

/** Maps one ZCode message + its ordered parts into wire-safe CliItems.
 * Preserves `id = msgId` for a message's primary text item so existing callers
 * and `before` cursors remain stable. */
export function zcodeMessageItems(
  role: "user" | "assistant",
  id: string,
  ts: number,
  data: Rec,
  parts: Rec[],
  home: string,
  imageRef: NonNullable<ItemContext["imageRef"]>,
): CliItem[] {
  const ctx: ItemContext = { segment: id, offset: 0, imageRef };
  if (role === "user") {
    const text = messageText(parts);
    const images: string[] = [];
    for (const part of parts) {
      if (images.length >= CLI_LIMITS.images) break;
      const ref = extractImageRef(part, home, imageRef);
      if (ref) images.push(ref);
    }
    if (!text && !images.length) return [];
    return [localImageLinks(buildUserItem({ id, ts, text, ...(images.length ? { images } : {}) }), ctx)];
  }

  const out: CliItem[] = [];
  const textChunks: string[] = [];
  const images: string[] = [];
  let textCount = 0;

  const flushText = (partSeq: number, final: boolean): void => {
    if (!textChunks.length && !images.length) return;
    const text = textChunks.join("\n\n");
    const caption = [text, ...images.map((ref) => `![图片](${ref})`)].filter(Boolean).join("\n\n");
    textChunks.length = 0;
    images.length = 0;
    if (!caption) return;
    const itemId = final && textCount === 0 ? id : `${id}:t${partSeq}`;
    textCount += 1;
    out.push(localImageLinks(buildAssistantItem({ id: itemId, ts, text: caption }), ctx));
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.synthetic === true) continue;
    const type = part.type;
    if (type === "text") {
      const text = str(part.text, ITEM_TEXT_MAX);
      if (text) textChunks.push(text);
    } else if (type === "file") {
      if (images.length < CLI_LIMITS.images) {
        const ref = extractImageRef(part, home, imageRef);
        if (ref) images.push(ref);
      }
    } else if (type === "reasoning") {
      const text = str(part.text, ITEM_TEXT_MAX).trim();
      if (!text) continue;
      flushText(i, false);
      out.push(buildThinkingItem({ id: `${id}:p${i}`, ts, text }));
    } else if (type === "tool" && typeof part.tool === "string" && part.tool.trim()) {
      flushText(i, false);
      const state = isRec(part.state) ? part.state : {};
      const status = state.status === "completed" ? "ok" : state.status === "error" ? "error" : "running";
      const toolOutput = status === "error" ? state.error ?? state.output : state.output;
      out.push(
        buildToolItem({
          id: `${id}:p${i}`,
          ts,
          name: part.tool.trim(),
          input: state.input,
          status,
          ...(toolOutput !== undefined ? { output: toolOutput } : {}),
        }),
      );
    } else if (type === "compaction") {
      flushText(i, false);
      out.push(buildNoticeItem({ id: `${id}:p${i}`, ts, level: "info", text: COMPACT_TEXT }));
    }
  }
  flushText(parts.length, true);

  if (isRec(data.error)) {
    const errData = isRec(data.error.data) ? data.error.data : {};
    const errText = str(errData.message ?? data.error.message ?? data.error.name, CLI_LIMITS.noticeText).trim();
    if (errText) out.push(buildNoticeItem({ id: `${id}:err`, ts, level: "error", text: errText }));
  }

  return out;
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

  /** The wire rows for this machine's ZCode sessions. Live external processes
   * report `running` (`liveIn: "desktop"`), and inactive sessions report
   * `stopped` so NexAgent can resume them. */
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
        const state: CliSessionState = row.running ? "running" : "stopped";
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
        if (row.model) session.model = row.model;
        if (row.context) session.context = row.context;
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
  for (const candidate of [path.join(home, "db", "db.sqlite"), path.join(home, "db.sqlite")]) {
    try {
      if ((await stat(candidate)).isFile()) return true;
    } catch {
      // try next layout
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// ZCode runtime binary / Desktop bundle discovery

let cachedLaunch: { key: string; result: ZcodeLaunchSpec | null; until: number } | null = null;
const LAUNCH_CACHE_MS = 60_000;

export function clearZcodeLaunchCache(): void {
  cachedLaunch = null;
}

function personalProviderConfig(homedir: string, env: NodeJS.ProcessEnv): string {
  return env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim() || path.join(homedir, ".zcode", "v2", "provider_config.json");
}

function desktopBundleSpec(
  resourcesDir: string,
  executableCandidate: string | null,
  homedir: string,
  env: NodeJS.ProcessEnv,
  version: string | null,
): ZcodeLaunchSpec | null {
  const entry = path.join(resourcesDir, "glm", "zcode.cjs");
  if (!existsSync(entry)) return null;
  const builtin = path.join(resourcesDir, "config", "provider", "zcode-builtin.json");
  const asarModules = path.join(resourcesDir, "app.asar", "node_modules");
  const command = executableCandidate && existsSync(executableCandidate) ? executableCandidate : process.execPath;
  const launchEnv: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: "1",
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalProviderConfig(homedir, env),
  };
  if (existsSync(builtin)) launchEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtin;
  if (existsSync(asarModules)) {
    launchEnv.NODE_PATH = env.NODE_PATH ? `${asarModules}${path.delimiter}${env.NODE_PATH}` : asarModules;
  }
  return { command, argsPrefix: [entry], env: launchEnv, version };
}

function queryRegUninstall(root: string): Promise<Array<{ dir: string; version: string | null }>> {
  return new Promise((resolve) => {
    execFile(
      "reg.exe",
      ["query", root, "/s"],
      { timeout: REG_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error || !stdout) {
          resolve([]);
          return;
        }
        const found: Array<{ dir: string; version: string | null }> = [];
        for (const block of stdout.split(/\r?\n\r?\n+/)) {
          const display = /^\s*DisplayName\s+REG_\w+\s+(.+)$/im.exec(block)?.[1]?.trim() ?? "";
          if (!/^ZCode(?:\b|\s|$)/i.test(display)) continue;
          const version = /^\s*DisplayVersion\s+REG_\w+\s+(.+)$/im.exec(block)?.[1]?.trim() || null;
          let dir = /^\s*InstallLocation\s+REG_\w+\s+(.+)$/im.exec(block)?.[1]?.trim().replace(/^"|"$/g, "") ?? "";
          if (!dir) {
            const uninstall = /^\s*UninstallString\s+REG_\w+\s+"?([^"\r\n]+?\.exe)"?/im.exec(block)?.[1]?.trim();
            if (uninstall) dir = path.dirname(uninstall);
          }
          if (dir) found.push({ dir, version });
        }
        resolve(found);
      },
    );
  });
}

/** Locates ZCode (`app-server` runnable): explicit env override, standalone CLI
 * on PATH, or ZCode Desktop's bundled `resources/glm/zcode.cjs`. */
export async function resolveZcodeLaunch(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  resolveCli?: (engine: CliEngine) => Promise<string | null>;
} = {}): Promise<ZcodeLaunchSpec | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? env.USERPROFILE ?? env.HOME ?? os.homedir();

  // Explicit test/user override (e.g. a node script fixture or standalone binary).
  const override = env.ZCODE_APP_SERVER_BIN?.trim();
  if (override && existsSync(override)) {
    const isScript = /\.(?:[cm]?js)$/i.test(override);
    return {
      command: isScript ? process.execPath : override,
      argsPrefix: isScript ? [override] : [],
      env: {
        ...(isScript ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalProviderConfig(homedir, env),
      },
      version: null,
    };
  }

  const cacheKey = `${platform}\0${homedir}\0${env.LOCALAPPDATA ?? ""}\0${env.ProgramFiles ?? ""}`;
  if (!options.resolveCli && cachedLaunch && cachedLaunch.key === cacheKey && cachedLaunch.until > Date.now()) {
    return cachedLaunch.result;
  }

  let found: ZcodeLaunchSpec | null = null;
  const findCli = options.resolveCli ?? ((engine: CliEngine) => resolveCli(engine, { platform, env }));
  const cli = await findCli("zcode").catch(() => null);
  if (cli) {
    const isScript = /\.(?:[cm]?js)$/i.test(cli);
    found = {
      command: isScript ? process.execPath : cli,
      argsPrefix: isScript ? [cli] : [],
      env: {
        ...(isScript ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalProviderConfig(homedir, env),
      },
      version: null,
    };
  }

  if (!found && platform === "win32") {
    const candidates: Array<{ dir: string; version: string | null }> = [];
    for (const root of [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ]) {
      const hits = await queryRegUninstall(root);
      candidates.push(...hits);
    }
    for (const base of [
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "ZCode") : "",
      env.ProgramFiles ? path.join(env.ProgramFiles, "ZCode") : "",
      env["ProgramFiles(x86)"] ? path.join(env["ProgramFiles(x86)"], "ZCode") : "",
    ]) {
      if (base) candidates.push({ dir: base, version: null });
    }
    for (const { dir, version } of candidates) {
      const spec = desktopBundleSpec(path.join(dir, "resources"), path.join(dir, "ZCode.exe"), homedir, env, version);
      if (spec) {
        found = spec;
        break;
      }
    }
  } else if (!found && platform === "darwin") {
    for (const app of ["/Applications/ZCode.app", path.join(homedir, "Applications", "ZCode.app")]) {
      const spec = desktopBundleSpec(
        path.join(app, "Contents", "Resources"),
        path.join(app, "Contents", "MacOS", "ZCode"),
        homedir,
        env,
        null,
      );
      if (spec) {
        found = spec;
        break;
      }
    }
  } else if (!found) {
    for (const base of [path.join(homedir, ".local", "share", "ZCode"), "/opt/ZCode", "/usr/lib/zcode"]) {
      const spec = desktopBundleSpec(path.join(base, "resources"), path.join(base, "zcode"), homedir, env, null);
      if (spec) {
        found = spec;
        break;
      }
    }
  }

  if (!options.resolveCli) {
    cachedLaunch = { key: cacheKey, result: found, until: Date.now() + LAUNCH_CACHE_MS };
  }
  return found;
}

export const ZCODE_ENGINE: CliEngine = "zcode";
