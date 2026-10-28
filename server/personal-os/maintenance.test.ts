import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager, type FileEntry } from '@earendil-works/pi-coding-agent';
import { createPersonalApp } from './index.ts';
import { startFakePersonalMemory } from './testing/fake-personal-memory.ts';
import { CoreStore } from './store.ts';
import { assistantCompletion, maintainUsage, MAINTAIN_DAILY_TOKENS } from './assistant-model.ts';
import { branchOf, maintenanceWork, projectEntries } from './context-tools.ts';
import { tokens } from './token-estimate.ts';

type Fixture = { root: string; fake: Awaited<ReturnType<typeof startFakePersonalMemory>>; app: Awaited<ReturnType<typeof createPersonalApp>>; bot: string };
type App = Fixture['app'];
const fixtures: Fixture[] = [];
async function fixture(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nex-maintenance-')), fake = await startFakePersonalMemory();
  const app = await createPersonalApp({ dir: root, key: randomBytes(32), token: 'synthetic-token', identity: false, memoryRuntime: false, hostDevice: false });
  app.store.saveConfig({ provider: 'openai', endpoint: fake.origin + '/v1', model: 'fixture-chat', apiKey: 'synthetic-only', contextWindow: 64000, maxOutputTokens: 4096, ...extra });
  const bot = app.store.createBot('合成个人助手'); clearInterval(app.runtime.memory.personal.timer);
  // The 10 s idle delay is injectable; tests use a short one.
  app.runtime.maintenanceDelay = 50;
  const result = { root, fake, app, bot }; fixtures.push(result); return result;
}
async function wait(check: () => boolean, app: App, limit = 25000) {
  const until = Date.now() + limit;
  while (!check()) {
    const failed = app.store.get("SELECT result_summary FROM tasks WHERE status='failed'"); if (failed) throw new Error(String(failed.result_summary));
    if (Date.now() > until) throw new Error('Fixture timeout: ' + JSON.stringify(app.store.all('SELECT status,result_summary FROM tasks')) + JSON.stringify(app.store.all('SELECT status,error FROM maintenance_runs')));
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
afterEach(async () => { for (const { app, fake, root } of fixtures.splice(0)) { await app.close(); await fake.close(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('nex-maintenance-')) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }); } });

const turn = async (app: App, bot: string, text: string, key: string) => {
  const task = app.agents.send(bot, text, key).taskId;
  await wait(() => app.store.get('SELECT status FROM tasks WHERE id=?', task)?.status === 'succeeded', app);
  while (app.runtime.workers.size) await sleep(20);
  return task;
};
const count = (app: App, table: string, where = '1=1') => Number(app.store.get(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`)!.n);
const finished = (app: App, runs = 1) => wait(() => count(app, 'maintenance_runs', "status<>'active'") >= runs && !app.runtime.maintenance.size, app);
const streamed = (fake: Fixture['fake']) => fake.requests.filter(row => row.stream);
const summarizers = (fake: Fixture['fake']) => fake.requests.filter(row => !row.stream);
const runtimeOf = (app: App, bot: string) => String(app.store.get('SELECT id FROM runtime_sessions WHERE bot_id=?', bot)!.id);
const conversationOf = (app: App, bot: string) => String(app.store.get('SELECT conversation_id FROM runtime_sessions WHERE bot_id=?', bot)!.conversation_id);
const bigDoc = (app: App, bot: string, label: string) => app.runtime.memory.write(bot, { title: label, content: `${label} ` + '资料'.repeat(1500) });
const withoutSystem = (request: Record<string, unknown>) => JSON.stringify((request.messages as Array<{ role: string }>).filter(message => message.role !== 'system' && message.role !== 'developer'));
const stored = (app: App, bot: string) => app.runtime.projection.load(runtimeOf(app, bot))!;
const edits = (app: App, bot: string) => stored(app, bot).filter(entry => entry.type === 'context_edit');

// Synthetic projections built with the SDK itself, as a worker would store them.
type Turn = { text: string; result?: string; image?: boolean; reply?: string };
function build(turns: Turn[], more?: (manager: SessionManager) => void) {
  const manager = SessionManager.inMemory('/maintenance-test');
  manager.appendMessage({ role: 'system', content: 'PROMPT', timestamp: 1 } as never);
  turns.forEach((item, index) => {
    manager.appendCustomMessageEntry('nex.input', item.text, false, { inputId: 'i' + index, hash: 'h', seq: index });
    if (item.result !== undefined) {
      manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'c' + index, name: 'broker', arguments: { action: 'memory.read' } }], stopReason: 'toolUse', timestamp: 2 } as never);
      manager.appendMessage({ role: 'toolResult', toolCallId: 'c' + index, toolName: 'broker', content: [{ type: 'text', text: item.result }, ...(item.image ? [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] : [])], isError: false, timestamp: 3 } as never);
    }
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: item.reply ?? '完成' }], stopReason: 'stop', timestamp: 4 } as never);
    manager.appendCustomEntry('nex.settled', { inputs: ['i' + index], text: '完成' });
  });
  more?.(manager);
  return { manager, entries: [manager.getHeader()!, ...manager.getEntries()] as FileEntry[] };
}
const resultId = (entries: FileEntry[], call: string) => entries.find(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === call)!.id;
const params = { contextWindow: 64000, maxOutputTokens: 4096, systemPrompt: 'S', volatilePrompt: 'V' };
const big = '资料'.repeat(1500);

describe('Background maintenance of the projection', () => {
  describe('decision', () => {
    it('has no work without a stored projection, for small turns and for the latest completed turn however large', () => {
      expect(maintenanceWork(undefined, params)).toMatchObject({ work: false, reason: null });
      expect(maintenanceWork(build([{ text: '你好' }]).entries, params).work).toBe(false);
      // Large results and images of the latest completed turn stay complete.
      expect(maintenanceWork(build([{ text: '读取', result: big, image: true }]).entries, params).work).toBe(false);
      expect(maintenanceWork(build([{ text: '一' }, { text: '读取', result: big, image: true }]).entries, params).work).toBe(false);
      // A single turn far above the trigger has nothing older to fold.
      const giant = maintenanceWork(build([{ text: '长', reply: '回答'.repeat(30000) }]).entries, params);
      expect(giant.estimate).toBeGreaterThan(giant.trigger);
      expect(giant.work).toBe(false);
    });
    it('finds a large result or an image once its turn is older than the latest completed one, and not again after the edit', () => {
      const { manager, entries } = build([{ text: '读取', result: big }, { text: '继续' }]);
      expect(maintenanceWork(entries, params)).toMatchObject({ work: true, reason: 'digest' });
      expect(maintenanceWork(build([{ text: '读取', result: '小' }, { text: '继续' }]).entries, params).work).toBe(false);
      expect(maintenanceWork(build([{ text: '看图', result: '小', image: true }, { text: '继续' }]).entries, params)).toMatchObject({ work: true, reason: 'digest' });
      manager.appendContextEdit(resultId(entries, 'c0'), { content: [{ type: 'text', text: '摘要' }] });
      expect(maintenanceWork([manager.getHeader()!, ...manager.getEntries()] as FileEntry[], params).work).toBe(false);
    });
    it('starts folding at 70% of the calibrated working budget and only when older turns exist', () => {
      const turns = Array.from({ length: 40 }, (_, index) => ({ text: `第${index}轮`, reply: '回答'.repeat(300) }));
      const { entries } = build(turns);
      const verdict = maintenanceWork(entries, params);
      expect(verdict).toMatchObject({ work: true, reason: 'budget' });
      expect(verdict.trigger).toBe(Math.floor(51200 * .7));
      expect(verdict.estimate).toBeGreaterThanOrEqual(verdict.trigger);
      // The calibrated count is what is compared; a roomier budget moves the line.
      expect(maintenanceWork(entries, { ...params, calibration: .5 }).work).toBe(false);
      expect(maintenanceWork(entries, { ...params, contextWindow: 400000, contextBudget: 200000 }).work).toBe(false);
      // The raw count reaching 90% of the window starts it whatever the ratio reads.
      expect(maintenanceWork(entries, { ...params, calibration: .01, contextWindow: Math.floor(verdict.estimate / .95) }).work).toBe(true);
      // A summary alone is not folded into another summary.
      const first = entries.find(entry => entry.type === 'custom_message' && entry.content === '第35轮')!;
      const folded = build(turns, manager => manager.appendCompaction('SUMMARY', first.id, 9, {} as never));
      expect(maintenanceWork(folded.entries, params).work).toBe(false);
    });
    it('projects like the SDK, so the estimate Core makes is the one the worker sees', () => {
      const { manager, entries } = build([{ text: '一', result: big, image: true }, { text: '二', result: '小' }, { text: '三' }, { text: '四' }, { text: '五' }], m => {
        const all = m.getEntries();
        m.appendContextEdit(all.find(entry => entry.type === 'message' && entry.message.role === 'toolResult')!.id, { content: [{ type: 'text', text: '摘要' }] });
        m.appendContextEdit(all.find(entry => entry.type === 'custom_message')!.id, null);
        m.appendCompaction('SUMMARY', all.find(entry => entry.type === 'custom_message' && entry.content === '三')!.id, 4321, {} as never);
        m.appendCustomMessageEntry('nex.input', '六', false, { inputId: 'x', hash: 'h', seq: 9 });
      });
      const sdk = SessionManager.inMemory('/maintenance-test', undefined, entries).buildSessionProjection();
      const mine = projectEntries(entries);
      expect(mine.map(item => item.sourceEntry.id)).toEqual(sdk.entries.map(item => item.sourceEntry.id));
      expect(mine.map(item => item.messages)).toEqual(sdk.entries.map(item => item.messages));
      expect(tokens(mine.flatMap(item => item.messages))).toBe(tokens(sdk.messages));
      expect(branchOf(entries)).toHaveLength(entries.length - 1);
      expect(manager.getEntries().some(entry => entry.type === 'compaction')).toBe(true);
    });
  });

  it('schedules nothing without work, digests older results after the turn, and leaves the next turn no summarizer call', async () => {
    const { app, fake, bot } = await fixture();
    const one = bigDoc(app, bot, 'MAINT-ONE');
    fake.scripts.push({ action: 'memory.read', args: { documentId: one.documentId } }, '第一轮完成', '第二轮完成', '第三轮完成');
    await turn(app, bot, '第一轮：读取资料', 'maint-1');
    // The large result belongs to the latest completed turn: no timer, no run.
    expect(app.runtime.maintenanceTimers.size).toBe(0);
    await sleep(300);
    expect(count(app, 'maintenance_runs')).toBe(0);
    expect(summarizers(fake)).toHaveLength(0);
    await turn(app, bot, '第二轮：继续', 'maint-2');
    await finished(app);
    const run = app.store.get('SELECT * FROM maintenance_runs')!;
    expect(run).toMatchObject({ status: 'ended', reason: 'digest', error: null, conversation_id: conversationOf(app, bot), bot_id: bot });
    // One digest, no answering request and no tool call from the maintenance worker.
    expect(summarizers(fake)).toHaveLength(1);
    expect(streamed(fake)).toHaveLength(3);
    expect(count(app, 'task_runs')).toBe(2);
    expect(edits(app, bot)).toHaveLength(1);
    // Usage is booked as maintenance without a task; the in-turn purpose is not used.
    const usage = app.store.all('SELECT * FROM assistant_usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ purpose: 'maintain', task_id: null, conversation_id: conversationOf(app, bot), status: 'succeeded' });
    expect(String(app.store.get('SELECT task_id FROM context_checkpoints')!.task_id)).toBe('maintain:' + run.id);
    expect(maintainUsage(app.store, conversationOf(app, bot))).toBeGreaterThan(0);
    // The next turn finds the work done.
    const before = fake.requests.length;
    await turn(app, bot, '第三轮：继续', 'maint-3');
    expect(fake.requests.slice(before).filter(row => !row.stream)).toHaveLength(0);
    expect(withoutSystem(streamed(fake).at(-1)!)).not.toContain('MAINT-ONE');
    expect(withoutSystem(streamed(fake).at(-1)!)).toContain('工具结果摘要');
    expect(edits(app, bot)).toHaveLength(1);
    await sleep(300);
    expect(count(app, 'maintenance_runs')).toBe(1);
  }, 120000);

  it('keeps the latest completed turn complete: only the turn before it is digested in the background', async () => {
    const { app, fake, bot } = await fixture();
    const docs = [bigDoc(app, bot, 'KEEP-ONE'), bigDoc(app, bot, 'KEEP-TWO')];
    fake.scripts.push(...docs.map(doc => ({ action: 'memory.read', args: { documentId: doc.documentId } })).flatMap((call, index) => [call, `第${index + 1}轮完成`]));
    await turn(app, bot, '第一轮：读取资料', 'keep-1'); await turn(app, bot, '第二轮：读取另一份资料', 'keep-2');
    await finished(app);
    expect(summarizers(fake)).toHaveLength(1);
    const targets = edits(app, bot).map(entry => (entry as { targetId: string }).targetId);
    expect(targets).toHaveLength(1);
    expect(JSON.stringify(stored(app, bot).find(entry => entry.id === targets[0]))).toContain('KEEP-ONE');
    fake.scripts.push('第三轮完成');
    const before = fake.requests.length;
    await turn(app, bot, '第三轮：继续比较', 'keep-3');
    expect(fake.requests.slice(before).filter(row => !row.stream)).toHaveLength(0);
    const request = withoutSystem(streamed(fake).at(-1)!);
    expect(request).toContain('KEEP-TWO'); expect(request).not.toContain('KEEP-ONE');
  }, 120000);

  it('folds older turns into a summary in the background when the context nears the budget', async () => {
    const { app, fake, bot } = await fixture({ contextWindow: 200000, contextBudget: 20000 });
    await turn(app, bot, 'BUDGET-FIRST ' + '合成资料'.repeat(1000), 'budget-1');
    // The first request ended below the answer trigger; the context is not yet 70% of the budget plus a second turn.
    expect(count(app, 'maintenance_runs')).toBe(0);
    await turn(app, bot, '第二轮：继续', 'budget-2');
    await finished(app);
    expect(app.store.get('SELECT * FROM maintenance_runs')).toMatchObject({ status: 'ended', reason: 'budget' });
    expect(summarizers(fake).length).toBeGreaterThanOrEqual(1);
    expect(stored(app, bot).some(entry => entry.type === 'compaction')).toBe(true);
    expect(app.store.all('SELECT task_id FROM context_checkpoints').every(row => String(row.task_id).startsWith('maintain:'))).toBe(true);
    expect(app.store.all('SELECT purpose,task_id FROM assistant_usage').every(row => row.purpose === 'maintain' && row.task_id === null)).toBe(true);
    const before = fake.requests.length;
    await turn(app, bot, '第三轮：继续', 'budget-3');
    expect(fake.requests.slice(before).filter(row => !row.stream)).toHaveLength(0);
    expect(withoutSystem(streamed(fake).at(-1)!)).not.toContain('BUDGET-FIRST');
    expect(withoutSystem(streamed(fake).at(-1)!)).toContain('第三轮：继续');
  }, 120000);

  it('stops maintenance at once when a message arrives, answers on a consistent projection and rejects late events of the stopped run', async () => {
    const { app, fake, bot } = await fixture();
    const docs = [bigDoc(app, bot, 'ABORT-ONE'), bigDoc(app, bot, 'ABORT-TWO')];
    fake.scripts.push(...docs.map(doc => ({ action: 'memory.read', args: { documentId: doc.documentId } })), '第一轮完成', '第二轮完成', '第三轮完成');
    fake.setOverride(async body => { if (!body.stream) await sleep(3000); return undefined; });
    await turn(app, bot, '第一轮：读取两份资料', 'abort-1');
    await turn(app, bot, '第二轮：继续', 'abort-2');
    const conversation = conversationOf(app, bot);
    await wait(() => app.runtime.maintenance.has(conversation) && summarizers(fake).length > 0, app);
    const run = app.runtime.maintenance.get(conversation)!;
    expect(app.store.get('SELECT status FROM maintenance_runs')).toMatchObject({ status: 'active' });
    fake.setOverride(undefined);
    const third = app.agents.send(bot, '第三轮：用户新消息', 'abort-3').taskId;
    // Synchronous: the run is already ended for Core's purposes, before the process has exited.
    expect(run.stopped).toBe(true);
    expect(() => app.runtime.assertMaintenance(run)).toThrow('no longer active');
    await wait(() => app.store.get('SELECT status FROM tasks WHERE id=?', third)?.status === 'succeeded', app);
    await wait(() => !app.runtime.workers.size && !app.runtime.maintenance.size, app);
    expect(app.store.all('SELECT status FROM maintenance_runs').map(row => row.status)).toEqual(['interrupted']);
    // Every digest exists once: the stopped run added nothing, the turn did its own.
    const entries = stored(app, bot);
    expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
    expect(branchOf(entries)).toHaveLength(entries.length - 1);
    const calls = new Set(entries.flatMap(entry => entry.type === 'message' && entry.message.role === 'assistant' ? entry.message.content.flatMap(part => part.type === 'toolCall' ? [part.id] : []) : []));
    for (const entry of entries) if (entry.type === 'message' && entry.message.role === 'toolResult') expect(calls.has(entry.message.toolCallId)).toBe(true);
    const targets = edits(app, bot).map(entry => (entry as { targetId: string }).targetId);
    expect(targets).toHaveLength(2); expect(new Set(targets).size).toBe(2);
    expect(withoutSystem(streamed(fake).at(-1)!)).not.toContain('ABORT-ONE');
    // Late snapshot, summary and done of the stopped run change nothing.
    const checkpoints = count(app, 'context_checkpoints'), usage = count(app, 'assistant_usage');
    const late = (event: object) => (app.runtime as unknown as { maintenanceEvent(run: unknown, event: object): Promise<void> }).maintenanceEvent(run, event);
    const header = entries[0];
    await expect(late({ type: 'snapshot', entries: [header], requestId: 'late-1' })).rejects.toThrow('no longer active');
    await expect(late({ type: 'compact', entries: [header], requestId: 'late-2', text: '[]', firstEntry: 'a', lastEntry: 'b' })).rejects.toThrow('no longer active');
    await expect(late({ type: 'done', entries: [header], requestId: 'late-3', inputs: [], text: '' })).rejects.toThrow('no longer active');
    expect(stored(app, bot)).toEqual(entries);
    expect(count(app, 'context_checkpoints')).toBe(checkpoints); expect(count(app, 'assistant_usage')).toBe(usage);
  }, 120000);

  it('never takes the last free worker slot and retries later', async () => {
    const { app, fake, bot } = await fixture();
    app.runtime.maintenanceDelay = 60_000; app.runtime.maintenanceRetry = 60;
    const one = bigDoc(app, bot, 'SLOT-ONE');
    fake.scripts.push({ action: 'memory.read', args: { documentId: one.documentId } }, '第一轮完成', '第二轮完成');
    await turn(app, bot, '第一轮：读取资料', 'slot-1'); await turn(app, bot, '第二轮：继续', 'slot-2');
    const conversation = conversationOf(app, bot);
    expect(app.runtime.maintenanceTimers.size).toBe(1);
    // Three busy workers leave one slot, which maintenance does not take.
    const busy = ['busy-1', 'busy-2', 'busy-3'];
    for (const key of busy) app.runtime.workers.set(key, {} as never);
    try {
      app.runtime.scheduleMaintenance(conversation, 20);
      await sleep(400);
      expect(count(app, 'maintenance_runs')).toBe(0);
      expect(app.runtime.maintenance.size).toBe(0);
      // It keeps retrying instead of giving up.
      expect(app.runtime.maintenanceTimers.size).toBe(1);
      app.runtime.workers.delete('busy-3');
    } catch (error) { for (const key of busy) app.runtime.workers.delete(key); throw error; }
    try { await finished(app); } finally { for (const key of busy) app.runtime.workers.delete(key); }
    expect(app.store.get('SELECT status FROM maintenance_runs')).toMatchObject({ status: 'ended' });
  }, 120000);

  it('counts maintenance against its own daily cap per conversation, not against the memory budget', async () => {
    const { app, fake, bot } = await fixture();
    app.runtime.maintenanceDelay = 60_000;
    const one = bigDoc(app, bot, 'CAP-ONE');
    fake.scripts.push({ action: 'memory.read', args: { documentId: one.documentId } }, '第一轮完成', '第二轮完成');
    await turn(app, bot, '第一轮：读取资料', 'cap-1'); await turn(app, bot, '第二轮：继续', 'cap-2');
    const conversation = conversationOf(app, bot);
    expect(app.runtime.maintenanceTimers.size).toBe(1);
    const insert = (id: string, conversationId: string | null, purpose: string, input: number, output: number) => app.store.run('INSERT INTO assistant_usage(id,bot_id,task_id,conversation_id,purpose,model,status,reserved_tokens,input_tokens,output_tokens,created_at) VALUES(?,?,NULL,?,?,?,?,?,?,?,?)', id, bot, conversationId, purpose, 'fixture', 'succeeded', 1000, input, output, Date.now());
    // Other conversations' maintenance does not count; this one's does.
    insert('maintain-other', 'another-conversation', 'maintain', 100_000, 50_000);
    expect(maintainUsage(app.store, conversation)).toBe(0);
    app.runtime.scheduleMaintenance(conversation, 60_000);
    expect(app.runtime.maintenanceTimers.size).toBe(1);
    insert('maintain-spent', conversation, 'maintain', 300_000, 250_000);
    expect(maintainUsage(app.store, conversation)).toBe(550_000);
    app.runtime.scheduleMaintenance(conversation, 60_000);
    expect(app.runtime.maintenanceTimers.size).toBe(0);
    expect(app.runtime.maintenancePlan(conversation)).toBeUndefined();
    // Maintenance usage neither consumes nor is blocked by the memory daily budget.
    await expect(assistantCompletion(app.store, { botId: bot, purpose: 'retain', instruction: 'summary', content: 'source', dailyBudget: 100_000 })).resolves.toBeTruthy();
    // Memory work of the day does not count against maintenance, but does against the memory budget.
    insert('memory-heavy', null, 'retain', 150_000, 10_000);
    expect(maintainUsage(app.store, conversation)).toBe(550_000);
    await expect(assistantCompletion(app.store, { botId: bot, purpose: 'retain', instruction: 'summary', content: 'source', dailyBudget: 100_000 })).rejects.toThrow('记忆维护预算');
    // A call that would pass the cap is refused where it is made, too.
    await expect(assistantCompletion(app.store, { botId: bot, conversationId: conversation, purpose: 'maintain', maintainBudget: MAINTAIN_DAILY_TOKENS, instruction: 'x', content: 'y' })).rejects.toThrow('后台整理预算');
    await expect(assistantCompletion(app.store, { botId: bot, conversationId: 'another-conversation', purpose: 'maintain', maintainBudget: MAINTAIN_DAILY_TOKENS, instruction: 'x', content: 'y' })).resolves.toBeTruthy();
    // Yesterday's usage is forgotten.
    app.store.run('UPDATE assistant_usage SET created_at=created_at-172800000 WHERE id=?', 'maintain-spent');
    app.runtime.scheduleMaintenance(conversation, 60_000);
    expect(app.runtime.maintenanceTimers.size).toBe(1);
  }, 120000);

  it('clears the pending run when a task comes first', async () => {
    const { app, fake, bot } = await fixture();
    app.runtime.maintenanceDelay = 60_000;
    const one = bigDoc(app, bot, 'FIRST-ONE');
    fake.scripts.push({ action: 'memory.read', args: { documentId: one.documentId } }, '第一轮完成', '第二轮完成', '第三轮完成');
    await turn(app, bot, '第一轮：读取资料', 'first-1'); await turn(app, bot, '第二轮：继续', 'first-2');
    expect(app.runtime.maintenanceTimers.size).toBe(1);
    const third = app.agents.send(bot, '第三轮：继续', 'first-3').taskId;
    expect(app.runtime.maintenanceTimers.size).toBe(0);
    await wait(() => app.store.get('SELECT status FROM tasks WHERE id=?', third)?.status === 'succeeded', app);
    while (app.runtime.workers.size) await sleep(20);
    // The turn digested turn one itself, so nothing is left to schedule.
    expect(edits(app, bot)).toHaveLength(1);
    expect(app.runtime.maintenanceTimers.size).toBe(0);
    expect(count(app, 'maintenance_runs')).toBe(0);
  }, 120000);

  it('cancels pending maintenance on shutdown', async () => {
    const f = await fixture(); const { app, fake, bot } = f;
    app.runtime.maintenanceDelay = 400;
    const one = bigDoc(app, bot, 'SHUT-ONE');
    fake.scripts.push({ action: 'memory.read', args: { documentId: one.documentId } }, '第一轮完成', '第二轮完成');
    await turn(app, bot, '第一轮：读取资料', 'shut-1'); await turn(app, bot, '第二轮：继续', 'shut-2');
    expect(app.runtime.maintenanceTimers.size).toBe(1);
    fixtures.splice(fixtures.indexOf(f), 1);
    await app.close(); await fake.close();
    expect(app.runtime.maintenanceTimers.size).toBe(0);
    await sleep(800);
    const reopened = new CoreStore(app.store.dir, app.store.key, 'synthetic-token');
    try { expect(reopened.get('SELECT COUNT(*) n FROM maintenance_runs')?.n).toBe(0); } finally { reopened.close(); }
    rmSync(f.root, { recursive: true, force: true });
  }, 120000);

  it('aborts a running maintenance on shutdown and records it as interrupted', async () => {
    const f = await fixture(); const { app, fake, bot } = f;
    const one = bigDoc(app, bot, 'SHUT-RUN');
    fake.scripts.push({ action: 'memory.read', args: { documentId: one.documentId } }, '第一轮完成', '第二轮完成');
    fake.setOverride(async body => { if (!body.stream) await sleep(5000); return undefined; });
    await turn(app, bot, '第一轮：读取资料', 'run-1'); await turn(app, bot, '第二轮：继续', 'run-2');
    await wait(() => app.runtime.maintenance.size === 1 && summarizers(fake).length > 0, app);
    fixtures.splice(fixtures.indexOf(f), 1);
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(4000);
    expect(app.runtime.maintenance.size).toBe(0);
    await fake.close();
    const reopened = new CoreStore(app.store.dir, app.store.key, 'synthetic-token');
    try {
      expect(reopened.get('SELECT status FROM maintenance_runs')?.status).toBe('interrupted');
      expect(reopened.get('SELECT ended_at FROM maintenance_runs')?.ended_at).not.toBeNull();
      expect(reopened.all('SELECT status FROM assistant_usage').every(row => row.status !== 'running')).toBe(true);
    } finally { reopened.close(); }
    rmSync(f.root, { recursive: true, force: true });
  }, 120000);
});
