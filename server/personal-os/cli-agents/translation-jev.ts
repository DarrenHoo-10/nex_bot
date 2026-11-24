import type { ProxyAgent } from "undici";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-1.14.0";
const MIN_ENGLISH_PROBABILITY = 0.7;
const MAX_BATCH_CHARS = 8_000;
const MAX_BATCH_PARAGRAPHS = 32;
const JEV_TIMEOUT = 5_000;
const FAILURE_LIMIT = 10;
const COOLDOWN = 60 * 60_000;
let proxyAgent: ProxyAgent | undefined;
// Shared by every workspace in this Core process.
let failures = 0;
let resumeAt = 0;
let generation = 0;

export function jevAvailable() {
  return Date.now() >= resumeAt;
}

function batchRequest(paragraphs: readonly string[]) {
  const entries = paragraphs.map((paragraph, index) => [`p${index + 1}`, paragraph] as const);
  return {
    model: MODEL,
    state: { paragraphs: Object.fromEntries(entries) },
    questions: Object.fromEntries(entries.map(([id]) => [id, {
      type: "noul",
      instructions: `Does \`paragraphs.${id}\` contain English prose that conveys meaning to the reader?`,
      criteria: {
        true: "There is an English sentence, clause, or meaningful heading or phrase, even alongside Chinese prose.",
        false: "Any English is limited to names, technical terms embedded in Chinese, commands, identifiers, or log fragments.",
      },
    }])),
  };
}

async function judgeBatch(paragraphs: readonly string[], apiKey: string, signal: AbortSignal) {
  const request = batchRequest(paragraphs);
  const options = {
    method: "POST", signal, redirect: "error",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(request),
  } as const;
  let response;
  try {
    const proxy = process.env.NEX_TRANSLATION_JEV_PROXY?.trim();
    if (proxy) {
      const { fetch: proxyFetch, ProxyAgent } = await import("undici");
      proxyAgent ??= new ProxyAgent(proxy);
      response = await proxyFetch(ENDPOINT, { ...options, dispatcher: proxyAgent });
    } else {
      response = await fetch(ENDPOINT, options);
    }
  } catch {
    throw new Error("Jev translation filter unavailable");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Jev translation filter failed (HTTP ${response.status})`);
  }
  // Keep provider response text and request data out of diagnostic logs.
  const data = await response.json().catch(() => null) as {
    answers?: Record<string, { type?: unknown; noul?: unknown } | undefined>;
  } | null;
  return Object.entries(request.state.paragraphs).flatMap(([id, paragraph]) => {
    const answer = data?.answers?.[id];
    const probability = answer?.noul;
    if (answer?.type !== "noul" || typeof probability !== "number" ||
        !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error("Jev translation filter returned an invalid answer");
    }
    return probability >= MIN_ENGLISH_PROBABILITY ? [paragraph] : [];
  });
}

async function selectTranslationProse(paragraphs: readonly string[], apiKey: string, signal: AbortSignal) {
  const unique = [...new Set(paragraphs)];
  const selected = new Set<string>();
  for (let start = 0; start < unique.length;) {
    let end = start + 1;
    let length = unique[start]!.length;
    while (end < unique.length && end - start < MAX_BATCH_PARAGRAPHS && length + unique[end]!.length <= MAX_BATCH_CHARS) {
      length += unique[end++]!.length;
    }
    const approved = await judgeBatch(unique.slice(start, end), apiKey, signal);
    for (const paragraph of approved) selected.add(paragraph);
    start = end;
  }
  return selected;
}

export async function tryJevTranslationFilter(paragraphs: readonly string[], apiKey: string, signal: AbortSignal) {
  if (!jevAvailable()) return;
  const attemptGeneration = generation;
  const budget = AbortSignal.timeout(JEV_TIMEOUT);
  try {
    const selected = await selectTranslationProse(paragraphs, apiKey, AbortSignal.any([signal, budget]));
    if (attemptGeneration === generation) return selected;
  } catch (error) {
    if (attemptGeneration !== generation || signal.aborted) return;
    failures++;
    const message = budget.aborted ? "Jev translation filter exceeded 5 seconds" : error instanceof Error ? error.message : "Jev translation filter failed";
    console.warn("[translation] using rules:", message);
    if (failures > FAILURE_LIMIT) {
      resumeAt = Date.now() + COOLDOWN;
      generation++;
      failures = 0;
      console.warn("[translation] Jev translation filter paused for one hour");
    }
  }
}
