import { HTML_PREVIEW_LIMIT } from './html-preview.ts';

export const htmlRenderDescription = `html.render(content) publishes a self-contained HTML document or fragment directly in the current Agent's chat using the existing isolated HTML preview. Use it for custom diagrams, funnel charts, layouts, interactive explanations and small local widgets when the built-in chart types do not fit. Match the user's requested visual form; a funnel is not a bar chart. content is raw HTML, without Markdown fences; inline CSS, SVG, canvas and JavaScript are supported. Maximum ${HTML_PREVIEW_LIMIT} JavaScript string characters. Include all assets inline; no network requests, CDN scripts, external fonts, remote images, navigation, parent/app access or backend APIs. Interactions stay inside the preview; it cannot save files, contact the model or perform real-world actions. Use responsive widths and a meaningful initial view. Use verified/user-provided data, and visibly label invented examples. The tool automatically publishes the preview message: do not repeat its source or another html-preview block in the final answer. The result confirms publication, not successful browser execution; do not claim visual verification without observing it.`;

export function htmlRenderContent(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > HTML_PREVIEW_LIMIT) {
    throw new Error(`HTML 内容不能为空，且不得超过 ${HTML_PREVIEW_LIMIT} 个字符`);
  }
  return value;
}

/** A generated code sample must never close its enclosing preview fence. */
export function htmlRenderMessage(value: unknown): string {
  const content = htmlRenderContent(value);
  let length = 3;
  for (const run of content.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
  const fence = '`'.repeat(length);
  return `${fence}html-preview\n${content}\n${fence}`;
}
