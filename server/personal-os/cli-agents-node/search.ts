// Content search over the sessions this device lists (the `search` op). A
// session matches when every whitespace-separated term of the query occurs,
// case-insensitively, somewhere in its user and assistant text; terms may sit
// in different messages. Tool calls, tool output and thinking never count.
//
// Bounded on purpose: files are read in chunks, lines that cannot match are
// not JSON-parsed, tool-result lines are skipped on their raw bytes, and the
// whole search stops at `limit` hits or when its time budget runs out.
import { open, type FileHandle } from "node:fs/promises";
import { CLI_SEARCH, type CliEngine, type CliItem, type CliSearchHit, type CliSessionRef } from "../../../shared/cli-agents.ts";
import { claudeRecordToItems, clipUnits, codexRecordToItems } from "./items.ts";

/** One session to search: a transcript file, or a reader of its items (the
 * Codex App database and ZCode, which have no file). */
export type SearchSource =
  | { ref: CliSessionRef; engine: CliEngine; file: string }
  | { ref: CliSessionRef; engine: CliEngine; items: () => Promise<CliItem[]> };

export interface SearchOptions {
  limit?: number;
  /** wall-clock budget; the search returns what it found when it runs out */
  budgetMs?: number;
  chunkBytes?: number;
  now?: () => number;
}

const DEFAULT_BUDGET_MS = 8000;
const CHUNK = 1024 * 1024;
/** a line longer than this is a pasted blob or an image, not something to search */
const LINE_MAX = 16 * 1024 * 1024;
const SNIPPET_LEAD = 30;
// structural (unescaped) markers: inside a JSON string these quotes would be escaped
const SKIP_MARKS = ['"type":"tool_result"', '"type":"function_call_output"', '"type":"custom_tool_call_output"'].map((mark) => Buffer.from(mark));

/** The lower-cased terms of a query; empty when it has none. */
export function searchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const term of query.toLowerCase().split(/\s+/)) if (term && !terms.includes(term)) terms.push(term);
  return terms;
}

/** At most CLI_SEARCH.snippetMax units of `text` on one line, starting a little
 * before `at` (where the first term occurs); an ellipsis marks each cut end. */
export function snippetAround(text: string, at: number): string {
  const max = CLI_SEARCH.snippetMax;
  // whitespace collapses to single spaces; `at` maps to the collapsed prefix's length (give or take one)
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const index = text.slice(0, at).replace(/\s+/g, " ").trimStart().length;
  let start = Math.max(0, Math.min(index - SNIPPET_LEAD, flat.length - max));
  const end = start + max;
  const head = start > 0;
  const tail = end < flat.length;
  if (head) start += 1;
  // never begin on the second half of a surrogate pair
  const code = flat.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  const body = clipUnits(flat.slice(start, end - (tail ? 1 : 0)), max - (head ? 1 : 0) - (tail ? 1 : 0));
  return `${head ? "…" : ""}${body}${tail ? "…" : ""}`;
}

class Match {
  readonly found = new Set<string>();
  snippet: string | null = null;
  constructor(readonly terms: string[]) {}

  get done(): boolean {
    return this.snippet !== null && this.found.size === this.terms.length;
  }

  take(item: CliItem): void {
    if (item.kind !== "user" && item.kind !== "assistant") return;
    const lower = item.text.toLowerCase();
    for (const term of this.terms) {
      if (this.found.has(term)) continue;
      const at = lower.indexOf(term);
      if (at < 0) continue;
      this.found.add(term);
      // the snippet shows the first term where it first occurs
      if (term === this.terms[0] && this.snippet === null) {
        // lower-casing can change the length of a few characters; the index is then approximate
        this.snippet = snippetAround(item.text, Math.min(at, item.text.length));
      }
    }
  }
}

/** Searches the sources in order (newest first is the caller's) and returns the
 * matching ones, at most `limit`. Never throws: an unreadable source is skipped. */
export async function searchSessions(sources: SearchSource[], query: string, options: SearchOptions = {}): Promise<CliSearchHit[]> {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const limit = Math.max(1, Math.min(CLI_SEARCH.maxLimit, options.limit ?? CLI_SEARCH.defaultLimit));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  const hits: CliSearchHit[] = [];
  for (const source of sources) {
    if (hits.length >= limit || now() >= deadline) break;
    const match = new Match(terms);
    try {
      if ("file" in source) await searchFile(source.file, source.engine, match, { deadline, now, chunk: options.chunkBytes ?? CHUNK });
      else for (const item of await source.items()) {
        match.take(item);
        if (match.done) break;
      }
    } catch {
      // a file that went away or a database that is locked: no hit from it
    }
    if (match.done) hits.push({ ref: source.ref, snippet: match.snippet ?? "" });
  }
  return hits;
}

/** Terms whose JSON form is the term itself can be looked for in the raw line;
 * a term with a quote, backslash or control character would be escaped there. */
function rawTerms(terms: string[]): string[] | null {
  return terms.every((term) => JSON.stringify(term) === `"${term}"`) ? terms : null;
}

async function searchFile(file: string, engine: CliEngine, match: Match, limits: { deadline: number; now: () => number; chunk: number }): Promise<void> {
  const prefilter = rawTerms(match.terms);
  let handle: FileHandle | null = null;
  try {
    handle = await open(file, "r");
    const buf = Buffer.alloc(Math.max(64, limits.chunk));
    let carry: Buffer = Buffer.alloc(0);
    let skipping = false;
    let position = 0;
    let offset = 0;
    for (;;) {
      if (limits.now() >= limits.deadline) return;
      const { bytesRead } = await handle.read(buf, 0, buf.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let from = 0;
      for (;;) {
        const nl = data.indexOf(10, from);
        if (nl < 0) break;
        if (!skipping) line(data.subarray(from, nl), engine, match, prefilter, offset);
        skipping = false;
        offset += nl + 1 - from;
        from = nl + 1;
        if (match.done) return;
      }
      const rest = data.subarray(from);
      if (skipping || rest.length > LINE_MAX) {
        skipping = true;
        offset += rest.length;
        carry = Buffer.alloc(0);
      } else carry = Buffer.from(rest);
    }
    if (carry.length && !skipping) line(carry, engine, match, prefilter, offset);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function line(bytes: Buffer, engine: CliEngine, match: Match, prefilter: string[] | null, offset: number): void {
  if (bytes.length === 0) return;
  for (const mark of SKIP_MARKS) if (bytes.indexOf(mark) >= 0) return;
  const text = bytes.toString("utf8");
  if (prefilter) {
    const lower = text.toLowerCase();
    if (!prefilter.some((term) => lower.includes(term))) return;
  }
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return;
  }
  const ctx = { segment: "search", offset };
  let items: CliItem[];
  if (engine === "claude") items = claudeRecordToItems(record, ctx).items;
  else if (engine === "codex") {
    // v1 files carry the text in response_item records, v2 files in event_msg item_completed
    const v2 = typeof record === "object" && record !== null && (record as { type?: unknown }).type === "event_msg";
    items = codexRecordToItems(record, { ...ctx, codexV2: v2 }).items;
  } else return;
  for (const item of items) match.take(item);
}
