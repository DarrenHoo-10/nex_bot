import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPersonalApp } from './index.ts';
import { CoreStore, hash, id, now } from './store.ts';
import { startFakeRetrieval } from './testing/fake-retrieval.ts';
import { startFakePersonalMemory } from './testing/fake-personal-memory.ts';
import { queryTerms } from './retrieval-index.ts';
import { retrievalDefaultsFromEnvironment, type RetrievalDefaults } from './retrieval-config.ts';
import { RERANK_DOC_TOKENS, RERANK_THRESHOLD, VECTOR_ONLY_MIN_SIMILARITY } from './retrieval.ts';
import { EMBED_BUDGET_EXHAUSTED, EMBED_DAILY_TOKENS } from './assistant-memory.ts';
import { assistantCompletion } from './assistant-model.ts';
import { tokens } from './token-estimate.ts';

type App = Awaited<ReturnType<typeof createPersonalApp>>;
const fixtures: Array<{ root: string; app: App; fake: Awaited<ReturnType<typeof startFakeRetrieval>> }> = [];
const extra: Array<{ close(): Promise<void> }> = [];

async function fixture(retrieval?: RetrievalDefaults) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nex-retrieval-')), fake = await startFakeRetrieval();
  const app = await createPersonalApp({ dir: root, key: randomBytes(32), token: 'synthetic-token', identity: false, memoryRuntime: false, hostDevice: false, retrieval });
  app.store.saveConfig({ provider: 'openai', endpoint: fake.origin + '/v1', model: 'fixture-chat', apiKey: 'synthetic-only', contextWindow: 64000, maxOutputTokens: 4096 });
  const bot = app.store.createBot('合成检索助手');
  clearInterval(app.runtime.memory.personal.timer);
  fixtures.push({ root, app, fake });
  return { root, app, fake, bot, retrieval: app.runtime.memory.retrieval, config: app.runtime.memory.retrieval.config, personal: app.runtime.memory.personal };
}
afterEach(async () => {
  for (const item of extra.splice(0)) await item.close();
  for (const { root, app, fake } of fixtures.splice(0)) {
    await app.close(); await fake.close();
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('nex-retrieval-')) throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

/** A memory resting on a real, verifiable message of the assistant. Returns the memory id. */
function remember(app: App, bot: string, title: string, content: string, kind = 'fact') {
  const source = 'source-' + id();
  app.agents.publish(bot, 'user', 'message', content, source);
  const message = app.store.get('SELECT id,seq FROM agent_messages WHERE source_key=?', source)!, messageId = String(message.id), seq = Number(message.seq);
  app.runtime.memory.personal.put(bot, kind, title, content, [{ id: messageId, hash: hash(content) }]);
  // The memory pump must not try to extract from the seed messages.
  app.store.run('UPDATE assistant_memory_settings SET cursor_seq=? WHERE bot_id=?', seq, bot);
  return String(app.store.get('SELECT id FROM assistant_memories WHERE bot_id=? AND title=? ORDER BY created_at DESC', bot, title)!.id);
}
function archive(app: App, bot: string, title: string, brief: string) {
  const conversation = app.store.createConversation(bot), key = id().slice(0, 8);
  return app.runtime.episodes.save({ botId: bot, conversationId: conversation, firstEntry: key, lastEntry: key + 'z', startedAt: now() - 1000, endedAt: now(), archive: { title, brief, topics: [], decisions: [], operations: [], openItems: [], refs: [] } });
}
/** Turns long-term memory on and keeps the language-model steps of the pump idle, so a pump only vectorizes. */
function enableMemory(app: App) {
  app.runtime.memory.personal.saveGlobal({ version: 0, enabled: true });
  app.store.run('UPDATE assistant_memory_settings SET consolidated_at=?', now() + 3_600_000);
}
async function pump(app: App) {
  app.store.run('UPDATE assistant_memory_settings SET next_attempt=0');
  await app.runtime.memory.personal.flush();
}
const embeddingOn = async (fake: { origin: string }, config: { save(data: Record<string, unknown>): Promise<unknown>; view(): { embedding: { version: number } } }, extraSettings: Record<string, unknown> = {}) =>
  config.save({ kind: 'embedding', baseUrl: fake.origin, model: 'fake-embed', enabled: true, version: config.view().embedding.version, ...extraSettings });
const rerankOn = async (fake: { origin: string }, config: { save(data: Record<string, unknown>): Promise<unknown>; view(): { rerank: { version: number } } }, extraSettings: Record<string, unknown> = {}) =>
  config.save({ kind: 'rerank', format: 'cohere', baseUrl: fake.origin, model: 'fake-rerank', enabled: true, version: config.view().rerank.version, ...extraSettings });
const titles = (result: { candidates: Array<{ title: string }> }) => result.candidates.map((item) => item.title);

describe('query terms', () => {
  it('cuts CJK runs into trigrams, keeps identifiers whole and in parts, and keeps 2-character terms apart', () => {
    expect(queryTerms('东京办公室')).toEqual({ long: ['东京办', '京办公', '办公室'], short: [] });
    expect(queryTerms('server/personal-os 部署')).toEqual({ long: ['server/personal-os', 'server', 'personal'], short: ['os', '部署'] });
    expect(queryTerms('Go')).toEqual({ long: [], short: ['go'] });
    expect(queryTerms('面')).toEqual({ long: [], short: ['面'] });
    expect(queryTerms('，。 ')).toEqual({ long: [], short: [] });
    expect(queryTerms('core部署到东京').long).toEqual(['core', '部署到', '署到东', '到东京']);
  });
});

describe('BM25 over trigram indexes', () => {
  it('finds Chinese, English and code-identifier substrings, in all three kinds of the pool', async () => {
    const { app, bot, retrieval } = await fixture();
    remember(app, bot, '部署约定', '我们每周二下午三点在东京办公室开例会，部署前先通知运维');
    remember(app, bot, '代码位置', '检索实现在 server/personal-os/retrieval.ts 里');
    remember(app, bot, '无关', '今天中午吃了面条');
    app.runtime.memory.write(bot, { title: '运维手册', content: 'PostgreSQL 备份每日凌晨执行，保留 14 天' });
    archive(app, bot, '迁移讨论', '决定把定时任务迁移到新的调度服务');
    // A 3+ character piece inside a longer run of Chinese.
    expect(titles(await retrieval.retrieve(bot, '东京办公室'))).toEqual(['部署约定']);
    // A path, case-insensitively, and a piece of a longer English word.
    expect(titles(await retrieval.retrieve(bot, 'Server/Personal-OS'))).toEqual(['代码位置']);
    expect(titles(await retrieval.retrieve(bot, 'retriev'))).toEqual(['代码位置']);
    expect(titles(await retrieval.retrieve(bot, 'postgres 备份'))).toEqual(['运维手册']);
    expect(titles(await retrieval.retrieve(bot, '调度服务'))).toEqual(['迁移讨论']);
    // Candidates carry what callers need.
    const [hit] = (await retrieval.retrieve(bot, '东京办公室')).candidates;
    expect(hit).toMatchObject({ kind: 'memory', title: '部署约定', sources: ['bm25'] });
    expect(hit.ref).toBe(`memory:${hit.refId}`);
    expect(hit.tokens).toBe(tokens(hit.text));
  });
  it('falls back to substring matching for terms shorter than a trigram', async () => {
    const { app, bot, retrieval } = await fixture();
    remember(app, bot, '午餐', '午餐吃面条');
    remember(app, bot, '语言', 'Go 语言的项目');
    remember(app, bot, '晚餐', '晚上吃米饭');
    expect(titles(await retrieval.retrieve(bot, '午餐'))).toEqual(['午餐']);
    expect(titles(await retrieval.retrieve(bot, 'go'))).toEqual(['语言']);
    expect(titles(await retrieval.retrieve(bot, '餐'))).toEqual(expect.arrayContaining(['午餐', '晚餐']));
    expect(titles(await retrieval.retrieve(bot, 'zz'))).toEqual([]);
    expect(titles(await retrieval.retrieve(bot, '   '))).toEqual([]);
    // Short terms are escaped, not interpreted as patterns.
    expect(titles(await retrieval.retrieve(bot, '%_'))).toEqual([]);
  });
  it('shows an assistant its own memories only, active ones with verifiable sources', async () => {
    const { app, bot, retrieval } = await fixture();
    const other = app.store.createBot('另一助手');
    remember(app, bot, '我的偏好', '偏好使用深色主题');
    remember(app, other, '别人的偏好', '偏好使用深色主题');
    const tampered = remember(app, bot, '被篡改', '深色主题的补充说明');
    const stale = remember(app, bot, '已过期', '深色主题的旧版本');
    app.store.run("UPDATE agent_messages SET content=content||'（改动）' WHERE id=(SELECT json_extract(refs_json,'$[0].id') FROM assistant_memories WHERE id=?)", tampered);
    app.store.run("UPDATE assistant_memories SET status='stale' WHERE id=?", stale);
    expect(titles(await retrieval.retrieve(bot, '深色主题'))).toEqual(['我的偏好']);
    expect(titles(await retrieval.retrieve(other, '深色主题'))).toEqual(['别人的偏好']);
    // Documents of the workspace are shared; those of another assistant are not.
    app.runtime.memory.write(bot, { title: '共享手册', content: '深色主题规范', scope: 'workspace' });
    app.runtime.memory.write(other, { title: '私有手册', content: '深色主题规范' });
    expect((await retrieval.retrieve(bot, '深色主题规范', { kinds: ['document'] })).candidates.map((item) => item.title)).toEqual(['共享手册']);
  });
});

describe('hybrid retrieval', () => {
  it('finds a paraphrase by vector that shares no words with the query, and ranks it above weaker vector matches', async () => {
    const { app, bot, fake, retrieval, config } = await fixture();
    remember(app, bot, '发布步骤', '周五晚上上线东京服务器，之后通知运维');
    remember(app, bot, '混合记录', '上线时天气不好，推迟了一小时');
    remember(app, bot, '天气', '今天下雨，气温很低');
    remember(app, bot, '咖啡偏好', '喜欢拿铁');
    enableMemory(app);
    // Without vectors, nothing shares a word with the query.
    expect(titles(await retrieval.retrieve(bot, '部署流程'))).toEqual([]);
    await embeddingOn(fake, config);
    await pump(app);
    expect(app.store.get('SELECT COUNT(*) n FROM memory_vectors')!.n).toBe(4);
    const result = await retrieval.retrieve(bot, '部署流程');
    expect(titles(result)).toEqual(['发布步骤', '混合记录']);
    expect(result.candidates.map((item) => item.sources)).toEqual([['vector'], ['vector']]);
    expect(result).toMatchObject({ vector: true, reranked: false, budget: 1000, degraded: [] });
    // The weaker match has similarity just above the floor; unrelated text has none.
    expect(VECTOR_ONLY_MIN_SIMILARITY).toBeLessThan(0.71);
  });
  it('merges BM25 and vector lists with reciprocal rank fusion (k=60) and deduplicates', async () => {
    const { app, bot, fake, retrieval, config } = await fixture();
    const both = remember(app, bot, '两路都中', '东京服务器的部署流程：先发布再验证');
    const lexicalOnly = remember(app, bot, '只词法', '东京服务器的机房位置');
    const vectorOnly = remember(app, bot, '只向量', '上线检查清单');
    enableMemory(app);
    await embeddingOn(fake, config); await pump(app);
    const result = await retrieval.retrieve(bot, '东京服务器的部署');
    expect(result.candidates.map((item) => item.refId)).toEqual([both, lexicalOnly, vectorOnly]);
    expect(result.candidates.map((item) => item.sources)).toEqual([['bm25', 'vector'], ['bm25', 'vector'], ['vector']]);
    expect(new Set(result.candidates.map((item) => item.refId)).size).toBe(3);
    // Scores are fusion scores: a rank in both lists adds both terms.
    const [first, second, third] = result.candidates.map((item) => item.score);
    expect(first).toBeGreaterThan(second); expect(second).toBeGreaterThan(third);
    expect(first).toBeCloseTo(1 / 61 + 1 / 62, 6);
    expect(third).toBeCloseTo(1 / 61, 6);
  });
  it('keeps at most 20 fused candidates and sends the reranker no more, each clipped to 512 tokens', async () => {
    const { app, bot, fake, retrieval, config } = await fixture();
    for (let i = 0; i < 25; i++) remember(app, bot, `项目笔记${i}`, `项目进展记录第${i}条。` + '细节内容，'.repeat(600));
    await rerankOn(fake, config, { apiKey: 'rerank-secret-key' });
    const result = await retrieval.retrieve(bot, '项目进展记录');
    expect(result.candidates.length).toBeLessThanOrEqual(20);
    const request = fake.requests.filter((item) => item.path === '/rerank').at(-1)!;
    expect(request.authorization).toBe('Bearer rerank-secret-key');
    expect(request.body).toMatchObject({ model: 'fake-rerank', query: '项目进展记录' });
    const documents = request.body.documents as string[];
    expect(documents).toHaveLength(20);
    expect(request.body.top_n).toBe(20);
    expect(Math.max(...documents.map((item) => tokens(item)))).toBeLessThanOrEqual(RERANK_DOC_TOKENS);
    expect(Math.min(...documents.map((item) => tokens(item)))).toBeGreaterThan(400);
  });
  it('drops candidates the reranker scores below the threshold and sorts the rest by score', async () => {
    const { app, bot, fake, retrieval, config } = await fixture();
    remember(app, bot, '甲', '项目方案 ALPHA');
    remember(app, bot, '乙', '项目方案 BRAVO');
    remember(app, bot, '丙', '项目方案 CHARLIE');
    remember(app, bot, '丁', '项目方案 DELTA');
    fake.state.scores = (_query, documents) => documents.map((document) => document.includes('BRAVO') ? 0.95 : document.includes('CHARLIE') ? RERANK_THRESHOLD : document.includes('ALPHA') ? 0.6 : RERANK_THRESHOLD - 0.01);
    await rerankOn(fake, config);
    const result = await retrieval.retrieve(bot, '项目方案');
    expect(titles(result)).toEqual(['乙', '甲', '丙']);
    expect(result.candidates.map((item) => item.score)).toEqual([0.95, 0.6, RERANK_THRESHOLD]);
    expect(result.candidates.every((item) => item.sources.includes('rerank'))).toBe(true);
    expect(result).toMatchObject({ reranked: true, budget: 2000, degraded: [] });
  });
  it('speaks the TEI wire format when configured', async () => {
    const { app, bot, fake, retrieval, config } = await fixture();
    remember(app, bot, '甲', '项目方案 一');
    remember(app, bot, '乙', '项目方案 二');
    fake.state.scores = (_query, documents) => documents.map((document) => document.includes('二') ? 0.9 : 0.5);
    await rerankOn(fake, config, { format: 'tei', model: '' });
    const result = await retrieval.retrieve(bot, '项目方案');
    expect(titles(result)).toEqual(['乙', '甲']);
    const request = fake.requests.filter((item) => item.path === '/rerank').at(-1)!;
    expect(Object.keys(request.body).sort()).toEqual(['query', 'texts']);
    expect(request.body.texts).toHaveLength(2);
  });
  it('remembers rerank scores and query embeddings briefly, so a task repeating a request pays once', async () => {
    const { app, bot, fake, retrieval, config } = await fixture();
    remember(app, bot, '甲', '部署方案');
    await embeddingOn(fake, config); await rerankOn(fake, config);
    await retrieval.retrieve(bot, '部署方案');
    await retrieval.retrieve(bot, '部署方案');
    expect(fake.count('/embeddings')).toBe(2); // the settings test, and one query
    expect(fake.count('/rerank')).toBe(2);
  });
});

describe('degradation', () => {
  async function ready() {
    const context = await fixture();
    remember(context.app, context.bot, '发布步骤', '周五晚上上线东京服务器，部署前通知运维');
    remember(context.app, context.bot, '部署约定', '部署前先通知运维，不要在周五晚上发布');
    enableMemory(context.app);
    await embeddingOn(context.fake, context.config); await rerankOn(context.fake, context.config);
    await pump(context.app);
    context.fake.requests.length = 0;
    return context;
  }
  it('uses BM25 alone when nothing is configured, and says the order is unvouched', async () => {
    const { app, bot, retrieval } = await fixture();
    remember(app, bot, '部署约定', '部署前先通知运维');
    const result = await retrieval.retrieve(bot, '通知运维');
    expect(titles(result)).toEqual(['部署约定']);
    expect(result).toMatchObject({ vector: false, reranked: false, budget: 1000, degraded: [] });
    expect(app.store.get("SELECT COUNT(*) n FROM assistant_usage WHERE purpose IN ('embed','rerank')")!.n).toBe(0);
  });
  it('works with vectors and rerank when both answer', async () => {
    const { bot, retrieval } = await ready();
    const result = await retrieval.retrieve(bot, '部署前通知运维 up');
    expect(result).toMatchObject({ vector: true, reranked: true, budget: 2000, degraded: [] });
    expect(result.candidates.length).toBeGreaterThan(0);
  });
  it.each([
    ['the embedding service fails', (fake: Awaited<ReturnType<typeof startFakeRetrieval>>) => { fake.state.embedStatus = 500; }, { vector: false, reranked: true, budget: 2000, degraded: ['embedding'] }],
    ['the reranker fails', (fake: Awaited<ReturnType<typeof startFakeRetrieval>>) => { fake.state.rerankStatus = 503; }, { vector: true, reranked: false, budget: 1000, degraded: ['rerank'] }],
    ['both fail', (fake: Awaited<ReturnType<typeof startFakeRetrieval>>) => { fake.state.embedStatus = 500; fake.state.rerankStatus = 500; }, { vector: false, reranked: false, budget: 1000, degraded: ['embedding', 'rerank'] }],
    ['both answer garbage', (fake: Awaited<ReturnType<typeof startFakeRetrieval>>) => { fake.state.garbage = true; }, { vector: false, reranked: false, budget: 1000, degraded: ['embedding', 'rerank'] }],
  ])('returns BM25 or rank-fusion results without throwing when %s', async (_name, break_, expected) => {
    const { bot, fake, retrieval, app } = await ready();
    break_(fake);
    const result = await retrieval.retrieve(bot, `部署约定 ${_name}`);
    expect(result).toMatchObject(expected);
    expect(titles(result)).toContain('部署约定');
    // Failed calls are accounted as failed with no tokens.
    for (const purpose of expected.degraded.map((stage) => stage === 'embedding' ? 'embed' : 'rerank')) expect(app.store.get("SELECT status,input_tokens FROM assistant_usage WHERE purpose=? ORDER BY created_at DESC,rowid DESC", purpose)).toMatchObject({ status: 'failed', input_tokens: 0 });
  });
  it('gives up on a slow embedding service within the overall timeout and still answers', async () => {
    const { bot, fake, retrieval } = await ready();
    fake.state.embedDelay = 3000;
    const started = Date.now();
    const result = await retrieval.retrieve(bot, '部署约定 超时', { timeoutMs: 600 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result).toMatchObject({ vector: false, degraded: ['embedding'] });
    expect(titles(result)).toContain('部署约定');
  });
  it('gives up on a slow reranker within the overall timeout and falls back to rank fusion', async () => {
    const { bot, fake, retrieval } = await ready();
    fake.state.rerankDelay = 3000;
    const started = Date.now();
    const result = await retrieval.retrieve(bot, '部署约定 重排超时', { timeoutMs: 800 });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(result).toMatchObject({ vector: true, reranked: false, budget: 1000, degraded: ['rerank'] });
    expect(titles(result)).toContain('部署约定');
  });
  it('records embedding and rerank usage with the provider’s count, or the estimate when it reports none', async () => {
    const { bot, fake, retrieval, app } = await ready();
    await retrieval.retrieve(bot, '部署约定 用量甲');
    fake.state.usage = false;
    await retrieval.retrieve(bot, '部署约定 用量乙');
    const rows = app.store.all("SELECT purpose,status,input_tokens,output_tokens,reserved_tokens,model FROM assistant_usage WHERE purpose IN ('embed','rerank') AND created_at>=? ORDER BY created_at,rowid", now() - 60_000);
    expect(rows.filter((row) => row.purpose === 'rerank').map((row) => [row.status, row.input_tokens === 77, row.model])).toEqual([['succeeded', true, 'fake-rerank'], ['succeeded', false, 'fake-rerank']]);
    expect(rows.every((row) => row.output_tokens === 0 || row.status !== 'succeeded')).toBe(true);
    expect(app.runtime.memory.personal.summary().incomplete).toBe(false);
  });
  it('does not count embedding or rerank usage against the memory model’s daily budget', async () => {
    const { app, bot } = await fixture();
    const chat = await startFakePersonalMemory(); extra.push(chat);
    app.store.saveConfig({ provider: 'openai', endpoint: chat.origin + '/v1', model: 'fixture-chat', apiKey: 'synthetic-only', contextWindow: 64000, maxOutputTokens: 4096 });
    for (const purpose of ['embed', 'rerank']) app.store.run("INSERT INTO assistant_usage(id,bot_id,purpose,model,status,reserved_tokens,input_tokens,output_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?)", id(), bot, purpose, 'x', 'succeeded', 9_000_000, 9_000_000, 0, now());
    await expect(assistantCompletion(app.store, { botId: bot, purpose: 'retain', dailyBudget: 100_000, instruction: 'x', content: 'y' })).resolves.toBeTypeOf('string');
    app.store.run("INSERT INTO assistant_usage(id,bot_id,purpose,model,status,reserved_tokens,input_tokens,output_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?)", id(), bot, 'retain', 'x', 'succeeded', 600_000, 600_000, 0, now());
    await expect(assistantCompletion(app.store, { botId: bot, purpose: 'retain', dailyBudget: 100_000, instruction: 'x', content: 'y' })).rejects.toThrow('预算');
  });
});

describe('exact identifiers', () => {
  it('return the record without ranking or any model call', async () => {
    const { app, bot, fake, retrieval, config } = await fixture();
    await embeddingOn(fake, config); await rerankOn(fake, config);
    fake.requests.length = 0;
    const memory = remember(app, bot, '偏好', '偏好深色主题');
    const episode = archive(app, bot, '段落', '讨论过部署');
    const document = app.runtime.memory.write(bot, { title: '手册', content: '备份手册内容' }).documentId as string;
    const messageId = String(app.store.get('SELECT id FROM agent_messages WHERE bot_id=?', bot)!.id);
    retrieval.resolveEntry = (botId, entryId) => botId === bot && entryId === 'abc123' ? { id: entryId, content: '工具输出原文' } : undefined;
    expect((await retrieval.retrieve(bot, `memory:${memory}`)).candidates).toMatchObject([{ kind: 'memory', title: '偏好', sources: ['exact'] }]);
    expect((await retrieval.retrieve(bot, `memory:${document}`)).candidates).toMatchObject([{ kind: 'document', title: '手册', text: '备份手册内容' }]);
    expect((await retrieval.retrieve(bot, `episode:${episode}`)).candidates).toMatchObject([{ kind: 'episode', ref: `episode:${episode}` }]);
    expect((await retrieval.retrieve(bot, `message:${messageId}`)).candidates).toMatchObject([{ kind: 'message', text: '偏好深色主题', ref: `message:${messageId}` }]);
    expect((await retrieval.retrieve(bot, 'entry:abc123')).candidates).toMatchObject([{ kind: 'entry', text: '工具输出原文' }]);
    expect((await retrieval.retrieve(bot, 'entry:nope')).candidates).toEqual([]);
    expect((await retrieval.retrieve(bot, 'memory:does-not-exist')).candidates).toEqual([]);
    // Other assistants' records are not reachable by id.
    const other = app.store.createBot('另一助手');
    expect((await retrieval.retrieve(other, `memory:${memory}`)).candidates).toEqual([]);
    expect((await retrieval.retrieve(other, `episode:${episode}`)).candidates).toEqual([]);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('configuration', () => {
  const embeddingEnv = { NEX_EMBEDDINGS_BASE_URL: 'https://embed.example/v1/', NEX_EMBEDDINGS_MODEL: 'default-embed', NEX_EMBEDDINGS_DIMENSIONS: '1024', NEX_EMBEDDINGS_API_KEY: 'default-embed-key' };
  const rerankEnv = { NEX_RERANK_FORMAT: 'cohere', NEX_RERANK_BASE_URL: 'https://rerank.example/v1', NEX_RERANK_MODEL: 'default-rerank', NEX_RERANK_API_KEY: 'default-rerank-key' };
  it('reads the server defaults from the environment and ignores incomplete or invalid ones', () => {
    expect(retrievalDefaultsFromEnvironment({ ...embeddingEnv, ...rerankEnv })).toEqual({
      embedding: { baseUrl: 'https://embed.example/v1', model: 'default-embed', dimensions: 1024, apiKey: 'default-embed-key' },
      rerank: { format: 'cohere', baseUrl: 'https://rerank.example/v1', model: 'default-rerank', apiKey: 'default-rerank-key' },
    });
    expect(retrievalDefaultsFromEnvironment({})).toEqual({});
    expect(retrievalDefaultsFromEnvironment({ NEX_EMBEDDINGS_BASE_URL: 'https://embed.example' })).toEqual({});
    expect(retrievalDefaultsFromEnvironment({ NEX_EMBEDDINGS_BASE_URL: 'ftp://x', NEX_EMBEDDINGS_MODEL: 'm' })).toEqual({});
    expect(retrievalDefaultsFromEnvironment({ NEX_EMBEDDINGS_BASE_URL: 'https://u:p@x', NEX_EMBEDDINGS_MODEL: 'm' })).toEqual({});
    expect(retrievalDefaultsFromEnvironment({ NEX_EMBEDDINGS_BASE_URL: 'https://x', NEX_EMBEDDINGS_MODEL: 'm', NEX_EMBEDDINGS_DIMENSIONS: 'abc' })).toEqual({ embedding: { baseUrl: 'https://x', model: 'm' } });
    expect(retrievalDefaultsFromEnvironment({ NEX_RERANK_BASE_URL: 'http://tei.lan:8080', NEX_RERANK_FORMAT: 'tei' })).toEqual({ rerank: { format: 'tei', baseUrl: 'http://tei.lan:8080', model: '' } });
    expect(retrievalDefaultsFromEnvironment({ NEX_RERANK_BASE_URL: 'https://x' })).toEqual({});
    expect(retrievalDefaultsFromEnvironment({ NEX_RERANK_BASE_URL: 'https://x', NEX_RERANK_MODEL: 'm', NEX_RERANK_FORMAT: 'other' })).toEqual({});
  });
  it('resolves each item on its own: custom settings, then the server default, then off', async () => {
    const { fake, config } = await fixture();
    expect(config.embedding()).toBeUndefined(); expect(config.rerank()).toBeUndefined();
    expect(config.view()).toMatchObject({ embedding: { source: 'disabled', default: null, custom: null }, rerank: { source: 'disabled', default: null, custom: null } });
    config.defaults = retrievalDefaultsFromEnvironment({ ...embeddingEnv, ...rerankEnv });
    expect(config.embedding()).toMatchObject({ source: 'default', model: 'default-embed', apiKey: 'default-embed-key' });
    // The default shows its model name and nothing else.
    expect(config.view().embedding).toEqual({ source: 'default', model: 'default-embed', version: 0, default: { model: 'default-embed' }, custom: null });
    expect(config.view().rerank).toEqual({ source: 'default', model: 'default-rerank', format: 'cohere', version: 0, default: { model: 'default-rerank', format: 'cohere' }, custom: null });
    // A custom embedding does not touch the rerank default.
    await embeddingOn(fake, config, { apiKey: 'custom-key' });
    expect(config.embedding()).toMatchObject({ source: 'custom', model: 'fake-embed', baseUrl: fake.origin, apiKey: 'custom-key' });
    expect(config.rerank()).toMatchObject({ source: 'default', model: 'default-rerank' });
    expect(config.view().embedding).toMatchObject({ source: 'custom', model: 'fake-embed', custom: { enabled: true, baseUrl: fake.origin, model: 'fake-embed', dimensions: null, hasKey: true }, default: { model: 'default-embed' } });
    // Switched off by the user, even though a default exists.
    await config.save({ kind: 'embedding', enabled: false, baseUrl: fake.origin, model: 'fake-embed', version: config.view().embedding.version });
    expect(config.embedding()).toBeUndefined();
    expect(config.view().embedding).toMatchObject({ source: 'disabled', custom: { enabled: false } });
    // Back to the default.
    await config.save({ kind: 'embedding', reset: true, version: config.view().embedding.version });
    expect(config.embedding()).toMatchObject({ source: 'default' });
    expect(config.view().embedding.custom).toBeNull();
  });
  it('never exposes a key: encrypted at rest, absent from every view', async () => {
    const { app, fake, config } = await fixture();
    config.defaults = retrievalDefaultsFromEnvironment({ ...embeddingEnv, ...rerankEnv });
    await embeddingOn(fake, config, { apiKey: 'sk-very-secret-embedding' });
    await rerankOn(fake, config, { apiKey: 'sk-very-secret-rerank' });
    const view = JSON.stringify(config.view());
    for (const secret of ['sk-very-secret-embedding', 'sk-very-secret-rerank', 'default-embed-key', 'default-rerank-key', 'embed.example']) expect(view).not.toContain(secret);
    const stored = app.store.all("SELECT id,ciphertext FROM secrets WHERE id LIKE 'retrieval-%'");
    expect(stored).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toContain('sk-very-secret');
    expect(app.store.decrypt(String(stored.find((row) => row.id === 'retrieval-embedding-key')!.ciphertext))).toBe('sk-very-secret-embedding');
    expect(JSON.stringify(app.store.all('SELECT * FROM memory_retrieval_settings'))).not.toContain('sk-very-secret');
    expect(JSON.stringify(app.store.all("SELECT details_json FROM audit_records WHERE action='memory.retrieval.configure'"))).not.toContain('sk-very-secret');
    // The service gets it as a bearer token.
    expect(fake.requests.at(-1)!.authorization).toBe('Bearer sk-very-secret-rerank');
  });
  it('keeps a blank key for the same address and drops it when the address moves', async () => {
    const { app, fake, config } = await fixture();
    await embeddingOn(fake, config, { apiKey: 'kept-key' });
    await embeddingOn(fake, config, { model: 'fake-embed-2' });
    expect(config.embedding()).toMatchObject({ model: 'fake-embed-2', apiKey: 'kept-key' });
    expect(fake.requests.at(-1)!.authorization).toBe('Bearer kept-key');
    await embeddingOn(fake, config, { baseUrl: fake.origin.replace('127.0.0.1', 'localhost') });
    expect(config.embedding()!.apiKey).toBeUndefined();
    expect(app.store.get("SELECT id FROM secrets WHERE id='retrieval-embedding-key'")).toBeUndefined();
    expect(fake.requests.at(-1)!.authorization).toBeUndefined();
  });
  it('rejects a save whose test request fails, and stores nothing', async () => {
    const { fake, config } = await fixture();
    fake.state.embedStatus = 500;
    await expect(embeddingOn(fake, config, { apiKey: 'never-stored' })).rejects.toThrow('测试请求失败：向量服务返回 500');
    expect(config.view().embedding).toMatchObject({ source: 'disabled', custom: null, version: 0 });
    fake.state.embedStatus = 200; fake.state.rerankStatus = 502;
    await expect(rerankOn(fake, config)).rejects.toThrow('测试请求失败：重排服务返回 502');
    fake.state.rerankStatus = 200; fake.state.garbage = true;
    await expect(rerankOn(fake, config)).rejects.toThrow('测试请求失败');
    fake.state.garbage = false; fake.state.ignoreDimensions = true;
    await expect(embeddingOn(fake, config, { dimensions: 4 })).rejects.toThrow('维度');
    fake.state.ignoreDimensions = false;
    expect(config.view().rerank.custom).toBeNull();
    // The test request is one text to embed, two documents to rank.
    fake.requests.length = 0;
    await embeddingOn(fake, config, { dimensions: 8 }); await rerankOn(fake, config);
    expect((fake.requests[0].body.input as string[]).length).toBe(1);
    expect(fake.requests[0].body.dimensions).toBe(8);
    expect((fake.requests[1].body.documents as string[]).length).toBe(2);
  });
  it('requires HTTPS except for localhost, and a model where the service needs one', async () => {
    const { fake, config } = await fixture();
    const save = (data: Record<string, unknown>) => config.save({ kind: 'embedding', model: 'm', enabled: true, version: 0, ...data });
    await expect(save({ baseUrl: 'http://example.com/v1' })).rejects.toThrow('HTTPS');
    await expect(save({ baseUrl: 'ftp://example.com' })).rejects.toThrow('HTTPS');
    await expect(save({ baseUrl: 'https://user:pw@example.com' })).rejects.toThrow('HTTPS');
    await expect(save({ baseUrl: 'https://example.com/v1?key=1' })).rejects.toThrow('HTTPS');
    await expect(save({ baseUrl: 'not a url' })).rejects.toThrow();
    await expect(save({ baseUrl: '' })).rejects.toThrow('服务地址');
    await expect(save({ baseUrl: fake.origin, model: '' })).rejects.toThrow('模型');
    await expect(save({ baseUrl: fake.origin, dimensions: 99999 })).rejects.toThrow('维度');
    await expect(config.save({ kind: 'rerank', baseUrl: fake.origin, model: '', format: 'cohere', enabled: true, version: 0 })).rejects.toThrow('模型');
    await expect(config.save({ kind: 'rerank', baseUrl: fake.origin, format: 'other', enabled: true, version: 0 })).rejects.toThrow('格式');
    await expect(config.save({ kind: 'other', version: 0 })).rejects.toThrow();
    // A TEI service names its own model; a switched-off item may be saved half-filled.
    await config.save({ kind: 'rerank', baseUrl: fake.origin, model: '', format: 'tei', enabled: true, version: 0 });
    await config.save({ kind: 'embedding', enabled: false, version: 0 });
    expect(config.view()).toMatchObject({ rerank: { source: 'custom' }, embedding: { source: 'disabled', custom: { enabled: false, baseUrl: '' } } });
    // A stale page cannot overwrite a newer save.
    await expect(config.save({ kind: 'embedding', enabled: false, version: 0 })).rejects.toThrow('已变化');
  });
  it('serves the settings through authenticated owner routes', async () => {
    const { fake, app, config } = await fixture({ embedding: { baseUrl: 'https://embed.example/v1', model: 'default-embed', apiKey: 'default-embed-key' } });
    const call = (method: 'GET' | 'POST', body?: unknown, token = 'synthetic-token') => fetch(app.origin + '/api/memory/retrieval', { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect((await call('GET', undefined, 'invalid')).status).toBe(401);
    expect((await call('POST', {}, 'invalid')).status).toBe(401);
    const initial = await (await call('GET')).text();
    expect(JSON.parse(initial)).toMatchObject({ embedding: { source: 'default', model: 'default-embed' }, rerank: { source: 'disabled' } });
    expect(initial).not.toContain('embed.example'); expect(initial).not.toContain('default-embed-key');
    const saved = await call('POST', { kind: 'rerank', baseUrl: fake.origin, model: 'route-rerank', format: 'cohere', apiKey: 'route-secret-key', enabled: true, version: 0 });
    const text = await saved.text();
    expect(saved.ok).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ rerank: { source: 'custom', model: 'route-rerank', custom: { hasKey: true } } });
    expect(text).not.toContain('route-secret-key');
    expect(await (await call('GET')).text()).not.toContain('route-secret-key');
    expect(config.rerank()).toMatchObject({ apiKey: 'route-secret-key' });
    fake.state.rerankStatus = 500;
    const failed = await call('POST', { kind: 'rerank', baseUrl: fake.origin, model: 'other', format: 'cohere', enabled: true, version: 1 });
    expect(failed.status).toBe(400);
    expect((await failed.json() as { error: string }).error).toContain('测试请求失败');
    expect(config.rerank()!.model).toBe('route-rerank');
  });
});

describe('vectors and their consistency', () => {
  it('vectorizes pending items in batches of at most 32 and records the usage', async () => {
    const { app, bot, fake, config } = await fixture();
    for (let i = 0; i < 70; i++) remember(app, bot, `记录${i}`, `第${i}条记录内容`);
    app.runtime.memory.write(bot, { title: '手册', content: '备份手册内容' });
    archive(app, bot, '段落', '讨论过部署');
    enableMemory(app);
    await embeddingOn(fake, config);
    fake.requests.length = 0;
    await pump(app);
    expect(app.store.get('SELECT COUNT(*) n FROM memory_vectors')!.n).toBe(72);
    expect(app.store.all('SELECT kind,COUNT(*) n FROM memory_vectors GROUP BY kind ORDER BY kind')).toMatchObject([{ kind: 'document', n: 1 }, { kind: 'episode', n: 1 }, { kind: 'memory', n: 70 }]);
    const batches = fake.requests.filter((item) => item.path === '/embeddings').map((item) => (item.body.input as string[]).length);
    expect(batches).toEqual([32, 32, 8]);
    const usage = app.store.all("SELECT status,model,input_tokens,task_id FROM assistant_usage WHERE purpose='embed' ORDER BY rowid");
    expect(usage).toHaveLength(3);
    expect(usage.every((row) => row.status === 'succeeded' && row.model === 'fake-embed' && Number(row.input_tokens) > 0 && row.task_id === null)).toBe(true);
    // Nothing is sent again while nothing changed.
    fake.requests.length = 0;
    await pump(app);
    expect(fake.requests).toHaveLength(0);
    expect(app.store.get('SELECT last_error FROM assistant_memory_settings WHERE bot_id=?', bot)!.last_error).toBeNull();
  });
  it('re-embeds under a new model or dimensions, ignoring old vectors meanwhile', async () => {
    const { app, bot, fake, retrieval, config } = await fixture();
    remember(app, bot, '发布步骤', '周五晚上上线东京服务器');
    enableMemory(app);
    await embeddingOn(fake, config); await pump(app);
    expect(titles(await retrieval.retrieve(bot, '部署流程'))).toEqual(['发布步骤']);
    await embeddingOn(fake, config, { model: 'fake-embed-v2' });
    // The old vector is another model's: not used, so only BM25 covers until the rebuild.
    expect(titles(await retrieval.retrieve(bot, '部署流程'))).toEqual([]);
    await pump(app);
    expect(app.store.all('SELECT model,dims FROM memory_vectors')).toMatchObject([{ model: 'fake-embed-v2', dims: 8 }]);
    expect(titles(await retrieval.retrieve(bot, '部署流程'))).toEqual(['发布步骤']);
    await embeddingOn(fake, config, { model: 'fake-embed-v2', dimensions: 12 });
    await pump(app);
    expect(app.store.all('SELECT model,dims FROM memory_vectors')).toMatchObject([{ model: 'fake-embed-v2', dims: 12 }]);
    expect(titles(await retrieval.retrieve(bot, '部署流程'))).toEqual(['发布步骤']);
  });
  it('ignores a vector whose content hash no longer matches, and rebuilds it', async () => {
    const { app, bot, fake, retrieval, config } = await fixture();
    const memory = remember(app, bot, '发布步骤', '周五晚上上线东京服务器');
    enableMemory(app);
    await embeddingOn(fake, config); await pump(app);
    expect(titles(await retrieval.retrieve(bot, '部署流程'))).toEqual(['发布步骤']);
    // Content changed behind the writers' back (no vector cleanup): the vector describes text that is gone.
    app.store.run('UPDATE assistant_memories SET content=? WHERE id=?', '今天下雨，气温很低', memory);
    expect(titles(await retrieval.retrieve(bot, '部署流程'))).toEqual([]);
    expect(app.store.get('SELECT COUNT(*) n FROM memory_vectors')!.n).toBe(1);
    await pump(app);
    expect(app.store.get('SELECT content_hash FROM memory_vectors')!.content_hash).toBe(hash('发布步骤\n今天下雨，气温很低'));
    expect(titles(await retrieval.retrieve(bot, '天气'))).toEqual(['发布步骤']);
  });
  it('removes vectors with the memory, document or archive in the same transaction that changes it', async () => {
    const { app, bot, fake, config, personal } = await fixture();
    const memory = remember(app, bot, '甲', '周五上线东京服务器');
    const forgotten = remember(app, bot, '乙', '密码规则：不要写进记忆 SECRET-NOTE');
    const document = app.runtime.memory.write(bot, { title: '手册', content: '发布手册内容' }).documentId as string;
    const other = app.runtime.memory.write(bot, { title: '手册二', content: '发布手册二' }).documentId as string;
    const episode = archive(app, bot, '段落', '讨论过上线');
    enableMemory(app);
    await embeddingOn(fake, config); await pump(app);
    const has = (kind: string, ref: string) => !!app.store.get('SELECT 1 x FROM memory_vectors WHERE kind=? AND ref_id=?', kind, ref);
    expect([has('memory', memory), has('document', document), has('episode', episode)]).toEqual([true, true, true]);
    // A memory rewritten by the maintenance pump, a document rewritten or deleted, an archive removed.
    personal.put(bot, 'fact', '甲', '周五上线西京服务器', JSON.parse(String(app.store.get('SELECT refs_json FROM assistant_memories WHERE id=?', memory)!.refs_json)), app.store.get('SELECT * FROM assistant_memories WHERE id=?', memory));
    expect(has('memory', memory)).toBe(false);
    const doc = app.store.get('SELECT version FROM memory_documents WHERE id=?', document)!;
    app.runtime.memory.write(bot, { title: '手册', content: '发布手册新内容', documentId: document, expectedVersion: Number(doc.version) });
    expect(has('document', document)).toBe(false);
    app.runtime.memory.remove(other, Number(app.store.get('SELECT version FROM memory_documents WHERE id=?', other)!.version));
    expect(has('document', other)).toBe(false);
    app.runtime.episodes.remove(episode);
    expect(has('episode', episode)).toBe(false);
    // Forgetting redacts the document and deletes the memories resting on the forgotten message, vectors included.
    await pump(app);
    expect([has('memory', memory), has('document', document)]).toEqual([true, true]);
    const preview = app.runtime.memory.privacy.preview(bot, { query: 'SECRET-NOTE' });
    expect(preview.messages.length).toBeGreaterThan(0);
    const secretVector = () => app.store.get('SELECT 1 x FROM memory_vectors WHERE kind=? AND ref_id=?', 'memory', forgotten);
    expect(secretVector()).toBeDefined();
    app.runtime.memory.forget(bot, { query: 'SECRET-NOTE' }, preview.revision);
    expect(secretVector()).toBeUndefined();
    expect(app.store.get('SELECT COUNT(*) n FROM memory_vectors WHERE kind=? AND ref_id NOT IN (SELECT id FROM assistant_memories)', 'memory')!.n).toBe(0);
    expect([has('memory', memory), has('document', document)]).toEqual([true, true]);
  });
  it('removes the vector of a forgotten document and leaves none for archives that are gone', async () => {
    const { app, bot, fake, config } = await fixture();
    const document = app.runtime.memory.write(bot, { title: '手册', content: '发布手册 FORGET-ME 内容' }).documentId as string;
    archive(app, bot, '段落', '讨论过上线');
    enableMemory(app);
    await embeddingOn(fake, config); await pump(app);
    expect(app.store.get('SELECT COUNT(*) n FROM memory_vectors')!.n).toBe(2);
    const preview = app.runtime.memory.privacy.preview(bot, { documentId: document });
    app.runtime.memory.forget(bot, { documentId: document }, preview.revision);
    expect(app.store.get('SELECT COUNT(*) n FROM memory_vectors WHERE kind=?', 'document')!.n).toBe(0);
    expect(app.store.get('SELECT COUNT(*) n FROM memory_search')!.n).toBe(0);
    expect(app.store.get("SELECT COUNT(*) n FROM memory_vectors WHERE kind='episode' AND ref_id NOT IN (SELECT id FROM conversation_episodes)")!.n).toBe(0);
  });
  it('backs off after a failing embedding service and stops at the daily token cap', async () => {
    const { app, bot, fake, config, personal } = await fixture();
    remember(app, bot, '甲', '周五上线东京服务器');
    enableMemory(app);
    await embeddingOn(fake, config);
    fake.state.embedStatus = 500;
    fake.requests.length = 0;
    await pump(app); await pump(app); await pump(app);
    expect(fake.count('/embeddings')).toBe(1);
    const step = app.store.get("SELECT failures,error FROM assistant_memory_steps WHERE bot_id=? AND step='embed'", bot)!;
    expect(step.failures).toBe(1); expect(String(step.error)).toContain('向量服务返回 500');
    // An embedding outage is not model maintenance: the assistant's own error and its other steps are untouched.
    expect(app.store.get('SELECT last_error FROM assistant_memory_settings WHERE bot_id=?', bot)!.last_error).toBeNull();
    // Saving a new embedding configuration is a fresh start.
    fake.state.embedStatus = 200;
    await embeddingOn(fake, config, { model: 'fake-embed-2' });
    expect(app.store.get("SELECT COUNT(*) n FROM assistant_memory_steps WHERE step='embed'")!.n).toBe(0);
    await pump(app);
    expect(app.store.get('SELECT COUNT(*) n FROM memory_vectors')!.n).toBe(1);
    // The cap.
    remember(app, bot, '乙', '另一条记录');
    app.store.run("INSERT INTO assistant_usage(id,bot_id,purpose,model,status,reserved_tokens,input_tokens,output_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?)", id(), bot, 'embed', 'x', 'succeeded', 10, EMBED_DAILY_TOKENS, 0, now());
    const before = fake.count('/embeddings');
    await pump(app);
    expect(fake.count('/embeddings')).toBe(before);
    expect(app.store.get("SELECT error,failures FROM assistant_memory_steps WHERE bot_id=? AND step='embed'", bot)).toMatchObject({ error: 'embed: ' + EMBED_BUDGET_EXHAUSTED, failures: 0 });
    void personal;
  });
});

describe('callers', () => {
  it('serves recall and the document and archive searches from the same ranking', async () => {
    const { app, bot, fake, config, retrieval } = await fixture();
    remember(app, bot, '发布步骤', '周五晚上上线东京服务器，之后通知运维');
    remember(app, bot, '无关', '喜欢拿铁咖啡');
    app.runtime.memory.write(bot, { title: '上线手册', content: '上线前检查清单' });
    archive(app, bot, '上线复盘', '这次上线推迟了一小时');
    enableMemory(app);
    await embeddingOn(fake, config); await pump(app);
    const found = await retrieval.retrieve(bot, '部署流程');
    expect(titles(found).sort()).toEqual(['上线复盘', '上线手册', '发布步骤'].sort());
    const facts = await app.runtime.memory.recall(bot, '部署流程', undefined, found);
    expect(facts.status).toBe('available');
    expect(facts.facts.map((fact) => fact.text)).toEqual(['周五晚上上线东京服务器，之后通知运维']);
    expect(app.runtime.memory.search(bot, '部署流程', found).map((doc) => doc.title)).toEqual(['上线手册']);
    expect(app.runtime.episodes.search(bot, '部署流程', 5, 3000, found).map((item) => item.title)).toEqual(['上线复盘']);
    // Without a prior retrieval the synchronous callers use BM25 alone.
    expect(app.runtime.memory.search(bot, '上线前检查').map((doc) => doc.title)).toEqual(['上线手册']);
    expect(app.runtime.episodes.related(bot, '推迟了一小时').map((item) => item.title)).toEqual(['上线复盘']);
    expect(app.runtime.memory.search(bot, '部署流程')).toEqual([]);
    // A recall that retrieves for itself sees only memories.
    expect((await app.runtime.memory.recall(bot, '部署流程')).facts).toHaveLength(1);
  });
});

describe('the memory.search tool and the prompt-time recall', () => {
  it('answer from the hybrid retrieval, keeping their result shapes', async () => {
    const { app, bot, fake, config } = await fixture();
    const chat = await startFakePersonalMemory(); extra.push(chat);
    app.store.saveConfig({ provider: 'openai', endpoint: chat.origin + '/v1', model: 'fixture-chat', contextWindow: 64000, maxOutputTokens: 4096 });
    remember(app, bot, '发布步骤', '周五晚上上线东京服务器，之后通知运维');
    remember(app, bot, '咖啡偏好', '喜欢拿铁');
    app.runtime.memory.write(bot, { title: '上线手册', content: '上线前检查清单' });
    archive(app, bot, '上线复盘', '这次上线推迟了一小时');
    enableMemory(app);
    await embeddingOn(fake, config); await rerankOn(fake, config); await pump(app);
    chat.scripts.push({ action: 'memory.search', args: { query: '部署流程' } }, { action: 'memory.search', args: { query: 'episode:' + app.store.get('SELECT id FROM conversation_episodes')!.id } }, '已查询');
    const task = app.agents.send(bot, '请查一下部署流程', 'search-1').taskId;
    const until = Date.now() + 25000;
    while (app.store.get('SELECT status FROM tasks WHERE id=?', task)?.status !== 'succeeded') {
      if (Date.now() > until) throw new Error('Fixture timeout: ' + JSON.stringify(app.store.all('SELECT status,result_summary FROM tasks')));
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const [text, exact] = app.store.all("SELECT result_json FROM tool_calls WHERE task_id=? AND tool_name='memory.search' ORDER BY created_at,rowid", task).map((row) => JSON.parse(String(row.result_json)) as { documents: Array<{ title: string }>; messages: unknown[]; episodes: Array<{ title: string }>; semantic: { status: string; facts: Array<{ text: string }> } });
    expect(text.documents.map((item) => item.title)).toEqual(['上线手册']);
    expect(text.episodes.map((item) => item.title)).toEqual(['上线复盘']);
    expect(text.semantic.status).toBe('available');
    expect(text.semantic.facts.map((fact) => fact.text)).toEqual(['周五晚上上线东京服务器，之后通知运维']);
    // Raw history search is unchanged (substring): it finds the user's own request.
    expect(text.messages).toMatchObject([{ content: '请查一下部署流程' }]);
    // An exact identifier is expanded as before, and ranks nothing.
    expect(exact.episodes).toEqual([]);
    expect(exact.semantic.facts).toEqual([]);
    expect(exact.messages).toHaveLength(1);
    // The prompt-time recall of every model request went through the same pipeline, accounted to the task.
    expect(Number(app.store.get("SELECT COUNT(*) n FROM assistant_usage WHERE task_id=? AND purpose='embed'", task)!.n)).toBeGreaterThanOrEqual(2);
    expect(Number(app.store.get("SELECT COUNT(*) n FROM assistant_usage WHERE task_id=? AND purpose='rerank'", task)!.n)).toBeGreaterThanOrEqual(1);
  }, 60000);
});

describe('migration', () => {
  it('rebuilds the three indexes with the trigram tokenizer from their sources, and can run again', async () => {
    const { app, bot, root } = await fixture();
    const memory = remember(app, bot, '部署约定', '我们每周二下午三点在东京办公室开例会');
    const document = app.runtime.memory.write(bot, { title: '运维手册', content: 'PostgreSQL 备份每日凌晨执行' }).documentId as string;
    archive(app, bot, '迁移讨论', '决定把定时任务迁移到新的调度服务');
    const inactive = remember(app, bot, '已过期', '这条记忆已经过期');
    app.store.run("UPDATE assistant_memories SET status='stale' WHERE id=?", inactive);
    const sql = (name: string) => String(app.store.get('SELECT sql FROM sqlite_master WHERE name=?', name)!.sql);
    for (const name of ['assistant_memory_search', 'conversation_episode_search', 'memory_search']) expect(sql(name)).toContain("tokenize='trigram'");
    expect(app.store.get('SELECT COUNT(*) n FROM schema_migrations WHERE version IN (31,32)')!.n).toBe(2);
    // Put the old state back: unicode61 indexes holding derived (bigram) text, no new tables, migrations unrecorded.
    app.store.db.exec(`DROP TABLE assistant_memory_search; DROP TABLE conversation_episode_search; DROP TABLE memory_search; DROP TABLE memory_vectors; DROP TABLE memory_retrieval_settings; DELETE FROM schema_migrations WHERE version>=31;
      CREATE VIRTUAL TABLE assistant_memory_search USING fts5(memory_id UNINDEXED,body,tokenize='unicode61');
      CREATE VIRTUAL TABLE conversation_episode_search USING fts5(episode_id UNINDEXED,body,tokenize='unicode61');
      CREATE VIRTUAL TABLE memory_search USING fts5(document_id UNINDEXED,title,content,tokenize='unicode61');
      INSERT INTO assistant_memory_search VALUES('stale-row','东京 京办');`);
    for (let round = 0; round < 2; round++) {
      const reopened = new CoreStore(app.store.dir, app.store.key, 'synthetic-token');
      try {
        for (const name of ['assistant_memory_search', 'conversation_episode_search', 'memory_search']) expect(String(reopened.get('SELECT sql FROM sqlite_master WHERE name=?', name)!.sql)).toContain("tokenize='trigram'");
        expect(reopened.get('SELECT COUNT(*) n FROM schema_migrations WHERE version IN (31,32)')!.n).toBe(2);
        expect(reopened.all('SELECT memory_id FROM assistant_memory_search').map((row) => row.memory_id)).toEqual([memory]);
        expect(reopened.get("SELECT memory_id FROM assistant_memory_search WHERE assistant_memory_search MATCH '\"东京办公室\"'")?.memory_id).toBe(memory);
        expect(reopened.get('SELECT document_id FROM memory_search WHERE memory_search MATCH \'"postgresql"\'')?.document_id).toBe(document);
        expect(reopened.get("SELECT COUNT(*) n FROM conversation_episode_search WHERE conversation_episode_search MATCH '\"调度服务\"'")!.n).toBe(1);
        expect(reopened.get('SELECT COUNT(*) n FROM memory_vectors')!.n).toBe(0);
        expect(reopened.get('SELECT COUNT(*) n FROM memory_retrieval_settings')!.n).toBe(0);
        // Running the migrations again (their rows deleted) changes nothing.
        if (round === 0) reopened.run('DELETE FROM schema_migrations WHERE version>=31');
      } finally { reopened.close(); }
    }
    void root;
  });
});
