import { useEffect, useMemo, useState } from "react";

// English assistant replies are shown in Chinese when the browser's local
// Translator can do it without a download. The original text is never changed:
// the translation is derived data, cached by content hash + target language +
// TRANSLATOR_VERSION. Code, commands, links and paths are never sent to the
// translator; only prose segments are, and the pieces are reassembled in place.

/** Bump when the segmentation or translator behaviour changes, to drop stale cache entries. */
export const TRANSLATOR_VERSION = "local-translator-1";
const TARGET = "zh";
/** Streaming text must stay unchanged this long before it is translated. */
export const STABLE_MS = 800;
const MAX_CACHE_ENTRIES = 200;
const MAX_CACHE_CHARS = 600_000;

interface LocalTranslator {
  translate(text: string, options: { signal: AbortSignal }): Promise<string>;
}
const pair = { sourceLanguage: "en", targetLanguage: TARGET };
interface TranslatorAPI {
  availability(options: typeof pair): Promise<string>;
  create(options: typeof pair): Promise<LocalTranslator>;
}
let instance: Promise<LocalTranslator> | undefined;
function translator(api: TranslatorAPI) {
  instance ??= api.create(pair).catch(error => { instance = undefined; throw error; });
  return instance;
}
const translatorApi = () => typeof window === "undefined" ? undefined : (window as Window & { Translator?: TranslatorAPI }).Translator;

// One message at a time keeps the browser responsive when a long session opens.
let tail: Promise<unknown> = Promise.resolve();
function enqueue<T>(signal: AbortSignal, job: () => Promise<T>): Promise<T | undefined> {
  const next = tail.then(() => signal.aborted ? undefined : job());
  tail = next.catch(() => undefined);
  return next;
}

export interface ReplySegment { text: string; translate: boolean }

// Protected inside a prose line: inline code, Markdown link targets, HTML tags,
// URLs, file paths and command-line flags.
const PROTECTED = /(\x60+[^\x60\n]*\x60+|\]\([^\n)]*\)|<\/?[A-Za-z][^>\n]*>|https?:\/\/[^\s)>]+|(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/])[^\s\x60"'<>)]+|(?<![\w)\]])\/[\w@.-][^\s\x60"'<>)]*|[\w@.-]+(?:[\\/][\w@.-]+){2,}|[\w@.-]+(?:[\\/][\w@.-]+)*[\\/][\w@-]+\.\w+|\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|css|html?|py|rs|go|java|kt|swift|sh|ya?ml|toml|lock|sql|txt|log)\b|(?<![\w-])--[A-Za-z][\w-]*)/;
const LIST_OR_HEADING = /^(\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+)?)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const CJK = /[぀-ヿ㐀-鿿가-힯]/g;
const LATIN = /[A-Za-z]/g;
const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

/** A prose piece worth translating: has a real Latin word and is not mostly CJK. */
function translatable(text: string) {
  if (!/[A-Za-z]{3,}/.test(text)) return false;
  const cjk = count(text, CJK);
  return cjk * 5 < cjk + count(text, LATIN);
}

/** Split Markdown into alternating verbatim and translatable pieces; joining the texts gives the input back. */
export function splitReply(text: string): ReplySegment[] {
  const out: ReplySegment[] = [];
  const keep = (value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last && !last.translate) last.text += value;
    else out.push({ text: value, translate: false });
  };
  const inline = (value: string) => {
    value.split(PROTECTED).forEach((piece, i) => {
      if (i % 2 === 1) { keep(piece); return; }
      const core = piece.trim();
      if (!translatable(core)) { keep(piece); return; }
      const start = piece.indexOf(core);
      keep(piece.slice(0, start));
      out.push({ text: core, translate: true });
      keep(piece.slice(start + core.length));
    });
  };
  let fence: string | undefined;
  for (const line of text.split(/(?<=\n)/)) {
    const body = line.replace(/\r?\n$/, "");
    const eol = line.slice(body.length);
    const mark = /^[ \t]*(\x60{3,}|~{3,})/.exec(body)?.[1];
    if (fence) {
      keep(line);
      if (mark && mark[0] === fence[0] && mark.length >= fence.length && /^[ \t]*[\x60~]+[ \t]*$/.test(body)) fence = undefined;
      continue;
    }
    if (mark) { fence = mark; keep(line); continue; }
    if (/^(?: {4}|\t)/.test(body) && !LIST_ITEM.test(body)) { keep(line); continue; }
    const prefix = LIST_OR_HEADING.exec(body)?.[0] ?? "";
    keep(prefix);
    const rest = body.slice(prefix.length);
    if (rest.trimStart().startsWith("|")) rest.split(/(\|)/).forEach((cell, i) => i % 2 ? keep(cell) : inline(cell));
    else inline(rest);
    keep(eol);
  }
  return out;
}

/** True for a reply that is mostly Latin prose with little CJK. */
export function isEnglishReply(text: string) {
  let latin = 0, cjk = 0;
  for (const segment of splitReply(text)) if (segment.translate) { latin += count(segment.text, LATIN); cjk += count(segment.text, CJK); }
  return latin >= 6 && cjk * 20 <= latin + cjk;
}

// Translation cache: memory first, mirrored to sessionStorage so reopening the
// session or paging older messages never retranslates. Oldest entries go first.
const STORAGE_KEY = `nexbot.cli-reply-zh.${TRANSLATOR_VERSION}`;
let memory: Map<string, string> | undefined;

function hash(text: string) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const cacheKey = (source: string) => `${TARGET}:${source.length}:${hash(source)}`;

function store() {
  if (memory) return memory;
  memory = new Map();
  try {
    const saved: unknown = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "[]");
    if (Array.isArray(saved)) for (const entry of saved) if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") memory.set(entry[0], entry[1]);
  } catch { /* storage unavailable or corrupt: memory only */ }
  return memory;
}

function readCache(source: string) {
  return store().get(cacheKey(source));
}

function writeCache(source: string, translation: string) {
  const entries = store();
  const key = cacheKey(source);
  entries.delete(key);
  entries.set(key, translation);
  let chars = 0;
  for (const value of entries.values()) chars += value.length;
  for (const [oldest, value] of entries) {
    if (entries.size <= MAX_CACHE_ENTRIES && chars <= MAX_CACHE_CHARS) break;
    if (oldest === key) break;
    entries.delete(oldest);
    chars -= value.length;
  }
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...entries]));
  } catch { /* quota or private mode: the in-memory copy still serves */ }
}

/** Test helper: forget every cached translation and the shared translator. */
export function resetReplyTranslations() {
  memory = undefined;
  instance = undefined;
  try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

async function translateProse(local: LocalTranslator, source: string, signal: AbortSignal) {
  const done = new Map<string, string>();
  const parts: string[] = [];
  for (const segment of splitReply(source)) {
    if (!segment.translate) { parts.push(segment.text); continue; }
    let result = done.get(segment.text);
    if (result === undefined) {
      result = (await local.translate(segment.text, { signal })).trim() || segment.text;
      done.set(segment.text, result);
    }
    parts.push(result);
  }
  return parts.join("");
}

// Chrome: "available" | "downloadable" | "downloading" | "unavailable"; older builds: "readily" | "after-download" | "no".
const READY = new Set(["available", "readily"]);
const NEVER = new Set(["unavailable", "no"]);

export function useChineseReply(source: string, supplied?: string) {
  const api = translatorApi();
  const english = useMemo(() => !supplied && !!source && isEnglishReply(source), [source, supplied]);
  const cached = english ? readCache(source) : undefined;
  const [translated, setTranslated] = useState<{ source: string; text: string }>();
  const [status, setStatus] = useState<"idle" | "ready" | "working" | "failed">("idle");
  const [requested, setRequested] = useState<{ engine: Promise<LocalTranslator> }>();
  const wanted = english && cached === undefined && translated?.source !== source;

  useEffect(() => {
    if (!api || !wanted) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => new Promise<void>(resolve => { timer = setTimeout(resolve, STABLE_MS); });
    async function run() {
      let engine = requested?.engine;
      if (!engine) {
        setStatus("idle");
        await settle();
        if (signal.aborted) return;
        engine = instance;
        if (!engine) {
          const availability = await api!.availability(pair).catch(() => "unavailable");
          if (signal.aborted || NEVER.has(availability)) return;
          // A download needs a user gesture: wait for the button.
          if (!READY.has(availability)) { setStatus("ready"); return; }
          engine = translator(api!);
        }
      }
      setStatus("working");
      const local = await engine;
      const text = await enqueue(signal, () => translateProse(local, source, signal));
      if (signal.aborted || text === undefined) return;
      writeCache(source, text);
      setTranslated({ source, text });
      setStatus("idle");
    }
    void run().catch(() => { if (!signal.aborted) setStatus("failed"); });
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, requested, source, wanted]);

  const text = supplied || cached || (translated?.source === source ? translated.text : undefined);
  return {
    translation: text && text !== source ? text : undefined,
    status: wanted ? status : "idle" as const,
    request: () => {
      if (!api) return;
      const engine = translator(api);
      // Start model creation in the click handler, while user activation is present.
      void engine.catch(() => {});
      setRequested({ engine });
    },
  };
}
