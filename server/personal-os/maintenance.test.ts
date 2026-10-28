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
import { MAINTAIN_IDLE_MS, branchOf, maintenanceWork, projectEntries, reductionLimits } from './context-tools.ts';
import { ChatFiles } from './chat-files.ts';
import { tokens } from './token-estimate.ts';

type Fixture = { root: string; fake: Awaited<ReturnType<typeof startFakePersonalMemory>>; app: Awaited<ReturnType<typeof createPersonalApp>>; bot: string };
type App = Fixture['app'];
const fixtures: Fixture[] = [];
// S = 70,000 tokens (the compaction threshold), T = 28,000; the input budget H is 160,000. The base prompt alone is ~16k tokens.
const SOFT = { contextWindow: 200000, contextBudget: 90000 };
async function fixture(extra: Record<string, unknown> = SOFT) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nex-maintenance-')), fake = await startFakePersonalMemory();
  const app = await createPersonalApp({ dir: root, key: randomBytes(32), token: 'synthetic-token', identity: false, memoryRuntime: false, hostDevice: false });
  app.store.saveConfig({ provider: 'openai', endpoint: fake.origin + '/v1', model: 'fixture-chat', apiKey: 'synthetic-only', maxOutputTokens: 4096, ...extra });
  const bot = app.store.createBot('合成个人助手'); clearInterval(app.runtime.memory.personal.timer);
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
const isDigest = (request: Record<string, unknown>) => JSON.stringify(request.messages).includes('只摘要这一个工具结果');
const runtimeOf = (app: App, bot: string) => String(app.store.get('SELECT id FROM runtime_sessions WHERE bot_id=?', bot)!.id);
const conversationOf = (app: App, bot: string) => String(app.store.get('SELECT conversation_id FROM runtime_sessions WHERE bot_id=?', bot)!.conversation_id);
const bigDoc = (app: App, bot: string, label: string) => app.runtime.memory.write(bot, { title: label, content: `${label} ` + '资料'.repeat(1500) });
const withoutSystem = (request: Record<string, unknown>) => JSON.stringify((request.messages as Array<{ role: string }>).filter(message => message.role !== 'system' && message.role !== 'developer'));
const stored = (app: App, bot: string) => app.runtime.projection.load(runtimeOf(app, bot))!;
const edits = (app: App, bot: string) => stored(app, bot).filter(entry => entry.type === 'context_edit');
// ~7,200 tokens of input per turn.
const ballast = (label: string) => `${label} ` + '合成资料'.repeat(1200);
/** Turns of ballast until the context is above S; returns the index of the last one. Below S nothing is scheduled. */
const fillPast = async (app: App, bot: string, limit = 14) => {
  for (let n = 0; n < limit; n++) {
    await turn(app, bot, ballast(`FILL-${n}`), `fill-${n}`);
    if (estimateOf(app, bot).estimate > SOFT.contextBudget) return n;
    expect(app.runtime.maintenanceTimers.size).toBe(0);
  }
  throw new Error('The context never crossed the threshold');
};
/** The test clock reads this many minutes ahead: the idle rule and the failure backoff both follow it. */
const minutesLater = (app: App, minutes: number) => { app.runtime.clock = () => Date.now() + minutes * 60_000; };
/** Calibrated estimate of the stored projection and the target T of the fixture's model. */
const estimateOf = (app: App, bot: string) => {
  const conversation = conversationOf(app, bot), last = app.store.get('SELECT id FROM tasks WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1', conversation)!;
  const model = app.store.modelConfig(bot), prompts = app.runtime.promptParts(String(last.id));
  return { estimate: maintenanceWork(stored(app, bot), { ...model, ...prompts }).estimate, target: reductionLimits(model).target };
};

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
      // A single turn far above the threshold has nothing older to fold.
      const giant = maintenanceWork(build([{ text: '长', reply: '回答'.repeat(30000) }]).entries, params);
      expect(giant.estimate).toBeGreaterThan(giant.trigger);
      expect(giant.work).toBe(false);
    });
    it('has no work at or below the soft threshold, however many old results and images wait', () => {
      // Old large results and images used to be a reason of their own; below S nothing is reduced.
      const turns: Turn[] = [{ text: '读取', result: big, image: true }, { text: '再读', result: big, image: true }, { text: '继续' }];
      const verdict = maintenanceWork(build(turns).entries, params);
      expect(verdict.estimate).toBeLessThan(verdict.trigger);
      expect(verdict).toMatchObject({ work: false, reason: null });
    });
    it('finds work above the soft threshold: a large older result to digest, or older turns to fold; a digested result is not work again', () => {
      // S of a 64,000-token window is 51,200. Older results of ~13,500 tokens each push the context above it.
      const bulky = '资料'.repeat(6000);
      const { manager, entries } = build([{ text: '读取', result: bulky }, { text: '再读', result: bulky }, { text: '再读', result: bulky }, { text: '继续' }]);
      const verdict = maintenanceWork(entries, params);
      expect(verdict.estimate).toBeGreaterThan(verdict.trigger);
      expect(verdict).toMatchObject({ work: true, reason: 'budget', trigger: 51200 });
      // Old results of any size are no reason below S.
      expect(maintenanceWork(build([{ text: '读取', result: big }, { text: '继续' }]).entries, params).work).toBe(false);
      // The latest completed turn is never reduced: the same bulk in the latest turn alone has no work.
      expect(maintenanceWork(build([{ text: '读取', result: bulky.repeat(3) }]).entries, params).work).toBe(false);
      // Once the results are digested the context is back below S: nothing left to do.
      for (const call of ['c0', 'c1', 'c2']) manager.appendContextEdit(resultId(entries, call), { content: [{ type: 'text', text: '摘要'.repeat(10) }] });
      const edited = [manager.getHeader()!, ...manager.getEntries()] as FileEntry[];
      expect(maintenanceWork(edited, params).work).toBe(false);
    });
    it('compares the calibrated count with S, falls back on the raw 90% net and does not fold a summary into itself', () => {
      const turns = Array.from({ length: 50 }, (_, index) => ({ text: `第${index}轮`, reply: '回答'.repeat(300) }));
      const { entries } = build(turns);
      const verdict = maintenanceWork(entries, params);
      expect(verdict).toMatchObject({ work: true, reason: 'budget', trigger: 51200 });
      expect(verdict.estimate).toBeGreaterThan(verdict.trigger);
      // The calibrated count is what is compared; a roomier threshold moves the line.
      expect(maintenanceWork(entries, { ...params, calibration: .5 }).work).toBe(false);
      expect(maintenanceWork(entries, { ...params, contextWindow: 400000, contextBudget: 200000 }).work).toBe(false);
      // The raw count reaching 90% of the window starts it whatever the ratio reads.
      expect(maintenanceWork(entries, { ...params, calibration: .01, contextWindow: Math.floor(verdict.estimate / .95) }).work).toBe(true);
      // A summary alone is not folded into another summary.
      const first = entries.find(entry => entry.type === 'custom_message' && entry.content === '第45轮')!;
      const folded = build(turns, manager => manager.appendCompaction('SUMMARY', first.id, 9, {} as never));
      expect(maintenanceWork(folded.entries, params).work).toBe(false);
    });
    it('leaves out targets in backoff: no work when every digest and the fold are blocked', () => {
      const bulky = '资料'.repeat(6000);
      const { entries } = build([{ text: '读取', result: bulky }, { text: '再读', result: bulky }, { text: '再读', result: bulky }, { text: '继续' }]);
      const result = entries.filter(entry => entry.type === 'message' && entry.message.role === 'toolResult').map(entry => entry.id);
      const input = entries.find(entry => entry.type === 'custom_message')!.id;
      expect(maintenanceWork(entries, { ...params, blocked: new Set([`entry:${result[0]}`]) }).work).toBe(true);
      // Every large result in backoff, but older turns can still be folded.
      expect(maintenanceWork(entries, { ...params, blocked: new Set(result.map(id => `entry:${id}`)) }).work).toBe(true);
      // A failed batch of the fold (its range starts at the first source entry) blocks the fold too.
      expect(maintenanceWork(entries, { ...params, blocked: new Set([...result.map(id => `entry:${id}`), `range:${input}..${result[1]}`]) }).work).toBe(false);
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

  it('schedules nothing below the soft threshold, however old the large results are, and calls no summarizer', async () => {
    const { app, fake, bot } = await fixture({ contextWindow: 64000 });
    const docs = [bigDoc(app, bot, 'BELOW-ONE'), bigDoc(app, bot, 'BELOW-TWO')];
    fake.scripts.push(...docs.flatMap((doc, index) => [{ action: 'memory.read', args: { documentId: doc.documentId } }, `第${index + 1}轮完成`]), '第三轮完成');
    await turn(app, bot, '第一轮：读取资料', 'below-1'); await turn(app, bot, '第二轮：读取另一份资料', 'below-2'); await turn(app, bot, '第三轮：继续', 'below-3');
    // Turn one's 4,500-token result is two turns old, but the context (~25k) is below S (49,152): no timer, no run, no call.
    minutesLater(app, 24 * 60);
    app.runtime.scheduleMaintenance(conversationOf(app, bot));
    expect(app.runtime.maintenanceTimers.size).toBe(0);
    expect(app.runtime.maintenancePlan(conversationOf(app, bot))).toBeUndefined();
    await sleep(300);
    expect(count(app, 'maintenance_runs')).toBe(0);
    expect(summarizers(fake)).toHaveLength(0);
    expect(edits(app, bot)).toHaveLength(0);
  }, 120000);

  it('above the threshold waits for 55 idle minutes, then reduces once with digests before the fold, down to the target, and the next turn needs no summarizer', async () => {
    const { app, fake, bot } = await fixture();
    expect(app.runtime.maintenanceIdle).toBe(MAINTAIN_IDLE_MS);
    expect(MAINTAIN_IDLE_MS).toBe(55 * 60_000);
    // Big results in the first turn, then enough turns to cross S = 70,000.
    const docs = [0, 1, 2].map(index => bigDoc(app, bot, `ORDER-${index}`));
    fake.scripts.push(...docs.map(doc => ({ action: 'memory.read', args: { documentId: doc.documentId } })), '第一轮完成');
    await turn(app, bot, ballast('FILL-0'), 'order-0');
    const conversation = conversationOf(app, bot);
    // At or below S there is no timer; the turn that crosses it arms one.
    let last = 0;
    for (let n = 1; n < 14; n++) {
      await turn(app, bot, ballast(`FILL-${n}`), `order-${n}`); last = n;
      if (estimateOf(app, bot).estimate > SOFT.contextBudget) break;
      expect(app.runtime.maintenanceTimers.size).toBe(0);
    }
    expect(estimateOf(app, bot).estimate).toBeGreaterThan(SOFT.contextBudget);
    expect(app.runtime.maintenanceTimers.size).toBe(1);
    // The timer follows the end of the last model request, 55 minutes on (the injected clock reads real time here).
    const lastEnd = app.runtime.lastRequestEnd(conversation);
    expect(lastEnd).toBeGreaterThan(Date.now() - 60_000);
    expect(Math.abs(app.runtime.maintenanceDue.get(conversation)! - (lastEnd + MAINTAIN_IDLE_MS))).toBeLessThan(5000);
    // 54 minutes: armed for the remaining minute, nothing runs.
    minutesLater(app, 54);
    app.runtime.scheduleMaintenance(conversation);
    expect(app.runtime.maintenanceDue.get(conversation)! - app.runtime.clock()).toBeGreaterThan(20_000);
    expect(app.runtime.maintenanceDue.get(conversation)! - app.runtime.clock()).toBeLessThan(80_000);
    await sleep(400);
    expect(count(app, 'maintenance_runs')).toBe(0); expect(summarizers(fake)).toHaveLength(0);
    // 56 minutes: due at once.
    minutesLater(app, 56);
    app.runtime.scheduleMaintenance(conversation);
    await finished(app);
    expect(app.store.get('SELECT * FROM maintenance_runs')).toMatchObject({ status: 'ended', reason: 'budget', error: null, conversation_id: conversation, bot_id: bot });
    // One run, no answering request and no tool call from the maintenance worker.
    expect(count(app, 'maintenance_runs')).toBe(1);
    const calls = summarizers(fake);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // Order within the reduction: the individual digests first (largest first), then the history fold.
    const kinds = calls.map(row => isDigest(row) ? 'digest' : 'fold');
    expect(kinds.indexOf('fold')).toBeGreaterThan(0);
    expect(kinds.slice(0, kinds.indexOf('fold')).every(kind => kind === 'digest')).toBe(true);
    expect(kinds.slice(kinds.indexOf('fold')).every(kind => kind === 'fold')).toBe(true);
    expect(edits(app, bot).length).toBeGreaterThanOrEqual(1);
    expect(stored(app, bot).some(entry => entry.type === 'compaction')).toBe(true);
    // Below the target afterwards, and booked as maintenance without a task.
    const after = estimateOf(app, bot);
    expect(after.estimate).toBeLessThanOrEqual(after.target);
    expect(app.store.all('SELECT purpose,task_id FROM assistant_usage').every(row => row.purpose === 'maintain' && row.task_id === null)).toBe(true);
    expect(maintainUsage(app.store, conversation)).toBeGreaterThan(0);
    expect(app.store.all('SELECT task_id FROM context_checkpoints').every(row => String(row.task_id).startsWith('maintain:'))).toBe(true);
    // The next turn finds the work done and keeps the latest completed turn complete.
    minutesLater(app, 0);
    const before = fake.requests.length;
    await turn(app, bot, '继续', 'order-next');
    expect(fake.requests.slice(before).filter(row => !row.stream)).toHaveLength(0);
    const request = withoutSystem(streamed(fake).at(-1)!);
    expect(request).toContain(`FILL-${last}`); expect(request).not.toContain('FILL-0'); expect(request).not.toContain('ORDER-0');
    // Nothing is left to do: no second run.
    await sleep(300);
    expect(count(app, 'maintenance_runs')).toBe(1);
  }, 180000);

  it('reaches the target with digests alone when they suffice: no fold, and old images become markers only as part of that reduction', async () => {
    const { app, fake, bot } = await fixture({ contextWindow: 200000, contextBudget: SOFT.contextBudget });
    const files = new ChatFiles(app.store), image = files.upload({ botId: bot, name: 'older.png', data: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(2000, 65)]).toString('base64') }, app.store.session);
    const docs = Array.from({ length: 20 }, (_, index) => bigDoc(app, bot, `ALONE-${index}`));
    fake.scripts.push({ action: 'attachment.read', args: { attachmentId: image.id } }, ...docs.map(doc => ({ action: 'memory.read', args: { documentId: doc.documentId } })), '第一轮完成', '第二轮完成');
    const first = app.agents.send(bot, `看图并读取资料\n![合成图片](/api/attachments/${image.id})`, 'alone-1').taskId; files.bind([image.id], bot, 'alone-1');
    await wait(() => app.store.get('SELECT status FROM tasks WHERE id=?', first)?.status === 'succeeded', app); while (app.runtime.workers.size) await sleep(20);
    // Fourteen results and an image in the first turn: above 70,000 tokens, and nothing is reduced on the way.
    expect(fake.requests.every(row => row.stream)).toBe(true);
    await turn(app, bot, '第二轮：继续', 'alone-2');
    expect(fake.requests.every(row => row.stream)).toBe(true);
    expect(JSON.stringify(streamed(fake).at(-1))).toContain('data:image/png;base64,');
    expect(estimateOf(app, bot).estimate).toBeGreaterThan(SOFT.contextBudget);
    minutesLater(app, 56);
    app.runtime.scheduleMaintenance(conversationOf(app, bot));
    await finished(app);
    expect(app.store.get('SELECT status FROM maintenance_runs')?.status).toBe('ended');
    // Digests only: no history fold, no compaction; the digests brought the context to the target.
    expect(summarizers(fake).length).toBeGreaterThanOrEqual(1);
    expect(summarizers(fake).every(isDigest)).toBe(true);
    expect(stored(app, bot).some(entry => entry.type === 'compaction')).toBe(false);
    const after = estimateOf(app, bot);
    expect(after.estimate).toBeLessThanOrEqual(after.target);
    minutesLater(app, 0);
    await turn(app, bot, '第三轮：继续', 'alone-3');
    const last = JSON.stringify(streamed(fake).at(-1));
    expect(last).not.toContain('data:image/png;base64,'); expect(last).toContain(`[图片 attachment:${image.id}]`);
    expect(last).toContain('工具结果摘要');
    // The image bytes stay in the original entry.
    const imageEdit = edits(app, bot).find(edit => JSON.stringify(edit).includes('[图片 attachment:'))!;
    const target = stored(app, bot).find(entry => entry.id === (imageEdit as { targetId: string }).targetId)!;
    expect(JSON.stringify(target)).toContain('"data":"iVBORw0KGg');
  }, 180000);

  it('stops maintenance at once when a message arrives, answers on a consistent projection and rejects late events of the stopped run', async () => {
    const { app, fake, bot } = await fixture();
    fake.setOverride(async body => { if (!body.stream) await sleep(3000); return undefined; });
    await fillPast(app, bot);
    const conversation = conversationOf(app, bot);
    minutesLater(app, 56);
    app.runtime.scheduleMaintenance(conversation);
    await wait(() => app.runtime.maintenance.has(conversation) && summarizers(fake).length > 0, app);
    const run = app.runtime.maintenance.get(conversation)!;
    expect(app.store.get('SELECT status FROM maintenance_runs')).toMatchObject({ status: 'active' });
    fake.setOverride(undefined); minutesLater(app, 0);
    const next = app.agents.send(bot, '用户新消息', 'abort-next').taskId;
    // Synchronous: the run is already ended for Core's purposes, before the process has exited.
    expect(run.stopped).toBe(true);
    expect(() => app.runtime.assertMaintenance(run)).toThrow('no longer active');
    await wait(() => app.store.get('SELECT status FROM tasks WHERE id=?', next)?.status === 'succeeded', app);
    await wait(() => !app.runtime.workers.size && !app.runtime.maintenance.size, app);
    expect(app.store.all('SELECT status FROM maintenance_runs').map(row => row.status)).toEqual(['interrupted']);
    // The stopped run added no half-finished edit: every entry exists once, calls and results stay paired.
    const entries = stored(app, bot);
    expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
    expect(branchOf(entries)).toHaveLength(entries.length - 1);
    const calls = new Set(entries.flatMap(entry => entry.type === 'message' && entry.message.role === 'assistant' ? entry.message.content.flatMap(part => part.type === 'toolCall' ? [part.id] : []) : []));
    for (const entry of entries) if (entry.type === 'message' && entry.message.role === 'toolResult') expect(calls.has(entry.message.toolCallId)).toBe(true);
    // Late snapshot, summary and done of the stopped run change nothing.
    const checkpoints = count(app, 'context_checkpoints'), usage = count(app, 'assistant_usage');
    const late = (event: object) => (app.runtime as unknown as { maintenanceEvent(run: unknown, event: object): Promise<void> }).maintenanceEvent(run, event);
    const header = entries[0];
    await expect(late({ type: 'snapshot', entries: [header], requestId: 'late-1' })).rejects.toThrow('no longer active');
    await expect(late({ type: 'compact', entries: [header], requestId: 'late-2', text: '[]', firstEntry: 'a', lastEntry: 'b' })).rejects.toThrow('no longer active');
    await expect(late({ type: 'done', entries: [header], requestId: 'late-3', inputs: [], text: '' })).rejects.toThrow('no longer active');
    expect(stored(app, bot)).toEqual(entries);
    expect(count(app, 'context_checkpoints')).toBe(checkpoints); expect(count(app, 'assistant_usage')).toBe(usage);
  }, 180000);

  it('never takes the last free worker slot and retries later', async () => {
    const { app, bot } = await fixture();
    await fillPast(app, bot);
    const conversation = conversationOf(app, bot);
    app.runtime.maintenanceRetry = 60; minutesLater(app, 56);
    // Three busy workers leave one slot, which maintenance does not take.
    const busy = ['busy-1', 'busy-2', 'busy-3'];
    for (const key of busy) app.runtime.workers.set(key, {} as never);
    try {
      app.runtime.scheduleMaintenance(conversation);
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
    const { app, bot } = await fixture();
    await fillPast(app, bot);
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

  it('clears the pending run when a task comes first; the turn itself reduces nothing while the context fits', async () => {
    const { app, fake, bot } = await fixture();
    await fillPast(app, bot);
    expect(app.runtime.maintenanceTimers.size).toBe(1);
    const before = fake.requests.length;
    const next = app.agents.send(bot, '第六轮：继续', 'first-next').taskId;
    expect(app.runtime.maintenanceTimers.size).toBe(0);
    await wait(() => app.store.get('SELECT status FROM tasks WHERE id=?', next)?.status === 'succeeded', app);
    while (app.runtime.workers.size) await sleep(20);
    // Above S but far below H: the turn calls no summarizer and edits nothing; maintenance is armed again after it.
    expect(fake.requests.slice(before).filter(row => !row.stream)).toHaveLength(0);
    expect(edits(app, bot)).toHaveLength(0);
    expect(count(app, 'maintenance_runs')).toBe(0);
    expect(app.runtime.maintenanceTimers.size).toBe(1);
  }, 120000);

  it('cancels pending maintenance on shutdown', async () => {
    const f = await fixture(); const { app, bot } = f;
    await fillPast(app, bot);
    expect(app.runtime.maintenanceTimers.size).toBe(1);
    fixtures.splice(fixtures.indexOf(f), 1);
    await app.close(); await f.fake.close();
    expect(app.runtime.maintenanceTimers.size).toBe(0);
    const reopened = new CoreStore(app.store.dir, app.store.key, 'synthetic-token');
    try { expect(reopened.get('SELECT COUNT(*) n FROM maintenance_runs')?.n).toBe(0); } finally { reopened.close(); }
    rmSync(f.root, { recursive: true, force: true });
  }, 120000);

  it('aborts a running maintenance on shutdown and records it as interrupted', async () => {
    const f = await fixture(); const { app, fake, bot } = f;
    fake.setOverride(async body => { if (!body.stream) await sleep(5000); return undefined; });
    await fillPast(app, bot);
    minutesLater(app, 56);
    app.runtime.scheduleMaintenance(conversationOf(app, bot));
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
