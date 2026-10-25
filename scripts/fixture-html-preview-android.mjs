// Disposable Core + synthetic model/account for an owned emulator. No live data.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { startFakeIdentity } from '../server/personal-os/testing/fake-identity.ts';
import { startFakeModel } from '../server/runtime/pi/p0/fake-model.ts';

const output = path.resolve(process.argv[2] ?? 'release/html-preview/android'); mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(os.tmpdir(), 'nex-html-android-'));
const identity = await startFakeIdentity({ displayName: '演示账号' }), model = await startFakeModel();
const source = '<style>body{padding:12px}output{font:600 24px system-ui;color:#496ce8}svg{display:block}</style><label>数量 <input id="quantity" type="range" min="1" max="100" value="20"></label><output id="result"></output><svg width="250" height="60"><rect id="bar" height="40" fill="#627eeb"/></svg><script>const input=document.querySelector("input"),output=document.querySelector("output");input.oninput=()=>{output.textContent=input.value;document.querySelector("rect").setAttribute("width",Number(input.value)*2.5)};input.oninput();window.exampleState=20;</script>';
model.scripts.push({ kind: 'openai-text', text: '这是交互示例。\n\n```html-preview\n' + source + '\n```' });
const { createPersonalApp } = await import(pathToFileURL(path.resolve('dist-personal/server/core/index.js')).href);
const app = await createPersonalApp({ dir: directory, key: randomBytes(32), token: 'synthetic-bootstrap', memoryRuntime: false, hostDevice: false, uiDir: path.resolve('dist-personal/server/ui'), modelCatalog: { fetchDisabled: true, readSnapshot: () => undefined, log: () => {} }, identity: { fixtureOrigin: identity.origin } });
const bootstrap = await fetch(app.origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'synthetic-bootstrap' }) });
const cookie = bootstrap.headers.get('set-cookie').split(';', 1)[0];
const login = async (route, body) => (await fetch(app.origin + '/api/' + route, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const transaction = await login('auth/start', { account: 'owner@example.test', name: '渲染验收' });
const { token } = await login('auth/respond', { ...transaction, password: ' synthetic password ' });
const api = async (route, body) => { const response = await fetch(app.origin + '/api/' + route, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) }); if (!response.ok) throw Error('Fixture API: ' + route + ' ' + response.status); return response.json(); };
try {
  await api('config', { provider: 'openai', endpoint: model.origin + '/v1', model: 'fixture-model', apiKey: 'synthetic-only' });
  const bot = await api('bots', { name: '交互示例', instructions: '展示示例。' });
  await api('agents/input', { botId: bot.id, text: '显示交互示例。', clientId: 'html-preview-fixture' });
  const end = Date.now() + 20000;
  while (!app.store.get("SELECT id FROM agent_messages WHERE bot_id=? AND role='assistant' AND content LIKE '%html-preview%'", bot.id)) {
    if (Date.now() > end) throw Error('Fixture reply did not finish');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  writeFileSync(path.join(output, 'fixture.json'), JSON.stringify({ origin: app.origin, directory, bot: bot.id, token }));
  console.log(JSON.stringify({ origin: app.origin, output, replyPersisted: true }));
  await new Promise(resolve => {
    const timer = setInterval(() => { if (existsSync(path.join(output, 'stop'))) { clearInterval(timer); resolve(); } }, 1000);
    process.once('SIGINT', () => { clearInterval(timer); resolve(); }); process.once('SIGTERM', () => { clearInterval(timer); resolve(); });
  });
} finally {
  await app.close(); await model.close(); await identity.close();
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { console.warn('Owned fixture retained:', directory); }
}
