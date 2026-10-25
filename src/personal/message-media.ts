/**
 * Chat messages carry uploads and generated images as Markdown attachment
 * references. The workspace shows image references as thumbnails above the
 * bubble instead of inline filename chips or a separate download link.
 */
export interface MessageImage {
  id: string;
  /** Authenticated same-origin attachment URL. */
  url: string;
  /** Inline preview URL; the server only answers this with a bitmap. */
  previewUrl: string;
  /** Name used when the bitmap is saved. */
  name: string;
  alt: string;
}

export interface ParsedMessage {
  /** Message text with inline image references removed. */
  text: string;
  images: MessageImage[];
}

const IMAGE_EXTENSIONS = new Set(["jpeg", "jpg", "png", "webp"]);
const IMAGE_MARKDOWN = /!\[([^\]\n]*)\]\(\s*\/api\/attachments\/([A-Za-z0-9-]+)(?:\?[^)\s]*)?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const ATTACHMENT_LINK = /\[([^\]\n]*)\]\(\s*\/api\/attachments\/([A-Za-z0-9-]+)(?:\?[^)\s]*)?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const DOWNLOAD_LABEL = /^(?:下载|下载图片|下载原图|保存图片|download(?:\s+image)?|save(?:\s+image)?)$/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED_CODE = /^(?: {4}|\t)/;

function cleanFilename(value: string): string {
  return Array.from(
    value
      .normalize("NFC")
      // oxlint-disable-next-line no-control-regex -- strip control and bidi characters from a filename
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/[\\/:*?"<>|]/g, "_")
      .trim()
      .replace(/[. ]+$/g, ""),
  ).slice(0, 160).join("");
}

export function imageExtension(name: string): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase();
  return extension && IMAGE_EXTENSIONS.has(extension) ? extension : null;
}

export function isImageFileName(name: string): boolean {
  return imageExtension(name) !== null;
}

/** Turn a link label or image alt into a portable download name. Generated
 * images arrive as `生成图片` without an extension; the server follows with the
 * actual header, while the browser download attribute needs a usable suffix. */
export function imageDownloadName(label: string): string {
  const cleaned = cleanFilename(label) || "图片";
  return imageExtension(cleaned) ? cleaned : `${cleaned}.png`;
}

function makeImage(id: string, label: string): MessageImage {
  const alt = label.trim() || "图片";
  const url = `/api/attachments/${id}`;
  return { id, url, previewUrl: `${url}?preview=1`, name: imageDownloadName(alt), alt };
}

/** Markdown may put inline code beside attachment prose; never turn an example
 * in a code span into a live thumbnail. */
function transformProse(segment: string, collect: (id: string, label: string) => void, seen: Set<string>): string {
  let output = segment.replace(IMAGE_MARKDOWN, (_match, label: string, id: string) => {
    collect(id, label);
    return "";
  });
  output = output.replace(ATTACHMENT_LINK, (match, label: string, id: string) => {
    if (DOWNLOAD_LABEL.test(label.trim()) || seen.has(`/api/attachments/${id}`)) return "";
    if (isImageFileName(label)) {
      collect(id, label);
      return "";
    }
    return match;
  });
  return output;
}

function transformLine(line: string, collect: (id: string, label: string) => void, seen: Set<string>): string {
  let output = "";
  let cursor = 0;
  while (cursor < line.length) {
    const open = line.indexOf("`", cursor);
    if (open < 0) {
      output += transformProse(line.slice(cursor), collect, seen);
      break;
    }
    output += transformProse(line.slice(cursor, open), collect, seen);
    let run = 1;
    while (line[open + run] === "`") run++;
    const marker = "`".repeat(run);
    const close = line.indexOf(marker, open + run);
    if (close < 0) {
      output += line.slice(open);
      break;
    }
    output += line.slice(open, close + run);
    cursor = close + run;
  }
  return output;
}

/** Extract image attachments and remove their Markdown from the display text. */
export function parseMessageMedia(value: string): ParsedMessage {
  const images: MessageImage[] = [];
  const seen = new Set<string>();
  const collect = (id: string, label: string) => {
    const url = `/api/attachments/${id}`;
    if (!seen.has(url)) {
      seen.add(url);
      images.push(makeImage(id, label));
    }
  };
  const lines: string[] = [];
  let fence: { character: string; length: number } | null = null;
  for (const line of value.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      lines.push(line);
      const match = FENCE.exec(line);
      if (match && match[1][0] === fence.character && match[1].length >= fence.length) fence = null;
      continue;
    }
    const match = FENCE.exec(line);
    if (match) {
      fence = { character: match[1][0], length: match[1].length };
      lines.push(line);
      continue;
    }
    if (INDENTED_CODE.test(line)) {
      lines.push(line);
      continue;
    }
    lines.push(transformLine(line, collect, seen));
  }
  const text = lines
    .join("\n")
    .replace(/^[ \t]{0,3}>[ \t]*$/gm, "")
    .replace(/^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]*$/gm, "")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "")
    .replace(/[ \t]+$/, "")
    .replace(/\n{3,}/g, "\n\n");
  return { text: text.trim() ? text : "", images };
}

/** One-line preview used by the contact list and quote bar. */
export function messagePreview(value: string): string {
  const { text, images } = parseMessageMedia(value);
  const preview = text.replace(/\s+/g, " ").trim();
  return preview || (images.length ? "图片" : "");
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Keep a context menu inside the viewport, flipping above the pointer when
 * there is not enough room below. */
export function imageMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
): { left: number; top: number } {
  const left = Math.min(Math.max(margin, x), Math.max(margin, viewportWidth - width - margin));
  const top = y + height + margin > viewportHeight
    ? Math.max(margin, y - height - margin)
    : Math.min(Math.max(margin, y), Math.max(margin, viewportHeight - height - margin));
  return { left, top };
}
