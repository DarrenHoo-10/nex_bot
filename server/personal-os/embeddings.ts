// Client of an OpenAI-compatible embeddings endpoint (POST {base}/embeddings). Errors name the HTTP status only:
// neither the request headers nor the response body ever reach a message or a log.
export interface EmbeddingSettings { baseUrl: string; model: string; dimensions?: number; apiKey?: string }

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 32_000_000;
/** One request carries at most this many texts. */
export const EMBED_BATCH = 32;

/** The body of a successful response, bounded; the connection is released on every path. */
export async function boundedJson(response: Response, what: string): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`${what}返回 ${response.status}`); }
  const body = await response.text();
  if (body.length > MAX_RESPONSE_BYTES) throw new Error(`${what}响应过大`);
  try { return JSON.parse(body); } catch { throw new Error(`${what}响应无效`); }
}
export const withTimeout = (signal?: AbortSignal) => AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]);
export const joinUrl = (base: string, path: string) => base.replace(/\/+$/, '') + path;

/** Unit-length vectors, so that similarity is a dot product. */
function unit(values: number[]): Float32Array {
  const vector = Float32Array.from(values);
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (!(norm > 0)) throw new Error('向量服务返回了零向量');
  for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return vector;
}

export async function embedTexts(settings: EmbeddingSettings, input: string[], signal?: AbortSignal): Promise<{ vectors: Float32Array[]; tokens: number | null }> {
  if (!input.length || input.length > EMBED_BATCH) throw new Error('向量请求数量无效');
  const response = await fetch(joinUrl(settings.baseUrl, '/embeddings'), {
    method: 'POST', redirect: 'error', signal: withTimeout(signal),
    headers: { 'Content-Type': 'application/json', ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) },
    body: JSON.stringify({ model: settings.model, input, encoding_format: 'float', ...(settings.dimensions ? { dimensions: settings.dimensions } : {}) }),
  });
  const body = await boundedJson(response, '向量服务') as { data?: Array<{ index?: number; embedding?: unknown }>; usage?: { prompt_tokens?: unknown; total_tokens?: unknown } };
  if (!Array.isArray(body?.data) || body.data.length !== input.length) throw new Error('向量服务返回的数量不符');
  const ordered = [...body.data].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  const vectors = ordered.map((item) => {
    const values = item.embedding;
    if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('向量服务返回的向量无效');
    return unit(values as number[]);
  });
  if (vectors.some((vector) => vector.length !== vectors[0].length) || (settings.dimensions && vectors[0].length !== settings.dimensions)) throw new Error('向量服务返回的维度不一致');
  const used = body.usage?.prompt_tokens ?? body.usage?.total_tokens;
  return { vectors, tokens: Number.isSafeInteger(used) && Number(used) >= 0 ? Number(used) : null };
}
