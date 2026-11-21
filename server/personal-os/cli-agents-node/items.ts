// Pure mappers from Claude Code / Codex transcript records to CliItem
// (plan 3.4). Nothing here touches the disk. Unknown record types are
// ignored, every text field is cut with truncateUtf8, and a tool result
// completes the matching running tool item through ctx.tools.
import {
  ITEM_TEXT_MAX,
  SUMMARY_MAX,
  TOOL_OUTPUT_MAX,
  truncateUtf8,
  type CliItem,
  type CliSessionWire,
} from "../../../shared/cli-agents.ts";

export type ToolItem = Extract<CliItem, { kind: "tool" }>;

/** How a message reaches a session that runs outside nex_bot's terminals. Device only: the socket
 * path and the key file location never go to Core, which only learns `sendVia`. */
export type SendRoute =
  | { via: "inbox"; configDir: string; pid: number; socketPath: string; sessionId: string }
  | { via: "daemon"; home: string; threadId: string }
  | { via: "host"; home: string; sessionId: string };

/** A Codex chat that exists only in the App's database (no rollout file). */
export interface AppChat {
  home: string;
  threadId: string;
}

/** A session row as the scanners and the discovery keep it on the computer.
 * `transcript` is the session file path (empty when none exists yet) and is
 * never sent to Core; neither are `route` and `appChat`. */
export type LocalSession = CliSessionWire & { transcript: string; route?: SendRoute; appChat?: AppChat };

/** Cuts to `max` UTF-16 units without splitting a surrogate pair (the wire
 * parsers cap strings in units). */
export function clipUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** Session-row fields a record can update. Metadata records produce only this. */
export interface RowUpdate {
  customTitle?: string;
  agentName?: string;
  mode?: string;
  prUrl?: string;
  model?: string;
}

export interface MappedRecord {
  items: CliItem[];
  row?: RowUpdate;
}

export interface ItemContext {
  /** file segment name, the stable prefix of ids without a native id */
  segment: string;
  /** byte offset of the line in its file */
  offset: number;
  /** Codex: the file carries event_msg/item_completed, so only those are used */
  codexV2?: boolean;
  /** timestamp used when a record has none */
  fallbackTs?: number;
  /** running tool items by tool_use_id / call_id. A result mutates the item in
   * place and returns it again, so callers that keep the map see the update. */
  tools?: Map<string, ToolItem>;
  /** emit the registered tool object itself instead of a copy (paging: later
   * results complete items that are already in the page) */
  shareTools?: boolean;
}

export const COMPACT_TEXT = "上下文已压缩";
const TOOL_INDEX_MAX = 2000;
const ID_MAX = 200;

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseTs(value: unknown, fallback: number | undefined): number {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms >= 0) return Math.trunc(ms);
  } else if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value < 1e11 ? value * 1000 : value);
  }
  return fallback ?? 0;
}

function clipId(id: string): string {
  return id.length > ID_MAX ? id.slice(0, ID_MAX) : id;
}

function fallbackId(ctx: ItemContext, suffix?: string | number): string {
  const base = `${ctx.segment}:${ctx.offset}`;
  return clipId(suffix === undefined ? base : `${base}:${suffix}`);
}

function itemText(text: string): string {
  return truncateUtf8(text, ITEM_TEXT_MAX);
}

function summary(text: string): string {
  return truncateUtf8(text, SUMMARY_MAX);
}

function output(text: string): string {
  return truncateUtf8(text, TOOL_OUTPUT_MAX);
}

function notice(id: string, ts: number, level: "info" | "error", text: string): CliItem {
  return { kind: "notice", id: clipId(id), ts, level, text: truncateUtf8(text, 4096) };
}

function registerTool(ctx: ItemContext, callId: string | undefined, item: ToolItem): void {
  if (!callId) return;
  const tools = (ctx.tools ??= new Map());
  tools.delete(callId);
  tools.set(callId, item);
  if (tools.size > TOOL_INDEX_MAX) {
    const oldest = tools.keys().next().value;
    if (oldest !== undefined) tools.delete(oldest);
  }
}

/** Completes a registered tool item in place. Returns it (a copy unless
 * ctx.shareTools), or null when unknown. */
function completeTool(ctx: ItemContext, callId: string | undefined, status: "ok" | "error", text: string | undefined): ToolItem | null {
  if (!callId) return null;
  const tool = ctx.tools?.get(callId);
  if (!tool) return null;
  tool.status = status;
  if (text !== undefined && text !== "") tool.output = output(text);
  return ctx.shareTools ? tool : { ...tool };
}

/** One short line for a tool call's arguments, at most SUMMARY_MAX bytes. */
export function summarizeInput(input: unknown): string {
  if (typeof input === "string") return summary(input);
  if (!isRec(input)) return input === undefined || input === null ? "" : summary(String(input));
  if (input.run_in_background === true) {
    const command = typeof input.command === "string" ? truncateUtf8(input.command, 200) : undefined;
    const title = input.description ?? input.prompt;
    const description = typeof title === "string" ? truncateUtf8(title, 200) : undefined;
    if (command || description) return summary(JSON.stringify({ run_in_background: true, command, description }));
  }
  if (typeof input.subject === "string" && typeof input.description === "string") {
    return summary(JSON.stringify({ subject: truncateUtf8(input.subject, 200), taskId: input.taskId, status: input.status }));
  }
  // a sub-agent call names its task (Claude's Agent `description`, Codex's spawn_agent `task_name`);
  // `prompt` and `message` are the whole brief
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "task_name", "description", "prompt"]) {
    const value = input[key];
    if (typeof value === "string" && value) return summary(value);
    if (key === "command" && Array.isArray(value) && value.every((part) => typeof part === "string")) return summary(value.join(" "));
  }
  try {
    return summary(JSON.stringify(input) ?? "");
  } catch {
    return "";
  }
}

function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Text of a message.content-like value: a string, or text-ish blocks. */
function blocksText(content: unknown, imagePlaceholder = false): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (isRec(block)) {
      const text = asStr(block.text);
      if (text !== undefined && (block.type === undefined || /text/i.test(String(block.type)))) parts.push(text);
      else if (imagePlaceholder && typeof block.type === "string" && /image/i.test(block.type)) parts.push("[image]");
    }
  }
  return parts.join("\n");
}

const IMAGE_SOURCE_RE = /\[Image(?: #\d+)?: source: ([^\]\n]+)\]/g;

/** Pulls `[Image: source: <path>]` markers out of text. */
function extractImagePaths(text: string): { text: string; images: string[] } {
  const images: string[] = [];
  const cleaned = text.replace(IMAGE_SOURCE_RE, (_m, p: string) => {
    images.push(p.trim());
    return "";
  });
  return { text: images.length > 0 ? cleaned.trim() : text, images };
}

// ---------------------------------------------------------------------------
// Claude

export function claudeRecordToItems(record: unknown, ctx: ItemContext): MappedRecord {
  const none: MappedRecord = { items: [] };
  if (!isRec(record)) return none;
  const type = asStr(record.type);
  if (!type) return none;

  switch (type) {
    case "custom-title": {
      const customTitle = nonEmpty(record.customTitle);
      return customTitle ? { items: [], row: { customTitle } } : none;
    }
    case "agent-name": {
      const agentName = nonEmpty(record.agentName);
      return agentName ? { items: [], row: { agentName } } : none;
    }
    case "mode": {
      const mode = nonEmpty(record.mode);
      return mode ? { items: [], row: { mode } } : none;
    }
    case "pr-link": {
      const prUrl = nonEmpty(record.prUrl) ?? nonEmpty(record.url);
      return prUrl ? { items: [], row: { prUrl } } : none;
    }
    case "user":
    case "assistant":
    case "system":
    case "attachment":
      break;
    default:
      return none; // queue-operation, last-prompt, file-history-*, api-request*, cost-state, ...
  }

  if (record.isSidechain === true) return none; // sub-agent records
  const ts = parseTs(record.timestamp, ctx.fallbackTs);
  const uuid = nonEmpty(record.uuid);
  const baseId = clipId(uuid ?? fallbackId(ctx));
  const message = isRec(record.message) ? record.message : undefined;

  if (type === "user") {
    if (record.isCompactSummary === true) return { items: [notice(baseId, ts, "info", COMPACT_TEXT)] };
    if (record.isMeta === true) {
      const text = blocksText(message?.content);
      return text.trimStart().startsWith("<task-notification>") ? { items: [notice(baseId, ts, "info", text)] } : none;
    }
    return { items: claudeUser(record, message, ctx, baseId, ts) };
  }

  if (type === "assistant") return claudeAssistant(record, message, ctx, uuid, ts);

  if (type === "attachment") {
    const attachment = isRec(record.attachment) ? record.attachment : undefined;
    if (attachment?.type === "task_notification" && typeof attachment.taskId === "string" && typeof attachment.status === "string") {
      return { items: [notice(baseId, ts, "info", `<task-notification><task-id>${attachment.taskId}</task-id><status>${attachment.status}</status></task-notification>`)] };
    }
    if (!attachment || attachment.type !== "queued_command") return none;
    const raw = attachment.prompt ?? attachment.content ?? attachment.text;
    const text = blocksText(raw);
    if (!text.trim()) return none;
    return { items: [{ kind: "user", id: baseId, ts, text: itemText(text), queued: true }] };
  }

  // system
  const subtype = asStr(record.subtype);
  if (subtype === "api_error") {
    return { items: [notice(baseId, ts, "error", systemErrorText(record))] };
  }
  if (subtype === "compact_boundary") {
    return { items: [notice(baseId, ts, "info", COMPACT_TEXT)] };
  }
  if (subtype === "local_command") {
    const text = stripTags(asStr(record.content) ?? blocksText(record.content));
    if (!text) return none;
    return { items: [notice(baseId, ts, "info", text)] };
  }
  return none;
}

function stripTags(text: string): string {
  return text
    .replace(/<\/?[a-z][\w-]*>/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function systemErrorText(record: Rec): string {
  const direct = nonEmpty(record.content) ?? nonEmpty(record.message);
  if (direct) return direct;
  const error = record.error;
  if (typeof error === "string") return error;
  if (isRec(error)) {
    const inner = isRec(error.error) ? error.error : undefined;
    const innerMessage = inner && isRec(inner.error) ? asStr(inner.error.message) : undefined;
    const text = innerMessage ?? asStr(inner?.message) ?? asStr(error.message) ?? (typeof error.status === "number" ? `HTTP ${error.status}` : undefined);
    if (text) return text;
  }
  return "API error";
}

function claudeUser(record: Rec, message: Rec | undefined, ctx: ItemContext, baseId: string, ts: number): CliItem[] {
  const content = message?.content;
  const out: CliItem[] = [];
  const texts: string[] = [];
  const images: string[] = [];
  let sawImage = false;

  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRec(block)) continue;
      switch (block.type) {
        case "text":
          if (typeof block.text === "string") texts.push(block.text);
          break;
        case "image": {
          sawImage = true;
          const source = isRec(block.source) ? block.source : undefined;
          const path = nonEmpty(source?.path) ?? nonEmpty(block.path) ?? (source?.type === "file" ? nonEmpty(source.file_path) : undefined);
          if (path) images.push(path);
          break;
        }
        case "tool_result": {
          const id = asStr(block.tool_use_id);
          const text = blocksText(block.content, true);
          const tool = completeTool(ctx, id, block.is_error === true ? "error" : "ok", text);
          if (tool) out.push(tool);
          break;
        }
        default:
          break;
      }
    }
  }

  let text = texts.join("\n\n");
  const extracted = extractImagePaths(text);
  text = extracted.text;
  images.push(...extracted.images);
  if (text.trim() === "" && images.length === 0 && sawImage) text = "[image]";
  if (text.trim() !== "" || images.length > 0) {
    const user: CliItem = { kind: "user", id: baseId, ts, text: itemText(text) };
    if (images.length > 0) user.images = images.slice(0, 20);
    if (record.isQueued === true) user.queued = true;
    out.unshift(user);
  }
  return out;
}

function claudeAssistant(record: Rec, message: Rec | undefined, ctx: ItemContext, uuid: string | undefined, ts: number): MappedRecord {
  const row: RowUpdate = {};
  const model = nonEmpty(message?.model);
  if (model && !model.startsWith("<")) row.model = model;
  const result = (items: CliItem[]): MappedRecord => (row.model ? { items, row } : { items });
  const content = message?.content;
  const idFor = (index: number) => clipId(uuid ? `${uuid}:${index}` : fallbackId(ctx, index));

  if (record.isApiErrorMessage === true) {
    const text = blocksText(content) || "API error";
    return result([notice(idFor(0), ts, "error", text)]);
  }
  const blocks: unknown[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const items: CliItem[] = [];
  blocks.forEach((block, index) => {
    if (!isRec(block)) return;
    switch (block.type) {
      case "text": {
        const text = asStr(block.text);
        if (text && text.trim()) items.push({ kind: "assistant", id: idFor(index), ts, text: itemText(text) });
        break;
      }
      case "thinking": {
        const text = asStr(block.thinking) ?? asStr(block.text);
        if (text && text.trim()) items.push({ kind: "thinking", id: idFor(index), ts, text: summary(text) });
        break;
      }
      case "tool_use": {
        const name = asStr(block.name) ?? "tool";
        const tool: ToolItem = {
          kind: "tool",
          id: idFor(index),
          ts,
          name: truncateUtf8(name, 200),
          input: summarizeInput(block.input),
          status: "running",
        };
        registerTool(ctx, asStr(block.id), tool);
        items.push(ctx.shareTools ? tool : { ...tool });
        break;
      }
      default:
        break;
    }
  });
  return result(items);
}

// ---------------------------------------------------------------------------
// Codex

/** Returns the lower-cased type with separators removed: `UserMessage`,
 * `user_message` and `userMessage` all become `usermessage`. */
function norm(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[_-]/g, "") : "";
}

const CODEX_INJECTED_USER = /^\s*(<environment_context>|<user_instructions>|<turn_aborted>|<permissions instructions>|# AGENTS\.md instructions|<INSTRUCTIONS>)/;

export function codexRecordToItems(record: unknown, ctx: ItemContext): MappedRecord {
  const none: MappedRecord = { items: [] };
  if (!isRec(record)) return none;
  const type = asStr(record.type);
  const payload = isRec(record.payload) ? record.payload : undefined;
  if (!type || !payload) return none;
  const ts = parseTs(record.timestamp, ctx.fallbackTs);

  switch (type) {
    case "turn_context": {
      const model = nonEmpty(payload.model);
      return model ? { items: [], row: { model } } : none;
    }
    case "compacted":
      return { items: [notice(fallbackId(ctx), ts, "info", COMPACT_TEXT)] };
    case "event_msg":
      return codexEvent(payload, ctx, ts);
    case "response_item":
      return ctx.codexV2 ? none : codexResponseItem(payload, ctx, ts);
    default:
      return none; // session_meta, world_state, unknown
  }
}

function codexEvent(payload: Rec, ctx: ItemContext, ts: number): MappedRecord {
  const none: MappedRecord = { items: [] };
  const kind = asStr(payload.type);
  switch (kind) {
    case "task_started":
    case "task_complete":
    case "turn_aborted": {
      const phase = kind === "task_started" ? "started" : kind === "task_complete" ? "ended" : "aborted";
      const turnId = nonEmpty(payload.turn_id);
      return { items: [{ kind: "turn", id: clipId(turnId ? `${turnId}:${phase}` : fallbackId(ctx)), ts, phase }] };
    }
    case "context_compacted":
      return { items: [notice(fallbackId(ctx), ts, "info", COMPACT_TEXT)] };
    case "item_completed":
      return ctx.codexV2 && isRec(payload.item) ? codexThreadItem(payload.item, ctx, ts) : none;
    default:
      return none; // agent_message, user_message, token_count, ...
  }
}

function codexToolStatus(item: Rec): "running" | "ok" | "error" {
  const status = norm(item.status);
  if (status === "failed" || status === "error" || status === "declined" || status === "cancelled") return "error";
  if (status === "inprogress" || status === "running" || status === "pending") return "running";
  const exit = item.exit_code ?? item.exitCode;
  if (typeof exit === "number" && exit !== 0) return "error";
  return "ok";
}

function codexUserText(item: Rec): { text: string; images: string[] } {
  const images: string[] = [];
  const texts: string[] = [];
  const content = item.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRec(part)) continue;
      const t = norm(part.type);
      if (t === "text" || t === "inputtext") {
        const text = asStr(part.text);
        if (text) texts.push(text);
      } else if (t === "localimage") {
        const path = nonEmpty(part.path);
        if (path) images.push(path);
      }
    }
  } else if (typeof item.message === "string") {
    texts.push(item.message);
  } else if (typeof item.text === "string") {
    texts.push(item.text);
  }
  return { text: texts.join("\n\n"), images };
}

function codexAgentText(item: Rec): string {
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  return blocksText(item.content);
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") out.push(entry);
    else if (isRec(entry) && typeof entry.text === "string") out.push(entry.text);
  }
  return out;
}

function codexThreadItem(item: Rec, ctx: ItemContext, ts: number): MappedRecord {
  const none: MappedRecord = { items: [] };
  const kind = norm(item.type);
  const nativeId = nonEmpty(item.id);
  const id = clipId(nativeId ?? fallbackId(ctx));
  switch (kind) {
    case "usermessage": {
      const { text, images } = codexUserText(item);
      if (text.trim() === "" && images.length === 0) return none;
      const user: CliItem = { kind: "user", id, ts, text: itemText(text) };
      if (images.length > 0) user.images = images.slice(0, 20);
      return { items: [user] };
    }
    case "agentmessage": {
      const text = codexAgentText(item);
      return text.trim() ? { items: [{ kind: "assistant", id, ts, text: itemText(text) }] } : none;
    }
    case "reasoning": {
      const parts = [...stringList(item.summary_text), ...stringList(item.summary)];
      const text = parts.join("\n").trim() || [...stringList(item.content), ...stringList(item.raw_content)].join("\n").trim();
      return text ? { items: [{ kind: "thinking", id, ts, text: summary(text) }] } : none;
    }
    case "commandexecution": {
      const command = item.command;
      const out = asStr(item.aggregated_output) ?? asStr(item.aggregatedOutput) ?? asStr(item.output) ?? asStr(item.stdout);
      return { items: [codexTool(id, ts, "shell", summarizeInput({ command }), codexToolStatus(item), out)] };
    }
    case "mcptoolcall": {
      const server = asStr(item.server);
      const tool = asStr(item.tool) ?? asStr(item.name) ?? "tool";
      const name = server ? `${server}.${tool}` : tool;
      const err = isRec(item.error) ? (asStr(item.error.message) ?? jsonText(item.error)) : asStr(item.error);
      const text = err ?? (item.result === undefined || item.result === null ? undefined : jsonText(item.result));
      const status = err ? "error" : codexToolStatus(item);
      return { items: [codexTool(id, ts, name, summarizeInput(item.arguments ?? item.input), status, text)] };
    }
    case "filechange": {
      const changes: Rec[] = Array.isArray(item.changes) ? item.changes.filter(isRec) : isRec(item.changes) ? Object.entries(item.changes).map(([path, change]) => ({ path, ...(isRec(change) ? change : {}) })) : [];
      const paths = changes.map((c) => asStr(c.path)).filter((p): p is string => !!p);
      const diffs = changes.map((c) => asStr(c.diff) ?? asStr(c.unified_diff) ?? asStr(c.content)).filter((d): d is string => !!d);
      return { items: [codexTool(id, ts, "apply_patch", summary(paths.join("\n")), codexToolStatus(item), diffs.join("\n") || undefined)] };
    }
    case "imageview":
      return { items: [codexTool(id, ts, "view_image", summarizeInput(item.path ?? item.image_path), codexToolStatus(item), undefined)] };
    case "extension": {
      const name = asStr(item.name) ?? asStr(item.tool) ?? asStr(item.extension) ?? "extension";
      return { items: [codexTool(id, ts, name, summarizeInput(item.arguments ?? item.input ?? item.params), codexToolStatus(item), item.output === undefined ? undefined : jsonText(item.output))] };
    }
    case "contextcompaction":
      return { items: [notice(id, ts, "info", COMPACT_TEXT)] };
    case "subagentactivity": {
      const label = asStr(item.description) ?? asStr(item.name) ?? asStr(item.agent_name) ?? asStr(item.status) ?? "";
      if (item.status) return { items: [codexTool(id, ts, "Agent", summary(label), codexToolStatus(item), undefined)] };
      return { items: [notice(id, ts, "info", label ? `子 Agent：${label}` : "子 Agent 活动")] };
    }
    default:
      return none;
  }
}

/** One Codex v2 thread item (the App's database rows and the shared daemon's notifications) as items. */
export function codexThreadItemToItems(item: unknown, ctx: ItemContext, ts: number): CliItem[] {
  return isRec(item) ? codexThreadItem(item, { ...ctx, codexV2: true }, ts).items : [];
}

function codexTool(id: string, ts: number, name: string, input: string, status: "running" | "ok" | "error", text: string | undefined): ToolItem {
  const tool: ToolItem = { kind: "tool", id, ts, name: truncateUtf8(name, 200), input, status };
  if (text !== undefined && text !== "") tool.output = output(text);
  return tool;
}

function codexResponseItem(payload: Rec, ctx: ItemContext, ts: number): MappedRecord {
  const none: MappedRecord = { items: [] };
  const kind = asStr(payload.type);
  const nativeId = nonEmpty(payload.id);
  const id = clipId(nativeId ?? fallbackId(ctx));
  switch (kind) {
    case "message": {
      const role = payload.role;
      if (role !== "user" && role !== "assistant") return none;
      const content = Array.isArray(payload.content) ? payload.content : [];
      const texts: string[] = [];
      const images: string[] = [];
      for (const part of content) {
        if (!isRec(part)) continue;
        const t = norm(part.type);
        if ((t === "inputtext" || t === "outputtext" || t === "text") && typeof part.text === "string") texts.push(part.text);
        else if (t === "localimage" && nonEmpty(part.path)) images.push(String(part.path));
      }
      const text = texts.join("\n\n");
      if (role === "user") {
        if (CODEX_INJECTED_USER.test(text)) return none;
        if (text.trim() === "" && images.length === 0) return none;
        const user: CliItem = { kind: "user", id, ts, text: itemText(text) };
        if (images.length > 0) user.images = images.slice(0, 20);
        return { items: [user] };
      }
      return text.trim() ? { items: [{ kind: "assistant", id, ts, text: itemText(text) }] } : none;
    }
    case "reasoning": {
      const text = stringList(payload.summary).join("\n").trim();
      return text ? { items: [{ kind: "thinking", id, ts, text: summary(text) }] } : none;
    }
    case "function_call":
    case "custom_tool_call":
    case "local_shell_call": {
      const callId = nonEmpty(payload.call_id) ?? nativeId;
      let input: unknown = payload.arguments ?? payload.input;
      if (kind === "local_shell_call") input = isRec(payload.action) ? payload.action : input;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          // keep the raw string
        }
      }
      const name = kind === "local_shell_call" ? "shell" : (asStr(payload.name) ?? "tool");
      const tool: ToolItem = {
        kind: "tool",
        id: clipId(callId ?? fallbackId(ctx)),
        ts,
        name: truncateUtf8(name, 200),
        input: summarizeInput(input),
        status: "running",
      };
      registerTool(ctx, callId, tool);
      return { items: [ctx.shareTools ? tool : { ...tool }] };
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const callId = nonEmpty(payload.call_id);
      const { text, failed } = codexOutputText(payload.output);
      const tool = completeTool(ctx, callId, failed ? "error" : "ok", text);
      return tool ? { items: [tool] } : none;
    }
    case "web_search_call": {
      const action = isRec(payload.action) ? payload.action : undefined;
      const query = asStr(action?.query) ?? asStr(payload.query) ?? "";
      const status = codexToolStatus(payload);
      return { items: [codexTool(id, ts, "web_search", summary(query), status, undefined)] };
    }
    default:
      return none;
  }
}

/** Function outputs are a string, often JSON `{output, metadata:{exit_code}}`,
 * or `{content, success}`. */
function codexOutputText(value: unknown): { text: string; failed: boolean } {
  let data: unknown = value;
  if (typeof value === "string") {
    if (value.trimStart().startsWith("{")) {
      try {
        data = JSON.parse(value);
      } catch {
        return { text: value, failed: false };
      }
    } else return { text: value, failed: false };
  }
  if (isRec(data)) {
    const text = asStr(data.output) ?? asStr(data.content) ?? blocksText(data.content) ?? "";
    const metadata = isRec(data.metadata) ? data.metadata : undefined;
    const exit = metadata?.exit_code ?? data.exit_code;
    const failed = data.success === false || (typeof exit === "number" && exit !== 0);
    return { text: text || jsonText(data), failed };
  }
  return { text: jsonText(data), failed: false };
}
