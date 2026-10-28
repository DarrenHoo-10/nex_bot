import type { FileEntry } from '@earendil-works/pi-coding-agent';
import { isImagePart, tokens } from './token-estimate.ts';
import { TARGET_SHARE, modelInputBudget, workingContextBudget } from './model-limits.ts';
import { brokerDeclaration, brokerDescription, brokerParameters } from './broker-tool.ts';

/** Text retrieval never turns image bytes back into a huge text token bill. */
export function entryText(entry: FileEntry): string {
  return JSON.stringify(entry, (_key, value) => isImagePart(value)
    ? { type: 'text', text: '[图片原文保留；查看图片请重新读取原附件或设备文件]' }
    : value);
}

export function entryPage(id: string, content: string, offset = 0, limit = 12000) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length) throw new Error('原文分页 offset 超出范围');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000) throw new Error('原文分页 limit 须为 1 至 100000');
  const end = Math.min(content.length, offset + limit);
  return { id, content: content.slice(offset, end), page: { offset, length: end - offset, totalChars: content.length, nextOffset: end < content.length ? end : null } };
}

type SystemEntry = Extract<FileEntry, { type: 'message' }>;
const isSystem = (entry: FileEntry): entry is SystemEntry => entry.type === 'message' && entry.message.role === 'system';
/** Core's own system messages carry the prompt text; the SDK's tool and section declarations have empty content. */
export const systemPromptText = (entry: FileEntry | undefined) => entry && isSystem(entry) && entry.message.role === 'system' && typeof entry.message.content === 'string' ? entry.message.content : '';

/**
 * Older projections hold a prompt-bearing system entry per worker start. They are
 * never sent (every request replaces the system message) and never read by
 * entry:<id>, so all but the newest prompt and the newest SDK declaration are
 * dropped. Entries that a compaction or edit still names stay. Children are
 * re-parented to the nearest kept ancestor; ids of every other entry are unchanged.
 */
export function dropStaleSystemEntries(entries: FileEntry[]): FileEntry[] {
  const keep = new Set<string>();
  for (const prompt of [true, false]) {
    const newest = entries.findLast((entry) => isSystem(entry) && !!systemPromptText(entry) === prompt);
    if (newest?.type !== 'session' && newest) keep.add(newest.id);
  }
  for (const entry of entries) {
    if (entry.type === 'compaction') {
      const details = entry.details as { sourceFirst?: string; sourceLast?: string } | undefined;
      for (const id of [entry.firstKeptEntryId, details?.sourceFirst, details?.sourceLast]) if (id) keep.add(id);
    } else if (entry.type === 'context_edit' || entry.type === 'label') keep.add(entry.targetId);
    else if (entry.type === 'branch_summary') keep.add(entry.fromId);
  }
  const dropped = new Map<string, string | null>();
  for (const entry of entries) if (isSystem(entry) && !keep.has(entry.id)) dropped.set(entry.id, entry.parentId);
  if (!dropped.size) return entries;
  const ancestor = (id: string | null): string | null => { while (id && dropped.has(id)) id = dropped.get(id)!; return id; };
  return entries.flatMap((entry) => entry.type !== 'session' && dropped.has(entry.id) ? [] : [entry.type !== 'session' && entry.parentId && dropped.has(entry.parentId) ? { ...entry, parentId: ancestor(entry.parentId) } : entry]);
}

// ---------------------------------------------------------------------------------------------
// Context reduction, shared by the worker (turn start and background maintenance) and by Core
// (deciding whether maintenance has work). Everything here is pure and free of Core state; the
// SDK-free projection below mirrors buildSessionProjection of the Pi SDK (pinned by a test), so
// Core never has to load the SDK to look at a stored projection.
// ---------------------------------------------------------------------------------------------

type Entry = Exclude<FileEntry, { type: 'session' }>;
export type ContextMessage = { role: string; content?: unknown; toolCallId?: string; isError?: boolean };
export interface ProjectedItem { sourceEntry: FileEntry; messages: ContextMessage[] }

/** A user turn begins at an input, a replayed user row of earlier history, or a user message. */
export const isTurnStart = (entry: FileEntry) => (entry.type === 'custom_message' && (entry.customType === 'nex.input' || entry.customType === 'nex.history' && String(entry.content).includes('"role":"user"'))) || (entry.type === 'message' && entry.message.role === 'user');
/** A reduction digests tool results above this many text tokens (images excluded) of turns older than the latest completed one. */
export const DIGEST_TOKENS = 4000;
/** Fixed request overhead (tool framing, provider wrappers) added to every estimate. */
export const CONTEXT_OVERHEAD = 2500;
/** A context above the soft threshold is reduced in the background only once the conversation has been idle this long (the cache is cold by then). */
export const MAINTAIN_IDLE_MS = 55 * 60_000;
/** The message of a summarizer request whose output was cut at its token cap, so the worker can split the batch and retry. */
export const OUTPUT_TRUNCATED = '压缩输出被截断';
/** Failure-record keys: one tool result, or the range of a history batch (first source entry of the fold to the last of the batch). */
export const entryTarget = (id: string) => `entry:${id}`;
export const rangeTarget = (first: string, last: string) => `range:${first}..${last}`;

/** The active branch: the chain of parents from the last entry. */
export function branchOf(entries: FileEntry[]): Entry[] {
  const body = entries.filter((entry): entry is Entry => entry.type !== 'session');
  const byId = new Map(body.map((entry) => [entry.id, entry]));
  const path: Entry[] = [], seen = new Set<string>();
  for (let current = body.at(-1); current && !seen.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) { seen.add(current.id); path.push(current); }
  return path.reverse();
}

/**
 * The entry an episode really starts at, given the first entry of its context. A summary compaction
 * leads the context after a turn summary or a maintenance fold: the walk follows its sourceFirst back to
 * the original entry. A compaction that closed a previous episode (details.episode) ends the walk at its
 * first kept entry, which is where the next episode begins.
 */
export function episodeStart(entries: FileEntry[], leading: FileEntry): string {
  const byId = new Map(entries.flatMap((entry) => entry.type === 'session' ? [] : [[entry.id, entry] as const]));
  let current: FileEntry = leading;
  for (let step = 0; step < 64 && current.type === 'compaction'; step++) {
    const details = current.details as { sourceFirst?: string; episode?: string } | undefined;
    if (details?.episode) return current.firstKeptEntryId;
    const next = details?.sourceFirst ? byId.get(details.sourceFirst) : undefined;
    if (!next) break;
    current = next;
  }
  // The prompt's system messages precede the first input; they are no part of the episode.
  let index = entries.findIndex((entry) => entry.type !== 'session' && entry.id === current.id);
  while (index >= 0 && index < entries.length - 1 && isSystem(entries[index])) index++;
  return index < 0 ? current.id : (entries[index] as Entry).id;
}

/** The compaction-aware entries that make up the model context (SDK buildContextEntries). */
export function contextEntries(entries: FileEntry[]): Entry[] {
  const path = branchOf(entries);
  const compaction = path.findLast((entry) => entry.type === 'compaction');
  if (compaction?.type !== 'compaction') return path;
  const at = path.indexOf(compaction), result: Entry[] = [compaction];
  let kept = false;
  for (let index = 0; index < at; index++) {
    const entry = path[index];
    if (entry.id === compaction.firstKeptEntryId) kept = true;
    if (kept && !(entry.type === 'message' && entry.message.role === 'system')) result.push(entry);
  }
  return [...result, ...path.slice(at + 1)];
}

function entryMessages(entry: Entry): ContextMessage[] {
  const time = (value: string) => new Date(value).getTime();
  if (entry.type === 'message') {
    const message = entry.message as ContextMessage;
    if (message.content == null) return message.role === 'system' ? [{ ...message, content: '' }] : ['user', 'assistant', 'toolResult'].includes(message.role) ? [{ ...message, content: [] }] : [message];
    return [message];
  }
  if (entry.type === 'custom_message') return [{ role: 'custom', customType: entry.customType, content: entry.content ?? [], display: entry.display, details: entry.details, timestamp: time(entry.timestamp) } as ContextMessage];
  if (entry.type === 'branch_summary' && entry.summary) return [{ role: 'branchSummary', summary: entry.summary, fromId: entry.fromId, timestamp: time(entry.timestamp) } as ContextMessage];
  if (entry.type === 'compaction') {
    const summary = { role: 'compactionSummary', summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp: time(entry.timestamp) } as ContextMessage;
    return entry.systemMessage ? [entry.systemMessage as ContextMessage, summary] : [summary];
  }
  return [];
}

/** Each context entry with the messages it contributes after context edits (SDK buildSessionProjection().entries). */
export function projectEntries(entries: FileEntry[]): ProjectedItem[] {
  const list = contextEntries(entries), edits = new Map<string, Extract<Entry, { type: 'context_edit' }>>();
  for (const entry of list) if (entry.type === 'context_edit') edits.set(entry.targetId, entry);
  return list.map((sourceEntry, index) => {
    const messages = sourceEntry.type === 'compaction' && index > 0 ? [] : entryMessages(sourceEntry), edit = edits.get(sourceEntry.id);
    if (!edit) return { sourceEntry, messages };
    const replacement = edit.replacement;
    return { sourceEntry, messages: replacement === null ? [] : messages.map((message) => !['user', 'assistant', 'toolResult', 'custom'].includes(message.role) ? message : { ...message, content: (message.role === 'assistant' || message.role === 'toolResult') && typeof replacement.content === 'string' ? [{ type: 'text', text: replacement.content }] : replacement.content }) };
  });
}

/** Ids of entries that already carry a context edit on this branch. */
export const editedTargets = (branch: Iterable<FileEntry>) => new Set([...branch].flatMap((entry) => entry.type === 'context_edit' ? [entry.targetId] : []));

/**
 * Entry ids older than the latest completed turn, i.e. the entries whose large tool results and images no
 * longer stay in context in full. At the start of a turn that is the turn before the new input; `next`
 * asks the same question for a turn that has not arrived yet (background maintenance), so the answer
 * is the one the next turn will see. Undefined when there is no earlier turn.
 */
export function hygieneScope(items: ProjectedItem[], next: boolean): Set<string> | undefined {
  const entries = items.map((item) => item.sourceEntry);
  const starts = entries.flatMap((entry, index) => isTurnStart(entry) ? [index] : []);
  // Inputs that arrived together after the last model output belong to the current turn.
  const lastOutput = entries.findLastIndex((entry) => entry.type === 'message' && (entry.message.role === 'assistant' || entry.message.role === 'toolResult'));
  const current = starts.find((index) => index > lastOutput) ?? (next ? entries.length : starts.at(-1));
  const previous = current === undefined ? undefined : starts.findLast((index) => index < current);
  return previous !== undefined && previous > 0 ? new Set(entries.slice(0, previous).map((entry) => entry.id)) : undefined;
}
const textTokens = (message: ContextMessage | undefined) => Array.isArray(message?.content) ? tokens(message.content.filter((part) => !isImagePart(part))) : 0;
/** Large unedited tool results of older turns, largest first; `skip` leaves out targets that are in backoff. */
export const digestCandidates = <T extends ProjectedItem>(items: T[], older: Set<string>, edited: Set<string>, skip?: (target: string) => boolean): T[] => items.filter((item) => {
  const message = item.messages[0];
  return older.has(item.sourceEntry.id) && item.sourceEntry.type === 'message' && message?.role === 'toolResult' && !edited.has(item.sourceEntry.id) && textTokens(message) > DIGEST_TOKENS && !skip?.(entryTarget(item.sourceEntry.id));
}).map((item) => ({ item, size: textTokens(item.messages[0]) })).sort((a, b) => b.size - a.size).map(({ item }) => item);
/** Messages of older turns that still hold image bytes. */
export const imageCandidates = <T extends ProjectedItem>(items: T[], older: Set<string>): T[] => items.filter((item) => {
  const message = item.messages[0];
  return older.has(item.sourceEntry.id) && !!message && ['user', 'toolResult', 'custom'].includes(message.role) && Array.isArray(message.content) && message.content.some((part) => isImagePart(part));
});

export interface ReductionLimits { inputBudget: number; soft: number; target: number; ceiling: number; calibration: number }
/**
 * The lines the reduction pipeline works against. inputBudget is the hard limit H: a request above it does not
 * fit and is reduced in the turn. soft is the threshold S: above it (and idle for MAINTAIN_IDLE_MS) the
 * background reduces; at or below it nothing is ever reduced. A reduction runs down to target T = 0.4 × S.
 * The calibrated count is what S, T and H are compared with; the raw count reaching 90% of the window is a
 * safety net that counts as over H whatever the calibration reads.
 */
export function reductionLimits(config: { contextWindow: number; maxOutputTokens: number; contextBudget?: number; calibration?: number }): ReductionLimits {
  const inputBudget = modelInputBudget(config.contextWindow, config.maxOutputTokens), soft = workingContextBudget(config.contextBudget, inputBudget, config.contextWindow);
  return { inputBudget, soft, target: Math.floor(soft * TARGET_SHARE), ceiling: Math.floor(config.contextWindow * .9), calibration: Number.isFinite(config.calibration) && config.calibration! > 0 ? config.calibration! : 1 };
}
/** Tokens a history compaction may keep as full recent turns. */
export const tailBudgetFor = (limits: ReductionLimits, promptTokens: number) => Math.max(0, Math.floor(limits.soft * .3) - CONTEXT_OVERHEAD - promptTokens - tokens(brokerParameters) - tokens(brokerDescription) - 4096);
/** The system message as it is counted: the prompt plus the broker declaration. */
export const systemMessage = (prompt: string) => ({ role: 'system' as const, content: prompt, toolsAdded: brokerDeclaration, timestamp: Date.now() });

/** Index in the context entries from which full turns are kept; everything before it is folded into the turn summary. Cuts fall on turn starts only. */
export function tailCut(entries: FileEntry[], tailBudget: number): number {
  const starts = entries.flatMap((entry, index) => isTurnStart(entry) ? [index] : []);
  let index = starts.at(-1) ?? 0;
  for (const candidate of starts.slice(0, -1).reverse()) {
    if (tokens(entries.slice(candidate)) > tailBudget) break;
    index = candidate;
  }
  return index;
}
/** Whether the entries before the cut hold anything a turn summary would fold, besides a leading summary and system messages. */
export const foldable = (earlier: FileEntry[], projection: Map<string, ContextMessage[]>) => earlier.some((entry) => entry.type === 'custom_message' || (entry.type === 'message' && entry.message.role !== 'system' && (projection.get(entry.id)?.length ?? 0) > 0));

export interface SourceItem { ref: string; role: string; content: unknown }
/**
 * What the summarizer reads for a run of context entries: inputs, a leading summary and the projected
 * messages. It reads text; image bytes stay in the original entry. Shared by the worker (which folds it) and
 * Core (which needs the same first entry to tell whether a fold is in backoff).
 */
export function historySource(earlier: FileEntry[], projection: Map<string, ContextMessage[]>): SourceItem[] {
  const textOnly = (content: unknown) => Array.isArray(content) ? content.map((part) => isImagePart(part) ? { type: 'text', text: '[图片]' } : part) : content;
  return earlier.flatMap<SourceItem>((entry, index) => {
    const ref = `entry:${entry.id}`;
    if (entry.type === 'custom_message') return [{ ref, role: 'user', content: textOnly(entry.content) }];
    if (entry.type === 'compaction' && index === 0) return [{ ref, role: 'summary', content: entry.summary }];
    if (entry.type === 'message' && entry.message.role !== 'system') return (projection.get(entry.id) ?? []).map((message) => ({ ref, role: message.role, content: 'content' in message ? textOnly(message.content) : JSON.stringify(message) }));
    return [];
  });
}
/** A fold is in backoff when any batch range of it (all start at the fold's first source entry) is blocked. */
export function foldBlocked(source: SourceItem[], blocked: Iterable<string>): boolean {
  const start = source[0]?.ref.slice(6);
  return !!start && [...blocked].some((target) => target.startsWith(`range:${start}..`));
}

export interface MaintenanceParams { contextWindow: number; maxOutputTokens: number; contextBudget?: number; calibration?: number; systemPrompt: string; volatilePrompt: string; /** Targets (entry:/range: keys) that are in backoff or given up on. */ blocked?: ReadonlySet<string> }
export interface MaintenanceVerdict { work: boolean; reason: 'budget' | null; /** Calibrated token estimate of the next request, before its new input. */ estimate: number; /** The soft threshold S, which the calibrated estimate must exceed. */ trigger: number }
/**
 * Whether background maintenance of a stored projection would do anything: the calibrated context is above
 * the soft threshold S and something is left to reduce, i.e. a large tool result of a turn older than the
 * latest completed one that is not in backoff, or older turns to fold into the summary. The latest completed turn is never
 * reduced, so a context made of that turn alone has no work however large it is. Old results or images alone
 * are no reason: below S nothing is reduced. Whether the conversation has been idle long enough is Core's call.
 */
export function maintenanceWork(entries: FileEntry[] | undefined, params: MaintenanceParams): MaintenanceVerdict {
  const limits = reductionLimits(params), trigger = limits.soft;
  if (!entries?.length) return { work: false, reason: null, estimate: 0, trigger };
  const items = projectEntries(entries), volatileTokens = tokens(params.volatilePrompt), promptTokens = tokens(params.systemPrompt) + volatileTokens;
  const count = tokens([systemMessage(params.systemPrompt), ...items.flatMap((item) => item.messages).filter((message) => message.role !== 'system')]) + CONTEXT_OVERHEAD + volatileTokens;
  const estimate = Math.round(count * limits.calibration), verdict = (work: boolean) => ({ work, reason: work ? 'budget' as const : null, estimate, trigger });
  if (!(count * limits.calibration > trigger || count >= limits.ceiling)) return verdict(false);
  const blocked = (target: string) => params.blocked?.has(target) ?? false, older = hygieneScope(items, true);
  if (older && digestCandidates(items, older, editedTargets(branchOf(entries)), blocked).length) return verdict(true);
  const context = contextEntries(entries), projection = new Map(items.map((item) => [item.sourceEntry.id, item.messages])), earlier = context.slice(0, tailCut(context, tailBudgetFor(limits, promptTokens)));
  if (!foldable(earlier, projection)) return verdict(false);
  const source = historySource(earlier, projection);
  return verdict(source.length > 0 && !foldBlocked(source, params.blocked ?? []));
}
