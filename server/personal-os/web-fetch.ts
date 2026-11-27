import { text } from "./store.ts";

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 30_000;
const MAX_CHARS_LIMIT = 100_000;
const TIMEOUT_MS = 30_000;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©",
};

function decodeEntities(value: string): string {
  return value.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g, (match, hex, dec, name) => {
    if (hex) { const code = Number.parseInt(hex, 16); return Number.isFinite(code) ? String.fromCodePoint(code) : match; }
    if (dec) { const code = Number.parseInt(dec, 10); return Number.isFinite(code) ? String.fromCodePoint(code) : match; }
    return ENTITIES[String(name).toLowerCase()] ?? match;
  });
}

/** Lightweight readable-text extraction for HTML responses (zero external dependencies). */
export function htmlToReadableText(html: string): string {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|main|header|footer|aside|nav|li|ul|ol|tr|table|h[1-6]|pre|blockquote|dd|dt)>/gi, "\n")
    .replace(/<(?:h[1-6]|li|tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutNoise)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function validateWebFetchArgs(args: Record<string, unknown>) {
  const rawUrl = text(args.url, 4096);
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { throw new Error("url 格式无效，请提供完整的 http:// 或 https:// 地址"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("仅支持 http:// 或 https:// 协议");
  const method = args.method === undefined ? "GET" : text(args.method, 16).toUpperCase();
  if (!ALLOWED_METHODS.has(method)) throw new Error(`不支持的 HTTP 方法：${method}`);
  const headers: Record<string, string> = {};
  if (args.headers !== undefined) {
    if (!args.headers || typeof args.headers !== "object" || Array.isArray(args.headers)) throw new Error("headers 须为键值对象");
    for (const [key, value] of Object.entries(args.headers as Record<string, unknown>)) {
      if (!key || /[\r\n\0:]/.test(key) || typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error(`请求头无效：${key}`);
      headers[key] = value;
    }
  }
  const body = args.body === undefined ? undefined : typeof args.body === "string" ? args.body : (() => { throw new Error("body 须为字符串"); })();
  if (body && body.length > 200_000) throw new Error("body 超过 200000 字符上限");
  const maxChars = args.maxChars === undefined ? DEFAULT_MAX_CHARS : Number(args.maxChars);
  if (!Number.isSafeInteger(maxChars) || maxChars < 100 || maxChars > MAX_CHARS_LIMIT) throw new Error(`maxChars 须为 100 到 ${MAX_CHARS_LIMIT} 之间的整数`);
  return { url: parsed.href, method, headers, body, maxChars };
}

async function readBoundedText(response: Response): Promise<{ raw: string; byteTruncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { raw: "", byteTruncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let byteTruncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.length > MAX_BYTES) {
        const remaining = MAX_BYTES - size;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        byteTruncated = true;
        break;
      }
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return { raw: Buffer.concat(chunks).toString("utf8"), byteTruncated };
}

/** Direct HTTP/HTTPS fetch executed by Core so assistants can read public web pages, GitHub Releases and APIs without needing a bound device. */
export async function webFetch(args: Record<string, unknown>, signal?: AbortSignal) {
  const { url, method, headers, body, maxChars } = validateWebFetchArgs(args);
  const requestHeaders: Record<string, string> = {
    "User-Agent": "NexBot/1.0",
    Accept: "text/markdown, text/plain, application/json, text/html;q=0.9, */*;q=0.8",
    ...headers,
  };
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body } : {}),
    redirect: "follow",
    signal: combined,
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (method === "HEAD") {
    return { url: response.url, status: response.status, ok: response.ok, contentType, truncated: false, totalChars: 0, text: "" };
  }
  const { raw, byteTruncated } = await readBoundedText(response);
  const isHtml = /\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType);
  const extracted = isHtml ? htmlToReadableText(raw) : raw;
  const truncated = byteTruncated || extracted.length > maxChars;
  return {
    url: response.url,
    status: response.status,
    ok: response.ok,
    contentType,
    truncated,
    totalChars: extracted.length,
    text: extracted.slice(0, maxChars),
  };
}
