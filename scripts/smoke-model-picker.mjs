// Isolated Core + real hidden Electron renderer; no user profile or live provider.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { WebSocket } from "ws";
import { get, createServer } from "node:http";
import { startFakeIdentity } from "../server/personal-os/testing/fake-identity.ts";
import { startFakeMcp } from "../server/personal-os/testing/fake-mcp.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "nex-picker-fixture-"));
const output = path.resolve("release/model-picker-verification"); mkdirSync(output, { recursive: true });
const { createPersonalApp } = await import(pathToFileURL(path.resolve("dist-personal/server/core/index.js")).href);
let catalogCalls=0;
const catalog=Array.from({length:1505},(_,i)=>({id:`demo-model-${String(i).padStart(4,'0')}`}));
const provider=createServer((req,res)=>{catalogCalls++;const after=new URL(req.url,'http://fixture').searchParams.get('after_id');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(after?{data:catalog.slice(1000),has_more:false}:{data:catalog.slice(0,1000),has_more:true,last_id:'demo-model-0999'}));});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const model={origin:`http://127.0.0.1:${provider.address().port}`,async close(){provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));}};
const identity = await startFakeIdentity({ displayName: "演示账号" }), mcp = await startFakeMcp();
let token = "synthetic-workspace-bootstrap";
const core = await createPersonalApp({ dir: path.join(root, "core"), key: randomBytes(32), token, uiDir: path.resolve("dist-personal/server/ui"), memoryRuntime: false, hostDevice:false, modelCatalog:{fetchDisabled:true}, identity: { fixtureOrigin: identity.origin } });
let child, ws, exited = false, logs = ""; const cases = [], exceptions = [];
async function until(check, label = "renderer state", timeout = 30_000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise((resolve) => setTimeout(resolve, 70)); } }
async function api(route, data) { const response = await fetch(core.origin + "/api/" + route, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) }); const value = await response.json(); if (!response.ok) throw new Error(value.error); return value; }
let command, evaluate;
const click = (selector) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw new Error('Control unavailable: '+${JSON.stringify(selector)});el.click();})()`);
const textButton = (text, scope = "document") => evaluate(`(()=>{const el=[...${scope}.querySelectorAll('button')].find(e=>e.getClientRects().length>0&&(e.textContent.trim()===${JSON.stringify(text)}||e.querySelector(':scope > span')?.textContent.trim()===${JSON.stringify(text)}));if(!el||el.disabled)throw new Error('Button unavailable: '+${JSON.stringify(text)});el.click();})()`);
async function input(selector, value) { await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
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
  await api("config", { provider: "openai", endpoint: model.origin + "/v1", model: "demo-model-0000", apiKey: "synthetic-only" });
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
  await textButton("模型", "document.querySelector('.preferences-nav')");
  const settings="document.querySelector('[data-model-visibility]')";
  await click('[aria-label="默认模型"]');
  await until(()=>evaluate("document.querySelector('.model-picker-popover .model-list-count')?.textContent.includes('1505 个')"),'full picker catalog');
  const loadedCalls=catalogCalls;
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',modifiers:2,windowsVirtualKeyCode:35});
  await until(()=>evaluate("!!document.querySelector('.model-picker-popover [role=option][data-active=true]')?.textContent.includes('1504')"),'keyboard scroll to last model');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await click('[aria-label="默认模型"]');
  await until(()=>evaluate("document.querySelector('.model-picker-popover')?.matches(':popover-open')"));
  if(catalogCalls!==loadedCalls)throw new Error('Reopening refetched unchanged catalog');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  cases.push('full-picker-virtual-keyboard-navigation-and-cache');

  await until(()=>evaluate("document.querySelector('[data-model-visibility] .model-list-count')?.textContent.includes('1505')"),'full paginated directory');
  if(await evaluate("document.querySelectorAll('[data-model-visibility] [role=option]').length")>20)throw new Error('Directory is not virtualized');
  await evaluate("document.querySelector('[data-model-visibility] .model-list-viewport').scrollTop=66000");
  await until(()=>evaluate("!![...document.querySelectorAll('[data-model-visibility] [role=option]')].find(el=>el.textContent.includes('1504'))"),'last page scroll');
  await input('[data-model-visibility] input[aria-label="搜索模型"]','1504');
  await until(()=>evaluate("document.querySelector('[data-model-visibility] [role=option]')?.textContent.includes('1504')"));
  cases.push('1505-models-with-pagination','bounded-rendered-rows','last-model-scroll-and-search');
  await textButton('清空选择',settings);
  await click('[data-model-visibility] [role=option]');
  await input('[data-model-visibility] input[aria-label="添加模型 ID"]','custom-private-model');await textButton('添加',settings);
  await textButton('保存显示模型',settings);
  await until(()=>core.store.modelVisibility().models?.length===2,'shortlist saved');
  await input('[data-model-visibility] input[aria-label="搜索模型"]','');
  await textButton('只看已选',settings);
  await evaluate("document.querySelector('[data-model-visibility]').scrollIntoView({block:'center'})");
  await screenshot('visible-model-settings');
  await command('Page.reload');await until(()=>evaluate("!!document.querySelector('.workspace-account-name')"));
  await click('.workspace-account-name');await textButton('设置',"document.querySelector('.account-menu')");await textButton('模型',"document.querySelector('.preferences-nav')");
  await until(()=>evaluate("document.querySelector('[data-model-visibility] .preferences-status')?.textContent==='已选 2 个'"));
  cases.push('shortlist-custom-id-save-reload');
  await click('[aria-label="默认模型"]');
  await until(()=>evaluate("document.querySelector('.model-picker-popover')?.matches(':popover-open')"));
  if(!await evaluate("document.querySelector('.model-picker-popover .model-list-count').textContent.includes('3 个')"))throw new Error('Default picker did not apply shortlist and retain current');
  await input('.model-picker-popover input[aria-label="搜索模型"]','1504');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await until(()=>evaluate("document.querySelector('input[name=model]')?.value==='demo-model-1504'"));
  cases.push('default-picker-shortlist-current-and-keyboard');
  await textButton('长期记忆',"document.querySelector('.preferences-nav')");
  await until(()=>evaluate("!!document.querySelector('[aria-label=选择记忆模型]')"));
  const requestsBefore=catalogCalls;
  await click('[aria-label="选择记忆模型"]');
  await until(()=>evaluate("document.querySelector('.model-picker-popover')?.matches(':popover-open')"));
  if(!await evaluate("document.querySelector('.model-picker-popover .model-list-count').textContent.includes('3 个')"))throw new Error('Memory picker did not apply shortlist');
  await screenshot('memory-model-picker');
  await input('.model-picker-popover input[aria-label="搜索模型"]','1504');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await until(()=>evaluate("document.querySelector('input[name=personalMemoryModel]')?.value==='demo-model-1504'"));
  if(catalogCalls!==requestsBefore)throw new Error('Shortlist unnecessarily fetched catalog');
  cases.push('shared-memory-picker-no-fetch');
  await click('.contact-item');
  await until(()=>evaluate("!!document.querySelector('[aria-label=选择聊天模型]')"));
  await click('[aria-label="选择聊天模型"]');
  await until(()=>evaluate("document.querySelector('.model-picker-popover')?.matches(':popover-open')"));
  await screenshot('chat-model-picker');
  await input('.model-picker-popover input[aria-label="搜索模型"]','1504');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await until(()=>core.store.botModelSelection(bot)?.selected_model==='demo-model-1504','chat model selection');
  await until(()=>evaluate("!document.querySelector('[aria-label=选择聊天模型]').disabled"));
  await click('[aria-label="选择聊天模型"]');
  await until(()=>evaluate("document.querySelector('.model-picker-popover')?.matches(':popover-open')"));
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await until(()=>evaluate("document.activeElement?.getAttribute('aria-label')==='选择聊天模型'&&!document.querySelector('.model-picker-popover')"));
  cases.push('chat-switch-and-escape-focus');
  await click('[aria-label=收起助手详情]');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await click('[aria-label="选择聊天模型"]');
  await until(()=>evaluate("document.querySelector('.model-picker-popover')?.matches(':popover-open')"));
  const bounds=await evaluate("(()=>{const r=document.querySelector('.model-picker-popover').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};})()");
  if(bounds.left<0||bounds.right>bounds.width||bounds.top<0||bounds.bottom>bounds.height)throw new Error('Popover outside viewport '+JSON.stringify(bounds));
  await screenshot('chat-model-picker-mobile');cases.push('mobile-popover-bounds');
  if (exceptions.length) throw new Error("Renderer exception: " + exceptions.join("; "));
  const report = { passed: true, cases, catalogCalls, screenshots: output };
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(error, logs.slice(-5000)); if (command) { await screenshot("failure").catch(() => {}); console.error(await evaluate("document.body.innerText").catch(() => "")); } throw error; }
finally {
  ws?.close();
  if (child && !exited) { if (process.platform === "win32") { const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); await new Promise((resolve) => killer.on("close", resolve)); } else child.kill("SIGTERM"); }
  await core.close(); await model.close(); await identity.close(); await mcp.close();
  if (path.dirname(root).toLowerCase() === os.tmpdir().toLowerCase() && path.basename(root).startsWith("nex-picker-fixture-")) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { console.warn("Owned fixture retained for cleanup:", root); }
  }
}
