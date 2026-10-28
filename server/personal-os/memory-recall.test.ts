import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPersonalApp } from './index.ts';
import { CoreStore, hash, id, now } from './store.ts';
import { startFakePersonalMemory } from './testing/fake-personal-memory.ts';
import { startFakeRetrieval } from './testing/fake-retrieval.ts';
import { tokens } from './token-estimate.ts';
import { evaluateTool } from './policy.ts';
import { CORE_MEMORY_TOKENS, renderCore } from './core-memory.ts';
import { RECALL_GUARD_MS, TaskRecall, recallQuery, renderRecall, worthRecalling } from './task-recall.ts';
import { WORKING_NOTE_TOKENS } from './recall-schema.ts';

type App = Awaited<ReturnType<typeof createPersonalApp>>;
type Wire = Array<{ role: string; content: string }>;
interface Fixture { root: string; app: App; chat: Awaited<ReturnType<typeof startFakePersonalMemory>>; fake: Awaited<ReturnType<typeof startFakeRetrieval>>; bot: string }
const fixtures: Fixture[] = [];

async function fixture(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nex-recall-')), chat = await startFakePersonalMemory(), fake = await startFakeRetrieval();
  const app = await createPersonalApp({ dir: root, key: randomBytes(32), token: 'synthetic-token', identity: false, memoryRuntime: false, hostDevice: false });
  app.store.saveConfig({ provider: 'openai', endpoint: chat.origin + '/v1', model: 'fixture-chat', apiKey: 'synthetic-only', contextWindow: 64000, maxOutputTokens: 4096, ...extra });
  const bot = app.store.createBot('合成个人助手'); clearInterval(app.runtime.memory.personal.timer);
  // Background maintenance would add summarizer calls of its own; these tests look at the turn path.
  app.runtime.maintenanceIdle = 3_600_000;
  const result = { root, app, chat, fake, bot }; fixtures.push(result); return result;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { app, chat, fake, root } of fixtures.splice(0)) {
    await app.close(); await chat.close(); await fake.close();
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('nex-recall-')) throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
async function wait(check: () => boolean, app: App, limit = 25000) {
  const until = Date.now() + limit;
  while (!check()) {
    const failed = app.store.get("SELECT result_summary FROM tasks WHERE status='failed'"); if (failed) throw new Error(String(failed.result_summary));
    if (Date.now() > until) throw new Error('Fixture timeout: ' + JSON.stringify(app.store.all('SELECT status,result_summary FROM tasks')));
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
const finished = async (app: App, task: string, status = 'succeeded') => { await wait(() => app.store.get('SELECT status FROM tasks WHERE id=?', task)?.status === status, app); await wait(() => !app.runtime.workers.size, app); return task; };
const turn = (app: App, bot: string, text: string, key: string) => finished(app, app.agents.send(bot, text, key).taskId);
/** A turn in one particular conversation of the assistant. */
const turnIn = (app: App, conversation: string, text: string, key: string) => finished(app, app.runtime.input(conversation, text, key));
const streamed = (chat: Fixture['chat']) => chat.requests.filter((row) => row.stream);
const wire = (request: Record<string, unknown>) => request.messages as Wire;
const stableOf = (request: Record<string, unknown>) => String(wire(request).find((message) => message.role === 'system')?.content);
const volatileOf = (request: Record<string, unknown>) => String(wire(request).find((message) => message.role === 'user' && String(message.content).includes('<system-reminder>'))?.content);
const RECALL_HEADER = '按本次输入召回的相关记忆';
/** The recall block inside a volatile reminder ('' when there is none). */
const recallPart = (volatile: string) => volatile.includes(RECALL_HEADER) ? volatile.slice(volatile.indexOf(RECALL_HEADER), volatile.indexOf('</system-reminder>')).trimEnd() : '';
const instructionOf = (request: Record<string, unknown>) => stableOf(request);
const reply = (content: string) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const truncated = { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
const conversationOf = (app: App, bot: string) => String(app.store.get('SELECT id FROM conversations WHERE bot_id=? ORDER BY created_at,rowid LIMIT 1', bot)!.id);
const task = (app: App, key: string) => app.store.get('SELECT * FROM task_recall WHERE task_id=?', key);

/** A memory resting on a real, verifiable message of the assistant. Returns the memory id. */
function remember(app: App, bot: string, title: string, content: string, kind = 'fact') {
  const source = 'source-' + id();
  app.agents.publish(bot, 'user', 'message', content, source);
  const message = app.store.get('SELECT id,seq FROM agent_messages WHERE source_key=?', source)!;
  app.runtime.memory.personal.put(bot, kind, title, content, [{ id: String(message.id), hash: hash(content) }]);
  // The memory pump must not try to extract from the seed messages.
  app.store.run('UPDATE assistant_memory_settings SET cursor_seq=? WHERE bot_id=?', Number(message.seq), bot);
  return String(app.store.get('SELECT id FROM assistant_memories WHERE bot_id=? AND title=? ORDER BY created_at DESC', bot, title)!.id);
}
/** Long-term memory on, and the language-model steps of the pump idle, so a pump only vectorizes. */
function enableMemory(app: App) {
  app.runtime.memory.personal.saveGlobal({ version: 0, enabled: true });
  // A far-away backoff of the migration keeps it (and with it the topic merge) idle.
  app.store.run("INSERT OR REPLACE INTO assistant_memory_steps(bot_id,step,failures,next_at,error,updated_at) SELECT bot_id,'migrate',1,?,NULL,? FROM assistant_memory_settings", now() + 3_600_000, now());
}
async function embedAll(app: App, fake: Fixture['fake'], rerank = true) {
  const config = app.runtime.memory.retrieval.config;
  await config.save({ kind: 'embedding', baseUrl: fake.origin, model: 'fake-embed', enabled: true, version: config.view().embedding.version });
  if (rerank) await config.save({ kind: 'rerank', format: 'cohere', baseUrl: fake.origin, model: 'fake-rerank', enabled: true, version: config.view().rerank.version });
  app.store.run('UPDATE assistant_memory_settings SET next_attempt=0');
  await app.runtime.memory.personal.flush();
  fake.requests.length = 0;
}

describe('recall once per task', () => {
  it('recalls nothing for a short input, and does not call the embedding or rerank service', async () => {
    const { app, chat, fake, bot } = await fixture();
    remember(app, bot, '发布步骤', '周五晚上上线东京服务器，之后通知运维');
    enableMemory(app); await embedAll(app, fake);
    const first = await turn(app, bot, '好的', 'short-1');
    expect(task(app, first)).toMatchObject({ status: 'skipped', block: '', tokens: 0 });
    expect(volatileOf(streamed(chat).at(-1)!)).not.toContain(RECALL_HEADER);
    expect(fake.requests).toHaveLength(0);
    // Punctuation and spaces do not count towards the four characters.
    expect(worthRecalling('继续。')).toBe(false); expect(worthRecalling('  好 的 ！ ')).toBe(false); expect(worthRecalling('好的谢谢')).toBe(true); expect(worthRecalling('ok')).toBe(false);
    expect(Number(app.store.get("SELECT memory_tokens FROM model_invocations WHERE purpose='answer'")!.memory_tokens)).toBe(0);
  }, 60000);

  it('puts only the relevant items, within 2000 tokens and 400 per item, cut with a pointer to the original', async () => {
    const { app, chat, fake, bot } = await fixture();
    const near = remember(app, bot, '发布步骤', '周五晚上上线东京服务器，之后通知运维');
    remember(app, bot, '咖啡偏好', '喜欢拿铁咖啡');
    const long = Array.from({ length: 6 }, (_, index) => remember(app, bot, `上线长文${index}`, `上线记录${index} ` + '步骤说明细节'.repeat(500)));
    enableMemory(app); await embedAll(app, fake);
    // Every document mentions 上线, so the stand-in reranker would score them all alike and the row order (random ids)
    // would decide whether the short one fits the budget: score the one that answers the question higher.
    fake.state.scores = (_query, documents) => documents.map((document) => document.includes('周五晚上上线东京服务器') ? 0.95 : 0.9);
    const first = await turn(app, bot, '请问部署流程怎么走', 'related-1');
    const row = task(app, first)!, block = String(row.block);
    expect(row.status).toBe('recalled');
    expect(block).toContain('周五晚上上线东京服务器'); expect(block).toContain(`[memory:${near}]`);
    expect(block).not.toContain('拿铁');
    expect(Number(row.tokens)).toBe(tokens(block)); expect(tokens(block)).toBeLessThanOrEqual(2000);
    const lines = block.split('\n').slice(1);
    for (const line of lines) expect(tokens(line)).toBeLessThanOrEqual(400);
    const clipped = lines.filter((line) => line.includes('（原文见 memory:'));
    expect(clipped.length).toBeGreaterThan(0);
    for (const line of clipped) expect(long.some((key) => line.includes(`（原文见 memory:${key}）`))).toBe(true);
    // The block sits in the volatile reminder, never in the stable prompt, and the invocation records its size.
    const request = streamed(chat).at(-1)!;
    expect(recallPart(volatileOf(request))).toBe(block); expect(stableOf(request)).not.toContain('周五晚上上线东京服务器');
    expect(Number(app.store.get("SELECT memory_tokens FROM model_invocations WHERE purpose='answer'")!.memory_tokens)).toBe(Number(row.tokens));
    expect(Number(app.store.get("SELECT COUNT(*) n FROM assistant_usage WHERE task_id=? AND purpose='embed'", first)!.n)).toBe(1);
    expect(Number(app.store.get("SELECT COUNT(*) n FROM assistant_usage WHERE task_id=? AND purpose='rerank'", first)!.n)).toBe(1);
    // The task is recorded as having seen the memory: forgetting its source reaches it.
    expect(Number(app.store.get('SELECT COUNT(*) n FROM assistant_memory_uses WHERE task_id=?', first)!.n)).toBeGreaterThan(0);
  }, 60000);

  it('falls back to 1000 tokens when the reranker is down', async () => {
    const { app, chat, fake, bot } = await fixture();
    for (let index = 0; index < 6; index++) remember(app, bot, `上线长文${index}`, `上线记录${index} ` + '步骤说明细节'.repeat(500));
    enableMemory(app); await embedAll(app, fake);
    fake.state.rerankStatus = 500;
    const first = await turn(app, bot, '请问部署流程怎么走', 'unranked-1');
    const row = task(app, first)!;
    expect(row.status).toBe('recalled'); expect(Number(row.tokens)).toBeLessThanOrEqual(1000); expect(Number(row.tokens)).toBeGreaterThan(400);
    for (const line of String(row.block).split('\n').slice(1)) expect(tokens(line)).toBeLessThanOrEqual(400);
    expect(recallPart(volatileOf(streamed(chat).at(-1)!))).toBe(String(row.block));
  }, 60000);

  it('recalls exactly once for a task with several tool continuations and carries the same bytes in every request', async () => {
    const { app, chat, fake, bot } = await fixture();
    remember(app, bot, '发布步骤', '周五晚上上线东京服务器，之后通知运维');
    enableMemory(app); await embedAll(app, fake);
    chat.scripts.push(...Array.from({ length: 4 }, () => ({ action: 'agent.directory', args: {} })), '完成');
    const first = await turn(app, bot, '请问部署流程怎么走', 'continue-1');
    const requests = streamed(chat);
    expect(requests).toHaveLength(5);
    const parts = requests.map((request) => recallPart(volatileOf(request)));
    expect(parts[0]).toContain('周五晚上上线东京服务器');
    expect(new Set(parts).size).toBe(1);
    expect(fake.count('/embeddings')).toBe(1); expect(fake.count('/rerank')).toBe(1);
    // The other parts of the reminder do change (time), so the cache hit is the recall's, not the whole text.
    expect(new Set(requests.map((request) => volatileOf(request))).size).toBeGreaterThan(1);
    const invocations = app.store.all("SELECT memory_tokens FROM model_invocations WHERE purpose='answer'");
    expect(invocations).toHaveLength(5); expect(new Set(invocations.map((row) => row.memory_tokens))).toEqual(new Set([task(app, first)!.tokens]));
    // A restarted worker of the same task, or a fresh object over the same database, finds the stored recall.
    app.runtime.recalls.prepare(app.store.get('SELECT * FROM tasks WHERE id=?', first)!);
    const again = new TaskRecall(app.store, app.runtime.memory);
    expect(again.get(first)?.block).toBe(parts[0]);
    again.prepare(app.store.get('SELECT * FROM tasks WHERE id=?', first)!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.count('/embeddings')).toBe(1);
  }, 60000);

  it('continues the task with no block when the recall fails, and stores that outcome', async () => {
    const { app, chat, fake, bot } = await fixture();
    remember(app, bot, '发布步骤', '周五晚上上线东京服务器，之后通知运维');
    enableMemory(app); await embedAll(app, fake);
    const retrieve = vi.spyOn(app.runtime.memory.retrieval, 'retrieve').mockRejectedValue(new Error('boom'));
    chat.scripts.push({ action: 'agent.directory', args: {} }, '完成');
    const first = await turn(app, bot, '请问部署流程怎么走', 'fail-1');
    expect(app.store.get('SELECT status FROM tasks WHERE id=?', first)?.status).toBe('succeeded');
    expect(task(app, first)).toMatchObject({ status: 'failed', block: '', tokens: 0 });
    for (const request of streamed(chat)) expect(volatileOf(request)).not.toContain(RECALL_HEADER);
    expect(retrieve).toHaveBeenCalledTimes(1);
  }, 60000);

  it('does not hold the task up for a retrieval that never answers', async () => {
    const { app, chat, fake, bot } = await fixture();
    enableMemory(app); await embedAll(app, fake);
    vi.spyOn(app.runtime.memory.retrieval, 'retrieve').mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    const first = await turn(app, bot, '请问部署流程怎么走', 'slow-1');
    expect(Date.now() - started).toBeGreaterThanOrEqual(RECALL_GUARD_MS - 500);
    expect(Date.now() - started).toBeLessThan(RECALL_GUARD_MS + 8000);
    expect(task(app, first)).toMatchObject({ status: 'failed', block: '' });
    expect(volatileOf(streamed(chat).at(-1)!)).not.toContain(RECALL_HEADER);
  }, 60000);

  it('recalls nothing when long-term memory is off, and reads attachment names as the query', async () => {
    const { app, chat, bot } = await fixture();
    remember(app, bot, '发布步骤', '周五晚上上线东京服务器');
    const first = await turn(app, bot, '请问部署流程怎么走 上线', 'off-1');
    expect(task(app, first)).toMatchObject({ status: 'skipped', block: '' });
    expect(volatileOf(streamed(chat).at(-1)!)).not.toContain(RECALL_HEADER);
    expect(recallQuery(['看这个 ![图](/api/attachments/abc) 和 [部署手册.md](/api/attachments/def)'])).toBe('看这个 图 和 部署手册.md');
  }, 60000);

  it('takes the legacy engine path through the same once-per-task cache for an assistant that is still on it', async () => {
    const { app, chat, bot } = await fixture();
    // An assistant without personal-memory settings and a connected engine is on the legacy path.
    app.runtime.memory.ledger.client = {} as never;
    const legacy = vi.spyOn(app.runtime.memory.ledger, 'recall').mockResolvedValue({ status: 'available', facts: [{ ref: 'src-1', refs: ['src-1'], scope: 'bot', text: '旧引擎事实：周五上线东京', sourceClass: 'user_stated' }, { ref: 'src-2', refs: ['src-2'], scope: 'workspace', text: '旧引擎共享事实', sourceClass: 'user_stated' }] });
    chat.scripts.push(...Array.from({ length: 3 }, () => ({ action: 'agent.directory', args: {} })), '完成');
    const first = await turn(app, bot, '请问部署流程怎么走', 'legacy-1');
    const parts = streamed(chat).map((request) => recallPart(volatileOf(request)));
    expect(parts).toHaveLength(4); expect(new Set(parts).size).toBe(1);
    expect(parts[0]).toContain('- [src-1] 私有：旧引擎事实：周五上线东京'); expect(parts[0]).toContain('- [src-2] 共享：旧引擎共享事实');
    expect(legacy).toHaveBeenCalledTimes(1); expect(legacy).toHaveBeenCalledWith(bot, '请问部署流程怎么走');
    expect(task(app, first)).toMatchObject({ status: 'recalled', block: parts[0] });
    // The engine failing is no different from any other failure.
    legacy.mockRejectedValue(new Error('engine down'));
    const second = await turn(app, bot, '请问上线流程怎么走', 'legacy-2');
    expect(task(app, second)).toMatchObject({ status: 'failed', block: '' });
    expect(app.store.get('SELECT status FROM tasks WHERE id=?', second)?.status).toBe('succeeded');
  }, 60000);

  it('renders items in score order into the budget, each cut at 400 tokens, and drops what does not fit', () => {
    const items = Array.from({ length: 8 }, (_, index) => ({ ref: `memory:m${index}`, title: `标题${index}`, text: `内容${index} ` + '细节'.repeat(600) }));
    const full = renderRecall(items, 2000);
    expect(full.tokens).toBeLessThanOrEqual(2000); expect(full.refs.slice(0, 4)).toEqual(['memory:m0', 'memory:m1', 'memory:m2', 'memory:m3']); expect(full.refs.length).toBeLessThan(items.length);
    expect(renderRecall(items, 1000).tokens).toBeLessThanOrEqual(1000);
    expect(renderRecall(items, 1000).refs.length).toBeLessThan(full.refs.length);
    const short = renderRecall([{ ref: 'memory:s', title: '短', text: '一句话' }], 2000);
    expect(short.block).toContain('- [memory:s] 短：一句话'); expect(short.block).not.toContain('原文见');
    expect(renderRecall([], 2000)).toEqual({ block: '', tokens: 0, refs: [] });
  });
});

describe('core memory', () => {
  it('starts empty and sits in the stable prompt, byte-identical across turns until it is updated, then changes once', async () => {
    const { app, chat, bot } = await fixture();
    const turns: string[] = [];
    for (const [index, text] of ['第一轮：只讨论。', '第二轮：继续。'].entries()) turns.push(await turn(app, bot, text, 'core-' + index));
    expect(app.runtime.memory.core.read('bot', bot)).toMatchObject({ version: 0 });
    const [one, two] = streamed(chat);
    expect(stableOf(one)).toContain('核心记忆（版本 0）\n关于用户：暂无\n主题索引：暂无');
    expect(stableOf(two)).toBe(stableOf(one));
    // A line is added: the next prompt changes, the one after it does not.
    const result = app.runtime.memory.core.update(bot, { patch: { about: { add: ['用户叫小明，偏好中文'] }, topics: { add: [{ title: '部署流程', line: '周五上线东京', ref: 'memory:abc' }] } }, expectedVersion: 0 }, undefined, () => true);
    expect(result).toMatchObject({ saved: true, version: 1, changed: true });
    await turn(app, bot, '第三轮：继续。', 'core-3'); await turn(app, bot, '第四轮：继续。', 'core-4');
    const [, , three, four] = streamed(chat);
    expect(stableOf(three)).not.toBe(stableOf(one)); expect(stableOf(three)).toBe(stableOf(four));
    expect(stableOf(three)).toContain('核心记忆（版本 1）\n关于用户：\n- 用户叫小明，偏好中文\n主题索引：\n- 部署流程 — 周五上线东京 (memory:abc)');
    expect(volatileOf(three)).not.toContain('用户叫小明');
    expect(turns).toHaveLength(2);
    // An update that changes nothing does not change the prompt either.
    expect(app.runtime.memory.core.update(bot, { patch: { about: { add: ['用户叫小明，偏好中文'] } }, expectedVersion: 1 })).toMatchObject({ version: 1, changed: false });
    // No document dump: a memory document is not in the prompt.
    app.runtime.memory.write(bot, { title: '长文', content: 'DOCUMENT-DUMP-MARKER' });
    expect(app.runtime.memory.prompt(bot)).not.toContain('DOCUMENT-DUMP-MARKER');
  }, 90000);

  it('is updated by the model through memory.core.update, without approval, and visible in the next task', async () => {
    const { app, chat, bot } = await fixture();
    chat.scripts.push({ action: 'memory.core.update', args: { patch: { about: { add: ['用户叫小明'] } }, expectedVersion: 0 } }, '已记住');
    const first = await turn(app, bot, '记住我叫小明', 'core-tool');
    const call = app.store.get("SELECT * FROM tool_calls WHERE task_id=? AND tool_name='memory.core.update'", first)!;
    expect(call.status).toBe('succeeded'); expect(JSON.parse(String(call.result_json))).toMatchObject({ saved: true, version: 1 });
    expect(app.store.all("SELECT * FROM approvals WHERE tool_call_id=?", call.id)).toEqual([]);
    expect(app.store.get('SELECT committed_version FROM core_memory_receipts WHERE tool_call_id=?', call.id)?.committed_version).toBe(1);
    expect(app.store.get("SELECT details_json FROM audit_records WHERE action='memory.core.update'")?.details_json).toContain('"version":1');
    await turn(app, bot, '我叫什么', 'core-tool-2');
    expect(stableOf(streamed(chat).at(-1)!)).toContain('- 用户叫小明');
    // The system prompt tells the model what to do and when to search instead of guessing.
    expect(stableOf(streamed(chat).at(-1)!)).toContain('memory.core.update'); expect(stableOf(streamed(chat).at(-1)!)).toContain('先用 memory.search 查，不要猜');
    // A replayed call returns its first result instead of applying twice.
    expect(app.runtime.memory.core.update(bot, { patch: { about: { add: ['用户叫小明'] } }, expectedVersion: 0 }, String(call.id))).toMatchObject({ version: 1 });
    expect(app.runtime.memory.core.read('bot', bot).version).toBe(1);
  }, 60000);

  it('rejects a patch over 1500 tokens with a clear message and keeps the memory unchanged; rejects a stale version', async () => {
    const { app, chat, bot } = await fixture();
    const lines = Array.from({ length: 8 }, (_, index) => `第${index}条：` + '长期偏好说明'.repeat(45));
    expect(() => app.runtime.memory.core.update(bot, { patch: { about: { add: lines } }, expectedVersion: 0 })).toThrow(/超过 1500 Token.*合并.*删除/);
    expect(app.runtime.memory.core.read('bot', bot)).toMatchObject({ version: 0 });
    // Through the tool the model receives the same error and can merge lines.
    chat.scripts.push({ action: 'memory.core.update', args: { patch: { about: { add: lines } }, expectedVersion: 0 } }, '精简后再试');
    const first = await turn(app, bot, '记住这些偏好', 'core-big');
    const call = app.store.get("SELECT * FROM tool_calls WHERE task_id=? AND tool_name='memory.core.update'", first)!;
    expect(call.status).toBe('failed'); expect(String(call.result_json)).toContain('超过 1500 Token');
    // Lines up to the cap are accepted; the whole rendered text stays within it.
    const fits = lines.slice(0, 3);
    expect(app.runtime.memory.core.update(bot, { patch: { about: { add: fits } }, expectedVersion: 0 })).toMatchObject({ version: 1 });
    expect(tokens(app.runtime.memory.prompt(bot))).toBeLessThanOrEqual(CORE_MEMORY_TOKENS);
    expect(() => app.runtime.memory.core.update(bot, { patch: { about: { add: ['再加一条'] } }, expectedVersion: 0 })).toThrow('核心记忆已被更新（当前版本 1）');
    expect(() => app.runtime.memory.core.update(bot, { patch: { about: { add: ['x'] } }, expectedVersion: -1 })).toThrow('核心记忆版本无效');
  }, 60000);

  it('applies line patches by index and reference, and checks what they refer to', async () => {
    const { app, bot } = await fixture();
    const core = app.runtime.memory.core, memory = app.runtime.memory.write(bot, { title: '手册', content: '部署手册正文' }).documentId as string;
    const call = (patch: unknown, expectedVersion: number) => core.update(bot, { patch, expectedVersion }, undefined, (ref) => app.runtime.memory.refExists(bot, ref));
    call({ about: { add: ['甲', '乙', '丙'] }, topics: { add: [{ title: '部署', line: '周五上线', ref: `memory:${memory}` }, { title: '咖啡', line: '喜欢拿铁', ref: '' }] } }, 0);
    call({ about: { update: [{ index: 2, text: '乙二' }], remove: [3] }, topics: { update: [{ ref: `memory:${memory}`, line: '周五晚上线', newRef: `memory:${memory}` }], remove: [{ index: 2 }] } }, 1);
    expect(core.read('bot', bot).content).toEqual({ about: ['甲', '乙二'], topics: [{ title: '部署', line: '周五晚上线', ref: `memory:${memory}` }] });
    expect(() => call({ about: { remove: [5] } }, 2)).toThrow('关于用户没有第 5 条');
    expect(() => call({ about: { update: [{ index: 1, text: 'a' }], remove: [1] } }, 2)).toThrow('被多次修改');
    expect(() => call({ topics: { add: [{ title: '假', line: '不存在', ref: 'memory:does-not-exist' }] } }, 2)).toThrow('不存在或不可读取');
    expect(() => call({ topics: { add: [{ title: '重复', line: '同一引用', ref: `memory:${memory}` }] } }, 2)).toThrow('请改用 update');
    expect(() => call({ topics: { add: [{ title: '坏引用', line: 'x', ref: 'http://x' }] } }, 2)).toThrow('主题引用须形如');
    expect(() => call({ other: {} }, 2)).toThrow('patch 只支持');
    expect(core.read('bot', bot).version).toBe(2);
  });

  it('is allowed exactly where memory.write is: same grant, no approval in either permission mode, workspace scope only for the owner', async () => {
    const { app, bot } = await fixture();
    const args = { action: 'memory.core.update', patch: { about: { add: ['x'] } }, expectedVersion: 0 };
    expect(evaluateTool(app.store, bot, args).approvalRequired).toBe(false);
    expect(evaluateTool(app.store, bot, { action: 'memory.write', title: 't', content: 'c' }).approvalRequired).toBe(false);
    app.store.run('INSERT INTO agent_approval_settings(bot_id,mode,version) VALUES(?,?,1)', bot, 'full');
    expect(evaluateTool(app.store, bot, args).approvalRequired).toBe(false);
    expect(() => evaluateTool(app.store, bot, { ...args, scope: 'workspace' })).toThrow('共享核心记忆请由用户');
    expect(() => app.runtime.memory.core.update(bot, { ...args, scope: 'workspace' })).toThrow('共享核心记忆请由用户');
    expect(() => evaluateTool(app.store, bot, { action: 'memory.core.update', expectedVersion: 0 })).toThrow('核心记忆补丁无效');
    // Without the memory.write grant there is no core update either.
    const policy = app.store.get('SELECT version FROM bot_policies WHERE bot_id=?', bot)!;
    app.store.run('UPDATE bot_policies SET policy_json=?,version=? WHERE bot_id=?', JSON.stringify({ tools: ['memory.search', 'memory.read'] }), Number(policy.version) + 1, bot);
    expect(() => evaluateTool(app.store, bot, args)).toThrow('无权');
    expect(() => evaluateTool(app.store, bot, { action: 'memory.write', title: 't', content: 'c' })).toThrow('无权');
    app.store.run('UPDATE bot_policies SET policy_json=?,version=version+1 WHERE bot_id=?', JSON.stringify({ tools: ['memory.write'] }), bot);
    expect(evaluateTool(app.store, bot, args).approvalRequired).toBe(false);
  });

  it('holds the shared workspace lines too, within the same 1500 tokens, and drops lines pointing at forgotten sources', async () => {
    const { app, bot } = await fixture();
    const peer = app.store.createBot('同伴助手'), core = app.runtime.memory.core;
    core.replace('workspace', '', { about: ['全员：回答先说结论'], topics: [{ title: '共享手册', line: '部署规范', ref: 'memory:shared-doc' }] }, 0);
    for (const key of [bot, peer]) {
      const text = core.render(key);
      expect(text).toContain('- [共享] 全员：回答先说结论'); expect(text).toContain('- [共享] 共享手册 — 部署规范 (memory:shared-doc)');
    }
    // The assistant's own lines come first and are the only ones its patches address.
    core.update(bot, { patch: { about: { add: ['私有一条'] } }, expectedVersion: 0 });
    expect(core.render(bot).indexOf('- 私有一条')).toBeLessThan(core.render(bot).indexOf('[共享] 全员'));
    expect(core.render(peer)).not.toContain('私有一条');
    // The shared lines count against every assistant: they cannot grow past what the fullest assistant leaves.
    core.update(bot, { patch: { about: { add: Array.from({ length: 3 }, (_, index) => `填充${index}：` + '长期偏好说明'.repeat(45)) } }, expectedVersion: 1 });
    const shared = core.read('workspace');
    expect(() => core.replace('workspace', '', { about: Array.from({ length: 4 }, (_, index) => `共享填充${index}：` + '长期偏好说明'.repeat(45)), topics: [] }, shared.version)).toThrow('超过 1500 Token');
    expect(core.read('workspace').version).toBe(shared.version);
    // Forgetting a document removes the topic lines that point at it.
    const doc = app.runtime.memory.write(bot, { title: '要忘记的', content: 'FORGET-DOC-BODY' }).documentId as string;
    core.update(bot, { patch: { topics: { add: [{ title: '忘记我', line: '指向已忘记文档', ref: `memory:${doc}` }] } }, expectedVersion: 2 });
    expect(core.render(bot)).toContain(`memory:${doc}`);
    const plan = app.runtime.memory.privacy.preview(bot, { documentId: doc });
    app.runtime.memory.forget(bot, { documentId: doc }, plan.revision);
    expect(core.render(bot)).not.toContain(`memory:${doc}`); expect(core.render(bot)).not.toContain('指向已忘记文档');
    expect(core.render(bot)).toContain('- 私有一条');
  });

  it('is read and replaced by the owner over /api/memory/core, with the version check and the cap', async () => {
    const { app, bot } = await fixture();
    const call = (route: string, data?: unknown) => fetch(app.origin + '/api/' + route, { ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }), headers: { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/json' } });
    const read = await call('memory/core?botId=' + bot);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ limit: 1500, bot: { version: 0, content: { about: [], topics: [] } }, workspace: { version: 0 } });
    const saved = await call('memory/core', { botId: bot, scope: 'bot', about: ['称呼：小明', '语言：中文'], topics: [{ title: '部署', line: '周五上线', ref: 'memory:abc' }], version: 0 });
    expect(saved.status).toBe(200);
    const view = await saved.json() as { bot: { version: number; content: { about: string[] } }; rendered: string; tokens: number };
    expect(view.bot.version).toBe(1); expect(view.bot.content.about).toEqual(['称呼：小明', '语言：中文']);
    expect(view.rendered).toBe(app.runtime.memory.prompt(bot)); expect(view.tokens).toBe(tokens(view.rendered));
    const shared = await call('memory/core', { botId: bot, scope: 'workspace', about: ['全员共享'], topics: [], version: 0 });
    expect(shared.status).toBe(200); expect((await (await call('memory/core?botId=' + bot)).json() as { workspace: { content: { about: string[] } } }).workspace.content.about).toEqual(['全员共享']);
    const stale = await call('memory/core', { botId: bot, scope: 'bot', about: ['x'], topics: [], version: 0 });
    expect(stale.status).toBe(400); expect(await stale.json()).toMatchObject({ error: expect.stringContaining('核心记忆已被更新') });
    const big = await call('memory/core', { botId: bot, scope: 'bot', about: Array.from({ length: 8 }, (_, index) => `第${index}条：` + '长期偏好说明'.repeat(45)), topics: [], version: 1 });
    expect(big.status).toBe(400); expect(await big.json()).toMatchObject({ error: expect.stringContaining('超过 1500 Token') });
    expect((await call('memory/core', { botId: bot, scope: 'bot', about: [''], topics: [], version: 1 })).status).toBe(400);
    expect((await fetch(app.origin + '/api/memory/core?botId=' + bot)).status).toBe(401);
  });

  it('renders deterministically', () => {
    const content = { about: ['甲', '乙'], topics: [{ title: '标题', line: '一句话', ref: 'memory:1' }, { title: '无引用', line: '没有引用', ref: '' }] };
    expect(renderCore(content, { about: [], topics: [] }, 3)).toBe('核心记忆（版本 3）\n关于用户：\n- 甲\n- 乙\n主题索引：\n- 标题 — 一句话 (memory:1)\n- 无引用 — 没有引用');
    expect(renderCore(content, { about: [], topics: [] }, 3)).toBe(renderCore(JSON.parse(JSON.stringify(content)), { about: [], topics: [] }, 3));
  });
});

describe('working notes per conversation', () => {
  const note = (app: App, conversation: string) => app.store.get('SELECT * FROM conversation_working_notes WHERE conversation_id=?', conversation);
  const write = (content: string, expectedVersion = 0) => ({ action: 'memory.write', args: { scope: 'context', title: '工作笔记', content, expectedVersion } });

  it('keeps the notes of two conversations of one assistant apart, and shows only the current one', async () => {
    const { app, chat, bot } = await fixture();
    const a = app.store.createConversation(bot, '甲'), b = app.store.createConversation(bot, '乙');
    chat.scripts.push(write('NOTE-A：只做甲'), '甲完成', write('NOTE-B：只做乙'), '乙完成', '甲再来', '乙再来');
    await turnIn(app, a, '甲会话开始', 'ca-1'); await turnIn(app, b, '乙会话开始', 'cb-1');
    expect(note(app, a)).toMatchObject({ content: 'NOTE-A：只做甲', version: 1, bot_id: bot }); expect(note(app, b)).toMatchObject({ content: 'NOTE-B：只做乙', version: 1 });
    await turnIn(app, a, '甲会话继续', 'ca-2'); await turnIn(app, b, '乙会话继续', 'cb-2');
    const [, , , , forA, forB] = streamed(chat);
    expect(volatileOf(forA)).toContain('NOTE-A：只做甲'); expect(volatileOf(forA)).not.toContain('NOTE-B');
    expect(volatileOf(forB)).toContain('NOTE-B：只做乙'); expect(volatileOf(forB)).not.toContain('NOTE-A');
    // The prompt carries no other conversation's work, no keyword-triggered history and no archive list.
    for (const request of streamed(chat)) for (const gone of ['otherRecentWork', 'recalledHistory', 'relatedEpisodes', '长期记忆引擎结果']) expect(volatileOf(request)).not.toContain(gone);
    expect(volatileOf(forA)).not.toContain('乙会话开始');
    expect(app.store.get('SELECT COUNT(*) n FROM assistant_working_notes')!.n).toBe(0);
  }, 90000);

  it('refuses a model write over 1000 tokens, asks for a shorter one and accepts it', async () => {
    const { app, chat, bot } = await fixture();
    const tooLong = '笔记内容'.repeat(300), fits = '笔记内容'.repeat(100);
    expect(tokens(tooLong)).toBeGreaterThan(WORKING_NOTE_TOKENS); expect(tokens(fits)).toBeLessThan(WORKING_NOTE_TOKENS);
    chat.scripts.push(write(tooLong), write(fits), '完成');
    const first = await turn(app, bot, '记一下笔记', 'note-long');
    const [rejected, accepted] = app.store.all("SELECT status,result_json FROM tool_calls WHERE task_id=? AND tool_name='memory.write' ORDER BY created_at,rowid", first);
    expect(rejected.status).toBe('failed'); expect(String(rejected.result_json)).toContain('工作笔记超过 1000 Token，请精简后重写');
    expect(accepted.status).toBe('succeeded');
    expect(note(app, conversationOf(app, bot))).toMatchObject({ content: fits, version: 1 });
    expect(app.runtime.systemPrompt(first)).toContain(fits.slice(0, 20));
  }, 60000);

  describe('written by Core', () => {
    // Core folds older turns only when a request does not fit the input limit H (57,856 for this window), or in the
    // background after 55 idle minutes (compaction-timing.md). Two inputs of about 25k tokens do not fit together, so
    // the second turn folds the first into a turn summary, which carries a working note. The small budget keeps the
    // tail of full turns to the latest one.
    const folding = { contextBudget: 8000 };
    const bulk = (label: string) => label + ' ' + '合成资料'.repeat(4200);
    const long = '长笔记条目：'.repeat(300);
    const summarizer = (chat: Fixture['chat'], compression: () => unknown) => chat.setOverride((body) => {
      if (body.stream) return undefined;
      const instruction = instructionOf(body);
      if (instruction.includes('你压缩工作笔记')) return compression();
      if (instruction.includes('"workingNote"') && !instruction.includes('建立段落档案')) return reply(JSON.stringify({ workingNote: long, history: 'HISTORY-ONLY：旧回合摘要' }));
      return undefined;
    });
    const compressions = (chat: Fixture['chat']) => chat.requests.filter((row) => !row.stream && instructionOf(row).includes('你压缩工作笔记'));

    it('compresses a note over the cap with the tidy-up model instead of cutting it', async () => {
      const { app, chat, bot } = await fixture(folding);
      expect(tokens(long)).toBeGreaterThan(WORKING_NOTE_TOKENS);
      summarizer(chat, () => reply('压缩后的笔记：只讨论，不部署；待验证长期记忆。'));
      await turn(app, bot, bulk('NOTE-ONE：第一轮'), 'core-note-1');
      const second = await turn(app, bot, bulk('NOTE-TWO：第二轮'), 'core-note-2');
      expect(compressions(chat).length).toBeGreaterThan(0);
      expect(String(wire(compressions(chat)[0]).at(-1)!.content)).toBe(long);
      expect(instructionOf(compressions(chat)[0])).toContain('800 Token');
      expect(note(app, conversationOf(app, bot))).toMatchObject({ content: '压缩后的笔记：只讨论，不部署；待验证长期记忆。', version: 1, task_id: second });
      expect(String(app.store.get('SELECT summary FROM context_checkpoints WHERE task_id=?', second)!.summary)).toContain('HISTORY-ONLY');
      expect(Number(app.store.get("SELECT COUNT(*) n FROM assistant_usage WHERE task_id=? AND purpose='compact'", second)!.n)).toBeGreaterThanOrEqual(2);
    }, 120000);

    it.each([['the compression fails', () => truncated], ['the compressed note is still over the cap', () => reply(long)]])('keeps the old note and the summary when %s', async (_name, compression) => {
      const { app, chat, bot } = await fixture(folding);
      summarizer(chat, compression);
      await turn(app, bot, bulk('KEEP-ONE：第一轮'), 'keep-note-1');
      const conversation = conversationOf(app, bot);
      app.store.run('INSERT INTO conversation_working_notes(conversation_id,bot_id,content,task_id,version,updated_at) VALUES(?,?,?,?,?,?)', conversation, bot, 'EXISTING-NOTE', 'earlier-task', 3, 1);
      const second = await turn(app, bot, bulk('KEEP-TWO：第二轮'), 'keep-note-2');
      expect(compressions(chat).length).toBeGreaterThan(0);
      expect(note(app, conversation)).toMatchObject({ content: 'EXISTING-NOTE', version: 3, task_id: 'earlier-task' });
      expect(String(app.store.get('SELECT summary FROM context_checkpoints WHERE task_id=?', second)!.summary)).toContain('HISTORY-ONLY');
      expect(app.store.get('SELECT status FROM tasks WHERE id=?', second)?.status).toBe('succeeded');
    }, 120000);
  });

  it('is removed with the conversation it belongs to when its work is forgotten', async () => {
    const { app, chat, bot } = await fixture();
    chat.scripts.push(write('FORGET-NOTE：这条笔记要被遗忘'), '完成');
    const first = await turn(app, bot, 'FORGET-MARK 记一下', 'forget-1');
    const conversation = conversationOf(app, bot);
    expect(note(app, conversation)).toBeTruthy(); expect(task(app, first)).toBeTruthy();
    const plan = app.runtime.memory.privacy.preview(bot, { query: 'forget-mark' });
    expect(plan.tasks).toContain(first);
    app.runtime.memory.forget(bot, { query: 'forget-mark' }, plan.revision);
    expect(note(app, conversation)).toBeUndefined(); expect(task(app, first)).toBeUndefined();
    expect(app.store.get('SELECT COUNT(*) n FROM conversation_working_notes')!.n).toBe(0);
  }, 60000);
});

describe('migration 34', () => {
  it('copies each assistant\'s working note into its most recently active conversation, keeps the old table, and cuts a note over the cap', async () => {
    const { app, bot } = await fixture();
    const other = app.store.createBot('另一个助手'), spare = app.store.createBot('没有笔记的助手');
    const older = app.store.createConversation(bot, '旧'), newer = app.store.createConversation(bot, '新');
    const lone = app.store.createConversation(other, '独');
    app.store.accept(older, '旧会话的输入', 'm-old'); app.store.accept(newer, '新会话的输入', 'm-new'); app.store.accept(lone, '独立会话的输入', 'm-lone');
    // The older conversation was created later but written to earlier.
    app.store.run('UPDATE conversation_inputs SET created_at=? WHERE conversation_id=?', 1000, newer);
    app.store.run('UPDATE conversation_inputs SET created_at=? WHERE conversation_id=?', 5000, older);
    const huge = '很长的旧笔记。'.repeat(400);
    app.store.run('INSERT INTO assistant_working_notes(bot_id,content,task_id,version,updated_at) VALUES(?,?,?,?,?)', bot, '旧笔记：只讨论，不部署', 'task-x', 4, 7);
    app.store.run('INSERT INTO assistant_working_notes(bot_id,content,task_id,version,updated_at) VALUES(?,?,?,?,?)', other, huge, 'task-y', 2, 8);
    app.store.db.exec('DROP TABLE conversation_working_notes; DROP TABLE task_recall; DROP TABLE core_memory_receipts; DROP TABLE assistant_core_memory; DELETE FROM schema_migrations WHERE version=34');
    for (let round = 0; round < 2; round++) {
      const reopened = new CoreStore(app.store.dir, app.store.key, 'synthetic-token');
      try {
        expect(reopened.get('SELECT COUNT(*) n FROM schema_migrations WHERE version=34')!.n).toBe(1);
        expect(reopened.get('SELECT * FROM conversation_working_notes WHERE conversation_id=?', older)).toMatchObject({ bot_id: bot, content: '旧笔记：只讨论，不部署', task_id: 'task-x', version: 4, updated_at: 7 });
        expect(reopened.get('SELECT COUNT(*) n FROM conversation_working_notes WHERE conversation_id=?', newer)!.n).toBe(0);
        const cut = reopened.get('SELECT content FROM conversation_working_notes WHERE conversation_id=?', lone)!;
        expect(tokens(cut.content)).toBeLessThanOrEqual(WORKING_NOTE_TOKENS); expect(String(cut.content)).toContain('已截断');
        expect(reopened.get('SELECT COUNT(*) n FROM conversation_working_notes')!.n).toBe(2);
        expect(reopened.get('SELECT COUNT(*) n FROM assistant_working_notes')!.n).toBe(2);
        expect(reopened.get('SELECT COUNT(*) n FROM assistant_core_memory')!.n).toBe(0);
        // Running it again changes nothing.
        if (round === 0) reopened.run('DELETE FROM schema_migrations WHERE version=34');
      } finally { reopened.close(); }
    }
    void spare;
  });
});

describe('what leaves the prompt', () => {
  it('has no document dump, no other-conversation work, no keyword history, no archive list and no engine block', async () => {
    const { app, chat, bot } = await fixture();
    app.runtime.memory.write(bot, { title: '长文', content: 'DOCUMENT-DUMP-MARKER ' + '资料'.repeat(200) });
    const other = app.store.createConversation(bot, '别的会话');
    chat.scripts.push('别处完成', '主会话完成');
    await turnIn(app, other, 'OTHER-CONVERSATION-MARKER 在别处工作', 'gone-1');
    await turn(app, bot, '之前我们在别处做了什么', 'gone-2');
    const request = streamed(chat).at(-1)!, all = JSON.stringify(wire(request));
    for (const gone of ['DOCUMENT-DUMP-MARKER', 'OTHER-CONVERSATION-MARKER', 'otherRecentWork', 'recalledHistory', 'relatedEpisodes', '长期记忆引擎结果']) expect(all, gone).not.toContain(gone);
    expect(volatileOf(request)).toContain('"history":"通过 memory.search 搜索早期原文');
    expect(volatileOf(request)).toContain('"checkpoint"');
  }, 60000);
});
