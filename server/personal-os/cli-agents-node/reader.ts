// Incremental transcript reader (plan 3.4). One reader per subscribed session
// file: it follows appended lines (fs.watch plus a 1 s stat fallback), keeps a
// partial last line for the next read, resets when the file is truncated or
// replaced, and serves backward paging from a lazily built line-start index.
import { watch, type FSWatcher } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { MAX_ITEMS_PER_MESSAGE, PAGE_SIZE, type CliEngine, type CliItem } from "../../../shared/cli-agents.ts";
import { claudeRecordToItems, codexRecordToItems, type ItemContext, type RowUpdate, type ToolItem } from "./items.ts";

export interface ReaderPage {
  /** oldest first, newest last */
  items: CliItem[];
  /** older items exist before the first one */
  more: boolean;
}

export interface TranscriptReaderOptions {
  path: string;
  engine: CliEngine;
  /** id prefix for records without a native id; defaults to the file name */
  segment?: string;
  onItems?: (items: CliItem[]) => void;
  /** the file shrank, was replaced, or turned out to be a v2 Codex file */
  onReset?: (page: ReaderPage) => void;
  onRow?: (update: RowUpdate) => void;
  /** stat fallback interval, default 1000 */
  pollMs?: number;
  /** use fs.watch in addition to the stat fallback, default true */
  watch?: boolean;
  /** index and tail read size, default 1 MiB */
  chunkBytes?: number;
}

const DEFAULT_CHUNK = 1024 * 1024;
const LOOKAHEAD_LINES = 200;
const ID_CACHE_MAX = 20_000;
const V2_MARK = Buffer.from('"item_completed"');

function yieldLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class TranscriptReader {
  /** lines that were not valid JSON */
  parseErrors = 0;

  private readonly file: string;
  private readonly engine: CliEngine;
  private readonly segment: string;
  private readonly chunk: number;
  private readonly opts: TranscriptReaderOptions;

  private closed = false;
  private started = false;
  private generation = 0;
  private codexV2 = false;

  // line-start index over complete lines
  private starts: number[] = [];
  private lineStart = 0;
  private scanPos = 0;
  private indexing: Promise<void> | null = null;

  // tail state
  private offset = 0;
  private partial: Buffer = Buffer.alloc(0);
  private ino = 0;
  private tools = new Map<string, ToolItem>();
  private ids = new Map<string, number>();

  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  private pollAgain = false;

  constructor(options: TranscriptReaderOptions) {
    this.opts = options;
    this.file = options.path;
    this.engine = options.engine;
    this.segment = options.segment ?? path.basename(options.path).replace(/\.jsonl$/i, "");
    this.chunk = Math.max(64, options.chunkBytes ?? DEFAULT_CHUNK);
  }

  /** Loads the newest page, then follows the file. */
  async start(): Promise<ReaderPage> {
    if (this.started) throw new Error("reader already started");
    this.started = true;
    const page = await this.load();
    if (this.closed) return page;
    if (this.opts.watch !== false) {
      try {
        this.watcher = watch(this.file, { persistent: false }, () => void this.poll());
        this.watcher.on("error", () => {
          this.watcher?.close();
          this.watcher = null;
        });
      } catch {
        this.watcher = null;
      }
    }
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? 1000);
    this.timer.unref();
    return page;
  }

  close(): void {
    this.closed = true;
    this.generation += 1;
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tools.clear();
    this.ids.clear();
  }

  /** Reads what was appended since the last read. Safe to call at any time;
   * calls are serialised. */
  poll(): Promise<void> {
    if (this.closed || !this.started) return Promise.resolve();
    if (this.polling) {
      this.pollAgain = true;
      return this.polling;
    }
    this.polling = (async () => {
      try {
        do {
          this.pollAgain = false;
          await this.pollOnce();
        } while (this.pollAgain && !this.closed);
      } catch {
        // a transient read error is retried by the next tick
      } finally {
        this.polling = null;
      }
    })();
    return this.polling;
  }

  /** Items right before `before` (an item id), newest last. Without `before`,
   * the newest page. */
  async page(options: { before?: string; limit?: number } = {}): Promise<ReaderPage> {
    const limit = Math.min(MAX_ITEMS_PER_MESSAGE, Math.max(1, Math.trunc(options.limit ?? PAGE_SIZE)));
    const generation = this.generation;
    await this.ensureIndex();
    if (generation !== this.generation) return { items: [], more: false };
    return this.buildPage(options.before, limit, new Map());
  }

  // -------------------------------------------------------------------------
  // loading and resetting

  private async load(): Promise<ReaderPage> {
    this.starts = [];
    this.lineStart = 0;
    this.scanPos = 0;
    this.indexing = null;
    this.partial = Buffer.alloc(0);
    this.tools = new Map();
    this.ids.clear();
    const generation = this.generation;
    let info;
    try {
      info = await stat(this.file);
    } catch {
      this.offset = 0;
      return { items: [], more: false };
    }
    this.ino = info.ino;
    if (this.engine === "codex") this.codexV2 = await this.detectV2(0, info.size);
    await this.ensureIndex();
    if (generation !== this.generation) return { items: [], more: false };
    this.offset = this.lineStart;
    return this.buildPage(undefined, PAGE_SIZE, this.tools);
  }

  private async detectV2(from: number, to: number): Promise<boolean> {
    let handle: FileHandle | null = null;
    try {
      handle = await open(this.file, "r");
      const buf = Buffer.alloc(this.chunk);
      let carry: Buffer = Buffer.alloc(0);
      let pos = from;
      while (pos < to) {
        const { bytesRead } = await handle.read(buf, 0, Math.min(this.chunk, to - pos), pos);
        if (bytesRead === 0) break;
        const data = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
        if (data.includes(V2_MARK)) return true;
        carry = Buffer.from(data.subarray(Math.max(0, data.length - (V2_MARK.length - 1))));
        pos += bytesRead;
        await yieldLoop();
      }
      return false;
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  private async reset(): Promise<void> {
    this.generation += 1;
    const page = await this.load();
    if (!this.closed) this.opts.onReset?.(page);
  }

  // -------------------------------------------------------------------------
  // index

  private ensureIndex(): Promise<void> {
    if (this.indexing) return this.indexing;
    const generation = this.generation;
    const run = (async () => {
      let handle: FileHandle | null = null;
      try {
        handle = await open(this.file, "r");
        const buf = Buffer.alloc(this.chunk);
        for (;;) {
          if (generation !== this.generation) return;
          const { bytesRead } = await handle.read(buf, 0, buf.length, this.scanPos);
          if (bytesRead === 0 || generation !== this.generation) break;
          let from = 0;
          for (;;) {
            const nl = buf.indexOf(10, from);
            if (nl < 0 || nl >= bytesRead) break;
            this.starts.push(this.lineStart);
            this.lineStart = this.scanPos + nl + 1;
            from = nl + 1;
          }
          this.scanPos += bytesRead;
          await yieldLoop();
        }
      } catch {
        // an unreadable file simply has no index yet
      } finally {
        await handle?.close().catch(() => {});
      }
    })();
    const tracked: Promise<void> = run.finally(() => {
      if (this.indexing === tracked) this.indexing = null;
    });
    this.indexing = tracked;
    return tracked;
  }

  private lineAtOffset(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] === offset) return mid;
      if (this.starts[mid] < offset) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  private async findLine(id: string): Promise<number> {
    const known = this.ids.get(id);
    if (known !== undefined) {
      const line = this.lineAtOffset(known);
      if (line >= 0) return line;
    }
    const own = new RegExp(`^${this.segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)(?::\\d+)?$`).exec(id);
    if (own) {
      const line = this.lineAtOffset(Number(own[1]));
      if (line >= 0) return line;
    }
    // last resort: the first line that mentions the id (or its uuid prefix)
    const needles = [`"${id}"`];
    const prefix = id.split(":")[0];
    if (prefix && prefix !== id) needles.push(`"${prefix}"`);
    const total = this.starts.length;
    const step = 256;
    for (let from = 0; from < total; from += step) {
      const to = Math.min(total, from + step);
      const lines = await this.readLines(from, to);
      for (let i = 0; i < lines.length; i += 1) {
        const text = lines[i].text;
        if (needles.some((needle) => text.includes(needle))) return from + i;
      }
      await yieldLoop();
    }
    return -1;
  }

  // -------------------------------------------------------------------------
  // paging

  private async readLines(from: number, to: number): Promise<{ text: string; offset: number }[]> {
    if (from >= to || from >= this.starts.length) return [];
    const end = to >= this.starts.length ? this.lineStart : this.starts[to];
    const begin = this.starts[from];
    if (end <= begin) return [];
    let handle: FileHandle | null = null;
    try {
      handle = await open(this.file, "r");
      const buf = Buffer.alloc(end - begin);
      let read = 0;
      while (read < buf.length) {
        const { bytesRead } = await handle.read(buf, read, buf.length - read, begin + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      const lines: { text: string; offset: number }[] = [];
      let s = 0;
      while (s < read) {
        let e = buf.indexOf(10, s);
        if (e < 0 || e > read) e = read;
        lines.push({ text: buf.toString("utf8", s, e), offset: begin + s });
        s = e + 1;
      }
      return lines;
    } catch {
      return [];
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  private ctxFor(tools: Map<string, ToolItem>, share: boolean): ItemContext {
    return { segment: this.segment, offset: 0, codexV2: this.codexV2, tools, shareTools: share };
  }

  /** Maps lines in order. Items are returned with their line offsets. */
  private mapLines(lines: { text: string; offset: number }[], ctx: ItemContext, onRow?: (u: RowUpdate) => void): { item: CliItem; offset: number }[] {
    const out: { item: CliItem; offset: number }[] = [];
    for (const line of lines) {
      const mapped = this.mapLine(line.text, line.offset, ctx);
      if (!mapped) continue;
      if (mapped.row) onRow?.(mapped.row);
      for (const item of mapped.items) out.push({ item, offset: line.offset });
    }
    return out;
  }

  private mapLine(text: string, offset: number, ctx: ItemContext) {
    const trimmed = text.endsWith("\r") ? text.slice(0, -1) : text;
    if (trimmed.trim() === "") return null;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      this.parseErrors += 1;
      return null;
    }
    ctx.offset = offset;
    return this.engine === "claude" ? claudeRecordToItems(record, ctx) : codexRecordToItems(record, ctx);
  }

  private remember(id: string, offset: number): void {
    if (this.ids.size >= ID_CACHE_MAX) {
      const oldest = this.ids.keys().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    this.ids.set(id, offset);
  }

  private async buildPage(before: string | undefined, limit: number, tools: Map<string, ToolItem>): Promise<ReaderPage> {
    let endLine = this.starts.length;
    if (before !== undefined) {
      const line = await this.findLine(before);
      if (line < 0) return { items: [], more: false };
      endLine = line + 1;
    }
    let span = Math.max(50, limit * 2);
    let startLine = 0;
    let unique: { item: CliItem; offset: number }[] = [];
    for (;;) {
      startLine = Math.max(0, endLine - span);
      if (before !== undefined) tools = new Map();
      const ctx = this.ctxFor(tools, true);
      const lines = await this.readLines(startLine, endLine);
      let found = this.mapLines(lines, ctx);
      if (before !== undefined) {
        // items of the cut line that come before `before`
        const cutIndex = found.findIndex((entry) => entry.item.id === before);
        if (cutIndex >= 0) found = found.slice(0, cutIndex);
        else found = found.filter((entry) => entry.offset < this.starts[endLine - 1]);
        // results that arrive after the page complete its running tools
        const ahead = await this.readLines(endLine, Math.min(this.starts.length, endLine + LOOKAHEAD_LINES));
        this.mapLines(ahead, ctx);
      }
      // a tool item appears twice when its result is in the window; keep the first slot.
      // The page is full only by distinct items: counting both slots ended a page early
      // and reported nothing older.
      const seen = new Set<string>();
      unique = found.filter((entry) => {
        if (seen.has(entry.item.id)) return false;
        seen.add(entry.item.id);
        return true;
      });
      if (unique.length > limit || startLine === 0) break;
      span *= 2;
      await yieldLoop();
    }
    const slice = unique.slice(-limit);
    for (const entry of slice) this.remember(entry.item.id, entry.offset);
    return { items: slice.map((entry) => ({ ...entry.item }) as CliItem), more: unique.length > limit };
  }

  // -------------------------------------------------------------------------
  // tail

  private async pollOnce(): Promise<void> {
    let info;
    try {
      info = await stat(this.file);
    } catch {
      return; // missing for now; the next tick retries
    }
    if (info.size < this.offset + this.partial.length || (this.ino !== 0 && info.ino !== 0 && info.ino !== this.ino)) {
      await this.reset();
      return;
    }
    if (info.size === this.offset + this.partial.length) return;
    let handle: FileHandle | null = null;
    const generation = this.generation;
    try {
      handle = await open(this.file, "r");
      for (;;) {
        const from = this.offset + this.partial.length;
        const buf = Buffer.alloc(this.chunk);
        const { bytesRead } = await handle.read(buf, 0, buf.length, from);
        if (bytesRead === 0 || generation !== this.generation) break;
        if (this.engine === "codex" && !this.codexV2 && buf.subarray(0, bytesRead).includes(V2_MARK)) {
          await handle.close();
          handle = null;
          this.codexV2 = true;
          await this.reset();
          return;
        }
        const data = Buffer.concat([this.partial, buf.subarray(0, bytesRead)]);
        const base = this.offset;
        const last = data.lastIndexOf(10);
        if (last < 0) {
          this.partial = data;
          continue;
        }
        const complete = data.subarray(0, last + 1);
        this.partial = Buffer.from(data.subarray(last + 1));
        const lines: { text: string; offset: number }[] = [];
        let s = 0;
        while (s < complete.length) {
          const e = complete.indexOf(10, s);
          lines.push({ text: complete.toString("utf8", s, e), offset: base + s });
          s = e + 1;
        }
        this.offset = base + complete.length;
        const mapped = this.mapLines(lines, this.ctxFor(this.tools, false), this.opts.onRow);
        for (const entry of mapped) this.remember(entry.item.id, entry.offset);
        for (let i = 0; i < mapped.length; i += MAX_ITEMS_PER_MESSAGE) {
          this.opts.onItems?.(mapped.slice(i, i + MAX_ITEMS_PER_MESSAGE).map((entry) => entry.item));
        }
        if (bytesRead < buf.length) break;
        await yieldLoop();
      }
    } finally {
      await handle?.close().catch(() => {});
    }
  }
}
