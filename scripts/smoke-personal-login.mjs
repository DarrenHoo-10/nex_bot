// Real Electron login/restart/logout in an owned profile, synthetic nex_user.
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { startFakeIdentity } from "../server/personal-os/testing/fake-identity.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "nex-login-desktop-fixture-")), profile = path.join(root, "profile"), readyFile = path.join(root, "ready.json");
const provider = await startFakeIdentity(), instances = [], cases = [];
const executable = process.argv.find((a) => a.startsWith("--exe="))?.slice(6);
let port = 0;
async function until(check, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Login desktop fixture timed out"); await new Promise((resolve) => setTimeout(resolve, 100)); }
}
async function launch() {
  for (const file of [readyFile, readyFile + ".shutdown.json", path.join(profile, "DevToolsActivePort")]) if (existsSync(file)) rmSync(file);
  const child = spawn(executable ?? path.resolve("dist-personal/electron/electron.exe"), [...(executable ? [] : [path.resolve("electron/nex-main.mjs")]), `--profile=${profile}`, `--port=${port}`, "--memory-fixture-disabled", "--remote-debugging-port=0"], {
    windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, NEX_SMOKE_OUTPUT: readyFile, NEX_IDENTITY_FIXTURE_URL: provider.origin }, stdio: ["ignore", "pipe", "pipe"]
  });
  const instance = { child, exited: false, ws: undefined, logs: "", sequence: 0, replies: new Map() }; instances.push(instance);
  child.stdout.on("data", (raw) => { instance.logs = (instance.logs + raw).slice(-4000); }); child.stderr.on("data", (raw) => { instance.logs = (instance.logs + raw).slice(-4000); }); child.once("close", () => { instance.exited = true; });
  await until(() => { if (instance.exited) throw new Error("Login fixture exited: " + instance.logs); return existsSync(readyFile) && existsSync(path.join(profile, "DevToolsActivePort")); }, 180_000);
  instance.ready = JSON.parse(readFileSync(readyFile, "utf8")); port = Number(new URL(instance.ready.origin).port);
  const debugPort = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
  const target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === "page" && t.url.startsWith(instance.ready.origin));
  if (!target) throw new Error("Login fixture renderer missing");
  instance.ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve) => instance.ws.once("open", resolve));
  instance.ws.on("message", (raw) => { const event = JSON.parse(raw.toString()), pending = instance.replies.get(event.id); if (!pending) return; instance.replies.delete(event.id); if (event.error) pending.reject(new Error(event.error.message)); else pending.resolve(event.result); });
  instance.command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++instance.sequence; const timer = setTimeout(() => { instance.replies.delete(id); reject(new Error("Login fixture command timeout: " + method)); }, 30_000); instance.replies.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } }); instance.ws.send(JSON.stringify({ id, method, params })); });
  instance.evaluate = async (expression) => { const result = await instance.command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  instance.quit = async () => { await instance.evaluate("void window.nex.quit();true"); await until(() => instance.exited, 65_000); if (!JSON.parse(readFileSync(readyFile + ".shutdown.json", "utf8")).graceful) throw new Error("Login Core did not shut down gracefully"); instance.ws.close(); };
  return instance;
}
async function submit(instance, password) {
  await instance.evaluate(`document.querySelector('[name=email]').value='owner@example.test';document.querySelector('[name=password]').value=${JSON.stringify(password)};document.querySelector('.login-form').requestSubmit();true`);
}
try {
  const first = await launch(); await until(() => first.evaluate("!!document.querySelector('.login-form')"));
  if (await first.evaluate("!!document.querySelector('.app')")) throw new Error("Business UI displayed without login");
  if ((await fetch(first.ready.origin + "/api/state", { headers: { Authorization: "Bearer " + first.ready.token } })).status !== 401) throw new Error("Bootstrap bypassed account login");
  const businessBlocked = await first.evaluate("window.nex.openData().then(()=>false,()=>true)"); if (!businessBlocked) throw new Error("Native data access bypassed login");
  cases.push("mandatory-renderer-gate", "mandatory-Core-gate", "native-IPC-gate");
  await submit(first, "wrong"); await until(() => first.evaluate("document.querySelector('.login-error')?.textContent.includes('密码')"));
  if (await first.evaluate("document.querySelector('[name=password]').value!==''||!!document.querySelector('.app')")) throw new Error("Password failure retained sensitive form/business UI");
  cases.push("wrong-password-feedback", "password-cleared");
  await submit(first, " synthetic password "); await until(() => first.evaluate("!!document.querySelector('.brand')"));
  const loginFile = path.join(profile, "account-session.bin"); if (!existsSync(loginFile) || readFileSync(loginFile).includes(Buffer.from(" synthetic password "))) throw new Error("Login credentials not safely persisted");
  const created = await first.evaluate("fetch('/api/bots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'合成持久联系人'})}).then(r=>r.json())"); if (!created.id) throw new Error("Signed-in API failed");
  const loginCookie = (await first.command("Network.getAllCookies")).cookies.find((c) => c.name === "nex").value;
  cases.push("first-owner-association", "DPAPI-login-storage", "signed-in-business-API");
  mkdirSync(path.resolve("release/personal-os"), { recursive: true });
  await first.quit();
  const second = await launch(); await until(() => second.evaluate("document.querySelector('.agents')?.textContent.includes('合成持久联系人')"));
  if (await second.evaluate("!!document.querySelector('.login-form')")) throw new Error("Valid saved login did not resume");
  cases.push("restart-login-restoration", "owner-data-preserved");
  await second.evaluate("[...document.querySelectorAll('nav button')].find(b=>b.textContent.includes('设置')).click();true");
  await until(() => second.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='退出登录')"));
  await second.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='退出登录').click();true");
  await until(() => second.evaluate("!!document.querySelector('.login-form')&&!document.querySelector('.app')"));
  if (existsSync(loginFile)) throw new Error("Logout retained saved credentials");
  if ((await fetch(second.ready.origin + "/api/state", { headers: { Authorization: "Bearer " + loginCookie } })).status !== 401) throw new Error("Logout kept Core token valid");
  if (provider.state.logoutCount < 1) throw new Error("Logout did not revoke upstream session");
  cases.push("logout-unmounts-private-UI", "logout-removes-saved-login", "local-and-upstream-revocation");
  writeFileSync(path.resolve("release/personal-os/login-smoke.png"), Buffer.from((await second.command("Page.captureScreenshot", { format: "png" })).data, "base64"));
  await second.quit();
  const third = await launch(); await until(() => third.evaluate("!!document.querySelector('.login-form')&&!document.querySelector('.app')"));
  await submit(third, " synthetic password "); await until(() => third.evaluate("document.querySelector('.agents')?.textContent.includes('合成持久联系人')"));
  await third.quit();
  for (const session of provider.sessions.values()) session.active = false;
  const fourth = await launch(); await until(() => fourth.evaluate("!!document.querySelector('.login-form')&&!document.querySelector('.app')"));
  if (existsSync(loginFile)) throw new Error("Invalid resumed account was saved again");
  await fourth.quit(); cases.push("logout-survives-restart", "relogin-preserves-data", "upstream-revocation-on-restart", "graceful-shutdown");
  const report = { passed: true, cases, packaged: !!executable };
  writeFileSync(path.resolve("release/personal-os/login-result.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally {
  for (const instance of instances) { instance.ws?.close(); if (!instance.exited && instance.child.pid) { const killer = spawn("taskkill.exe", ["/PID", String(instance.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); await new Promise((resolve) => killer.once("close", resolve)); } }
  await provider.close();
  if (path.dirname(root).toLowerCase() === os.tmpdir().toLowerCase() && path.basename(root).startsWith("nex-login-desktop-fixture-")) try { rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); } catch { console.warn("Owned login fixture retained:", root); }
}
