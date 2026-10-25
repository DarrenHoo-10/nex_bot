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
