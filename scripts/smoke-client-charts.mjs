// Real thin shell; Core and identity are independent disposable services.
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { pathToFileURL } from "node:url";
import { startFakeIdentity } from "../server/personal-os/testing/fake-identity.ts";
import { startFakeModel } from "../server/runtime/pi/p0/fake-model.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "nex-shell-login-fixture-")), profile = path.join(root, "profile"), readyFile = path.join(root, "ready.json");
const provider = await startFakeIdentity(), catalogModel = await startFakeModel(), instances = [], cases = [], key = randomBytes(32);
const accountWorkspaces = false; const uiDir = path.resolve(process.argv.find(arg => arg.startsWith("--ui-dir="))?.slice(9) ?? "dist-personal/server/ui");
const bundle = await import(pathToFileURL(path.resolve(`dist-personal/server/core/${accountWorkspaces ? "workspaces" : "index"}.js`)).href);
const createPersonalApp = accountWorkspaces ? bundle.createWorkspaceService : bundle.createPersonalApp;
let core = await createPersonalApp({ dir: path.join(root, "core"), key, token: "synthetic-bootstrap", uiDir, memoryRuntime: false, hostDevice: false, identity: { fixtureOrigin: provider.origin } });
const operator = core.store.get("SELECT * FROM user_sessions WHERE id=?", core.store.session);
const transaction = core.identity.start({ account: "owner@example.test", name: "Service initialization" }, operator);
const initial = await core.identity.respond({ ...transaction, password: " synthetic password " }, operator); await core.identity.logout(initial.token);
const executable = process.argv.find((arg) => arg.startsWith("--exe="))?.slice(6);
async function until(check, timeout = 30_000) { const end = Date.now() + timeout; const ready = async () => { try { return await check(); } catch (error) { if (/Inspected target navigated|Execution context was destroyed|Cannot find context/.test(error.message)) return false; throw error; } }; while (!await ready()) { if (Date.now() > end) throw new Error("Shell login fixture timed out"); await new Promise((resolve) => setTimeout(resolve, 80)); } }
async function launch() {
  for (const file of [readyFile, path.join(profile, "DevToolsActivePort")]) if (existsSync(file)) rmSync(file);
  const child = spawn(executable ?? path.resolve("dist-personal/electron", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron.exe"), [...(executable ? [] : [path.resolve("electron/nex-client-main.mjs")]), `--profile=${profile}`, "--remote-debugging-port=0"], {
    windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, NEX_CLIENT_SMOKE_OUTPUT: readyFile }, stdio: ["ignore", "pipe", "pipe"]
  });
  const instance = { child, exited: false, ws: undefined, sequence: 0, replies: new Map(), logs: "" }; instances.push(instance);
  child.once("close", () => { instance.exited = true; });
  child.stdout.on("data", (raw) => { instance.logs = (instance.logs + raw).slice(-4000); }); child.stderr.on("data", (raw) => { instance.logs = (instance.logs + raw).slice(-4000); });
  await until(() => { if (instance.exited) throw new Error(instance.logs); return existsSync(readyFile) && existsSync(path.join(profile, "DevToolsActivePort")); }, 120_000);
  const port = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === "page");
  instance.ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve) => instance.ws.once("open", resolve));
  instance.webLoginFrames = 0;
  instance.ws.on("message", (raw) => { const event = JSON.parse(raw.toString()); if (event.method === "Runtime.bindingCalled" && event.params.name === "fixtureWebLoginShown") instance.webLoginFrames++; const pending = instance.replies.get(event.id); if (!pending) return; instance.replies.delete(event.id); if (event.error) pending.reject(new Error(event.error.message)); else pending.resolve(event.result); });
  instance.command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++instance.sequence; const timer = setTimeout(() => { instance.replies.delete(id); reject(new Error("Shell command timed out")); }, 30_000); instance.replies.set(id, { resolve: (result) => { clearTimeout(timer); resolve(result); }, reject: (error) => { clearTimeout(timer); reject(error); } }); instance.ws.send(JSON.stringify({ id, method, params })); });
  instance.evaluate = async (expression) => { const result = await instance.command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  await instance.command("Runtime.addBinding", { name: "fixtureWebLoginShown" });
  await instance.command("Page.addScriptToEvaluateOnNewDocument", { source: "new MutationObserver(()=>{if(document.querySelector('.login-form:not(#connection)'))window.fixtureWebLoginShown('shown')}).observe(document,{childList:true,subtree:true});" });
  instance.quit = async () => { await instance.evaluate("void window.nex.quit();true"); await until(() => instance.exited); instance.ws.close(); };
  return instance;
}
async function login(instance, password, account = "owner@example.test") {
  await instance.evaluate(`document.querySelector('#name').value='示例电脑';document.querySelector('#origin').value=${JSON.stringify(core.origin)};document.querySelector('#email').value=${JSON.stringify(account)};document.querySelector('#password').value=${JSON.stringify(password)};document.querySelector('#connection').requestSubmit();true`);
}
const output = path.resolve(process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? 'release/client-chart-verification');
mkdirSync(output, { recursive: true });
const expectOld = process.argv.includes('--expect-old');
const samples = [
  { type: 'bar', title: '2024各部门季度销售业绩（示例数据）', labels: ['第一季度', '第二季度', '第三季度', '第四季度'], series: [{ name: '华东区', values: [120, 150, 180, 210] }, { name: '华北区', values: [90, 110, 130, 160] }], xLabel: '季度', yLabel: '销售额', unit: '万元' },
  { type: 'line', title: '上半年网站月度活跃访问量（示例数据）', labels: ['1月', '2月', '3月', '4月', '5月', '6月'], series: [{ name: '独立访客(UV)', values: [32, 28, 45, 52, 68, 85] }], xLabel: '月份', yLabel: '访问人次', unit: '万人' },
  { type: 'histogram', title: '响应时长（示例数据）', values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], bins: 5 },
  { type: 'pie', title: '渠道占比（示例数据）', labels: ['自然访问', '社交媒体', '推广'], values: [50, 30, 20] },
];
const reply = samples.map(sample => '```chart\n' + JSON.stringify(sample, null, 2) + '\n```').join('\n\n') + '\n\n```json\n{"literal":true}\n```\n\n```html\n<b>这行显示源码</b>\n```';
async function screenshot(instance, name) {
  writeFileSync(path.join(output, name + '.png'), Buffer.from((await instance.command('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
}
try {
  if (!executable) throw new Error('Pass --exe with the actual packaged application');
  const first = await launch();
  await until(() => first.evaluate("!!document.querySelector('#connection')"));
  await login(first, ' synthetic password ');
  await until(() => first.evaluate("!!document.querySelector('.workspace-brand')"));
  const localUI = await first.evaluate("document.querySelector('meta[name=nexbot-ui-source]')?.content==='local'");
  if (localUI !== expectOld) throw new Error('Unexpected UI origin: local=' + localUI);
  cases.push(expectOld ? 'old-exe-shadows-server-ui' : 'packaged-exe-loads-server-ui');
  const api = (route, body) => first.evaluate(`fetch('/api/'+${JSON.stringify(route)},{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r=>{if(!r.ok)throw new Error('Fixture API '+r.status);return r.json()})`);
  await api('config', { provider: 'openai', endpoint: catalogModel.origin + '/v1', model: 'fixture-model', apiKey: 'synthetic-only' });
  await api('bots', { name: '图表验收助手', instructions: '返回示例图表。' });
  await until(() => first.evaluate("!!document.querySelector('.contact-item')"));
  await first.evaluate("document.querySelector('.contact-item').click()");
  await until(() => first.evaluate("!!document.querySelector('textarea[aria-label=\"发送给 Agent 的消息\"]')"));
  catalogModel.scripts.push({ kind: 'openai-text', text: reply });
  await first.evaluate("(()=>{const el=document.querySelector('textarea[aria-label=\"发送给 Agent 的消息\"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'用示例数据分别展示柱状图、直方图、折线图和饼图');el.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await first.evaluate("document.querySelector('[aria-label=\"发送消息\"]').click()");
  if (expectOld) {
    await until(() => first.evaluate("document.querySelectorAll('code.language-chart').length===4"));
    if (await first.evaluate("document.querySelectorAll('.nex-chart').length")) throw new Error('Old package unexpectedly renders charts');
    await first.evaluate("document.querySelector('code.language-chart').scrollIntoView({block:'center'})");
    await screenshot(first, 'old-exe-reproduction');
    cases.push('screenshot-reproduced-four-charts-as-code');
  } else {
    await until(() => first.evaluate("document.querySelectorAll('.nex-chart[data-chart-type]').length===4"));
    if (await first.evaluate("document.querySelectorAll('code.language-chart').length")) throw new Error('Chart data still shown as code');
    if (!await first.evaluate("document.querySelector('code.language-json')?.textContent.includes('literal')&&document.querySelector('code.language-html')?.textContent.includes('<b>')")) throw new Error('Ordinary code lost literal rendering');
    for (const type of ['bar', 'line', 'histogram', 'pie']) {
      await first.evaluate(`(()=>{const chart=document.querySelector('.nex-chart[data-chart-type=${type}]');chart.scrollIntoView({block:'center'});chart.querySelector('[data-label]').dispatchEvent(new MouseEvent('click',{bubbles:true}));chart.querySelector('summary').click();})()`);
      if (!await first.evaluate(`document.querySelector('.nex-chart[data-chart-type=${type}] .nex-chart-tooltip').textContent.includes('：')&&document.querySelector('.nex-chart[data-chart-type=${type}] details').open`)) throw new Error('Chart interaction failed: ' + type);
      await screenshot(first, type);
      cases.push(type + '-render-values-and-data-table');
    }
    const count = await first.evaluate("[...document.querySelectorAll('.nex-chart[data-chart-type=histogram] tbody td')].reduce((n,td)=>n+Number(td.textContent),0)");
    if (count !== 11) throw new Error('Histogram total mismatch');
    const html = await first.evaluate("fetch('/').then(r=>r.text())");
    if (html !== readFileSync(path.join(uiDir, 'index.html'), 'utf8')) throw new Error('Packaged client does not serve the fixture server HTML unchanged');
    await first.command('Page.reload', { ignoreCache: true });
    await until(() => first.evaluate("document.querySelectorAll('.nex-chart[data-chart-type]').length===4"));
    cases.push('history-reload-renders-four-charts', 'server-html-byte-parity', 'ordinary-code-remains-literal');
    await first.quit();
    const second = await launch();
    await until(() => second.evaluate("document.querySelectorAll('.nex-chart[data-chart-type]').length===4"));
    if (await second.evaluate("!!document.querySelector('meta[name=nexbot-ui-source]')")) throw new Error('Restart switched to local UI');
    cases.push('exe-restart-restores-session-and-chart-history');
    await second.quit();
  }
  const report = { passed: true, expectOld, packaged: true, cases };
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await screenshot(instances.at(-1), 'failure').catch(() => {});
  console.error(await instances.at(-1)?.evaluate('document.body.innerText').catch(() => ''), instances.at(-1)?.logs);
  throw error;
} finally {
  for (const instance of instances) {
    if (!instance.exited) await instance.quit?.().catch(() => {});
    instance.ws?.close();
    if (!instance.exited) { instance.child.kill('SIGTERM'); await until(() => instance.exited).catch(() => instance.child.kill('SIGKILL')); }
  }
  await core.close(); await provider.close(); await catalogModel.close();
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { console.warn('Owned fixture retained for cleanup:', root); }
}
