import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPersonalApp } from './index.ts';
import { startFakeModel, type FakeModel, type FakeScript } from '../runtime/pi/p0/fake-model.ts';
import { leaseResources } from './device-leases.ts';
import { todoSchema } from './todo-schema.ts';
import type { TodoItem } from '../../shared/personal-todos.ts';

type App = Awaited<ReturnType<typeof createPersonalApp>>;
const token = 'synthetic-jobs-token';
const fixtures: Array<{ root: string; app: App; close: () => Promise<void>; release: Array<() => void> }> = [];

/**
 * A fake model per lane: a job's requests all carry its brief (`后台任务「title」。`), so each job gets its own
 * script queue and parallel jobs stay deterministic. Everything else (the main chat, delegated peers) is `main`.
 */
async function router() {
  const main = await startFakeModel(), lanes = new Map<string, FakeModel>();
  const server = createServer((request, response) => { void (async () => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    const lane = [...lanes].find(([title]) => body.includes(`后台任务「${title}」。`))?.[1] ?? main;
    const abort = new AbortController(); request.once('close', () => { if (!response.writableFinished) abort.abort(); });
    try {
      const upstream = await fetch(lane.origin + request.url, { method: request.method, headers: { 'Content-Type': 'application/json' }, body: body || undefined, signal: abort.signal });
      response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
      if (upstream.body) for await (const chunk of upstream.body) response.write(chunk);
      response.end();
    } catch { response.destroy(); }
  })(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    main, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    async lane(title: string, ...scripts: FakeScript[]) { const fake = lanes.get(title) ?? await startFakeModel(); lanes.set(title, fake); fake.scripts.push(...scripts); return fake; },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); for (const fake of [main, ...lanes.values()]) await fake.close(); },
  };
}
async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nex-jobs-')), key = randomBytes(32), model = await router();
  const start = async () => {
    const app = await createPersonalApp({ dir: root, key, token, identity: false, memoryRuntime: false, hostDevice: false });
    clearInterval(app.runtime.memory.personal.timer);
    return app;
  };
  const app = await start();
  app.store.saveConfig({ provider: 'openai', endpoint: model.origin + '/v1', model: 'fake', apiKey: 'synthetic-only' });
  const bot = app.store.createBot('后台合成助手');
  const owned = { root, app, close: () => model.close(), release: [] as Array<() => void> }; fixtures.push(owned);
  const gate = () => new Promise<void>(resolve => owned.release.push(resolve));
  const request = (route: string, data?: unknown, auth = true) => fetch(owned.app.origin + '/api/' + route, { headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }) });
  return {
    get app() { return owned.app; }, model, bot, gate, request, owned,
    async restart() { await owned.app.close(); owned.app = await start(); return owned.app; },
  };
}
async function wait(check: () => boolean, app: () => App) {
  const deadline = Date.now() + 25_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Isolated job fixture timeout: ' + JSON.stringify(app().store.all('SELECT id,status,result_summary FROM tasks')));
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const tool = (id: string, args: Record<string, unknown>): FakeScript => ({ kind: 'openai-tool', calls: [{ id, name: 'broker', args: JSON.stringify(args) }] });
const say = (text: string, waitFor?: Promise<void>): FakeScript => ({ kind: 'openai-text', text, ...(waitFor ? { waitFor } : {}) });
const task = (app: App, id: string) => app.store.get('SELECT * FROM tasks WHERE id=?', id)!;
const jobRow = (app: App, id: string) => app.store.get('SELECT * FROM agent_jobs WHERE id=?', id)!;
const view = (app: App, id: string) => app.jobs.list().find(job => job.id === id)!;
const reportMessages = (app: App, jobId: string) => app.store.all("SELECT m.* FROM agent_messages m JOIN agent_job_reports r ON m.source_key='job-report:'||r.id WHERE r.job_id=? ORDER BY m.seq", jobId);
const tasksOf = (app: App, jobId: string) => app.store.all('SELECT * FROM tasks WHERE conversation_id=? ORDER BY created_at,rowid', jobRow(app, jobId).conversation_id);
const idle = (app: App) => app.runtime.workers.size === 0;
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const release of f.release) release();
    await f.app.close(); await f.close();
    if (path.dirname(f.root) !== os.tmpdir() || !path.basename(f.root).startsWith('nex-jobs-')) throw new Error('Unsafe fixture cleanup');
    rmSync(f.root, { recursive: true, force: true });
  }
});

describe('Background jobs in disposable Core fixtures', () => {
  it('dispatches from the main chat into an isolated job that reports back once', async () => {
    const f = await fixture(), { app, bot, model } = f;
    await model.lane('整理下载文件夹', tool('report-ready', { action: 'job.report', state: 'ready', summary: '已整理 12 个文件' }), say('整理完成的执行细节'));
    model.main.scripts.push(tool('dispatch', { action: 'job.start', title: '整理下载文件夹', note: '用户已确认用方案 B' }), say('已交给后台：整理下载文件夹'));
    const owner = app.agents.send(bot, '帮我把下载文件夹按类型整理好', 'dispatch-input').taskId;
    await wait(() => task(app, owner).status === 'succeeded' && app.store.all('SELECT id FROM agent_job_reports WHERE message_id IS NOT NULL').length === 1 && idle(app), () => app);
    const call = app.store.get("SELECT * FROM tool_calls WHERE task_id=? AND tool_name='job.start'", owner)!;
    const { jobId } = JSON.parse(String(call.result_json)) as { jobId: string };
    const job = jobRow(app, jobId), [round] = tasksOf(app, jobId);
    expect(job).toMatchObject({ bot_id: bot, origin_task_id: owner, title: '整理下载文件夹', source_key: `job-start:${call.id}` });
    expect(round.conversation_id).not.toBe(task(app, owner).conversation_id);
    expect(app.store.get('SELECT origin FROM agent_task_links WHERE task_id=?', round.id)?.origin).toBe('job');
    const source = app.store.get("SELECT id FROM agent_messages WHERE task_id=? AND role='user'", owner)!;
    const brief = JSON.parse(String(app.store.get('SELECT content_json FROM conversation_inputs WHERE task_id=?', round.id)!.content_json)).text as string;
    expect(brief).toContain(`[message:${source.id} `);
    expect(brief).toContain('帮我把下载文件夹按类型整理好');
    expect(brief).toContain('主对话备注：用户已确认用方案 B');
    expect(JSON.parse(String(job.brief_json))).toMatchObject({ sources: [`message:${source.id}`], note: '用户已确认用方案 B' });
    // The message stream shows the hand-off and the report, never the job's execution.
    const stream = app.agents.messages(bot);
    expect(stream.map(m => JSON.stringify([m.role, m.kind, m.content])).sort()).toEqual([
      ['user', 'message', '帮我把下载文件夹按类型整理好'],
      ['system', 'activity', '已交给后台：整理下载文件夹'],
      ['assistant', 'message', '已交给后台：整理下载文件夹'],
      ['assistant', 'result', '后台任务「整理下载文件夹」\n已整理 12 个文件'],
    ].map(row => JSON.stringify(row)).sort());
    expect(stream.find(m => m.kind === 'activity')).toMatchObject({ job_id: jobId, job_title: '整理下载文件夹', task_id: owner });
    expect(stream.find(m => m.kind === 'result')).toMatchObject({ job_id: jobId, job_state: 'ready' });
    expect(JSON.stringify(stream)).not.toContain('整理完成的执行细节');
    const state = await (await f.request('state')).json() as { jobs: Array<{ id: string; stage: string; latestReport: { state: string; summary: string } }>; tasks: Array<{ id: string; origin: string }> };
    expect(state.jobs.find(item => item.id === jobId)).toMatchObject({ stage: 'done', latestReport: { state: 'ready', summary: '已整理 12 个文件' } });
    expect(state.tasks.find(item => item.id === round.id)?.origin).toBe('job');
    const detail = await (await f.request('jobs/detail?id=' + jobId)).json() as { messages: Array<{ content: string }>; steps: Array<{ tool_name: string }>; reports: unknown[] };
    expect(detail.messages.some(message => message.content === '整理完成的执行细节')).toBe(true);
    expect(detail.steps.map(step => step.tool_name)).toEqual(['job.report']);
    expect(detail.reports).toHaveLength(1);
    expect((await f.request('jobs/detail?id=' + jobId, undefined, false)).status).toBe(401);
    // Settlement and the tool call replay once.
    app.jobs.settle(String(round.id)); app.jobs.recover();
    expect(reportMessages(app, jobId)).toHaveLength(1);
    expect(app.jobs.tool(call, JSON.parse(String(call.arguments_json)))).toEqual(JSON.parse(String(call.result_json)));
    expect(app.store.all('SELECT id FROM agent_jobs')).toHaveLength(1);
    const ownerProjection = app.runtime.projection.load(String(app.store.get('SELECT id FROM runtime_sessions WHERE conversation_id=?', task(app, owner).conversation_id)!.id));
    expect(JSON.stringify(ownerProjection)).not.toContain('整理完成的执行细节');
  }, 60_000);

  it('keeps the main chat responsive while a job runs, then supplies the report at its next request', async () => {
    const f = await fixture(), { app, bot, model } = f;
    const lane = await model.lane('长时间整理', say('长时间整理的结论', f.gate()));
    const job = app.jobs.start({ botId: bot, title: '长时间整理', prompt: '慢慢整理资料', sourceKey: 'responsive-job' });
    await wait(() => lane.requests.length === 1, () => app);
    expect(view(app, job.jobId).stage).toBe('running');
    model.main.scripts.push(say('主对话即时回答'));
    const owner = app.agents.send(bot, '现在回答我的问题', 'responsive-owner').taskId;
    await wait(() => task(app, owner).status === 'succeeded', () => app);
    expect(task(app, job.taskId).status).toBe('running');
    expect(app.store.all('SELECT * FROM conversation_inputs WHERE task_id=?', job.taskId)).toHaveLength(1);
    // A running job is not the main chat's work: nothing there for new input to steer or a new topic to wait for.
    expect(app.agents.active(bot)).toBeUndefined();
    f.owned.release[0]();
    await wait(() => reportMessages(app, job.jobId).length === 1 && idle(app), () => app);
    expect(lane.requests.every(request => !request.body.includes('现在回答我的问题'))).toBe(true);
    expect(app.store.get('SELECT automatic FROM agent_job_reports WHERE job_id=?', job.jobId)?.automatic).toBe(1);
    model.main.scripts.push(say('知道了'));
    const next = app.agents.send(bot, '后台那件事怎么样了', 'responsive-next').taskId;
    await wait(() => task(app, next).status === 'succeeded', () => app);
    const sent = model.main.requests.at(-1)!.body;
    expect(sent).toContain('jobReports'); expect(sent).toContain('长时间整理的结论'); expect(sent).toContain('currentMessages');
    expect(sent).toContain('job.start(title'); expect(sent).toContain('你是主对话');
    expect(lane.requests[0].body).toContain('你在执行一项后台任务'); expect(lane.requests[0].body).toContain('job.report(state');
    expect(lane.requests[0].body).not.toContain('你是主对话');
  }, 60_000);

  it('runs three jobs in parallel, queues a fourth in the shared background slots and still starts the main chat', async () => {
    const f = await fixture(), { app, bot, model } = f;
    const lanes = await Promise.all([0, 1, 2, 3].map(index => model.lane('并行' + index, say('并行结果' + index, f.gate()))));
    const jobs = [0, 1, 2, 3].map(index => app.jobs.start({ botId: bot, title: '并行' + index, prompt: '第 ' + index + ' 项', sourceKey: 'parallel-' + index }));
    await wait(() => lanes.slice(0, 3).every(lane => lane.requests.length === 1), () => app);
    expect(view(app, jobs[3].jobId).stage).toBe('queued');
    expect(lanes[3].requests).toHaveLength(0);
    model.main.scripts.push(say('主对话名额'));
    const owner = app.agents.send(bot, '主对话不受影响', 'parallel-owner').taskId;
    await wait(() => task(app, owner).status === 'succeeded', () => app);
    for (const release of f.owned.release) release();
    await wait(() => jobs.every(job => reportMessages(app, job.jobId).length === 1) && idle(app), () => app);
    // Each job's context holds its own brief only.
    for (const [index, lane] of lanes.entries()) for (const other of [0, 1, 2, 3].filter(n => n !== index)) expect(lane.requests[0].body).not.toContain('第 ' + other + ' 项');
  }, 60_000);

  it('refuses long tools in the main chat with useJob, keeps topic questions there and runs them inside a job', async () => {
    const f = await fixture(), { app, bot, model } = f, peer = app.store.createBot('合成同伴');
    const device = app.gateway.pair('合成电脑').deviceId;
    app.store.run("INSERT INTO device_local_grants(device_id,local_grant_id,workspace_id,owner_user_id,policy_version,scope_json,status,reported_at) VALUES(?,'shared',?,?,1,?,'active',?)", device, app.store.workspace, app.store.owner, JSON.stringify({ root: 'shared', info: true, read: true, exec: true, computer: true, identity: { supported: ['device.computer'] } }), Date.now());
    model.main.scripts.push({ kind: 'openai-tool', calls: [
      { id: 'owner-computer', name: 'broker', args: JSON.stringify({ action: 'device.computer', deviceId: device, operation: 'click', parameters: { x: 1, y: 1 } }) },
      { id: 'owner-image', name: 'broker', args: JSON.stringify({ action: 'image.generate', prompt: '一只鸟' }) },
      { id: 'owner-delegate', name: 'broker', args: JSON.stringify({ action: 'agent.delegate', botId: peer, message: '帮我查资料' }) },
      { id: 'owner-topic', name: 'broker', args: JSON.stringify({ action: 'agent.delegate', botId: peer, message: '那个项目怎么部署', topic: 'memory:missing-topic' }) },
    ] }, say('我会交给后台任务'));
    const owner = app.agents.send(bot, '点一下、画张图、问问同伴', 'owner-refused').taskId;
    await wait(() => task(app, owner).status === 'succeeded' && idle(app), () => app);
    const calls = Object.fromEntries(app.store.all('SELECT provider_tool_call_id,status,result_json FROM tool_calls WHERE task_id=?', owner).map(call => [call.provider_tool_call_id, call]));
    for (const id of ['owner-computer', 'owner-image', 'owner-delegate']) {
      expect(calls[id].status).toBe('failed');
      expect(JSON.parse(String(calls[id].result_json))).toEqual({ error: '主对话不直接执行此操作，请用 job.start 交给后台任务', useJob: true });
    }
    // The topic question is evaluated as before (here it names no topic the peer looks after).
    expect(JSON.parse(String(calls['owner-topic'].result_json)).useJob).toBeUndefined();
    expect(app.store.all('SELECT * FROM approvals')).toHaveLength(0);
    expect(app.store.all('SELECT * FROM device_calls')).toHaveLength(0);
    expect(app.store.all('SELECT * FROM a2a_messages')).toHaveLength(0);
    expect(model.main.requests[0].body).toContain('仅后台任务可用');
    // Inside a job the same delegation runs, and waits for the peer synchronously.
    await model.lane('请同伴协助', tool('job-delegate', { action: 'agent.delegate', botId: peer, message: '请整理合成资料' }), say('已拿到同伴的整理结果'));
    model.main.scripts.push(say('同伴的合成资料'));
    const job = app.jobs.start({ botId: bot, title: '请同伴协助', prompt: '请同伴整理资料', sourceKey: 'job-delegate' });
    await wait(() => reportMessages(app, job.jobId).length === 1 && idle(app), () => app);
    const link = app.store.get('SELECT * FROM a2a_messages')!;
    expect(link).toMatchObject({ parent_task_id: job.taskId, status: 'succeeded' });
    expect(reportMessages(app, job.jobId)[0].content).toContain('已拿到同伴的整理结果');
    expect(app.agents.messages(bot).some(message => String(message.source_key).startsWith('a2a-'))).toBe(false);
  }, 60_000);

  it('publishes the last report of each round, asks questions and settles every outcome once', async () => {
    const f = await fixture(), { app, bot, model } = f;
    const lane = await model.lane('导出报告',
      tool('first', { action: 'job.report', state: 'ready', summary: '先写的结论' }),
      tool('second', { action: 'job.report', state: 'question', summary: '报告已整理好', question: '导出为 PDF 还是 Word？' }),
      say('等待回答'));
    const job = app.jobs.start({ botId: bot, title: '导出报告', prompt: '整理并导出报告', sourceKey: 'report-states' });
    await wait(() => reportMessages(app, job.jobId).length === 1 && idle(app), () => app);
    expect(view(app, job.jobId)).toMatchObject({ stage: 'question', latestReport: { state: 'question', question: '导出为 PDF 还是 Word？' } });
    expect(reportMessages(app, job.jobId)[0]).toMatchObject({ role: 'assistant', kind: 'request', content: '后台任务「导出报告」\n报告已整理好\n\n导出为 PDF 还是 Word？' });
    expect(app.store.all('SELECT * FROM agent_job_reports WHERE job_id=?', job.jobId)).toHaveLength(1);
    // A direct reply opens the next round and is shown in the stream.
    lane.scripts.push(tool('blocked', { action: 'job.report', state: 'blocked', summary: '导出设备离线' }), say('受阻'));
    expect((await f.request('jobs/input', { jobId: job.jobId, text: 'PDF', clientId: 'reply-1' })).status).toBe(202);
    await wait(() => reportMessages(app, job.jobId).length === 2 && idle(app), () => app);
    const rounds = tasksOf(app, job.jobId);
    expect(rounds).toHaveLength(2);
    const reply = app.agents.messages(bot).find(message => message.source_key === `job-input:${job.jobId}:reply-1`)!;
    expect(reply).toMatchObject({ role: 'user', content: 'PDF', job_id: job.jobId });
    expect(reportMessages(app, job.jobId)[1]).toMatchObject({ role: 'system', kind: 'error' });
    expect(view(app, job.jobId).stage).toBe('blocked');
    lane.scripts.push(tool('dropped', { action: 'job.report', state: 'dropped', summary: '已被其他工作覆盖' }), say('无需处理'));
    app.jobs.input(job.jobId, '再看一下', 'retry-dropped', 'direct');
    await wait(() => tasksOf(app, job.jobId).length === 3 && tasksOf(app, job.jobId)[2].ended_at !== null && idle(app), () => app);
    expect(reportMessages(app, job.jobId)).toHaveLength(2);
    expect(view(app, job.jobId).stage).toBe('dropped');
    lane.scripts.push({ kind: 'openai-error', status: 400, message: '合成模型错误' });
    app.jobs.input(job.jobId, '再试一次', 'retry-failed', 'direct');
    await wait(() => reportMessages(app, job.jobId).length === 3 && idle(app), () => app);
    expect(reportMessages(app, job.jobId)[2]).toMatchObject({ role: 'system', kind: 'error' });
    expect(view(app, job.jobId)).toMatchObject({ stage: 'failed', latestReport: { state: 'failed', automatic: true } });
    for (const round of tasksOf(app, job.jobId)) app.jobs.settle(String(round.id));
    app.jobs.recover();
    expect(reportMessages(app, job.jobId)).toHaveLength(3);
    // A report from outside the job is refused.
    model.main.scripts.push(tool('owner-report', { action: 'job.report', state: 'ready', summary: '主对话不能回报' }), say('主对话回答'));
    const ownerTask = app.agents.send(bot, '主对话', 'foreign').taskId;
    await wait(() => task(app, ownerTask).status === 'succeeded' && idle(app), () => app);
    expect(JSON.parse(String(app.store.get("SELECT result_json FROM tool_calls WHERE provider_tool_call_id='owner-report'")!.result_json))).toMatchObject({ error: expect.stringContaining('只有后台任务') });
    expect(app.store.all('SELECT * FROM agent_job_reports WHERE job_id=?', job.jobId)).toHaveLength(4);
  }, 60_000);

  it('routes direct replies, main-chat hand-overs, stop and stop-all to the right job', async () => {
    const f = await fixture(), { app, bot, model } = f;
    const lane = await model.lane('持续整理', { kind: 'hang' });
    const job = app.jobs.start({ botId: bot, title: '持续整理', prompt: '持续整理资料', sourceKey: 'interaction' });
    await wait(() => lane.requests.length === 1, () => app);
    expect((await f.request('jobs/input', { jobId: job.jobId, text: '顺便整理图片', clientId: 'steer-1' })).status).toBe(202);
    expect(app.store.all('SELECT * FROM conversation_inputs WHERE task_id=?', job.taskId)).toHaveLength(2);
    model.main.scripts.push(tool('hand-over', { action: 'job.message', jobId: job.jobId, text: '用户要求改成 PDF' }), say('已转交给后台'));
    const owner = app.agents.send(bot, '刚才那个改成 PDF', 'hand-over-input').taskId;
    await wait(() => task(app, owner).status === 'succeeded', () => app);
    const inputs = app.store.all('SELECT content_json FROM conversation_inputs WHERE task_id=? ORDER BY input_seq', job.taskId).map(row => JSON.parse(String(row.content_json)).text as string);
    expect(inputs).toHaveLength(3);
    const source = app.store.get("SELECT id FROM agent_messages WHERE task_id=? AND role='user'", owner)!;
    expect(inputs[2]).toContain(`用户在主对话中说（message:${source.id}）：`);
    expect(inputs[2]).toContain('刚才那个改成 PDF'); expect(inputs[2]).toContain('主对话备注：用户要求改成 PDF');
    expect(app.agents.messages(bot).filter(message => message.role === 'user').map(message => message.content)).toEqual(['顺便整理图片', '刚才那个改成 PDF']);
    expect((await f.request('jobs/stop', { jobId: job.jobId }, false)).status).toBe(401);
    expect((await f.request('jobs/stop', { jobId: job.jobId })).status).toBe(200);
    await wait(() => task(app, job.taskId).status === 'cancelled', () => app);
    expect(view(app, job.jobId).stage).toBe('stopped');
    const refused = await f.request('jobs/input', { jobId: job.jobId, text: '继续', clientId: 'after-stop' });
    expect(refused.status).toBe(400); expect(await refused.json()).toMatchObject({ error: expect.stringContaining('已停止') });
    // Stop-all ends the main chat and every job, including one waiting for an answer.
    const waiting = await model.lane('等待回答', tool('ask', { action: 'job.report', state: 'question', summary: '需要确认', question: '要继续吗？' }), say('等待'));
    const question = app.jobs.start({ botId: bot, title: '等待回答', prompt: '需要确认后继续', sourceKey: 'stop-all-question' });
    await wait(() => view(app, question.jobId).stage === 'question' && waiting.requests.length === 2, () => app);
    const running = await model.lane('还在运行', { kind: 'hang' });
    const busy = app.jobs.start({ botId: bot, title: '还在运行', prompt: '一直运行', sourceKey: 'stop-all-running' });
    model.main.scripts.push({ kind: 'hang' });
    const ownerBusy = app.agents.send(bot, '主对话也在忙', 'stop-all-owner').taskId;
    await wait(() => running.requests.length === 1 && model.main.requests.length === 3, () => app);
    expect((await f.request('agents/stop-all', { botId: bot })).status).toBe(200);
    await wait(() => idle(app), () => app);
    expect([task(app, busy.taskId).status, task(app, ownerBusy).status]).toEqual(['cancelled', 'cancelled']);
    expect([view(app, question.jobId).stage, view(app, busy.jobId).stage]).toEqual(['stopped', 'stopped']);
  }, 60_000);

  it('asks for approval inside a job, keeps it through main-chat input and continues once approved', async () => {
    const f = await fixture(), { app, bot, model } = f;
    const doc = app.runtime.memory.write(bot, { title: '合成待清理记忆', content: '用于验证后台审批' });
    const lane = await model.lane('清理记忆', tool('job-delete', { action: 'memory.delete', documentId: doc.documentId, expectedVersion: doc.version }));
    const job = app.jobs.start({ botId: bot, title: '清理记忆', prompt: '清理指定记忆', sourceKey: 'approval-job' });
    await wait(() => !!app.store.get("SELECT id FROM approvals WHERE status='pending'"), () => app);
    expect(view(app, job.jobId).stage).toBe('approval');
    model.main.scripts.push(say('主对话照常回答'));
    const owner = app.agents.send(bot, '今天天气怎么样', 'during-approval').taskId;
    await wait(() => task(app, owner).status === 'succeeded', () => app);
    const approval = app.store.get("SELECT * FROM approvals WHERE status='pending'")!;
    lane.scripts.push(say('已清理'));
    app.runtime.decide(String(approval.id), String(approval.argument_hash), true);
    await wait(() => reportMessages(app, job.jobId).length === 1 && idle(app), () => app);
    expect(app.store.get('SELECT status FROM memory_documents WHERE id=?', doc.documentId)?.status).toBe('deleted');
  }, 60_000);

  it('recovers jobs across restart: re-runs interrupted rounds, backfills reports and shows reconciliation as blocked', async () => {
    const f = await fixture(), { bot, model } = f;
    let app = f.app;
    const lane = await model.lane('重启恢复', { kind: 'hang' });
    const running = app.jobs.start({ botId: bot, title: '重启恢复', prompt: '重启前后都要完成', sourceKey: 'restart-running' });
    await wait(() => lane.requests.length === 1, () => app);
    app.runtime.authorizeTask = async () => false;
    const ended = app.jobs.start({ botId: bot, title: '停机前已完成', prompt: '停机前完成', sourceKey: 'restart-ended' });
    const blocked = app.jobs.start({ botId: bot, title: '需要核对', prompt: '结果未知', sourceKey: 'restart-unknown' });
    await new Promise(resolve => setTimeout(resolve, 0));
    app.store.run("UPDATE tasks SET status='succeeded',result_summary='停机前已完成的结论',ended_at=? WHERE id=?", Date.now(), ended.taskId);
    app.store.run("UPDATE tasks SET status='needs_reconciliation' WHERE id=?", blocked.taskId);
    lane.scripts.push(say('重启后完成'));
    app = await f.restart();
    await wait(() => reportMessages(app, running.jobId).length === 1 && reportMessages(app, ended.jobId).length === 1, () => app);
    expect(reportMessages(app, ended.jobId)[0].content).toBe('后台任务「停机前已完成」\n停机前已完成的结论');
    expect(reportMessages(app, running.jobId)[0].content).toContain('重启后完成');
    expect(view(app, blocked.jobId).stage).toBe('blocked');
    app.jobs.recover();
    expect(reportMessages(app, ended.jobId)).toHaveLength(1);
  }, 60_000);

  it('runs a todo as a job: a question keeps it running, both acceptance paths are version-checked, revisions reuse the job', async () => {
    const f = await fixture(), { app, bot, model } = f;
    const lane = await model.lane('写周报', tool('todo-question', { action: 'job.report', state: 'question', summary: '需要范围', question: '包含下周计划吗？' }), say('等待'));
    const item = app.todos.save({ id: 'todo-job', version: 0, title: '写周报', description: '本周进展', owner: bot, date: '', priority: '普通', steps: [] });
    const started = app.todos.action({ id: item.id, version: item.version, action: 'start', clientId: 'todo-start' }, app.store.session) as TodoItem;
    expect(started.status).toBe('running');
    const job = app.store.get('SELECT * FROM agent_jobs WHERE todo_id=?', item.id)!;
    await wait(() => view(app, String(job.id)).stage === 'question' && idle(app), () => app);
    expect(app.todos.get(item.id)).toMatchObject({ status: 'running' });
    expect(app.todos.get(item.id).log).toContain('等待你回答');
    expect(app.agents.messages(bot).map(message => message.role)).toEqual(['system', 'assistant']);
    lane.scripts.push(tool('todo-ready', { action: 'job.report', state: 'ready', summary: '周报已写好' }), say('完成'));
    expect((await f.request('jobs/input', { jobId: job.id, text: '包含', clientId: 'todo-answer' })).status).toBe(202);
    await wait(() => app.todos.get(item.id).status === 'review' && idle(app), () => app);
    const review = view(app, String(job.id));
    expect(review).toMatchObject({ stage: 'review', todoId: item.id, todoStatus: 'review' });
    // The report card and the todo panel send the same versioned action; the second one is refused.
    expect((await f.request('todos/action', { id: item.id, version: review.todoVersion, action: 'complete' })).status).toBe(200);
    expect((await f.request('todos/action', { id: item.id, version: review.todoVersion, action: 'complete' })).status).toBe(409);
    expect(view(app, String(job.id)).stage).toBe('done');
    const reopened = app.todos.action({ ...app.todos.get(item.id), action: 'reopen' }, app.store.session) as TodoItem;
    lane.scripts.push(tool('todo-revised', { action: 'job.report', state: 'ready', summary: '周报已改好' }), say('改好了'));
    app.todos.action({ id: item.id, version: reopened.version, action: 'start', clientId: 'todo-revise', feedback: '加上风险' }, app.store.session);
    await wait(() => app.todos.get(item.id).status === 'review' && idle(app), () => app);
    expect(app.store.all('SELECT id FROM agent_jobs WHERE todo_id=?', item.id)).toHaveLength(1);
    expect(tasksOf(app, String(job.id))).toHaveLength(3);
    expect(lane.requests.at(-1)!.body).toContain('修改要求：加上风险');
    lane.scripts.push({ kind: 'hang' });
    const again = app.todos.action({ ...app.todos.get(item.id), action: 'start', clientId: 'todo-stop', feedback: '再改一次' }, app.store.session) as TodoItem;
    await wait(() => lane.requests.length === 7, () => app);
    app.todos.action({ ...again, action: 'stop' }, app.store.session);
    await wait(() => app.todos.get(item.id).status === 'todo' && idle(app), () => app);
    expect(app.todos.get(item.id).log).toContain('执行已停止');
    expect(view(app, String(job.id)).stage).toBe('stopped');
    // A main-chat todo task still follows the original trigger.
    model.main.scripts.push(say('旧路径完成'));
    const legacy = app.todos.save({ id: 'todo-owner', version: 0, title: '旧待办', description: '', owner: bot, date: '', priority: '普通', steps: [] });
    const ownerTask = app.agents.send(bot, '旧待办', 'legacy-todo').taskId;
    app.store.run("UPDATE todos SET status='running',task_id=? WHERE id=?", ownerTask, legacy.id);
    await wait(() => task(app, ownerTask).status === 'succeeded', () => app);
    expect(app.todos.get(legacy.id).status).toBe('review');
  }, 60_000);

  it('leases a device resource per device: writers wait, readers and other devices do not, and a freed screen wakes the waiter', async () => {
    const f = await fixture(), { app, bot, model } = f;
    app.runtime.authorizeTask = async () => false;
    const a = app.jobs.start({ botId: bot, title: '操作甲', prompt: '操作屏幕', sourceKey: 'lease-a' });
    const b = app.jobs.start({ botId: bot, title: '操作乙', prompt: '也操作屏幕', sourceKey: 'lease-b' });
    const one = app.gateway.pair('合成设备一').deviceId, two = app.gateway.pair('合成设备二').deviceId;
    expect(leaseResources('device.computer', { operation: 'click' })).toEqual(['screen']);
    expect(leaseResources('device.computer', { operation: 'get_window_state' })).toEqual([]);
    expect(leaseResources('device.exec', { command: 'echo' })).toEqual([]);
    const call = (taskId: string, deviceId: string, operation: string) => app.gateway.execute({ id: `call-${taskId}-${deviceId}-${operation}`, task_id: taskId, target_id: deviceId, tool_name: 'device.computer', authorization_snapshot_json: '{}' }, { operation });
    // Past the lease the call reaches the (offline) device.
    await expect(call(a.taskId, one, 'click')).rejects.toThrow('设备离线');
    expect(await call(b.taskId, one, 'type_text')).toEqual({ error: '屏幕正被「操作甲」使用', waitingFor: `resource:${one}:screen` });
    await expect(call(b.taskId, one, 'get_window_state')).rejects.toThrow('设备离线');
    await expect(call(b.taskId, two, 'click')).rejects.toThrow('设备离线');
    expect(app.store.all('SELECT device_id,task_id FROM device_resource_leases ORDER BY device_id')).toEqual([{ device_id: one, task_id: a.taskId }, { device_id: two, task_id: b.taskId }].sort((x, y) => x.device_id.localeCompare(y.device_id)));
    // A holder whose task ended (a crash before release) is taken over.
    app.store.run("UPDATE tasks SET status='failed',ended_at=? WHERE id=?", Date.now(), b.taskId);
    const c = app.jobs.start({ botId: bot, title: '操作丙', prompt: '接管', sourceKey: 'lease-c' });
    await expect(call(c.taskId, two, 'click')).rejects.toThrow('设备离线');
    // Stopping a job releases its leases; a job blocked on that resource gets a new round.
    app.store.run("UPDATE tasks SET status='succeeded',ended_at=? WHERE id=?", Date.now(), c.taskId);
    app.store.run("INSERT INTO agent_job_reports(id,job_id,task_id,state,summary,waiting_for,created_at) VALUES('blocked-c',?,?,'blocked','屏幕正被占用',?,?)", c.jobId, c.taskId, `resource:${one}:screen`, Date.now());
    app.runtime.authorizeTask = async () => true;
    await model.lane('操作丙', say('屏幕空出后完成'));
    app.jobs.stop(a.jobId);
    expect(app.store.all('SELECT * FROM device_resource_leases WHERE task_id=?', a.taskId)).toEqual([]);
    await wait(() => tasksOf(app, c.jobId).length === 2, () => app);
    const wake = JSON.parse(String(app.store.get('SELECT content_json FROM conversation_inputs WHERE task_id=?', tasksOf(app, c.jobId)[1].id)!.content_json)).text;
    expect(wake).toBe('屏幕已空闲，可以继续。');
    await wait(() => reportMessages(app, c.jobId).length === 1 && idle(app), () => app);
  }, 60_000);

  it('migrates a database from before background jobs without changing existing rows', async () => {
    const f = await fixture(), { bot, model } = f;
    let app = f.app;
    model.main.scripts.push(say('迁移前的回答'));
    const owner = app.agents.send(bot, '迁移前的消息', 'before-migration').taskId;
    await wait(() => task(app, owner).status === 'succeeded' && idle(app), () => app);
    const item = app.todos.save({ id: 'todo-before', version: 0, title: '迁移前待办', description: '', owner: bot, date: '', priority: '普通', steps: [] });
    // Rewind the database to migration 42.
    const oldTrigger = /CREATE TRIGGER todo_task_ended[\s\S]*?END;/.exec(todoSchema)![0];
    app.store.db.exec(`DROP TABLE device_resource_leases; DROP TABLE job_tool_receipts; DROP TABLE agent_job_reports; DROP TABLE agent_jobs; DROP TRIGGER todo_task_ended;
      CREATE TABLE agent_task_links_old (task_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES agent_inboxes(bot_id), origin TEXT NOT NULL CHECK(origin IN ('owner','routine')), source_key TEXT NOT NULL UNIQUE, FOREIGN KEY(task_id,bot_id) REFERENCES tasks(id,bot_id)) STRICT;
      INSERT INTO agent_task_links_old SELECT * FROM agent_task_links; DROP TABLE agent_task_links; ALTER TABLE agent_task_links_old RENAME TO agent_task_links;
      ${oldTrigger} DELETE FROM schema_migrations WHERE version=43;`);
    const links = app.store.all('SELECT * FROM agent_task_links ORDER BY task_id'), todos = app.store.all('SELECT * FROM todos ORDER BY id');
    expect(String(app.store.get("SELECT sql FROM sqlite_master WHERE name='agent_task_links'")?.sql)).not.toContain("'job'");
    app = await f.restart();
    expect(app.store.all('SELECT * FROM agent_task_links ORDER BY task_id')).toEqual(links);
    expect(app.store.all('SELECT * FROM todos ORDER BY id')).toEqual(todos);
    expect(String(app.store.get("SELECT sql FROM sqlite_master WHERE name='agent_task_links'")?.sql)).toContain("'job'");
    expect(app.store.get('SELECT version FROM schema_migrations WHERE version=43')).toBeDefined();
    expect(app.store.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(app.todos.get(item.id).status).toBe('todo');
    expect(app.agents.messages(bot).map(message => message.content)).toEqual(['迁移前的消息', '迁移前的回答']);
  }, 60_000);
});
