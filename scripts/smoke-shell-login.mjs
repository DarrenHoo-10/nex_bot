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
const accountWorkspaces = process.argv.includes("--account-workspaces");
const bundle = await import(pathToFileURL(path.resolve(`dist-personal/server/core/${accountWorkspaces ? "workspaces" : "index"}.js`)).href);
const createPersonalApp = accountWorkspaces ? bundle.createWorkspaceService : bundle.createPersonalApp;
let core = await createPersonalApp({ dir: path.join(root, "core"), key, token: "synthetic-bootstrap", uiDir: path.resolve(process.argv.find(arg => arg.startsWith("--ui-dir="))?.slice(9) ?? "dist-personal/server/ui"), identity: { fixtureOrigin: provider.origin } });
const operator = core.store.get("SELECT * FROM user_sessions WHERE id=?", core.store.session);
const transaction = core.identity.start({ account: "owner@example.test", name: "Service initialization" }, operator);
const initial = await core.identity.respond({ ...transaction, password: " synthetic password " }, operator); await core.identity.logout(initial.token);
const executable = process.argv.find((arg) => arg.startsWith("--exe="))?.slice(6);
async function until(check, timeout = 30_000) { const end = Date.now() + timeout; const ready = async () => { try { return await check(); } catch (error) { if (/Inspected target navigated|Execution context was destroyed|Cannot find context/.test(error.message)) return false; throw error; } }; while (!await ready()) { if (Date.now() > end) throw new Error("Shell login fixture timed out"); await new Promise((resolve) => setTimeout(resolve, 80)); } }
async function launch() {
  for (const file of [readyFile, path.join(profile, "DevToolsActivePort")]) if (existsSync(file)) rmSync(file);
  const child = spawn(executable ?? path.resolve("dist-personal/electron", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron.exe"), [...(executable ? [] : [path.resolve("electron/nex-client-main.mjs")]), `--profile=${profile}`, "--remote-debugging-port=0"], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, NEX_CLIENT_SMOKE_OUTPUT: readyFile }, stdio: ["ignore", "pipe", "pipe"]
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
try {
  const first = await launch(); await until(() => first.evaluate("!!document.querySelector('#connection')"));
  if (process.argv.includes("--expect-local-ui")) {
    await until(() => first.evaluate("document.body.classList.contains('ready')"));
    if (await first.evaluate("/后端|高级/.test(document.body.innerText)||document.querySelector('#origin').type!=='hidden'")) throw new Error("Login still exposes connection settings");
    if (!await first.evaluate("document.querySelector('h1').textContent==='登录 NexBot'&&document.querySelector('#name').type==='hidden'&&document.querySelector('.login-signup').textContent==='没有账号？去注册'&&getComputedStyle(document.querySelector('#connect')).backgroundColor==='rgb(53, 105, 232)'")) throw new Error("Shell login does not match the new design");
    mkdirSync(path.resolve("release/personal-client-mac"), { recursive: true });
    writeFileSync(path.resolve("release/personal-client-mac/shell-login.png"), Buffer.from((await first.command("Page.captureScreenshot", { format: "png" })).data, "base64"));
  }
  if (await first.evaluate("!!document.querySelector('.workspace-brand')||typeof window.nex.configureNode!=='undefined'")) throw new Error("Shell exposes business/device state without login");
  if (!await first.evaluate("window.nex.deviceState().then(s=>s.available===false&&!s.deviceId,()=>true)")) throw new Error("Unauthenticated renderer can inspect device state");
  await login(first, "wrong"); await until(() => first.evaluate("document.querySelector('#error').textContent.includes('密码')&&document.querySelector('#password').value===''"));
  if (existsSync(path.join(profile, "connection.bin"))) throw new Error("Failed login was persisted");
  cases.push("mandatory-shell-login", "no-unauthenticated-device-access", "wrong-password-cleared");
  await login(first, " synthetic password "); await until(() => first.evaluate("!!document.querySelector('.workspace-brand')"));
  await until(() => first.evaluate("window.nex.deviceState().then(s=>s.connected&&!!s.deviceId)"));
  const localDevice = await first.evaluate("window.nex.deviceState()");
  if (!localDevice.authorized || !localDevice.exec || !localDevice.root || localDevice.token) throw new Error("Login did not enable control or secret exposed");
  const firstDeviceId = localDevice.deviceId;
  cases.push("authenticated-device-auto-connect-without-prompt");
  if (process.argv.includes("--expect-local-ui")) {
    if (!await first.evaluate("document.querySelector('meta[name=nexbot-ui-source]')?.content==='local'")) throw new Error("Client did not load its local UI");
    const remoteHtml = await (await fetch(core.origin)).text();
    if (remoteHtml.includes('name="nexbot-ui-source"')) throw new Error("Fixture Core unexpectedly serves local UI marker");
    if (!await first.evaluate("fetch('/health').then(r=>r.json()).then(v=>v.app==='NexBot')")) throw new Error("Local UI did not forward backend requests");
    if (!await first.evaluate("document.title==='NexBot'")) throw new Error("Window title is not NexBot");
    cases.push("local-ui-with-remote-api");
    await first.evaluate("document.querySelector('.workspace-account-name').click();true");
    await first.evaluate("[...document.querySelectorAll('.account-menu button')].find(el=>el.textContent==='设置').click();true");
    await first.evaluate("[...document.querySelectorAll('.preferences-nav button')].find(el=>el.textContent==='模型').click();true");
    await first.evaluate(`(()=>{for(const [name,value] of [['endpoint',${JSON.stringify(catalogModel.origin + '/v1')}],['apiKey','synthetic-catalog-key']]){const el=document.querySelector('input[name='+name+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
    await first.evaluate("document.querySelector('[aria-label=默认模型]').click()");
    await first.evaluate("(()=>{const el=document.querySelector('.model-picker-popover input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'fixture-model');el.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await until(() => first.evaluate("document.querySelector('.model-picker-popover input')?.value==='fixture-model'"));
    await until(() => first.evaluate("[...document.querySelectorAll('.model-picker-popover [role=option]')].some(el=>el.textContent.includes('fixture-model'))"));
    await first.evaluate("[...document.querySelectorAll('.model-picker-popover [role=option]')].find(el=>el.textContent.includes('fixture-model')).click()");
    await until(() => first.evaluate("document.querySelector('input[name=model]')?.value==='fixture-model'&&!document.querySelector('[data-model-settings] button[type=submit]').disabled"));
    if (!await first.evaluate("document.querySelector('input[name=apiKey]').type==='password'")) throw new Error("Key was not masked by default");
    await first.evaluate("document.querySelector('button[aria-label=\"显示 API Key\"]').click();true");
    if (!await first.evaluate("document.querySelector('input[name=apiKey]').type==='text'&&document.querySelector('input[name=apiKey]').value==='synthetic-catalog-key'")) throw new Error("Key reveal failed");
    await first.evaluate("document.querySelector('button[aria-label=\"隐藏 API Key\"]').click();true");
    if (!await first.evaluate("document.querySelector('input[name=apiKey]').type==='password'")) throw new Error("Key hide failed");
    await first.evaluate("document.querySelector('button[aria-label=\"显示 API Key\"]').click();document.querySelector('[data-model-settings] form').requestSubmit();true");
    await until(() => first.evaluate("!!document.querySelector('.preferences-saved')"));
    if (!await first.evaluate("document.querySelector('input[name=apiKey]').type==='password'&&document.querySelector('input[name=apiKey]').value==='synthetic-catalog-key'")) throw new Error("Save cleared the entered key or left it exposed");
    // Simulate the deployed Core that does not yet offer saved-key discovery.
    await first.evaluate("window.fixtureFetch=window.fetch;window.fetch=(url,options)=>url==='/api/models/list'?Promise.resolve(new Response('{}',{status:404})):window.fixtureFetch(url,options);true");
    await first.evaluate("[...document.querySelectorAll('[data-model-settings] button')].find(el=>el.textContent==='获取模型列表').click();true");
    await until(() => first.evaluate("document.querySelector('[data-model-settings] [role=status]')?.textContent.includes('已获取')"));
    await first.evaluate("document.querySelector('[aria-label=默认模型]').click()");
    await until(() => first.evaluate("document.querySelector('.model-picker-popover')?.textContent.includes('fixture-reasoning')"));
    await first.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await first.evaluate("window.fetch=window.fixtureFetch;delete window.fixtureFetch;true");
    await first.evaluate("document.querySelector('button[aria-label=\"显示 API Key\"]').click();[...document.querySelectorAll('.preferences-nav button')].find(el=>el.textContent==='长期记忆').click();true");
    await first.evaluate("[...document.querySelectorAll('.preferences-nav button')].find(el=>el.textContent==='模型').click();true");
    if (!await first.evaluate("document.querySelector('input[name=apiKey]').type==='password'&&document.querySelector('input[name=apiKey]').value==='synthetic-catalog-key'")) throw new Error("Category navigation exposed or lost the key");
    await first.evaluate("(()=>{const el=document.querySelector('input[name=endpoint]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'https://other.example.test/v1');el.dispatchEvent(new Event('input',{bubbles:true}));})()");
    if (!await first.evaluate("document.querySelector('input[name=apiKey]').value===''")) throw new Error("Endpoint change retained another provider's key");
    cases.push("key-reveal-hide", "save-then-discover-on-older-core", "key-remasked-on-navigation", "key-cleared-for-new-endpoint");
    if (await first.evaluate("/个人工作空间|系统信息|高级设置|后端连接/.test(document.body.innerText)")) throw new Error("Removed descriptions remain visible");
    cases.push("native-model-discovery-in-settings");
  }
  const saved = path.join(profile, "connection.bin");
  if (!existsSync(saved) || readFileSync(saved).includes(Buffer.from(" synthetic password "))) throw new Error("Shell persisted a password");
  await first.evaluate("fetch('/api/bots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'独立后端联系人'})}).then(r=>r.json())");
  const cookie = (await first.command("Network.getAllCookies")).cookies.find((item) => item.name === "nex").value;
  await first.quit(); if (!(await fetch(core.origin + "/health")).ok) throw new Error("Shell exit stopped backend");
  const second = await launch(); await until(() => second.evaluate("document.querySelector('.contact-groups')?.textContent.includes('独立后端联系人')"));
  await until(() => second.evaluate("window.nex.deviceState().then(s=>s.connected)"));
  if ((await second.evaluate("window.nex.deviceState()")).deviceId !== firstDeviceId) throw new Error("Restart created duplicate device");
  cases.push("device-identity-survives-restart");
  cases.push("encrypted-login-storage", "shell-restart-restores-login", "client-exit-keeps-backend");
  await second.evaluate("document.querySelector('.workspace-account-name').click();true");
  await until(() => second.evaluate("!!document.querySelector('.account-menu')"));
  await second.evaluate("[...document.querySelectorAll('.account-menu button')].find(button=>button.textContent.includes('设置')).click();true");
  await until(() => second.evaluate("!!document.querySelector('[data-memory-dashboard]')"));
  await second.evaluate("[...document.querySelectorAll('.preferences-nav button')].find(button=>button.textContent==='设备').click();true");
  await until(() => second.evaluate("document.querySelector('.local-device')?.textContent.includes('在线')"));
  if (await second.evaluate("/生成配对令牌|文件读取|选择文件夹|终端与文件操作|开启所需能力/.test(document.querySelector('.ds-settings-page').textContent)")) throw new Error("Removed device controls remain");
  await second.evaluate("document.querySelector('.local-device button').click();true");
  await until(() => second.evaluate("document.querySelector('.local-device')?.textContent.includes('已暂停')"));
  await second.evaluate("document.querySelector('.local-device button').click();true");
  await until(() => second.evaluate("document.querySelector('.local-device')?.textContent.includes('在线')"));
  for (const [name, age] of [["示例笔记本", 0], ["示例 Mac", 180_000]]) {
    const transaction = core.identity.start({ account: "owner@example.test", name }, operator);
    const session = await core.identity.respond({ ...transaction, password: " synthetic password " }, operator);
    core.store.run("UPDATE client_sessions SET last_seen_at=? WHERE session_id=?", Date.now() - age, session.sessionId);
  }
  await until(() => second.evaluate("document.querySelector('.signed-in-devices')?.textContent.includes('示例 Mac')"));
  if (!await second.evaluate("(()=>{const rows=[...document.querySelectorAll('.signed-in-device')];return rows.length===3&&rows.filter(r=>r.textContent.includes('本设备')).length===1&&rows.find(r=>r.textContent.includes('示例 Mac')).textContent.includes('离线')&&rows.find(r=>r.textContent.includes('示例笔记本')).textContent.includes('在线')})()")) throw new Error("Login device list/presence/current marker mismatch");
  cases.push("login-device-list-presence-without-executor-records");
  mkdirSync(path.resolve("release/client-executor-verification"), { recursive: true });
  await second.evaluate("document.activeElement?.blur();new Promise(resolve=>setTimeout(resolve,250))");
  writeFileSync(path.resolve("release/client-executor-verification/devices-local-light.png"), Buffer.from((await second.command("Page.captureScreenshot", { format: "png" })).data, "base64"));
  cases.push("local-device-settings-visible");
  for (const [name, file] of [["账号与登录设备", "settings-account-light.png"], ["模型", "settings-model-light.png"], ["长期记忆", "settings-memory-light.png"]]) {
    await second.evaluate(`[...document.querySelectorAll('.preferences-nav button')].find(button=>button.textContent===${JSON.stringify(name)}).click();true`);
    await until(() => second.evaluate(`document.querySelector('.preferences-panel:not([hidden])')?.getAttribute('aria-label')===${JSON.stringify(name)}`));
    if (await second.evaluate("/管理你的账号|管理个人身份|NexorAI 账号 · 已认证|移除不再使用|选择助手使用|通常以|密钥将加密|让助手在后续|将记忆来源|填写后端能够|模型调用与费用/.test(document.querySelector('.preferences-panel:not([hidden])').textContent)")) throw new Error("Removed settings copy remains");
    await second.evaluate("document.activeElement?.blur();new Promise(resolve=>setTimeout(resolve,250))");
    writeFileSync(path.resolve("release/client-executor-verification", file), Buffer.from((await second.command("Page.captureScreenshot", { format: "png" })).data, "base64"));
  }
  cases.push("minimal-settings-copy");
  await second.evaluate("[...document.querySelectorAll('.preferences-nav button')].find(button=>button.textContent==='长期记忆').click();true");
  await until(() => second.evaluate("!!document.querySelector('input[name=personalMemoryEnabled]:not(:disabled)')"));
  if (!await second.evaluate("document.querySelectorAll('[data-memory-dashboard] input[type=checkbox]').length===1&&!!document.querySelector('[data-memory-total]')&&!document.querySelector('[data-memory-plugin]')")) throw new Error("Memory settings must show only one switch and total tokens");
  mkdirSync(path.resolve("release/personal-client-mac"), { recursive: true });
  writeFileSync(path.resolve("release/personal-client-mac/shell-settings.png"), Buffer.from((await second.command("Page.captureScreenshot", { format: "png" })).data, "base64"));
  await second.evaluate("[...document.querySelectorAll('.preferences-nav button')].find(button=>button.textContent==='账号与登录设备').click();true");
  await second.evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='退出登录').click();true");
  await until(() => second.evaluate("!!document.querySelector('.account-logout-modal[open]')"));
  await second.evaluate("[...document.querySelectorAll('.account-logout-modal button')].find(button=>button.textContent==='取消').click();true");
  if (!await second.evaluate("!!document.querySelector('.workspace-brand')&&!document.querySelector('.account-logout-modal')")) throw new Error("Logout cancellation changed session");
  await second.evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='退出登录').click();true");
  await until(() => second.evaluate("!!document.querySelector('.account-logout-modal[open]')"));
  await second.evaluate("document.querySelector('.account-logout-modal .primary').click();true");
  await until(() => second.evaluate("!!document.querySelector('#connection')&&!document.querySelector('.workspace-brand')"));
  if (second.webLoginFrames) throw new Error("Logout flashed a second login form");
  await new Promise(resolve => setTimeout(resolve, 31_000));
  if (!await second.evaluate("!!document.querySelector('#connection')&&document.querySelector('h1').textContent==='登录 NexBot'")) throw new Error("Idle login changed after refresh interval");
  cases.push("styled-logout-cancel-confirm", "no-intermediate-web-login", "idle-login-stable-after-refresh-interval");
  if (existsSync(saved) || (await fetch(core.origin + "/api/state", { headers: { Authorization: "Bearer " + cookie } })).status !== 401) throw new Error("Logout retained access");
  await second.quit(); cases.push("unified-memory-settings-visible", "logout-clears-shell-and-Core-session");
  const third = await launch(); await until(() => third.evaluate("!!document.querySelector('#connection')")); await login(third, " synthetic password "); await until(() => third.evaluate("document.querySelector('.contact-groups')?.textContent.includes('独立后端联系人')"));
  await third.evaluate("fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(()=>document.dispatchEvent(new Event('visibilitychange')))").catch(error => { if (!/Inspected target navigated|Execution context was destroyed/.test(error.message)) throw error; });
  await until(() => third.evaluate("!!document.querySelector('#connection')&&document.querySelector('h1').textContent==='登录 NexBot'"));
  if (third.webLoginFrames || existsSync(saved)) throw new Error("Expired session showed web login or kept saved login");
  cases.push("active-session-expiry-uses-canonical-login");
  await login(third, " synthetic password "); await until(() => third.evaluate("!!document.querySelector('.workspace-brand')")); await third.quit();
  const port = Number(new URL(core.origin).port); await core.close();
  for (const session of provider.sessions.values()) session.active = false;
  core = await createPersonalApp({ dir: path.join(root, "core"), key, port, token: "synthetic-bootstrap", uiDir: path.resolve(process.argv.find(arg => arg.startsWith("--ui-dir="))?.slice(9) ?? "dist-personal/server/ui"), identity: { fixtureOrigin: provider.origin } });
  const fourth = await launch(); await until(() => fourth.evaluate("!!document.querySelector('#connection')&&document.querySelector('#error').textContent.length>0"));
  if (existsSync(saved)) throw new Error("Invalid resumed token retained"); await fourth.quit();
  for (const file of ["personal-os", "core.db", "memory"]) if (existsSync(path.join(profile, file))) throw new Error("Thin shell created backend state: " + file);
  cases.push("relogin-preserves-backend-data", "upstream-revocation-on-restart", "no-local-Agent-or-Core-database");
  if (accountWorkspaces) {
    const fifth = await launch(); await until(() => fifth.evaluate("!!document.querySelector('#connection')"));
    await login(fifth, " synthetic password ", "other@example.test");
    await until(() => fifth.evaluate("!!document.querySelector('.workspace-brand')"));
    await until(() => fifth.evaluate("window.nex.deviceState().then(s=>s.connected)"));
    if ((await fifth.evaluate("window.nex.deviceState()")).deviceId === firstDeviceId) throw new Error("Device binding leaked across accounts");
    if (await fifth.evaluate("document.querySelector('.contact-groups').textContent.includes('独立后端联系人')")) throw new Error("New account inherited previous owner's contacts");
    await fifth.evaluate("fetch('/api/bots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'第二账号私有联系人'})}).then(r=>r.json())");
    await until(() => fifth.evaluate("document.querySelector('.contact-groups').textContent.includes('第二账号私有联系人')"));
    await fifth.quit();
    const sixth = await launch();
    await until(() => sixth.evaluate("document.querySelector('.contact-groups')?.textContent.includes('第二账号私有联系人')"));
    await sixth.evaluate("document.querySelector('.workspace-account-name').click();true");
    await until(() => sixth.evaluate("!!document.querySelector('.account-menu')"));
    await sixth.evaluate("[...document.querySelectorAll('.account-menu button')].find(button=>button.textContent.includes('设置')).click();true");
    await until(() => sixth.evaluate("[...document.querySelectorAll('button')].some(button=>button.textContent==='退出登录')"));
    await sixth.evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='退出登录').click();true");
    await until(() => sixth.evaluate("!!document.querySelector('.account-logout-modal[open]')"));
    await sixth.evaluate("document.querySelector('.account-logout-modal .primary').click();true");
    await until(() => sixth.evaluate("!!document.querySelector('#connection')"));
    await login(sixth, " synthetic password ");
    await until(() => sixth.evaluate("document.querySelector('.contact-groups')?.textContent.includes('独立后端联系人')"));
    if (await sixth.evaluate("document.querySelector('.contact-groups').textContent.includes('第二账号私有联系人')")) throw new Error("Switching accounts leaked contacts");
    await sixth.quit();
    cases.push("new-account-empty-workspace", "second-account-restart", "account-switch-isolation", "legacy-owner-contacts-preserved");
  }
  console.log(JSON.stringify({ passed: true, cases, packaged: !!executable, accountWorkspaces }));
} catch (error) { console.error("Completed shell checks:", cases); console.error(await instances.at(-1)?.evaluate("({text:document.body.innerText,model:document.querySelector('input[name=model]')?.value,endpoint:document.querySelector('input[name=endpoint]')?.value})").catch(()=>null)); throw error; } finally {
  for (const instance of instances) { instance.ws?.close(); if (!instance.exited) { instance.child.kill("SIGTERM"); await until(() => instance.exited).catch(() => instance.child.kill("SIGKILL")); } }
  await core.close(); await provider.close(); await catalogModel.close(); try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { console.warn("Owned fixture retained for cleanup:", root); }
}
