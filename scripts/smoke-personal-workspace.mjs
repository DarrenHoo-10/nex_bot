// Isolated Core + real hidden Electron renderer; no user profile or live provider.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { WebSocket } from "ws";
import { startFakeIdentity } from "../server/personal-os/testing/fake-identity.ts";
import { startFakeModel } from "../server/runtime/pi/p0/fake-model.ts";
import { startFakeMcp } from "../server/personal-os/testing/fake-mcp.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "nex-workspace-fixture-"));
const output = path.resolve("release/workspace-verification-avatars"); mkdirSync(output, { recursive: true });
const { createPersonalApp } = await import(pathToFileURL(path.resolve("dist-personal/server/core/index.js")).href);
const identity = await startFakeIdentity(), model = await startFakeModel(), mcp = await startFakeMcp();
let token = "synthetic-workspace-bootstrap";
const core = await createPersonalApp({ dir: path.join(root, "core"), key: randomBytes(32), token, uiDir: path.resolve("dist-personal/server/ui"), memoryRuntime: false, identity: { fixtureOrigin: identity.origin } });
let child, ws, exited = false, logs = ""; const cases = [], exceptions = [];
async function until(check, label = "renderer state", timeout = 30_000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise((resolve) => setTimeout(resolve, 70)); } }
async function api(route, data) { const response = await fetch(core.origin + "/api/" + route, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) }); const value = await response.json(); if (!response.ok) throw new Error(value.error); return value; }
let command, evaluate;
const click = (selector) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw new Error('Control unavailable: '+${JSON.stringify(selector)});el.click();})()`);
const textButton = (text, scope = "document") => evaluate(`(()=>{const el=[...${scope}.querySelectorAll('button')].find(e=>(e.textContent.trim()===${JSON.stringify(text)}||e.querySelector(':scope > span')?.textContent.trim()===${JSON.stringify(text)}));if(!el||el.disabled)throw new Error('Button unavailable: '+${JSON.stringify(text)});el.click();})()`);
async function input(selector, value) { await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
async function screenshot(name) { await new Promise((resolve) => setTimeout(resolve, 250)); writeFileSync(path.join(output, name + ".png"), Buffer.from((await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data, "base64")); }
async function send(text) { await input(".composer textarea", text); await until(() => evaluate("!document.querySelector('.send').disabled")); await click(".send"); }
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
  await api("config", { provider: "openai", endpoint: model.origin + "/v1", model: "fixture-model", apiKey: "synthetic-only" });
  const bot = await api("bots", { name: "工作助手", instructions: "整理信息、调用工具，帮助你推进每天的工作。" });
  const peer = await api("bots", { name: "研究伙伴", instructions: "关注问题的依据，整理资料和研究结论。" });
  const profile = path.join(root, "renderer"); mkdirSync(profile, { recursive: true });
  const entry = path.join(root, "renderer.cjs");
  writeFileSync(entry, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(profile)});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,offscreen:true}});await w.webContents.session.cookies.set({url:${JSON.stringify(core.origin)},name:'nex',value:${JSON.stringify(token)},httpOnly:true,sameSite:'strict',path:'/'});await w.loadURL(${JSON.stringify(core.origin)});});app.on('window-all-closed',()=>app.quit());`);
  const stagedElectron = path.resolve("dist-personal/electron", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron.exe");
  const electron = existsSync(stagedElectron) ? stagedElectron : createRequire(import.meta.url)("electron");
  child = spawn(electron, [entry, "--remote-debugging-port=0"], { windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, TEMP: os.tmpdir(), TMP: os.tmpdir() }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => logs += data); child.stderr.on("data", (data) => logs += data); child.on("exit", () => exited = true);
  await until(() => { if (exited) throw new Error("Fixture renderer exited: " + logs); return existsSync(path.join(profile, "DevToolsActivePort")); }, "hidden renderer boot");
  const port = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl); await new Promise((resolve) => ws.once("open", resolve));
  let sequence = 0; const replies = new Map();
  ws.on("message", (raw) => { const event = JSON.parse(raw); if (event.method === "Runtime.exceptionThrown") exceptions.push(event.params.exceptionDetails.text); const pending = replies.get(event.id); if (pending) { replies.delete(event.id); if (event.error) pending.reject(new Error(event.error.message)); else pending.resolve(event.result); } });
  command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { replies.delete(id); reject(new Error("CDP timeout: " + method)); }, 20_000); replies.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } }); ws.send(JSON.stringify({ id, method, params })); });
  evaluate = async (expression) => { const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  await command("Runtime.enable");
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await until(() => evaluate("!!document.querySelector('.contact-item')"), "authenticated workspace");
  await click(`[data-agent='${bot.id}']`);
  await until(() => evaluate("!!document.querySelector('.composer')"));
  await click("[title='更换头像']");
  await until(() => evaluate("document.querySelectorAll('.avatar-option').length===20&&[...document.querySelectorAll('.avatar-option img')].every(img=>img.complete&&img.naturalWidth>0)"), "20 loaded vector portraits");
  await screenshot("avatar-picker");
  await click("[data-avatar-option='fox']"); await textButton("完成");
  await until(() => evaluate("document.querySelectorAll('.portrait-avatar[data-avatar=fox]').length>=3"));
  await command("Page.reload"); await until(() => evaluate("!!document.querySelector('.composer')&&document.querySelector('header .portrait-avatar')?.dataset.avatar==='fox'"), "avatar selection survives reload");
  cases.push("20-vector-portraits-load-select-and-persist");
  model.scripts.push({ kind: "openai-text", text: "可以。我们先把今天最重要的工作整理清楚，再逐项推进。\n\n- 确认要完成的事项\n- 用连接器获取所需信息\n- 完成后向你汇报结果" });
  await send("帮我整理今天的工作，稍后用连接器查询资料。");
  await until(() => evaluate("document.querySelector('.transcript').textContent.includes('完成后向你汇报结果')"), "actual worker reply");
  await click("[aria-label='打开快捷操作']");
  await until(() => evaluate("document.querySelector('.composer-menu')?.textContent.includes('管理连接器')"));
  await click("[aria-label='关闭快捷操作']");
  if (await evaluate("document.querySelector('.agent-configuration').open")) throw new Error("Settings should be collapsed initially");
  await click(".agent-configuration > summary");
  if (!await evaluate("document.querySelector('.agent-configuration').textContent.includes('工具权限')")) throw new Error("Agent settings missing");
  await click(".agent-configuration > summary");
  cases.push("compact-composer-menu-and-inspector-settings");
  await geometry(); await screenshot("workspace-light"); cases.push("NexorAI-fixture-login", "three-pane-layout", "real-worker-chat");
  await input("[aria-label='搜索 Agent']", "研究");
  await until(() => evaluate("document.querySelectorAll('.contact-item').length===1"));
  await input("[aria-label='搜索 Agent']", "");
  await click("[title='置顶联系人']");
  if (!await evaluate("document.querySelector('.sidebar-section-title').textContent.includes('置顶')")) throw new Error("Pin did not update");
  await input(".composer textarea", "保留这段草稿"); await click(`[data-agent='${peer.id}']`); await click(`[data-agent='${bot.id}']`);
  await until(() => evaluate("document.querySelector('.composer textarea').value==='保留这段草稿'")); await input(".composer textarea", "");
  cases.push("contact-search-pin", "per-agent-draft");
  await textButton("连接器", "document.querySelector('.workspace-nav')");
  await textButton("添加连接器");
  await input("input[name='name']", "本地知识库"); await input("input[name='url']", mcp.origin + "/mcp"); await input("input[name='token']", "synthetic-ui-secret");
  await textButton("保存连接器"); await until(() => evaluate("!!document.querySelector('.connector-detail')&&!document.querySelector('.connector-modal')"));
  await textButton("测试连接"); await until(() => evaluate("document.querySelector('.connector-detail').textContent.includes('连接测试通过')"));
  await evaluate("[...document.querySelectorAll('.connector-agent')].find(el=>el.textContent.includes('工作助手')).querySelector('button').click()");
  await click(".grant-editor input"); await textButton("保存授权");
  await until(() => evaluate("!document.querySelector('.grant-editor')&&document.querySelector('.connector-detail').textContent.includes('1 项工具已授权')"));
  await screenshot("connectors-light"); cases.push("MCP-add-test-discovery-grant-UI");
  const connector = (await api("state")).connectors[0];
  await click(`[data-agent='${bot.id}']`);
  const args = { action: "connector.call", connectorId: connector.id, connectorVersion: connector.version, tool: "echo", parameters: { text: "工作资料已找到" } };
  model.scripts.push({ kind: "openai-tool", calls: [{ id: "workspace-mcp", name: "broker", args: JSON.stringify(args) }] }, { kind: "openai-text", text: "已通过连接器获取工作资料。" });
  await send("用知识库工具查找工作资料。"); await until(() => evaluate("!!document.querySelector('.approval')"), "MCP approval");
  if (mcp.calls.length) throw new Error("Tool ran without approval"); await screenshot("connector-approval");
  await textButton("批准", "document.querySelector('.approval')");
  await until(() => evaluate("document.querySelector('.transcript').textContent.includes('已通过连接器获取工作资料')"));
  if (mcp.calls.length !== 1) throw new Error("MCP did not execute exactly once");
  cases.push("MCP-approval-and-tool-call");
  mcp.hold(true); model.scripts.push({ kind: "openai-tool", calls: [{ id: "workspace-stop", name: "broker", args: JSON.stringify(args) }] });
  await send("测试停止等待中的调用。"); await until(() => evaluate("!!document.querySelector('.approval')")); await textButton("批准", "document.querySelector('.approval')");
  await until(() => mcp.calls.length === 2); await click("[aria-label='停止任务']");
  await until(() => core.store.get("SELECT status FROM tool_calls WHERE provider_tool_call_id='workspace-stop'")?.status === "unknown" && !core.runtime.workers.size);
  cases.push("stop-fences-late-connector-result");
  await click("[aria-label='切换深色模式']"); await screenshot("workspace-dark");
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  // Details can be explicitly opened on narrow screens; close the initial panel.
  await click("[aria-label='收起资料']"); await geometry(); await screenshot("workspace-mobile");
  await click(".mobile-menu"); await until(() => evaluate("document.querySelector('.contact-sidebar').classList.contains('is-open')"));
  await textButton("连接器", "document.querySelector('.workspace-nav')"); await geometry(); await screenshot("connectors-mobile");
  cases.push("light-dark-theme", "mobile-drawer-and-no-horizontal-overflow");
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await click("[aria-label='切换浅色模式']");
  await textButton("停用"); await until(() => evaluate("document.querySelector('.connection-status').textContent==='已停用'")); await textButton("启用");
  await textButton("移除连接器"); await until(() => evaluate("[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='确认移除'&&!button.disabled)")); await textButton("确认移除"); await until(() => evaluate("!!document.querySelector('.connector-empty')"));
  cases.push("MCP-disable-enable-remove");
  if (exceptions.length) throw new Error("Renderer exceptions: " + exceptions.join(","));
  await command("Emulation.setDeviceMetricsOverride", { width: 1200, height: 1160, deviceScaleFactor: 1, mobile: false });
  await command("Page.navigate", { url: pathToFileURL(path.resolve("docs/design/avatar-collection.html")).href });
  await until(() => evaluate("document.querySelectorAll('article img').length===20&&[...document.images].every(img=>img.complete&&img.naturalWidth>0)"), "portrait contact sheet");
  await screenshot("avatar-collection");
  const report = { passed: true, cases, modelRequests: model.requests.length, toolCalls: mcp.calls.length, screenshots: output };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { console.error(error, logs.slice(-5000)); if (command) { await screenshot("failure").catch(() => {}); console.error(await evaluate("document.body.innerText").catch(() => "")); } throw error; }
finally {
  ws?.close();
  if (child && !exited) { if (process.platform === "win32") { const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); await new Promise((resolve) => killer.on("close", resolve)); } else child.kill("SIGTERM"); }
  await core.close(); await model.close(); await identity.close(); await mcp.close();
  if (path.dirname(root).toLowerCase() === os.tmpdir().toLowerCase() && path.basename(root).startsWith("nex-workspace-fixture-")) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { console.warn("Owned fixture retained for cleanup:", root); }
  }
}
