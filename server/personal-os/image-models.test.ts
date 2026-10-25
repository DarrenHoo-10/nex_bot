import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createPersonalApp } from './index.ts';
import { ImageModels } from './image-models.ts';
import { ChatFiles } from './chat-files.ts';
import { evaluateTool, basicActions } from './policy.ts';
import { startFakeModel } from '../runtime/pi/p0/fake-model.ts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEtcAAAAASUVORK5CYII=';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(check: () => boolean) {
  const end = Date.now() + 25000;
  while (!check()) { if (Date.now() > end) throw new Error('Image fixture timed out'); await new Promise(resolve => setTimeout(resolve, 25)); }
}
async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nex-image-models-')), key = randomBytes(32), token = 'synthetic-image-owner';
  cleanup.push(async () => {
    if (path.dirname(dir).toLowerCase() !== os.tmpdir().toLowerCase() || !path.basename(dir).startsWith('nex-image-models-')) throw new Error('Unsafe cleanup');
    rmSync(dir, { recursive: true, force: true });
  });
  const requests: Array<{ path: string; authorization?: string; body: Record<string, unknown> }> = [];
  let reply: unknown = { data: [{ b64_json: png }] }, status = 200, hold: Promise<void> | undefined;
  const model = await startFakeModel(); cleanup.push(() => model.close());
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url !== '/v1/images/generations') {
      const upstream = await fetch(model.origin + req.url, { method: req.method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body } : {}) });
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type')! }); res.end(Buffer.from(await upstream.arrayBuffer())); return;
    }
    requests.push({ path: req.url!, authorization: req.headers.authorization, body: JSON.parse(body) });
    if (hold) await hold;
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  let app = await createPersonalApp({ dir, key, token, identity: false, memoryRuntime: false, hostDevice: false });
  cleanup.push(() => app.close());
  app.store.saveConfig({ provider: 'openai', endpoint, model: 'fixture', apiKey: 'synthetic-chat-key' });
  const bot = app.store.createBot('Image fixture');
  const request = (route: string, data?: unknown, auth = token) => fetch(app.origin + '/api/' + route, { headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }) });
  const select = (models: string[]) => app.store.saveImageModelSelection({ provider: 'openai', endpoint, models, version: app.store.imageModelSelection().version });
  return { select, get app() { return app; }, model, bot, request, endpoint, requests, token,
    respond(value: unknown, code = 200) { reply = value; status = code; },
    hold(value: Promise<void>) { hold = value; },
    async restart() { await app.close(); app = await createPersonalApp({ dir, key, token, identity: false, memoryRuntime: false, hostDevice: false }); },
  };
}

it('selects existing models, reuses credentials, fences stale edits and scopes selections to the connection', async () => {
  const f = await fixture(), data = { provider: 'openai', endpoint: f.endpoint, models: ['image-fixture', 'second'], version: 0 };
  expect((await f.request('models/images', data, 'invalid')).status).toBe(401);
  expect((await f.request('models/images', data)).status).toBe(200);
  expect((await f.request('models/images', data)).status).toBe(400);
  expect((await f.request('models/images', { ...data, version: 1, endpoint: f.endpoint + '/other' })).status).toBe(400);
  expect((await f.request('image-models/save', {})).status).toBe(410);
  expect((await f.request('image-models/delete', {})).status).toBe(410);
  expect(f.app.store.all('SELECT id FROM image_models')).toHaveLength(0);
  expect(JSON.stringify(f.app.store.state())).not.toContain('synthetic-chat-key');
  await f.restart();
  const models = new ImageModels(f.app.store); expect(models.list().map(row => row.id)).toEqual(data.models);
  await models.generate({ prompt: 'a blue bird' }, new AbortController().signal);
  await models.generate({ prompt: 'a red bird', modelId: 'second' }, new AbortController().signal);
  expect(f.requests.map(req => req.authorization)).toEqual(['Bearer synthetic-chat-key', 'Bearer synthetic-chat-key']);
  expect(f.requests[1].body.model).toBe('second');
  f.app.store.saveConfig({ provider: 'openai', endpoint: f.endpoint + '/other', model: 'fixture', apiKey: 'other-key' });
  expect(models.list()).toEqual([]);
  f.app.store.saveConfig({ provider: 'openai', endpoint: f.endpoint, model: 'fixture', apiKey: 'synthetic-chat-key' });
  expect(models.list()).toHaveLength(2);
  f.select([]); expect(models.list()).toEqual([]);
});

it('generates through a real worker and publishes a scoped, previewable, downloadable image', async () => {
  const f = await fixture();
  f.select(['gpt-image-fixture']);
  f.app.store.run('UPDATE bot_policies SET policy_json=? WHERE bot_id=?', JSON.stringify({ tools: ['attachment.read'] }), f.bot);
  f.model.scripts.push(
    { kind: 'openai-tool', calls: [{ id: 'image-list', name: 'broker', args: JSON.stringify({ action: 'image.models' }) }] },
    { kind: 'openai-tool', calls: [{ id: 'image-generate', name: 'broker', args: JSON.stringify({ action: 'image.generate', modelId: 'gpt-image-fixture', prompt: '画一只蓝色小鸟', size: '1536x1024' }) }] },
    { kind: 'openai-text', text: '图片已生成' },
  );
  const sent = await (await f.request('agents/input', { botId: f.bot, text: '画一只蓝色小鸟', clientId: 'image-turn' })).json() as { taskId: string };
  await until(() => f.app.store.get('SELECT status FROM tasks WHERE id=?', sent.taskId)?.status === 'succeeded');
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toMatchObject({ path: '/v1/images/generations', body: { model: 'gpt-image-fixture', prompt: '画一只蓝色小鸟', size: '1536x1024', n: 1 } });
  expect(f.requests[0].body).not.toHaveProperty('response_format');
  const call = f.app.store.get("SELECT * FROM tool_calls WHERE tool_name='image.generate'")!;
  expect(call.status).toBe('succeeded');
  const result = JSON.parse(String(call.result_json)) as { url: string; attachmentId: string };
  expect(String(call.result_json)).not.toContain(png);
  const message = f.app.store.get("SELECT * FROM agent_messages WHERE source_key=?", `image:${call.id}`)!;
  expect(message.content).toContain(`![生成图片](${result.url})`);
  expect(f.app.store.all('SELECT id FROM approvals')).toHaveLength(0);
  const preview = await f.request(`attachments/${result.attachmentId}?preview=1`);
  expect(preview.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await preview.arrayBuffer()).toString('base64')).toBe(png);
  expect((await f.request(`attachments/${result.attachmentId}`)).headers.get('content-disposition')).toContain('attachment;');
  expect((await f.request(`attachments/${result.attachmentId}?preview=1`, undefined, 'bad')).status).toBe(401);
  const peer = f.app.store.createBot('Peer');
  await expect(new ChatFiles(f.app.store).read(peer, result.attachmentId)).rejects.toThrow('不可访问');
  f.app.store.run("UPDATE agent_messages SET content='[已遗忘]' WHERE id=?", message.id);
  expect((await f.request(`attachments/${result.attachmentId}?preview=1`)).status).toBe(400);
}, 60000);

it('rejects unselected models, missing models, invalid results, URL-only output and leaking provider errors', async () => {
  const f = await fixture(), models = new ImageModels(f.app.store), signal = new AbortController().signal;
  await expect(models.generate({ prompt: 'bird' }, signal)).rejects.toThrow('选择生图模型');
  f.select(['compatible-image']);
  await expect(models.generate({ prompt: 'bird', modelId: 'missing' }, signal)).rejects.toThrow('未被选为生图模型');
  await expect(models.generate({ prompt: 'bird', size: '99999x99999' }, signal)).rejects.toThrow('尺寸');
  for (const reply of [{ data: [] }, { data: [{ url: 'http://127.0.0.1/private' }] }, { data: [{ b64_json: 'SGVsbG8=' }] }]) {
    f.respond(reply); await expect(models.generate({ prompt: 'bird' }, signal)).rejects.toThrow();
  }
  expect(f.requests).toHaveLength(3);
  expect(f.requests[0].body.response_format).toBe('b64_json');
  f.respond({ error: 'synthetic-secret-do-not-leak' }, 401);
  await expect(models.generate({ prompt: 'bird' }, signal)).rejects.toThrow('生图服务返回 HTTP 401');
  f.respond({ data: [{ b64_json: Buffer.alloc(6 * 1024 * 1024).toString('base64') }] });
  await expect(models.generate({ prompt: 'bird' }, signal)).rejects.toThrow('超过 5 MB');
});

it('stopping an in-flight generation prevents late attachments and messages', async () => {
  const f = await fixture();
  f.select(['image-fixture']);
  let release!: () => void; f.hold(new Promise<void>(resolve => { release = resolve; }));
  f.model.scripts.push({ kind: 'openai-tool', calls: [{ id: 'slow-image', name: 'broker', args: JSON.stringify({ action: 'image.generate', prompt: 'bird' }) }] });
  const sent = f.app.agents.send(f.bot, 'draw a bird', 'slow-image');
  await until(() => f.requests.length === 1);
  f.app.runtime.cancel(sent.taskId, '用户停止'); release();
  await until(() => f.app.runtime.workers.size === 0);
  expect(f.app.store.all('SELECT id FROM chat_attachments')).toHaveLength(0);
  expect(f.app.store.all("SELECT id FROM agent_messages WHERE source_key LIKE 'image:%'")).toHaveLength(0);
  expect(f.app.store.get('SELECT status FROM tasks WHERE id=?', sent.taskId)?.status).toBe('cancelled');
}, 60000);

it('does not publish an image when stopped during object storage upload', async () => {
  const f = await fixture(); f.select(['image-fixture']);
  let release!: () => void, started = false, stored = '';
  const held = new Promise<void>(resolve => { release = resolve; });
  f.app.store.attachmentObjects = { async put(_key, value) { started = true; await held; stored = value; }, async get() { return stored; } };
  f.model.scripts.push({ kind: 'openai-tool', calls: [{ id: 'cloud-image', name: 'broker', args: JSON.stringify({ action: 'image.generate', prompt: 'bird' }) }] });
  const sent = f.app.agents.send(f.bot, 'draw a bird', 'cloud-image');
  await until(() => started); f.app.runtime.cancel(sent.taskId, '用户停止'); release();
  await until(() => f.app.store.attachmentJobs.size === 0 && f.app.runtime.workers.size === 0);
  expect(f.app.store.all("SELECT id FROM agent_messages WHERE source_key LIKE 'image:%'")).toHaveLength(0);
  const file = f.app.store.get('SELECT id FROM chat_attachments')!;
  expect((await f.request(`attachments/${file.id}`)).status).toBe(400);
}, 60000);

it('grants image capability to old restricted and new agents while preserving other restrictions', async () => {
  const f = await fixture(), peer = f.app.store.createBot('Restricted');
  const old = basicActions.filter(action => !action.startsWith('image.'));
  f.app.store.run('UPDATE bot_policies SET policy_json=? WHERE bot_id=?', JSON.stringify({ tools: old }), f.bot);
  f.app.store.run('UPDATE bot_policies SET policy_json=? WHERE bot_id=?', JSON.stringify({ tools: ['attachment.read'] }), peer);
  f.app.store.run('DROP TABLE image_models'); f.app.store.run('DELETE FROM schema_migrations WHERE version=19');
  await f.restart();
  expect(evaluateTool(f.app.store, f.bot, { action: 'image.generate', prompt: 'bird' }).approvalRequired).toBe(false);
  expect(evaluateTool(f.app.store, peer, { action: 'image.generate', prompt: 'bird' }).approvalRequired).toBe(false);
  expect(evaluateTool(f.app.store, peer, { action: 'image.models' }).approvalRequired).toBe(false);
  expect(() => evaluateTool(f.app.store, peer, { action: 'memory.search', query: 'private' })).toThrow('无权');
  expect(JSON.parse(String(f.app.agents.policyView(peer)!.policy_json)).tools).toEqual(['attachment.read', 'image.models', 'image.generate', 'html.render']);
  const version = f.app.store.get('SELECT version FROM bot_policies WHERE bot_id=?', peer)!.version;
  expect((await f.request('bots/policy', { id: peer, version, tools: [] })).status).toBe(200);
  const state = await (await f.request('state')).json() as { bots: { id: string; policy_json: string }[]; directory: { id: string; capabilities: string[] }[] };
  expect(JSON.parse(state.bots.find(bot => bot.id === peer)!.policy_json).tools).toEqual(['image.models', 'image.generate', 'html.render']);
  expect(state.directory.find(bot => bot.id === peer)!.capabilities).toEqual(['image.models', 'image.generate', 'html.render']);
  const fresh = f.app.store.createBot('New');
  expect(evaluateTool(f.app.store, fresh, { action: 'image.generate', prompt: 'bird' }).approvalRequired).toBe(false);
  f.app.store.run("UPDATE bots SET status='archived' WHERE id=?", peer);
  expect(() => evaluateTool(f.app.store, peer, { action: 'image.generate', prompt: 'bird' })).toThrow('无权');
  expect(() => evaluateTool(f.app.store, 'not-an-agent', { action: 'image.models' })).toThrow('无权');
});

it.each(['selection', 'connection', 'permission'])('does not publish a late image after %s changes', async (change) => {
  const f = await fixture();
  f.select(['image-fixture']);
  let release!: () => void; f.hold(new Promise<void>(resolve => { release = resolve; }));
  f.model.scripts.push({ kind: 'openai-tool', calls: [{ id: 'changed-image', name: 'broker', args: JSON.stringify({ action: 'image.generate', prompt: 'bird' }) }] }, { kind: 'openai-text', text: '生成未完成' });
  const sent = f.app.agents.send(f.bot, 'draw a bird', 'changed-image');
  await until(() => f.requests.length === 1);
  if (change === 'selection') f.select([]);
  else if (change === 'connection') f.app.store.saveConfig({ provider: 'openai', endpoint: f.endpoint, model: 'fixture', apiKey: 'rotated-key' });
  else f.app.store.run('UPDATE bot_policies SET policy_json=?,version=version+1 WHERE bot_id=?', JSON.stringify({ tools: ['image.models'] }), f.bot);
  release();
  await until(() => f.app.store.get('SELECT status FROM tasks WHERE id=?', sent.taskId)?.status === 'succeeded');
  expect(f.app.store.get("SELECT status FROM tool_calls WHERE provider_tool_call_id='changed-image'")?.status).toBe('failed');
  expect(f.app.store.all('SELECT id FROM chat_attachments')).toHaveLength(0);
}, 60000);
