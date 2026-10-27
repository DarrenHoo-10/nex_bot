import type { FileEntry } from '@earendil-works/pi-coding-agent';
import { isImagePart } from './token-estimate.ts';

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
