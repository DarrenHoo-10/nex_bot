import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createPersonalApp } from './index.ts';
import { startFakeModel, type FakeModel } from '../runtime/pi/p0/fake-model.ts';
import { resolveReasoning } from './reasoning.ts';

type App = Awaited<ReturnType<typeof createPersonalApp>>;
const token = 'synthetic-connections-token';
const owned: Array<{ root: string; app?: App; models: FakeModel[] }> = [];
afterEach(async () => {
  for (const fixture of owned.splice(0)) {
    await fixture.app?.close();
    for (const model of fixture.models) await model.close();
    if (path.dirname(fixture.root) !== os.tmpdir() || !path.basename(fixture.root).startsWith('nex-connections-')) throw new Error('Unsafe fixture cleanup');
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nex-connections-')), key = randomBytes(32);
  const first = await startFakeModel(), second = await startFakeModel();
  const entry: { root: string; app?: App; models: FakeModel[] } = { root, models: [first, second] };
  owned.push(entry);
  const open = async () => {
    entry.app = await createPersonalApp({ dir: root, key, token, identity: false, memoryRuntime: false, hostDevice: false, modelCatalog: { fetchDisabled: true, readSnapshot: () => undefined, log: () => {} } });
    clearInterval(entry.app.runtime.memory.personal.timer);
    return entry.app;
  };
  const app = await open();
  const request = async <T = Record<string, unknown>>(route: string, data?: unknown) => {
    const response = await fetch(entry.app!.origin + '/api/' + route, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }) });
    const body = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    return body;
  };
  const state = () => request<{ config: Record<string, unknown>; connections: Array<Record<string, any>>; bots: Array<Record<string, any>> }>('state');
  return { root, app, first, second, request, state, get app_() { return entry.app!; }, async reopen() { await entry.app!.close(); return open(); } };
}
const wait = async (done: () => boolean, ms = 15000) => { const end = Date.now() + ms; while (!done()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 25)); } };

describe('Model providers (供应商)', () => {
  it('keeps the legacy single connection as the default provider and its API working', async () => {
    const f = await fixture();
    await f.request('config', { provider: 'openai', endpoint: f.first.origin + '/v1', model: 'first-model', apiKey: 'synthetic-first' });
    const state = await f.state();
    expect(state.config).toMatchObject({ id: 'default', provider_id: 'openai', endpoint: f.first.origin + '/v1', default_model: 'first-model', configured: 1 });
    expect(state.connections).toEqual([expect.objectContaining({ id: 'default', provider: 'openai', defaultModel: 'first-model', isDefault: true, enabled: true, configured: true })]);
    expect(f.app.store.get("SELECT id FROM secrets WHERE id='model-key'")).toBeTruthy();
    // An older client's bots/model (provider + endpoint, no connectionId) still works against it.
    const bot = f.app.store.createBot('合成助手');
    await f.request('bots/model', { id: bot, model: 'first-other', provider: 'openai', endpoint: f.first.origin + '/v1', version: 0 });
    expect(f.app.store.modelConfig(bot)).toMatchObject({ connectionId: 'default', model: 'first-other', apiKey: 'synthetic-first', reasoning: 'off' });
  });

  it('upgrades a single-connection database without changing its rows', async () => {
    const f = await fixture();
    await f.request('config', { provider: 'anthropic', endpoint: f.first.origin, model: 'legacy-model', apiKey: 'synthetic-legacy' });
    const bot = f.app.store.createBot('合成助手');
    await f.request('bots/model', { id: bot, model: 'legacy-chosen', provider: 'anthropic', endpoint: f.first.origin, version: 0 });
    // Turn the database back into v44: no provider columns, no options table, no reasoning column, no migration row.
    const db = f.app.store;
    db.run('DELETE FROM schema_migrations WHERE version IN (45,46)');
    db.run('DROP TABLE model_display_names');
    for (const column of ['enabled', 'is_default', 'sort_order']) db.run(`ALTER TABLE model_connections DROP COLUMN ${column}`);
    db.run('DROP TABLE model_options');
    db.run('ALTER TABLE agent_model_settings DROP COLUMN reasoning');
    const before = { connection: db.get("SELECT id,display_name,provider_id,endpoint,credential_ref,default_model,status,version FROM model_connections"), selection: db.get('SELECT * FROM agent_model_settings') };
    const app = await f.reopen();
    expect(app.store.get('SELECT version FROM schema_migrations WHERE version=45')).toBeTruthy();
    expect(app.store.get("SELECT id,display_name,provider_id,endpoint,credential_ref,default_model,status,version FROM model_connections")).toEqual(before.connection);
    expect(app.store.get('SELECT bot_id,provider,endpoint,model,version FROM agent_model_settings')).toEqual(before.selection);
    expect(app.store.defaultConnection()?.id).toBe('default');
    expect(app.store.modelConfig(bot)).toMatchObject({ connectionId: 'default', provider: 'anthropic', model: 'legacy-chosen', apiKey: 'synthetic-legacy' });
  });

  it('adds, edits, makes default and removes providers, each with its own key', async () => {
    const f = await fixture();
    await f.request('config', { provider: 'openai', endpoint: f.first.origin + '/v1', model: 'first-model', apiKey: 'synthetic-first' });
    await expect(f.request('connections/save', { name: '第二家', provider: 'openai', endpoint: f.second.origin + '/v1' })).rejects.toThrow('请配置 API Key');
    await expect(f.request('connections/save', { name: '重复', provider: 'openai', endpoint: f.first.origin + '/v1/', apiKey: 'x' })).rejects.toThrow('已使用相同的 API 格式和地址');
    const { id: second } = await f.request<{ id: string }>('connections/save', { name: '第二家', provider: 'openai', endpoint: f.second.origin + '/v1', apiKey: 'synthetic-second', defaultModel: 'second-model' });
    let state = await f.state();
    expect(state.connections.map(c => [c.name, c.isDefault, c.configured])).toEqual([['Default', true, true], ['第二家', false, true]]);
    expect(JSON.stringify(state)).not.toContain('synthetic-second');
    // Its model list uses its own saved key, with nothing typed.
    await expect(f.request('models/list', { connectionId: second })).resolves.toMatchObject({ models: expect.any(Array) });
    // A stale version is refused; the key stays when left empty.
    const version = state.connections[1].version;
    await expect(f.request('connections/save', { id: second, version: version - 1, name: '改名', provider: 'openai', endpoint: f.second.origin + '/v1' })).rejects.toThrow('其他设备');
    await f.request('connections/save', { id: second, version, name: '改名', provider: 'openai', endpoint: f.second.origin + '/v1' });
    expect(f.app.store.connectionSecret(second)?.apiKey).toBe('synthetic-second');
    // Default moves; the default cannot be disabled or removed.
    await f.request('connections/default', { id: second });
    state = await f.state();
    expect(state.config).toMatchObject({ id: second, default_model: 'second-model' });
    await expect(f.request('connections/save', { id: second, version: state.connections[0].version, name: '改名', provider: 'openai', endpoint: f.second.origin + '/v1', enabled: false })).rejects.toThrow('默认供应商不能停用');
    await expect(f.request('connections/remove', { id: second, version: state.connections[0].version })).rejects.toThrow('默认供应商不能删除');
    // Removing a provider erases its key and sends its assistants back to the default.
    const bot = f.app.store.createBot('合成助手');
    const firstRow = state.connections.find(c => c.id === 'default')!;
    await f.request('bots/model', { id: bot, connectionId: 'default', model: 'first-model', version: 0 });
    await f.request('connections/remove', { id: 'default', version: firstRow.version });
    expect(f.app.store.get("SELECT id FROM secrets WHERE id='model-key'")).toBeUndefined();
    expect((await f.state()).connections.map(c => c.id)).toEqual([second]);
    expect(f.app.store.modelConfig(bot)).toMatchObject({ connectionId: second, model: 'second-model', apiKey: 'synthetic-second' });
  });

  it('switches an assistant between providers with its own model and reasoning, refusing stale versions', async () => {
    const f = await fixture();
    await f.request('config', { provider: 'openai', endpoint: f.first.origin + '/v1', model: 'first-model', apiKey: 'synthetic-first' });
    const { id: second } = await f.request<{ id: string }>('connections/save', { name: '第二家', provider: 'anthropic', endpoint: f.second.origin, apiKey: 'synthetic-second', defaultModel: 'claude-x' });
    await f.request('connections/model', { connectionId: second, model: 'claude-x', reasoning: ['low', 'high', 'max'], imageInput: true, version: 0 });
    const bot = f.app.store.createBot('合成助手');
    await f.request('bots/model', { id: bot, connectionId: second, model: 'claude-x', reasoning: 'medium', version: 0 });
    let selection = (await f.state()).bots.find(b => b.id === bot)!;
    expect(selection).toMatchObject({ selected_connection: second, selected_model: 'claude-x', selected_reasoning: 'medium' });
    // medium is not offered: the nearer lower level is used.
    expect(f.app.store.modelConfig(bot)).toMatchObject({ connectionId: second, provider: 'anthropic', model: 'claude-x', apiKey: 'synthetic-second', reasoning: 'low' });
    await expect(f.request('bots/model', { id: bot, connectionId: 'default', model: 'first-model', version: 0 })).rejects.toThrow('其他设备');
    await f.request('bots/model', { id: bot, connectionId: 'default', model: 'first-model', version: selection.model_selection_version });
    selection = (await f.state()).bots.find(b => b.id === bot)!;
    expect(selection).toMatchObject({ selected_connection: 'default', selected_model: 'first-model' });
    expect(f.app.store.modelConfig(bot)).toMatchObject({ connectionId: 'default', reasoning: 'off' });
    // Disabling a provider sends its assistants to the default until it is enabled again.
    await f.request('bots/model', { id: bot, connectionId: second, model: 'claude-x', version: selection.model_selection_version });
    const row = (await f.state()).connections.find(c => c.id === second)!;
    await f.request('connections/save', { id: second, version: row.version, name: row.name, provider: 'anthropic', endpoint: f.second.origin, enabled: false });
    expect(f.app.store.modelConfig(bot).connectionId).toBe('default');
  });

  it.each(['openai', 'anthropic'] as const)('sends reasoning to the %s model only when the model offers levels', async (provider) => {
    const f = await fixture();
    const endpoint = provider === 'openai' ? f.first.origin + '/v1' : f.first.origin;
    await f.request('config', { provider, endpoint, model: 'thinker', apiKey: 'synthetic-first' });
    const reply = provider === 'openai' ? { kind: 'openai-text' as const, text: '好的' } : { kind: 'anthropic-text' as const, text: '好的' };
    const bot = f.app.store.createBot('合成助手');
    const turn = async (clientId: string) => {
      f.first.scripts.push(reply);
      const taskId = f.app.agents.send(bot, '你好', clientId).taskId;
      await wait(() => ['succeeded', 'failed'].includes(String(f.app.store.get('SELECT status FROM tasks WHERE id=?', taskId)?.status)) && f.app.runtime.workers.size === 0);
      expect(f.app.store.get('SELECT status FROM tasks WHERE id=?', taskId)?.status).toBe('succeeded');
      return JSON.parse(f.first.requests.filter(r => r.body).at(-1)!.body);
    };
    const plain = await turn('plain');
    expect(plain.reasoning_effort).toBeUndefined(); expect(plain.thinking).toBeUndefined(); expect(plain.output_config).toBeUndefined();
    await f.request('connections/model', { connectionId: 'default', model: 'thinker', reasoning: ['low', 'medium', 'high'], version: 0 });
    await f.request('bots/model', { id: bot, connectionId: 'default', model: 'thinker', reasoning: 'high', version: 0 });
    const thinking = await turn('thinking');
    if (provider === 'openai') expect(thinking.reasoning_effort).toBe('high');
    else expect(thinking.thinking ?? thinking.output_config).toBeTruthy();
  });

  it('keeps the display names a provider lists for rewritten ids and shows them with its connection', async () => {
    const f = await fixture();
    let list = [{ id: 'claude-fable-5-dd-6.4-korg', display_name: 'Grok 4.6' }, { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }, { id: 'same', display_name: 'same' }];
    const server = createServer((request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(request.url === '/v1/models' ? { data: list, has_more: false } : {})); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      await f.request('config', { provider: 'anthropic', endpoint, model: 'claude-opus-5-5', apiKey: 'synthetic-proxy' });
      await f.request('models/list', { connectionId: 'default' });
      expect((await f.state()).connections[0].names).toEqual({ 'claude-fable-5-dd-6.4-korg': 'Grok 4.6', 'claude-opus-5-5': 'Claude Opus 5.5' });
      // A fresh complete list replaces the names; the request still uses the original id.
      list = [{ id: 'claude-fable-5-dd-6.4-korg', display_name: 'Grok 4.6 Fast' }];
      await f.request('models/list', { connectionId: 'default' });
      expect((await f.state()).connections[0].names).toEqual({ 'claude-fable-5-dd-6.4-korg': 'Grok 4.6 Fast' });
      expect(f.app.store.modelConfig().model).toBe('claude-opus-5-5');
      // A list fetched for an address no provider uses is not kept.
      await f.request('models/list', { provider: 'anthropic', endpoint: endpoint + '/other', apiKey: 'x' }).catch(() => undefined);
      expect(f.app.store.all('SELECT DISTINCT endpoint FROM model_display_names').map(row => row.endpoint)).toEqual([endpoint]);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('picks the nearest offered reasoning level', () => {
    expect(resolveReasoning('high', [])).toBe('off');
    expect(resolveReasoning('off', ['low'])).toBe('off');
    expect(resolveReasoning(null, ['low', 'medium', 'high'])).toBe('medium');
    expect(resolveReasoning('medium', ['low', 'high'])).toBe('low');
    expect(resolveReasoning('max', ['low', 'high'])).toBe('high');
    expect(resolveReasoning('xhigh', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('xhigh');
  });
});
