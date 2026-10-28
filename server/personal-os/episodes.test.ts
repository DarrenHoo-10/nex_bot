import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, type FileEntry } from '@earendil-works/pi-coding-agent';
import { createPersonalApp } from './index.ts';
import { startFakePersonalMemory } from './testing/fake-personal-memory.ts';
import { hash } from './store.ts';
import { archiveText, episodeHash, episodeText, parseArchive, EPISODE_GAP_MS } from './episodes.ts';
import { episodeStart } from './context-tools.ts';
import { tokens } from './token-estimate.ts';

type Fixture = { root: string; fake: Awaited<ReturnType<typeof startFakePersonalMemory>>; app: Awaited<ReturnType<typeof createPersonalApp>>; bot: string };
type App = Fixture['app'];
const fixtures: Fixture[] = [];
const HOUR = 3_600_000;
// Core stamps inputs with Date.now(); the clock is injected by skewing it. Workers are separate processes and keep real time.
const realNow = Date.now.bind(Date);
let skew = 0;
const advance = (ms: number) => { skew += ms; };
beforeEach(() => { skew = 0; vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew); });

async function fixture(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nex-episodes-')), fake = await startFakePersonalMemory();
  const app = await createPersonalApp({ dir: root, key: randomBytes(32), token: 'synthetic-token', identity: false, memoryRuntime: false, hostDevice: false });
  app.store.saveConfig({ provider: 'openai', endpoint: fake.origin + '/v1', model: 'fixture-chat', apiKey: 'synthetic-only', contextWindow: 64000, maxOutputTokens: 4096, ...extra });
  const bot = app.store.createBot('合成个人助手'); clearInterval(app.runtime.memory.personal.timer);
  // Background maintenance would add summarizer calls of its own; these tests look at the turn path.
  app.runtime.maintenanceDelay = 600_000;
  const result = { root, fake, app, bot }; fixtures.push(result); return result;
}
async function wait(check: () => boolean, app: App, limit = 25000) {
  const until = realNow() + limit;
  while (!check()) {
    const failed = app.store.get("SELECT result_summary FROM tasks WHERE status='failed'"); if (failed) throw new Error(String(failed.result_summary));
    if (realNow() > until) throw new Error('Fixture timeout: ' + JSON.stringify(app.store.all('SELECT status,result_summary FROM tasks')));
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { app, fake, root } of fixtures.splice(0)) { await app.close(); await fake.close(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('nex-episodes-')) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }); }
});

const turn = async (app: App, bot: string, text: string, key: string) => {
  const task = app.agents.send(bot, text, key).taskId;
  await wait(() => app.store.get('SELECT status FROM tasks WHERE id=?', task)?.status === 'succeeded', app);
  await wait(() => !app.runtime.workers.size, app);
  return task;
};
const count = (app: App, table: string, where = '1=1') => Number(app.store.get(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`)!.n);
const streamed = (fake: Fixture['fake']) => fake.requests.filter(row => row.stream);
const summarizers = (fake: Fixture['fake']) => fake.requests.filter(row => !row.stream);
type Wire = Array<{ role: string; content: string }>;
const instructionOf = (request: Record<string, unknown>) => String((request.messages as Wire).find(message => message.role === 'system')?.content ?? '');
const episodeRequests = (fake: Fixture['fake']) => summarizers(fake).filter(row => instructionOf(row).includes('建立段落档案'));
const historyRequests = (fake: Fixture['fake']) => summarizers(fake).filter(row => instructionOf(row).includes('"workingNote"') && !instructionOf(row).includes('建立段落档案'));
const withoutSystem = (request: Record<string, unknown>) => JSON.stringify((request.messages as Wire).filter(message => message.role !== 'system' && message.role !== 'developer'));
const runtimeOf = (app: App, bot: string) => String(app.store.get('SELECT id FROM runtime_sessions WHERE bot_id=?', bot)!.id);
const stored = (app: App, bot: string) => app.runtime.projection.load(runtimeOf(app, bot))!;
const episodes = (app: App) => app.store.all('SELECT * FROM conversation_episodes ORDER BY created_at');
const episodeCompaction = (entries: FileEntry[]) => entries.find(entry => entry.type === 'compaction' && (entry.details as { episode?: string } | undefined)?.episode);
const note = (app: App, bot: string) => app.store.get('SELECT * FROM assistant_working_notes WHERE bot_id=?', bot);
const post = (app: App, route: string, data: unknown, token = 'synthetic-token') => fetch(app.origin + '/api/agents/' + route, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
/** The volatile reminder of a request: the one user message that carries it. */
const volatileOf = (request: Record<string, unknown>) => String((request.messages as Wire).find(message => message.role === 'user' && String(message.content).includes('<system-reminder>'))?.content);
const reply = (content: string) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
/** One memory pump run (it waits 30 s between runs of the same assistant). */
const pump = async (app: App) => { app.store.run('UPDATE assistant_memory_settings SET next_attempt=0'); await app.runtime.memory.personal.flush(); };

describe('Episode archives', () => {
  describe('archive validation', () => {
    const known = new Set(['aaaa1111', 'bbbb2222']);
    const valid = { title: '标题', brief: '要点', topics: ['主题'], decisions: [{ decision: '决定', reason: '原因' }], operations: [{ operation: 'memory.read', outcome: 'success', identifiers: ['DOC-1'], detail: '成功' }, { operation: 'device.exec', outcome: '失败', identifiers: 'F-2' }], openItems: ['待办'], refs: ['entry:aaaa1111', 'entry:unknown', 'message:x', 'entry:aaaa1111'], workingNote: '笔记' };
    it('accepts a complete archive, normalizes outcomes and drops references to entries that are not in the conversation', () => {
      const archive = parseArchive('```json\n' + JSON.stringify(valid) + '\n```', known);
      expect(archive).toMatchObject({ title: '标题', brief: '要点', topics: ['主题'], openItems: ['待办'], refs: ['entry:aaaa1111'], workingNote: '笔记' });
      expect(archive.operations.map(item => [item.outcome, item.identifiers])).toEqual([['success', ['DOC-1']], ['failure', ['F-2']]]);
      expect(archiveText(archive)).toContain('[失败] device.exec');
      expect(archiveText(archive)).toContain('（原因：原因）');
    });
    it('rejects what is not an object, lacks a title or brief, or lacks an array', () => {
      for (const output of ['这不是 JSON', '[]', '{"title":"t"}', JSON.stringify({ ...valid, title: '' }), JSON.stringify({ ...valid, brief: ' ' }), ...['topics', 'decisions', 'operations', 'openItems', 'refs'].map(name => JSON.stringify({ ...valid, [name]: 'x' }))]) {
        expect(() => parseArchive(output, known), output).toThrow('段落档案');
      }
    });
    it('keeps the short summary within 300 tokens', () => {
      const archive = parseArchive(JSON.stringify({ ...valid, brief: '很长的要点'.repeat(500) }), known);
      expect(tokens(archive.brief)).toBeLessThanOrEqual(300);
      expect(archive.brief.endsWith('…')).toBe(true);
    });
    it('hashes everything an archive says', () => {
      const row = { title: 't', summary: 's', open_items: '[]', refs_json: '[]', detail_json: '{}' };
      expect(episodeHash(row)).toBe(hash(episodeText(row)));
      for (const field of Object.keys(row)) expect(episodeHash({ ...row, [field]: 'changed' })).not.toBe(episodeHash(row));
    });
    it('finds where an episode really starts through summary compactions, and stops at the previous episode boundary', () => {
      const manager = SessionManager.inMemory('/episodes-test');
      const input = (text: string) => manager.appendCustomMessageEntry('nex.input', text, false, { inputId: text, hash: 'h', seq: 1 });
      const a = input('a'); manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'x' }], stopReason: 'stop', timestamp: 1 } as never);
      const b = input('b');
      const entries = () => [manager.getHeader()!, ...manager.getEntries()] as FileEntry[];
      manager.appendCompaction('S1', b, 1, { sourceFirst: a, sourceLast: b } as never);
      const c = input('c');
      const first = manager.getEntries().find(entry => entry.type === 'compaction')!;
      expect(episodeStart(entries(), first)).toBe(a);
      manager.appendCompaction('S2', c, 1, { sourceFirst: first.id, sourceLast: c } as never);
      const second = manager.getEntries().filter(entry => entry.type === 'compaction')[1];
      expect(episodeStart(entries(), second)).toBe(a);
      manager.appendCompaction('S3', c, 1, { sourceFirst: second.id, sourceLast: c, episode: 'e1' } as never);
      const boundary = manager.getEntries().filter(entry => entry.type === 'compaction')[2];
      expect(episodeStart(entries(), boundary)).toBe(c);
      const d = input('d');
      expect(episodeStart(entries(), manager.getEntries().find(entry => entry.id === d)!)).toBe(d);
    });
  });

  describe('boundary', () => {
    it('opens a new episode after a gap of 6 hours: archive row, boundary compaction, clean next context, working note', async () => {
      const f = await fixture(), { app, fake, bot } = f;
      expect(EPISODE_GAP_MS).toBe(6 * HOUR);
      fake.scripts.push('第一段回答', '第二段回答', '第三段回答');
      await turn(app, bot, 'EP1-FIRST：讨论合成方案A', 'ep-1');
      expect(episodes(app)).toHaveLength(0);
      advance(6 * HOUR);
      const second = await turn(app, bot, 'EP2-FIRST：另一个话题', 'ep-2');
      const [episode] = episodes(app);
      expect(episodes(app)).toHaveLength(1);
      expect(episode).toMatchObject({ bot_id: bot, title: '合成段落档案', conversation_id: String(app.store.get('SELECT conversation_id FROM runtime_sessions WHERE bot_id=?', bot)!.conversation_id) });
      expect(Number(episode.ended_at)).toBeGreaterThanOrEqual(Number(episode.started_at));
      // The row covers the first episode only, from its first entry to the entry before the new input.
      const entries = stored(app, bot), ids = entries.flatMap(entry => entry.type === 'session' ? [] : [entry.id]);
      const input = (text: string) => entries.find(entry => entry.type === 'custom_message' && entry.content === text)!;
      expect(ids).toContain(String(episode.first_entry)); expect(ids).toContain(String(episode.last_entry));
      expect(ids.indexOf(String(episode.first_entry))).toBeLessThan(ids.indexOf(input('EP2-FIRST：另一个话题').id));
      expect(ids.indexOf(String(episode.last_entry))).toBeLessThan(ids.indexOf(input('EP2-FIRST：另一个话题').id));
      expect(ids.indexOf(String(episode.first_entry))).toBeLessThanOrEqual(ids.indexOf(input('EP1-FIRST：讨论合成方案A').id));
      // The structure is kept: decisions with reasons, tool outcomes with identifiers, open items and real entry references.
      expect(String(episode.summary)).toContain('（原因：用户要求保持只读）');
      expect(String(episode.summary)).toContain('[成功] memory.read 读取合成资料（标识：DOC-SYNTH-1）');
      expect(String(episode.summary)).toContain('[失败] device.exec 保存文件（标识：/tmp/synthetic.txt）');
      expect(JSON.parse(String(episode.open_items))).toEqual(['验证长期记忆']);
      const refs = JSON.parse(String(episode.refs_json)) as string[];
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(ids).toContain(ref.slice(6));
      expect(Number(episode.tokens)).toBe(tokens(String(episode.summary)));
      // Boundary compaction: the new input is the first kept entry, so nothing of the first episode remains in context.
      const compaction = episodeCompaction(entries)!;
      expect(compaction).toMatchObject({ type: 'compaction', firstKeptEntryId: input('EP2-FIRST：另一个话题').id });
      expect(compaction.type === 'compaction' && compaction.summary).toContain('上一段要点');
      expect(compaction.type === 'compaction' && compaction.summary).toContain('episode:' + episode.id);
      expect((compaction as unknown as { details: { episode: string } }).details.episode).toBe(episode.id);
      expect(episodeRequests(fake)).toHaveLength(1);
      expect(historyRequests(fake)).toHaveLength(0);
      const request = withoutSystem(streamed(fake).at(-1)!);
      expect(request).toContain('EP2-FIRST'); expect(request).toContain('上一段要点'); expect(request).not.toContain('EP1-FIRST');
      // Core wrote the working note from the same response; usage and the checkpoint belong to the task.
      expect(note(app, bot)).toMatchObject({ content: '段落笔记：只讨论，不部署；待验证长期记忆。', version: 1, task_id: second });
      expect(app.store.get('SELECT task_id,summary FROM context_checkpoints')).toMatchObject({ task_id: second });
      expect(app.store.get("SELECT purpose,task_id FROM assistant_usage WHERE purpose='compact'")).toMatchObject({ task_id: second });
      // Originals are untouched and still retrievable, and the archive is searchable.
      expect(app.agents.search(bot, 'entry:' + episode.first_entry)[0].content).toContain('EP1-FIRST');
      expect(count(app, 'agent_messages', "content LIKE '%EP1-FIRST%'")).toBeGreaterThan(0);
      expect(count(app, 'conversation_episode_search')).toBe(1);
      // The next turn right away is the same episode: no new archive and no summarizer call.
      const before = fake.requests.length;
      await turn(app, bot, 'EP2-SECOND：接着聊', 'ep-3');
      expect(episodes(app)).toHaveLength(1);
      expect(fake.requests.slice(before).filter(row => !row.stream)).toHaveLength(0);
      expect(withoutSystem(streamed(fake).at(-1)!)).toContain('EP2-FIRST');
    }, 90000);

    it('does not open an episode for a shorter gap or a first input', async () => {
      const f = await fixture(), { app, fake, bot } = f;
      await turn(app, bot, 'GAP-FIRST', 'gap-1');
      advance(5 * HOUR + 50 * 60_000);
      await turn(app, bot, 'GAP-SECOND', 'gap-2');
      expect(episodes(app)).toHaveLength(0);
      expect(summarizers(fake)).toHaveLength(0);
      expect(episodeCompaction(stored(app, bot))).toBeUndefined();
      expect(withoutSystem(streamed(fake).at(-1)!)).toContain('GAP-FIRST');
      // A task that resumes with its input already applied is not a boundary either.
      const task = String(app.store.get('SELECT id FROM tasks ORDER BY created_at DESC LIMIT 1')!.id);
      expect(app.runtime.episodes.boundary(task)).toBeUndefined();
    }, 90000);

    it('reports the gap and the explicit topic as the reason, and ignores marks that were passed by', async () => {
      const f = await fixture(), { app, bot } = f;
      await turn(app, bot, 'REASON-FIRST', 'reason-1');
      const conversation = String(app.store.get('SELECT conversation_id FROM runtime_sessions WHERE bot_id=?', bot)!.conversation_id);
      // Inputs are accepted without starting a worker, so only the decision is looked at.
      expect(app.agents.newTopic(bot)).toEqual({ marked: true });
      expect(count(app, 'conversation_topic_marks')).toBe(1);
      const topicTask = app.store.accept(conversation, 'REASON-TOPIC', 'reason-2');
      expect(app.runtime.episodes.boundary(topicTask)).toMatchObject({ reason: 'topic' });
      app.runtime.cancel(topicTask);
      expect(app.store.get('SELECT status FROM tasks WHERE id=?', topicTask)?.status).toBe('cancelled');
      // The mark was for that input; a later one finds it stale and removes it.
      advance(7 * HOUR);
      const gapTask = app.store.accept(conversation, 'REASON-GAP', 'reason-3');
      expect(app.runtime.episodes.boundary(gapTask)).toMatchObject({ reason: 'gap' });
      expect(count(app, 'conversation_topic_marks')).toBe(0);
      app.runtime.cancel(gapTask);
    }, 90000);
  });

  describe('explicit new topic', () => {
    it('needs authentication, marks the current conversation and opens an episode at the next input only', async () => {
      const f = await fixture(), { app, fake, bot } = f;
      expect((await post(app, 'topic', { botId: bot }, 'invalid')).status).toBe(401);
      expect((await post(app, 'topic', { botId: bot }, '')).status).toBe(401);
      // Nothing to separate yet.
      expect(await (await post(app, 'topic', { botId: bot })).json()).toEqual({ marked: false });
      expect(count(app, 'conversation_topic_marks')).toBe(0);
      expect((await post(app, 'topic', { botId: 'unknown-bot' })).status).toBe(400);
      fake.scripts.push('第一段回答', '第二段回答', '第三段回答');
      await turn(app, bot, 'TOPIC-FIRST：旧话题内容', 'topic-1');
      expect(await (await post(app, 'topic', { botId: bot })).json()).toEqual({ marked: true });
      expect(count(app, 'conversation_topic_marks')).toBe(1);
      // No time has passed: only the mark opens the episode.
      await turn(app, bot, 'TOPIC-SECOND：新话题', 'topic-2');
      expect(episodes(app)).toHaveLength(1);
      expect(count(app, 'conversation_topic_marks')).toBe(0);
      expect(episodeCompaction(stored(app, bot))).toBeDefined();
      const request = withoutSystem(streamed(fake).at(-1)!);
      expect(request).toContain('TOPIC-SECOND'); expect(request).not.toContain('TOPIC-FIRST');
      // One-shot: the following input continues the new episode.
      await turn(app, bot, 'TOPIC-THIRD：继续新话题', 'topic-3');
      expect(episodes(app)).toHaveLength(1);
      expect(episodeRequests(fake)).toHaveLength(1);
    }, 90000);

    it('is refused while the conversation is working', async () => {
      const f = await fixture(), { app, bot } = f;
      await turn(app, bot, 'BUSY-FIRST', 'busy-1');
      const task = app.agents.send(bot, 'BUSY-SECOND', 'busy-2').taskId;
      expect((await post(app, 'topic', { botId: bot })).status).toBe(400);
      expect(count(app, 'conversation_topic_marks')).toBe(0);
      await wait(() => app.store.get('SELECT status FROM tasks WHERE id=?', task)?.status === 'succeeded', app);
    }, 90000);
  });

  describe('failures never fail the turn', () => {
    it('keeps the episode open on invalid or incomplete archives and archives the whole stretch at the next boundary', async () => {
      const f = await fixture(), { app, fake, bot } = f;
      let mode: 'text' | 'incomplete' | 'length' | 'valid' = 'text';
      fake.setOverride(body => {
        if (body.stream || !instructionOf(body).includes('建立段落档案')) return undefined;
        if (mode === 'text') return reply('这不是 JSON');
        if (mode === 'incomplete') return reply(JSON.stringify({ title: '只有标题', brief: '要点' }));
        if (mode === 'length') return { choices: [{ message: { content: '{"title":"被截断' }, finish_reason: 'length' }] };
        return undefined;
      });
      await turn(app, bot, 'OPEN-ONE：第一个话题', 'open-1');
      for (const [index, next] of (['text', 'incomplete', 'length'] as const).entries()) {
        mode = next; advance(7 * HOUR);
        const task = await turn(app, bot, `OPEN-${index + 2}：之后的话题`, `open-${index + 2}`);
        // The turn succeeded and nothing was archived or folded; the first input is still in context.
        expect(app.store.get('SELECT status FROM tasks WHERE id=?', task)?.status).toBe('succeeded');
        expect(episodes(app)).toHaveLength(0);
        expect(count(app, 'conversation_episode_search')).toBe(0);
        expect(episodeCompaction(stored(app, bot))).toBeUndefined();
        expect(withoutSystem(streamed(fake).at(-1)!)).toContain('OPEN-ONE');
        expect(episodeRequests(fake)).toHaveLength(index + 1);
        expect(count(app, 'context_checkpoints')).toBe(0);
        expect(note(app, bot)).toBeUndefined();
      }
      mode = 'valid'; advance(7 * HOUR);
      await turn(app, bot, 'OPEN-LAST：最后的话题', 'open-last');
      const [episode] = episodes(app);
      expect(episodes(app)).toHaveLength(1);
      // The archive covers the stretch that stayed open, back to its very first entry.
      const entries = stored(app, bot), ids = entries.flatMap(entry => entry.type === 'session' ? [] : [entry.id]);
      const first = entries.find(entry => entry.type === 'custom_message' && entry.content === 'OPEN-ONE：第一个话题')!;
      expect(episode.first_entry).toBe(first.id);
      expect(ids.indexOf(String(episode.last_entry))).toBeLessThan(ids.indexOf(entries.find(entry => entry.type === 'custom_message' && entry.content === 'OPEN-LAST：最后的话题')!.id));
      const request = withoutSystem(streamed(fake).at(-1)!);
      expect(request).toContain('OPEN-LAST'); expect(request).not.toContain('OPEN-ONE');
    }, 180000);

  });

  describe('search', () => {
    it('expands episode:<id> to the archive for its own assistant only, and finds archives by text with a bounded result', async () => {
      const f = await fixture(), { app, fake, bot } = f;
      fake.scripts.push('第一段回答', '第二段回答');
      await turn(app, bot, 'SEARCH-ONE：旧内容', 'search-1');
      advance(7 * HOUR);
      await turn(app, bot, 'SEARCH-TWO：新内容', 'search-2');
      const [episode] = episodes(app);
      const [found] = app.agents.search(bot, 'episode:' + episode.id) as unknown as Array<Record<string, unknown>>;
      expect(found).toMatchObject({ id: episode.id, ref: 'episode:' + episode.id, title: '合成段落档案', openItems: ['验证长期记忆'], conversationId: episode.conversation_id, firstEntry: episode.first_entry, lastEntry: episode.last_entry });
      expect((found.decisions as unknown[]).length).toBe(1);
      expect((found.operations as Array<{ outcome: string; identifiers: string[] }>).map(item => [item.outcome, item.identifiers[0]])).toEqual([['success', 'DOC-SYNTH-1'], ['failure', '/tmp/synthetic.txt']]);
      expect(String(found.content)).toContain('标题：合成段落档案');
      expect(app.agents.search(bot, 'episode:missing')).toEqual([]);
      expect(app.agents.search(app.store.createBot('另一助手'), 'episode:' + episode.id)).toEqual([]);
      // The tool: a plain text query returns matching archives next to messages and notes; an expansion query does not search them.
      fake.scripts.push({ action: 'memory.search', args: { query: '合成段落档案 验证' } }, { action: 'memory.search', args: { query: 'episode:' + episode.id } }, '已检索');
      await turn(app, bot, '检索之前的段落', 'search-3');
      const results = app.store.all("SELECT arguments_json,result_json FROM tool_calls WHERE tool_name='memory.search' ORDER BY created_at").map(row => JSON.parse(String(row.result_json)) as { episodes: Array<{ ref: string; title: string; summary: string }>; messages: Array<Record<string, unknown>> });
      expect(results[0].episodes.map(item => item.ref)).toEqual(['episode:' + episode.id]);
      expect(results[0].episodes[0].summary).toContain('合成段落档案');
      expect(results[1].episodes).toEqual([]);
      expect(results[1].messages[0]).toMatchObject({ id: episode.id, ref: 'episode:' + episode.id });
    }, 90000);

    it('ranks archives and bounds how many and how large they are', async () => {
      const { app, bot } = await fixture();
      const conversation = 'synthetic-conversation';
      const save = (index: number, title: string, body: string) => app.runtime.episodes.save({ botId: bot, conversationId: conversation, firstEntry: 'f' + index, lastEntry: 'l' + index, startedAt: 1000 + index, endedAt: 2000 + index, archive: { title, brief: body, topics: [], decisions: [], operations: [], openItems: [], refs: [] } });
      const best = save(0, '部署服务器排查', '部署服务器排查的完整记录 部署 服务器 排查');
      for (let index = 1; index <= 8; index++) save(index, `部署记录${index}`, '部署相关的次要记录 ' + '细节'.repeat(index * 400));
      save(9, '无关话题', '午餐菜单');
      const found = app.runtime.episodes.search(bot, '部署服务器排查');
      expect(found.length).toBeLessThanOrEqual(5);
      expect(found[0].ref).toBe('episode:' + best);
      expect(found.some(item => item.title === '无关话题')).toBe(false);
      expect(tokens(found)).toBeLessThanOrEqual(3000 + 400);
      expect(app.runtime.episodes.search(bot, '午餐').map(item => item.title)).toEqual(['无关话题']);
      expect(app.runtime.episodes.search(bot, '')).toEqual([]);
      expect(app.runtime.episodes.search(app.store.createBot('另一助手'), '部署')).toEqual([]);
      // Saving the same range again replaces the earlier attempt, in the table and in the index.
      const again = save(0, '部署服务器排查', '新的版本');
      expect(again).not.toBe(best);
      expect(count(app, 'conversation_episodes', "last_entry='l0'")).toBe(1);
      expect(count(app, 'conversation_episode_search', `episode_id='${best}'`)).toBe(0);
    });
  });

  describe('forgetting', () => {
    it('removes archives, their index and memories resting on them when a forget plan reaches the assistant', async () => {
      const f = await fixture(), { app, fake, bot } = f, memory = app.runtime.memory.personal;
      memory.saveGlobal({ version: 0, enabled: true, model: 'fixture-memory' });
      fake.scripts.push('第一段回答', '第二段回答');
      await turn(app, bot, 'FORGET-ONE：旧内容', 'forget-1');
      advance(7 * HOUR);
      await turn(app, bot, 'FORGET-TWO：新内容', 'forget-2');
      const [episode] = episodes(app);
      await pump(app);
      const ref = 'episode:' + episode.id;
      const derived = () => app.store.all('SELECT * FROM assistant_memories').filter(row => String(row.refs_json).includes(ref));
      expect(derived().length).toBeGreaterThan(0);
      app.agents.newTopic(bot);
      expect(count(app, 'conversation_topic_marks')).toBe(1);
      // The query matches the archive's own text, not any message: the archive is derived data and is reached all the same.
      const plan = app.runtime.memory.privacy.preview(bot, { query: '合成段落档案' });
      expect(plan.bots).toEqual([bot]);
      app.runtime.memory.forget(bot, { query: '合成段落档案' }, plan.revision);
      expect(episodes(app)).toHaveLength(0);
      expect(count(app, 'conversation_episode_search')).toBe(0);
      expect(count(app, 'conversation_topic_marks')).toBe(0);
      expect(derived()).toHaveLength(0);
      expect(app.agents.search(bot, 'episode:' + episode.id)).toEqual([]);
      expect(() => memory.source(bot, ref)).toThrow('已遗忘');
      expect(app.runtime.episodes.search(bot, '合成段落档案')).toEqual([]);
    }, 90000);

    it('leaves other assistants archives alone', async () => {
      const { app, bot } = await fixture(), other = app.store.createBot('另一助手');
      const save = (botId: string, last: string) => app.runtime.episodes.save({ botId, conversationId: 'c-' + botId, firstEntry: 'f', lastEntry: last, startedAt: 1, endedAt: 2, archive: { title: '共同话题', brief: '共同话题', topics: [], decisions: [], operations: [], openItems: [], refs: [] } });
      save(bot, 'a'); const kept = save(other, 'b');
      expect([...app.runtime.episodes.forgetBot(bot)]).toHaveLength(1);
      expect(episodes(app).map(row => row.id)).toEqual([kept]);
      expect(count(app, 'conversation_episode_search')).toBe(1);
    });
  });

  describe('long-term memory sources', () => {
    it('retains closed episode archives as experiences whose sources are verified by id and hash', async () => {
      const f = await fixture(), { app, fake, bot } = f, memory = app.runtime.memory.personal;
      memory.saveGlobal({ version: 0, enabled: true, model: 'fixture-memory' });
      fake.scripts.push('第一段回答', '第二段回答');
      await turn(app, bot, 'RETAIN-ONE：旧内容', 'retain-1');
      advance(7 * HOUR);
      await turn(app, bot, 'RETAIN-TWO：新内容', 'retain-2');
      const [episode] = episodes(app), ref = 'episode:' + episode.id;
      expect(memory.settings(bot).episode_cursor).toBe(0);
      await pump(app);
      const rows = app.store.all('SELECT * FROM assistant_memories WHERE refs_json LIKE ?', `%${ref}%`);
      expect(rows.length).toBeGreaterThan(0);
      // Tool outcomes are experiences, and the source carries the id and the hash of the archive's text.
      const row = rows.find(item => item.kind === 'experience')!;
      expect(row).toBeDefined();
      expect(JSON.parse(String(row.refs_json))).toEqual([{ id: ref, hash: hash(episodeText(episode)) }]);
      expect(memory.rows(bot).some(item => item.id === row.id)).toBe(true);
      expect(Number(memory.settings(bot).episode_cursor)).toBe(Number(episode.created_at));
      expect(app.runtime.memory.expand(bot, ref).content).toBe(episodeText(episode));
      expect(() => app.runtime.memory.expand(app.store.createBot('另一助手'), ref)).toThrow();
      const recalled = await memory.recall(bot, '合成段落档案 验证长期记忆');
      expect(recalled.flatMap(item => item.refs)).toContain(ref);
      // The archive is read once.
      const before = fake.requests.length;
      await pump(app);
      expect(fake.requests.slice(before).filter(request => instructionOf(request).includes('从新增原文提取'))).toHaveLength(0);
      // A changed archive no longer supports the memory: it is hidden, not served.
      app.store.run("UPDATE conversation_episodes SET summary=summary||'（被篡改）' WHERE id=?", episode.id);
      expect(memory.rows(bot).some(item => item.id === row.id)).toBe(false);
      expect((await memory.recall(bot, '合成段落档案 验证长期记忆')).flatMap(item => item.refs)).not.toContain(ref);
    }, 90000);

    it('rejects a retain whose archive changed while the model was working, and reads it again later', async () => {
      const f = await fixture(), { app, fake, bot } = f, memory = app.runtime.memory.personal;
      memory.saveGlobal({ version: 0, enabled: true, model: 'fixture-memory' });
      fake.scripts.push('第一段回答', '第二段回答');
      await turn(app, bot, 'TAMPER-ONE：旧内容', 'tamper-1');
      advance(7 * HOUR);
      await turn(app, bot, 'TAMPER-TWO：新内容', 'tamper-2');
      const [episode] = episodes(app), ref = 'episode:' + episode.id;
      // Messages first, so that only the archive is left to retain.
      await pump(app);
      app.store.run('DELETE FROM assistant_memories WHERE refs_json LIKE ?', `%${ref}%`);
      app.store.run('UPDATE assistant_memory_settings SET episode_cursor=0 WHERE bot_id=?', bot);
      fake.setOverride(body => {
        if (!body.stream && instructionOf(body).includes('从新增原文提取') && String((body.messages as Wire).at(-1)?.content).includes(ref)) app.store.run("UPDATE conversation_episodes SET title=title||'（改）' WHERE id=?", episode.id);
        return undefined;
      });
      await pump(app);
      expect(app.store.all('SELECT * FROM assistant_memories WHERE refs_json LIKE ?', `%${ref}%`)).toHaveLength(0);
      expect(memory.settings(bot).last_error).toContain('来源已变化');
      expect(Number(memory.settings(bot).episode_cursor)).toBe(0);
    }, 90000);

    it('does not retain archives that existed before the memory was switched on, or that hold secrets', async () => {
      const f = await fixture(), { app, fake, bot } = f, memory = app.runtime.memory.personal;
      const save = (last: string, body: string) => app.runtime.episodes.save({ botId: bot, conversationId: 'c', firstEntry: 'f', lastEntry: last, startedAt: 1, endedAt: 2, archive: { title: '旧段落', brief: body, topics: [], decisions: [], operations: [], openItems: [], refs: [] } });
      save('old', '开启记忆之前的段落');
      memory.saveGlobal({ version: 0, enabled: true, model: 'fixture-memory' });
      expect(Number(memory.settings(bot).episode_cursor)).toBeGreaterThan(0);
      save('secret', '配置里写着 password: hunter2hunter2');
      save('plain', '开启之后的普通段落');
      await pump(app);
      const sent = fake.requests.filter(request => instructionOf(request).includes('从新增原文提取')).map(request => String((request.messages as Wire).at(-1)?.content)).join('\n');
      expect(sent).toContain('开启之后的普通段落');
      expect(sent).not.toContain('开启记忆之前的段落'); expect(sent).not.toContain('hunter2');
      expect(memory.settings(bot).last_error).toBeNull();
      expect(Number(memory.settings(bot).episode_cursor)).toBe(Number(app.store.get("SELECT created_at FROM conversation_episodes WHERE last_entry='plain'")!.created_at));
    }, 90000);
  });

  describe('recall', () => {
    it('puts the most relevant archives into the volatile reminder only, bounded', async () => {
      const f = await fixture(), { app, fake, bot } = f;
      fake.scripts.push('第一段回答', '第二段回答', '第三段回答');
      await turn(app, bot, 'RECALL-ONE：旧内容', 'recall-1');
      advance(7 * HOUR);
      await turn(app, bot, 'RECALL-TWO：新内容', 'recall-2');
      const [episode] = episodes(app);
      await turn(app, bot, '继续 合成段落档案 里待验证的长期记忆', 'recall-3');
      const request = streamed(fake).at(-1)!, wire = request.messages as Wire;
      const volatile = wire.filter(message => message.role === 'user' && String(message.content).includes('<system-reminder>'));
      expect(volatile).toHaveLength(1);
      expect(String(volatile[0].content)).toContain('"relatedEpisodes"');
      expect(String(volatile[0].content)).toContain('episode:' + episode.id);
      // Not in the stable prompt, nor anywhere else in the request.
      const stable = wire.filter(message => message.role === 'system').map(message => String(message.content)).join('\n');
      expect(stable).not.toContain('relatedEpisodes'); expect(stable).not.toContain('episode:' + episode.id); expect(stable).not.toContain('合成段落档案');
      expect(wire.filter(message => String(message.content).includes('"relatedEpisodes"'))).toHaveLength(1);
      // A turn that has nothing to do with it recalls nothing.
      await turn(app, bot, '今天午餐吃什么', 'recall-4');
      expect(volatileOf(streamed(fake).at(-1)!)).toContain('"relatedEpisodes":[]');
    }, 90000);

    it('puts at most 3 archives and 1500 tokens into it', async () => {
      const { app, bot } = await fixture();
      for (let index = 0; index < 6; index++) app.runtime.episodes.save({ botId: bot, conversationId: 'c', firstEntry: 'f' + index, lastEntry: 'l' + index, startedAt: index, endedAt: index + 1, archive: { title: `项目记录${index}`, brief: '项目进展 ' + '详细内容'.repeat(900), topics: ['项目'], decisions: [], operations: [], openItems: [], refs: [] } });
      const related = app.runtime.episodes.related(bot, '项目进展');
      expect(related.length).toBeGreaterThan(0); expect(related.length).toBeLessThanOrEqual(3);
      expect(tokens(related)).toBeLessThanOrEqual(1500);
      // The same list is what the volatile context carries for the latest user message.
      app.agents.publish(bot, 'user', 'message', '项目进展如何', 'recall-bound');
      const context = JSON.parse(app.agents.context(bot, 'no-task')) as { relatedEpisodes: Array<{ ref: string }> };
      expect(context.relatedEpisodes.map(item => item.ref)).toEqual(related.map(item => item.ref));
      expect(tokens(context.relatedEpisodes)).toBeLessThanOrEqual(1500);
    });
  });

  describe('working note maintained by Core', () => {
    // A tight working budget makes the second turn fold the first into a turn summary.
    const folding = { contextBudget: 8000 };
    const history = { choices: [{ message: { content: JSON.stringify({ workingNote: 'CORE-NOTE：沿用的约束', history: 'HISTORY-ONLY：旧回合摘要' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    it('writes workingNote of a turn summary into the note (version + 1) and uses history as the summary', async () => {
      const f = await fixture(folding), { app, fake, bot } = f;
      await turn(app, bot, 'NOTE-ONE：第一轮', 'note-1');
      const task = await turn(app, bot, 'NOTE-TWO：第二轮', 'note-2');
      const requests = historyRequests(fake);
      expect(requests.length).toBeGreaterThan(0);
      expect(note(app, bot)).toMatchObject({ content: 'Core 笔记：只讨论，不部署。压缩阈值80%。尚需验证长期记忆。', version: 1, task_id: task });
      const summary = String(app.store.get('SELECT summary FROM context_checkpoints WHERE task_id=?', task)!.summary);
      expect(summary).toContain('历史：已经讨论上下文连续性及登录问题'); expect(summary).not.toContain('Core 笔记');
      expect(episodes(app)).toHaveLength(0);
      // The next compaction is shown the current note, writes version 2 and keeps the model's other writes safe.
      expect(String(requests[0].messages && (requests[0].messages as Wire).at(-1)!.content)).toContain('"现有工作笔记":""');
      await turn(app, bot, 'NOTE-THREE：第三轮', 'note-3');
      const latest = historyRequests(fake).at(-1)!;
      expect(String((latest.messages as Wire).at(-1)!.content)).toContain('Core 笔记');
      expect(note(app, bot)).toMatchObject({ version: 2 });
      // The volatile reminder shows the maintained note.
      expect(volatileOf(streamed(fake).at(-1)!)).toContain('"workingNote":{"content":"Core 笔记');
    }, 120000);

    it('takes non-JSON output whole as the summary and leaves the note unchanged', async () => {
      const f = await fixture(folding), { app, fake, bot } = f;
      app.store.run('INSERT INTO assistant_working_notes(bot_id,content,task_id,version,updated_at) VALUES(?,?,?,?,?)', bot, 'EXISTING-NOTE', 'earlier-task', 3, 1);
      fake.setOverride(body => (!body.stream && instructionOf(body).includes('"workingNote"') && !instructionOf(body).includes('建立段落档案')) ? reply('PLAIN-SUMMARY：纯文本摘要，不是 JSON') : undefined);
      await turn(app, bot, 'PLAIN-ONE：第一轮', 'plain-1');
      const task = await turn(app, bot, 'PLAIN-TWO：第二轮', 'plain-2');
      expect(String(app.store.get('SELECT summary FROM context_checkpoints WHERE task_id=?', task)!.summary)).toContain('PLAIN-SUMMARY：纯文本摘要，不是 JSON');
      expect(note(app, bot)).toMatchObject({ content: 'EXISTING-NOTE', version: 3, task_id: 'earlier-task' });
      // JSON without a history is not that shape either.
      fake.setOverride(body => (!body.stream && instructionOf(body).includes('"workingNote"') && !instructionOf(body).includes('建立段落档案')) ? reply(JSON.stringify({ workingNote: 'IGNORED', summary: 'x' })) : undefined);
      const third = await turn(app, bot, 'PLAIN-THREE：第三轮', 'plain-3');
      expect(String(app.store.get('SELECT summary FROM context_checkpoints WHERE task_id=?', third)!.summary)).toContain('IGNORED');
      expect(note(app, bot)).toMatchObject({ content: 'EXISTING-NOTE', version: 3 });
    }, 120000);

    it('keeps a note the model wrote meanwhile (version conflict) and still keeps the summary', async () => {
      const f = await fixture(folding), { app, fake, bot } = f;
      // The model's own write path through memory.write(scope=context) is unchanged.
      fake.scripts.push({ action: 'memory.write', args: { scope: 'context', title: '工作笔记', content: 'MODEL-NOTE-V1', expectedVersion: 0 } }, '第一轮完成');
      const first = await turn(app, bot, 'CONFLICT-ONE：第一轮', 'conflict-1');
      expect(note(app, bot)).toMatchObject({ content: 'MODEL-NOTE-V1', version: 1, task_id: first });
      let writes = 0;
      fake.setOverride(body => {
        if (body.stream || !instructionOf(body).includes('"workingNote"') || instructionOf(body).includes('建立段落档案')) return undefined;
        // The model's write lands while the summarizer is working.
        writes++;
        app.store.run('UPDATE assistant_working_notes SET content=?,version=version+1,updated_at=? WHERE bot_id=?', 'MODEL-NOTE-V2', Date.now(), bot);
        return history;
      });
      const second = await turn(app, bot, 'CONFLICT-TWO：第二轮', 'conflict-2');
      expect(writes).toBeGreaterThan(0);
      expect(note(app, bot)).toMatchObject({ content: 'MODEL-NOTE-V2', version: 2 });
      expect(String(app.store.get('SELECT summary FROM context_checkpoints WHERE task_id=?', second)!.summary)).toContain('HISTORY-ONLY：旧回合摘要');
      // Without a conflict Core's update lands with version + 1.
      fake.setOverride(undefined);
      const third = await turn(app, bot, 'CONFLICT-THREE：第三轮', 'conflict-3');
      expect(note(app, bot)).toMatchObject({ version: 3, task_id: third });
      expect(String(note(app, bot)!.content)).toContain('Core 笔记');
    }, 120000);

    it('does not create a note from an empty workingNote', async () => {
      const f = await fixture(folding), { app, fake, bot } = f;
      fake.setOverride(body => (!body.stream && instructionOf(body).includes('"workingNote"') && !instructionOf(body).includes('建立段落档案')) ? reply(JSON.stringify({ workingNote: '  ', history: 'EMPTY-NOTE-HISTORY' })) : undefined);
      await turn(app, bot, 'EMPTY-ONE：第一轮', 'empty-1');
      const task = await turn(app, bot, 'EMPTY-TWO：第二轮', 'empty-2');
      expect(String(app.store.get('SELECT summary FROM context_checkpoints WHERE task_id=?', task)!.summary)).toContain('EMPTY-NOTE-HISTORY');
      expect(note(app, bot)).toBeUndefined();
    }, 120000);

    it('keeps a single tool result digest plain text, without the note', async () => {
      const f = await fixture(), { app, fake, bot } = f;
      const doc = app.runtime.memory.write(bot, { title: '长资料', content: 'DIGEST-BODY ' + '资料'.repeat(1500) });
      fake.scripts.push({ action: 'memory.read', args: { documentId: doc.documentId } }, '第一轮完成', '第二轮完成', '第三轮完成');
      await turn(app, bot, 'DIGEST-ONE：读取资料', 'digest-1');
      await turn(app, bot, 'DIGEST-TWO：继续', 'digest-2');
      await turn(app, bot, 'DIGEST-THREE：继续', 'digest-3');
      const digests = summarizers(fake).filter(request => !instructionOf(request).includes('"workingNote"'));
      expect(digests.length).toBeGreaterThan(0);
      for (const request of digests) { expect(String((request.messages as Wire).at(-1)!.content)).not.toContain('现有工作笔记'); expect(instructionOf(request)).toContain('你整理连续对话'); }
      expect(note(app, bot)).toBeUndefined();
    }, 120000);
  });

  describe('tidy-up model', () => {
    const configure = (app: App, fake: Fixture['fake'], extra: Record<string, unknown> = {}) => {
      // The tidy-up model has its own limits; the chat model keeps its own.
      app.store.saveConfig({ provider: 'openai', endpoint: fake.origin + '/v1', model: 'fixture-memory', contextWindow: 16000, maxOutputTokens: 2048 });
      app.store.saveConfig({ provider: 'openai', endpoint: fake.origin + '/v1', model: 'fixture-chat', contextWindow: 64000, maxOutputTokens: 4096, ...extra });
    };
    it('is the assistant memory model when set, else the chat model, each with its own window', async () => {
      const { app, fake, bot } = await fixture(); configure(app, fake);
      expect(app.runtime.tidyModel(bot)).toMatchObject({ model: 'fixture-chat', contextWindow: 64000, maxOutputTokens: 4096 });
      app.runtime.memory.personal.save(bot, { version: 0, enabled: false, model: 'fixture-memory' });
      expect(app.runtime.tidyModel(bot)).toMatchObject({ model: 'fixture-memory', contextWindow: 16000, maxOutputTokens: 2048 });
      // A model the catalog and settings know nothing about gets the default limits, not the chat model's.
      app.runtime.memory.personal.save(bot, { version: 1, enabled: false, model: 'unlisted-memory' });
      expect(app.runtime.tidyModel(bot)).toMatchObject({ model: 'unlisted-memory', contextWindow: 256_000 });
      // A per-assistant chat model does not change which model tidies.
      app.runtime.memory.personal.save(bot, { version: 2, enabled: false, model: '' });
      expect(app.runtime.tidyModel(bot).model).toBe('fixture-chat');
    });

    it('sends every summarizer request to it: digests, turn summaries and episode archives', async () => {
      const f = await fixture({ contextBudget: 8000 }), { app, fake, bot } = f;
      configure(app, fake, { contextBudget: 8000 });
      app.runtime.memory.personal.save(bot, { version: 0, enabled: false, model: 'fixture-memory' });
      const doc = app.runtime.memory.write(bot, { title: '长资料', content: 'TIDY-BODY ' + '资料'.repeat(1500) });
      fake.scripts.push({ action: 'memory.read', args: { documentId: doc.documentId } }, '第一轮完成', '第二轮完成', '第三轮完成', '第四轮完成');
      await turn(app, bot, 'TIDY-ONE：读取资料', 'tidy-1');
      await turn(app, bot, 'TIDY-TWO：继续', 'tidy-2');
      advance(7 * HOUR);
      await turn(app, bot, 'TIDY-THREE：新话题', 'tidy-3');
      const kinds = new Set(summarizers(fake).map(request => instructionOf(request).includes('建立段落档案') ? 'episode' : instructionOf(request).includes('"workingNote"') ? 'history' : 'digest'));
      expect(kinds).toEqual(new Set(['digest', 'history', 'episode']));
      for (const request of summarizers(fake)) expect(request.model).toBe('fixture-memory');
      for (const request of streamed(fake)) expect(request.model).toBe('fixture-chat');
      expect(app.store.all('SELECT DISTINCT model FROM assistant_usage').map(row => row.model)).toEqual(['fixture-memory']);
    }, 180000);

    it('sizes summarizer batches by the tidy-up model window, not the chat model window', async () => {
      const f = await fixture(), { app, fake, bot } = f;
      configure(app, fake);
      app.runtime.memory.personal.save(bot, { version: 0, enabled: false, model: 'fixture-memory' });
      // Long turns accepted under a roomy working budget (a large explicit one stands in for it) ...
      app.store.saveConfig({ provider: 'openai', endpoint: fake.origin + '/v1', model: 'fixture-chat', contextWindow: 400000, maxOutputTokens: 4096, contextBudget: 400000 });
      for (let index = 0; index < 5; index++) { fake.scripts.push(`TIDY-REPLY-${index} ` + '回答'.repeat(5000)); await turn(app, bot, `积压第 ${index} 轮`, `tidy-batch-${index}`); }
      expect(count(app, 'context_checkpoints')).toBe(0);
      // ... then the chat window shrinks, while the summarizer keeps its 16,000 token window.
      app.store.saveConfig({ provider: 'openai', endpoint: fake.origin + '/v1', model: 'fixture-chat', contextWindow: 64000, maxOutputTokens: 4096, contextBudget: null });
      const before = fake.requests.length;
      await turn(app, bot, 'TIDY-NEXT：继续', 'tidy-batch-next');
      const compact = fake.requests.slice(before).filter(row => !row.stream);
      // Half the 16,000 token window per batch: a 64,000 token window would have needed far fewer requests.
      expect(compact.length).toBeGreaterThanOrEqual(5);
      for (const request of compact) {
        expect(request.model).toBe('fixture-memory');
        expect(tokens(request.messages) + Number(request.max_tokens)).toBeLessThan(16000);
        expect(Number(request.max_tokens)).toBeLessThanOrEqual(1600);
      }
      expect(JSON.stringify(compact.at(-1))).toContain('\\"role\\":\\"summary\\"');
      expect(withoutSystem(streamed(fake).at(-1)!)).not.toContain('TIDY-REPLY-0');
    }, 180000);
  });

  describe('archive requests', () => {
    it('reads the existing summary instead of the originals it covers, in window-sized batches', async () => {
      const f = await fixture({ contextBudget: 8000 }), { app, fake, bot } = f;
      // Two turns, the second folds the first into a turn summary ...
      await turn(app, bot, 'REUSE-ONE：最早的内容', 'reuse-1');
      await turn(app, bot, 'REUSE-TWO：随后的内容', 'reuse-2');
      expect(stored(app, bot).some(entry => entry.type === 'compaction')).toBe(true);
      // ... so the archive of the episode starts from that summary and reads only what came after it.
      advance(7 * HOUR);
      await turn(app, bot, 'REUSE-THREE：新话题', 'reuse-3');
      const [request] = episodeRequests(fake);
      const content = String((request.messages as Wire).at(-1)!.content);
      expect(content).toContain('"role":"summary"');
      expect(content).not.toContain('REUSE-ONE');
      expect(content).toContain('REUSE-TWO');
      expect(tokens(request.messages) + Number(request.max_tokens)).toBeLessThan(64000);
      const [episode] = episodes(app);
      // The first entry is the very first one of the episode, found through the summary's source range.
      const first = stored(app, bot).find(entry => entry.type === 'custom_message' && entry.content === 'REUSE-ONE：最早的内容')!;
      expect(episode.first_entry).toBe(first.id);
    }, 180000);

    it('archives a stretch larger than a summarizer window in batches, the last one producing the archive', async () => {
      const f = await fixture(), { app, fake, bot } = f;
      app.store.saveConfig({ provider: 'openai', endpoint: fake.origin + '/v1', model: 'fixture-memory', contextWindow: 16000, maxOutputTokens: 2048 });
      app.store.saveConfig({ provider: 'openai', endpoint: fake.origin + '/v1', model: 'fixture-chat', contextWindow: 400000, maxOutputTokens: 4096, contextBudget: 400000 });
      app.runtime.memory.personal.save(bot, { version: 0, enabled: false, model: 'fixture-memory' });
      for (let index = 0; index < 4; index++) { fake.scripts.push(`BATCH-REPLY-${index} ` + '回答'.repeat(5000)); await turn(app, bot, `BATCH-${index}：第 ${index} 轮`, `batch-${index}`); }
      advance(7 * HOUR);
      const before = fake.requests.length;
      await turn(app, bot, 'BATCH-NEW：新话题', 'batch-new');
      const compact = fake.requests.slice(before).filter(row => !row.stream);
      expect(compact.length).toBeGreaterThanOrEqual(3);
      for (const request of compact) expect(tokens(request.messages) + Number(request.max_tokens)).toBeLessThan(16000);
      // Only the final request asks for the archive; it reads the running summary, not the first batch again.
      expect(compact.slice(0, -1).every(request => !instructionOf(request).includes('建立段落档案'))).toBe(true);
      expect(instructionOf(compact.at(-1)!)).toContain('建立段落档案');
      expect(JSON.stringify(compact.at(-1))).toContain('\\"role\\":\\"summary\\"');
      expect(episodes(app)).toHaveLength(1);
      const request = withoutSystem(streamed(fake).at(-1)!);
      expect(request).toContain('BATCH-NEW'); expect(request).not.toContain('BATCH-REPLY-0');
    }, 240000);

    it('does not close an episode in a maintenance run', async () => {
      const { app } = await fixture();
      const events = app.runtime as unknown as { summarize(who: unknown, event: unknown): Promise<unknown> };
      await expect(events.summarize({ botId: 'x', conversationId: 'c', owner: 'maintain:1', purpose: 'maintain', signal: new AbortController().signal, recheck: async () => {} }, { type: 'compact', summaryKind: 'episode', text: '[]', firstEntry: 'a', lastEntry: 'b', episode: { firstEntry: 'a', lastEntry: 'b', startedAt: 1, endedAt: 2 }, entries: [] })).rejects.toThrow('段落范围无效');
    });
  });
});
