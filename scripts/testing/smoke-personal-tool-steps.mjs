// Disposable real Core + synthetic identity/model + isolated Chromium renderer.
// Run from the worktree: node scripts/testing/smoke-personal-tool-steps.mjs
// Verifies chat tool steps expand in place with readable content instead of the side JSON panel.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync, cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { WebSocket } from "ws";
import { build as bundle } from "esbuild";
import { pathToFileURL } from "node:url";
import { startFakeIdentity } from "../../server/personal-os/testing/fake-identity.ts";
import { startFakeModel } from "../../server/runtime/pi/p0/fake-model.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "nex-tool-steps-browser-"));
const evidence = mkdtempSync(path.join(os.tmpdir(), "nex-tool-steps-evidence-"));
let core, identity, model, child, ws, exited = false, logs = "", sequence = 0;
const cases = [], exceptions = [], pending = new Map();
const tokenSeed = "synthetic-tool-steps-bootstrap";
let token = tokenSeed;
async function until(check, label = "renderer state", timeout = 30000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 70)); }
}
async function api(route, data) {
  const response = await fetch(core.origin + "/api/" + route, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
}
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout: " + method)); }, 20000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } }); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value;
}
const click = selector => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw new Error('Unavailable control');el.click()})()`);
async function screenshot(name) {
  await evaluate("Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))");
  writeFileSync(path.join(evidence, name + ".png"), Buffer.from((await command("Page.captureScreenshot", { format: "png" })).data, "base64"));
}
try {
  const uiDir = path.join(root, "ui");
  await build({ configFile: false, root: process.cwd(), plugins: [react()], build: { outDir: uiDir, emptyOutDir: true, rollupOptions: { input: path.resolve("personal.html") } } });
  cpSync(path.join(uiDir, "personal.html"), path.join(uiDir, "index.html"));
  const coreDir = path.join(root, "core-build");
  await bundle({ entryPoints: ["server/personal-os/index.ts", "server/personal-os/worker.ts"], outdir: coreDir, bundle: true, platform: "node", target: "node22", format: "esm", define: { PI_BUNDLED_NODE: "true" }, external: ["pdfjs-dist/legacy/build/pdf.mjs"], banner: { js: `import {createRequire as nexCreateRequire} from 'node:module'; const require=nexCreateRequire(${JSON.stringify(path.resolve("package.json"))});` } });
  writeFileSync(path.join(coreDir, "package.json"), JSON.stringify({ type: "module" }));
  for (const file of readdirSync("server/personal-os").filter(file => file.endsWith(".sql"))) cpSync(path.join("server/personal-os", file), path.join(coreDir, file));
  cpSync("server/personal-os/skills", path.join(coreDir, "skills"), { recursive: true });
  const { createPersonalApp } = await import(pathToFileURL(path.join(coreDir, "index.js")).href);
  identity = await startFakeIdentity({ displayName: "工具步骤验收" }); model = await startFakeModel();
  core = await createPersonalApp({ dir: path.join(root, "core"), key: randomBytes(32), token, uiDir, hostDevice: false, memoryRuntime: false, modelCatalog: { fetchDisabled: true, readSnapshot: () => undefined, log: () => {} }, identity: { fixtureOrigin: identity.origin } });
  const bootstrap = await fetch(core.origin + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
  const login = async (route, data) => { const response = await fetch(core.origin + "/api/" + route, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(data) }); if (!response.ok) throw new Error("Fixture login failed"); return response.json(); };
  const transaction = await login("auth/start", { account: "owner@example.test", name: "浏览器验收" });
  token = (await login("auth/respond", { ...transaction, password: " synthetic password " })).token;
  await api("config", { provider: "openai", endpoint: model.origin + "/v1", model: "fixture-model", apiKey: "synthetic-only" });
  await api("bots", { name: "验收助手", instructions: "仅处理隔离验收数据。" });
  const profile = path.join(root, "renderer"); mkdirSync(profile);
  const entry = path.join(root, "renderer.cjs");
  writeFileSync(entry, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(profile)});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,offscreen:true}});await w.webContents.session.cookies.set({url:${JSON.stringify(core.origin)},name:'nex',value:${JSON.stringify(token)},httpOnly:true,sameSite:'strict',path:'/'});await w.loadURL(${JSON.stringify(core.origin)});});app.on('window-all-closed',()=>app.quit());`);
  child = spawn(createRequire(import.meta.url)("electron"), [entry, "--remote-debugging-port=0"], { windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, TEMP: os.tmpdir(), TMP: os.tmpdir() }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", data => logs += data); child.stderr.on("data", data => logs += data); child.on("exit", () => exited = true);
  await until(() => { if (exited) throw new Error(logs); return existsSync(path.join(profile, "DevToolsActivePort")); }, "renderer boot");
  const port = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl); await new Promise(resolve => ws.once("open", resolve));
  ws.on("message", raw => { const event = JSON.parse(raw); if (event.method === "Runtime.exceptionThrown") exceptions.push(event.params.exceptionDetails.text); const request = pending.get(event.id); if (request) { pending.delete(event.id); if (event.error) request.reject(new Error(event.error.message)); else request.resolve(event.result); } });
  await command("Runtime.enable"); await command("Page.enable");
  await until(() => evaluate("!!document.querySelector('.composer textarea')"), "authenticated composer");
  const memoryText = "报告用中文写，先给结论再给依据。";
  model.scripts.push({ kind: "openai-tool", calls: [{ id: "memory-fixture", name: "broker", args: JSON.stringify({ action: "memory.write", title: "写作偏好", content: memoryText }) }] }, { kind: "openai-text", text: "已经写入长期记忆。" });
  await evaluate(`(()=>{const el=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'把这条写作偏好记到长期记忆里：${memoryText}');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(() => evaluate("!document.querySelector('.send').disabled"));
  await click(".send");
  await until(async () => { if (await evaluate("!!document.querySelector('.approval')")) await click(".approval .actions button"); return evaluate("document.querySelector('.transcript').textContent.includes('已经写入长期记忆。')"); }, "tool reply committed", 60000);
  await evaluate("[...document.querySelectorAll('.transcript details')].forEach(el=>el.open=true)");
  await until(() => evaluate("!!document.querySelector('.transcript .step-row')"), "tool activity row");
  await click(".transcript .step-row");
  await until(() => evaluate("!!document.querySelector('.transcript .step-detail')"), "step detail expands in place");
  const detail = await evaluate("document.querySelector('.transcript .step-detail').textContent");
  assert.match(detail, /写入内容/);
  assert.match(detail, new RegExp(memoryText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(detail, /"saved"/);
  assert.equal(await evaluate("!!document.querySelector('.preview-card')"), false, "no JSON preview card");
  await screenshot("tool-step-inline-desktop");
  await click(".transcript .step-row");
  await until(() => evaluate("!document.querySelector('.transcript .step-detail')"), "step detail collapses");
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await click("[aria-label='收起助手详情']");
  await until(() => evaluate("document.querySelector('.app').dataset.right === 'closed'"), "inspector drawer closed");
  await click(".transcript .step-row");
  await until(() => evaluate("!!document.querySelector('.transcript .step-detail')"), "step detail expands on mobile");
  assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
  await screenshot("tool-step-inline-mobile");
  cases.push("chat-memory-step-expands-inline-text", "chat-step-collapse-and-mobile-bounds");
  assert.deepEqual(exceptions, []);
  writeFileSync(path.join(evidence, "result.json"), JSON.stringify({ ok: true, cases, exceptions, coreOrigin: core.origin }, null, 2));
  console.log(JSON.stringify({ ok: true, cases, evidence }, null, 2));
} catch (error) {
  writeFileSync(path.join(evidence, "failure.txt"), String(error.stack || error) + "\n" + logs);
  console.error("Evidence:", evidence); throw error;
} finally {
  ws?.close(); if (child && !exited) { child.kill(); await until(() => exited, "renderer shutdown", 5000).catch(() => {}); }
  await core?.close(); await model?.close(); await identity?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}
