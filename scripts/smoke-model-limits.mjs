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
import { startFakeModel } from "../server/runtime/pi/p0/fake-model.ts";
import { startFakeMcp } from "../server/personal-os/testing/fake-mcp.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "nex-limits-fixture-"));
const output = path.resolve("release/model-limits-verification"); mkdirSync(output, { recursive: true });
const { createPersonalApp } = await import(pathToFileURL(path.resolve("dist-personal/server/core/index.js")).href);
const identity = await startFakeIdentity({ displayName: "演示账号" }), model = await startFakeModel(), mcp = await startFakeMcp();
let token = "synthetic-workspace-bootstrap";
let failCatalog = false, holdCatalog; let catalogCalls = 0;
const catalogFetch = async () => { catalogCalls++; if (holdCatalog) await holdCatalog; if (failCatalog) throw new Error("fixture offline"); return Response.json({ fixture: { id: "fixture", name: "Fixture", env: [], api: model.origin + "/v1", models: { "fixture-model": { id: "fixture-model", name: "Fixture", tool_call: true, modalities: { input: ["text"] }, limit: { context: 120000, output: 24000 } }, "fixture-other": { id: "fixture-other", name: "Other", tool_call: true, modalities: { input: ["text"] }, limit: { context: 80000, output: 10000 } } } } }); };
const core = await createPersonalApp({ dir: path.join(root, "core"), key: randomBytes(32), token, uiDir: path.resolve("dist-personal/server/ui"), memoryRuntime: false, modelCatalog: { fetch: catalogFetch, readSnapshot: () => undefined, log: () => {} }, identity: { fixtureOrigin: identity.origin } });
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
  await api("config", { provider: "openai", endpoint: model.origin + "/v1", model: "fixture-model", apiKey: "synthetic-only" });
  await api("bots", { name: "工作助手", instructions: "整理信息。" });
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
  const form = "document.querySelector('[data-model-settings]')";
  const ready = () => until(() => evaluate("!!document.querySelector('input[name=contextWindow]')&&!document.querySelector('input[name=contextWindow]').disabled&&!document.querySelector('[data-model-settings] button[type=submit]').disabled"));
  const save = async () => { await ready(); await textButton("保存配置", form); await until(() => evaluate("!!document.querySelector('.preferences-saved')")); };
  await ready();
  await until(() => evaluate("document.querySelector('input[name=contextWindow]').placeholder.includes('120,000')&&document.querySelector('input[name=maxOutputTokens]').placeholder.includes('24,000')"), "automatic model limits");
  if (catalogCalls !== 1) throw new Error("Catalog refresh was not coalesced");
  cases.push("automatic-context-and-output-discovery");
  await input("input[name=contextWindow]", "180000"); await input("input[name=maxOutputTokens]", "12345"); await save();
  if (core.store.modelConfig().contextWindow !== 180000 || core.store.modelConfig().maxOutputTokens !== 12345) throw new Error("Manual limits not saved");
  await input("input[name=model]", "fixture-other"); await ready();
  await until(() => evaluate("document.querySelector('input[name=contextWindow]').placeholder.includes('80,000')"));
  if (await evaluate("document.querySelector('input[name=contextWindow]').value!==''")) throw new Error("Another model inherited manual override");
  await input("input[name=contextWindow]", "90000"); await input("input[name=maxOutputTokens]", "9000"); await save();
  await input("input[name=model]", "fixture-model"); await ready();
  await until(() => evaluate("document.querySelector('input[name=contextWindow]').value==='180000'&&document.querySelector('input[name=maxOutputTokens]').value==='12345'"));
  cases.push("per-model-values-restored");
  // A slow directory response cannot overwrite edits or the next model.
  let releaseCatalog; holdCatalog = new Promise(resolve => { releaseCatalog = resolve; });
  await textButton("联网识别", form); await until(() => catalogCalls === 2);
  await input("input[name=contextWindow]", "190000");
  releaseCatalog(); holdCatalog = undefined;
  await until(() => evaluate("[...document.querySelectorAll('[data-model-limits] button')].some(b=>b.textContent==='联网识别')"));
  if (!await evaluate("document.querySelector('input[name=contextWindow]').value==='190000'")) throw new Error("Lookup replaced manual edit");
  await save();
  holdCatalog = new Promise(resolve => { releaseCatalog = resolve; });
  await textButton("联网识别", form); await until(() => catalogCalls === 3);
  await input("input[name=model]", "fixture-other"); await ready();
  releaseCatalog(); holdCatalog = undefined;
  await until(() => evaluate("document.querySelector('input[name=contextWindow]').value==='90000'"));
  cases.push("slow-lookup-preserves-edits-and-model-scope");
  // Clearing a saved value returns to auto mode, without losing other models.
  await input("input[name=contextWindow]", ""); await input("input[name=maxOutputTokens]", ""); await save();
  if (core.store.modelConfig().contextWindow !== 80000 || core.store.modelConfig().maxOutputTokens !== 10000) throw new Error("Clearing did not restore automatic limits");
  failCatalog = true; await textButton("联网识别", form);
  await until(() => evaluate("document.querySelector('[data-model-limits]').textContent.includes('联网识别失败')"));
  if (!await evaluate("document.querySelector('input[name=contextWindow]').placeholder.includes('80,000')")) throw new Error("Offline lookup discarded cache");
  cases.push("clear-override-and-offline-cache");
  await input("input[name=model]", "unrecognized-model"); await ready();
  await until(() => evaluate("document.querySelector('[data-model-limits]').textContent.includes('未识别到此模型')"));
  if (!await evaluate("document.querySelector('input[name=contextWindow]').placeholder.includes('256,000')&&document.querySelector('input[name=maxOutputTokens]').placeholder.includes('32,000')")) throw new Error("Incorrect default limits");
  await input("input[name=contextWindow]", "100000"); await input("input[name=maxOutputTokens]", "128000");
  if (!await evaluate("document.querySelector('[data-model-settings] form').checkValidity()")) throw new Error("Independent output ceiling rejected");
  await save();
  if (core.store.modelConfig().contextWindow !== 100000 || core.store.modelConfig().maxOutputTokens !== 128000) throw new Error("Independent output ceiling not saved");
  cases.push("default-256k-32k-and-independent-output-ceiling");
  await input("input[name=model]", "fixture-model"); await ready();
  await until(() => evaluate("document.querySelector('input[name=contextWindow]').value==='190000'"));
  await save();
  await command("Page.reload"); await until(() => evaluate("!!document.querySelector('.workspace-account-name')"));
  await click(".workspace-account-name"); await textButton("设置", "document.querySelector('.account-menu')"); await textButton("模型", "document.querySelector('.preferences-nav')"); await ready();
  await until(() => evaluate("document.querySelector('input[name=contextWindow]').value==='190000'"));
  cases.push("unknown-model-validation-and-reload");
  await evaluate("document.querySelector('[data-model-limits]').scrollIntoView({block:'center'})");
  await geometry(); await screenshot("model-limits-desktop");
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate("document.querySelector('[data-model-limits]').scrollIntoView({block:'center'})");
  await geometry(); await screenshot("model-limits-mobile");
  if (exceptions.length) throw new Error("Renderer exception: " + exceptions.join("; "));
  const report = { passed: true, cases, catalogCalls, screenshots: output };
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(error, logs.slice(-5000)); if (command) { await screenshot("failure").catch(() => {}); console.error(await evaluate("document.body.innerText").catch(() => "")); } throw error; }
finally {
  ws?.close();
  if (child && !exited) { if (process.platform === "win32") { const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); await new Promise((resolve) => killer.on("close", resolve)); } else child.kill("SIGTERM"); }
  await core.close(); await model.close(); await identity.close(); await mcp.close();
  if (path.dirname(root).toLowerCase() === os.tmpdir().toLowerCase() && path.basename(root).startsWith("nex-limits-fixture-")) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { console.warn("Owned fixture retained for cleanup:", root); }
  }
}
