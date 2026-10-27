import type { FileEntry } from '@earendil-works/pi-coding-agent';
import { isImagePart, tokens } from './token-estimate.ts';
import { modelInputBudget, workingContextBudget } from './model-limits.ts';
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
/** Tool results above this many text tokens (images excluded) are digested once their turn is no longer the latest completed one. */
export const DIGEST_TOKENS = 1500;
/** Fixed request overhead (tool framing, provider wrappers) added to every estimate. */
export const CONTEXT_OVERHEAD = 2500;
/** Background maintenance starts reducing at this share of the working budget, so the next turn finds room. */
export const MAINTAIN_TRIGGER = 0.7;

/** The active branch: the chain of parents from the last entry. */
export function branchOf(entries: FileEntry[]): Entry[] {
  const body = entries.filter((entry): entry is Entry => entry.type !== 'session');
  const byId = new Map(body.map((entry) => [entry.id, entry]));
  const path: Entry[] = [], seen = new Set<string>();
  for (let current = body.at(-1); current && !seen.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) { seen.add(current.id); path.push(current); }
  return path.reverse();
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
/** Large unedited tool results of older turns. */
export const digestCandidates = <T extends ProjectedItem>(items: T[], older: Set<string>, edited: Set<string>): T[] => items.filter((item) => {
  const message = item.messages[0];
  return older.has(item.sourceEntry.id) && item.sourceEntry.type === 'message' && message?.role === 'toolResult' && !edited.has(item.sourceEntry.id) && Array.isArray(message.content) && tokens(message.content.filter((part) => !isImagePart(part))) > DIGEST_TOKENS;
});
/** Messages of older turns that still hold image bytes. */
export const imageCandidates = <T extends ProjectedItem>(items: T[], older: Set<string>): T[] => items.filter((item) => {
  const message = item.messages[0];
  return older.has(item.sourceEntry.id) && !!message && ['user', 'toolResult', 'custom'].includes(message.role) && Array.isArray(message.content) && message.content.some((part) => isImagePart(part));
});

export interface ReductionLimits { inputBudget: number; workingBudget: number; target: number; ceiling: number; calibration: number }
/**
 * The lines the reduction pipeline works against. Reduction starts at the working budget (or at
 * MAINTAIN_TRIGGER of it in the background) and, once started, continues down to half of it. The raw
 * count reaching 90% of the window starts it regardless of the calibration; inputBudget is the hard limit.
 */
export function reductionLimits(config: { contextWindow: number; maxOutputTokens: number; contextBudget?: number; calibration?: number }): ReductionLimits {
  const inputBudget = modelInputBudget(config.contextWindow, config.maxOutputTokens), workingBudget = workingContextBudget(config.contextBudget, inputBudget);
  return { inputBudget, workingBudget, target: Math.floor(workingBudget * .5), ceiling: Math.floor(config.contextWindow * .9), calibration: Number.isFinite(config.calibration) && config.calibration! > 0 ? config.calibration! : 1 };
}
export const triggerLine = (limits: ReductionLimits, maintain: boolean) => maintain ? Math.floor(limits.workingBudget * MAINTAIN_TRIGGER) : limits.workingBudget;
/** Tokens the turn summary may keep as full recent turns. */
export const tailBudgetFor = (limits: ReductionLimits, promptTokens: number) => Math.max(0, Math.floor(limits.workingBudget * .3) - CONTEXT_OVERHEAD - promptTokens - tokens(brokerParameters) - tokens(brokerDescription) - 4096);
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

export interface MaintenanceParams { contextWindow: number; maxOutputTokens: number; contextBudget?: number; calibration?: number; systemPrompt: string; volatilePrompt: string }
export interface MaintenanceVerdict { work: boolean; reason: 'digest' | 'budget' | null; /** Calibrated token estimate of the next request, before its new input. */ estimate: number; /** The calibrated estimate at which background reduction starts. */ trigger: number }
/**
 * Whether background maintenance of a stored projection would do anything: tool results or images of
 * turns older than the latest completed one waiting for a digest, or a calibrated context above
 * MAINTAIN_TRIGGER of the working budget with older turns left to fold into the summary. The latest
 * completed turn is never reduced, so a context made of that turn alone has no work however large it is.
 */
export function maintenanceWork(entries: FileEntry[] | undefined, params: MaintenanceParams): MaintenanceVerdict {
  const limits = reductionLimits(params), trigger = triggerLine(limits, true);
  if (!entries?.length) return { work: false, reason: null, estimate: 0, trigger };
  const items = projectEntries(entries), volatileTokens = tokens(params.volatilePrompt), promptTokens = tokens(params.systemPrompt) + volatileTokens;
  const count = tokens([systemMessage(params.systemPrompt), ...items.flatMap((item) => item.messages).filter((message) => message.role !== 'system')]) + CONTEXT_OVERHEAD + volatileTokens;
  const estimate = Math.round(count * limits.calibration), verdict = (reason: 'digest' | 'budget' | null) => ({ work: reason !== null, reason, estimate, trigger });
  const older = hygieneScope(items, true);
  if (older && (digestCandidates(items, older, editedTargets(branchOf(entries))).length || imageCandidates(items, older).length)) return verdict('digest');
  if (count * limits.calibration >= trigger || count >= limits.ceiling) {
    const context = contextEntries(entries);
    if (foldable(context.slice(0, tailCut(context, tailBudgetFor(limits, promptTokens))), new Map(items.map((item) => [item.sourceEntry.id, item.messages])))) return verdict('budget');
  }
  return verdict(null);
}
