import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPersonalApp } from './index.ts';
import { startFakeModel } from '../runtime/pi/p0/fake-model.ts';
import { id, now } from './store.ts';

it('gives public topics full access to all connectors, jobs, tools and prompts', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nex-public-scope-')), fake = await startFakeModel(), app = await createPersonalApp({ dir, key: randomBytes(32), token: 'fixture', identity: false, hostDevice: false, memoryRuntime: false, modelCatalog: { fetchDisabled: true } });
  try {
    app.store.saveConfig({ provider: 'openai', endpoint: fake.origin + '/v1', model: 'fake', apiKey: 'synthetic' });
    const { botId } = app.agents.finance();
    const add = (kind: string, name: string) => {
      const connectorId = id();
      app.store.insert('personal_connectors', { id: connectorId, ...app.store.scope(), name, url: 'https://fixture.example.test/mcp', transport: 'http', kind, enabled: 1, created_at: now(), tools_json: JSON.stringify([{ name: 'private_api_name', inputSchema: { type: 'object' } }]) });
      return connectorId;
    };
    add('mcp', 'SECRET-MAILBOX');
    add('stock-finance', 'SECRET-FINANCE-ACCOUNT');
    const kick = app.runtime.kick; app.runtime.kick = () => {};
    const privateJob = app.jobs.start({ botId, title: 'SECRET-PRIVATE-JOB', prompt: 'private task', sourceKey: 'private-job' });
    const pub = app.agents.send(botId, 'public scope test', 'public-scope', undefined, { newConversation: true, audience: 'public' });
    const publicJob = app.jobs.start({ botId, title: 'PUBLIC-JOB', sources: ['message:' + pub.messageId], originTaskId: pub.taskId!, sourceKey: 'public-job' });
    app.runtime.kick = kick; app.runtime.authorizeTask = async task => task.id === pub.taskId;
    fake.scripts.push(
      { kind: 'openai-tool', calls: [{ id: 'list-connectors', name: 'broker', args: JSON.stringify({ action: 'connector.list' }) }] },
      { kind: 'openai-tool', calls: [{ id: 'list-jobs', name: 'broker', args: JSON.stringify({ action: 'job.list' }) }] },
      { kind: 'openai-text', text: 'public research complete' },
    );
    app.runtime.kick(pub.taskId!);
    const deadline = Date.now() + 25000;
    while (app.store.get('SELECT status FROM tasks WHERE id=?', pub.taskId)?.status !== 'succeeded' && Date.now() < deadline) await new Promise(r => setTimeout(r, 30));
    expect(app.store.get('SELECT status FROM tasks WHERE id=?', pub.taskId)?.status).toBe('succeeded');
    const bodies = JSON.stringify(fake.requests.map(r => r.body));
    expect(bodies).toContain('SECRET-MAILBOX');
    expect(bodies).toContain('PUBLIC-JOB');
    expect(bodies).toContain('web.fetch');
    expect(() => app.runtime.assertTopicTool(pub.taskId!, 'device.exec', {})).not.toThrow();
    expect(() => app.runtime.assertTopicTool(publicJob.taskId, 'device.read', {})).not.toThrow();
    app.agents.cancelTopic(botId, pub.conversationId); app.jobs.stop(privateJob.jobId);
  } finally { await app.close(); await fake.close(); rmSync(dir, { recursive: true, force: true }); }
}, 35000);
