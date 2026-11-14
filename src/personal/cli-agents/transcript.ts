// Pure helpers for the conversation view: merging item pages and pushes by id,
// and grouping the flat item list into what the view renders.
import type { CliItem } from "../../../shared/cli-agents";

type ToolItem = Extract<CliItem, { kind: "tool" }>;
type ThinkingItem = Extract<CliItem, { kind: "thinking" }>;
export type ActivityItem = ToolItem | ThinkingItem;

/** Adds pushed items. An id already shown is replaced in place (a tool call
 * gains its output and status); a new id goes after the last item that is not
 * newer than it. `reset` swaps the whole list for the pushed one. */
export function mergeItems(existing: readonly CliItem[], incoming: readonly CliItem[], reset = false): CliItem[] {
  if (reset) return dedupe(incoming);
  const out = [...existing];
  const index = new Map(out.map((item, at) => [item.id, at]));
  for (const item of incoming) {
    const at = index.get(item.id);
    if (at !== undefined) { out[at] = item; continue; }
    let position = out.length;
    while (position > 0 && out[position - 1].ts > item.ts) position--;
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

export type Block =
  | { kind: "user"; id: string; item: Extract<CliItem, { kind: "user" }> }
  | { kind: "assistant"; id: string; item: Extract<CliItem, { kind: "assistant" }> }
  | { kind: "activity"; id: string; items: ActivityItem[] }
  | { kind: "notice"; id: string; level: "info" | "error"; text: string };

/** One block per user or assistant message, one per notice, and one block for
 * each run of adjacent tool calls and thinking. Turn markers only matter when
 * the turn was interrupted. */
export function groupItems(items: readonly CliItem[]): Block[] {
  const blocks: Block[] = [];
  for (const item of items) {
    switch (item.kind) {
      case "user":
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
      case "notice":
        blocks.push({ kind: "notice", id: item.id, level: item.level, text: item.text });
        break;
      case "turn":
        if (item.phase === "aborted") blocks.push({ kind: "notice", id: item.id, level: "info", text: "已中断" });
        break;
    }
  }
  return blocks;
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
