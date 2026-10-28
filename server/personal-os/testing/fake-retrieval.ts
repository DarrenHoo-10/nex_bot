import { createServer } from 'node:http';

// A local stand-in for an embeddings service and a reranker. Embeddings are deterministic: every keyword group
// ("bucket") is one dimension, so a paraphrase that uses another word of the same group is close to its source and
// unrelated text is orthogonal. No real provider is ever involved.
export const BUCKETS = [
  ['部署', '上线', '发布', 'deploy', 'release'],
  ['天气', '下雨', '气温', 'weather'],
  ['咖啡', '拿铁', 'coffee'],
  ['旅行', '机票', '酒店'],
  ['数据库', 'sqlite', 'postgres'],
  ['会议', '日程'],
];
export const FAKE_DIMS = BUCKETS.length + 2;

/** The bucket vector of a text (`dims` wide; padded with zeros or cut). */
export function fakeEmbedding(value: string, dims = FAKE_DIMS): number[] {
  const text = value.toLocaleLowerCase();
  const vector = [...BUCKETS.map((words) => words.reduce((sum, word) => sum + text.split(word).length - 1, 0)), 0, 0.01];
  while (vector.length < dims) vector.push(0);
  return vector.slice(0, dims);
}
const grams = (value: string) => { const set = new Set<string>(); for (let i = 0; i + 3 <= value.length; i++) set.add(value.slice(i, i + 3)); return set; };
/** Relevance: a shared bucket or a shared trigram counts as relevant. */
export function fakeScore(query: string, document: string) {
  const q = fakeEmbedding(query), d = fakeEmbedding(document);
  if (q.slice(0, BUCKETS.length).some((value, index) => value > 0 && d[index] > 0)) return 0.9;
  const lower = document.toLocaleLowerCase();
  return [...grams(query.toLocaleLowerCase())].some((gram) => lower.includes(gram)) ? 0.8 : 0.1;
}

export interface FakeRequest { path: string; authorization?: string; body: Record<string, unknown> }

export async function startFakeRetrieval() {
  const requests: FakeRequest[] = [];
  const state = {
    embedStatus: 200, rerankStatus: 200, embedDelay: 0, rerankDelay: 0,
    /** Replaces the rerank scores when set (by document index). */
    scores: undefined as undefined | ((query: string, documents: string[]) => number[]),
    /** Reports no usage when false. */
    usage: true,
    /** Garbage instead of JSON. */
    garbage: false,
    /** Answers with the default width whatever was asked for. */
    ignoreDimensions: false,
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>;
    const path = req.url ?? '';
    requests.push({ path, authorization: req.headers.authorization, body });
    const reply = (status: number, value: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(state.garbage && status === 200 ? '<html>nope</html>' : JSON.stringify(value)); };
    if (path === '/embeddings') {
      await new Promise((resolve) => setTimeout(resolve, state.embedDelay));
      if (state.embedStatus !== 200) return reply(state.embedStatus, { error: 'upstream failure' });
      const input = body.input as string[], dims = state.ignoreDimensions ? FAKE_DIMS : Number(body.dimensions ?? FAKE_DIMS);
      return reply(200, { data: input.map((value, index) => ({ index, embedding: fakeEmbedding(value, dims) })), ...(state.usage ? { usage: { prompt_tokens: input.reduce((sum, value) => sum + value.length, 0), total_tokens: 0 } } : {}) });
    }
    if (path === '/rerank') {
      await new Promise((resolve) => setTimeout(resolve, state.rerankDelay));
      if (state.rerankStatus !== 200) return reply(state.rerankStatus, { error: 'upstream failure' });
      const tei = Array.isArray(body.texts), documents = (tei ? body.texts : body.documents) as string[], query = String(body.query);
      const scores = state.scores ? state.scores(query, documents) : documents.map((document) => fakeScore(query, document));
      // Services sort by score, best first; the client must map by index.
      const order = scores.map((score, index) => ({ index, score })).sort((a, b) => b.score - a.score);
      return reply(200, tei ? order.map(({ index, score }) => ({ index, score })) : { results: order.map(({ index, score }) => ({ index, relevance_score: score })), ...(state.usage ? { tokens: { input_tokens: 77, output_tokens: 0 } } : {}) });
    }
    reply(404, { error: 'unknown' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed');
  return {
    origin: `http://127.0.0.1:${address.port}`, requests, state,
    count: (path: string) => requests.filter((request) => request.path === path).length,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
