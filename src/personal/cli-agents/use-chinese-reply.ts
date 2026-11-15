import { useEffect, useState } from "react";

interface LocalTranslator {
  translate(text: string, options: { signal: AbortSignal }): Promise<string>;
}
const pair = { sourceLanguage: "en", targetLanguage: "zh" };
interface TranslatorAPI {
  availability(options: typeof pair): Promise<string>;
  create(options: typeof pair): Promise<LocalTranslator>;
}
let instance: Promise<LocalTranslator> | undefined;
function translator(api: TranslatorAPI) {
  instance ??= api.create(pair).catch(error => { instance = undefined; throw error; });
  return instance;
}

// Translate prose only. Keep code, command examples, URLs and Markdown link targets verbatim.
function proseParts(text: string) {
  return text.split(/(\x60{3}[\s\S]*?(?:\x60{3}|(?![\s\S]))|~{3}[\s\S]*?(?:~{3}|(?![\s\S]))|\x60[^\x60\n]*\x60|https?:\/\/[^\s)]+|\]\([^\n)]*\)|^(?: {4}|\t)[^\n]*|\n+)/gm);
}
const english = (text: string) => /[a-z]{2}/i.test(text) && !/[\u3400-\u9fff]/u.test(text);

export function useChineseReply(source: string, supplied?: string) {
  const api = (window as Window & { Translator?: TranslatorAPI }).Translator;
  const [translated, setTranslated] = useState<string>();
  const [status, setStatus] = useState<"idle" | "ready" | "working" | "failed">("idle");
  const [requested, setRequested] = useState<{ engine: Promise<LocalTranslator> }>();
  useEffect(() => {
    if (!api || supplied || !source) return;
    const parts = proseParts(source);
    if (!parts.some((part, i) => i % 2 === 0 && english(part))) return;
    const controller = new AbortController();
    const { signal } = controller;
    async function run() {
      let engine = requested?.engine ?? instance;
      if (!engine) {
        const availability = await api!.availability(pair);
        if (signal.aborted || availability === "unavailable") return;
        if (availability !== "available") { setStatus("ready"); return; }
        engine = translator(api!);
      }
      setStatus("working");
      const local = await engine;
      for (let i = 0; i < parts.length && !signal.aborted; i += 2) {
        const part = parts[i], trimmed = part.trim();
        if (english(trimmed)) {
          const start = part.indexOf(trimmed);
          const result = await local.translate(trimmed, { signal });
          parts[i] = part.slice(0, start) + result + part.slice(start + trimmed.length);
        }
      }
      if (!signal.aborted) { setTranslated(parts.join("")); setStatus("idle"); }
    }
    void run().catch(() => { if (!signal.aborted) setStatus("failed"); });
    return () => controller.abort();
  }, [api, requested, source, supplied]);

  return {
    translation: supplied || translated,
    status,
    request: () => {
      if (!api) return;
      const engine = translator(api);
      // Start model creation in the click handler, while user activation is present.
      void engine.catch(() => {});
      setRequested({ engine });
    },
  };
}
