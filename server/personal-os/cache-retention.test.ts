import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createPersonalApp } from './index.ts';
import { startFakeModel } from '../runtime/pi/p0/fake-model.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function send(provider: 'anthropic' | 'openai') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nex-cache-')); roots.push(root);
  const fake = await startFakeModel();
  const app = await createPersonalApp({ dir: root, key: randomBytes(32), token: 'cache', identity: false, hostDevice: false, memoryRuntime: false, modelCatalog: { fetchDisabled: true } });
  try {
    app.store.saveConfig({ provider, endpoint: fake.origin + '/v1', model: 'fixture-model', apiKey: 'synthetic-key', contextWindow: 180000, maxOutputTokens: 12345 });
    const bot = app.store.createBot('Fixture'); app.agents.ensure(bot);
    fake.scripts.push(provider === 'openai' ? { kind: 'openai-text', text: 'cached' } : { kind: 'anthropic-text', text: 'cached' }, provider === 'openai' ? { kind: 'openai-text', text: 'again' } : { kind: 'anthropic-text', text: 'again' });
    for (const [index, text] of ['hello', 'once more'].entries()) {
      const sent = app.agents.send(bot, text, `cache-${index}`);
      const deadline = Date.now() + 25000;
      while (app.store.get('SELECT status FROM tasks WHERE id=?', sent.taskId)?.status !== 'succeeded' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
      expect(app.store.get('SELECT status FROM tasks WHERE id=?', sent.taskId)).toMatchObject({ status: 'succeeded' });
      while (app.runtime.workers.size) await new Promise(resolve => setTimeout(resolve, 20));
    }
    return { bodies: fake.requests.filter(request => request.url.includes(provider === 'openai' ? 'completions' : 'messages')).map(request => JSON.parse(request.body)), prompt: app.runtime.promptParts(String(app.store.get('SELECT id FROM tasks ORDER BY created_at LIMIT 1')!.id)) };
  } finally { await app.close(); await fake.close(); }
}

it('asks Anthropic for the 1 h cache tier on the system prompt and the conversation, and keeps the marker when the prompt text is replaced', async () => {
  const { bodies, prompt } = await send('anthropic');
  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    // The system prompt is Core's stable prompt, in the block the SDK marked: the marker and its ttl survive the replacement.
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system).toHaveLength(1);
    expect(body.system[0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral', ttl: '1h' } });
    expect(body.system[0].text).toBe(prompt.systemPrompt);
    expect(body.system[0].text).not.toContain('当前 Core 时间');
    // The conversation breakpoint is on the last block before the volatile reminder, with the same ttl.
    const last = body.messages.at(-1), marked = last.content.filter((block: { cache_control?: unknown }) => block.cache_control);
    expect(marked).toHaveLength(1);
    expect(marked[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(last.content.at(-1).text).toContain('<system-reminder>');
    expect(last.content.at(-1).cache_control).toBeUndefined();
  }
  // The second request carries the first one's history, still a byte-identical prefix before the reminder.
  expect(JSON.stringify(bodies[1].system)).toBe(JSON.stringify(bodies[0].system));
}, 60000);

it('does not add Anthropic cache markers to OpenAI-protocol requests', async () => {
  const { bodies } = await send('openai');
  expect(bodies).toHaveLength(2);
  expect(JSON.stringify(bodies)).not.toContain('cache_control');
}, 60000);
