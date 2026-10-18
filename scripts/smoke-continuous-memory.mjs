// Isolated Core + real hidden Electron renderer; no user profile or live provider.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { WebSocket } from "ws";
import { get } from "node:http";
import { startFakeIdentity } from "../server/personal-os/testing/fake-identity.ts";
import { startFakePersonalMemory } from "../server/personal-os/testing/fake-personal-memory.ts";
import { startFakeMcp } from "../server/personal-os/testing/fake-mcp.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "nex-memory-fixture-"));
const output = path.resolve("release/personal-memory-verification"); mkdirSync(output, { recursive: true });
const { createPersonalApp } = await import(pathToFileURL(path.resolve("dist-personal/server/core/index.js")).href);
const identity = await startFakeIdentity({ displayName: "演示账号" }), model = await startFakePersonalMemory(), mcp = await startFakeMcp();
let token = "synthetic-workspace-bootstrap";
const core = await createPersonalApp({ dir: path.join(root, "core"), key: randomBytes(32), token, uiDir: path.resolve("dist-personal/server/ui"), memoryRuntime: false, hostDevice:false, identity: { fixtureOrigin: identity.origin } });
let child, ws, exited = false, logs = ""; const cases = [], exceptions = [];
async function until(check, label = "renderer state", timeout = 30_000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise((resolve) => setTimeout(resolve, 70)); } }
async function api(route, data) { const response = await fetch(core.origin + "/api/" + route, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) }); const value = await response.json(); if (!response.ok) throw new Error(value.error); return value; }
let command, evaluate;
const click = (selector) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw new Error('Control unavailable: '+${JSON.stringify(selector)});el.click();})()`);
const textButton = (text, scope = "document") => evaluate(`(()=>{const el=[...${scope}.querySelectorAll('button')].find(e=>e.getClientRects().length>0&&(e.textContent.trim()===${JSON.stringify(text)}||e.querySelector(':scope > span')?.textContent.trim()===${JSON.stringify(text)}));if(!el||el.disabled)throw new Error('Button unavailable: '+${JSON.stringify(text)});el.click();})()`);
async function screenshot(name) { await new Promise((resolve) => setTimeout(resolve, 250)); writeFileSync(path.join(output, name + ".png"), Buffer.from((await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data, "base64")); }
async function geometry() {
  const result = await evaluate(`(()=>{const main=document.querySelector('main');const c=document.querySelector('.composer');return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,mainWidth:main.getBoundingClientRect().width,composer:c?{left:c.getBoundingClientRect().left,right:c.getBoundingClientRect().right,bottom:c.getBoundingClientRect().bottom}:null,height:innerHeight};})()`);
  if (result.overflow || result.mainWidth < 300 || (result.composer && (result.composer.left < 0 || result.composer.right > result.width + 1 || result.composer.bottom > result.height + 1))) throw new Error("Layout overflow: " + JSON.stringify(result));
  return result;
}
try {
  const bootstrap = await fetch(core.origin + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
  const loginRequest = async (route, data) => { const response = await fetch(core.origin + "/api/" + route, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(data) }); if (!response.ok) throw new Error("Fixture login failed"); return response.json(); };
  const transaction = await loginRequest("auth/start", { account: "owner@example.test", name: "界面验收" });
  token = (await loginRequest("auth/respond", { ...transaction, password: " synthetic password " })).token;
  // Keep exported reference screenshots free of this machine's hostname.
  core.store.run("UPDATE devices SET name=?", "演示设备");
  await api("config", { provider: "openai", endpoint: model.origin + "/v1", model: "fixture-chat", apiKey: "synthetic-only" });
  await api("bots", { name: "工作助手", instructions: "整理信息。" });
  clearInterval(core.runtime.memory.personal.timer);
  const bot=String(core.store.get("SELECT id FROM bots")?.id);
  const profile = path.join(root, "renderer"); mkdirSync(profile, { recursive: true });
  const entry = path.join(root, "renderer.cjs");
  writeFileSync(entry, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(profile)});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,offscreen:true}});await w.webContents.session.cookies.set({url:${JSON.stringify(core.origin)},name:'nex',value:${JSON.stringify(token)},httpOnly:true,sameSite:'strict',path:'/'});await w.loadURL(${JSON.stringify(core.origin)});});app.on('window-all-closed',()=>app.quit());`);
  const stagedElectron = path.resolve("dist-personal/electron", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron.exe");
  const electron = existsSync(stagedElectron) ? stagedElectron : createRequire(import.meta.url)("electron");
  child = spawn(electron, [entry, "--remote-debugging-port=0"], { windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, TEMP: os.tmpdir(), TMP: os.tmpdir() }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => logs += data); child.stderr.on("data", (data) => logs += data); child.on("exit", () => exited = true);
  await until(() => { if (exited) throw new Error("Fixture renderer exited: " + logs); return existsSync(path.join(profile, "DevToolsActivePort")); }, "hidden renderer boot");
  const port = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
  // Electron can receive a port on fetch's browser-blocked list on Windows.
  // Read this owned debugger endpoint through Node HTTP instead.
  const targets = await new Promise((resolve, reject) => {
    const request = get(`http://127.0.0.1:${port}/json/list`, response => {
      let body = ""; response.on("data", chunk => body += chunk); response.on("error", reject);
      response.on("end", () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on("error", reject); request.setTimeout(15000, () => request.destroy(new Error("Debugger timeout")));
  });
  ws = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl); await new Promise((resolve) => ws.once("open", resolve));
  let sequence = 0; const replies = new Map();
  ws.on("message", (raw) => { const event = JSON.parse(raw); if (event.method === "Runtime.exceptionThrown") exceptions.push(event.params.exceptionDetails.text); const pending = replies.get(event.id); if (pending) { replies.delete(event.id); if (event.error) pending.reject(new Error(event.error.message)); else pending.resolve(event.result); } });
  command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { replies.delete(id); reject(new Error("CDP timeout: " + method)); }, 20_000); replies.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } }); ws.send(JSON.stringify({ id, method, params })); });
  evaluate = async (expression) => { const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  await command("Runtime.enable");
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await until(() => evaluate("!!document.querySelector('.contact-item')"), "authenticated workspace");
  await click(".workspace-account-name");
  await textButton("设置", "document.querySelector('.account-menu')");
  await textButton("长期记忆", "document.querySelector('.preferences-nav')");
  await until(()=>evaluate("!!document.querySelector('input[name=personalMemoryEnabled]:not(:disabled)')"));
  if(await evaluate("document.querySelector('input[name=personalMemoryEnabled]').checked"))throw new Error('Memory must start off');
  if(!await evaluate("document.querySelectorAll('[data-memory-dashboard] input[type=checkbox]').length===1&&!document.querySelector('[aria-label=记忆所属助手]')&&!document.querySelector('[data-memory-dashboard] select')&&!document.querySelector('[data-memory-plugin]')"))throw new Error('Memory UI must only expose one switch');
  cases.push('single-switch-and-model-without-assistant-budget-or-details');
  await click('[aria-label="选择记忆模型"]');
  await until(()=>evaluate("[...document.querySelectorAll('.model-picker-popover [role=option]')].some(el=>el.textContent==='fixture-memory')"));
  await evaluate("[...document.querySelectorAll('.model-picker-popover [role=option]')].find(el=>el.textContent==='fixture-memory').click()");
  await until(()=>core.runtime.memory.personal.globalSettings().model==='fixture-memory');
  await until(()=>evaluate("!document.querySelector('input[name=personalMemoryEnabled]').disabled"));
  await click('input[name=personalMemoryEnabled]');
  await until(()=>core.runtime.memory.personal.globalSettings().enabled===1,'global opt-in save');
  const other=core.store.createBot('另一助手');
  if(!core.runtime.memory.personal.enabled(other))throw new Error('New assistant did not inherit switch');
  core.agents.publish(bot,'user','message','这个项目先讨论完整方案，再实现。','synthetic-decision');
  core.agents.publish(other,'user','message','希望回答简洁。','synthetic-preference');
  await core.runtime.memory.personal.flush();
  await core.runtime.memory.personal.flush();
  const total=core.runtime.memory.personal.summary().totalTokens;
  if(total<=0||!core.runtime.memory.personal.rows(bot).length||!core.runtime.memory.personal.rows(other).length)throw new Error('Both assistants must retain memory: '+JSON.stringify({summary:core.runtime.memory.personal.summary(),settings:core.store.all('SELECT bot_id,enabled,last_error,cursor_seq FROM assistant_memory_settings'),calls:model.requests.length}));
  await until(()=>evaluate(`document.querySelector('[data-memory-total]')?.textContent===${JSON.stringify(total.toLocaleString())}`),'aggregate usage');
  if(model.requests.some(r=>r.model!=='fixture-memory'))throw new Error('All assistants must use the unified memory model');
  cases.push('unified-memory-model-auto-save-and-provider-routing');
  cases.push('global-opt-in-and-future-assistant','aggregate-tokens-across-assistants');
  await command('Page.reload');await until(()=>evaluate("!!document.querySelector('.workspace-account-name')"));
  await click('.workspace-account-name');await textButton('设置',"document.querySelector('.account-menu')");await textButton('长期记忆',"document.querySelector('.preferences-nav')");
  await until(()=>evaluate("document.querySelector('input[name=personalMemoryEnabled]')?.checked"));
  if(!await evaluate("document.querySelector('input[name=personalMemoryModel]')?.value==='fixture-memory'"))throw new Error('Memory model lost after reload');
  await screenshot('memory-settings-desktop');cases.push('reload-persistence');
  await click('input[name=personalMemoryEnabled]');
  await until(()=>core.runtime.memory.personal.globalSettings().enabled===0);
  for(const target of [bot,other]){
    if(core.runtime.memory.personal.recall(target,'项目').length)throw new Error('Disabled memory recalled');
    if(!core.runtime.memory.personal.rows(target).length)throw new Error('Disable deleted data');
  }
  if(core.runtime.memory.personal.summary().totalTokens!==total)throw new Error('Disable cleared usage');
  cases.push('disable-all-preserves-records-and-usage');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate("document.querySelector('[data-memory-dashboard]').scrollIntoView({block:'start'})");
  await geometry();await screenshot('memory-settings-mobile');cases.push('mobile-layout');
  if (exceptions.length) throw new Error("Renderer exception: " + exceptions.join("; "));
  const report = { passed: true, cases, modelCalls:model.requests.length, screenshots: output };
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(error, logs.slice(-5000)); if (command) { await screenshot("failure").catch(() => {}); console.error(await evaluate("document.body.innerText").catch(() => "")); } throw error; }
finally {
  ws?.close();
  if (child && !exited) { if (process.platform === "win32") { const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); await new Promise((resolve) => killer.on("close", resolve)); } else child.kill("SIGTERM"); }
  await core.close(); await model.close(); await identity.close(); await mcp.close();
  if (path.dirname(root).toLowerCase() === os.tmpdir().toLowerCase() && path.basename(root).startsWith("nex-memory-fixture-")) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { console.warn("Owned fixture retained for cleanup:", root); }
  }
}
