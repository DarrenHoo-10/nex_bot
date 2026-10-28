import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPersonalApp } from './index.ts';
import { startFakePersonalMemory } from './testing/fake-personal-memory.ts';
import { BACKOFF_MS, CompactionFailures, GIVEN_UP, MAINTENANCE_PAUSE_MS } from './compaction-failures.ts';
import { MAINTAIN_IDLE_MS, OUTPUT_TRUNCATED } from './context-tools.ts';
import { tokens } from './token-estimate.ts';

type Fake = Awaited<ReturnType<typeof startFakePersonalMemory>>;
type App = Awaited<ReturnType<typeof createPersonalApp>>;
type Fixture = { root: string; fake: Fake; app: App; bot: string };
const fixtures: Fixture[] = [];
const roots: string[] = [];
const options = (root: string, key: Buffer) => ({ dir: root, key, token: 'synthetic-token', identity: false as const, memoryRuntime: false as const, hostDevice: false as const });
// Every context is above S = 8,000 (the floor), so two turns are enough for maintenance to have work.
const LOW = { contextWindow: 200000, contextBudget: 8000 };
async function fixture(extra: Record<string, unknown> = LOW) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nex-timing-')), fake = await startFakePersonalMemory();
  roots.push(root);
  const app = await createPersonalApp(options(root, randomBytes(32)));
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
afterEach(async () => {
  for (const { app, fake } of fixtures.splice(0)) { await app.close(); await fake.close(); }
  for (const root of roots.splice(0)) { if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('nex-timing-')) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }); }
});
const turn = async (app: App, bot: string, text: string, key: string) => {
  const task = app.agents.send(bot, text, key).taskId;
  await wait(() => app.store.get('SELECT status FROM tasks WHERE id=?', task)?.status === 'succeeded', app);
  while (app.runtime.workers.size) await sleep(20);
  return task;
};
const count = (app: App, table: string, where = '1=1') => Number(app.store.get(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`)!.n);
const finished = (app: App, runs = 1) => wait(() => count(app, 'maintenance_runs', "status<>'active'") >= runs && !app.runtime.maintenance.size, app);
const streamed = (fake: Fake) => fake.requests.filter(row => row.stream);
const summarizers = (fake: Fake) => fake.requests.filter(row => !row.stream);
const systemText = (request: Record<string, unknown>) => String((request.messages as Array<{ content: unknown }>)[0].content);
const isDigest = (request: Record<string, unknown>) => systemText(request).includes('只摘要这一个工具结果');
const isHistory = (request: Record<string, unknown>) => systemText(request).includes('"workingNote"');
const runtimeOf = (app: App, bot: string) => String(app.store.get('SELECT id FROM runtime_sessions WHERE bot_id=?', bot)!.id);
const conversationOf = (app: App, bot: string) => String(app.store.get('SELECT conversation_id FROM runtime_sessions WHERE bot_id=?', bot)!.conversation_id);
const bigDoc = (app: App, bot: string, label: string) => app.runtime.memory.write(bot, { title: label, content: `${label} ` + '资料'.repeat(1500) });
const ballast = (label: string, repeats = 1200) => `${label} ` + '合成资料'.repeat(repeats);
// The prompt no longer lists every memory (memory-recall.md: core memory and one recall per task instead), so seven
// 1,200-character documents no longer add about 12k tokens to every request. The input carries that weight instead.
const DOCUMENT_WEIGHT = 2070;
const withoutSystem = (request: Record<string, unknown>) => JSON.stringify((request.messages as Array<{ role: string }>).filter(message => message.role !== 'system' && message.role !== 'developer'));
const stored = (app: App, bot: string) => app.runtime.projection.load(runtimeOf(app, bot))!;
const edits = (app: App, bot: string) => stored(app, bot).filter(entry => entry.type === 'context_edit') as Array<{ targetId: string; replacement: { content: Array<{ text: string }> } | null }>;
const resultIds = (app: App, bot: string) => stored(app, bot).filter(entry => entry.type === 'message' && entry.message.role === 'toolResult').map(entry => entry.id);
const coreIds = (entries: Array<{ type: string; id?: string; message?: { role: string } }>) => entries.filter(entry => !(entry.type === 'message' && entry.message?.role === 'system')).map(entry => entry.id ?? entry.type);
const minutesLater = (app: App, minutes: number) => { app.runtime.clock = () => Date.now() + minutes * 60_000; };
const reply = (content: string, finish = 'stop') => ({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 400, completion_tokens: 80 } });
/** A turn that reads one 4,500-token result, then a plain one: the first is older than the latest completed turn. */
async function twoTurns(app: App, fake: Fake, bot: string) {
  const doc = bigDoc(app, bot, 'ORDER-ONE');
  fake.scripts.push({ action: 'memory.read', args: { documentId: doc.documentId } }, '第一轮完成', '第二轮完成');
  await turn(app, bot, '第一轮：读取资料', 'timing-1'); await turn(app, bot, '第二轮：继续', 'timing-2');
}
const runMaintenance = async (app: App, bot: string, minutes: number, runs: number) => { minutesLater(app, minutes); app.runtime.scheduleMaintenance(conversationOf(app, bot)); await finished(app, runs); };

describe('Failures never fail the turn, and are not retried at once', () => {
  it('keeps a cut-off digest when it is at most 30% of the original and says that it is partial', async () => {
    const { app, fake, bot } = await fixture();
    await twoTurns(app, fake, bot);
    fake.setOverride(body => body.stream ? undefined : isDigest(body) ? reply('简短摘要', 'length') : undefined);
    await runMaintenance(app, bot, 56, 1);
    expect(app.store.get('SELECT status FROM maintenance_runs')?.status).toBe('ended');
    const edit = edits(app, bot).find(item => JSON.stringify(item.replacement).includes('简短摘要'));
    expect(edit).toBeDefined();
    expect(edit!.replacement!.content[0].text).toContain(`（摘要不完整，原文 entry:${edit!.targetId}）`);
    // The original is intact and retrievable; nothing is held against the result.
    expect(JSON.stringify(stored(app, bot).find(entry => entry.id === edit!.targetId))).toContain('ORDER-ONE');
    expect(app.runtime.failures.list(runtimeOf(app, bot)).filter(row => String(row.target).startsWith('entry:'))).toHaveLength(0);
  }, 120000);

  it('counts a cut-off digest of more than 30% as a failure: backoff of 30 min and 6 h, then given up; the original and the user\'s turns are untouched', async () => {
    const { app, fake, bot } = await fixture();
    await twoTurns(app, fake, bot);
    const runtime = runtimeOf(app, bot), conversation = conversationOf(app, bot), before = coreIds(stored(app, bot));
    // The production repro: finish_reason=length on every summary, the digest's far over 30% of the result.
    fake.setOverride(body => body.stream ? undefined : reply('长'.repeat(2500), 'length'));
    await runMaintenance(app, bot, 56, 1);
    expect(app.store.get('SELECT status,error FROM maintenance_runs')).toMatchObject({ status: 'failed' });
    expect(coreIds(stored(app, bot))).toEqual(before);
    const target = `entry:${resultIds(app, bot)[0]}`;
    const record = () => app.runtime.failures.list(runtime).find(row => row.target === target)!;
    expect(record()).toMatchObject({ attempts: 1 });
    expect(Number(record().next_at)).toBeGreaterThan(Date.now() + 56 * 60_000 + BACKOFF_MS[0] - 60_000);
    expect(Number(record().next_at)).toBeLessThan(Date.now() + 56 * 60_000 + BACKOFF_MS[0] + 60_000);
    expect(app.runtime.failures.list(runtime).some(row => String(row.target).startsWith('range:'))).toBe(true);
    // In backoff: not a candidate, nothing scheduled, nothing tried however long the conversation is idle.
    const calls = fake.requests.length;
    minutesLater(app, 70); app.runtime.scheduleMaintenance(conversation);
    expect(app.runtime.maintenancePlan(conversation)).toBeUndefined();
    expect(app.runtime.maintenanceTimers.size).toBe(0);
    // Past 30 minutes the target is tried again, and fails again: now a 6 h wait.
    await runMaintenance(app, bot, 90, 2);
    expect(record().attempts).toBe(2);
    expect(Number(record().next_at)).toBeGreaterThan(Date.now() + 90 * 60_000 + BACKOFF_MS[1] - 60_000);
    // Six hours later, a third failure gives the target up for good.
    await runMaintenance(app, bot, 90 + 6 * 60 + 400, 3);
    expect(record().attempts).toBe(3);
    expect(Number(record().next_at)).toBe(GIVEN_UP);
    minutesLater(app, 24 * 60 * 365); app.runtime.scheduleMaintenance(conversation);
    expect(app.runtime.maintenancePlan(conversation)).toBeUndefined();
    expect(app.runtime.maintenanceTimers.size).toBe(0);
    expect(fake.requests.length).toBeGreaterThan(calls);
    // The projection never changed; the next turn sends the original in full and calls no summarizer.
    expect(coreIds(stored(app, bot))).toEqual(before);
    expect(edits(app, bot)).toHaveLength(0);
    minutesLater(app, 0);
    const since = fake.requests.length;
    await turn(app, bot, '第三轮：继续', 'timing-3');
    expect(fake.requests.slice(since).filter(row => !row.stream)).toHaveLength(0);
    expect(withoutSystem(streamed(fake).at(-1)!)).toContain('ORDER-ONE');
  }, 180000);

  it('pauses the conversation\'s maintenance for six hours after two failed runs in a row', async () => {
    const { app, fake, bot } = await fixture();
    await twoTurns(app, fake, bot);
    const runtime = runtimeOf(app, bot), conversation = conversationOf(app, bot);
    fake.setOverride(body => body.stream ? undefined : reply('', 'stop'));
    await runMaintenance(app, bot, 56, 1);
    expect(app.runtime.maintenancePaused(conversation)).toBe(false);
    await runMaintenance(app, bot, 90, 2);
    expect(app.store.all("SELECT status FROM maintenance_runs ORDER BY started_at").map(row => row.status)).toEqual(['failed', 'failed']);
    expect(app.runtime.maintenancePaused(conversation)).toBe(true);
    // Whatever the failure records say, the pause holds; it ends six hours after the second run.
    app.store.run('DELETE FROM compaction_failures');
    minutesLater(app, 91); app.runtime.scheduleMaintenance(conversation);
    expect(app.runtime.maintenancePlan(conversation)).toBeUndefined(); expect(app.runtime.maintenanceTimers.size).toBe(0);
    // The pause runs from the end of the second run, which just happened.
    minutesLater(app, MAINTENANCE_PAUSE_MS / 60_000 - 5); expect(app.runtime.maintenancePaused(conversation)).toBe(true);
    minutesLater(app, MAINTENANCE_PAUSE_MS / 60_000 + 5); expect(app.runtime.maintenancePaused(conversation)).toBe(false);
    expect(app.runtime.maintenancePlan(conversation)).toBeDefined();
    expect(app.runtime.failures.list(runtime)).toHaveLength(0);
  }, 180000);
});

describe('A request that does not fit is reduced in the turn', () => {
  // H = 63,856 (window 70,000), S = 56,000 (80%), T = 22,400. Turn one reads four results (18k tokens), turn two is plain, turn three reads three more after a 19k-token input (7k of its own, 12k standing in for the documents the prompt used to list).
  const setup = async (fixtureExtra: Record<string, unknown> = { contextWindow: 70000 }) => {
    const f = await fixture(fixtureExtra);
    const first = Array.from({ length: 4 }, (_, i) => bigDoc(f.app, f.bot, `SYNC-A${i}`)), second = Array.from({ length: 3 }, (_, i) => bigDoc(f.app, f.bot, `SYNC-B${i}`));
    f.fake.scripts.push(...first.map(doc => ({ action: 'memory.read', args: { documentId: doc.documentId } })), '第一轮完成', '第二轮完成', ...second.map(doc => ({ action: 'memory.read', args: { documentId: doc.documentId } })), '第三轮完成');
    await turn(f.app, f.bot, '第一轮：读取资料', 'sync-1'); await turn(f.app, f.bot, '第二轮：继续', 'sync-2');
    return f;
  };
  it('digests older results first, then keeps going: a failing fold does not fail the turn while the request fits, and a given-up target is tried once more', async () => {
    const { app, fake, bot } = await setup();
    const runtime = runtimeOf(app, bot), older = resultIds(app, bot);
    expect(older).toHaveLength(4);
    // Core has given up on these results (three failures each), but a request that does not fit may try them once more.
    for (const id of older) for (let n = 0; n < 3; n++) app.runtime.failures.record(runtime, `entry:${id}`, 'earlier failure');
    expect(app.runtime.failures.blocked(runtime).size).toBe(4);
    // Digests work; the history fold fails.
    fake.setOverride(body => body.stream || isDigest(body) ? undefined : reply('', 'stop'));
    const task = await turn(app, bot, ballast('SYNC-INPUT', 1200 + DOCUMENT_WEIGHT), 'sync-3');
    expect(app.store.get('SELECT status FROM tasks WHERE id=?', task)?.status).toBe('succeeded');
    const calls = summarizers(fake);
    expect(calls.filter(isDigest).length).toBeGreaterThanOrEqual(4);
    // Order: every digest before the fold attempt.
    const kinds = calls.map(row => isDigest(row) ? 'd' : 'f').join('');
    expect(kinds).toMatch(/^d+f+$/);
    // The older results are digested and their failure records gone; the fold failed and left its record; no compaction.
    const digested = new Set(edits(app, bot).map(edit => edit.targetId));
    for (const id of older) expect(digested.has(id)).toBe(true);
    const failures = app.runtime.failures.list(runtime);
    expect(failures.filter(row => String(row.target).startsWith('entry:'))).toHaveLength(0);
    expect(failures.filter(row => String(row.target).startsWith('range:'))).toHaveLength(1);
    expect(stored(app, bot).some(entry => entry.type === 'compaction')).toBe(false);
    // The request that went out fits the input budget, above the target; the current turn is complete.
    const sent = streamed(fake).at(-1)!, request = withoutSystem(sent);
    expect(tokens(sent)).toBeLessThan(63856);
    for (const label of ['SYNC-B0', 'SYNC-B1', 'SYNC-B2']) expect(request).toContain(label);
    expect(request).not.toContain('SYNC-A0'); expect(request).toContain('工具结果摘要');
  }, 180000);

  it('accepts a short digest cut off at the output cap (the turn succeeds) and marks it partial', async () => {
    const { app, fake, bot } = await setup();
    fake.setOverride(body => body.stream ? undefined : isDigest(body) ? reply('简短摘要', 'length') : undefined);
    const task = await turn(app, bot, ballast('SYNC-INPUT', 1200 + DOCUMENT_WEIGHT), 'sync-3');
    expect(app.store.get('SELECT status FROM tasks WHERE id=?', task)?.status).toBe('succeeded');
    const partial = edits(app, bot).filter(edit => JSON.stringify(edit.replacement).includes('摘要不完整'));
    expect(partial.length).toBeGreaterThanOrEqual(1);
    expect(app.store.all('SELECT target FROM compaction_failures').filter(row => String(row.target).startsWith('entry:'))).toHaveLength(0);
  }, 180000);
});

describe('Whole-history batches', () => {
  /** Three small turns, enough for one fold of the first two. */
  async function threeTurns(app: App, bot: string) {
    for (const [index, text] of ['第一轮：讨论方案', '第二轮：继续讨论', '第三轮：确认'].entries()) await turn(app, bot, text + ' ' + '内容'.repeat(300), `batch-${index}`);
  }
  it('sizes the output cap from the batch, splits a cut-off batch in half and retries once', async () => {
    const { app, fake, bot } = await fixture();
    await threeTurns(app, bot);
    let first = true;
    fake.setOverride(body => { if (body.stream || !isHistory(body)) return undefined; if (first) { first = false; return reply('{"workingNote":"x","history":"被截断', 'length'); } return undefined; });
    await runMaintenance(app, bot, 56, 1);
    expect(app.store.get('SELECT status FROM maintenance_runs')?.status).toBe('ended');
    const history = summarizers(fake).filter(isHistory);
    // The full batch, then its two halves.
    expect(history).toHaveLength(3);
    // Small input: 10% of it is below the floor of 2,048 tokens (the fixture model's own output limit is 4,096).
    expect(history.map(row => Number(row.max_tokens))).toEqual([2048, 2048, 2048]);
    expect(stored(app, bot).some(entry => entry.type === 'compaction')).toBe(true);
    // The retried batch succeeded: no record is left against it.
    expect(app.store.all('SELECT target FROM compaction_failures')).toHaveLength(0);
  }, 180000);

  it('keeps the originals when the halves are cut off too: nothing partial is installed, the failure is recorded, and the run fails', async () => {
    const { app, fake, bot } = await fixture();
    await threeTurns(app, bot);
    const before = coreIds(stored(app, bot));
    fake.setOverride(body => body.stream || !isHistory(body) ? undefined : reply('{"workingNote":"x","history":"被截断', 'length'));
    await runMaintenance(app, bot, 56, 1);
    // One full attempt and one half: retried once, not again.
    expect(summarizers(fake).filter(isHistory)).toHaveLength(2);
    expect(coreIds(stored(app, bot))).toEqual(before);
    expect(stored(app, bot).some(entry => entry.type === 'compaction')).toBe(false);
    expect(app.store.get('SELECT status FROM maintenance_runs')?.status).toBe('failed');
    expect(app.runtime.failures.list(runtimeOf(app, bot)).filter(row => String(row.target).startsWith('range:')).length).toBeGreaterThanOrEqual(1);
    // The worker sees the dedicated message to split on, not a generic failure.
    expect(OUTPUT_TRUNCATED).toBe('压缩输出被截断');
    expect(app.store.get('SELECT last_error FROM compaction_failures')?.last_error).toContain('未完整结束');
  }, 180000);
});

describe('Failure records', () => {
  it('backs off 30 minutes, then 6 hours, then never; a success clears the record', () => {
    const rows = new Map<string, { attempts: number; next_at: number }>();
    const store = {
      get: (_sql: string, runtime: string, target: string) => rows.has(runtime + target) ? { attempts: rows.get(runtime + target)!.attempts } : undefined,
      run: (_sql: string, runtime: string, target: string, attempts: number, nextAt: number) => { rows.set(runtime + target, { attempts, next_at: nextAt }); return { changes: 1 }; },
      all: () => [],
    };
    let at = 1_000_000;
    const failures = new CompactionFailures(store as never, () => at);
    expect(failures.record('r', 'entry:a', 'e')).toBe(1); expect(rows.get('rentry:a')!.next_at).toBe(at + 30 * 60_000);
    expect(failures.record('r', 'entry:a', 'e')).toBe(2); expect(rows.get('rentry:a')!.next_at).toBe(at + 6 * 3_600_000);
    expect(failures.record('r', 'entry:a', 'e')).toBe(3); expect(rows.get('rentry:a')!.next_at).toBe(GIVEN_UP);
    expect(failures.record('r', 'entry:a', 'e')).toBe(4); expect(rows.get('rentry:a')!.next_at).toBe(GIVEN_UP);
    expect(BACKOFF_MS).toEqual([1_800_000, 21_600_000]);
  });

  it('is deleted with forget and when the runtime is cleared; entries folded under a compaction are pruned', async () => {
    const { app, fake, bot } = await fixture();
    await twoTurns(app, fake, bot);
    const runtime = runtimeOf(app, bot), live = resultIds(app, bot)[0];
    app.runtime.failures.record(runtime, `entry:${live}`, 'e'); app.runtime.failures.record(runtime, `range:${live}..${live}`, 'e'); app.runtime.failures.record(runtime, 'entry:gone', 'e'); app.runtime.failures.record(runtime, 'range:gone..gone', 'e');
    // Pruning follows the model context: records of targets that are no longer in it go.
    app.runtime.failures.prune(runtime, stored(app, bot));
    expect(app.runtime.failures.list(runtime).map(row => row.target).sort()).toEqual([`entry:${live}`, `range:${live}..${live}`].sort());
    // Forget removes the records of the assistant's runtimes.
    app.agents.publish(bot, 'user', 'message', '待遗忘的合成偏好', 'forget-source');
    const plan = app.runtime.memory.privacy.preview(bot, { query: '待遗忘' });
    app.runtime.memory.forget(bot, { query: '待遗忘' }, plan.revision);
    expect(count(app, 'compaction_failures')).toBe(0);
    // Clearing a runtime's projection clears its records, too.
    app.runtime.failures.record(runtime, 'entry:again', 'e');
    app.runtime.forgetFence({ bots: [bot], tasks: [], banks: [], documents: [], messages: [], hashes: [], sources: [], selectorHash: 'x' } as never);
    expect(count(app, 'compaction_failures')).toBe(0);
  }, 120000);
});

describe('After Core starts', () => {
  it('arms maintenance of conversations above the threshold by the time of their last request', async () => {
    const f = await fixture(); const { app, fake, bot } = f;
    await twoTurns(app, fake, bot);
    const conversation = conversationOf(app, bot), lastEnd = app.runtime.lastRequestEnd(conversation), key = app.store.key, root = f.root;
    fixtures.splice(fixtures.indexOf(f), 1);
    await app.close();
    // A restart soon after the last request: due 55 minutes after it ended.
    const again = await createPersonalApp(options(root, key));
    try {
      clearInterval(again.runtime.memory.personal.timer);
      expect(again.runtime.maintenanceTimers.size).toBe(1);
      expect(Math.abs(again.runtime.maintenanceDue.get(conversation)! - (lastEnd + MAINTAIN_IDLE_MS))).toBeLessThan(5000);
    } finally { await again.close(); }
    // A restart long after it: due after the short start-up wait, not at once.
    const hours = 3 * 3_600_000;
    const raw = (await import('./store.ts')).CoreStore;
    const store = new raw(root, key, 'synthetic-token');
    try { store.run('UPDATE model_invocations SET finished_at=finished_at-?', hours); store.run('UPDATE tasks SET created_at=created_at-?,ended_at=ended_at-?', hours, hours); } finally { store.close(); }
    const late = await createPersonalApp(options(root, key));
    try {
      clearInterval(late.runtime.memory.personal.timer);
      expect(late.runtime.maintenanceTimers.size).toBe(1);
      const due = late.runtime.maintenanceDue.get(conversation)! - Date.now();
      expect(due).toBeGreaterThan(late.runtime.maintenanceStartup - 5000); expect(due).toBeLessThanOrEqual(late.runtime.maintenanceStartup + 1000);
    } finally { await late.close(); await fake.close(); }
  }, 180000);

  it('arms nothing for a conversation at or below the threshold', async () => {
    const f = await fixture({ contextWindow: 64000 }); const { app, fake, bot } = f;
    await twoTurns(app, fake, bot);
    const key = app.store.key, root = f.root;
    fixtures.splice(fixtures.indexOf(f), 1);
    await app.close();
    const again = await createPersonalApp(options(root, key));
    try { clearInterval(again.runtime.memory.personal.timer); expect(again.runtime.maintenanceTimers.size).toBe(0); } finally { await again.close(); await fake.close(); }
  }, 120000);
});
