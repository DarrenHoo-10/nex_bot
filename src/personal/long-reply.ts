/** A reply with headings, or more than this many rendered lines, becomes a document card. */
export const DOCUMENT_LINES = 12;
// A reading column fits about 42 CJK characters; CJK counts two units per character.
const LINE_UNITS = 84;
const units = (line: string) => { let total = 0; for (const char of line) total += char.charCodeAt(0) > 0x2e7f ? 2 : 1; return total; };

/** Decide from the Markdown source alone, so the layout never changes after render. Charts and
 * HTML previews are visuals, not text, and are not counted. */
export function replyLayout(markdown: string): { headings: boolean; lines: number; document: boolean } {
  let fence: string | undefined, visual = false, headings = false, lines = 0;
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(raw)) fence = undefined;
      else if (!visual) lines++;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w-]*)/.exec(raw);
    if (open) { fence = open[1]; visual = open[2] === "chart" || open[2] === "html-preview"; continue; }
    if (/^ {0,3}#{1,4}[ \t]+\S/.test(raw)) headings = true;
    if (raw.trim()) lines += Math.max(1, Math.ceil(units(raw) / LINE_UNITS));
  }
  return { headings, lines, document: headings || lines > DOCUMENT_LINES };
}
