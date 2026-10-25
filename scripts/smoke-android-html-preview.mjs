import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { connectAndroidWorkspace } from './testing/android-workspace-cdp.mjs';

const output = path.resolve(process.argv[2] ?? 'release/html-preview/android');
const fixture = JSON.parse(readFileSync(path.join(output, 'fixture.json'), 'utf8'));
const client = await connectAndroidWorkspace(Number(process.argv[3] ?? 9229));
const cases = [];
const wait = async check => { const end = Date.now() + 15000; while (!await check()) { if (Date.now() > end) throw Error('Android preview timed out'); await new Promise(r => setTimeout(r, 100)); } };
const contexts = new Map();
async function contentFrame() {
  const tree = (await client.command('Page.getFrameTree')).frameTree;
  const find = tree => tree.frame.url.startsWith('data:text/html;base64,') ? tree.frame.id : tree.childFrames?.map(find).find(Boolean);
  return find(tree);
}
async function child(expression) {
  const id = await contentFrame(); assert.ok(id, 'content frame');
  let contextId = contexts.get(id);
  if (!contextId) { contextId = (await client.command('Page.createIsolatedWorld', { frameId: id, worldName: 'html-preview-verification' })).executionContextId; contexts.set(id, contextId); }
  const result = await client.command('Runtime.evaluate', { expression, contextId, returnByValue: true, userGesture: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
  return result.result.value;
}
const button = text => client.evaluate(`[...document.querySelectorAll('.html-preview-toolbar button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
const ready = () => wait(() => client.evaluate('document.querySelector(".html-preview-status")?.textContent===""'));
const adb = process.argv.find(arg => arg.startsWith('--adb='))?.slice(6) ?? 'adb';
const serial = process.argv.find(arg => arg.startsWith('--serial='))?.slice(9);
const screenshot = async name => {
  if (!serial || !/^emulator-\d+$/.test(serial)) return;
  writeFileSync(path.join(output, name + '.png'), execFileSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { windowsHide: true, timeout: 10000, maxBuffer: 20 * 1024 * 1024 }));
};
try {
  const status = await client.evaluate('fetch("/api/auth/status").then(r=>r.json())');
  assert.equal(status.account.displayName, '演示账号');
  const server = await (await fetch(fixture.origin + '/health')).json(); assert.equal(server.app, 'NexBot');
  cases.push('native-main-frame-port-authenticated-request');
  await button('重新运行');
  await ready(); assert.equal(await child('document.querySelector("output").textContent'), '20'); cases.push('persisted-model-reply-renders');
  await client.evaluate(`document.querySelector('[aria-label="关闭联系人列表"]')?.click()`);
  await child('document.querySelector("input").value="80";document.querySelector("input").dispatchEvent(new Event("input",{bubbles:true}));true');
  assert.equal(await child('document.querySelector("output").textContent'), '80');
  assert.equal(await child('document.querySelector("rect").getAttribute("width")'), '200'); cases.push('range-input-updates-dom-and-svg');
  await screenshot('inline');
  await client.evaluate('window.fixturePreviewFrame=document.querySelector(".html-preview>iframe");true');
  await button('全屏');
  await wait(() => client.evaluate('!!document.querySelector(".html-preview-fullscreen")'));
  assert.equal(await client.evaluate('window.fixturePreviewFrame===document.querySelector(".html-preview>iframe")'), true);
  assert.equal(await child('document.querySelector("output").textContent'), '80');
  assert.equal(await client.evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  await screenshot('fullscreen'); cases.push('fullscreen-preserves-state-and-fits-screen');
  await client.evaluate('dispatchEvent(new Event("nex-android-back"))');
  await wait(() => client.evaluate('!document.querySelector(".html-preview-fullscreen")'));
  assert.equal(await child('document.querySelector("output").textContent'), '80'); cases.push('android-back-exits-preview');
  const probe = `(()=>{let dom=false,storage=false;try{parent.document.body}catch{dom=true}try{localStorage.setItem('probe','1')}catch{storage=true}document.body.dataset.probe=JSON.stringify({dom,storage,bridge:typeof window.nex,native:typeof window.NexAndroid,rtc:typeof window.RTCPeerConnection})})()`;
  await child(`(()=>{const script=document.createElement('script');script.textContent=${JSON.stringify(probe)};document.body.append(script)})()`);
  assert.deepEqual(JSON.parse(await child('document.body.dataset.probe')), { dom: true, storage: true, bridge: 'undefined', native: 'undefined', rtc: 'undefined' }); cases.push('content-has-no-native-bridge-storage-or-parent-access');
  await button('重新运行'); await ready(); await wait(async () => (await child('document.querySelector("output")?.textContent')) === '20'); cases.push('rerun-resets-state');
  await child(`(()=>{const script=document.createElement('script');script.textContent="throw Error('fixture')";document.body.append(script)})()`);
  await wait(() => client.evaluate('document.querySelector(".html-preview-status")?.textContent==="运行出错"')); cases.push('runtime-error-visible');
  await button('停止'); await wait(async () => !await contentFrame()); cases.push('stop-removes-content-frame');
  await client.command('Page.reload'); contexts.clear();
  await ready(); await wait(async () => (await child('document.querySelector("output")?.textContent')) === '20');
  assert.equal(await client.evaluate('fetch("/api/auth/status").then(r=>r.json()).then(s=>s.account.displayName)'), '演示账号'); cases.push('reload-restores-bridge-and-history');
  const report = { passed: true, cases }; writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { client.close(); }
