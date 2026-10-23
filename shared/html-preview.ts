import { fromMarkdown } from 'mdast-util-from-markdown';

export const HTML_PREVIEW_LIMIT = 500_000;
export type HtmlPart = { kind: 'markdown'; source: string } | { kind: 'preview'; source: string; complete: boolean };

/** Only real top-level CommonMark fences opt in. Raw HTML, nested fences and
 * examples inside larger code fences cannot opt a message into execution. */
export function htmlPreviewParts(source: string): HtmlPart[] {
  if (!source.includes('html-preview')) return [{ kind: 'markdown', source }];
  const tree = fromMarkdown(source), parts: HtmlPart[] = [];
  let cursor = 0;
  for (const node of tree.children) {
    if (node.type !== 'code' || node.lang !== 'html-preview' || node.meta) continue;
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const raw = source.slice(start, end).replace(/\r\n?/g, '\n');
    const lines = raw.split('\n'), opening = /^(`{3,}|~{3,})[\t ]*html-preview[\t ]*$/.exec(lines[0]);
    if (!opening) continue;
    if (start > cursor) parts.push({ kind: 'markdown', source: source.slice(cursor, start) });
    const fence = opening[1];
    const closing = lines.length > 1 && new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[\\t ]*$`).test(lines.at(-1)!);
    parts.push({ kind: 'preview', source: node.value, complete: closing });
    cursor = end;
  }
  if (cursor < source.length || !parts.length) parts.push({ kind: 'markdown', source: source.slice(cursor) });
  return parts;
}

export function previewHeight(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(900, Math.max(160, Math.ceil(value))) : undefined;
}
