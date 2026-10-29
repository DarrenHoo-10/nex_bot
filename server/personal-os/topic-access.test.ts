import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPersonalApp } from './index.ts';
import { CoreStore, hash, id } from './store.ts';
import { startFakePersonalMemory } from './testing/fake-personal-memory.ts';
import { startFakeRetrieval } from './testing/fake-retrieval.ts';
import { baselineSnapshot } from './testing/memory-baseline.ts';
import { tokens } from './token-estimate.ts';
import { CORE_MEMORY_TOKENS } from './core-memory.ts';
import { evaluateTool, directory } from './policy.ts';
import { isolateSource } from './topic-access.ts';
import { vectorCache } from './vector-cache.ts';

// User topics, who may see them, handing a question to the steward, and what is kept out of an assistant's memory
// (docs/plans/user-topics.md sections 3, 5, 6, 7, 8, 10 and 12; tests of 15.2). Isolated fixtures only: a fake chat model
// (scripted tool calls), a fake embedding service; nothing leaves the machine.

type App = Awaited<ReturnType<typeof createPersonalApp>>;
interface Fixture { create?: (input: { topics: Array<{ id: string; title: string }> }) => Record<string, unknown>; root: string; app: App; chat: Awaited<ReturnType<typeof startFakePersonalMemory>>; fake: Awaited<ReturnType<typeof startFakeRetrieval>>; a: string; b: string; c: string }
const fixtures: Fixture[] = [];
const DAY = 86_400_000;

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nex-access-')), chat = await startFakePersonalMemory(), fake = await startFakeRetrieval();
  const app = await createPersonalApp({ dir: root, key: randomBytes(32), token: 'synthetic-token', identity: false, memoryRuntime: false, hostDevice: false });
  app.store.saveConfig({ provider: 'openai', endpoint: chat.origin + '/v1', model: 'fixture-chat', apiKey: 'synthetic-only', contextWindow: 64000, maxOutputTokens: 4096 });
  const a = app.store.createBot('开发助手'), b = app.store.createBot('理财助手'), c = app.store.createBot('备用助手');
  clearInterval(app.runtime.memory.personal.timer); app.runtime.maintenanceIdle = 3_600_000;
  // The container prompts: nothing to create; an overview is the names of the children.
  chat.setOverride((body) => {
    if (body.stream) return undefined;
    const system = String((body.messages as Array<{ role: string; content: string }>).find((message) => message.role === 'system')?.content ?? ''), input = JSON.parse(String((body.messages as Array<{ content: string }>).at(-1)?.content ?? '{}'));
    const answer = (value: unknown) => ({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 400, completion_tokens: 80 } });
    if (system.includes('组建容器')) return answer(fixtures.find((one) => one.chat === chat)?.create?.(input) ?? { anchor: '', name: '', aliases: [], summary: '', overview: '', members: [] });
    if (system.includes('重写容器概要')) return answer({ name: input.container.title, aliases: input.container.aliases, summary: '概要', overview: input.children.map((child: { title: string }) => child.title).join('；') });
    return undefined;
  });
  const result = { root, app, chat, fake, a, b, c }; fixtures.push(result); return result;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const { app, chat, fake, root } of fixtures.splice(0)) {
    await app.close(); await chat.close(); await fake.close();
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('nex-access-')) throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

const personal = (app: App) => app.runtime.memory.personal;
const tree = (app: App) => personal(app).tree;
const access = (app: App) => personal(app).access;
const embeddingOn = async (app: App, fake: Fixture['fake']) => { const config = app.runtime.memory.retrieval.config; await config.save({ kind: 'embedding', baseUrl: fake.origin, model: 'fake-embed', enabled: true, version: config.view().embedding.version }); };
function enable(app: App, ...bots: string[]) { for (const bot of bots) personal(app).save(bot, { version: personal(app).settings(bot).version, enabled: true, model: 'fixture-memory', dailyBudget: 100000 }); }
async function pump(app: App, times = 1) { for (let i = 0; i < times; i++) { app.store.run('UPDATE assistant_memory_settings SET next_attempt=0'); await personal(app).flush(); } }
const say = (app: App, bot: string, content: string, role = 'user') => app.agents.publish(bot, role, 'message', content, 'k-' + id());
async function wait(check: () => boolean, app: App, limit = 30000) {
  const until = Date.now() + limit;
  while (!check()) {
    const failed = app.store.get("SELECT result_summary FROM tasks WHERE status='failed'"); if (failed) throw new Error(String(failed.result_summary));
    if (Date.now() > until) throw new Error('Fixture timeout: ' + JSON.stringify(app.store.all('SELECT status,result_summary FROM tasks')));
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
/** A whole turn of the assistant, on the real clock. */
async function turn(app: App, bot: string, text: string, key: string) {
  const task = app.agents.send(bot, text, key).taskId;
  await wait(() => app.store.get('SELECT status FROM tasks WHERE id=?', task)?.status === 'succeeded', app); await wait(() => !app.runtime.workers.size, app);
  return task;
}
const streamed = (chat: Fixture['chat']) => chat.requests.filter((request) => request.stream);
const wire = (request: Record<string, unknown>) => request.messages as Array<{ role: string; content: string }>;
const volatileOf = (request: Record<string, unknown>) => String(wire(request).find((message) => message.role === 'user' && String(message.content).includes('<system-reminder>'))?.content);

let counter = 0;
const settle = (app: App, bot: string) => app.store.run('UPDATE assistant_memory_settings SET cursor_seq=(SELECT COALESCE(MAX(seq),0) FROM agent_messages WHERE bot_id=?) WHERE bot_id=?', bot, bot);
/** A topic resting on one fact (or experience) per entry of `days`; `user` makes it a user topic the bot looks after. */
function seed(app: App, bot: string, title: string, opts: { days?: number[]; body?: string; kind?: string; user?: boolean } = {}) {
  const refs: Array<{ id: string; hash: string }> = [], facts: string[] = [];
  for (const day of opts.days ?? [-30, -20, -5]) {
    const content = `${title}的事实${++counter}`, source = 'seed-' + id();
    app.agents.publish(bot, 'user', 'message', content, source, null, null, Date.now() + day * DAY);
    const message = app.store.get('SELECT id FROM agent_messages WHERE source_key=?', source)!, ref = { id: String(message.id), hash: hash(content) };
    facts.push(personal(app).put(bot, opts.kind ?? 'fact', title, content, [ref])); refs.push(ref);
  }
  const key = personal(app).put(bot, 'topic', title, opts.body ?? `${title}正文`, refs, undefined, false, !!opts.user);
  app.store.run('INSERT INTO assistant_topics(topic_id,bot_id,summary,owner,maintainer) VALUES(?,?,?,?,?)', key, bot, `${title}说明`, opts.user ? 'user' : 'bot', opts.user ? bot : null);
  for (const fact of facts) app.store.run('INSERT INTO assistant_topic_evidence(topic_id,memory_id,added_at) VALUES(?,?,?)', key, fact, Date.now());
  if (opts.user) access(app).create(key, bot);
  settle(app, bot);
  return { key, facts, refs };
}
const userTopic = (app: App, bot: string, title: string, opts: { days?: number[]; body?: string } = {}) => seed(app, bot, title, { ...opts, user: true });
/** A task the user started in a chat (or another origin), with the user's text as its input, without running it. */
function task(app: App, bot: string, text: string, origin: 'owner' | 'routine' | 'delegated' = 'owner') {
  const conv = 'conv-' + id(), key = 'task-' + id();
  app.store.db.exec('PRAGMA foreign_keys=OFF');
  app.store.run("INSERT INTO conversations(id,workspace_id,owner_user_id,bot_id,title,status,created_at) VALUES(?,?,?,?,?,'open',?)", conv, app.store.workspace, app.store.owner, bot, '合成会话', Date.now());
  app.store.run("INSERT INTO tasks(id,workspace_id,owner_user_id,conversation_id,bot_id,initiated_by_session_id,authorized_session_id,objective,status,legacy_max_model_calls,legacy_max_tool_calls,legacy_token_budget,legacy_deadline_at,created_at) VALUES(?,?,?,?,?,'s','s','合成','running',1,1,1,?,?)", key, app.store.workspace, app.store.owner, conv, bot, Date.now() + DAY, Date.now());
  app.store.run("INSERT INTO conversation_inputs(id,workspace_id,owner_user_id,bot_id,conversation_id,task_id,sender_session_id,client_message_id,input_seq,input_kind,content_json,request_hash,status,created_at) VALUES(?,?,?,?,?,?,'s',?,1,'start',?,?,'accepted',?)", id(), app.store.workspace, app.store.owner, bot, conv, key, id(), JSON.stringify({ text }), 'a'.repeat(64), Date.now());
  if (origin !== 'delegated') app.store.run('INSERT INTO agent_task_links VALUES(?,?,?,?)', key, bot, origin === 'routine' ? 'routine' : 'owner', 'link-' + key);
  else app.store.run("INSERT INTO a2a_messages(id,call_id,parent_task_id,sender_bot_id,receiver_bot_id,child_conversation_id,child_task_id,root_task_id,depth,status,payload,created_at) VALUES(?,?,?,?,?,?,?,?,1,'running','x',?)", id(), id(), key, bot, bot, conv, key, key, Date.now());
  app.store.db.exec('PRAGMA foreign_keys=ON');
  return key;
}
const roleOf = (app: App, topic: string, bot: string) => access(app).role(topic, bot);
const recalled = async (app: App, bot: string, query: string) => (await app.runtime.memory.retrieval.retrieve(bot, query)).candidates.map((item) => item.ref);
const meta = (app: App, key: string) => app.store.get('SELECT * FROM assistant_topics WHERE topic_id=?', key)!;
const coreText = (app: App, bot: string) => app.runtime.memory.prompt(bot);

describe('migration 37 and promotion', () => {
  it('goes through the merge as before for one assistant: recall and core memory stay byte for byte as recorded before user topics existed', async () => {
    const golden = JSON.parse(readFileSync(new URL('./testing/memory-baseline.golden.json', import.meta.url), 'utf8'));
    let owners: unknown[] = [];
    expect(await baselineSnapshot((app) => { owners = app.store.all('SELECT owner FROM assistant_topics').map((row) => row.owner); })).toEqual(golden);
    // The topics the merge made are user topics, looked after by the assistant that wrote them.
    expect(owners).toHaveLength(5); expect(new Set(owners)).toEqual(new Set(['user']));
  }, 120000);

  it('promotes the topics that rest mostly on facts without changing what any assistant recalls or carries, and the move can be reverted', async () => {
    const f = await fixture(), { app, a, b, fake } = f;
    await embeddingOn(app, fake);
    const facts = seed(app, a, '部署流程', { body: '周五晚上上线东京服务器' }), mixed = seed(app, a, '会议习惯', { kind: 'experience' }), mine = seed(app, b, '咖啡偏好', { body: '喜欢拿铁咖啡' });
    app.store.run("UPDATE assistant_memories SET kind='fact' WHERE id=?", mixed.facts[0]);
    for (const bot of [a, b]) enable(app, bot);
    await pump(app, 6);
    const queries = ['周五上线东京服务器', '拿铁咖啡', '会议习惯', '今天天气'];
    const snapshot = async () => JSON.stringify({ recall: await Promise.all([a, b].map(async (bot) => Promise.all(queries.map(async (query) => (await app.runtime.memory.retrieval.retrieve(bot, query)).candidates.map((item) => [item.ref, item.text, item.score, item.sources]))))), core: [a, b].map((bot) => coreText(app, bot)), lines: [a, b].map((bot) => app.runtime.memory.core.read('bot', bot).content) });
    // The state before: all assistant topics. (The migration already ran when the stores were made; the promotion is the step.)
    for (const key of [facts.key, mixed.key, mine.key]) app.store.run("UPDATE assistant_topics SET owner='bot',maintainer=NULL WHERE topic_id=?", key);
    app.store.run('DELETE FROM user_topic_access'); app.store.run('DELETE FROM user_topic_indexed');
    const before = await snapshot();
    expect(meta(app, facts.key).owner).toBe('bot');
    expect(tree(app).promote(a)).toBe(1); expect(tree(app).promote(b)).toBe(1);
    expect(meta(app, facts.key)).toMatchObject({ owner: 'user', maintainer: a }); expect(meta(app, mixed.key).owner).toBe('bot'); expect(meta(app, mine.key).owner).toBe('user');
    // Only the assistant they came from may see them, exactly as before.
    expect(roleOf(app, facts.key, a)).toBe('steward'); expect(roleOf(app, facts.key, b)).toBe('none'); expect(roleOf(app, mine.key, a)).toBe('none');
    expect(await snapshot()).toBe(before);
    expect(personal(app).topics.topics(a).map((row) => row.id)).toEqual(expect.arrayContaining([facts.key, mixed.key]));
    // Twice is the same; and the move is on record, revertible while nobody else was let in.
    expect(tree(app).promote(a)).toBe(0);
    const [move] = app.store.all("SELECT * FROM assistant_topic_moves WHERE bot_id=? AND action='promote'", a);
    expect(move).toMatchObject({ topic_id: facts.key, actor: 'auto' });
    tree(app).run(a, { op: 'revert', moveId: move.id });
    expect(meta(app, facts.key).owner).toBe('bot'); expect(access(app).rows(facts.key)).toHaveLength(0); expect(await snapshot()).toBe(before);
  }, 90000);

  it('adds its tables and columns once, changes no row, and runs again without changing anything', async () => {
    const f = await fixture(), { app, a } = f;
    const topic = seed(app, a, '甲', { kind: 'experience' });
    const columns = (store: CoreStore, table: string) => (store.all(`PRAGMA table_info(${table})`) as Array<{ name: string }>).map((column) => column.name).sort();
    expect(columns(app.store, 'assistant_topics')).toEqual(expect.arrayContaining(['special', 'resident', 'maintainer'])); expect(columns(app.store, 'task_recall')).toContain('hints_json');
    expect(meta(app, topic.key)).toMatchObject({ owner: 'bot', special: null, resident: 0 });
    const before = columns(app.store, 'assistant_topics');
    for (let round = 0; round < 3; round++) {
      const reopened = new CoreStore(app.store.dir, app.store.key, 'synthetic-token');
      try {
        expect(reopened.get('SELECT COUNT(*) n FROM schema_migrations WHERE version=37')!.n).toBe(1);
        expect(columns(reopened, 'assistant_topics')).toEqual(before);
        if (round < 2) reopened.run('DELETE FROM schema_migrations WHERE version=37');
      } finally { reopened.close(); }
    }
  });
});

describe('a fact goes to the closest user topic whoever extracted it', () => {
  it('merges the fact of another assistant into the topic of its steward, who reads it, while the extractor sees neither topic nor fact; experiences stay with their assistant', async () => {
    const f = await fixture(), { app, a, b } = f;
    enable(app, a, b);
    // The steward writes the topic; the other assistant says the same kind of thing.
    say(app, a, '记住：nex_bot部署流程说明文档'); await pump(app, 4);
    const topics = () => app.store.all("SELECT m.* FROM assistant_memories m JOIN assistant_topics t ON t.topic_id=m.id WHERE m.kind='topic' AND t.owner='user' AND m.status='active'");
    expect(topics()).toHaveLength(1);
    const [topic] = topics();
    say(app, b, '记住：nex_bot部署流程说明文档补充'); say(app, b, '遇到端口占用的解决方法：先停旧进程再启动', 'assistant');
    await pump(app, 6);
    // Merged by the steward, in its own pass; not a second topic, not a topic of the extractor.
    expect(topics()).toHaveLength(1);
    const evidence = app.store.all('SELECT f.bot_id,f.kind,f.content FROM assistant_topic_evidence e JOIN assistant_memories f ON f.id=e.memory_id WHERE e.topic_id=?', topic.id);
    expect(evidence.map((row) => row.bot_id).sort()).toEqual([a, b].sort());
    expect(String(app.store.get('SELECT content FROM assistant_memories WHERE id=?', topic.id)!.content)).toContain('补充');
    expect(roleOf(app, String(topic.id), a)).toBe('steward'); expect(roleOf(app, String(topic.id), b)).toBe('none');
    expect(app.store.get('SELECT maintainer FROM assistant_topics WHERE topic_id=?', topic.id)!.maintainer).toBe(a);
    // The extractor does not gain access, and its own fact is out of its sight now that it rests in the topic.
    const fact = app.store.get("SELECT id FROM assistant_memories WHERE bot_id=? AND kind='fact' AND content LIKE '%补充%'", b)!;
    expect(await recalled(app, b, 'nex_bot部署流程')).toEqual([]);
    for (const ref of [`memory:${topic.id}`, `memory:${fact.id}`]) expect((await app.runtime.memory.retrieval.retrieve(b, ref)).candidates).toEqual([]);
    expect(await recalled(app, a, 'nex_bot部署流程')).toContain(`memory:${topic.id}`);
    expect((await app.runtime.memory.retrieval.retrieve(a, `memory:${fact.id}`)).candidates).toHaveLength(1);
    // Experiences never go into a user topic; the extractor keeps its own assistant topic.
    expect(evidence.every((row) => row.kind === 'fact')).toBe(true);
    const own = app.store.all("SELECT m.id FROM assistant_memories m JOIN assistant_topics t ON t.topic_id=m.id WHERE m.bot_id=? AND m.kind='topic' AND t.owner='bot'", b);
    expect(own).toHaveLength(1);
    expect(await recalled(app, b, '端口占用的解决方法')).toContain(`memory:${own[0].id}`);
    // With no close topic, the fact starts a user topic of its extractor.
    say(app, b, '记住：喜欢拿铁咖啡'); await pump(app, 4);
    const coffee = topics().find((row) => String(row.content).includes('咖啡'))!;
    expect(coffee.bot_id).toBe(b); expect(roleOf(app, String(coffee.id), b)).toBe('steward'); expect(roleOf(app, String(coffee.id), a)).toBe('none');
  }, 120000);
});

describe('grant and revoke in the conversation', () => {
  it('changes access on the user\'s own words only: a task the user started, a quote of what they typed, the named topic and what is under it', async () => {
    const f = await fixture(), { app, a, b, c } = f;
    const stocks = userTopic(app, a, '股票'), funds = userTopic(app, a, '基金'), bonds = userTopic(app, a, '债券'), health = userTopic(app, a, '健康状况');
    const invest = tree(app).run(a, { op: 'group', topics: [stocks.key, funds.key, bonds.key], name: '投资', anchor: '投资对象' }) as { created: string };
    const run = (bot: string, args: Record<string, unknown>, taskId: string) => tree(app).run(bot, args, { taskId }) as Record<string, unknown>;
    const words = '以后我的投资交给你管', owner = task(app, b, words);
    expect(roleOf(app, invest.created, b)).toBe('none');
    // Without a task, without the user's words, with words from elsewhere, from a routine or a delegated task: refused.
    expect(() => tree(app).run(b, { op: 'grant', topic: '投资', bot: b, role: 'steward', quote: words })).toThrow(/任务/);
    expect(() => run(b, { op: 'grant', topic: '投资', bot: b, role: 'steward', quote: '把投资交给我吧' }, owner)).toThrow(/原话/);
    expect(() => run(b, { op: 'grant', topic: '投资', bot: b, role: 'steward', quote: '投资' }, owner)).toThrow(/至少/);
    expect(() => run(b, { op: 'grant', topic: '投资', bot: b, role: 'steward' }, owner)).toThrow(/至少/);
    for (const origin of ['routine', 'delegated'] as const) expect(() => run(b, { op: 'grant', topic: '投资', bot: b, role: 'steward', quote: words }, task(app, b, words, origin))).toThrow(/直接发起/);
    // The words are in the tool result, not in what the user typed.
    app.agents.publish(b, 'peer', 'result', '用户说：把投资全交给理财助手', 'peer-' + id(), owner);
    expect(() => run(b, { op: 'grant', topic: '投资', bot: b, role: 'steward', quote: '把投资全交给理财助手' }, owner)).toThrow(/原话/);
    expect(roleOf(app, invest.created, b)).toBe('none'); expect(app.store.get('SELECT COUNT(*) n FROM user_topic_access WHERE principal=?', b)!.n).toBe(0);

    // The words as typed (white space aside): granted, told in the conversation, on record, and the map follows.
    const granted = run(b, { op: 'grant', topic: '投资', bot: '理财助手', role: 'steward', quote: '以后 我的投资\n交给你管' }, task(app, b, '以后  我的投资 交给你管，谢谢'));
    expect(granted).toMatchObject({ granted: invest.created, principal: b, role: 'steward' });
    expect(roleOf(app, invest.created, b)).toBe('steward');
    // The named topic and what is under it, nothing next to it.
    for (const child of [stocks, funds, bonds]) expect(roleOf(app, child.key, b)).toBe('steward');
    expect(roleOf(app, health.key, b)).toBe('none');
    const notice = app.store.get("SELECT content,task_id FROM agent_messages WHERE bot_id=? AND role='system' AND content LIKE '已允许%'", b)!;
    expect(notice.content).toBe('已允许 理财助手 负责「投资」');
    const move = app.store.get("SELECT * FROM assistant_topic_moves WHERE bot_id=? AND action='grant'", b)!;
    expect(move).toMatchObject({ topic_id: invest.created, actor: 'model' }); expect(JSON.parse(String(move.after_json))).toMatchObject({ principal: b, role: 'steward' });
    const mapOf = (bot: string) => (directory(app.store).find((peer) => peer.id === bot) as { responsibilities?: string[] }).responsibilities;
    expect(mapOf(b)).toEqual(['投资']); expect([...mapOf(a)!].sort()).toEqual(['健康状况', '投资']); expect(mapOf(c)).toBeUndefined();

    // Readers, a revocation, and the last steward: somebody always looks after a topic.
    const read = task(app, a, '你也看看投资吧');
    run(a, { op: 'grant', topic: invest.created, bot: c, role: 'reader', quote: '你也看看投资吧' }, read);
    expect(roleOf(app, stocks.key, c)).toBe('reader'); expect(await recalled(app, c, '股票正文')).toEqual(expect.arrayContaining([`memory:${stocks.key}`]));
    expect(app.store.get("SELECT content FROM agent_messages WHERE bot_id=? AND content LIKE '已允许 备用助手 阅读%'", a)!.content).toBe('已允许 备用助手 阅读「投资」');
    run(b, { op: 'revoke', topic: '投资', bot: '备用助手', quote: '以后别让备用助手看投资' }, task(app, b, '以后别让备用助手看投资'));
    expect(roleOf(app, stocks.key, c)).toBe('none'); expect(await recalled(app, c, '股票正文')).toEqual([]);
    expect(app.store.get("SELECT content FROM agent_messages WHERE bot_id=? AND content LIKE '已收回%'", b)!.content).toBe('已收回 备用助手 对「投资」的访问');
    // Revoke both stewards of a topic of one steward: the reader that was last talked to takes it over, and the user is told.
    const solo = userTopic(app, a, '旅行计划');
    run(a, { op: 'grant', topic: solo.key, bot: b, role: 'reader', quote: '理财助手也能看旅行计划' }, task(app, a, '理财助手也能看旅行计划'));
    run(b, { op: 'revoke', topic: solo.key, bot: a, quote: '旅行计划不要开发助手管了' }, task(app, b, '旅行计划不要开发助手管了'));
    expect(access(app).stewards(solo.key)).toEqual([b]); expect(roleOf(app, solo.key, a)).toBe('none');
    expect(app.store.get("SELECT content FROM agent_messages WHERE bot_id=? AND content LIKE '已收回 开发助手%'", b)!.content).toContain('现由 理财助手 负责');
    // What an assistant that cannot read a topic is told: who looks after it.
    expect(run(c, { op: 'access', topic: '旅行计划' }, owner)).toEqual({ topic: '旅行计划', accessible: false, stewards: ['理财助手'] });
    expect(run(b, { op: 'access', topic: '旅行计划' }, owner)).toMatchObject({ you: 'steward', stewards: ['理财助手'] });
    // A change can be reverted, on the user's words again.
    expect(() => run(b, { op: 'revert', moveId: String(move.id) }, owner)).toThrow(/原话/);
  }, 120000);

  it('answers memory.topic inside a turn: the call is made with the user\'s words, and the conversation shows the change', async () => {
    const f = await fixture(), { app, chat, a, b } = f;
    const invest = userTopic(app, a, '投资');
    chat.scripts.push({ action: 'memory.topic', args: { op: 'grant', topic: '投资', bot: b, role: 'steward', quote: '以后我的投资交给你管' } });
    const first = await turn(app, b, '以后我的投资交给你管', 'grant-1');
    expect(roleOf(app, invest.key, b)).toBe('steward');
    expect(app.store.get('SELECT status FROM tool_calls WHERE task_id=? AND tool_name=?', first, 'memory.topic')!.status).toBe('succeeded');
    expect(app.store.get("SELECT content FROM agent_messages WHERE bot_id=? AND role='system' AND task_id=?", b, first)!.content).toBe('已允许 理财助手 负责「投资」');
    // The same words claimed for another request are not the user's: refused inside the turn.
    chat.scripts.push({ action: 'memory.topic', args: { op: 'revoke', topic: '投资', bot: a, quote: '以后我的投资交给你管' } });
    const second = await turn(app, b, '今天天气怎么样呢', 'grant-2');
    expect(JSON.parse(String(app.store.get('SELECT result_json FROM tool_calls WHERE task_id=?', second)!.result_json)).error ?? String(app.store.get('SELECT status FROM tool_calls WHERE task_id=?', second)!.status)).toBeTruthy();
    expect(roleOf(app, invest.key, a)).toBe('steward');
  }, 120000);
});

describe('inheritance, override and the user\'s own topic', () => {
  it('opens the user\'s topic to every assistant, now and later, until a sub-topic is closed to one of them', async () => {
    const f = await fixture(), { app, a, b } = f;
    app.runtime.memory.core.replace('workspace', '', { about: ['称呼：小明'], topics: [] }, 0);
    const me = tree(app).aboutMe(a), style = userTopic(app, a, '沟通偏好', { body: '喜欢简短回答' }), health = userTopic(app, a, '健康状况', { body: '对花生过敏' });
    // Put in the user's own topic, a topic is seen by everyone: only on the user's words.
    expect(() => tree(app).run(a, { op: 'move', topic: style.key, to: me })).toThrow(/任务/);
    for (const [name, child] of [['沟通偏好', style], ['健康状况', health]] as const) { const text = `把${name}放进关于我`; tree(app).run(a, { op: 'move', topic: child.key, to: me, quote: text }, { taskId: task(app, a, text) }); }
    expect(tree(app).aboutMe(a)).toBe(me);
    expect(meta(app, me)).toMatchObject({ special: 'about_me', resident: 1, owner: 'user', role: 'container' });
    // Every assistant reads it, the later ones too; the sub-topics follow.
    expect(roleOf(app, me, b)).toBe('reader'); expect(roleOf(app, health.key, b)).toBe('reader');
    const late = app.store.createBot('新助手');
    expect(roleOf(app, me, late)).toBe('reader'); expect(roleOf(app, style.key, late)).toBe('reader');
    // "别让理财助手看我的健康情况": the sub-topic is closed to one assistant, the rest stays open.
    tree(app).run(a, { op: 'revoke', topic: health.key, bot: b, quote: '别让理财助手看我的健康情况' }, { taskId: task(app, a, '别让理财助手看我的健康情况') });
    expect(roleOf(app, health.key, b)).toBe('none'); expect(roleOf(app, style.key, b)).toBe('reader'); expect(roleOf(app, health.key, late)).toBe('reader'); expect(roleOf(app, health.key, a)).toBe('steward');
    expect(await recalled(app, b, '沟通偏好的事实')).toContain(`memory:${style.key}`);
    expect(await recalled(app, b, '健康状况的事实')).toEqual([]);
    expect(await recalled(app, late, '健康状况的事实')).toContain(`memory:${health.key}`);
    // Opened by reference: the shared "about" lines and the sub-topics the assistant may read.
    const opened = (await app.runtime.memory.retrieval.retrieve(b, `memory:${me}`)).candidates[0].text;
    expect(opened).toContain('称呼：小明'); expect(opened).toContain('沟通偏好'); expect(opened).not.toContain('健康状况');
    // Its overview is the shared lines; neither it nor its sub-topics take an index line.
    personal(app).topics.indexTopics(b);
    expect(app.runtime.memory.core.read('bot', b).content.topics.map((line) => line.ref)).toEqual([]);
    expect(coreText(app, b)).toContain('- [共享] 称呼：小明');
    // The user's topic takes facts only: an experience of an assistant cannot be put in it.
    const experience = seed(app, a, '做法', { kind: 'experience' });
    expect(() => tree(app).run(a, { op: 'move', topic: experience.key, to: me })).toThrow(/不能放进同一个容器/);
  }, 90000);

  it('makes a user topic resident for those who may read it, within the 1500 tokens, and lets the user\'s "记住" reach the shared lines from a task of theirs only', async () => {
    const f = await fixture(), { app, a, b, c } = f;
    const plan = userTopic(app, a, '装修计划', { body: '装修预算三十万' });
    const run = (bot: string, args: Record<string, unknown>, text: string) => tree(app).run(bot, args, { taskId: task(app, bot, text) }) as Record<string, unknown>;
    run(a, { op: 'grant', topic: plan.key, bot: b, role: 'reader', quote: '理财助手也能看装修计划' }, '理财助手也能看装修计划');
    const before = coreText(app, c);
    run(a, { op: 'resident', topic: plan.key, on: true, quote: '把装修计划常驻' }, '把装修计划常驻');
    for (const bot of [a, b]) expect(coreText(app, bot)).toContain('常驻主题：\n- 「装修计划」装修预算三十万');
    expect(coreText(app, c)).toBe(before);
    expect(app.store.get("SELECT content FROM agent_messages WHERE bot_id=? AND content LIKE '已将%'", a)!.content).toBe('已将「装修计划」设为常驻');
    run(a, { op: 'resident', topic: plan.key, on: false, quote: '装修计划不用常驻了' }, '装修计划不用常驻了');
    expect(coreText(app, b)).not.toContain('常驻主题');
    // A reader whose core memory has no room refuses it, with the reason.
    const big = userTopic(app, a, '大主题', { body: '内容细节'.repeat(100) });
    run(a, { op: 'grant', topic: big.key, bot: b, role: 'reader', quote: '理财助手也能看大主题' }, '理财助手也能看大主题');
    const core = app.runtime.memory.core;
    core.update(b, { patch: { about: { add: ['甲'.repeat(300), '乙'.repeat(300), '丙'.repeat(300)] } }, expectedVersion: core.read('bot', b).version });
    expect(tokens(coreText(app, b))).toBeLessThan(CORE_MEMORY_TOKENS);
    expect(() => run(a, { op: 'resident', topic: big.key, on: true, quote: '把大主题常驻' }, '把大主题常驻')).toThrow(/超过 1500/);
    expect(meta(app, big.key).resident).toBe(0);

    // "记住…": a line of the user's own topic, from the user's task with their words; not from a routine, not with other words.
    const words = '记住：我叫小明', owner = task(app, a, words);
    expect(() => evaluateTool(app.store, a, { action: 'memory.core.update', scope: 'workspace', patch: { about: { add: ['称呼：小明'] } }, expectedVersion: 0 })).toThrow('共享核心记忆请由用户');
    expect(evaluateTool(app.store, a, { action: 'memory.core.update', scope: 'workspace', patch: { about: { add: ['称呼：小明'] } }, quote: words }).policy.bot_id).toBe(a);
    expect(() => access(app).assertUserTask(task(app, a, words, 'routine'))).toThrow(/直接发起/);
    expect(() => access(app).assertQuote(owner, '记住：我叫小红')).toThrow(/原话/);
    access(app).assertUserTask(owner); access(app).assertQuote(owner, words);
    expect(core.updateAbout(a, { about: { add: ['称呼：小明'] } }).changed).toBe(true);
    expect(() => core.updateAbout(a, { topics: { add: [{ title: 'x', line: 'y', ref: '' }] } })).toThrow(/只能修改/);
    expect(coreText(app, c)).toContain('- [共享] 称呼：小明');
  }, 90000);
});

describe('a question about a topic the assistant may not read', () => {
  it('tells the asking assistant who looks after it, lets it hand the question over once and only to that assistant, and keeps the answer out of its memory', async () => {
    const f = await fixture(), { app, chat, a, b, c } = f;
    const nex = userTopic(app, a, 'nex_bot', { body: '部署走东京服务器' });
    userTopic(app, b, '投资', { body: '我的投资怎么定投：指数基金' });
    enable(app, a, b);
    // "A" is the only steward; the topic is not B's.
    expect(roleOf(app, nex.key, b)).toBe('none');
    const hint = (volatile: string) => volatile.split('\n').filter((line) => line.includes('你没有访问权限'));
    // First the wrong assistant (refused), then the steward, a second time (refused), then the answer.
    chat.scripts.push(
      { action: 'agent.delegate', args: { botId: c, message: '请问 nex_bot 怎么部署', topic: `memory:${nex.key}` } },
      { action: 'agent.delegate', args: { botId: a, message: '请问 nex_bot 怎么部署', topic: `memory:${nex.key}` } },
      'A回答：结论 nex_bot 部署走东京服务器',
      { action: 'agent.delegate', args: { botId: a, message: '再问一次 nex_bot', topic: `memory:${nex.key}` } },
      '结论：已转交开发助手，nex_bot 部署走东京服务器',
    );
    const question = '请问 nex_bot 的部署怎么走，另外我的投资怎么定投', first = await turn(app, b, question, 'ask-1');
    const mine_ = streamed(chat).filter((request) => volatileOf(request).includes('你没有访问权限'));
    expect(mine_.length).toBeGreaterThanOrEqual(2);
    // One line, naming the top-level topic and the one steward; nothing of the content, nothing of the topic B may read.
    const lines = hint(volatileOf(mine_[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('「nex_bot」'); expect(lines[0]).toContain('开发助手'); expect(lines[0]).toContain(`botId="${a}"`); expect(lines[0]).toContain(`topic="memory:${nex.key}"`);
    expect(lines[0]).not.toContain('东京'); expect(lines[0]).not.toContain('投资');
    // The same bytes in every request of the task (it is stored with the recall), and kept with the task.
    for (const request of mine_) expect(hint(volatileOf(request))).toEqual(lines);
    expect(JSON.parse(String(app.store.get('SELECT hints_json FROM task_recall WHERE task_id=?', first)!.hints_json))).toEqual([{ topic: nex.key, name: 'nex_bot', steward: a, stewardName: '开发助手' }]);
    expect(String(app.store.get('SELECT block FROM task_recall WHERE task_id=?', first)!.block)).toContain('指数基金');

    const results = app.store.all("SELECT status,arguments_json,result_json FROM tool_calls WHERE task_id=? AND tool_name='agent.delegate' ORDER BY created_at,rowid", first);
    expect(results).toHaveLength(3);
    expect(String(results[0].result_json)).toContain('必须发给'); expect(String(results[0].result_json)).toContain('开发助手');
    expect(results[1].status).toBe('succeeded'); expect(String(results[2].result_json)).toContain('只能委派一次');
    expect(app.store.all('SELECT task_id,topic_id,target_bot_id FROM topic_delegations')).toEqual([{ task_id: first, topic_id: nex.key, target_bot_id: a }]);
    expect(app.store.get('SELECT COUNT(*) n FROM a2a_messages')!.n).toBe(1);
    // An assistant that looks after the topic is not told anything of the kind.
    const own = await turn(app, a, '请问 nex_bot 的部署怎么走', 'ask-2');
    expect(hint(volatileOf(streamed(chat).at(-1)!))).toEqual([]); expect(app.store.get('SELECT hints_json FROM task_recall WHERE task_id=?', own)!.hints_json).toBe('[]');

    // The answer and the replies built on it are not extracted by the asking assistant; what the user said is.
    enable(app, b);
    await pump(app, 8);
    const kept = () => app.store.all("SELECT content FROM assistant_memories WHERE bot_id=? AND kind IN ('fact','experience')", b).map((row) => String(row.content));
    expect(kept().some((content) => content.includes('请问 nex_bot 的部署怎么走'))).toBe(true);
    expect(kept().filter((content) => content.includes('A回答') || content.includes('已转交开发助手'))).toEqual([]);
    expect(app.store.get("SELECT COUNT(*) n FROM agent_messages WHERE bot_id=? AND role='peer' AND content LIKE '%A回答%'", b)!.n).toBe(1);
    // Without the record of the handover the same messages are extracted: it is the record that holds them back.
    app.store.run('DELETE FROM topic_delegations'); app.store.run('UPDATE assistant_memory_settings SET cursor_seq=0,cursor_offset=0 WHERE bot_id=?', b);
    await pump(app, 8);
    expect(kept().some((content) => content.includes('A回答'))).toBe(true);

    // The archive input: what came back is one line, the rest of the transcript stays.
    const call = app.store.get("SELECT assistant_entry_id FROM tool_calls WHERE task_id=? AND tool_name='agent.delegate' AND status='succeeded'", first)!;
    const items = [{ ref: 'entry:e0', role: 'user', content: question }, { ref: `entry:${call.assistant_entry_id}`, role: 'assistant', content: '转交' }, { ref: 'entry:e2', role: 'toolResult', content: 'A回答：东京' }, { ref: 'entry:e3', role: 'assistant', content: '结论：东京' }, { ref: 'entry:e4', role: 'user', content: '谢谢' }];
    const conversation = String(app.store.get('SELECT conversation_id FROM tasks WHERE id=?', first)!.conversation_id);
    const isolated = JSON.parse((app.runtime as unknown as { isolateEpisode(conversation: string, source: string): string }).isolateEpisode(conversation, JSON.stringify(items))) as typeof items;
    // (the table of delegations was emptied above for the control; put its row back)
    expect(isolated).toEqual(items);
    app.store.run('INSERT INTO topic_delegations(task_id,topic_id,target_bot_id,call_id,created_at) SELECT ?,?,?,id,? FROM tool_calls WHERE task_id=? AND tool_name=? AND status=?', first, nex.key, a, Date.now(), first, 'agent.delegate', 'succeeded');
    const again = JSON.parse((app.runtime as unknown as { isolateEpisode(conversation: string, source: string): string }).isolateEpisode(conversation, JSON.stringify(items))) as typeof items;
    expect(again.map((item) => item.ref)).toEqual(['entry:e0', `entry:${call.assistant_entry_id}`, 'entry:e2', 'entry:e4']);
    expect(again[2]).toMatchObject({ role: 'system', content: '（已转交 开发助手 回答 nex_bot 的问题，内容不归档）' });
    expect(JSON.stringify(again)).not.toContain('东京'); expect(again.at(-1)!.content).toBe('谢谢');
    expect(isolateSource('not json', [{ entry: 'x', line: 'y' }])).toBe('not json');
  }, 240000);
});

describe('merging user topics of the same name', () => {
  it('keeps two containers of one anchor apart while their access differs, and folds them into one on the next pass once it is the same', async () => {
    const f = await fixture(), { app, a, b } = f;
    enable(app, a, b);
    await pump(app, 2);
    // Each assistant has made its own "nex_bot" out of its facts; promotion makes them user topics seen by one assistant each.
    const build = (bot: string) => {
      const leaves = [1, 2, 3].map((n) => seed(app, bot, `${bot === a ? '甲' : '乙'}项目${n}`));
      const container = tree(app).run(bot, { op: 'group', topics: leaves.map((one) => one.key), name: 'nex_bot', anchor: 'nexbot项目' }) as { created: string };
      expect(tree(app).promote(bot)).toBe(4);
      app.store.run("UPDATE assistant_topics SET placed_by='auto' WHERE topic_id=?", container.created);
      return { container: container.created, leaves };
    };
    const first = build(a), second = build(b);
    for (const one of [first, second]) expect(meta(app, one.container)).toMatchObject({ owner: 'user', role: 'container' });
    await tree(app).organize(personal(app).settings(a), new AbortController().signal);
    await tree(app).organize(personal(app).settings(b), new AbortController().signal);
    const alive = () => app.store.all("SELECT id FROM assistant_memories m JOIN assistant_topics t ON t.topic_id=m.id WHERE t.role='container' AND m.status='active' AND t.owner='user'");
    expect(alive()).toHaveLength(2);
    expect(access(app).sameAccess(first.container, second.container)).toBe(false);
    // The user lets both assistants look after both: the access is the same, and the next pass merges them.
    let n = 0;
    const say_ = (bot: string, topic: string, who: string) => { const text = `${n++}请让${who}也负责 nex_bot 吧`; tree(app).run(bot, { op: 'grant', topic, bot: who, role: 'steward', quote: text }, { taskId: task(app, bot, text) }); };
    say_(a, first.container, b); say_(b, second.container, a);
    expect(access(app).sameAccess(first.container, second.container)).toBe(true);
    await tree(app).organize(personal(app).settings(a), new AbortController().signal);
    expect(alive()).toHaveLength(1);
    const [kept] = alive();
    expect(app.store.all('SELECT topic_id FROM assistant_topics WHERE parent_id=?', kept.id)).toHaveLength(6);
    expect(app.store.all("SELECT action FROM assistant_topic_moves WHERE action='merge'")).toHaveLength(1);
  }, 120000);
});

describe('retrieval scope, the map and forgetting', () => {
  it('shows a reader the topic and its facts only while it may read them, and the vector cache follows', async () => {
    const f = await fixture(), { app, fake, a, b } = f;
    await embeddingOn(app, fake); enable(app, a, b);
    const topic = userTopic(app, a, '咖啡偏好', { body: '喜欢拿铁咖啡' }), cache = vectorCache(app.store);
    cache.minimum = 1;
    await pump(app, 6);
    const before = JSON.stringify(await recalled(app, b, '拿铁咖啡'));
    expect(JSON.parse(before)).toEqual([]);
    expect(cache.has(b, 'fake-embed', 8, 'memory')).toBe(false);
    tree(app).run(a, { op: 'grant', topic: topic.key, bot: b, role: 'reader', quote: '理财助手也能看咖啡偏好' }, { taskId: task(app, a, '理财助手也能看咖啡偏好') });
    await pump(app, 4);
    const after = await recalled(app, b, '拿铁咖啡');
    expect(after).toContain(`memory:${topic.key}`);
    expect(after.some((ref) => topic.facts.some((fact) => ref === `memory:${fact}`))).toBe(false);
    expect((await app.runtime.memory.retrieval.retrieve(b, `memory:${topic.facts[0]}`)).candidates).toHaveLength(1);
    expect(cache.has(b, 'fake-embed', 8, 'memory')).toBe(true);
    // Revoked: the entry is rebuilt without it, and the topic is gone from the answer and from the index.
    personal(app).topics.indexTopics(b);
    expect(app.runtime.memory.core.read('bot', b).content.topics.map((line) => line.ref)).toContain(`memory:${topic.key}`);
    tree(app).run(a, { op: 'revoke', topic: topic.key, bot: b, quote: '不要让理财助手看咖啡偏好' }, { taskId: task(app, a, '不要让理财助手看咖啡偏好') });
    expect(cache.has(b, 'fake-embed', 8, 'memory')).toBe(false);
    expect(await recalled(app, b, '拿铁咖啡')).toEqual([]); expect((await app.runtime.memory.retrieval.retrieve(b, `memory:${topic.facts[0]}`)).candidates).toEqual([]);
    expect(app.runtime.memory.core.read('bot', b).content.topics).toEqual([]);
    expect(await recalled(app, a, '拿铁咖啡')).toContain(`memory:${topic.key}`);
  }, 120000);

  it('lists only the names of the top-level topics an assistant looks after in the map, and nothing for the others', async () => {
    const f = await fixture(), { app, a, b } = f;
    const kids = ['股票', '基金', '债券'].map((title) => userTopic(app, a, title));
    tree(app).run(a, { op: 'group', topics: kids.map((one) => one.key), name: '投资', anchor: '投资对象' });
    userTopic(app, a, '服务器与设备'); seed(app, a, '做法', { kind: 'experience' }); tree(app).aboutMe(a);
    const peers = directory(app.store) as Array<{ id: string; responsibilities?: string[]; directory_version: string }>;
    expect([...peers.find((peer) => peer.id === a)!.responsibilities!].sort()).toEqual(['投资', '服务器与设备']);
    expect(peers.find((peer) => peer.id === b)).not.toHaveProperty('responsibilities');
    const version = peers[0].directory_version;
    tree(app).run(a, { op: 'grant', topic: '服务器与设备', bot: b, role: 'steward', quote: '服务器也交给理财助手' }, { taskId: task(app, a, '服务器也交给理财助手') });
    const changed = directory(app.store) as typeof peers;
    expect(changed.find((peer) => peer.id === b)!.responsibilities).toEqual(['服务器与设备']); expect(changed[0].directory_version).not.toBe(version);
  }, 60000);

  it('forgets a whole assistant without losing the user topics it looked after: they pass to a reader, its grants and records go, and facts from its conversations go with their sources', async () => {
    const f = await fixture(), { app, a, b } = f;
    const shared = userTopic(app, b, '共同的事', { body: '两人都知道的事' }), own = userTopic(app, b, '秘密SECRET-B', { body: '只有B知道' });
    tree(app).run(b, { op: 'grant', topic: shared.key, bot: a, role: 'reader', quote: '开发助手也能看共同的事' }, { taskId: task(app, b, '开发助手也能看共同的事') });
    // A fact of the other assistant rests in the shared topic as well; the topic stays, the forgotten facts' topic goes.
    const factA = seed(app, a, '开发笔记', { kind: 'fact' });
    app.store.run('INSERT INTO assistant_topic_evidence(topic_id,memory_id,added_at) VALUES(?,?,?)', shared.key, factA.facts[0], Date.now());
    app.store.run('UPDATE assistant_memories SET refs_json=? WHERE id=?', JSON.stringify([...shared.refs, ...factA.refs.slice(0, 1)]), shared.key);
    vectorCache(app.store).minimum = 1;
    expect(access(app).stewards(shared.key)).toEqual([b]);
    const plan = app.runtime.memory.privacy.preview(b, { query: 'secret-b' });
    expect(plan.bots).toEqual([b]);
    app.runtime.memory.forget(b, { query: 'secret-b' }, plan.revision);
    // The topic whose facts were forgotten is gone; the one the user shares stays, and the other assistant looks after it now.
    expect(app.store.get('SELECT id FROM assistant_memories WHERE id=?', own.key)).toBeUndefined();
    expect(app.store.get("SELECT status FROM assistant_memories WHERE id=?", shared.key)).toBeTruthy();
    expect(access(app).stewards(shared.key)).toEqual([a]); expect(roleOf(app, shared.key, b)).toBe('none');
    expect(app.store.get('SELECT COUNT(*) n FROM user_topic_access WHERE principal=?', b)!.n).toBe(0);
    expect(app.store.get('SELECT COUNT(*) n FROM assistant_topic_moves WHERE bot_id=?', b)!.n).toBe(0);
    expect(personal(app).topics.topics(a).map((row) => row.id)).toContain(shared.key);
  }, 90000);
});

// ---- containers and merges over user topics, semantic hints, residents that grow ----------------------------------------------

const organize = (f: Fixture, bot: string) => tree(f.app).organize(personal(f.app).settings(bot), new AbortController().signal);
const containersOf = (app: App) => app.store.all("SELECT m.*,t.anchor,t.parent_id,t.owner FROM assistant_topics t JOIN assistant_memories m ON m.id=t.topic_id WHERE t.role='container' AND m.status='active' AND t.special IS NULL ORDER BY m.rowid");
const childrenOf = (app: App, key: string) => app.store.all('SELECT topic_id FROM assistant_topics WHERE parent_id=? ORDER BY rowid', key).map((row) => String(row.topic_id));
const rolesOf = (app: App, key: string, bots: string[]) => bots.map((bot) => roleOf(app, key, bot));
/** Lets `bot` read `topic` on the user's words, through the tool. */
function share(app: App, by: string, topic: string, who: string, role: 'reader' | 'steward' = 'reader') {
  const text = `让${counter++}号助手也${role === 'reader' ? '看' : '管'}这个主题吧`;
  tree(app).run(by, { op: 'grant', topic, bot: who, role, quote: text }, { taskId: task(app, by, text) });
}

describe('containers over user topics', () => {
  it('groups, joins and dissolves in the steward\'s pass, among topics of identical access only, and gives the container exactly that access', async () => {
    const f = await fixture(), { app, chat, a, b, c } = f;
    enable(app, a, b); await pump(app, 3);
    const created: Array<{ topics: string[] }> = [];
    f.create = (input) => { if (input.topics.some((topic) => topic.title.startsWith('做法'))) return { anchor: '', name: '', aliases: [], summary: '', overview: '', members: [] }; created.push({ topics: input.topics.map((topic) => topic.title) }); return { anchor: '运维体系', name: '运维体系', aliases: ['ops'], summary: '运维相关', overview: input.topics.map((topic) => topic.title).join('；'), members: input.topics.map((topic) => topic.id) }; };
    const mine = [1, 2, 3, 4, 5].map((n) => userTopic(app, a, `运维笔记${n}`)), shared = [1, 2, 3].map((n) => userTopic(app, a, `共享笔记${n}`));
    for (const one of shared) share(app, a, one.key, b);
    // Topics of the assistant's own (never mixed in) and the user's own topic (never grouped), both with enough to tempt.
    for (let n = 1; n <= 5; n++) seed(app, a, `做法${n}`, { kind: 'experience' });
    const me = tree(app).aboutMe(a), style = userTopic(app, a, '沟通偏好');
    tree(app).run(a, { op: 'move', topic: style.key, to: me, quote: '把沟通偏好放进关于我吧' }, { taskId: task(app, a, '把沟通偏好放进关于我吧') });
    const before = chat.requests.length;
    // The assistant topics are judged first (no anchor: nothing); the user topics follow in the next pass.
    await organize(f, a);
    expect(containersOf(app)).toHaveLength(0);
    expect(await organize(f, a)).toBeGreaterThanOrEqual(1);
    const [made] = containersOf(app);
    expect(containersOf(app)).toHaveLength(1);
    // Only the five of one access; the shared ones, the assistant's topics and the user's own topic are not in it or its input.
    expect(made).toMatchObject({ owner: 'user', anchor: '运维体系' }); expect(childrenOf(app, String(made.id))).toEqual(mine.map((one) => one.key));
    expect(created.at(-1)!.topics.sort()).toEqual(mine.map((_, n) => `运维笔记${n + 1}`).sort());
    expect(rolesOf(app, String(made.id), [a, b, c])).toEqual(['steward', 'none', 'none']);
    expect(access(app).sameAccess(String(made.id), mine[0].key)).toBe(true);
    for (const one of shared) expect(meta(app, one.key).parent_id).toBeNull();
    expect(meta(app, style.key).parent_id).toBe(me);
    expect(chat.requests.length).toBeGreaterThan(before);
    // A new topic joins by its name when its access is the same, and not when it is not.
    const same = userTopic(app, a, '运维体系手册'), other = userTopic(app, a, '运维体系值班表');
    share(app, a, other.key, c);
    await organize(f, a);
    expect(meta(app, same.key).parent_id).toBe(made.id); expect(meta(app, other.key).parent_id).toBeNull();
    expect(roleOf(app, other.key, c)).toBe('reader');
    // A topic made to look like the others, but seen by one more assistant than the container, stays out too.
    // Dissolved below two children: the children go to the top level with the access they had.
    for (const one of [mine[0], mine[1], mine[2], mine[3], mine[4]]) app.store.run("UPDATE agent_messages SET content='[已遗忘]' WHERE id=?", one.refs[0].id);
    await organize(f, a);
    expect(containersOf(app).filter((row) => row.owner === 'user')).toHaveLength(0);
    expect(meta(app, same.key).parent_id).toBeNull(); expect(rolesOf(app, same.key, [a, b, c])).toEqual(['steward', 'none', 'none']);
  }, 120000);

  it('keeps the access of a topic when it leaves its container, and refuses to put one into a container of another access', async () => {
    const f = await fixture(), { app, a, b } = f;
    const kids = [1, 2, 3].map((n) => userTopic(app, a, `项目${n}`)), outsider = userTopic(app, a, '项目外');
    const box = tree(app).run(a, { op: 'group', topics: kids.map((one) => one.key), name: '项目', anchor: '项目对象' }) as { created: string };
    expect(rolesOf(app, box.created, [a, b])).toEqual(['steward', 'none']);
    share(app, a, outsider.key, b);
    expect(() => tree(app).run(a, { op: 'move', topic: outsider.key, to: box.created })).toThrow(/访问范围不同/);
    expect(() => tree(app).run(a, { op: 'group', topics: [userTopic(app, a, '项目四').key, outsider.key, userTopic(app, a, '项目五').key], name: '另一个', anchor: '另一个对象' })).toThrow(/访问范围不同/);
    // Granting on the container reaches what is in it; leaving keeps what the topic had there.
    share(app, a, box.created, b);
    expect(rolesOf(app, kids[0].key, [b])).toEqual(['reader']);
    tree(app).run(a, { op: 'move', topic: kids[0].key });
    expect(rolesOf(app, kids[0].key, [a, b])).toEqual(['steward', 'reader']);
    // The container with two left is no container; both stay as they were seen.
    tree(app).run(a, { op: 'move', topic: kids[1].key });
    expect(containersOf(app).filter((row) => row.owner === 'user')).toHaveLength(0);
    expect(rolesOf(app, kids[2].key, [a, b])).toEqual(['steward', 'reader']);
  }, 60000);
});

describe('user topics of the same name', () => {
  it('merges two once their access is identical: the older stays, the facts and members move, one tidy-up call, revertible; different access never', async () => {
    const f = await fixture(), { app, chat, a, b } = f;
    enable(app, a, b); await pump(app, 3);
    const first = userTopic(app, a, '投资', { body: '定投指数基金' }), second = userTopic(app, a, '投资', { body: '每月第一周定投' });
    share(app, a, second.key, b);
    const archive = 'archive-' + id();
    app.store.run("INSERT INTO assistant_topic_members(topic_id,kind,ref_id,bot_id,placed_by,added_at) VALUES(?,?,?,?,'auto',?)", second.key, 'episode', archive, a, Date.now());
    const merges = () => chat.requests.filter((request) => !request.stream && String((request.messages as Array<{ role: string; content: string }>)[0].content).includes('整理主题条目')).length;
    const topics = () => app.store.all("SELECT id,status,content FROM assistant_memories WHERE id IN (?,?)", first.key, second.key);
    // The access differs: nothing is merged, whatever the name.
    await organize(f, a);
    expect(topics().map((row) => row.status)).toEqual(['active', 'active']); expect(merges()).toBe(0);
    // The user lets the other assistant read the first as well: the next pass merges.
    share(app, a, first.key, b);
    expect(access(app).sameAccess(first.key, second.key)).toBe(true);
    expect(await organize(f, a)).toBe(1); expect(merges()).toBe(1);
    const survivor = app.store.get('SELECT * FROM assistant_memories WHERE id=?', first.key)!, gone = app.store.get('SELECT * FROM assistant_memories WHERE id=?', second.key)!;
    expect(survivor.status).toBe('active'); expect(gone.status).toBe('retired');
    expect(String(survivor.content)).toContain('定投指数基金'); expect(String(survivor.content)).toContain('的事实');
    const evidence = app.store.all('SELECT memory_id FROM assistant_topic_evidence WHERE topic_id=?', first.key).map((row) => String(row.memory_id));
    expect(evidence.sort()).toEqual([...first.facts, ...second.facts].sort());
    expect(app.store.all('SELECT memory_id FROM assistant_topic_evidence WHERE topic_id=?', second.key)).toEqual([]);
    expect(app.store.all('SELECT topic_id FROM assistant_topic_members WHERE ref_id=?', archive).map((row) => row.topic_id)).toEqual([first.key]);
    expect(JSON.parse(String(survivor.refs_json))).toHaveLength(6);
    expect(await recalled(app, b, '定投')).toContain(`memory:${first.key}`); expect(await recalled(app, b, '定投')).not.toContain(`memory:${second.key}`);
    const [move] = app.store.all("SELECT * FROM assistant_topic_moves WHERE action='merge'");
    expect(move).toMatchObject({ topic_id: first.key, actor: 'auto', reverted_by: null });
    // Reverted: both as they were, with their facts and members; the pair is not merged again.
    tree(app).run(a, { op: 'revert', moveId: String(move.id) });
    expect(topics().map((row) => row.status)).toEqual(['active', 'active']);
    expect(String(app.store.get('SELECT content FROM assistant_memories WHERE id=?', first.key)!.content)).toBe('定投指数基金');
    expect(String(app.store.get('SELECT content FROM assistant_memories WHERE id=?', second.key)!.content)).toBe('每月第一周定投');
    expect(app.store.all('SELECT memory_id FROM assistant_topic_evidence WHERE topic_id=?', second.key).map((row) => row.memory_id).sort()).toEqual([...second.facts].sort());
    expect(app.store.all('SELECT topic_id FROM assistant_topic_members WHERE ref_id=?', archive).map((row) => row.topic_id)).toEqual([second.key]);
    await organize(f, a); expect(merges()).toBe(1);
  }, 120000);

  it('counts the merge, the new container and an overview against the same three calls of a pass', async () => {
    const f = await fixture(), { app, chat, a, b } = f;
    enable(app, a, b); await pump(app, 3);
    f.create = (input) => ({ anchor: '运维体系', name: '运维体系', aliases: [], summary: 's', overview: 'o', members: input.topics.slice(0, 3).map((topic) => topic.id) });
    // Five private topics to group; two of one name, seen by the same two assistants; two containers waiting for an overview.
    for (let n = 1; n <= 5; n++) userTopic(app, a, `运维笔记${n}`);
    for (const topic of [userTopic(app, a, '重名'), userTopic(app, a, '重名')]) share(app, a, topic.key, b);
    for (const name of ['甲', '乙']) { const kids = [1, 2, 3].map((n) => userTopic(app, a, `${name}专题${n}`)); for (const kid of kids) share(app, a, kid.key, b, 'steward'); tree(app).run(a, { op: 'group', topics: kids.map((kid) => kid.key), name: `${name}专题`, anchor: `${name}专题对象` }); }
    const count = (marker: string) => chat.requests.filter((request) => !request.stream && String((request.messages as Array<{ role: string; content: string }>)[0].content).includes(marker)).length;
    expect(await organize(f, a)).toBe(3);
    expect(count('组建容器')).toBe(1); expect(count('整理主题条目')).toBe(1); expect(count('重写容器概要')).toBe(1);
    expect(await organize(f, a)).toBe(1); expect(count('重写容器概要')).toBe(2);
  }, 120000);
});

describe('a question that names nothing', () => {
  it('is routed to the top-level user topic its meaning is closest to, also one the assistant may not read, and the hint names that topic and its steward only', async () => {
    const f = await fixture(), { app, fake, a, b } = f;
    await embeddingOn(app, fake); enable(app, a, b); await pump(app, 3);
    // A container the other assistant may not read, with sub-topics whose names stay out of the hint; a topic of its own.
    const kids = ['部署甲', '部署乙', '部署丙'].map((title) => userTopic(app, a, title, { body: `${title}的流程` }));
    const box = tree(app).run(a, { op: 'group', topics: kids.map((one) => one.key), name: '运维流程', anchor: '运维对象' }) as { created: string };
    userTopic(app, b, '会议习惯', { body: '周一会议提前十分钟' });
    await pump(app, 4);
    const found = await app.runtime.memory.retrieval.retrieve(b, '请问怎么上线发布');
    expect(found.blocked).toEqual([box.created]);
    const task_ = await turn(app, b, '请问怎么上线发布', 'semantic-1');
    const hints = JSON.parse(String(app.store.get('SELECT hints_json FROM task_recall WHERE task_id=?', task_)!.hints_json));
    expect(hints).toEqual([{ topic: box.created, name: '运维流程', steward: a, stewardName: '开发助手' }]);
    const block = String(app.store.get('SELECT block FROM task_recall WHERE task_id=?', task_)!.block);
    expect(block).toContain('「运维流程」'); expect(block).toContain('开发助手');
    for (const secret of ['部署甲', '部署乙', '部署丙', '的流程']) expect(block).not.toContain(secret);
    expect(String(volatileOf(streamed(f.chat).at(-1)!))).toContain('「运维流程」');
    // The steward is not told; a question closer to a topic the assistant reads is its own; two equally close topics decide nothing.
    expect((await app.runtime.memory.retrieval.retrieve(a, '请问怎么上线发布')).blocked).toBeUndefined();
    expect((await app.runtime.memory.retrieval.retrieve(b, '周一开会安排')).blocked).toBeUndefined();
    userTopic(app, a, '拿铁偏好', { body: '喜欢拿铁咖啡' }); userTopic(app, a, '咖啡豆产地', { body: '咖啡豆产自云南' });
    await pump(app, 4);
    expect((await app.runtime.memory.retrieval.retrieve(b, '推荐一款咖啡')).blocked).toBeUndefined();
    // A name still decides before meaning does.
    expect((await app.runtime.memory.retrieval.retrieve(b, '运维流程是什么')).blocked).toEqual([box.created]);
  }, 180000);
});

describe('a resident topic that grows', () => {
  it('drops index lines first, then shows the newest resident topic as one line, and restores the full overview when it fits again; the core memory stays within 1500 tokens', async () => {
    const f = await fixture(), { app, a, b } = f;
    const core = app.runtime.memory.core, used = () => tokens(coreText(app, b));
    const run = (bot: string, args: Record<string, unknown>, text: string) => tree(app).run(bot, args, { taskId: task(app, bot, text) });
    const older = userTopic(app, a, '旧常驻', { body: '旧的常驻概要。'.repeat(20) }), newer = userTopic(app, a, '新常驻', { body: '新的常驻概要。'.repeat(20) });
    for (const topic of [older, newer]) run(a, { op: 'grant', topic: topic.key, bot: b, role: 'reader', quote: `让理财助手看${topic.key.slice(0, 6)}` }, `让理财助手看${topic.key.slice(0, 6)}`);
    run(a, { op: 'resident', topic: older.key, on: true, quote: '把旧常驻设为常驻' }, '把旧常驻设为常驻');
    await new Promise((resolve) => setTimeout(resolve, 5));
    run(a, { op: 'resident', topic: newer.key, on: true, quote: '把新常驻设为常驻' }, '把新常驻设为常驻');
    // The assistant's own lines: a few index lines of topics of its own, and shared lines of the user.
    for (let n = 1; n <= 3; n++) seed(app, b, `自有主题${n}`, { kind: 'experience' });
    core.update(b, { patch: { about: { add: ['甲'.repeat(200), '乙'.repeat(200)] } }, expectedVersion: core.read('bot', b).version });
    for (let n = 0; n < 3; n++) personal(app).topics.indexTopics(b);
    const lines = () => core.read('bot', b).content.topics.length, flags = () => app.store.all('SELECT topic_id FROM resident_shortened WHERE bot_id=?', b).map((row) => String(row.topic_id));
    expect(lines()).toBeGreaterThan(0); expect(flags()).toEqual([]); expect(used()).toBeLessThanOrEqual(CORE_MEMORY_TOKENS);
    const grow = (key: string, base: string, extra: number) => personal(app).put(a, 'topic', key === older.key ? '旧常驻' : '新常驻', base + '内容细节'.repeat(Math.ceil(extra / 6)), JSON.parse(String(app.store.get('SELECT refs_json FROM assistant_memories WHERE id=?', key)!.refs_json)), app.store.get('SELECT * FROM assistant_memories WHERE id=?', key)!, false, true);
    const body = (key: string) => String(app.store.get('SELECT content FROM assistant_memories WHERE id=?', key)!.content);
    const small = body(older.key), startLines = lines();

    // A little over: the index lines go, least recalled and oldest first; nothing is shortened.
    grow(older.key, small, CORE_MEMORY_TOKENS - used() + 20);
    expect(lines()).toBeLessThan(startLines); expect(flags()).toEqual([]); expect(used()).toBeLessThanOrEqual(CORE_MEMORY_TOKENS);
    // Far over: every line is gone, and the topic made resident last is one line (the older one keeps its overview).
    const lineTokens = used() - tokens(coreText(app, b).split('主题索引：')[0]);
    grow(older.key, body(older.key), CORE_MEMORY_TOKENS - used() + lineTokens + 60);
    expect(lines()).toBe(0); expect(flags()).toEqual([newer.key]); expect(used()).toBeLessThanOrEqual(CORE_MEMORY_TOKENS);
    const text = coreText(app, b);
    expect(text).toContain(`- 新常驻 — 新常驻说明 (memory:${newer.key})`); expect(text).not.toContain('新的常驻概要'); expect(text).toContain(`「旧常驻」${body(older.key)}`);
    const shortened = app.store.all("SELECT * FROM assistant_topic_moves WHERE bot_id=? AND action='resident' AND actor='auto'", b);
    expect(shortened).toHaveLength(1); expect(JSON.parse(String(shortened[0].after_json))).toEqual({ shortened: true });
    expect(() => run(b, { op: 'revert', moveId: String(shortened[0].id) }, '撤销一下自动缩写')).toThrow(/不能撤销/);
    // The other assistant that reads it is not touched, and neither is the steward's own core memory.
    expect(app.store.get('SELECT COUNT(*) n FROM resident_shortened WHERE bot_id=?', a)!.n).toBe(0);
    // Back to a size that fits: the full overview returns (the index lines that were given up are not brought back).
    grow(older.key, small, 0);
    expect(flags()).toEqual([]); expect(coreText(app, b)).toContain('新的常驻概要'); expect(used()).toBeLessThanOrEqual(CORE_MEMORY_TOKENS); expect(lines()).toBe(0);
    expect(app.store.all("SELECT after_json FROM assistant_topic_moves WHERE bot_id=? AND action='resident' AND actor='auto' ORDER BY created_at,rowid", b).map((row) => JSON.parse(String(row.after_json)))).toEqual([{ shortened: true }, { shortened: false }]);
  }, 90000);
});
