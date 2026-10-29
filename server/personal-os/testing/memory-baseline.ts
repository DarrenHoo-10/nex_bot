import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import { createPersonalApp } from '../index.ts';
import { Episodes } from '../episodes.ts';
import { startFakePersonalMemory } from './fake-personal-memory.ts';
import { startFakeRetrieval } from './fake-retrieval.ts';

// A fixed scenario whose recall candidates and core memory text were recorded (memory-baseline.golden.json) with the code
// before migration 36 (assistant topic containers). It runs with no container present: the structure added by migration 36
// must leave every byte of what an assistant recalls and carries in its prompt as it was. Ids are random, so they are
// replaced by their order of appearance; candidates that tie on score are put in a fixed order (the row order of a tie
// follows random ids in SQLite and is not part of the behaviour).

type App = Awaited<ReturnType<typeof createPersonalApp>>;
const START = Date.UTC(2026, 9, 1, 2, 0, 0);

const normalize = (value: unknown) => {
  const seen = new Map<string, string>();
  return JSON.parse(JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (found) => { if (!seen.has(found)) seen.set(found, `#${seen.size + 1}`); return seen.get(found)!; }));
};

export async function baselineSnapshot(): Promise<unknown> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nex-baseline-')), chat = await startFakePersonalMemory(), fake = await startFakeRetrieval();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(START);
  const app: App = await createPersonalApp({ dir: root, key: randomBytes(32), token: 'synthetic-token', identity: false, memoryRuntime: false, hostDevice: false });
  try {
    app.store.saveConfig({ provider: 'openai', endpoint: chat.origin + '/v1', model: 'fixture-chat', apiKey: 'synthetic-only', contextWindow: 64000, maxOutputTokens: 4096 });
    const bot = app.store.createBot('合成个人助手'); clearInterval(app.runtime.memory.personal.timer);
    const personal = app.runtime.memory.personal, config = app.runtime.memory.retrieval.config;
    await config.save({ kind: 'embedding', baseUrl: fake.origin, model: 'fake-embed', enabled: true, version: config.view().embedding.version });
    await config.save({ kind: 'rerank', format: 'cohere', baseUrl: fake.origin, model: 'fake-rerank', enabled: true, version: config.view().rerank.version });
    personal.save(bot, { version: personal.settings(bot).version, enabled: true, model: 'fixture-memory', dailyBudget: 100000 });
    const pump = async (times: number) => { for (let i = 0; i < times; i++) { app.store.run('UPDATE assistant_memory_settings SET next_attempt=0'); await personal.flush(); } };
    let at = START;
    const say = (content: string) => app.agents.publish(bot, 'user', 'message', content, 'k-' + (++at), null, null, at);
    for (const line of ['周五晚上上线东京服务器', '部署前不需要再次确认', '发布后通知运维', '喜欢拿铁咖啡', '咖啡不加糖', '会议提前十分钟确认日程', '旅行订机票和酒店', '数据库用 sqlite 不用 postgres']) { say(line); at += 60_000; }
    await pump(1);
    // An archive and a document of the assistant join the pool.
    new Episodes(app.store).save({ botId: bot, conversationId: 'baseline-conversation', firstEntry: 'e1', lastEntry: 'e2', startedAt: START, endedAt: START + 3600_000, archive: { title: '上线东京服务器的讨论', brief: '讨论了周五上线东京服务器的流程', topics: ['部署'], decisions: [{ decision: '周五晚上上线', reason: '用户空闲' }], operations: [], openItems: ['通知运维'], refs: [] } });
    app.runtime.memory.write(bot, { title: '部署手册', content: '部署手册：周五晚上上线东京服务器，发布前备份数据库' });
    await pump(3);

    const rounded = (value: number) => Number(value.toPrecision(12));
    const queries = ['周五上线东京服务器的部署流程', '咖啡偏好', '数据库迁移', '旅行机票酒店', '今天天气怎么样', '会议日程安排', '部署手册 备份'];
    const recalled = async () => {
      const result = [];
      for (const query of queries) {
        const found = await app.runtime.memory.retrieval.retrieve(bot, query);
        const candidates = found.candidates.map((item) => ({ kind: item.kind, ref: item.ref, title: item.title, text: item.text, tokens: item.tokens, score: rounded(item.score), sources: item.sources }));
        candidates.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title) || a.text.localeCompare(b.text));
        result.push({ query, candidates, reranked: found.reranked, vector: found.vector, budget: found.budget, degraded: found.degraded });
      }
      return result;
    };
    const withBoth = await recalled();
    // Lexical only: both optional stages off.
    await config.save({ kind: 'rerank', format: 'cohere', baseUrl: fake.origin, model: 'fake-rerank', enabled: false, version: config.view().rerank.version });
    const withVectors = await recalled();
    await config.save({ kind: 'embedding', baseUrl: fake.origin, model: 'fake-embed', enabled: false, version: config.view().embedding.version });
    const lexicalOnly = await recalled();
    const topics = app.store.all("SELECT m.id,m.title,m.content,m.version,t.summary FROM assistant_memories m JOIN assistant_topics t ON t.topic_id=m.id WHERE m.bot_id=? AND m.kind='topic' AND m.status='active' ORDER BY m.rowid", bot);
    const semantic = (await personal.recall(bot, '周五上线东京服务器的部署流程', 2000)).map((item) => ({ ref: item.ref, text: item.text, kind: item.kind, sourceClass: item.sourceClass }));
    const core = app.runtime.memory.core;
    return normalize({ withBoth, withVectors, lexicalOnly, topics, semantic, core: core.read('bot', bot).content, rendered: core.render(bot), prompt: app.runtime.memory.prompt(bot) });
  } finally {
    vi.useRealTimers();
    await app.close(); await chat.close(); await fake.close();
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('nex-baseline-')) rmSync(root, { recursive: true, force: true });
  }
}
