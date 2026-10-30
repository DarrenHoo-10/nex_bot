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
import { Episodes } from './episodes.ts';
import { tokens } from './token-estimate.ts';
import { evaluateTool } from './policy.ts';
import { CORE_MEMORY_TOKENS } from './core-memory.ts';
import { dropVectors, storeVector, unpackVector, vectorRows } from './retrieval-index.ts';
import { VectorCache, vectorCache } from './vector-cache.ts';
import { CONTAINER_LIMIT, PENDING_TITLE, normalizeTerm, recurs } from './topic-tree.ts';
import { CORE_PATCH_FACTS } from './topic-memory.ts';

// The two-level structure of assistant topics, phase 1 (docs/plans/user-topics.md sections 4, 8, 9, 12 and 15.1).
// Isolated fixtures only: a fake chat model (answering the container prompts from a script) and a fake embedding
// service; nothing leaves the machine. Topics are seeded directly (a topic, its facts and their original messages at
// chosen times), so the rules of grouping are tested without the merge in the way.

type App = Awaited<ReturnType<typeof createPersonalApp>>;
interface Fixture { root: string; app: App; chat: Awaited<ReturnType<typeof startFakePersonalMemory>>; fake: Awaited<ReturnType<typeof startFakeRetrieval>>; bot: string; script: Script }
interface Script { merge?: (input: { topic: { id: string; title: string } | null; facts: Array<{ id: string }> }) => Record<string, unknown>; create: (input: { topics: Array<{ id: string; title: string; summary: string }>; containers: string[] }) => Record<string, unknown>; rewrite: (input: { container: { title: string; aliases: string[] }; children: Array<{ id: string; title: string }> }) => Record<string, unknown> }
const fixtures: Fixture[] = [];
const DAY = 86_400_000, NOW = Date.UTC(2027, 2, 1, 9, 0, 0);
const usage = { prompt_tokens: 400, completion_tokens: 80 };
const CREATE = '组建容器', REWRITE = '重写容器概要', MERGE = '整理主题条目';

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nex-tree-')), chat = await startFakePersonalMemory(), fake = await startFakeRetrieval();
  const app = await createPersonalApp({ dir: root, key: randomBytes(32), token: 'synthetic-token', identity: false, memoryRuntime: false, hostDevice: false });
  app.store.saveConfig({ provider: 'openai', endpoint: chat.origin + '/v1', model: 'fixture-chat', apiKey: 'synthetic-only', contextWindow: 64000, maxOutputTokens: 4096 });
  const bot = app.store.createBot('合成个人助手'); clearInterval(app.runtime.memory.personal.timer);
  const script: Script = {
    create: () => ({ anchor: '', name: '', aliases: [], summary: '', overview: '', members: [] }),
    rewrite: (input) => ({ name: input.container.title, aliases: input.container.aliases, summary: `${input.children.length} 个子主题的概要`, overview: input.children.map((child) => child.title).join('；') }),
  };
  chat.setOverride((body) => {
    if (body.stream) return undefined;
    const system = String((body.messages as Array<{ role: string; content: string }>).find((message) => message.role === 'system')?.content ?? ''), input = JSON.parse(String((body.messages as Array<{ content: string }>).at(-1)?.content ?? '{}'));
    const answer = (value: unknown) => ({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }], usage });
    if (system.includes(CREATE)) return answer(script.create(input));
    if (system.includes(REWRITE)) return answer(script.rewrite(input));
    if (system.includes(MERGE) && script.merge) return answer(script.merge(input));
    return undefined;
  });
  const result = { root, app, chat, fake, bot, script }; fixtures.push(result); return result;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const { app, chat, fake, root } of fixtures.splice(0)) {
    await app.close(); await chat.close(); await fake.close();
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('nex-tree-')) throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

const personal = (app: App) => app.runtime.memory.personal;
const tree = (app: App) => personal(app).tree;
const instructionOf = (body: Record<string, unknown>) => String((body.messages as Array<{ role: string; content: string }>).find((message) => message.role === 'system')?.content ?? '');
const calls = (chat: Fixture['chat'], marker: string) => chat.requests.filter((request) => !request.stream && instructionOf(request).includes(marker));
const clock = (at = NOW) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at); return { advance: (ms: number) => vi.setSystemTime(Date.now() + ms), set: (to: number) => vi.setSystemTime(to) }; };
async function embeddingOn(app: App, fake: Fixture['fake']) {
  const config = app.runtime.memory.retrieval.config;
  await config.save({ kind: 'embedding', baseUrl: fake.origin, model: 'fake-embed', enabled: true, version: config.view().embedding.version });
}
function enable(app: App, bot: string) {
  personal(app).save(bot, { version: personal(app).settings(bot).version, enabled: true, model: 'fixture-memory', dailyBudget: 100000 });
}
async function pump(app: App, times = 1) {
  for (let i = 0; i < times; i++) { app.store.run('UPDATE assistant_memory_settings SET next_attempt=0'); await personal(app).flush(); }
}
/** Memory on and the one-time migration of the (empty) assistant done, so `organize` may run. */
async function ready(f: Fixture) { enable(f.app, f.bot); await pump(f.app); expect(personal(f.app).topics.migrated(f.bot)).toBe(true); }
const organize = (f: Fixture) => tree(f.app).organize(personal(f.app).settings(f.bot), new AbortController().signal);

let counter = 0;
/** Moves the memory pump's cursors past everything seeded, so it extracts nothing from the seed messages. */
function settle(app: App, bot: string) {
  app.store.run('UPDATE assistant_memory_settings SET cursor_seq=(SELECT COALESCE(MAX(seq),0) FROM agent_messages WHERE bot_id=?),episode_cursor=(SELECT COALESCE(MAX(created_at),0) FROM conversation_episodes WHERE bot_id=?) WHERE bot_id=?', bot, bot, bot);
}
/**
 * A leaf topic resting on one fact per entry of `days` (days from NOW at which its original message was said), with its
 * summary and evidence rows, as the merge leaves it. `task` puts the messages in a conversation (for archive membership).
 */
function leaf(app: App, bot: string, title: string, opts: { days?: number[]; body?: string; task?: string; at?: number; kind?: string } = {}) {
  const days = opts.days ?? [-30, -20, -5], refs: Array<{ id: string; hash: string }> = [], facts: string[] = [];
  for (const day of days) {
    const content = `${title}的事实${++counter}`, source = 'seed-' + id();
    app.agents.publish(bot, 'user', 'message', content, source, opts.task ?? null, null, (opts.at ?? Date.now()) + day * DAY);
    const message = app.store.get('SELECT id FROM agent_messages WHERE source_key=?', source)!, ref = { id: String(message.id), hash: hash(content) };
    facts.push(personal(app).put(bot, opts.kind ?? 'experience', title, content, [ref])); refs.push(ref);
  }
  const key = personal(app).put(bot, 'topic', title, opts.body ?? `${title}正文`, refs);
  app.store.run('INSERT INTO assistant_topics(topic_id,bot_id,summary) VALUES(?,?,?)', key, bot, `${title}说明`);
  for (const fact of facts) app.store.run('INSERT INTO assistant_topic_evidence(topic_id,memory_id,added_at) VALUES(?,?,?)', key, fact, Date.now());
  settle(app, bot);
  return { key, facts, refs };
}
const meta = (app: App, key: string) => app.store.get('SELECT * FROM assistant_topics WHERE topic_id=?', key)!;
const containers = (app: App, bot: string) => app.store.all("SELECT m.*,t.anchor,t.aliases_json,t.parent_id,t.overview_stale,t.overview_at,t.summary,t.placed_by FROM assistant_topics t JOIN assistant_memories m ON m.id=t.topic_id WHERE t.bot_id=? AND t.role='container' AND m.status='active' ORDER BY m.rowid", bot);
const childrenOf = (app: App, key: string) => app.store.all('SELECT topic_id FROM assistant_topics WHERE parent_id=? ORDER BY rowid', key).map((row) => String(row.topic_id));
const moves = (app: App, bot: string, action?: string) => app.store.all(`SELECT * FROM assistant_topic_moves WHERE bot_id=? ${action ? 'AND action=?' : ''} ORDER BY created_at,rowid`, bot, ...(action ? [action] : []));
const coreLines = (app: App, bot: string) => app.runtime.memory.core.read('bot', bot).content.topics;
/** Five top-level leaves of one project that recur over a month, and the model's agreement to group the first four. */
function project(f: Fixture, names = ['甲项目发布', '甲项目数据库', '甲项目权限', '甲项目日志', '监控告警']) {
  const leaves = names.map((name) => leaf(f.app, f.bot, name));
  f.script.create = (input) => ({ anchor: '甲项目', name: '甲项目', aliases: ['jia'], summary: '甲项目的运行与发布', overview: '甲项目：' + input.topics.map((topic) => topic.title).join('、'), members: leaves.slice(0, 4).map((one) => one.key) });
  return leaves;
}

describe('migration 39', () => {
  it('leaves what an assistant recalls and carries in its prompt byte for byte as it was, with no container present, on every run', async () => {
    const golden = JSON.parse(readFileSync(new URL('./testing/memory-baseline.golden.json', import.meta.url), 'utf8'));
    expect(await baselineSnapshot()).toEqual(golden);
    expect(await baselineSnapshot()).toEqual(golden);
  }, 120000);

  it('adds the structure once, keeps every topic a top-level leaf, and runs again without changing anything', async () => {
    const { app, bot } = await fixture();
    const topic = leaf(app, bot, '甲');
    const columns = (store: CoreStore, table: string) => (store.all(`PRAGMA table_info(${table})`) as Array<{ name: string }>).map((column) => column.name).sort();
    const before = columns(app.store, 'assistant_topics');
    expect(before).toEqual(expect.arrayContaining(['owner', 'role', 'parent_id', 'anchor', 'aliases_json', 'placed_by', 'split_from', 'overview_stale', 'overview_at']));
    expect(columns(app.store, 'task_recall')).toContain('topic_ids');
    for (const table of ['assistant_topic_members', 'assistant_topic_member_scan', 'assistant_topic_moves']) expect(app.store.get('SELECT COUNT(*) n FROM sqlite_master WHERE name=?', table)!.n).toBe(1);
    // The tables of the next migration (user topics) are there too, empty.
    for (const table of ['user_topic_access', 'topic_delegations']) expect(app.store.get(`SELECT COUNT(*) n FROM ${table}`)!.n).toBe(0);
    expect(meta(app, topic.key)).toMatchObject({ role: 'leaf', parent_id: null, owner: 'bot', placed_by: 'auto', anchor: '', aliases_json: '[]', overview_stale: 0 });
    for (let round = 0; round < 3; round++) {
      const reopened = new CoreStore(app.store.dir, app.store.key, 'synthetic-token');
      try {
        expect(reopened.get('SELECT COUNT(*) n FROM schema_migrations WHERE version=39')!.n).toBe(1);
        expect(columns(reopened, 'assistant_topics')).toEqual(before);
        expect(reopened.get('SELECT role,parent_id FROM assistant_topics WHERE topic_id=?', topic.key)).toMatchObject({ role: 'leaf', parent_id: null });
        // As after a restore of the marker table: the migration runs again over the finished schema.
        if (round < 2) reopened.run('DELETE FROM schema_migrations WHERE version=39');
      } finally { reopened.close(); }
    }
  });
});

describe('creating a container', () => {
  it('groups four topics that recur and name one anchor, in one model call, with the overview and a record of the move', async () => {
    const f = await fixture(), { app, chat, bot } = f;
    await ready(f); clock();
    const leaves = project(f);
    expect(await organize(f)).toBe(1);
    expect(calls(chat, CREATE)).toHaveLength(1);
    const [container] = containers(app, bot);
    expect(containers(app, bot)).toHaveLength(1);
    expect(container).toMatchObject({ title: '甲项目', anchor: '甲项目', refs_json: '[]', kind: 'topic' });
    expect(container.content).toContain('甲项目发布');
    expect(JSON.parse(String(container.aliases_json))).toEqual(['jia']);
    expect(childrenOf(app, String(container.id))).toEqual(leaves.slice(0, 4).map((one) => one.key));
    expect(meta(app, leaves[4].key).parent_id).toBeNull();
    // Children keep their own evidence; the container has none and rests on theirs.
    expect(app.store.get('SELECT COUNT(*) n FROM assistant_topic_evidence WHERE topic_id=?', container.id)!.n).toBe(0);
    expect(tree(app).sources(container)).toHaveLength(12);
    expect(personal(app).topics.topics(bot).map((row) => row.id)).toContain(container.id);
    const [move] = moves(app, bot, 'create');
    expect(moves(app, bot)).toHaveLength(1);
    expect(move).toMatchObject({ topic_id: container.id, actor: 'auto', reverted_by: null });
    expect(JSON.parse(String(move.before_json)).children).toHaveLength(4);
    // The input to the model: only top-level topics, with their summaries, and the names of existing containers.
    const input = JSON.parse(String((calls(chat, CREATE)[0].messages as Array<{ content: string }>).at(-1)!.content));
    expect(input.topics).toHaveLength(5); expect(input.containers).toEqual([]);
    // Judged just now: not again before a day has passed and five more topics are new.
    expect(await organize(f)).toBe(0);
  }, 60000);

  it('does not create one from topics that all fall on one day, nor from only two, nor when the model names no anchor', async () => {
    const f = await fixture(), { app, chat, bot } = f;
    await ready(f); clock();
    // One day: the recurrence rule fails before the model is asked.
    for (const name of ['乙一', '乙二', '乙三', '乙四', '乙五']) leaf(app, bot, name, { days: [-1, -1, -1] });
    expect(await organize(f)).toBe(0); expect(calls(chat, CREATE)).toHaveLength(0);
    expect(recurs({ days: new Set([1, 2]), first: 0, last: 20 * DAY, fellBack: false })).toBe(false);
    expect(recurs({ days: new Set([1, 2, 3]), first: 0, last: 13 * DAY, fellBack: false })).toBe(false);
    expect(recurs({ days: new Set([1, 2, 3]), first: 0, last: 14 * DAY, fellBack: false })).toBe(true);
    // Two topics: too few for a model to be asked about.
    const g = await fixture(); await ready(g);
    leaf(g.app, g.bot, '丙一'); leaf(g.app, g.bot, '丙二');
    expect(await organize(g)).toBe(0); expect(calls(g.chat, CREATE)).toHaveLength(0);
    // The model finds no anchor: nothing is created, the set is turned down.
    const h = await fixture(); await ready(h);
    for (const name of ['丁一', '丁二', '丁三', '丁四', '丁五']) leaf(h.app, h.bot, name);
    expect(await organize(h)).toBe(1);
    expect(calls(h.chat, CREATE)).toHaveLength(1); expect(containers(h.app, h.bot)).toHaveLength(0); expect(moves(h.app, h.bot)).toHaveLength(0);
  }, 90000);

  it('turns down a group of fewer than three, one without recurrence and one that repeats a container, and never asks about the same topics twice', async () => {
    const f = await fixture(), { app, chat, bot, script } = f;
    await ready(f); const time = clock();
    const leaves = project(f);
    script.create = () => ({ anchor: '甲项目', name: '甲项目', aliases: [], summary: 's', overview: 'o', members: [leaves[0].key, leaves[1].key] });
    expect(await organize(f)).toBe(1);
    expect(containers(app, bot)).toHaveLength(0);
    // Nothing new joined: a day later the same topics are not sent again, though the interval has passed.
    time.advance(2 * DAY); expect(await organize(f)).toBe(0); expect(calls(chat, CREATE)).toHaveLength(1);
    // Five new topics change the set: it is judged again, and now a group is made.
    script.create = () => ({ anchor: '甲项目', name: '甲项目', aliases: [], summary: 's', overview: 'o', members: leaves.slice(0, 3).map((one) => one.key) });
    for (const name of ['戊一', '戊二', '戊三', '戊四', '戊五']) leaf(app, bot, name);
    expect(await organize(f)).toBe(1); expect(containers(app, bot)).toHaveLength(1);
    // A second group around the same anchor repeats the first container: refused.
    time.advance(2 * DAY);
    for (const name of ['己一', '己二', '己三', '己四', '己五']) leaf(app, bot, name);
    expect(normalizeTerm('甲项目')).toBe(normalizeTerm('甲 项目'));
    script.create = () => ({ anchor: '甲 项目', name: '另一个', aliases: [], summary: 's', overview: 'o', members: ['己一', '己二', '己三'].map((title) => String(app.store.get("SELECT id FROM assistant_memories WHERE title=? AND kind='topic'", title)!.id)) });
    // (The leaf named after the project joined it in between, so its overview is also rewritten: two calls.)
    expect(await organize(f)).toBe(2); expect(calls(chat, CREATE)).toHaveLength(3); expect(calls(chat, REWRITE)).toHaveLength(1);
    expect(containers(app, bot)).toHaveLength(1);
  }, 90000);

  it('reads the time of the original message, falls back to the own time of a fact only with a quiet period of 14 days, and never goes above ten containers', async () => {
    const f = await fixture(), { app, bot } = f;
    await ready(f); const time = clock();
    const done = Number(app.store.get("SELECT completed_at FROM assistant_memory_migrations WHERE bot_id=?", bot)!.completed_at);
    // The originals of a fact are gone: its own time is used, and that is no evidence of recurrence this early.
    const lost = leaf(app, bot, '庚一');
    const message = app.store.get('SELECT id FROM agent_messages WHERE bot_id=? ORDER BY seq DESC LIMIT 1', bot)!;
    app.store.run("UPDATE agent_messages SET content='[已遗忘]' WHERE id=?", message.id);
    const times = tree(app).times(bot, [lost.key]);
    expect(times.fellBack).toBe(true);
    // Real sources resolve to the time of the original message, not to the time of the fact.
    const real = leaf(app, bot, '庚二', { days: [-40, -3] });
    const resolved = tree(app).times(bot, [real.key]);
    expect(resolved.fellBack).toBe(false); expect(resolved.first).toBe(Date.now() - 40 * DAY); expect(resolved.last).toBe(Date.now() - 3 * DAY);
    const quiet = (at: number) => { time.set(at); return (tree(app) as unknown as { quiet(botId: string, times: unknown): boolean }).quiet(bot, times); };
    expect(quiet(done + DAY)).toBe(true); expect(quiet(done + 15 * DAY)).toBe(false);
    time.set(done + DAY); expect((tree(app) as unknown as { quiet(botId: string, times: unknown): boolean }).quiet(bot, resolved)).toBe(false);

    // Ten containers: the limit holds, and a new group is not even asked for.
    const g = await fixture(); await ready(g);
    clock();
    for (let n = 0; n < CONTAINER_LIMIT; n++) {
      const kids = [1, 2, 3].map((k) => leaf(g.app, g.bot, `组${n}-${k}`).key);
      tree(g.app).run(g.bot, { op: 'group', topics: kids, name: `组${n}`, anchor: `对象${n}号` });
    }
    expect(containers(g.app, g.bot)).toHaveLength(CONTAINER_LIMIT);
    for (const name of ['辛一', '辛二', '辛三', '辛四', '辛五']) leaf(g.app, g.bot, name);
    await organize(g); expect(calls(g.chat, CREATE)).toHaveLength(0);
    expect(() => tree(g.app).run(g.bot, { op: 'group', topics: ['辛一', '辛二', '辛三'].map((title) => String(g.app.store.get("SELECT id FROM assistant_memories WHERE title=? AND kind='topic'", title)!.id)), name: '多一个', anchor: '对象十一号' })).toThrow(/上限/);
  }, 120000);
});

// ---- helpers for the rest ----------------------------------------------------------------------------------------

/** A container the owner made over `count` fresh leaves named `${name}1..`; returns its id and the leaves. */
function made(f: Fixture, name: string, anchor: string, count = 3, opts: { body?: (n: number) => string; days?: number[]; kind?: string } = {}) {
  const leaves = Array.from({ length: count }, (_, n) => leaf(f.app, f.bot, `${name}${n + 1}`, { days: opts.days, body: opts.body?.(n + 1), kind: opts.kind }));
  const result = tree(f.app).run(f.bot, { op: 'group', topics: leaves.map((one) => one.key), name, anchor }) as { created: string };
  return { key: result.created, leaves };
}
/** A conversation with one task, for messages that belong to an episode (the foreign keys to sessions are not needed here). */
function conversation(app: App, bot: string) {
  const conv = 'conv-' + id(), task = 'task-' + id();
  app.store.db.exec('PRAGMA foreign_keys=OFF');
  app.store.run("INSERT INTO conversations(id,workspace_id,owner_user_id,bot_id,title,status,created_at) VALUES(?,?,?,?,?,'open',?)", conv, app.store.workspace, app.store.owner, bot, '合成会话', Date.now());
  app.store.run("INSERT INTO tasks(id,workspace_id,owner_user_id,conversation_id,bot_id,initiated_by_session_id,authorized_session_id,objective,status,legacy_max_model_calls,legacy_max_tool_calls,legacy_token_budget,legacy_deadline_at,created_at,ended_at) VALUES(?,?,?,?,?,'s','s','合成','succeeded',1,1,1,?,?,?)", task, app.store.workspace, app.store.owner, conv, bot, Date.now() + DAY, Date.now(), Date.now());
  app.store.db.exec('PRAGMA foreign_keys=ON');
  return { conv, task };
}
function episode(app: App, bot: string, conv: string, title: string, brief: string, from = -10, to = 0) {
  const key = new Episodes(app.store).save({ botId: bot, conversationId: conv, firstEntry: 'a' + id(), lastEntry: 'b' + id(), startedAt: Date.now() + from * DAY, endedAt: Date.now() + to * DAY, archive: { title, brief, topics: [], decisions: [], operations: [], openItems: [], refs: [] } });
  settle(app, bot);
  return key;
}
const members = (app: App, kind: string, ref: string) => app.store.all('SELECT topic_id FROM assistant_topic_members WHERE kind=? AND ref_id=? ORDER BY rowid', kind, ref).map((row) => String(row.topic_id));
const scans = (app: App) => Number(app.store.get('SELECT COUNT(*) n FROM assistant_topic_member_scan')!.n);
const embedAll = (f: Fixture) => personal(f.app).embedPending(personal(f.app).settings(f.bot), new AbortController().signal);

describe('members of a leaf', () => {
  it('gives an archive to the leaves that at least two of its facts rest on, three at most, and not to leaves with one fact or facts outside its range', async () => {
    const f = await fixture(), { app, bot } = f;
    await ready(f); clock();
    const { conv, task } = conversation(app, bot), other = conversation(app, bot);
    const a = leaf(app, bot, '甲', { task, days: [-5, -4, -3] }), b = leaf(app, bot, '乙', { task, days: [-5, -4] }), c = leaf(app, bot, '丙', { task, days: [-5] });
    const d = leaf(app, bot, '丁', { task, days: [-3, -2] }), e = leaf(app, bot, '戊', { task, days: [-2, -1] });
    const outside = leaf(app, bot, '己', { task, days: [-40, -39] }), elsewhere = leaf(app, bot, '庚', { task: other.task, days: [-5, -4] });
    const archive = episode(app, bot, conv, '一段对话', '讨论');
    expect(scans(app)).toBe(0);
    await organize(f);
    const got = members(app, 'episode', archive);
    expect(got).toHaveLength(3); expect(got).toContain(a.key);
    for (const bad of [c, outside, elsewhere]) expect(got).not.toContain(bad.key);
    expect(new Set(got).size).toBe(3); expect([b.key, d.key, e.key].filter((key) => got.includes(key))).toHaveLength(2);
    expect(scans(app)).toBe(1);
    // Judged once: a membership removed by hand is not made again, and nothing is called to do it.
    app.store.run('DELETE FROM assistant_topic_members WHERE ref_id=?', archive);
    await organize(f); expect(members(app, 'episode', archive)).toEqual([]);
  }, 60000);

  it('falls back to the vector only when it points clearly at one leaf, and lets an archive wait until its vector exists', async () => {
    const f = await fixture(), { app, bot, fake } = f;
    await embeddingOn(app, fake); await ready(f); clock();
    const coffee = leaf(app, bot, '咖啡偏好'), meeting = leaf(app, bot, '会议习惯'), d1 = leaf(app, bot, '部署甲'), d2 = leaf(app, bot, '部署乙');
    const e1 = episode(app, bot, 'c-1', '喝咖啡', '拿铁咖啡'), e2 = episode(app, bot, 'c-2', '发布', '上线部署发布'), e3 = episode(app, bot, 'c-3', '天气', '今天下雨');
    const doc = app.runtime.memory.write(bot, { title: '咖啡手册', content: '咖啡豆与拿铁' }).documentId as string;
    // No vectors yet: nothing can be judged, so nothing is recorded.
    await organize(f); expect(scans(app)).toBe(0);
    await embedAll(f);
    await organize(f);
    expect(members(app, 'episode', e1)).toEqual([coffee.key]);
    // Two leaves are as close as each other: no member, and the archive is not judged again.
    expect(members(app, 'episode', e2)).toEqual([]); expect(members(app, 'episode', e3)).toEqual([]);
    expect(members(app, 'document', doc)).toEqual([coffee.key]);
    expect(scans(app)).toBe(4);
    expect([meeting.key, d1.key, d2.key].some((key) => members(app, 'episode', e1).includes(key))).toBe(false);
  }, 60000);

  it('takes at most 200 items a pass and records only what it judged', async () => {
    const f = await fixture(), { app, bot, fake } = f;
    await embeddingOn(app, fake); await ready(f); clock();
    leaf(app, bot, '咖啡偏好');
    for (let n = 0; n < 205; n++) app.runtime.memory.write(bot, { title: `咖啡手册${n}`, content: '咖啡豆' });
    await embedAll(f); await embedAll(f);
    await organize(f); expect(scans(app)).toBe(200);
    await organize(f); expect(scans(app)).toBe(205);
  }, 90000);
});

describe('joining and inheriting', () => {
  it('puts a leaf into the container it names, or is clearly closest to, without a model call, and leaves the ambiguous and the owner\'s placements alone', async () => {
    const f = await fixture(), { app, bot, fake, chat } = f;
    await embeddingOn(app, fake); await ready(f); clock();
    const coffee = made(f, '咖啡', '咖啡馆'), deploy = made(f, '部署', '发布线');
    const named = leaf(app, bot, '咖啡馆的新菜单'), closest = leaf(app, bot, '拿铁豆'), both = leaf(app, bot, '咖啡部署'), plain = leaf(app, bot, '旅行计划');
    // Named by the anchor of two containers is no placement.
    const twice = leaf(app, bot, '咖啡馆与发布线');
    await embedAll(f);
    await organize(f);
    expect(meta(app, named.key).parent_id).toBe(coffee.key); expect(meta(app, closest.key).parent_id).toBe(coffee.key);
    expect(meta(app, both.key).parent_id).toBeNull(); expect(meta(app, plain.key).parent_id).toBeNull(); expect(meta(app, twice.key).parent_id).toBeNull();
    expect(moves(app, bot, 'contain').map((move) => JSON.parse(String(move.after_json)).via).sort()).toEqual(['name', 'vector']);
    void deploy;
    // The owner moved a topic to the top level: it stays there, though it names a container.
    tree(app).run(bot, { op: 'move', topic: named.key }); expect(meta(app, named.key)).toMatchObject({ parent_id: null, placed_by: 'owner' });
    await organize(f); expect(meta(app, named.key).parent_id).toBeNull();
    expect(calls(chat, CREATE)).toHaveLength(0);
  }, 60000);

  it('puts a sub-topic split off a topic into the same container, and the merge records where it came from', async () => {
    const f = await fixture(), { app, bot } = f;
    await ready(f); clock();
    const body = '甲项目发布流程说明文档';
    // Topics of facts: the merge promotes them (and their container) to user topics before it looks for the one a new fact belongs to.
    const group = made(f, '甲项目', '甲项目对象', 3, { body: () => body, kind: 'fact' });
    // The merge splits the new facts into the topic and a sub-topic.
    f.script.merge = (input) => { const ids = input.facts.map((fact) => fact.id); return { topics: [{ id: input.topic!.id, title: input.topic!.title, summary: '主', body, facts: [ids[0]] }, { title: '拆出的子主题', summary: '子', body: '子正文', facts: ids.slice(1) }] }; };
    app.agents.publish(bot, 'user', 'message', '记住：' + body, 'a-' + id()); app.agents.publish(bot, 'user', 'message', '记住：' + body + '。', 'b-' + id());
    await pump(app);
    const sub = app.store.get("SELECT id FROM assistant_memories WHERE title='拆出的子主题'")!;
    expect(sub).toBeTruthy();
    // The merge ran with the origin by BM25; if it joined another topic of the group, inheritance still follows that topic.
    expect(meta(app, String(sub.id)).parent_id).toBe(group.key); expect(meta(app, String(sub.id)).split_from).toBeNull();
    expect(moves(app, bot, 'contain').some((move) => JSON.parse(String(move.after_json)).via === 'split')).toBe(true);
  }, 60000);
});

describe('merging and dissolving', () => {
  it('merges two containers with the same anchor or a shared alias into the older one, never one the owner made, and the move can be reverted', async () => {
    const f = await fixture(), { app, bot } = f;
    await ready(f); clock();
    const a = made(f, '甲', '甲对象'), b = made(f, '乙', '乙对象'), c = made(f, '丙', '丙对象'), d = made(f, '丁', '丁对象');
    // As the model's creation and rewrites leave them: automatic placements, one sharing an alias with another's anchor.
    app.store.run("UPDATE assistant_topics SET placed_by='auto' WHERE topic_id IN (?,?)", a.key, b.key);
    app.store.run("UPDATE assistant_topics SET aliases_json=? WHERE topic_id=?", JSON.stringify(['甲 对象']), b.key);
    await organize(f);
    expect(containers(app, bot).map((row) => row.id)).toEqual([a.key, c.key, d.key]);
    expect(childrenOf(app, a.key)).toEqual([...a.leaves, ...b.leaves].map((one) => one.key));
    expect(JSON.parse(String(meta(app, a.key).aliases_json))).toEqual(['乙对象']);
    const [merge] = moves(app, bot, 'merge'); expect(merge).toMatchObject({ topic_id: a.key, actor: 'auto' });
    // Reverted: the folded container is back with its children.
    tree(app).run(bot, { op: 'revert', moveId: merge.id });
    expect(containers(app, bot).map((row) => row.id).sort()).toEqual([a.key, b.key, c.key, d.key].sort());
    expect(childrenOf(app, b.key)).toEqual(b.leaves.map((one) => one.key)); expect(childrenOf(app, a.key)).toEqual(a.leaves.map((one) => one.key));
    expect(JSON.parse(String(meta(app, a.key).aliases_json))).toEqual([]);
    expect(() => tree(app).run(bot, { op: 'revert', moveId: merge.id })).toThrow(/已撤销/);
    // The owner's containers (c, d) are not merged by background work even with the same anchor.
    app.store.run("UPDATE assistant_topics SET anchor='丙对象' WHERE topic_id=?", d.key);
    await organize(f); expect(containers(app, bot)).toHaveLength(4);
  }, 60000);

  it('dissolves a container below two children, keeps its record, and brings it back on revert', async () => {
    const f = await fixture(), { app, bot } = f;
    await ready(f); clock();
    const g = made(f, '甲', '甲对象');
    // Two of the three children lose their originals.
    for (const one of g.leaves.slice(0, 2)) app.store.run("UPDATE agent_messages SET content='[已遗忘]' WHERE id=?", one.refs[0].id);
    expect(personal(app).topics.topics(bot).map((row) => row.id)).not.toContain(g.key);
    await organize(f);
    expect(containers(app, bot)).toHaveLength(0);
    expect(meta(app, g.leaves[2].key).parent_id).toBeNull();
    const [dissolve] = moves(app, bot, 'dissolve'); expect(dissolve).toMatchObject({ topic_id: g.key, actor: 'auto' });
    expect(app.store.get('SELECT status FROM assistant_memories WHERE id=?', g.key)).toMatchObject({ status: 'retired' });
    // Revert brings the container back.
    tree(app).run(bot, { op: 'revert', moveId: dissolve.id });
    expect(app.store.get('SELECT status FROM assistant_memories WHERE id=?', g.key)).toMatchObject({ status: 'active' });
  }, 60000);
});

describe('overviews', () => {
  it('does not call the model when a leaf gains an archive, rewrites on the cadence and never twice in 24 hours', async () => {
    const f = await fixture(), { app, bot, chat } = f;
    await ready(f); const time = clock();
    project(f);
    await organize(f);
    const [container] = containers(app, bot), key = String(container.id);
    expect(calls(chat, REWRITE)).toHaveLength(0);
    // A new archive for a child: membership of a leaf changes no overview.
    const archive = episode(app, bot, 'c-x', '一段', '讨论');
    app.store.run("INSERT INTO assistant_topic_members(topic_id,kind,ref_id,bot_id,placed_by,added_at) VALUES(?,?,?,?,'auto',?)", childrenOf(app, key)[0], 'episode', archive, bot, Date.now());
    time.advance(2 * DAY); expect(await organize(f)).toBe(0); expect(calls(chat, REWRITE)).toHaveLength(0);
    // Membership changes: the overview is rewritten once the day since its last writing is over, then not again for a day.
    leaf(app, bot, '甲项目新增一');
    expect(await organize(f)).toBe(1); expect(calls(chat, REWRITE)).toHaveLength(1);
    expect(meta(app, key)).toMatchObject({ overview_stale: 0 });
    expect(JSON.parse(String((calls(chat, REWRITE)[0].messages as Array<{ content: string }>).at(-1)!.content)).children.length).toBe(5);
    leaf(app, bot, '甲项目新增二');
    time.advance(23 * 3_600_000); expect(await organize(f)).toBe(0);
    time.advance(2 * 3_600_000); expect(await organize(f)).toBe(1); expect(calls(chat, REWRITE)).toHaveLength(2);
    // Three children that changed their own text are enough; so is one after a week.
    time.advance(2 * DAY);
    for (const child of childrenOf(app, key).slice(0, 3)) app.store.run('UPDATE assistant_memories SET updated_at=? WHERE id=?', Date.now(), child);
    expect(await organize(f)).toBe(1);
    time.advance(2 * DAY); app.store.run('UPDATE assistant_memories SET updated_at=? WHERE id=?', Date.now(), childrenOf(app, key)[0]);
    expect(await organize(f)).toBe(0);
    time.advance(6 * DAY); app.store.run('UPDATE assistant_memories SET updated_at=? WHERE id=?', Date.now(), childrenOf(app, key)[0]);
    expect(await organize(f)).toBe(1);
    expect(moves(app, bot, 'rename')).toHaveLength(0);
  }, 90000);

  it('makes at most three model calls a pass and no more than two overviews, and does nothing once the day\'s budget is spent', async () => {
    const f = await fixture(), { app, bot, chat } = f;
    await ready(f); clock();
    // Four owner-made containers wait for their first real overview, and five recurring new topics are ready to be judged.
    for (const n of [1, 2, 3, 4]) made(f, `组${n}`, `对象${n}号`);
    project(f);
    expect(await organize(f)).toBe(3);
    expect(calls(chat, CREATE)).toHaveLength(1); expect(calls(chat, REWRITE)).toHaveLength(2);
    expect(await organize(f)).toBe(2); expect(calls(chat, REWRITE)).toHaveLength(4);
    // Spent: the pass is skipped whole.
    app.store.run("INSERT INTO assistant_usage(id,bot_id,purpose,model,status,reserved_tokens,input_tokens,output_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?)", id(), bot, 'consolidate', 'fixture', 'succeeded', 10, 60000, 40000, Date.now());
    for (const name of ['癸一', '癸二', '癸三', '癸四', '癸五']) leaf(app, bot, name);
    const before = chat.requests.length;
    expect(await organize(f)).toBe(0); expect(chat.requests.length).toBe(before);
  }, 90000);

  it('runs as a step of the background pass, between the merge and the index, and waits for the migration', async () => {
    const f = await fixture(), { app, bot, chat } = f;
    enable(app, bot);
    // A topic written while the migration is not done: organize does nothing.
    expect(await organize(f)).toBe(0);
    await pump(app); clock();
    project(f);
    await pump(app);
    expect(containers(app, bot)).toHaveLength(1); expect(calls(chat, CREATE)).toHaveLength(1);
    // Its failures back off like those of any step, and are named after it.
    f.script.rewrite = () => ({ name: '' });
    leaf(app, bot, '甲项目新增一'); vi.setSystemTime(Date.now() + 2 * DAY);
    await pump(app);
    expect(app.store.get("SELECT failures FROM assistant_memory_steps WHERE bot_id=? AND step='organize'", bot)).toMatchObject({ failures: 1 });
    expect(String(personal(app).settings(bot).last_error)).toContain('organize');
    const requests = chat.requests.length; await pump(app); expect(chat.requests.length).toBe(requests);
  }, 90000);
});

// ---- the core memory index, opening a container, routing ------------------------------------------------------------

async function wait(check: () => boolean, app: App, limit = 25000) {
  const until = Date.now() + limit;
  while (!check()) {
    const failed = app.store.get("SELECT result_summary FROM tasks WHERE status='failed'"); if (failed) throw new Error(String(failed.result_summary));
    if (Date.now() > until) throw new Error('Fixture timeout: ' + JSON.stringify(app.store.all('SELECT status,result_summary FROM tasks')));
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
/** A whole turn of the assistant, on the real clock (the worker needs it). */
async function turn(app: App, bot: string, text: string, key: string) {
  const task = app.agents.send(bot, text, key).taskId;
  await wait(() => app.store.get('SELECT status FROM tasks WHERE id=?', task)?.status === 'succeeded', app); await wait(() => !app.runtime.workers.size, app);
  return task;
}

describe('core memory index', () => {
  it('shows a container as one line, drops the lines of its children on the next update, keeps a line edited by hand, and stays within 1500 tokens', async () => {
    const f = await fixture(), { app, bot } = f, indexer = personal(app).topics, core = app.runtime.memory.core;
    await ready(f); clock();
    const kids = ['甲一', '甲二', '甲三'].map((title) => leaf(app, bot, title)), solo = leaf(app, bot, '独立主题');
    for (let n = 0; n < 4; n++) indexer.indexTopics(bot);
    const refs = () => coreLines(app, bot).map((line) => line.ref);
    expect(new Set(refs())).toEqual(new Set([...kids, solo].map((one) => `memory:${one.key}`)));
    // The owner edits one line by hand.
    const edited = core.read('bot', bot);
    core.replace('bot', bot, { about: [], topics: edited.content.topics.map((line) => line.ref === `memory:${kids[1].key}` ? { ...line, title: '我改的标题' } : line) }, edited.version);
    const grouped = tree(app).run(bot, { op: 'group', topics: kids.map((one) => one.key), name: '甲项目', anchor: '甲项目对象', summary: '甲项目的一切' }) as { created: string };
    // The container's line is written at once (a new line fits); the children's go with it.
    expect(indexer.indexTopics(bot)).toBe(true);
    expect(new Set(refs())).toEqual(new Set([`memory:${kids[1].key}`, `memory:${solo.key}`, `memory:${grouped.created}`])); expect(refs()).toHaveLength(3);
    expect(refs()).not.toContain(`memory:${kids[0].key}`); expect(refs()).not.toContain(`memory:${kids[2].key}`);
    expect(coreLines(app, bot).find((line) => line.title === '我改的标题')).toBeTruthy();
    expect(app.runtime.memory.prompt(bot)).toContain(`- 甲项目 — 甲项目的一切 · 3 个子主题 (memory:${grouped.created})`);
    // Top-level leaves keep their lines as they were.
    expect(coreLines(app, bot).find((line) => line.ref === `memory:${solo.key}`)).toEqual({ title: '独立主题', line: '独立主题说明', ref: `memory:${solo.key}` });

    // Many topics and a container together: the cap holds, and the container's line outlasts the lines of unrecalled leaves.
    const g = await fixture(); await ready(g);
    const many = Array.from({ length: 40 }, (_, n) => leaf(g.app, g.bot, `主题${n}`, { days: [-1] }));
    for (const one of many) g.app.store.run('UPDATE assistant_topics SET summary=? WHERE topic_id=?', `这个主题的说明，${'内容细节'.repeat(25)}`, one.key);
    const indexer2 = personal(g.app).topics;
    for (let n = 0; n < 40; n++) indexer2.indexTopics(g.bot);
    const before = coreLines(g.app, g.bot).length;
    expect(before).toBeLessThan(40);
    const shown = new Set(coreLines(g.app, g.bot).map((line) => line.ref)), late = many.filter((one) => !shown.has(`memory:${one.key}`)).slice(0, 3);
    const box = tree(g.app).run(g.bot, { op: 'group', topics: late.map((one) => one.key), name: '后到的容器', anchor: '后到对象' }) as { created: string };
    g.app.store.run('UPDATE assistant_topic_state SET facts_since_patch=?,core_patched_at=0 WHERE bot_id=?', CORE_PATCH_FACTS, g.bot);
    expect(indexer2.indexTopics(g.bot)).toBe(true);
    expect(coreLines(g.app, g.bot).map((line) => line.ref)).toContain(`memory:${box.created}`);
    expect(tokens(g.app.runtime.memory.prompt(g.bot))).toBeLessThanOrEqual(CORE_MEMORY_TOKENS);
    for (const one of late) expect(coreLines(g.app, g.bot).map((line) => line.ref)).not.toContain(`memory:${one.key}`);
  }, 90000);

  it('opens a container with memory.search: the overview and at most 20 children, the most recalled first', async () => {
    const f = await fixture(), { app, bot } = f;
    await ready(f); clock();
    const kids = Array.from({ length: 25 }, (_, n) => leaf(app, bot, `子主题${n}`, { days: [-3] }));
    const grouped = tree(app).run(bot, { op: 'group', topics: kids.map((one) => one.key), name: '大容器', anchor: '大容器对象', summary: '很多子主题' }) as { created: string };
    for (let n = 0; n < 3; n++) app.store.run('INSERT INTO assistant_memory_uses VALUES(?,?)', 'task-' + n, kids[20].refs[0].id);
    const found = await app.runtime.memory.retrieval.retrieve(bot, `memory:${grouped.created}`);
    expect(found.candidates).toHaveLength(1);
    const text = found.candidates[0].text, lines = text.split('\n').filter((line) => line.startsWith('- ') && line.includes(' (memory:'));
    expect(lines).toHaveLength(20); expect(lines[0]).toBe(`- 子主题20 — 子主题20说明 (memory:${kids[20].key})`);
    expect(text).toContain('共 25 个'); expect(text.startsWith(String(containers(app, bot)[0].content))).toBe(true);
    // A leaf opens as it did.
    const leafFound = await app.runtime.memory.retrieval.retrieve(bot, `memory:${kids[0].key}`);
    expect(leafFound.candidates[0].text).toBe('子主题0正文');
  }, 60000);
});

describe('routing', () => {
  /** 25 archives about the same words; the one that belongs to a child of the container says them once, among other words. */
  function archives(app: App, bot: string, child: string) {
    for (let n = 0; n < 25; n++) episode(app, bot, 'c-' + n, `备份说明${n}`, '备份说明 备份说明 备份说明 备份说明 备份说明');
    const member = episode(app, bot, 'c-member', '成员档案', '成员标记 一段很长的其他内容 '.repeat(10) + '备份说明');
    app.store.run("INSERT INTO assistant_topic_members(topic_id,kind,ref_id,bot_id,placed_by,added_at) VALUES(?,?,?,?,'auto',?)", child, 'episode', member, bot, Date.now());
    return member;
  }
  const refsOf = (found: { candidates: Array<{ ref: string }> }) => found.candidates.map((item) => item.ref);

  it('lifts the archives of a container the prompt names into the first 20, leaves an unrelated prompt as it was, and records the routing', async () => {
    const f = await fixture(), { app, bot } = f;
    await ready(f); clock();
    const kids = ['一', '二', '三'].map((title) => leaf(app, bot, `子${title}`));
    const member = archives(app, bot, kids[0].key);
    const retrieval = app.runtime.memory.retrieval, query = 'nexbot 备份说明', unrelated = '今天的天气和旅行机票';
    const without = await retrieval.retrieve(bot, query), unrelatedWithout = await retrieval.retrieve(bot, unrelated);
    expect(refsOf(without)).not.toContain(`episode:${member}`); expect(without.routed).toBeUndefined();
    const grouped = tree(app).run(bot, { op: 'group', topics: kids.map((one) => one.key), name: '项目', anchor: '项目对象', aliases: ['nexbot'] }) as { created: string };
    const lifted = await retrieval.retrieve(bot, query);
    expect(refsOf(lifted)).toContain(`episode:${member}`); expect(lifted.routed).toEqual([grouped.created]);
    expect(lifted.candidates.find((item) => item.ref === `episode:${member}`)!.sources).toEqual(expect.arrayContaining(['bm25', 'topic']));
    expect(lifted.candidates).toHaveLength(20);
    // Not routed: byte for byte what it was without the container.
    const unrelatedWith = await retrieval.retrieve(bot, unrelated);
    expect(JSON.stringify(unrelatedWith)).toBe(JSON.stringify(unrelatedWithout)); expect(unrelatedWith.routed).toBeUndefined();
    // Only what was found gets the bonus: a member that matches nothing is not added.
    app.store.run("INSERT INTO assistant_topic_members(topic_id,kind,ref_id,bot_id,placed_by,added_at) VALUES(?,?,?,?,'auto',?)", kids[1].key, 'episode', episode(app, bot, 'c-quiet', '完全无关', '咖啡'), bot, Date.now());
    expect(refsOf(await retrieval.retrieve(bot, query)).length).toBe(20);
  }, 60000);

  it('leaves the last word to the reranker: a lifted archive scored under 0.3 does not appear', async () => {
    const f = await fixture(), { app, bot, fake } = f;
    await ready(f); clock();
    const kids = ['一', '二', '三'].map((title) => leaf(app, bot, `子${title}`));
    const member = archives(app, bot, kids[0].key);
    tree(app).run(bot, { op: 'group', topics: kids.map((one) => one.key), name: '项目', anchor: '项目对象', aliases: ['nexbot'] });
    const config = app.runtime.memory.retrieval.config;
    await config.save({ kind: 'rerank', format: 'cohere', baseUrl: fake.origin, model: 'fake-rerank', enabled: true, version: config.view().rerank.version });
    fake.state.scores = (_query, documents) => documents.map((document) => document.includes('成员标记') ? 0.1 : 0.9);
    const low = await app.runtime.memory.retrieval.retrieve(bot, 'nexbot 备份说明');
    expect(low.reranked).toBe(true); expect(refsOf(low)).not.toContain(`episode:${member}`);
    fake.state.scores = (_query, documents) => documents.map((document) => document.includes('成员标记') ? 0.95 : 0.9);
    const high = await app.runtime.memory.retrieval.retrieve(bot, 'NexBot 备份说明');
    expect(refsOf(high)[0]).toBe(`episode:${member}`);
  }, 60000);

  it('routes by the centre of the children when the prompt names nothing, ahead of the second by a margin, and stores the routing with the task', async () => {
    const f = await fixture(), { app, bot, fake } = f;
    await embeddingOn(app, fake); await ready(f);
    app.runtime.maintenanceIdle = 3_600_000;
    const coffee = ['咖啡一', '咖啡二', '咖啡三'].map((title) => leaf(app, bot, title, { days: [-3] })), deploy = ['部署一', '部署二', '部署三'].map((title) => leaf(app, bot, title, { days: [-3] }));
    leaf(app, bot, '拿铁豆产地', { days: [-3] });
    const a = tree(app).run(bot, { op: 'group', topics: coffee.map((one) => one.key), name: '饮品', anchor: '饮品对象' }) as { created: string };
    tree(app).run(bot, { op: 'group', topics: deploy.map((one) => one.key), name: '上线', anchor: '上线对象' });
    await embedAll(f); await embedAll(f);
    const route = (query: string) => tree(app).route(bot, query, Float32Array.from([0, 0, 1, 0, 0, 0, 0, 0.01]));
    // A query about coffee (the vector of the fake service puts it on the coffee axis only).
    expect(route('拿铁怎么选')?.topics).toEqual([a.created]);
    // On the axes of both containers equally: no margin, no routing.
    expect(tree(app).route(bot, '拿铁怎么选', Float32Array.from([1, 0, 1, 0, 0, 0, 0, 0.01]))).toBeUndefined();
    expect(tree(app).route(bot, '拿铁怎么选', Float32Array.from([0, 1, 0, 0, 0, 0, 0, 0.01]))).toBeUndefined();
    // The task keeps what the recall was routed to.
    const task = await turn(app, bot, '帮我看看拿铁咖啡的选择', 'route-1');
    expect(JSON.parse(String(app.store.get('SELECT topic_ids FROM task_recall WHERE task_id=?', task)!.topic_ids))).toEqual([a.created]);
    const other = await turn(app, bot, '今天天气怎么样呢', 'route-2');
    expect(JSON.parse(String(app.store.get('SELECT topic_ids FROM task_recall WHERE task_id=?', other)!.topic_ids))).toEqual([]);
  }, 90000);
});

// ---- the vector cache -------------------------------------------------------------------------------------------------------

describe('vector cache', () => {
  /** Deterministic pseudo-random vectors. */
  const random = (seed: number, dims: number) => { const out = new Float32Array(dims); let x = seed * 2654435761 % 4294967296; for (let i = 0; i < dims; i++) { x = (x * 1664525 + 1013904223) % 4294967296; out[i] = x / 4294967296 - 0.5; } return out; };
  function populate(f: Fixture, count: number, bot = f.bot) {
    const rows: Array<{ key: string; hash: string }> = [];
    for (let n = 0; n < count; n++) {
      const content = `内容${++counter}`, source = 'vc-' + id();
      f.app.agents.publish(bot, 'user', 'message', content, source);
      const message = f.app.store.get('SELECT id FROM agent_messages WHERE source_key=?', source)!, key = personal(f.app).put(bot, 'fact', `事实${n}`, content, [{ id: String(message.id), hash: hash(content) }]);
      rows.push({ key, hash: hash(key) });
      storeVector(f.app.store, { kind: 'memory', refId: key, hash: hash(key) }, 'm', random(counter, 8), Date.now(), bot);
    }
    return rows;
  }
  /** The scan the cache replaced: every vector read from the rows, scored, sorted. */
  function reference(app: App, bot: string, query: Float32Array) {
    const scored = vectorRows(app.store, 'memory', bot, 'm', query.length).flatMap((row) => { const vector = unpackVector(row.vector, query.length); if (!vector) return []; let similarity = 0; for (let i = 0; i < vector.length; i++) similarity += vector[i] * query[i]; return [{ kind: 'memory' as const, refId: String(row.ref_id), similarity, hash: String(row.content_hash) }]; });
    return scored.sort((a, b) => b.similarity - a.similarity);
  }

  it('gives the same first 50 as the scan of the rows, is rebuilt after a write or a delete, and is per assistant', async () => {
    const f = await fixture(), { app, bot } = f;
    const other = app.store.createBot('另一个助手');
    const rows = populate(f, 60), query = random(999, 8);
    populate(f, 12, other);
    const cache = new VectorCache(1 << 26, 10);
    expect(cache.scan(app.store, ['memory'], bot, 'm', query).slice(0, 50)).toEqual(reference(app, bot, query).slice(0, 50));
    expect(cache.has(bot, 'm', 8, 'memory')).toBe(true);
    // The global cache of the store is the one the writes tell.
    const shared = vectorCache(app.store);
    shared.minimum = 10;
    expect(shared.scan(app.store, ['memory'], bot, 'm', query).slice(0, 50)).toEqual(reference(app, bot, query).slice(0, 50));
    expect(shared.has(bot, 'm', 8, 'memory')).toBe(true);
    shared.scan(app.store, ['memory'], other, 'm', query); expect(shared.has(other, 'm', 8, 'memory')).toBe(true);
    // A write to this assistant's vectors makes its entry stale and leaves the other assistant's alone.
    storeVector(app.store, { kind: 'memory', refId: rows[0].key, hash: rows[0].hash }, 'm', random(5000, 8), Date.now(), bot);
    expect(shared.has(bot, 'm', 8, 'memory')).toBe(false); expect(shared.has(other, 'm', 8, 'memory')).toBe(true);
    expect(shared.scan(app.store, ['memory'], bot, 'm', query).slice(0, 50)).toEqual(reference(app, bot, query).slice(0, 50));
    // A delete does the same.
    dropVectors(app.store, 'memory', rows[1].key, rows[2].key);
    expect(shared.has(bot, 'm', 8, 'memory')).toBe(false);
    const after = shared.scan(app.store, ['memory'], bot, 'm', query);
    expect(after).toHaveLength(58); expect(after.slice(0, 50)).toEqual(reference(app, bot, query).slice(0, 50));
    expect(after.some((item) => item.refId === rows[1].key)).toBe(false);
    // Below the threshold nothing is kept.
    shared.minimum = 1000; shared.drop(bot); shared.scan(app.store, ['memory'], bot, 'm', query);
    expect(shared.has(bot, 'm', 8, 'memory')).toBe(false);
  }, 60000);

  it('keeps all entries under the cap, dropping the least recently used assistant', async () => {
    const f = await fixture(), { app, bot } = f;
    const other = app.store.createBot('另一个助手');
    populate(f, 40); populate(f, 40, other);
    const query = random(7, 8), cache = new VectorCache(12_000, 1);
    cache.scan(app.store, ['memory'], bot, 'm', query); cache.scan(app.store, ['memory'], other, 'm', query);
    expect(cache.has(bot, 'm', 8, 'memory')).toBe(false); expect(cache.has(other, 'm', 8, 'memory')).toBe(true); expect(cache.bytes).toBeLessThanOrEqual(12_000);
    cache.scan(app.store, ['memory'], bot, 'm', query);
    expect(cache.has(bot, 'm', 8, 'memory')).toBe(true); expect(cache.has(other, 'm', 8, 'memory')).toBe(false); expect(cache.bytes).toBeLessThanOrEqual(12_000);
    // An assistant larger than the whole cache is not kept, and still answers.
    const tiny = new VectorCache(1000, 1);
    expect(tiny.scan(app.store, ['memory'], bot, 'm', query).slice(0, 50)).toEqual(reference(app, bot, query).slice(0, 50)); expect(tiny.bytes).toBe(0);
    // A model or width never seen has its own entry.
    expect(cache.scan(app.store, ['memory'], bot, 'other-model', query)).toEqual([]);
  }, 60000);

  it('changes nothing in what retrieval returns when it is on', async () => {
    const f = await fixture(), { app, bot, fake } = f;
    await embeddingOn(app, fake); await ready(f);
    for (const title of ['咖啡偏好', '会议习惯', '部署流程', '旅行计划', '数据库选择']) leaf(app, bot, title, { days: [-3] });
    await embedAll(f);
    const shared = vectorCache(app.store), run = async () => JSON.stringify(await Promise.all(['拿铁咖啡', '上线部署', '日程会议', '今天下雨'].map((query) => app.runtime.memory.retrieval.retrieve(bot, query))));
    shared.minimum = Number.MAX_SAFE_INTEGER; const off = await run();
    shared.minimum = 1; shared.drop(bot); const on = await run();
    expect(on).toBe(off); expect(shared.has(bot, 'fake-embed', 8, 'memory')).toBe(true);
    shared.minimum = 2000;
  }, 60000);
});

// ---- forgetting ----------------------------------------------------------------------------------------------------------------

describe('forgetting', () => {
  it('takes a forgotten topic out of its container, shows the container as pending until it is rewritten, and loses its index line and records', async () => {
    const f = await fixture(), { app, bot } = f;
    await ready(f); clock();
    const g = made(f, '普通', '普通对象', 4, { body: (n) => n === 4 ? '正文含ZZTOP' : `普通${n}正文` });
    const indexer = personal(app).topics;
    expect(indexer.indexTopics(bot)).toBe(true);
    expect(coreLines(app, bot).map((line) => line.ref)).toContain(`memory:${g.key}`);
    expect(moves(app, bot, 'create')).toHaveLength(1);
    const plan = app.runtime.memory.privacy.preview(bot, { query: 'zztop' });
    expect(plan.memories).toEqual([g.leaves[3].key]);
    app.runtime.memory.forget(bot, { query: 'zztop' }, plan.revision);
    expect(app.store.get('SELECT id FROM assistant_memories WHERE id=?', g.leaves[3].key)).toBeUndefined();
    expect(childrenOf(app, g.key)).toEqual(g.leaves.slice(0, 3).map((one) => one.key));
    expect(app.store.get('SELECT title,content FROM assistant_memories WHERE id=?', g.key)).toEqual({ title: PENDING_TITLE, content: '' });
    expect(meta(app, g.key).overview_stale).toBe(2);
    expect(coreLines(app, bot).map((line) => line.ref)).not.toContain(`memory:${g.key}`);
    expect(moves(app, bot)).toHaveLength(0);
    expect(app.store.get("SELECT COUNT(*) n FROM memory_vectors WHERE ref_id=?", g.key)!.n).toBe(0);
    // The next pass writes the overview from what is left, whatever the age of the last one.
    f.script.rewrite = (input) => ({ name: '普通', aliases: [], summary: '三个子主题', overview: input.children.map((child) => child.title).join('；') });
    expect(await organize(f)).toBe(1);
    expect(app.store.get('SELECT title,content FROM assistant_memories WHERE id=?', g.key)).toEqual({ title: '普通', content: '普通1；普通2；普通3' });
    expect(meta(app, g.key).overview_stale).toBe(0);
    expect(JSON.stringify(app.store.all('SELECT content FROM assistant_memories'))).not.toContain('ZZTOP');
  }, 60000);

  it('dissolves a container left with fewer than two topics, whole: its row, its line and its records', async () => {
    const f = await fixture(), { app, bot } = f;
    await ready(f); clock();
    const g = made(f, '普通', '普通对象', 3, { body: (n) => n >= 2 ? '正文含ZZTOP' : '普通1正文' });
    personal(app).topics.indexTopics(bot);
    const plan = app.runtime.memory.privacy.preview(bot, { query: 'zztop' });
    app.runtime.memory.forget(bot, { query: 'zztop' }, plan.revision);
    expect(app.store.get('SELECT id FROM assistant_memories WHERE id=?', g.key)).toBeUndefined(); expect(meta(app, g.key)).toBeUndefined();
    expect(meta(app, g.leaves[0].key)).toMatchObject({ parent_id: null, role: 'leaf' });
    expect(coreLines(app, bot).map((line) => line.ref)).not.toContain(`memory:${g.key}`);
    expect(moves(app, bot)).toHaveLength(0);
    expect(personal(app).topics.topics(bot).map((row) => row.id)).toEqual([g.leaves[0].key]);
  }, 60000);

  it('removes the containers, members, moves and cached vectors of a whole assistant when its conversations are forgotten, and leaves the other topics at the top', async () => {
    const f = await fixture(), { app, bot, fake } = f;
    await embeddingOn(app, fake); await ready(f); clock();
    const g = made(f, '普通', '普通对象', 3), secret = leaf(app, bot, 'SECRET-B项');
    const archive = episode(app, bot, 'c-1', '咖啡', '咖啡');
    app.store.run("INSERT INTO assistant_topic_members(topic_id,kind,ref_id,bot_id,placed_by,added_at) VALUES(?,?,?,?,'auto',?)", g.leaves[0].key, 'episode', archive, bot, Date.now());
    app.store.run("INSERT INTO assistant_topic_member_scan(bot_id,kind,ref_id,scanned_at) VALUES(?,?,?,?)", bot, 'episode', archive, Date.now());
    await embedAll(f);
    const shared = vectorCache(app.store); shared.minimum = 1;
    await app.runtime.memory.retrieval.retrieve(bot, '咖啡');
    expect(shared.has(bot, 'fake-embed', 8, 'memory')).toBe(true); expect(moves(app, bot).length).toBeGreaterThan(0);
    const plan = app.runtime.memory.privacy.preview(bot, { query: 'secret-b' });
    expect(plan.bots).toEqual([bot]);
    app.runtime.memory.forget(bot, { query: 'secret-b' }, plan.revision);
    expect(containers(app, bot)).toHaveLength(0);
    expect(app.store.get('SELECT id FROM assistant_memories WHERE id=?', g.key)).toBeUndefined();
    for (const table of ['assistant_topic_members', 'assistant_topic_member_scan', 'assistant_topic_moves']) expect(app.store.get(`SELECT COUNT(*) n FROM ${table}`)!.n).toBe(0);
    expect(shared.has(bot, 'fake-embed', 8, 'memory')).toBe(false);
    expect(app.store.get('SELECT id FROM assistant_memories WHERE id=?', secret.key)).toBeUndefined();
  }, 60000);

  it('forgets the membership and scan record of an archive or a document that is removed', async () => {
    const f = await fixture(), { app, bot } = f;
    await ready(f); clock();
    const topic = leaf(app, bot, '甲'), archive = episode(app, bot, 'c-1', '一段', '讨论');
    const document = app.runtime.memory.write(bot, { title: '手册', content: '内容' });
    for (const [kind, ref] of [['episode', archive], ['document', document.documentId as string]]) {
      app.store.run("INSERT INTO assistant_topic_members(topic_id,kind,ref_id,bot_id,placed_by,added_at) VALUES(?,?,?,?,'auto',?)", topic.key, kind, ref, bot, Date.now());
      app.store.run("INSERT INTO assistant_topic_member_scan(bot_id,kind,ref_id,scanned_at) VALUES(?,?,?,?)", bot, kind, ref, Date.now());
    }
    new Episodes(app.store).remove(archive);
    expect(members(app, 'episode', archive)).toEqual([]); expect(scans(app)).toBe(1);
    app.runtime.memory.remove(document.documentId as string, Number(document.version));
    expect(members(app, 'document', document.documentId as string)).toEqual([]); expect(scans(app)).toBe(0);
  }, 60000);
});

// ---- the tool ----------------------------------------------------------------------------------------------------------------------

describe('memory.topic', () => {
  it('lists the tree, groups top-level topics around an anchor, moves, renames and merges them as the owner, and refuses what the rules refuse', async () => {
    const f = await fixture(), { app, bot } = f;
    await ready(f); clock();
    const run = (args: Record<string, unknown>) => tree(app).run(bot, args) as Record<string, unknown>;
    const [a, b, c, d, e] = ['甲', '乙', '丙', '丁', '戊'].map((title) => leaf(app, bot, `${title}主题`)), keys = [a, b, c].map((one) => one.key);
    expect(run({ op: 'tree' })).toMatchObject({ containers: [], topics: expect.arrayContaining([{ id: a.key, title: '甲主题' }]) });
    expect(() => run({ op: 'group', topics: keys, name: '项目' })).toThrow(/锚点/);
    expect(() => run({ op: 'group', topics: keys.slice(0, 2), name: '项目', anchor: '项目对象' })).toThrow(/至少/);
    expect(() => run({ op: 'group', topics: [...keys, 'nope'], name: '项目', anchor: '项目对象' })).toThrow(/不存在/);
    const grouped = run({ op: 'group', topics: keys, name: '项目', anchor: '项目对象', aliases: ['proj'] }).created as string;
    expect(containers(app, bot)[0]).toMatchObject({ title: '项目', anchor: '项目对象', placed_by: 'owner', overview_stale: 1 });
    expect(moves(app, bot, 'create')[0]).toMatchObject({ actor: 'model' });
    expect(meta(app, a.key)).toMatchObject({ parent_id: grouped, placed_by: 'owner' });
    expect(() => run({ op: 'group', topics: keys, name: '另一个', anchor: '另一个对象' })).toThrow(/已在容器/);
    expect(() => run({ op: 'group', topics: [d.key, e.key, leaf(app, bot, '己主题').key], name: '又一个', anchor: '项目对象' })).toThrow(/相同的名称/);
    expect(run({ op: 'tree' })).toMatchObject({ containers: [{ id: grouped, name: '项目', anchor: '项目对象', aliases: ['proj'], by: 'owner', children: [{ id: a.key }, { id: b.key }, { id: c.key }] }] });
    // Moves in and out; a container below two children is taken down at once.
    run({ op: 'move', topic: d.key, to: grouped }); expect(childrenOf(app, grouped)).toHaveLength(4); expect(moves(app, bot, 'contain')).toHaveLength(1);
    expect(() => run({ op: 'move', topic: d.key, to: grouped })).toThrow(/已在/);
    run({ op: 'move', topic: `memory:${d.key}` }); run({ op: 'move', topic: a.key, to: '' });
    expect(containers(app, bot)).toHaveLength(3 - 2); expect(moves(app, bot, 'release')).toHaveLength(2);
    run({ op: 'move', topic: b.key });
    expect(containers(app, bot)).toHaveLength(0); expect(moves(app, bot, 'dissolve')).toHaveLength(1);
    // Rename and merge.
    const x = made(f, '子', '子对象'), y = made(f, '孙', '孙对象');
    run({ op: 'rename', topic: x.key, name: '子项目', aliases: ['zixm'] });
    expect(containers(app, bot).find((row) => row.id === x.key)).toMatchObject({ title: '子项目', aliases_json: '["zixm"]', placed_by: 'owner' });
    expect(() => run({ op: 'rename', topic: y.key, anchor: '子对象' })).toThrow(/相同的名称/);
    expect(() => run({ op: 'merge', topic: y.key, into: y.key })).toThrow(/自己/);
    run({ op: 'merge', topic: y.key, into: x.key });
    expect(containers(app, bot).map((row) => row.id)).toEqual([x.key]); expect(childrenOf(app, x.key)).toHaveLength(6);
    expect(moves(app, bot, 'merge')[0]).toMatchObject({ topic_id: x.key, actor: 'model' });
    expect(() => run({ op: 'nope' })).toThrow(/op/);
    expect(() => run({ op: 'rename', topic: c.key, name: 'x' })).toThrow(/容器/);
  }, 90000);

  it('reverts any of its moves, once, and only the assistant\'s own', async () => {
    const f = await fixture(), { app, bot } = f;
    await ready(f); clock();
    const run = (args: Record<string, unknown>) => tree(app).run(bot, args) as Record<string, unknown>;
    // create
    const leaves = [1, 2, 3, 4].map((n) => leaf(app, bot, `项${n}`));
    const grouped = run({ op: 'group', topics: leaves.slice(0, 3).map((one) => one.key), name: '项目', anchor: '项目对象' }).created as string;
    const create = moves(app, bot, 'create')[0];
    run({ op: 'revert', moveId: create.id });
    expect(containers(app, bot)).toHaveLength(0); expect(meta(app, leaves[0].key)).toMatchObject({ parent_id: null, placed_by: 'auto' });
    expect(app.store.get('SELECT reverted_by FROM assistant_topic_moves WHERE id=?', create.id)!.reverted_by).toBeTruthy(); expect(moves(app, bot, 'revert')).toHaveLength(1);
    expect(() => run({ op: 'revert', moveId: create.id })).toThrow(/已撤销/); expect(() => run({ op: 'revert', moveId: 'nope' })).toThrow(/不存在/);
    expect(app.store.get('SELECT status FROM assistant_memories WHERE id=?', grouped)!.status).toBe('retired');
    // The group is not proposed again by the background work.
    expect(parseJson(app.store.get('SELECT rejected_json FROM assistant_topic_organize WHERE bot_id=?', bot)!.rejected_json)).toHaveLength(1);
    // contain / release
    const g = made(f, '组', '组对象');
    run({ op: 'move', topic: leaves[3].key, to: g.key });
    run({ op: 'revert', moveId: moves(app, bot, 'contain').at(-1)!.id }); expect(meta(app, leaves[3].key)).toMatchObject({ parent_id: null, placed_by: 'owner' });
    run({ op: 'move', topic: g.leaves[0].key });
    expect(meta(app, g.leaves[0].key).parent_id).toBeNull();
    run({ op: 'revert', moveId: moves(app, bot, 'release').at(-1)!.id }); expect(meta(app, g.leaves[0].key)).toMatchObject({ parent_id: g.key, placed_by: 'owner' });
    // rename
    run({ op: 'rename', topic: g.key, name: '新名字', anchor: '新对象', aliases: ['xin'] });
    run({ op: 'revert', moveId: moves(app, bot, 'rename').at(-1)!.id });
    expect(containers(app, bot)[0]).toMatchObject({ title: '组', anchor: '组对象', aliases_json: '[]' });
    // A move of another assistant cannot be reverted from here.
    const other = app.store.createBot('另一个助手');
    expect(() => tree(app).run(other, { op: 'revert', moveId: create.id })).toThrow(/不存在/);
  }, 90000);

  it('is covered by the memory.write grant, validates its op, runs inside a turn and is named in the prompt', async () => {
    const f = await fixture(), { app, bot, chat } = f;
    await ready(f);
    expect(evaluateTool(app.store, bot, { action: 'memory.topic', op: 'tree' }).policy.bot_id).toBe(bot);
    expect(() => evaluateTool(app.store, bot, { action: 'memory.topic', op: 'split' })).toThrow(/op/);
    expect(() => evaluateTool(app.store, bot, { action: 'memory.topic' })).toThrow(/op/);
    const restricted = app.store.createBot('只读助手');
    app.store.run('UPDATE bot_policies SET policy_json=? WHERE bot_id=?', JSON.stringify({ tools: ['memory.search'], inheritDefaults: false }), restricted);
    expect(() => evaluateTool(app.store, restricted, { action: 'memory.topic', op: 'tree' })).toThrow(/无权/);
    const leaves = ['甲', '乙', '丙'].map((title) => leaf(app, bot, `${title}主题`, { days: [-2] }));
    app.runtime.maintenanceIdle = 3_600_000;
    chat.scripts.push({ action: 'memory.topic', args: { op: 'group', topics: leaves.map((one) => one.key), name: '脚本容器', anchor: '脚本对象' } });
    const task = await turn(app, bot, '请把甲乙丙三个主题归成一组，围绕脚本对象', 'tool-1');
    const call = app.store.get("SELECT * FROM tool_calls WHERE task_id=? AND tool_name='memory.topic'", task)!;
    expect(call).toMatchObject({ status: 'succeeded', target_kind: 'memory', target_id: 'memory-topic' });
    expect(containers(app, bot)).toHaveLength(1); expect(containers(app, bot)[0]).toMatchObject({ title: '脚本容器', anchor: '脚本对象' });
    expect(JSON.parse(String(call.result_json))).toMatchObject({ created: containers(app, bot)[0].id });
    const system = String((chat.requests.find((request) => request.stream)!.messages as Array<{ role: string; content: string }>).find((message) => message.role === 'system')!.content);
    expect(system).toContain('memory.topic'); expect(system).toContain('不要主动归组');
  }, 90000);
});
const parseJson = (value: unknown) => JSON.parse(String(value)) as unknown[];
