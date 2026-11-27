// Pure helpers for the conversation view: merging item pages and pushes by id,
// and grouping the flat item list into what the view renders.
import { isCliCommandRecord, modelFailureReason, normalizeCliTaskItem, type CliItem } from "../../../shared/cli-agents";

type ToolItem = Extract<CliItem, { kind: "tool" }>;
type ThinkingItem = Extract<CliItem, { kind: "thinking" }>;
export type ActivityItem = ToolItem | ThinkingItem;

/** Adds pushed items. An id already shown is replaced in place (a tool call
 * gains its output and status); a new id goes after the last item that is not
 * newer than it. `reset` swaps the whole list for the pushed one. */
export function mergeItems(existing: readonly CliItem[], incoming: readonly CliItem[], reset = false, appendInRecordOrder = false): CliItem[] {
  if (reset) return dedupe(incoming);
  const out = [...existing];
  const index = new Map(out.map((item, at) => [item.id, at]));
  for (const item of incoming) {
    const at = index.get(item.id);
    if (at !== undefined) { out[at] = item; continue; }
    let position = out.length;
    while (!appendInRecordOrder && position > 0 && out[position - 1].ts > item.ts) position--;
    if (position === out.length) {
      out.push(item);
      index.set(item.id, position);
      continue;
    }
    out.splice(position, 0, item);
    // positions after the insert point moved
    index.clear();
    out.forEach((entry, i) => index.set(entry.id, i));
  }
  return out;
}

/** Applies a reset page (the newest page sent again). When the page starts at an item already shown,
 * everything before that item stays, so earlier pages the reader loaded survive; the page replaces the
 * rest. A page that shares nothing with what is shown replaces it all. `kept` says whether older
 * items were kept, in which case the page's own `more` no longer describes the list. */
export function resetItems(existing: readonly CliItem[], incoming: readonly CliItem[]): { items: CliItem[]; kept: boolean } {
  const page = dedupe(incoming);
  const at = page.length ? existing.findIndex((item) => item.id === page[0].id) : -1;
  if (at <= 0) return { items: page, kept: false };
  const fresh = new Set(page.map((item) => item.id));
  return { items: [...existing.slice(0, at).filter((item) => !fresh.has(item.id)), ...page], kept: true };
}

/** User messages in the list, to tell whether earlier turns are in view. */
export function userTurns(items: readonly CliItem[]): number {
  return items.reduce((count, item) => count + (normalizeCliTaskItem(item).kind === "user" ? 1 : 0), 0);
}

/** Puts an older page in front. Items already shown win over the page's copy. */
export function prependItems(existing: readonly CliItem[], older: readonly CliItem[]): CliItem[] {
  const shown = new Set(existing.map((item) => item.id));
  return [...dedupe(older).filter((item) => !shown.has(item.id)), ...existing];
}

function dedupe(items: readonly CliItem[]): CliItem[] {
  const seen = new Set<string>();
  const out: CliItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** Captured synchronously on the guide click. The tail can still grow in place
 * under the same native ID after the user speaks. */
export interface GuideMessage {
  id: string;
  text: string;
  at: number;
  uncertain?: boolean;
  known: ReadonlySet<string>;
  after?: string;
  tail?: Extract<CliItem, {kind: "assistant"}>;
}

export function guideTimeline(items: readonly CliItem[], guides: readonly GuideMessage[]): CliItem[] {
  if (!guides.length) return [...items];
  const echoes = new Set<string>();
  const rows: Array<{item: CliItem; rank: number}> = [];
  guides.forEach((guide, i) => {
    const boundary = guide.after ? items.findIndex(item => item.id === guide.after) : -1;
    const echo = items.find((item, index) => index > boundary && item.kind === "user" && item.text === guide.text &&
      !guide.known.has(item.id) && !echoes.has(item.id));
    if (echo) echoes.add(echo.id);
    rows.push({ item: { ...echo, kind: "user", id: echo?.id ?? "guide:" + guide.id, ts: guide.at, text: guide.text, queued: false }, rank: 2*i+1 });
  });
  for (const item of items) {
    if (echoes.has(item.id)) continue;
    const seen = guides.findIndex(guide => guide.known.has(item.id));
    let rank = 2 * (seen < 0 ? guides.length : seen);
    if (item.kind !== "assistant") { rows.push({ item, rank }); continue; }
    let offset = 0;
    let startAt = -Infinity;
    let id = item.id, ts = item.ts;
    for (const [i, guide] of guides.entries()) {
      const tail = guide.tail;
      if (tail?.id !== item.id || tail.text.length < offset || !item.text.startsWith(tail.text)) continue;
      if (tail.text.length > offset) {
        rows.push({ item: { ...item, id, ts: Math.min(guide.at, Math.max(startAt, tail.ts)), text: item.text.slice(offset, tail.text.length) }, rank });
      }
      offset = tail.text.length;
      id = "after-guide:" + guide.id;
      startAt = guide.at;
      ts = Math.max(item.ts, guide.at);
      rank = 2*i+2;
    }
    if (offset < item.text.length) rows.push({ item: { ...item, id, ts, text: item.text.slice(offset) }, rank });
  }
  // Keep the history that was already on screen in CLI record order. Only
  // the timeline from the first guide onward needs timestamp ordering.
  const first = guides[0];
  const before: CliItem[] = [];
  const after: typeof rows = [];
  for (const row of rows) {
    if (row.item.ts < first.at || first.known.has(row.item.id)) before.push(row.item);
    else after.push(row);
  }
  return before.concat(after.sort((a, b) => a.item.ts - b.item.ts || a.rank - b.rank).map(row => row.item));
}

export type Block =
  | { kind: "user"; id: string; item: Extract<CliItem, { kind: "user" }> }
  | { kind: "assistant"; id: string; item: Extract<CliItem, { kind: "assistant" }> }
  | { kind: "activity"; id: string; items: ActivityItem[] }
  | { kind: "notice"; id: string; level: "info" | "error"; text: string; /** a model call that failed for good */ failure?: boolean };

/** One block per user or assistant message, one per notice, and one block for
 * each run of adjacent tool calls and thinking. Turn markers only matter when
 * the turn was interrupted. */
export function groupItems(items: readonly CliItem[]): Block[] {
  const blocks: Block[] = [];
  for (const raw of items) {
    const item = normalizeCliTaskItem(raw);
    switch (item.kind) {
      case "user":
        // a `/model` switch and other commands leave bookkeeping records, not the user's words
        if (isCliCommandRecord(item.text)) break;
        blocks.push({ kind: "user", id: item.id, item });
        break;
      case "assistant":
        blocks.push({ kind: "assistant", id: item.id, item });
        break;
      case "tool":
      case "thinking": {
        const last = blocks[blocks.length - 1];
        if (last?.kind === "activity") last.items.push(item);
        else blocks.push({ kind: "activity", id: item.id, items: [item] });
        break;
      }
      case "notice": {
        if (!item.text) break;
        const previous = blocks.at(-1);
        if (item.level === "info" && item.text === "上下文已压缩" && previous?.kind === "notice" &&
            previous.level === item.level && previous.text === item.text) break;
        const reason = item.level === "error" ? modelFailureReason(item.text) : null;
        blocks.push(reason
          ? { kind: "notice", id: item.id, level: "error", text: "模型调用失败：" + reason, failure: true }
          : { kind: "notice", id: item.id, level: item.level, text: item.text });
        break;
      }
      case "turn":
        if (item.phase === "aborted") blocks.push({ kind: "notice", id: item.id, level: "info", text: "已中断" });
        break;
    }
  }
  return blocks;
}

export type TranscriptRow = Block | { kind: "progress"; id: string; blocks: Block[]; durationMs?: number };

function blockTsBounds(blocks: readonly Block[]): { first: number; last: number } {
  let first = 0, last = 0;
  const record = (ts: number) => {
    if (ts <= 0) return;
    if (first === 0 || ts < first) first = ts;
    if (ts > last) last = ts;
  };
  for (const block of blocks) {
    if (block.kind === "user" || block.kind === "assistant") record(block.item.ts);
    else if (block.kind === "activity") for (const item of block.items) record(item.ts);
  }
  return { first, last };
}

/** A recorded turn can contain steering messages. For older logs without turn
 * markers, the next user prompt or the session becoming idle closes the turn. */
export function transcriptRows(items: readonly CliItem[], active: boolean): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let pending: CliItem[] = [];
  let marked = false;
  let turnStart = 0;
  function flush(closed: boolean, aborted = false, turnEnd = 0) {
    const blocks = groupItems(pending);
    const openedAt = turnStart;
    pending = [];
    turnStart = 0;
    if (!closed) { rows.push(...blocks); return; }
    const last = blocks.at(-1);
    const interrupted = aborted || (last?.kind === "notice" && last.level === "error");
    const explicit = blocks.some(block => block.kind === "assistant" && block.item.replyPhase === "final");
    const tail = [...blocks].reverse().find(block => block.kind === "activity" || (block.kind === "assistant" && block.item.replyPhase !== "artifact"));
    let progress: Block[] = [];
    let anchorTs = openedAt > 0 ? openedAt : 0;
    function emitProgress(next?: Block) {
      if (!progress.length) return;
      const bounds = blockTsBounds(progress);
      const endTs = next?.kind === "assistant" && next.item.ts > 0 ? next.item.ts : (turnEnd > 0 ? turnEnd : bounds.last);
      const startTs = anchorTs > 0 && anchorTs <= endTs ? anchorTs : bounds.first;
      const durationMs = startTs > 0 && endTs > startTs ? endTs - startTs : undefined;
      rows.push({ kind: "progress", id: "progress:" + progress[progress.length - 1].id, blocks: progress, ...(durationMs ? { durationMs } : {}) });
      progress = [];
    }
    for (const block of blocks) {
      if (block.kind === "activity" || (block.kind === "assistant" && block.item.replyPhase !== "artifact" &&
          block.item.replyPhase !== "final" && (interrupted || explicit || block !== tail || block.item.replyPhase === "commentary"))) {
        progress.push(block);
      } else {
        emitProgress(block);
        rows.push(block);
        if ((block.kind === "user" || block.kind === "assistant") && block.item.ts > 0) anchorTs = block.item.ts;
      }
    }
    emitProgress();
  }
  for (const item of items) {
    if (item.kind === "turn") {
      flush(true, item.phase === "aborted", item.phase === "started" ? 0 : item.ts);
      marked = item.phase === "started";
      turnStart = item.phase === "started" && item.ts > 0 ? item.ts : 0;
      if (item.phase === "aborted") rows.push({ kind: "notice", id: item.id, level: "info", text: "已中断" });
    } else {
      if (!marked && item.kind === "user" && !item.queued && !item.id.startsWith("guide:")) flush(true);
      pending.push(item);
    }
  }
  flush(!active);
  return rows.filter((row, index) => {
    const previous = rows[index - 1];
    return !(row.kind === "notice" && row.level === "info" && row.text === "上下文已压缩" &&
      previous?.kind === "notice" && previous.level === row.level && previous.text === row.text);
  });
}

/** First line of a tool's input, cut for a one-line summary. */
export function toolSummary(input: string, max = 120): string {
  const line = input.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** What the activity disclosure needs: the step count, failures and whether
 * a tool is still running. Thinking counts as a step but never as running. */
export function activityStats(items: readonly ActivityItem[]) {
  const steps = items.map((item) => ({ tool_name: item.kind === "tool" ? item.name : "thinking", status: item.kind === "tool" && item.status === "error" ? "failed" : "ok" }));
  return { stepCount: items.length, steps, live: items.some((item) => item.kind === "tool" && item.status === "running") };
}

/** The id the next older page ends before, or undefined with nothing loaded. */
export function oldestId(items: readonly CliItem[]): string | undefined {
  return items[0]?.id;
}

/** The last assistant block of each reply: its conclusion. Only it carries copy and branch;
 * the text the agent wrote between its steps does not. */
export function replyTails(blocks: readonly Block[]): Set<string> {
  const tails = new Set<string>();
  let last: string | undefined;
  for (const block of blocks) {
    if (block.kind === "user") { if (last) tails.add(last); last = undefined; }
    else if (block.kind === "assistant") last = block.id;
  }
  if (last) tails.add(last);
  return tails;
}
