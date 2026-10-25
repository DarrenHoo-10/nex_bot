// Real renderer + isolated Core, identity, model and Google fixtures. No live accounts.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { startFakeGoogle } from "../server/personal-os/testing/fake-google.ts";
import { startFakeIdentity } from "../server/personal-os/testing/fake-identity.ts";
import { startFakeModel } from "../server/runtime/pi/p0/fake-model.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "nex-gmail-renderer-"));
const nativeShell = process.argv.includes("--shell");
const output = path.resolve(nativeShell ? "release/gmail-cross-platform/windows" : "release/gmail-verification"); mkdirSync(output, { recursive: true });
const { createPersonalApp } = await import(pathToFileURL(path.resolve("dist-personal/server/core/index.js")).href);
const google = await startFakeGoogle(), identity = await startFakeIdentity({ displayName: "演示账号" }), model = await startFakeModel();
const core = await createPersonalApp({ dir: path.join(root, "core"), key: randomBytes(32), token: "synthetic-bootstrap", hostDevice: false, uiDir: path.resolve("dist-personal/server/ui"), identity: { fixtureOrigin: identity.origin }, gmail: google.configuration, memoryRuntime: false, modelCatalog: { fetchDisabled: true, readSnapshot: () => undefined, log: () => {} } });
let token, child, ws, command, evaluate, exited = false, logs = "";
const cases = [], exceptions = [];
async function until(check, label, timeout = 30_000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error("Timed out: " + label); await new Promise((resolve) => setTimeout(resolve, 75)); } }
async function api(route, data) { const response = await fetch(core.origin + "/api/" + route, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); return result; }
const click = (selector) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw new Error('Control unavailable');el.click()})()`);
const button = (text, selector = "body") => evaluate(`(()=>{const el=[...document.querySelector(${JSON.stringify(selector)}).querySelectorAll('button')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)});if(!el||el.disabled)throw new Error('Button unavailable: '+${JSON.stringify(text)});el.click()})()`);
async function screenshot(name) { if (nativeShell) return; await new Promise((resolve) => setTimeout(resolve, 200)); writeFileSync(path.join(output, name + ".png"), Buffer.from((await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data, "base64")); }
async function finishAuthorization(selector = ".connector-account-add") {
  await until(() => evaluate(`!!document.querySelector('${selector} .gmail-authorization a')`), "authorization link");
  const url = await evaluate(`document.querySelector('${selector} .gmail-authorization a').href`);
  const response = await fetch(url); return response.status;
}
async function geometry() {
  const layout = await evaluate(`(()=>{const el=document.querySelector('.connectors-page'),r=el.getBoundingClientRect();return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,left:r.left,right:r.right}})()`);
  if (layout.scrollWidth > layout.width + 1 || layout.left < 0 || layout.right > layout.width + 1) throw new Error("Connector overflow: " + JSON.stringify(layout));
}
try {
  const operator = core.store.get("SELECT * FROM user_sessions WHERE id=?", core.store.session);
  const challenge = core.identity.start({ account: "owner@example.test", name: "Gmail 界面验收" }, operator);
  token = (await core.identity.respond({ ...challenge, password: " synthetic password " }, operator)).token;
  await api("config", { provider: "openai", endpoint: model.origin + "/v1", model: "fixture", apiKey: "synthetic-only" });
  const bot = await api("bots", { name: "工作助手", instructions: "帮助整理邮件与日程。" });
  const profile = path.join(root, "renderer"); mkdirSync(profile);
  const entry = path.join(root, "renderer.cjs");
  const browserMode = path.join(root, "browser-mode.txt"), browserCalls = path.join(root, "browser-calls.jsonl");
  writeFileSync(browserMode, "fail");
  writeFileSync(entry, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(profile)});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,offscreen:true}});w.webContents.setWindowOpenHandler(()=>({action:'allow',overrideBrowserWindowOptions:{show:false,webPreferences:{sandbox:true,contextIsolation:true}}}));await w.webContents.session.cookies.set({url:${JSON.stringify(core.origin)},name:'nex',value:${JSON.stringify(token)},httpOnly:true,sameSite:'strict',path:'/'});await w.loadURL(${JSON.stringify(core.origin)});});app.on('window-all-closed',()=>app.quit());`);
  if (nativeShell) writeFileSync(entry, `const {app,shell}=require('electron');const fs=require('node:fs');app.on('browser-window-created',(_,w)=>{w.webContents.setBackgroundThrottling(false);w.hide();w.on('show',()=>w.hide());});shell.openExternal=async(url)=>{if(new URL(url).origin!==${JSON.stringify(google.origin)})throw Error('Fixture refused external origin');fs.appendFileSync(${JSON.stringify(browserCalls)},JSON.stringify({url})+'\\n');if(fs.readFileSync(${JSON.stringify(browserMode)},'utf8')==='fail')throw Error('Fixture browser unavailable');await fetch(url);};import(${JSON.stringify(pathToFileURL(path.resolve("electron/nex-client-main.mjs")).href)});`);
  const staged = path.resolve("dist-personal/electron", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron.exe");
  const electron = existsSync(staged) ? staged : createRequire(import.meta.url)("electron");
  child = spawn(electron, [entry, `--profile=${profile}`, "--remote-debugging-port=0"], { windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, TEMP: os.tmpdir(), TMP: os.tmpdir() }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => logs += data); child.stderr.on("data", (data) => logs += data); child.on("exit", () => exited = true);
  await until(() => { if (exited) throw new Error("Fixture renderer exited"); return existsSync(path.join(profile, "DevToolsActivePort")); }, "renderer boot");
  const port = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl); await new Promise((resolve) => ws.once("open", resolve));
  let sequence = 0; const replies = new Map();
  ws.on("message", (raw) => { const event = JSON.parse(raw); if (event.method === "Runtime.exceptionThrown") exceptions.push(event.params.exceptionDetails.text); const pending = replies.get(event.id); if (pending) { replies.delete(event.id); if (event.error) pending.reject(new Error(event.error.message)); else pending.resolve(event.result); } });
  command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { replies.delete(id); reject(new Error("CDP timeout: " + method)); }, 20_000); replies.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } }); ws.send(JSON.stringify({ id, method, params })); });
  evaluate = async (expression) => { const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  await command("Runtime.enable"); await command("Page.enable");
  if (nativeShell) {
    await until(() => evaluate("!!document.querySelector('#connection')"), "native login");
    await evaluate(`document.querySelector('#name').value='Gmail Fixture';document.querySelector('#origin').value=${JSON.stringify(core.origin)};document.querySelector('#email').value='owner@example.test';document.querySelector('#password').value=' synthetic password ';document.querySelector('#connection').requestSubmit();true`);
  }
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await until(() => evaluate("!!document.querySelector('.contact-item')"), "workspace");
  await click(".workspace-account-name"); await button("设置", ".account-menu"); await button("连接器", ".preferences-nav");
  await until(() => evaluate("!!document.querySelector('.connector-catalog')"), "Gmail catalog");
  await geometry(); await screenshot("gmail-catalog-light");
  if (!await evaluate("document.querySelector('[data-connector=gmail] img').naturalWidth>0")) throw new Error("Gmail brand asset did not load");
  await evaluate("(()=>{const el=document.querySelector('.connector-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'no-match-fixture');el.dispatchEvent(new Event('input',{bubbles:true}))})()");
  await until(() => evaluate("!!document.querySelector('.connector-no-results')"), "filtered catalog");
  await evaluate("(()=>{const el=document.querySelector('.connector-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'');el.dispatchEvent(new Event('input',{bubbles:true}))})()");
  await click("[data-connector=gmail]"); await until(() => evaluate("!!document.querySelector('.connector-profile')"), "Gmail detail");
  cases.push("brand-catalog-search-and-detail-navigation");
  // A blocked popup must leave a usable link and must not start a second OAuth flow.
  await evaluate("window.fixtureOriginalOpen=window.open;window.open=()=>null");
  await button("连接 Gmail", ".connector-account-add");
  await until(() => evaluate("!!document.querySelector('.gmail-authorization a')"), "blocked popup recovery");
  await screenshot("gmail-authorization-light");
  const cancelledUrl = await evaluate("document.querySelector('.gmail-authorization a').href");
  if (nativeShell) {
    await until(() => evaluate("document.querySelector('.gmail-connect [role=alert]')?.textContent.includes('Fixture browser unavailable')"), "native browser failure");
    await click(".gmail-authorization a");
    await until(() => existsSync(browserCalls) && readFileSync(browserCalls, "utf8").trim().split("\n").length === 2, "native retry");
    cases.push("real-preload-ipc-system-browser-failure-and-retry");
  }
  await button("取消连接", ".connector-account-add");
  await until(() => evaluate("!document.querySelector('.gmail-authorization')"), "cancelled flow");
  if ((await fetch(cancelledUrl)).status !== 400 || core.connectors.list().length) throw new Error("Cancelled flow connected");
  cases.push(nativeShell ? "native-browser-fallback-and-cancellation" : "blocked-popup-fallback-and-cancellation");
  await button("连接 Gmail", ".connector-account-add");
  await until(() => evaluate("!!document.querySelector('.gmail-authorization a')"), "navigation cancellation flow");
  const abandonedUrl = await evaluate("document.querySelector('.gmail-authorization a').href");
  await evaluate("window.dispatchEvent(new Event('nex-android-back'))");
  await until(() => evaluate("document.activeElement?.dataset.connector==='gmail'"), "catalog focus restoration");
  if ((await fetch(abandonedUrl)).status !== 400 || core.connectors.list().length) throw new Error("Leaving details retained authorization");
  await click("[data-connector=gmail]"); cases.push("back-navigation-cancels-authorization-and-restores-focus");
  google.state.deny = true; await button("连接 Gmail", ".connector-account-add");
  if (await finishAuthorization() !== 400) throw new Error("Consent denial was accepted");
  await until(() => evaluate("document.querySelector('.connector-account-add')?.textContent.includes('Google 授权未完成')"), "denial UI");
  google.state.deny = false; await button("连接 Gmail", ".connector-account-add");
  if (await finishAuthorization() !== 200) throw new Error("OAuth failed");
  await until(() => evaluate("document.querySelector('.connector-detail')?.textContent.includes('reader@example.test')&&!document.querySelector('.gmail-authorization')"), "connected mailbox");
  if (core.connectors.list()[0].grants.length) throw new Error("Connection automatically granted tools");
  cases.push("denial-retry-callback-polling-account-display");
  await button("管理授权", ".connector-agent");
  await evaluate("[...document.querySelectorAll('.grant-editor input')].forEach(el=>el.click())");
  await screenshot("gmail-grants-light"); await button("保存授权", ".grant-editor");
  await until(() => evaluate("!document.querySelector('.grant-editor')&&document.querySelector('.connector-detail')?.textContent.includes('3 项工具已授权')"), "saved grants");
  await click(".connector-back");
  if (!await evaluate("document.querySelector('[data-connector=gmail]').textContent.includes('已添加')")) throw new Error("Connected catalog status missing");
  await screenshot("gmail-catalog-added-light"); await click("[data-connector=gmail]");
  await screenshot("gmail-connected-light");
  await click(".connector-tool-disclosure summary");
  if (!await evaluate("document.querySelector('.connector-tool-disclosure').open&&document.querySelectorAll('.connector-capabilities > div').length===3")) throw new Error("Tool disclosure failed");
  await screenshot("gmail-tools-light"); await click(".connector-tool-disclosure summary");
  const connector = core.connectors.list()[0];
  model.scripts.push({ kind: "openai-tool", calls: [{ id: "mail", name: "broker", args: JSON.stringify({ action: "connector.call", connectorId: connector.id, connectorVersion: connector.version, tool: "gmail.search", parameters: { query: "is:unread" } }) }] }, { kind: "openai-text", text: "你有一封未读的项目进展邮件，来自 team@example.test。" });
  await click(`[data-agent='${bot.id}']`);
  await until(() => evaluate("!!document.querySelector('.composer textarea')"), "composer");
  await evaluate("(()=>{const el=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'查找未读邮件');el.dispatchEvent(new Event('input',{bubbles:true}))})()");
  await until(() => evaluate("!document.querySelector('.send').disabled"), "send ready"); await click(".send");
  await until(() => evaluate("document.querySelector('.transcript')?.textContent.includes('你有一封未读的项目进展邮件')"), "worker reply");
  if (core.store.all("SELECT id FROM approvals").length) throw new Error("Read-only mail required approval");
  await screenshot("gmail-chat-light"); cases.push("granted-mail-search-through-real-worker-and-transcript");
  await click(".workspace-account-name"); await button("设置", ".account-menu"); await button("连接器", ".preferences-nav");
  await click("[data-connector=gmail]");
  await click(".connector-account-menu");
  await button("停用", ".connector-detail"); await until(() => evaluate("[...document.querySelectorAll('.connector-detail button')].some(el=>el.textContent==='启用'&&!el.disabled)"), "disabled");
  if (core.connectors.directory(bot.id).length) throw new Error("Disabled mailbox remains advertised");
  await button("启用", ".connector-detail"); await until(() => evaluate("[...document.querySelectorAll('.connector-detail button')].some(el=>el.textContent==='停用'&&!el.disabled)"), "enabled");
  await button("测试连接", ".connector-detail"); await until(() => evaluate("document.querySelector('.connector-feedback')?.textContent.includes('连接成功')"), "connection check");
  await click(".connector-account-menu");
  google.state.email = "research.team.with.a.long.mailbox.name@example.test";
  await button("添加其他账户", ".connector-account-add");
  if (await finishAuthorization() !== 200) throw new Error("Second mailbox failed");
  await until(() => evaluate("document.querySelectorAll('.connector-account').length===2&&!document.querySelector('.gmail-authorization')"), "two grouped mailboxes");
  const second = core.connectors.list().find((item) => item.id !== connector.id);
  if (second.grants.length || core.connectors.list().find((item) => item.id === connector.id).grants[0].tools.length !== 3) throw new Error("Mailbox grants leaked across accounts");
  await click(".connector-back");
  if (!await evaluate("document.querySelectorAll('[data-connector=gmail]').length===1")) throw new Error("Mailboxes duplicated catalog entries");
  await click("[data-connector=gmail]"); await screenshot("gmail-multiple-accounts-light");
  await click(".workspace-account-name"); await button("切换深色模式", ".account-menu"); await screenshot("gmail-connected-dark");
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await geometry(); await screenshot("gmail-connected-mobile-dark");
  await evaluate("document.querySelector('.connector-detail').scrollIntoView({block:'start'})");
  if (!await evaluate("(()=>{const r=document.querySelector('.connector-detail').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&[...document.querySelectorAll('.connector-detail button')].every(el=>el.getBoundingClientRect().right<=innerWidth+1)})()")) throw new Error("Mobile mailbox controls overflow");
  await screenshot("gmail-details-mobile-dark");
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await evaluate("document.querySelector('.preferences-page').scrollIntoView({block:'start'})");
  await click(".workspace-account-name"); await button("切换浅色模式", ".account-menu");
  cases.push("test-disable-enable-desktop-mobile-light-dark");
  await click(`[data-account='${second.id}'] .connector-account-menu`);
  await button("断开连接", `[data-account='${second.id}']`); await button("确认断开", `[data-account='${second.id}']`);
  await until(() => evaluate("document.querySelectorAll('.connector-account').length===1"), "one mailbox removed");
  if (core.connectors.list().length !== 1 || core.connectors.list()[0].id !== connector.id || core.connectors.list()[0].grants[0].tools.length !== 3) throw new Error("Removing one mailbox affected another");
  cases.push("multiple-accounts-grouping-grant-isolation-and-targeted-disconnect");
  google.state.email = "reader@example.test";
  await evaluate("window.open=window.fixtureOriginalOpen");
  if (nativeShell) writeFileSync(browserMode, "complete");
  await click(".connector-account-menu");
  await button("重新授权", ".connector-detail");
  await until(() => google.exchanges >= 3, "popup callback");
  await until(() => evaluate("!document.querySelector('.connector-detail .gmail-authorization')"), "reauthorization completed");
  if (core.connectors.list()[0].grants[0].tools.length !== 3) throw new Error("Reconnect lost grants");
  cases.push(nativeShell ? "native-browser-reauthorization-preserves-grants" : "normal-popup-reauthorization-preserves-grants");
  await button("断开连接", ".connector-detail"); await button("确认断开", ".connector-detail");
  await until(() => evaluate("!document.querySelector('.connector-account')&&document.querySelector('.connector-account-add')?.textContent.includes('连接 Gmail')"), "disconnected");
  if (core.connectors.list().length || google.revocations !== 2) throw new Error("Disconnect failed");
  await click(".connector-back");
  if (await evaluate("document.querySelector('[data-connector=gmail]').textContent.includes('已添加')")) throw new Error("Removed mailbox still appears connected");
  cases.push("disconnect-revocation-and-empty-state");
  // The catalog row offers Connect directly; opening the detail page first is not required.
  const rowConnect = ".connector-catalog-item > .gmail-connect";
  const onCatalog = "!!document.querySelector('.connector-catalog')&&!document.querySelector('.connector-profile')";
  if (!await evaluate(`(()=>{const el=document.querySelector('${rowConnect} button');return !!el&&el.textContent.trim()==='连接'&&!el.disabled&&el.getClientRects().length>0&&!document.querySelector('[data-connector=gmail]').textContent.includes('已添加')})()`)) throw new Error("Catalog row has no direct Connect button");
  if (await evaluate("!!document.querySelector('[data-connector=gmail] button')")) throw new Error("Interactive control nested inside the catalog row button");
  await geometry(); await screenshot("gmail-catalog-connect-light");
  await evaluate("window.fixtureOriginalOpen=window.open;window.open=()=>null");
  // The native shell would finish authorization at once; keep it pending so cancellation can be exercised.
  if (nativeShell) writeFileSync(browserMode, "fail");
  const pendingFromCatalog = async (width) => {
    await button("连接", rowConnect);
    await until(() => evaluate(`!!document.querySelector('${rowConnect} .gmail-authorization a')`), "catalog authorization link");
    if (!await evaluate(onCatalog)) throw new Error("Connecting from the catalog left the catalog");
    await geometry();
    if (!await evaluate(`[...document.querySelectorAll('.connector-catalog-item *')].every(el=>el.getBoundingClientRect().right<=innerWidth+1)`)) throw new Error("Catalog authorization overflows at " + width);
    await screenshot(`gmail-catalog-authorizing-${width}`);
    return evaluate(`document.querySelector('${rowConnect} .gmail-authorization a').href`);
  };
  const cancelFromCatalog = async (url) => {
    await button("取消连接", rowConnect);
    await until(() => evaluate(`!document.querySelector('${rowConnect} .gmail-authorization')&&!!document.querySelector('${rowConnect} button')`), "catalog cancelled flow");
    if ((await fetch(url)).status !== 400 || core.connectors.list().length) throw new Error("Cancelled catalog flow connected");
  };
  await cancelFromCatalog(await pendingFromCatalog("desktop"));
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await geometry(); await screenshot("gmail-catalog-connect-mobile");
  await cancelFromCatalog(await pendingFromCatalog("mobile"));
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  // Opening the detail page while authorizing abandons the pending flow, like leaving the detail page does.
  const abandonedFromCatalog = await pendingFromCatalog("desktop");
  await click("[data-connector=gmail]"); await until(() => evaluate("!!document.querySelector('.connector-profile')"), "detail from catalog");
  if ((await fetch(abandonedFromCatalog)).status !== 400 || core.connectors.list().length) throw new Error("Opening details retained catalog authorization");
  await click(".connector-back");
  cases.push("catalog-direct-connect-blocked-popup-cancel-mobile-and-abandon");
  await evaluate("window.open=window.fixtureOriginalOpen");
  if (nativeShell) writeFileSync(browserMode, "complete");
  const exchanges = google.exchanges;
  await button("连接", rowConnect);
  await until(() => google.exchanges > exchanges, "catalog popup callback");
  await until(() => evaluate("document.querySelector('[data-connector=gmail]').textContent.includes('已添加')&&!document.querySelector('.connector-catalog-item > .gmail-connect')"), "catalog connected state");
  if (!await evaluate(onCatalog)) throw new Error("Catalog connection navigated away");
  if (core.connectors.list().length !== 1 || core.connectors.list()[0].grants.length) throw new Error("Catalog connection created extra records or grants");
  await screenshot("gmail-catalog-connected-direct-light");
  cases.push("catalog-direct-connect-completes-without-grants");
  if (exceptions.length) throw new Error("Renderer exceptions: " + exceptions.join(", "));
  const report = { passed: true, cases, googleExchanges: google.exchanges, mailRequests: google.requests.filter((request) => request.path.includes("/gmail/")).length, ...(nativeShell ? {} : { screenshots: output }) };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { console.error(error, logs.slice(-2000)); if (evaluate) console.error(await evaluate("({url:location.href,text:document.body.innerText.slice(0,2000)})").catch(() => "Page unavailable")); if (command) await screenshot("failure").catch(() => {}); throw error; }
finally {
  if (command && child && !exited) { await command("Browser.close").catch(() => {}); await until(() => exited, "renderer shutdown", 5000).catch(() => {}); }
  ws?.close();
  if (child && !exited) { if (process.platform === "win32") { const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); await new Promise((resolve) => killer.on("close", resolve)); } else child.kill("SIGTERM"); }
  await core.close(); await google.close(); await identity.close(); await model.close();
  if (path.dirname(root).toLowerCase() === os.tmpdir().toLowerCase() && path.basename(root).startsWith("nex-gmail-renderer-")) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { console.warn("Owned fixture retained for cleanup:", root); }
  }
}
