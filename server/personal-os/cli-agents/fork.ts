// "Fork to topic" (design section 9): hands an Agent session's recent
// conversation to an assistant, as a new private topic it can carry on from.
// The session itself is not touched. Only a text digest crosses over: what the
// user and the CLI said and which tools it used, never tool input or output.
import { randomUUID } from "node:crypto";
import type { CliItem } from "../../../shared/cli-agents.ts";
import { CliOpError, type CliAgentHub } from "./hub.ts";

export const FORK_SUMMARY_LIMIT = 8000;
const ITEM_LIMIT = 2000;
const MAX_PAGES = 3;

function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max - 1;
  // do not leave half a surrogate pair at the cut
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

/** A text digest of a transcript, newest first, at most `FORK_SUMMARY_LIMIT`
 * characters. `items` are in transcript order (oldest first). Runs of tool
 * calls fold into one line of names. Thinking, notices and turn markers are
 * left out. When the room runs out the oldest lines are the ones dropped. */
export function summarizeForTopic(items: readonly CliItem[], limit = FORK_SUMMARY_LIMIT): string {
  const lines: string[] = [];
  let tools: Map<string, number> | null = null;
  const flush = () => {
    if (!tools) return;
    lines.push(`工具：${[...tools].map(([name, count]) => (count > 1 ? `${name}×${count}` : name)).join("、")}`);
    tools = null;
  };
  // walk newest to oldest so the digest reads newest first
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "tool") {
      tools ??= new Map();
      tools.set(item.name, (tools.get(item.name) ?? 0) + 1);
      continue;
    }
    if (item.kind !== "user" && item.kind !== "assistant") continue;
    const body = item.text.trim();
    if (!body) continue;
    flush();
    lines.push(`${item.kind === "user" ? "用户" : "助手"}：${cut(body, ITEM_LIMIT)}`);
  }
  flush();
  let out = "";
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length > limit) {
      if (!out) out = cut(line, limit);
      break;
    }
    out = next;
  }
  return out;
}

/** The slice of the agent module a fork needs. */
export interface ForkAgents {
  createTopic(botId: string, options: { title: string; audience: "private" | "public"; sourceContext?: Record<string, unknown>; branchContext?: string }): { conversationId: string };
  send(
    botId: string,
    content: string,
    clientId: string,
    sessionId: string | undefined,
    options: { conversationId?: string; audience?: "private" | "public"; sourceContext?: Record<string, unknown> },
  ): { conversationId: string };
}

export interface ForkResult {
  botId: string;
  conversationId: string;
}

export async function forkToTopic(hub: CliAgentHub, agents: ForkAgents, actor: string, key: string, botId: string, itemId?: string): Promise<ForkResult> {
  const session = hub.session(key);
  if (!session) throw new CliOpError("not_found");
  // up to a few pages, newest first, until the digest has all it can hold
  let items: CliItem[] = [];
  let before: string | undefined;
  if (itemId !== undefined) {
    const reply = hub.cachedReply(key, itemId);
    if (reply) {
      items = [reply];
    } else {
      // An older message may be visible on a client after it has left Core's cache.
      // Walk the device's pages without retaining messages after the branch point.
      const cursors = new Set<string>();
      do {
        const result = await hub.items(actor, key, before);
        const index = result.items.findIndex(item => item.id === itemId);
        if (index !== -1) {
          if (result.items[index].kind !== "assistant") break;
          items = result.items.slice(0, index + 1);
          break;
        }
        const next = result.items[0]?.id;
        if (!result.more || !next || cursors.has(next)) break;
        cursors.add(next);
        before = next;
      } while (before !== undefined);
      if (!items.length) throw new CliOpError("not_found", "找不到这条回复");
    }
    before = items[0].id;
  }
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await hub.items(actor, key, before);
    items = [...result.items, ...items];
    if (!result.more || !result.items.length || summarizeForTopic(items).length >= FORK_SUMMARY_LIMIT) break;
    before = result.items[0].id;
  }
  const summary = summarizeForTopic(items);
  if (!summary) throw new CliOpError("not_found", "no transcript to hand over");
  const title = session.title.trim() || session.cwd;
  const sourceContext = { kind: "cli-agent", key, engine: session.engine, title: cut(title, 200), cwd: cut(session.cwd, 1000), ...(itemId ? { itemId } : {}) };
  const topicOptions = { title: cut(`Agent：${title}`, 120), audience: "private" as const, sourceContext };
  const context = `这是从 Agent 会话「${cut(title, 200)}」（${cut(session.cwd, 1000)}）分出来的对话摘要，最新的在前。`;
  if (itemId !== undefined) {
    const topic = agents.createTopic(botId, { ...topicOptions, branchContext: `${context}\n\n${summary}` });
    return { botId, conversationId: topic.conversationId };
  }
  const topic = agents.createTopic(botId, topicOptions);
  const content = `${context}原会话保持不动，请接着处理。\n\n${summary}`;
  const sent = agents.send(botId, content, `cli-fork:${randomUUID()}`, actor, { conversationId: topic.conversationId, audience: "private", sourceContext });
  return { botId, conversationId: sent.conversationId };
}
