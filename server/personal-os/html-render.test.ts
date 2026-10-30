import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createPersonalApp } from './index.ts';
import { evaluateTool } from './policy.ts';
import { htmlPreviewParts, HTML_PREVIEW_LIMIT } from '../../shared/html-preview.ts';
import { htmlRenderMessage } from '../../shared/html-render.ts';
import { startFakeModel } from '../runtime/pi/p0/fake-model.ts';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nex-html-render-'));
  cleanup.push(async () => {
    if (path.dirname(dir).toLowerCase() !== os.tmpdir().toLowerCase() || !path.basename(dir).startsWith('nex-html-render-')) throw new Error('Unsafe cleanup');
    rmSync(dir, { recursive: true, force: true });
  });
  const model = await startFakeModel(); cleanup.push(() => model.close());
  const app = await createPersonalApp({ dir, key: randomBytes(32), token: 'synthetic-html-owner', identity: false, memoryRuntime: false, hostDevice: false, modelCatalog: { fetchDisabled: true, readSnapshot: () => undefined, log: () => {} } });
  cleanup.push(() => app.close());
  app.store.saveConfig({ provider: 'openai', endpoint: model.origin + '/v1', model: 'fixture', apiKey: 'synthetic-html-key' });
  const bot = app.store.createBot('HTML fixture');
  return { app, bot, model };
}
async function until(check: () => boolean) {
  const end = Date.now() + 25000;
  while (!check()) { if (Date.now() > end) throw new Error('HTML fixture timed out'); await new Promise(resolve => setTimeout(resolve, 25)); }
}

it('publishes one scoped funnel preview through the actual model/Broker/feed path', async () => {
  const { app, bot, model } = await fixture();
  const peer = app.store.createBot('Other fixture');
  // Existing explicitly restricted policies still receive this basic display capability.
  app.store.run('UPDATE bot_policies SET policy_json=? WHERE bot_id=?', JSON.stringify({ tools: [] }), bot);
  const content = '<!doctype html><meta charset="utf-8"><h2>转化漏斗（示例数据）</h2><svg viewBox="0 0 400 220" role="img" aria-label="从访问到付费逐层变窄"><polygon points="0,0 400,0 330,90 70,90" fill="#3282bf"/><polygon points="70,100 330,100 260,190 140,190" fill="#2ba5a0"/></svg>';
  model.scripts.push({ kind: 'openai-tool', calls: [{ id: 'discover-html', name: 'broker', args: JSON.stringify({ action: 'tool.search', query: 'html.render' }) }] }, { kind: 'openai-tool', calls: [{ id: 'funnel', name: 'broker', args: JSON.stringify({ action: 'html.render', content, botId: peer }) }] }, { kind: 'openai-text', text: '已提供示例漏斗。' });
  const sent = app.agents.send(bot, '画一个从上到下的漏斗，使用示例数据', 'html-funnel');
  await until(() => app.store.get('SELECT ended_at FROM tasks WHERE id=?', sent.taskId)?.ended_at != null);
  expect(app.store.get('SELECT status FROM tasks WHERE id=?', sent.taskId)?.status).toBe('succeeded');
  const calls = app.store.all("SELECT * FROM tool_calls WHERE tool_name='html.render'");
  expect(calls).toHaveLength(1);
  expect(calls[0].status).toBe('succeeded');
  const result = JSON.parse(String(calls[0].result_json));
  expect(result).toMatchObject({ status: 'published' });
  expect(String(calls[0].result_json)).not.toContain('<svg');
  const messages = app.store.all("SELECT * FROM agent_messages WHERE source_key LIKE 'html:%'");
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ id: result.messageId, bot_id: bot, role: 'assistant' });
  expect(htmlPreviewParts(String(messages[0].content))).toEqual([{ kind: 'preview', source: content, complete: true }]);
  expect(app.store.all('SELECT id FROM approvals')).toHaveLength(0);
  expect(app.store.all('SELECT id FROM agent_messages WHERE bot_id=?', peer)).toHaveLength(0);
  expect(model.requests[0].body).not.toContain('no network requests');
  const request = JSON.stringify(model.requests[1].body);
  expect(request).toContain('html.render(content)');
  expect(request).toContain('no network requests');
  expect(request).not.toContain('不要输出绘图库脚本、HTML/SVG');
}, 60000);

it('validates source limits and active Agent scope without granting other tools', async () => {
  const { app, bot } = await fixture();
  app.store.run('UPDATE bot_policies SET policy_json=? WHERE bot_id=?', JSON.stringify({ tools: [] }), bot);
  expect(evaluateTool(app.store, bot, { action: 'html.render', content: '<p>你好</p>' }).approvalRequired).toBe(false);
  for (const content of [null, 12, '', '  ', 'x'.repeat(HTML_PREVIEW_LIMIT + 1)]) {
    expect(() => evaluateTool(app.store, bot, { action: 'html.render', content })).toThrow('HTML');
  }
  expect(() => evaluateTool(app.store, bot, { action: 'device.exec', command: 'pwd' })).toThrow('无权');
  expect(() => evaluateTool(app.store, 'unknown', { action: 'html.render', content: '<p>x</p>' })).toThrow('无权');
  app.store.run("UPDATE bots SET status='archived' WHERE id=?", bot);
  expect(() => evaluateTool(app.store, bot, { action: 'html.render', content: '<p>x</p>' })).toThrow('无权');
});

it('keeps Markdown fences in generated HTML inside a single preview', () => {
  const content = '<pre>\n```\n# not a chat message\n````\n</pre>\n<script>const x = `value`;</script>';
  expect(htmlPreviewParts(htmlRenderMessage(content))).toEqual([{ kind: 'preview', source: content, complete: true }]);
  expect(htmlPreviewParts(htmlRenderMessage('x'.repeat(HTML_PREVIEW_LIMIT)))[0]).toMatchObject({ complete: true });
});
