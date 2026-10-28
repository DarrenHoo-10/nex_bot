import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPersonalApp } from './index.ts';
import { CoreStore, hash, id } from './store.ts';
import { startFakePersonalMemory, worthKeeping } from './testing/fake-personal-memory.ts';
import { startFakeRetrieval } from './testing/fake-retrieval.ts';
import { tokens } from './token-estimate.ts';
import { CORE_MEMORY_TOKENS } from './core-memory.ts';
import { RETAIN_INSTRUCTION } from './assistant-memory.ts';
import { CORE_PATCH_FACTS, CORE_PATCH_INTERVAL_MS, JOB_FACTS, MIGRATION_NAME, TOPIC_BODY_TOKENS, containment } from './topic-memory.ts';
import { assistantMemoriesTable } from './topic-schema.ts';

// Topic entries, their merge, the core memory index, the stricter extraction and the one-time migration
// (docs/plans/memory-recall.md sections 4.5, 4.9 and 5). Isolated fixtures only: a fake chat model and a fake
// embedding service; nothing leaves the machine.

type App = Awaited<ReturnType<typeof createPersonalApp>>;
interface Fixture { root: string; app: App; chat: Awaited<ReturnType<typeof startFakePersonalMemory>>; fake: Awaited<ReturnType<typeof startFakeRetrieval>>; bot: string }
const fixtures: Fixture[] = [];
const MIN = 60_000;

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nex-topics-')), chat = await startFakePersonalMemory(), fake = await startFakeRetrieval();
  const app = await createPersonalApp({ dir: root, key: randomBytes(32), token: 'synthetic-token', identity: false, memoryRuntime: false, hostDevice: false });
  app.store.saveConfig({ provider: 'openai', endpoint: chat.origin + '/v1', model: 'fixture-chat', apiKey: 'synthetic-only', contextWindow: 64000, maxOutputTokens: 4096 });
  const bot = app.store.createBot('合成个人助手'); clearInterval(app.runtime.memory.personal.timer);
  const result = { root, app, chat, fake, bot }; fixtures.push(result); return result;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const { app, chat, fake, root } of fixtures.splice(0)) {
    await app.close(); await chat.close(); await fake.close();
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('nex-topics-')) throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

const personal = (app: App) => app.runtime.memory.personal;
const instructionOf = (body: Record<string, unknown>) => String((body.messages as Array<{ role: string; content: string }>).find((message) => message.role === 'system')?.content ?? '');
const inputOf = (body: Record<string, unknown>) => String((body.messages as Array<{ role: string; content: string }>).at(-1)?.content ?? '');
const calls = (chat: Fixture['chat'], marker: string) => chat.requests.filter((request) => !request.stream && instructionOf(request).includes(marker));
const MERGE = '整理主题条目', TRIAGE = '筛选旧记忆', RETAIN = '从新增原文提取';
const usage = { prompt_tokens: 400, completion_tokens: 80 };
const invalid = { choices: [{ message: { content: '这不是 JSON' }, finish_reason: 'stop' }], usage };

function enable(app: App, bot: string) {
  const settings = personal(app).settings(bot);
  personal(app).save(bot, { version: settings.version, enabled: true, model: 'fixture-memory', dailyBudget: 100000 });
}
async function embeddingOn(app: App, fake: Fixture['fake']) {
  const config = app.runtime.memory.retrieval.config;
  await config.save({ kind: 'embedding', baseUrl: fake.origin, model: 'fake-embed', enabled: true, version: config.view().embedding.version });
}
async function pump(app: App, times = 1) {
  for (let i = 0; i < times; i++) { app.store.run('UPDATE assistant_memory_settings SET next_attempt=0'); await personal(app).flush(); }
}
const say = (app: App, bot: string, content: string, role = 'user') => app.agents.publish(bot, role, 'message', content, 'k-' + id());
const topics = (app: App, bot: string) => app.store.all("SELECT * FROM assistant_memories WHERE bot_id=? AND kind='topic' AND status='active' ORDER BY rowid", bot);
const evidence = (app: App, topic: unknown) => app.store.all('SELECT memory_id FROM assistant_topic_evidence WHERE topic_id=?', String(topic)).map((row) => String(row.memory_id));
const coreLines = (app: App, bot: string) => app.runtime.memory.core.read('bot', bot).content.topics;
const state = (app: App, bot: string) => app.store.get('SELECT * FROM assistant_topic_state WHERE bot_id=?', bot);

/** A memory of any kind resting on a real message of the assistant (what an earlier version of Core left behind). Returns its id. */
function legacy(app: App, bot: string, kind: string, title: string, content: string) {
  const source = 'legacy-' + id();
  app.agents.publish(bot, 'user', 'message', content, source);
  const message = app.store.get('SELECT id FROM agent_messages WHERE source_key=?', source)!;
  return personal(app).put(bot, kind, title, content, [{ id: String(message.id), hash: hash(content) }]);
}

describe('topic merge', () => {
  it('puts two related facts into one topic, a third related fact updates it, and an unrelated fact gets its own topic', async () => {
    const { app, chat, fake, bot } = await fixture();
    await embeddingOn(app, fake); enable(app, bot);
    say(app, bot, '周五晚上上线东京服务器'); say(app, bot, '部署前不需要再次确认');
    await pump(app);
    const [first] = topics(app, bot);
    expect(topics(app, bot)).toHaveLength(1); expect(calls(chat, MERGE)).toHaveLength(1);
    expect(String(first.content)).toBe('周五晚上上线东京服务器\n部署前不需要再次确认');
    expect(evidence(app, first.id)).toHaveLength(2);
    // The facts stay as evidence; the topic rests on both of their originals.
    expect(JSON.parse(String(first.refs_json))).toHaveLength(2);
    expect(app.store.all("SELECT kind FROM assistant_memories WHERE bot_id=? AND kind IN ('fact','experience')", bot)).toHaveLength(2);

    // Nothing in this fact repeats a word of the topic: it is the embedding that finds it.
    say(app, bot, '发布后通知运维');
    await pump(app);
    const [updated] = topics(app, bot);
    expect(topics(app, bot)).toHaveLength(1); expect(updated.id).toBe(first.id); expect(updated.version).toBe(2);
    expect(String(updated.content).split('\n')).toEqual(['周五晚上上线东京服务器', '部署前不需要再次确认', '发布后通知运维']);
    expect(evidence(app, updated.id)).toHaveLength(3); expect(calls(chat, MERGE)).toHaveLength(2);
    // The model was given the existing topic to rewrite, and only the new fact.
    const input = JSON.parse(inputOf(calls(chat, MERGE)[1]));
    expect(input.topic).toMatchObject({ id: first.id, body: '周五晚上上线东京服务器\n部署前不需要再次确认' }); expect(input.facts.map((fact: { content: string }) => fact.content)).toEqual(['发布后通知运维']);

    say(app, bot, '喜欢拿铁咖啡');
    await pump(app);
    expect(topics(app, bot)).toHaveLength(2); expect(calls(chat, MERGE)).toHaveLength(3);
    const other = topics(app, bot).find((row) => row.id !== first.id)!;
    expect(String(other.content)).toBe('喜欢拿铁咖啡'); expect(evidence(app, other.id)).toHaveLength(1);
    expect(topics(app, bot).find((row) => row.id === first.id)!.version).toBe(2);
    // Topics are vectorized in the pass that wrote them.
    expect(app.store.all("SELECT ref_id FROM memory_vectors WHERE kind='memory'").map((row) => row.ref_id)).toEqual(expect.arrayContaining([first.id, other.id]));
  }, 60000);

  it('falls back to BM25 over the topics when there are no vectors', async () => {
    const { app, chat, bot } = await fixture();
    enable(app, bot);
    say(app, bot, '每周五晚上部署到东京服务器');
    await pump(app);
    say(app, bot, '每周五晚上部署到东京服务器并通知运维');
    say(app, bot, '喜欢拿铁咖啡');
    await pump(app);
    expect(topics(app, bot)).toHaveLength(2);
    const joined = topics(app, bot).find((row) => String(row.content).includes('通知运维'))!;
    expect(evidence(app, joined.id)).toHaveLength(2); expect(joined.version).toBe(2);
    expect(calls(chat, MERGE)).toHaveLength(3);
    // The share of the shorter text's trigrams found in the other one.
    expect(containment('每周五晚上部署到东京', '每周五晚上部署到东京服务器')).toBe(1); expect(containment('喜欢拿铁咖啡', '每周五晚上部署到东京服务器')).toBe(0); expect(containment('好', '好的')).toBe(0);
  }, 60000);

  it('keeps every topic body within 400 tokens: by dropping superseded lines, by one correction, and by cutting what is still over', async () => {
    const { app, chat, fake, bot } = await fixture();
    await embeddingOn(app, fake); enable(app, bot);
    for (let n = 0; n < 12; n++) say(app, bot, `部署记录${n}：` + '上线检查项说明'.repeat(30));
    await pump(app);
    const [topic] = topics(app, bot);
    expect(topics(app, bot)).toHaveLength(1); expect(evidence(app, topic.id)).toHaveLength(12);
    expect(tokens(topic.content)).toBeLessThanOrEqual(TOPIC_BODY_TOKENS); expect(String(topic.content)).toContain('部署记录11');
    expect(String(topic.content)).not.toContain('部署记录0：');
    expect(calls(chat, MERGE)).toHaveLength(1);

    // A model that overruns is asked once more; a second overrun is cut at the limit, never refused.
    const long = '部署很长的正文。'.repeat(250);
    let answers = [long, long];
    chat.setOverride((body) => {
      if (body.stream || !instructionOf(body).includes(MERGE)) return undefined;
      const input = JSON.parse(inputOf(body));
      return { choices: [{ message: { content: JSON.stringify({ topics: [{ id: input.topic.id, title: '部署长主题', summary: '一句话', body: answers.shift() ?? '精简正文', facts: input.facts.map((fact: { id: string }) => fact.id) }] }) }, finish_reason: 'stop' }], usage };
    });
    say(app, bot, '部署新增一条记录');
    await pump(app);
    expect(calls(chat, MERGE)).toHaveLength(3);
    expect(String(JSON.parse(inputOf(calls(chat, MERGE)[2])).correction)).toContain('超过 400');
    expect(tokens(topics(app, bot)[0].content)).toBeLessThanOrEqual(TOPIC_BODY_TOKENS); expect(tokens(topics(app, bot)[0].content)).toBeGreaterThan(300);
    answers = [long, '精简后的正文'];
    say(app, bot, '部署再新增一条记录');
    await pump(app);
    expect(calls(chat, MERGE)).toHaveLength(5);
    expect(topics(app, bot)[0].content).toBe('精简后的正文');
  }, 90000);

  it('splits unrelated content into a sub-topic when the model returns one, and refuses an answer that names nothing real', async () => {
    const { app, chat, bot } = await fixture();
    enable(app, bot);
    chat.setOverride((body) => {
      if (body.stream || !instructionOf(body).includes(MERGE)) return undefined;
      const input = JSON.parse(inputOf(body)), ids = input.facts.map((fact: { id: string }) => fact.id);
      return { choices: [{ message: { content: JSON.stringify({ topics: [{ title: '主题甲', summary: '甲', body: '甲的正文', facts: [ids[0]] }, { title: '主题乙', summary: '乙', body: '乙的正文', facts: ids.slice(1) }] }) }, finish_reason: 'stop' }], usage };
    });
    say(app, bot, '喜欢拿铁咖啡 偏好甲'); say(app, bot, '喜欢拿铁咖啡 偏好乙');
    await pump(app);
    const rows = topics(app, bot);
    expect(rows.map((row) => row.title)).toEqual(['主题甲', '主题乙']);
    expect(evidence(app, rows[0].id)).toHaveLength(1); expect(evidence(app, rows[1].id)).toHaveLength(1);
    chat.setOverride((body) => body.stream || !instructionOf(body).includes(MERGE) ? undefined : { choices: [{ message: { content: JSON.stringify({ topics: [{ title: '假', summary: '假', body: '假正文', facts: ['unknown-fact'] }] }) }, finish_reason: 'stop' }], usage });
    say(app, bot, '会议提前十分钟');
    await pump(app);
    expect(topics(app, bot)).toHaveLength(2); expect(String(personal(app).settings(bot).last_error)).toContain('consolidate');
  }, 60000);

  it('waits for the day\'s budget without counting a failure, and its failures back off like any other step', async () => {
    const { app, chat, bot } = await fixture();
    enable(app, bot); personal(app).save(bot, { version: personal(app).settings(bot).version, enabled: true, model: 'fixture-memory', dailyBudget: 100 });
    // The migration of an empty memory finished at once; a fact of its own is merged by the regular step.
    await pump(app);
    legacy(app, bot, 'fact', '甲', '喜欢拿铁咖啡');
    await pump(app);
    expect(chat.requests).toHaveLength(0);
    expect(app.store.get("SELECT failures FROM assistant_memory_steps WHERE bot_id=? AND step='consolidate'", bot)).toMatchObject({ failures: 0 });
    expect(personal(app).settings(bot).last_error).toContain('预算');
  }, 60000);
});

describe('stricter extraction', () => {
  it('records long-term information and explicit requests, and nothing of narration, process ids or temporary paths', async () => {
    const { app, chat, bot } = await fixture();
    enable(app, bot);
    say(app, bot, '我的服务器在东京，部署都走东京那台');
    say(app, bot, '我已经重启了服务，现在一切正常', 'assistant');
    say(app, bot, '进程号 4821 还在跑');
    say(app, bot, '日志放在 /tmp/build-9f3.log');
    say(app, bot, '看一下这张截图');
    say(app, bot, '记住：进程号 4821 是我的测试进程');
    say(app, bot, '遇到端口占用的解决方法：先停旧进程再启动', 'assistant');
    await pump(app);
    const facts = app.store.all("SELECT kind,content FROM assistant_memories WHERE bot_id=? AND kind IN ('fact','experience') ORDER BY rowid", bot);
    expect(facts.map((row) => row.content)).toEqual(['我的服务器在东京，部署都走东京那台', '记住：进程号 4821 是我的测试进程', '遇到端口占用的解决方法：先停旧进程再启动']);
    expect(facts.map((row) => row.kind)).toEqual(['fact', 'fact', 'experience']);
    // The model is told the rules; the originals of what was left out stay searchable.
    const instruction = instructionOf(calls(chat, RETAIN)[0]);
    for (const phrase of ['宁缺毋滥', '关于用户的长期信息', '项目与环境的稳定事实', '用户做出的决定及原因', '反复出现的问题及其解决方法', '助手自己的叙述和过程汇报', '进程号、临时路径', '拿不准就不记', '“记住…”的内容一定要记', '密码、密钥']) expect(instruction).toContain(phrase);
    expect(instruction).toContain(RETAIN_INSTRUCTION);
    expect(app.agents.search(bot, '进程号 4821').length).toBeGreaterThan(0);
    expect(worthKeeping('user', '临时文件 /tmp/x')).toBe(false); expect(worthKeeping('user', '记住 /tmp/x')).toBe(true); expect(worthKeeping('assistant', '好的，我来处理')).toBe(false);
  }, 60000);
});

describe('core memory index', () => {
  const clock = () => {
    const start = new Date(); start.setDate(start.getDate() + 1); start.setHours(1, 0, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start);
    return { start: start.getTime(), advance: (ms: number) => vi.setSystemTime(Date.now() + ms) };
  };

  it('adds the line of a new topic at once, and patches renamed or re-summarised lines only after 5 facts and 6 hours', async () => {
    const { app, fake, bot } = await fixture(), time = clock();
    await embeddingOn(app, fake); enable(app, bot);
    say(app, bot, '部署记录一：先备份'); say(app, bot, '部署记录二：再上线');
    await pump(app);
    const [topic] = topics(app, bot), line = () => coreLines(app, bot).find((item) => item.ref === `memory:${topic.id}`)!;
    // A brand-new topic is indexed in the pass that created it: title, one-line summary and the reference.
    expect(coreLines(app, bot)).toHaveLength(1); expect(line()).toEqual({ title: '部署记录一：先备份', line: '部署记录二：再上线', ref: `memory:${topic.id}` });
    expect(app.runtime.memory.prompt(bot)).toContain(`- 部署记录一：先备份 — 部署记录二：再上线 (memory:${topic.id})`);
    expect(app.runtime.memory.core.read('bot', bot).version).toBe(1); expect(state(app, bot)).toMatchObject({ facts_since_patch: 2, core_patched_at: 0 });

    // A third fact rewrites the topic, but not its line: that waits for the cadence.
    time.advance(MIN); say(app, bot, '部署记录三：然后验证'); await pump(app);
    expect(line().line).toBe('部署记录二：再上线'); expect(app.runtime.memory.core.read('bot', bot).version).toBe(1); expect(state(app, bot)).toMatchObject({ facts_since_patch: 3 });
    // Five facts, and the last patch was never: the line follows the topic, in one commit.
    time.advance(MIN); say(app, bot, '部署记录四'); say(app, bot, '部署记录五：上线完成'); await pump(app);
    expect(CORE_PATCH_FACTS).toBe(5);
    expect(line().line).toBe('部署记录五：上线完成'); expect(app.runtime.memory.core.read('bot', bot).version).toBe(2);
    const patched = Date.now();
    expect(state(app, bot)).toMatchObject({ facts_since_patch: 0, core_patched_at: patched });
    // Five more facts within six hours change the topic and not the line.
    time.advance(MIN); for (let n = 6; n <= 10; n++) say(app, bot, `部署记录${n}：补充${n}`); await pump(app);
    expect(topics(app, bot)[0].version).toBeGreaterThan(3); expect(line().line).toBe('部署记录五：上线完成'); expect(app.runtime.memory.core.read('bot', bot).version).toBe(2);
    expect(state(app, bot)).toMatchObject({ facts_since_patch: 5, core_patched_at: patched });
    // Six hours after the last patch the pass patches, even with nothing new.
    time.advance(CORE_PATCH_INTERVAL_MS - 2 * MIN); await pump(app);
    expect(line().line).toBe('部署记录五：上线完成');
    time.advance(2 * MIN); await pump(app);
    expect(line().line).toBe('部署记录10：补充10'); expect(app.runtime.memory.core.read('bot', bot).version).toBe(3);
    expect(state(app, bot)).toMatchObject({ facts_since_patch: 0 });
    // A line the owner edited by hand is not overwritten by a refresh of a topic that did not change since.
    const edited = app.runtime.memory.core.read('bot', bot);
    app.runtime.memory.core.replace('bot', bot, { about: [], topics: [{ title: '我改的标题', line: '我改的说明', ref: `memory:${topic.id}` }] }, edited.version);
    app.store.run('UPDATE assistant_topic_state SET facts_since_patch=5,core_patched_at=0 WHERE bot_id=?', bot);
    await pump(app);
    expect(line()).toEqual({ title: '我改的标题', line: '我改的说明', ref: `memory:${topic.id}` });
  }, 120000);

  /** A topic row with its summary, resting on a real message. */
  function makeTopic(app: App, bot: string, title: string, summary: string) {
    const content = title + summary, source = 'topic-' + id();
    app.agents.publish(bot, 'user', 'message', content, source);
    const message = app.store.get('SELECT id FROM agent_messages WHERE source_key=?', source)!;
    const key = personal(app).put(bot, 'topic', title, '正文：' + summary, [{ id: String(message.id), hash: hash(content) }]);
    app.store.run('INSERT INTO assistant_topics(topic_id,bot_id,summary) VALUES(?,?,?)', key, bot, summary);
    return { key, message: String(message.id) };
  }

  it('respects the 1500-token cap: a line that does not fit waits, and the cadence patch drops the least recalled, then oldest, lines', async () => {
    const { app, bot } = await fixture(), core = app.runtime.memory.core, indexer = personal(app).topics;
    const base = core.read('bot', bot);
    core.update(bot, { patch: { about: { add: ['关于用户：' + '长期偏好说明'.repeat(40), '称呼：' + '常用设备说明'.repeat(40)] } }, expectedVersion: base.version });
    const made: Array<{ key: string; message: string }> = [];
    // Each topic is indexed as it arrives, as in the pump.
    for (let n = 1; n <= 6; n++) { made.push(makeTopic(app, bot, `主题${n}`, `这个主题${n}的说明，` + '内容细节'.repeat(25))); indexer.indexTopics(bot); }
    const indexed = () => coreLines(app, bot).map((item) => item.title);
    expect(indexed().length).toBeGreaterThan(0); expect(indexed().length).toBeLessThan(6);
    // The first ones to arrive got the room; the others were left out rather than pushing anything out.
    expect(indexed()).toEqual(made.slice(0, indexed().length).map((_, n) => `主题${n + 1}`));
    expect(tokens(app.runtime.memory.prompt(bot))).toBeLessThanOrEqual(CORE_MEMORY_TOKENS);
    const waiting = made.slice(indexed().length);
    for (const topic of waiting) expect(app.store.get('SELECT indexed_at FROM assistant_topics WHERE topic_id=?', topic.key)!.indexed_at).toBeNull();

    // Topic 2 has been recalled by three tasks (usage is counted by the originals a task has seen).
    for (let n = 0; n < 3; n++) app.store.run('INSERT INTO assistant_memory_uses VALUES(?,?)', 'task-' + n, made[1].message);
    const version = core.read('bot', bot).version;
    // The cadence is not met: nothing is written, however long the line has waited.
    app.store.run('UPDATE assistant_topic_state SET facts_since_patch=4,core_patched_at=0 WHERE bot_id=?', bot);
    expect(indexer.indexTopics(bot)).toBe(false); expect(core.read('bot', bot).version).toBe(version);
    app.store.run('UPDATE assistant_topic_state SET facts_since_patch=5,core_patched_at=0 WHERE bot_id=?', bot);
    expect(indexer.indexTopics(bot)).toBe(true);
    expect(core.read('bot', bot).version).toBe(version + 1);
    expect(indexed()).toContain('主题2'); expect(indexed()).not.toContain('主题1');
    expect(indexed()).toContain(`主题${waiting.length ? 6 : 1}`);
    expect(tokens(app.runtime.memory.prompt(bot))).toBeLessThanOrEqual(CORE_MEMORY_TOKENS);
    expect(core.read('bot', bot).content.about).toHaveLength(2);
    expect(state(app, bot)).toMatchObject({ facts_since_patch: 0 });
  }, 60000);
});

describe('migration', () => {
  /** What an assistant looked like before topics: 106 experiences, 32 facts, 54 observations, 3 understanding documents. */
  function synthetic(app: App, bot: string) {
    const ids = { narration: [] as string[], durable: [] as string[], observations: [] as string[], narrationObservations: [] as string[], understanding: [] as string[] };
    const durable = (n: number) => [`部署约定${n}：每次发布前先在预发环境验证 ${n}`, `咖啡偏好${n}：早上喝拿铁咖啡，不加糖 ${n}`, `会议习惯${n}：周一上午的会议提前十分钟确认日程 ${n}`][n % 3];
    for (let n = 0; n < 106; n++) {
      if (n < 80) ids.narration.push(legacy(app, bot, 'experience', '过程', `我正在处理第${n}个部署任务，进程号 ${4000 + n}`));
      else ids.durable.push(legacy(app, bot, 'experience', '经验', durable(n)));
    }
    for (let n = 0; n < 32; n++) ids.durable.push(legacy(app, bot, 'fact', '事实', durable(n)));
    for (let n = 0; n < 54; n++) {
      if (n < 4) ids.narrationObservations.push(legacy(app, bot, 'observation', '过程观察', `助手正在重启服务，进程号 ${9000 + n} 的截图`));
      else ids.observations.push(legacy(app, bot, 'observation', '综合观察', durable(n)));
    }
    for (const title of ['用户偏好', '重要决定', '工作经验']) ids.understanding.push(legacy(app, bot, 'understanding', title, `旧的理解：${title}`));
    return ids;
  }
  const status = (app: App, key: string) => String(app.store.get('SELECT status FROM assistant_memories WHERE id=?', key)!.status);
  const migrationRow = (app: App, bot: string) => app.store.get('SELECT * FROM assistant_memory_migrations WHERE bot_id=? AND name=?', bot, MIGRATION_NAME);
  async function untilDone(app: App, bot: string, limit = 25) {
    for (let pass = 0; pass < limit && migrationRow(app, bot)?.state !== 'done'; pass++) await pump(app);
    expect(migrationRow(app, bot)).toMatchObject({ state: 'done' });
  }
  const snapshot = (app: App) => JSON.stringify([app.store.all('SELECT id,kind,status,version,content FROM assistant_memories ORDER BY id'), app.store.all('SELECT * FROM assistant_topic_evidence ORDER BY topic_id,memory_id'), app.store.all('SELECT * FROM assistant_core_memory ORDER BY scope,bot_id'), app.store.all('SELECT * FROM assistant_memory_migrations')]);

  it('moves a production-sized memory to topics: narration retired, observations folded then retired, understanding retired, core index seeded, and a second run does nothing', async () => {
    const { app, chat, fake, bot } = await fixture();
    const ids = synthetic(app, bot);
    await embeddingOn(app, fake); enable(app, bot);
    expect(app.store.get('SELECT COUNT(*) n FROM assistant_memories')!.n).toBe(195);
    await pump(app);
    // At most three triage calls a pass, in batches of 40 within the model window.
    expect(calls(chat, TRIAGE)).toHaveLength(3); expect(calls(chat, MERGE)).toHaveLength(0);
    expect(migrationRow(app, bot)).toMatchObject({ state: 'running' });
    expect(app.store.all("SELECT * FROM assistant_memories WHERE kind='understanding' AND status='active'")).toHaveLength(0);
    await untilDone(app, bot);
    expect(calls(chat, TRIAGE)).toHaveLength(5);
    for (const request of calls(chat, TRIAGE)) { expect(JSON.parse(inputOf(request)).items.length).toBeLessThanOrEqual(40); expect(tokens(inputOf(request))).toBeLessThan(12000); }

    // Narration is retired, not deleted: the row is kept, and the original message is still searchable.
    for (const key of [...ids.narration, ...ids.narrationObservations]) expect(status(app, key)).toBe('retired');
    for (const key of ids.understanding) expect(status(app, key)).toBe('retired');
    expect(migrationRow(app, bot)).toMatchObject({ retired: 84 });
    expect(app.agents.search(bot, '进程号 4000').length).toBeGreaterThan(0);
    // What was worth keeping is evidence of a topic; observations were folded in and retired.
    const [bucketA, ...rest] = topics(app, bot);
    expect(topics(app, bot)).toHaveLength(3); void bucketA; void rest;
    for (const key of ids.durable) { expect(status(app, key)).toBe('active'); expect(Number(app.store.get('SELECT COUNT(*) n FROM assistant_topic_evidence e JOIN assistant_memories t ON t.id=e.topic_id WHERE e.memory_id=? AND t.status=?', key, 'active')!.n)).toBe(1); }
    for (const key of ids.observations) { expect(status(app, key)).toBe('retired'); expect(Number(app.store.get('SELECT COUNT(*) n FROM assistant_topic_evidence WHERE memory_id=?', key)!.n)).toBe(1); }
    expect(app.store.get("SELECT COUNT(*) n FROM assistant_memories WHERE status='active' AND kind IN ('observation','understanding')")!.n).toBe(0);
    for (const topic of topics(app, bot)) { expect(tokens(topic.content)).toBeLessThanOrEqual(TOPIC_BODY_TOKENS); expect(JSON.parse(String(topic.refs_json)).length).toBeGreaterThan(0); expect(app.store.get('SELECT summary FROM assistant_topics WHERE topic_id=?', topic.id)).toBeTruthy(); }
    expect(app.store.get("SELECT COUNT(*) n FROM assistant_topic_evidence")!.n).toBe(ids.durable.length + ids.observations.length);
    expect(Math.max(...topics(app, bot).map((topic) => evidence(app, topic.id).length))).toBeGreaterThan(JOB_FACTS);
    // The core memory carries one index line per topic, within its cap.
    expect(coreLines(app, bot).map((item) => item.ref).sort()).toEqual(topics(app, bot).map((topic) => `memory:${topic.id}`).sort());
    expect(tokens(app.runtime.memory.prompt(bot))).toBeLessThanOrEqual(CORE_MEMORY_TOKENS);
    expect(state(app, bot)).toMatchObject({ facts_since_patch: 0 });
    // Retired rows are in no index and have no vector; the vectors that exist are of rows that are recalled.
    expect(app.store.get("SELECT COUNT(*) n FROM assistant_memory_search WHERE memory_id IN (SELECT id FROM assistant_memories WHERE status='retired')")!.n).toBe(0);
    expect(app.store.get("SELECT COUNT(*) n FROM memory_vectors WHERE ref_id IN (SELECT id FROM assistant_memories WHERE status='retired')")!.n).toBe(0);

    // Recall returns topics: not the facts they cover, not a retired row.
    const recalled = await personal(app).recall(bot, '部署 发布 上线', 2000);
    expect(recalled.length).toBeGreaterThan(0); expect(recalled.every((item) => item.kind === 'topic')).toBe(true);
    const retired = new Set(app.store.all("SELECT id FROM assistant_memories WHERE status='retired'").map((row) => `personal:${row.id}`));
    expect(recalled.some((item) => retired.has(item.ref))).toBe(false);

    // Run again, also after a restart: nothing is called and nothing changes.
    const before = snapshot(app), requests = chat.requests.length;
    await pump(app, 3);
    expect(chat.requests.length).toBe(requests); expect(snapshot(app)).toBe(before);
    const reopened = new CoreStore(app.store.dir, app.store.key, 'synthetic-token');
    try { expect(reopened.get('SELECT state FROM assistant_memory_migrations WHERE bot_id=?', bot)?.state).toBe('done'); } finally { reopened.close(); }
    // The monitor lists topics, not observations or understanding documents.
    const monitor = personal(app).monitor(bot);
    expect(monitor.topics.map((item) => item.title).length).toBe(3); expect(monitor).not.toHaveProperty('documents'); expect(monitor.migration).toMatchObject({ state: 'done', retired: 84 });
    expect(monitor.counts.map((item) => item.kind).sort()).toEqual(['experience', 'fact', 'topic']);
  }, 180000);

  it('resumes after an interruption where it stopped, without triaging the same batch twice', async () => {
    const { app, chat, fake, bot } = await fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    synthetic(app, bot);
    await embeddingOn(app, fake); enable(app, bot);
    // The second triage call of the run fails.
    let seen = 0;
    chat.setOverride((body) => {
      if (body.stream || !instructionOf(body).includes(TRIAGE)) return undefined;
      return ++seen === 2 ? invalid : undefined;
    });
    await pump(app);
    const row = migrationRow(app, bot)!;
    expect(calls(chat, TRIAGE)).toHaveLength(2);
    expect(app.store.get("SELECT failures,next_at FROM assistant_memory_steps WHERE bot_id=? AND step='migrate'", bot)).toMatchObject({ failures: 1 });
    expect(row).toMatchObject({ state: 'running' }); expect(Number(row.triaged_rowid)).toBeGreaterThan(0);
    // Nothing is called while the step backs off; the cursor holds the first batch.
    await pump(app); expect(calls(chat, TRIAGE)).toHaveLength(2);
    vi.setSystemTime(Date.now() + 11 * MIN);
    await untilDone(app, bot);
    // 192 items in batches of 40: five successful calls and the one that failed; the first batch was sent once.
    const batches = calls(chat, TRIAGE).map((request) => JSON.parse(inputOf(request)).items.map((item: { id: string }) => item.id) as string[]);
    expect(batches).toHaveLength(6);
    expect(batches[1]).toEqual(batches[2]); expect(batches[0].some((key) => batches.slice(1).some((later) => later.includes(key)))).toBe(false);
    expect(migrationRow(app, bot)).toMatchObject({ state: 'done', retired: 84 });
    expect(topics(app, bot)).toHaveLength(3);
    expect(app.store.get("SELECT COUNT(*) n FROM assistant_memory_steps WHERE bot_id=? AND step='migrate'", bot)!.n).toBe(0);
  }, 180000);

  it('also resumes between triage and merge: a merge that fails leaves the rest pending and the migration open', async () => {
    const { app, chat, bot } = await fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let n = 0; n < 6; n++) legacy(app, bot, 'fact', '事实', `咖啡偏好${n}：早上喝拿铁咖啡 ${n}`);
    legacy(app, bot, 'fact', '事实', '会议习惯：周一上午的会议提前十分钟确认日程');
    enable(app, bot);
    let failing = true;
    chat.setOverride((body) => !body.stream && failing && instructionOf(body).includes(MERGE) ? invalid : undefined);
    // Triage is the work of the first pass; the merge follows in the next, once the memories are vectorized.
    await pump(app);
    expect(calls(chat, TRIAGE)).toHaveLength(1); expect(calls(chat, MERGE)).toHaveLength(0); expect(migrationRow(app, bot)).toMatchObject({ state: 'running' });
    await pump(app);
    expect(calls(chat, MERGE)).toHaveLength(1); expect(topics(app, bot)).toHaveLength(0); expect(migrationRow(app, bot)).toMatchObject({ state: 'running' });
    expect(app.store.get("SELECT failures FROM assistant_memory_steps WHERE bot_id=? AND step='migrate'", bot)).toMatchObject({ failures: 1 });
    failing = false; vi.setSystemTime(Date.now() + 11 * MIN);
    await untilDone(app, bot);
    expect(calls(chat, TRIAGE)).toHaveLength(1);
    expect(topics(app, bot)).toHaveLength(2); expect(coreLines(app, bot)).toHaveLength(2);
  }, 90000);

  it('retires an old memory whose originals are gone without asking the model, and starts the regular merge only afterwards', async () => {
    const { app, chat, bot } = await fixture();
    const lost = legacy(app, bot, 'fact', '事实', '已经找不到原文的事实');
    app.store.run("UPDATE agent_messages SET content='[已遗忘]' WHERE content=?", '已经找不到原文的事实');
    enable(app, bot);
    await untilDone(app, bot);
    expect(chat.requests).toHaveLength(0);
    expect(String(app.store.get('SELECT status FROM assistant_memories WHERE id=?', lost)!.status)).toBe('retired');
    // A fact retained later goes through the regular merge, not the migration.
    say(app, bot, '喜欢拿铁咖啡');
    await pump(app);
    expect(calls(chat, TRIAGE)).toHaveLength(0); expect(topics(app, bot)).toHaveLength(1);
  }, 60000);
});

describe('retrieval pool', () => {
  it('recalls topics, leaves out the facts a topic covers and retired rows, and recalls a fact no topic covers', async () => {
    const { app, fake, bot } = await fixture();
    await embeddingOn(app, fake); enable(app, bot);
    say(app, bot, '周五晚上上线东京服务器'); say(app, bot, '部署前不需要再次确认');
    await pump(app);
    const [topic] = topics(app, bot), retrieval = app.runtime.memory.retrieval;
    const found = await retrieval.retrieve(bot, '周五上线东京服务器的部署流程');
    expect(found.candidates.map((item) => item.refId)).toEqual([topic.id]); expect(found.candidates[0].row.kind).toBe('topic');
    // A fact is only evidence while its topic is: with the topic gone it is recalled again.
    app.store.run("UPDATE assistant_memories SET status='retired' WHERE id=?", topic.id);
    app.store.run('DELETE FROM assistant_memory_search WHERE memory_id=?', topic.id);
    const alone = await retrieval.retrieve(bot, '周五晚上上线东京服务器');
    expect(alone.candidates.length).toBeGreaterThan(0); expect(alone.candidates.every((item) => item.row.kind === 'fact')).toBe(true); expect(alone.candidates[0].text).toBe('周五晚上上线东京服务器');
    // A memory of a superseded kind is never recalled, even by its reference.
    const old = legacy(app, bot, 'observation', '旧观察', '周五晚上上线东京服务器，旧结论');
    expect((await retrieval.retrieve(bot, '周五晚上上线东京服务器')).candidates.some((item) => item.refId === old)).toBe(false);
    expect((await retrieval.retrieve(bot, `memory:${old}`)).candidates).toEqual([]);
  }, 60000);
});

describe('forgetting', () => {
  it('takes the topics that cite a forgotten fact with it, with their index lines and vectors, and merges the surviving facts afresh', async () => {
    const { app, fake, bot } = await fixture();
    await embeddingOn(app, fake); enable(app, bot);
    say(app, bot, '周五晚上上线东京服务器 SECRET-A'); say(app, bot, '部署前不需要再次确认'); say(app, bot, '喜欢拿铁咖啡');
    await pump(app);
    expect(topics(app, bot)).toHaveLength(2);
    const doomed = topics(app, bot).find((row) => String(row.content).includes('SECRET-A'))!, kept = topics(app, bot).find((row) => row.id !== doomed.id)!;
    const factA = app.store.get("SELECT id FROM assistant_memories WHERE kind='fact' AND content LIKE '%SECRET-A%'")!.id, factB = app.store.get("SELECT id FROM assistant_memories WHERE kind='fact' AND content='部署前不需要再次确认'")!.id;
    expect(evidence(app, doomed.id).sort()).toEqual([String(factA), String(factB)].sort());
    expect(coreLines(app, bot).map((item) => item.ref)).toEqual(expect.arrayContaining([`memory:${doomed.id}`, `memory:${kept.id}`]));
    const vectors = (...keys: unknown[]) => Number(app.store.get(`SELECT COUNT(*) n FROM memory_vectors WHERE ref_id IN (${keys.map(() => '?').join(',')})`, ...keys.map(String))!.n);
    expect(vectors(doomed.id, factA, kept.id)).toBe(3);

    const plan = app.runtime.memory.privacy.preview(bot, { query: 'secret-a' });
    app.runtime.memory.forget(bot, { query: 'secret-a' }, plan.revision);
    expect(app.store.get('SELECT id FROM assistant_memories WHERE id=?', doomed.id)).toBeUndefined(); expect(app.store.get('SELECT id FROM assistant_memories WHERE id=?', factA)).toBeUndefined();
    expect(app.store.all('SELECT * FROM assistant_topic_evidence WHERE topic_id=? OR memory_id=?', doomed.id, factA)).toEqual([]);
    expect(app.store.get('SELECT * FROM assistant_topics WHERE topic_id=?', doomed.id)).toBeUndefined();
    expect(app.store.all('SELECT * FROM assistant_memory_versions WHERE id=?', doomed.id)).toEqual([]);
    expect(vectors(doomed.id, factA)).toBe(0); expect(vectors(kept.id)).toBe(1);
    expect(coreLines(app, bot).map((item) => item.ref)).toEqual([`memory:${kept.id}`]);
    expect(app.runtime.memory.prompt(bot)).not.toContain('SECRET'); expect(JSON.stringify(app.store.all('SELECT content FROM assistant_memories'))).not.toContain('SECRET');
    // The fact that survived is evidence of nothing now, and the next pass writes it a new topic that never saw the forgotten one.
    expect(app.store.get('SELECT id FROM assistant_memories WHERE id=?', factB)).toBeTruthy(); expect(evidence(app, kept.id)).toHaveLength(1);
    expect(topics(app, bot)).toHaveLength(1);
    await pump(app);
    const rewritten = topics(app, bot).find((row) => row.id !== kept.id)!;
    expect(rewritten.content).toBe('部署前不需要再次确认'); expect(evidence(app, rewritten.id)).toEqual([String(factB)]);
    expect(coreLines(app, bot).map((item) => item.ref)).toEqual(expect.arrayContaining([`memory:${kept.id}`, `memory:${rewritten.id}`]));
    expect(JSON.stringify(app.store.all('SELECT * FROM assistant_memory_versions'))).not.toContain('SECRET');
  }, 60000);
});

describe('migration 35', () => {
  it('rebuilds the memory table once to allow topics, keeps rows and their order, and runs again without changing anything', async () => {
    const { app, bot } = await fixture();
    const keys = [legacy(app, bot, 'fact', '甲', '事实甲'), legacy(app, bot, 'observation', '乙', '观察乙'), legacy(app, bot, 'understanding', '丙', '理解丙'), legacy(app, bot, 'experience', '丁', '经验丁')];
    app.store.run("UPDATE assistant_memories SET status='stale' WHERE id=?", keys[1]);
    const rowids = app.store.all('SELECT rowid AS r,id FROM assistant_memories ORDER BY rowid');
    // Back to the schema of migration 34: the old CHECK, and none of the new tables.
    app.store.db.exec(`${assistantMemoriesTable('assistant_memories_old').replace(",'topic')", ")")}
      INSERT INTO assistant_memories_old(rowid,id,bot_id,kind,title,content,refs_json,version,status,created_at,updated_at) SELECT rowid,id,bot_id,kind,title,content,refs_json,version,status,created_at,updated_at FROM assistant_memories ORDER BY rowid;
      DROP TABLE assistant_memories; ALTER TABLE assistant_memories_old RENAME TO assistant_memories; CREATE INDEX assistant_memories_bank ON assistant_memories(bot_id,status,kind);
      DROP TABLE assistant_topic_evidence; DROP TABLE assistant_topics; DROP TABLE assistant_topic_state; DROP TABLE assistant_memory_migrations; DELETE FROM schema_migrations WHERE version=35;
      INSERT INTO assistant_memory_steps VALUES('${bot}','understanding',2,0,'old',0);`);
    expect(String(app.store.get("SELECT sql FROM sqlite_master WHERE name='assistant_memories'")!.sql)).not.toContain("'topic'");
    expect(() => app.store.run("INSERT INTO assistant_memories(id,bot_id,kind,title,content,refs_json,created_at,updated_at) VALUES('t',?,'topic','t','c','[]',1,1)", bot)).toThrow(/CHECK/);
    for (let round = 0; round < 3; round++) {
      const reopened = new CoreStore(app.store.dir, app.store.key, 'synthetic-token');
      try {
        expect(reopened.get('SELECT COUNT(*) n FROM schema_migrations WHERE version=35')!.n).toBe(1);
        expect(String(reopened.get("SELECT sql FROM sqlite_master WHERE name='assistant_memories'")!.sql)).toContain("'topic'");
        expect(reopened.all('SELECT rowid AS r,id FROM assistant_memories ORDER BY rowid')).toEqual(rowids);
        expect(reopened.get('SELECT status FROM assistant_memories WHERE id=?', keys[1])!.status).toBe('stale');
        for (const table of ['assistant_topic_evidence', 'assistant_topics', 'assistant_topic_state', 'assistant_memory_migrations']) expect(reopened.get('SELECT COUNT(*) n FROM sqlite_master WHERE name=?', table)!.n).toBe(1);
        expect(reopened.get("SELECT COUNT(*) n FROM sqlite_master WHERE name='assistant_memories_bank'")!.n).toBe(1);
        // The understanding step's backoff row is gone; a topic can be stored now.
        expect(reopened.get("SELECT COUNT(*) n FROM assistant_memory_steps WHERE step='understanding'")!.n).toBe(0);
        reopened.run("INSERT INTO assistant_memories(id,bot_id,kind,title,content,refs_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", 'topic-' + round, bot, 'topic', '主题', '正文', '[]', 1, 1);
        reopened.run('DELETE FROM assistant_memories WHERE id=?', 'topic-' + round);
        // Running the migration again (as after a restore of the marker table) changes nothing.
        if (round < 2) reopened.run('DELETE FROM schema_migrations WHERE version=35');
      } finally { reopened.close(); }
    }
  });
});
