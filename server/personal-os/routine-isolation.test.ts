import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPersonalApp } from './index.ts';
import { startFakeModel } from '../runtime/pi/p0/fake-model.ts';
import { ChatFiles } from './chat-files.ts';

type App = Awaited<ReturnType<typeof createPersonalApp>>;
const fixtures: Array<{ root: string; app: App; fake: Awaited<ReturnType<typeof startFakeModel>>; release: Array<() => void> }> = [];
async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nex-routine-isolation-'));
  const fake = await startFakeModel(), key = randomBytes(32);
  const app = await createPersonalApp({ dir: root, key, token: 'synthetic-routine-token', identity: false, memoryRuntime: false, hostDevice: false });
  app.store.saveConfig({ provider: 'openai', endpoint: fake.origin + '/v1', model: 'fake', apiKey: 'synthetic-only' });
  clearInterval(app.runtime.memory.personal.timer);
  const bot = app.store.createBot('隔离合成助手');
  const owned = { root, app, fake, release: [] as Array<() => void> }; fixtures.push(owned);
  const gate = () => new Promise<void>(resolve => owned.release.push(resolve));
  return { ...owned, bot, gate, key, owned };
}
async function wait(check: () => boolean, app: App) {
  const deadline = Date.now() + 25_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Isolated fixture timeout: ' + JSON.stringify(app.store.all('SELECT id,status,result_summary FROM tasks')));
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const task = (app: App, id: string) => app.store.get('SELECT * FROM tasks WHERE id=?', id)!;
const reports = (app: App, id: string) => app.store.all('SELECT * FROM agent_messages WHERE source_key=?', `routine-report:${id}`);
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const release of f.release) release();
    await f.app.close(); await f.fake.close();
    if (path.dirname(f.root) !== os.tmpdir() || !path.basename(f.root).startsWith('nex-routine-isolation-')) throw new Error('Unsafe fixture cleanup');
    rmSync(f.root, { recursive: true, force: true });
  }
});

describe('Routine execution isolation in disposable Core fixtures', () => {
  it('deletes through the authenticated API without reviving tool receipts or interrupting active work', async () => {
    const f = await fixture(), { app, bot, fake } = f;
    const draft = { name: '删除验证计划', prompt: '保留执行结果', scheduleKind: 'interval', intervalMinutes: 5 };
    fake.scripts.push(
      { kind: 'openai-tool', calls: [{ id: 'create-plan', name: 'broker', args: JSON.stringify({ action: 'routine.save', ...draft }) }] },
      { kind: 'openai-tool', calls: [{ id: 'list-plans', name: 'broker', args: JSON.stringify({ action: 'routine.list' }) }] },
      { kind: 'openai-text', text: '计划已创建' },
    );
    const owner = app.agents.send(bot, '创建合成定时计划', 'create-delete-fixture').taskId;
    await wait(() => task(app, owner).status === 'succeeded' && app.runtime.workers.size === 0, app);
    const plan = app.routines.list()[0], id = String(plan.id);
    expect(plan).toMatchObject({ bot_id: bot, version: 1 });
    const saveCall = app.store.get("SELECT * FROM tool_calls WHERE task_id=? AND tool_name='routine.save'", owner)!;
    const listCall = app.store.get("SELECT * FROM tool_calls WHERE task_id=? AND tool_name='routine.list'", owner)!;
    fake.scripts.push({ kind: 'openai-text', text: '删除后仍正常完成的结果', waitFor: f.gate() });
    app.routines.runNow(id, 'active-before-delete');
    const occurrence = app.store.get("SELECT * FROM routine_occurrences WHERE routine_id=? AND status='running'", id)!;
    const active = String(occurrence.task_id);
    await wait(() => task(app, active).status === 'running' && fake.requests.length === 4, app);
    app.routines.runNow(id, 'pending-before-delete');
    app.routines.tick(Number(plan.next_due_at));
    const post = (pathname: string, data: unknown, authenticated = true) => fetch(app.origin + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer synthetic-routine-token' } : {}) }, body: JSON.stringify(data) });
    expect((await post('/api/routines/delete', { id, version: 1 }, false)).status).toBe(401);
    const stale = await post('/api/routines/delete', { id, version: 0 });
    expect(stale.status).toBe(400); expect(await stale.json()).toMatchObject({ error: '例行任务已修改，请刷新' });
    const deleted = await post('/api/routines/delete', { id, version: 1 });
    expect(deleted.status).toBe(200); expect(await deleted.json()).toEqual({ ok: true });
    const state = await (await fetch(app.origin + '/api/state', { headers: { Authorization: 'Bearer synthetic-routine-token' } })).json() as { routines: unknown[] };
    expect(state.routines).toEqual([]);
    expect(app.store.all("SELECT trigger_source,status FROM routine_occurrences WHERE routine_id=? AND id<>? ORDER BY trigger_source", id, occurrence.id)).toEqual([{ trigger_source: 'manual', status: 'cancelled' }, { trigger_source: 'schedule', status: 'cancelled' }]);
    expect(task(app, active).status).toBe('running');
    expect(app.routines.tool(listCall, {})).toEqual({ routines: [] });
    expect(() => app.routines.tool(saveCall, JSON.parse(String(saveCall.arguments_json)))).toThrow('已删除');
    expect(() => app.routines.tool({ ...saveCall, id: 'new-save-call' }, { ...draft, routineId: id, expectedVersion: 2 })).toThrow('已删除');
    for (const [route, data] of [
      ['/api/routines', { ...draft, botId: bot, id, version: 2 }],
      ['/api/routines/toggle', { id, version: 2, enabled: true }],
      ['/api/routines/run', { id, clientId: 'new-manual' }],
      ['/api/routines/delete', { id, version: 2 }],
    ] as const) {
      const response = await post(route, data);
      expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: '例行任务已删除' });
    }
    f.release[0]();
    await wait(() => task(app, active).status === 'succeeded' && app.runtime.workers.size === 0, app);
    app.routines.tick();
    expect(reports(app, active)).toHaveLength(1);
    expect(reports(app, active)[0].content).toContain('删除后仍正常完成的结果');
    const detail = await (await fetch(app.origin + '/api/routines/occurrence?id=' + encodeURIComponent(String(occurrence.id)), { headers: { Authorization: 'Bearer synthetic-routine-token' } })).json() as { messages: Array<{ content: string }> };
    expect(detail).toMatchObject({ occurrence: { status: 'succeeded' }, task: { id: active, status: 'succeeded' } });
    expect(detail.messages.some((message: { content: string }) => message.content.includes('删除后仍正常完成的结果'))).toBe(true);
  }, 40_000);

  it('keeps a busy owner turn and a routine independent, then supplies the report at the next model boundary', async () => {
    const f = await fixture(), { app, bot, fake } = f;
    fake.scripts.push({ kind: 'openai-tool', calls: [{ id: 'owner-directory', name: 'broker', args: JSON.stringify({ action: 'agent.directory' }) }], waitFor: f.gate() });
    const owner = app.agents.send(bot, '保持当前主会话工作', 'owner-first').taskId;
    await wait(() => fake.requests.length === 1, app);
    const ownerConversation = task(app, owner).conversation_id;
    const inputs = app.store.all('SELECT * FROM conversation_inputs WHERE task_id=?', owner);
    fake.scripts.push({ kind: 'openai-tool', calls: [{ id: 'routine-html', name: 'broker', args: JSON.stringify({ action: 'html.render', content: '<p>执行详情中的中间图表</p>' }) }] }, { kind: 'openai-text', text: '合成天气最终报告：晴，23度' });
    const routine = app.agents.startRoutine(bot, '检查天气并输出结果', '每日天气', 'weather-isolation');
    expect(app.agents.startRoutine(bot, '检查天气并输出结果', '每日天气', 'weather-isolation')).toBe(routine);
    expect(task(app, routine).conversation_id).not.toBe(ownerConversation);
    expect(app.store.get('SELECT conversation_id FROM assistant_conversations WHERE bot_id=?', bot)?.conversation_id).toBe(ownerConversation);
    expect(app.store.get('SELECT active_task_id FROM agent_inboxes WHERE bot_id=?', bot)?.active_task_id).toBe(owner);
    expect(app.agents.active(bot)?.id).toBe(owner);
    expect(app.store.all('SELECT * FROM agent_messages WHERE task_id=?', routine)).toHaveLength(0);
    app.runtime.kick(routine);
    await wait(() => task(app, routine).status === 'succeeded', app);
    expect(task(app, owner).status).toBe('running');
    expect(app.store.all('SELECT * FROM conversation_inputs WHERE task_id=?', owner)).toEqual(inputs);
    expect(app.store.all('SELECT * FROM agent_messages WHERE task_id=?', routine)).toHaveLength(1);
    expect(reports(app, routine)[0]).toMatchObject({ role: 'assistant', kind: 'result', content: '定时任务「每日天气」\n合成天气最终报告：晴，23度' });
    expect(app.store.get("SELECT status FROM tool_calls WHERE task_id=? AND tool_name='html.render'", routine)?.status).toBe('succeeded');
    expect(app.store.all("SELECT * FROM transcript WHERE task_id=? AND source_key LIKE 'html:%'", routine)).toHaveLength(1);
    const firstId = reports(app, routine)[0].id;
    app.agents.reportRoutine(routine); app.runtime.onSettled?.(routine);
    expect(reports(app, routine)).toHaveLength(1); expect(reports(app, routine)[0].id).toBe(firstId);
    fake.scripts.push({ kind: 'openai-text', text: '主会话继续完成' }); f.release[0]();
    await wait(() => task(app, owner).status === 'succeeded' && app.runtime.workers.size === 0, app);
    const sent = JSON.parse(fake.requests.at(-1)!.body);
    expect(JSON.stringify(sent.messages)).toContain('合成天气最终报告：晴，23度');
    expect(JSON.stringify(sent.messages)).toContain('routineReports');
    expect(JSON.stringify(sent.messages)).not.toContain('执行详情中的中间图表');
    const projection = app.runtime.projection.load(String(app.store.get('SELECT id FROM runtime_sessions WHERE conversation_id=?', ownerConversation)!.id));
    expect(JSON.stringify(projection)).not.toContain('合成天气最终报告：晴，23度');
  }, 40_000);

  it('does not cancel or steer background work when owner input arrives', async () => {
    const f = await fixture(), { app, bot, fake } = f;
    fake.scripts.push({ kind: 'openai-text', text: '后台完成', waitFor: f.gate() });
    const routine = app.agents.startRoutine(bot, '长时间运行', '后台检查', 'background-before-owner'); app.runtime.kick(routine);
    await wait(() => fake.requests.length === 1, app);
    expect(app.agents.active(bot)).toBeUndefined();
    fake.scripts.push({ kind: 'openai-text', text: '主聊天即时回答' });
    const owner = app.agents.send(bot, '现在回答我的问题', 'owner-during-routine').taskId;
    await wait(() => task(app, owner).status === 'succeeded', app);
    expect(task(app, routine).status).toBe('running');
    expect(app.store.all('SELECT * FROM conversation_inputs WHERE task_id=?', routine)).toHaveLength(1);
    expect(app.store.all("SELECT * FROM agent_messages WHERE source_key LIKE 'routine-yield:%'")).toHaveLength(0);
    f.release[0](); await wait(() => task(app, routine).status === 'succeeded', app);
    expect(reports(app, routine)).toHaveLength(1);
  }, 40_000);

  it('reserves an owner slot per bot and lets another bot run beyond the old global cap', async () => {
    const f = await fixture(), { app, bot, fake } = f;
    // Direct startRoutine calls exercise runtime capacity; RoutineModule owns
    // the production one-active-routine gate, independently of this budget.
    const active: string[] = [];
    for (let index = 0; index < 3; index++) {
      fake.scripts.push({ kind: 'openai-text', text: '后台' + index, waitFor: f.gate() });
      const id = app.agents.startRoutine(bot, '后台工作', '容量' + index, 'capacity-' + index); active.push(id); app.runtime.kick(id);
      await wait(() => fake.requests.length === index + 1, app);
    }
    const queued = app.agents.startRoutine(bot, '排队后台工作', '容量排队', 'capacity-queued'); app.runtime.kick(queued);
    expect(task(app, queued).status).toBe('queued');
    fake.scripts.push({ kind: 'openai-text', text: '主会话名额', waitFor: f.gate() });
    const owner = app.agents.send(bot, '主聊天', 'capacity-owner').taskId;
    await wait(() => fake.requests.length === 4, app);
    expect(task(app, owner).status).toBe('running');
    const otherBot = app.store.createBot('另一位合成助手');
    fake.scripts.push({ kind: 'openai-text', text: '另一位助手即时回答' });
    const other = app.agents.send(otherBot, '独立执行', 'other-bot-capacity').taskId;
    await wait(() => task(app, other).status === 'succeeded', app);
    expect(active.every(id => task(app, id).status === 'running')).toBe(true);
    expect(task(app, queued).status).toBe('queued');
    fake.scripts.push({ kind: 'openai-text', text: '排队任务最终完成' }); f.release[0]();
    await wait(() => task(app, queued).status === 'succeeded', app);
  }, 40_000);

  it('publishes generated media only with settlement and binds the downloadable attachment to that report', async () => {
    const { app, bot } = await fixture();
    const routine = app.agents.startRoutine(bot, '生成结果图片', '图片报告', 'routine-media');
    const files = new ChatFiles(app.store);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEtcAAAAASUVORK5CYII=';
    const file = files.upload({ botId: bot, name: '合成结果.png', data: png }, app.store.session);
    const content = `![生成图片](/api/attachments/${file.id})`, row = task(app, routine);
    app.store.message(String(row.conversation_id), routine, 'assistant', content, 'image:synthetic-routine-image');
    app.runtime.onResult?.(row, 'assistant', content, 'image:synthetic-routine-image');
    expect(app.store.all('SELECT * FROM agent_messages WHERE task_id=?', routine)).toHaveLength(0);
    expect(files.authorize(file.id, bot).message_id).toBeNull();
    expect((await files.read(bot, file.id)).images?.[0].data).toBe(png);
    const peer = app.store.createBot('无权读取的助手');
    await expect(files.read(peer, file.id)).rejects.toThrow('不可访问');
    // A random unpublished upload or a user-provided URL is not authorization.
    const unbound = files.upload({ botId: bot, name: '未绑定.png', data: png }, app.store.session);
    app.store.message(String(row.conversation_id), routine, 'user', `/api/attachments/${unbound.id}`, 'input:unbound-image');
    expect(() => files.authorize(unbound.id, bot)).toThrow('不可访问');
    app.store.run('UPDATE chat_attachments SET created_at=? WHERE id=?', Date.now() - 2 * 86400_000, file.id);
    files.upload({ botId: bot, name: '触发孤立附件清理.png', data: png }, app.store.session);
    expect(files.authorize(file.id, bot).id).toBe(file.id);
    app.runtime.finishTask(routine, 'succeeded', '图片已完成');
    const report = reports(app, routine)[0];
    expect(report.content).toContain(content);
    expect(files.authorize(file.id, bot).message_id).toBe(report.id);
    app.agents.reportRoutine(routine);
    expect(reports(app, routine)).toHaveLength(1);
    app.store.run('INSERT INTO memory_forgotten_tasks VALUES(?)', routine);
    await expect(files.read(bot, file.id)).rejects.toThrow('不可访问');
    // The transcript fallback must not re-authorize a forgotten attachment either.
    app.store.run('UPDATE chat_attachments SET message_id=NULL WHERE id=?', file.id);
    await expect(files.read(bot, file.id)).rejects.toThrow('不可访问');
  });

  it('lets the scheduler expire persistently unauthorized work and dispatch the next routine', async () => {
    const { app, bot, fake } = await fixture();
    app.runtime.authorizeTask = async () => false;
    const first = app.routines.save({ botId: bot, name: '授权一直未通过', prompt: '过期后不执行', scheduleKind: 'once', runAt: Date.now() + 60_000 });
    app.routines.runNow(first.id, 'authorization-never');
    const occurrence = app.store.get('SELECT * FROM routine_occurrences WHERE routine_id=?', first.id)!;
    const blocked = String(occurrence.task_id);
    expect(task(app, blocked).status).toBe('queued');
    // Let the asynchronous authorization finish returning false, so dispatch
    // isn't testing a still-pending authorization callback.
    await new Promise(resolve => setTimeout(resolve, 0));
    app.store.run('UPDATE routine_occurrences SET expires_at=? WHERE id=?', Date.now() - 1, occurrence.id);
    app.routines.tick();
    expect(task(app, blocked).status).toBe('cancelled');
    expect(app.store.get('SELECT status FROM routine_occurrences WHERE id=?', occurrence.id)?.status).toBe('skipped');
    expect(fake.requests).toHaveLength(0); expect(reports(app, blocked)).toHaveLength(0);
    app.runtime.authorizeTask = async () => true;
    fake.scripts.push({ kind: 'openai-text', text: '后续例行任务正常完成' });
    const next = app.routines.save({ botId: bot, name: '后续工作', prompt: '现在可以执行', scheduleKind: 'once', runAt: Date.now() + 60_000 });
    app.routines.runNow(next.id, 'after-authorization-expiry');
    const nextTask = String(app.store.get('SELECT task_id FROM routine_occurrences WHERE routine_id=?', next.id)!.task_id);
    await wait(() => task(app, nextTask).status === 'succeeded', app);
    expect(reports(app, nextTask)).toHaveLength(1);
  }, 40_000);

  it('expires a queued first execution after authorization, but resumes already-started work', async () => {
    const f = await fixture(), { app, bot, fake } = f;
    const plan = app.routines.save({ botId: bot, name: '启动迟到检查', prompt: '只执行一次', scheduleKind: 'once', runAt: Date.now() + 60_000 });
    const authorization = f.gate();
    app.runtime.authorizeTask = async () => { await authorization; return true; };
    app.routines.runNow(plan.id, 'queued-expiry');
    const occurrence = app.store.get('SELECT * FROM routine_occurrences WHERE routine_id=?', plan.id)!;
    const id = String(occurrence.task_id);
    expect(task(app, id).status).toBe('queued');
    expect(occurrence.started_at).toBeNull();
    app.store.run('UPDATE routine_occurrences SET expires_at=? WHERE id=?', Date.now() - 1, occurrence.id);
    f.release[0]();
    await wait(() => task(app, id).status === 'cancelled', app);
    expect(app.store.get('SELECT status,reason,started_at FROM routine_occurrences WHERE id=?', occurrence.id)).toMatchObject({ status: 'skipped', reason: '已超过允许迟到时间', started_at: null });
    expect(reports(app, id)).toHaveLength(0); expect(fake.requests).toHaveLength(0);
    // A run that reached the model before pausing has already met the start
    // deadline; allowing recovery after expiry does not replay a missed run.
    fake.scripts.push({ kind: 'openai-text', text: '第一次请求', waitFor: f.gate() });
    app.routines.runNow(plan.id, 'started-before-expiry');
    const resumedOccurrence = app.store.get("SELECT * FROM routine_occurrences WHERE routine_id=? AND status='running'", plan.id)!;
    const resumed = String(resumedOccurrence.task_id);
    await wait(() => fake.requests.length === 1, app);
    expect(app.store.get('SELECT started_at FROM routine_occurrences WHERE id=?', resumedOccurrence.id)?.started_at).toEqual(expect.any(Number));
    app.runtime.workers.get(resumed)!.child.kill();
    await wait(() => !app.runtime.workers.has(resumed), app);
    expect(task(app, resumed).status).toBe('paused');
    app.store.run('UPDATE routine_occurrences SET expires_at=? WHERE id=?', Date.now() - 1, resumedOccurrence.id);
    fake.scripts.push({ kind: 'openai-text', text: '恢复后完成' });
    app.runtime.resume(resumed);
    await wait(() => task(app, resumed).status === 'succeeded', app);
    expect(reports(app, resumed)).toHaveLength(1);
  }, 40_000);

  it('backfills a completed routine after restart and publishes failures once without intermediate errors', async () => {
    const f = await fixture(), { app, bot } = f;
    const routine = app.agents.startRoutine(bot, '恢复后补报', '合成恢复报告', 'recover-report');
    app.store.run("UPDATE tasks SET status='succeeded',result_summary='停机前已完成',ended_at=? WHERE id=?", Date.now(), routine);
    expect(reports(app, routine)).toHaveLength(0);
    await app.close();
    const reopened = await createPersonalApp({ dir: f.root, key: f.key, token: 'synthetic-routine-token', identity: false, memoryRuntime: false, hostDevice: false });
    f.owned.app = reopened;
    clearInterval(reopened.runtime.memory.personal.timer);
    const recovered = reopened.agents;
    recovered.reportRoutine(routine); recovered.reportRoutine(routine);
    expect(reports(reopened, routine)).toHaveLength(1);
    expect(reports(reopened, routine)[0].content).toContain('停机前已完成');
    expect(f.fake.requests).toHaveLength(0);
    const failed = recovered.startRoutine(bot, '模拟必要错误', '错误检查', 'failure-report');
    const row = task(reopened, failed);
    reopened.runtime.onResult?.(row, 'system', '尚未结束的错误', 'error:intermediate');
    expect(reports(reopened, failed)).toHaveLength(0);
    reopened.runtime.finishTask(failed, 'failed', '合成服务不可用');
    recovered.reportRoutine(failed);
    expect(reopened.store.all('SELECT * FROM agent_messages WHERE task_id=?', failed)).toHaveLength(1);
    expect(reports(reopened, failed)[0]).toMatchObject({ role: 'system', kind: 'error', content: '定时任务「错误检查」\n合成服务不可用' });
  });
});
