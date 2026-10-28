import { boundedJson, joinUrl, withTimeout } from './embeddings.ts';

// Client of a reranker. Two wire formats cover the common services:
//   cohere  POST {base}/rerank  {model, query, documents, top_n}  ->  {results:[{index, relevance_score}]}
//           (SiliconFlow, Jina, Cohere)
//   tei     POST {base}/rerank  {query, texts}                    ->  [{index, score}]
//           (Hugging Face text-embeddings-inference; its model is whatever it serves)
export type RerankFormat = 'cohere' | 'tei';
export interface RerankSettings { format: RerankFormat; baseUrl: string; model: string; apiKey?: string }

/** A score per input document, in input order; undefined where the service returned none. */
export async function rerankDocuments(settings: RerankSettings, query: string, documents: string[], signal?: AbortSignal): Promise<{ scores: Array<number | undefined>; tokens: number | null }> {
  if (!documents.length) return { scores: [], tokens: 0 };
  const response = await fetch(joinUrl(settings.baseUrl, '/rerank'), {
    method: 'POST', redirect: 'error', signal: withTimeout(signal),
    headers: { 'Content-Type': 'application/json', ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) },
    body: JSON.stringify(settings.format === 'tei' ? { query, texts: documents } : { model: settings.model, query, documents, top_n: documents.length }),
  });
  const body = await boundedJson(response, '重排服务') as unknown;
  const list = Array.isArray(body) ? body : (body as { results?: unknown })?.results;
  if (!Array.isArray(list)) throw new Error('重排服务响应无效');
  const scores: Array<number | undefined> = Array.from({ length: documents.length });
  for (const item of list as Array<{ index?: unknown; relevance_score?: unknown; score?: unknown }>) {
    const score = settings.format === 'tei' ? item?.score : item?.relevance_score;
    if (!Number.isSafeInteger(item?.index) || Number(item.index) < 0 || Number(item.index) >= documents.length || typeof score !== 'number' || !Number.isFinite(score)) throw new Error('重排服务返回的结果无效');
    scores[Number(item.index)] = score;
  }
  // Services report billed input differently; none of this is required.
  const usage = body as { tokens?: { input_tokens?: unknown }; meta?: { tokens?: { input_tokens?: unknown } }; usage?: { total_tokens?: unknown } };
  const used = usage?.tokens?.input_tokens ?? usage?.meta?.tokens?.input_tokens ?? usage?.usage?.total_tokens;
  return { scores, tokens: Number.isSafeInteger(used) && Number(used) >= 0 ? Number(used) : null };
}
