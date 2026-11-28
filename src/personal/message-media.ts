import { CLI_IMAGE_PREFIX, cliImageId, mapCliImageLinks } from "../../shared/cli-images";

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
const IMAGE_MARKDOWN = /!\[([^\]\n]*)\]\(\s*(\/api\/(?:attachments|cli-agents\/images)\/)([A-Za-z0-9-]+)(?:\?[^)\s]*)?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const STANDALONE_CLI_IMAGE = /^\s*(?:https?:\/\/[^/\s()]+)?(\/api\/cli-agents\/images\/[0-9a-f-]+)(?:\?ticket=[^\s)]+)?\s*$/;
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

function makeImage(id: string, label: string, cli: boolean): MessageImage {
  const alt = label.trim() || "图片";
  const url = `/api/attachments/${id}`;
  if (cli) return { id: CLI_IMAGE_PREFIX + id, url: "", previewUrl: CLI_IMAGE_PREFIX + id, name: imageDownloadName(alt), alt };
  return { id, url, previewUrl: `${url}?preview=1&compact=1`, name: imageDownloadName(alt), alt };
}

/** Markdown may put inline code beside attachment prose; never turn an example
 * in a code span into a live thumbnail. */
type CollectImage = (id: string, label: string, cli?: boolean) => void;

function transformProse(segment: string, collect: CollectImage, seen: Set<string>, includeCli: boolean): string {
  const normalized = includeCli ? mapCliImageLinks(segment, id => CLI_IMAGE_PREFIX + id) : segment;
  let output = normalized.replace(IMAGE_MARKDOWN, (match, label: string, prefix: string, id: string) => {
    const cli = prefix === CLI_IMAGE_PREFIX;
    if (cli && (!includeCli || !cliImageId(prefix + id))) return match;
    collect(id, label, cli);
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

function transformLine(line: string, collect: CollectImage, seen: Set<string>, includeCli: boolean): string {
  let output = "";
  let cursor = 0;
  while (cursor < line.length) {
    const open = line.indexOf("`", cursor);
    if (open < 0) {
      output += transformProse(line.slice(cursor), collect, seen, includeCli);
      break;
    }
    output += transformProse(line.slice(cursor, open), collect, seen, includeCli);
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
export function parseMessageMedia(value: string, includeCli = false): ParsedMessage {
  const images: MessageImage[] = [];
  const seen = new Set<string>();
  const collect: CollectImage = (id, label, cli = false) => {
    const url = cli ? CLI_IMAGE_PREFIX + id : `/api/attachments/${id}`;
    if (!seen.has(url)) {
      seen.add(url);
      images.push(makeImage(id, label, cli));
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
    const standalone = includeCli ? STANDALONE_CLI_IMAGE.exec(line) : null;
    const image = standalone && cliImageId(standalone[1]);
    if (image) {
      collect(image, "图片", true);
      continue;
    }
    lines.push(transformLine(line, collect, seen, includeCli));
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

function stripMarkdownPreview(value: string): string {
  return value
    .replace(/^[ \t]{0,3}(?:`{3,}|~{3,})[^\n]*$/gm, " ")
    .replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, " ")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}>+[ \t]?/gm, "")
    .replace(/^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`+([^`\n]+)`+/g, "$1")
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[\s(（【「『])([*_])(?=\S)([^*\n_]+?)(?<=\S)\2(?=$|[\s.,!?;:，。！？；：)）】」』])/g, "$1$3")
    .replace(/\s+/g, " ")
    .trim();
}

/** One-line preview used by the contact list and quote bar. */
export function messagePreview(value: string): string {
  const { text, images } = parseMessageMedia(value);
  const preview = stripMarkdownPreview(text);
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
