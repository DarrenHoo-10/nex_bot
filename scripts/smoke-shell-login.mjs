// Real thin shell; Core and identity are independent disposable services.
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { pathToFileURL } from "node:url";
import { startFakeIdentity } from "../server/personal-os/testing/fake-identity.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "nex-shell-login-fixture-")), profile = path.join(root, "profile"), readyFile = path.join(root, "ready.json");
const provider = await startFakeIdentity(), instances = [], cases = [], key = randomBytes(32);
const { createPersonalApp } = await import(pathToFileURL(path.resolve("dist-personal/server/core/index.js")).href);
let core = await createPersonalApp({ dir: path.join(root, "core"), key, token: "synthetic-bootstrap", uiDir: path.resolve("dist-personal/server/ui"), identity: { fixtureOrigin: provider.origin } });
const operator = core.store.get("SELECT * FROM user_sessions WHERE id=?", core.store.session);
const transaction = core.identity.start({ account: "owner@example.test", name: "Service initialization" }, operator);
const initial = await core.identity.respond({ ...transaction, password: " synthetic password " }, operator); await core.identity.logout(initial.token);
const executable = process.argv.find((arg) => arg.startsWith("--exe="))?.slice(6);
async function until(check, timeout = 30_000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error("Shell login fixture timed out"); await new Promise((resolve) => setTimeout(resolve, 80)); } }
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
  instance.ws.on("message", (raw) => { const event = JSON.parse(raw.toString()), pending = instance.replies.get(event.id); if (!pending) return; instance.replies.delete(event.id); if (event.error) pending.reject(new Error(event.error.message)); else pending.resolve(event.result); });
  instance.command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++instance.sequence; const timer = setTimeout(() => { instance.replies.delete(id); reject(new Error("Shell command timed out")); }, 30_000); instance.replies.set(id, { resolve: (result) => { clearTimeout(timer); resolve(result); }, reject: (error) => { clearTimeout(timer); reject(error); } }); instance.ws.send(JSON.stringify({ id, method, params })); });
  instance.evaluate = async (expression) => { const result = await instance.command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  instance.quit = async () => { await instance.evaluate("void window.nex.quit();true"); await until(() => instance.exited); instance.ws.close(); };
  return instance;
}
async function login(instance, password) {
  await instance.evaluate(`document.querySelector('#origin').value=${JSON.stringify(core.origin)};document.querySelector('#email').value='owner@example.test';document.querySelector('#password').value=${JSON.stringify(password)};document.querySelector('#connection').requestSubmit();true`);
}
try {
  const first = await launch(); await until(() => first.evaluate("!!document.querySelector('#connection')"));
  if (await first.evaluate("!!document.querySelector('.brand')||typeof window.nex.configureNode!=='undefined'")) throw new Error("Shell exposes business/device state without login");
  await login(first, "wrong"); await until(() => first.evaluate("document.querySelector('#error').textContent.includes('密码')&&document.querySelector('#password').value===''"));
  if (existsSync(path.join(profile, "connection.bin"))) throw new Error("Failed login was persisted");
  cases.push("mandatory-shell-login", "no-local-device-bridge", "wrong-password-cleared");
  await login(first, " synthetic password "); await until(() => first.evaluate("!!document.querySelector('.brand')"));
  const saved = path.join(profile, "connection.bin");
  if (!existsSync(saved) || readFileSync(saved).includes(Buffer.from(" synthetic password "))) throw new Error("Shell persisted a password");
  await first.evaluate("fetch('/api/bots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'独立后端联系人'})}).then(r=>r.json())");
  const cookie = (await first.command("Network.getAllCookies")).cookies.find((item) => item.name === "nex").value;
  await first.quit(); if (!(await fetch(core.origin + "/health")).ok) throw new Error("Shell exit stopped backend");
  const second = await launch(); await until(() => second.evaluate("document.querySelector('.agents')?.textContent.includes('独立后端联系人')"));
  cases.push("encrypted-login-storage", "shell-restart-restores-login", "client-exit-keeps-backend");
  await second.evaluate("[...document.querySelectorAll('nav button')].find(button=>button.textContent.includes('设置')).click();true");
  await until(() => second.evaluate("!!document.querySelector('[data-memory-plugin]')"));
  if (!await second.evaluate("document.querySelector('[data-memory-plugin]').textContent.includes('后端')")) throw new Error("Plugin configuration is missing from thin shell");
  mkdirSync(path.resolve("release/personal-client-mac"), { recursive: true });
  writeFileSync(path.resolve("release/personal-client-mac/shell-settings.png"), Buffer.from((await second.command("Page.captureScreenshot", { format: "png" })).data, "base64"));
  await second.evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='退出登录').click();true");
  await until(() => second.evaluate("!!document.querySelector('#connection')&&!document.querySelector('.brand')"));
  if (existsSync(saved) || (await fetch(core.origin + "/api/state", { headers: { Authorization: "Bearer " + cookie } })).status !== 401) throw new Error("Logout retained access");
  await second.quit(); cases.push("backend-plugin-settings-visible", "logout-clears-shell-and-Core-session");
  const third = await launch(); await until(() => third.evaluate("!!document.querySelector('#connection')")); await login(third, " synthetic password "); await until(() => third.evaluate("document.querySelector('.agents')?.textContent.includes('独立后端联系人')")); await third.quit();
  const port = Number(new URL(core.origin).port); await core.close();
  for (const session of provider.sessions.values()) session.active = false;
  core = await createPersonalApp({ dir: path.join(root, "core"), key, port, token: "synthetic-bootstrap", uiDir: path.resolve("dist-personal/server/ui"), identity: { fixtureOrigin: provider.origin } });
  const fourth = await launch(); await until(() => fourth.evaluate("!!document.querySelector('#connection')&&document.querySelector('#error').textContent.length>0"));
  if (existsSync(saved)) throw new Error("Invalid resumed token retained"); await fourth.quit();
  for (const file of ["device", "device-key.bin", "personal-os", "core.db", "memory"]) if (existsSync(path.join(profile, file))) throw new Error("Thin shell created backend state: " + file);
  cases.push("relogin-preserves-backend-data", "upstream-revocation-on-restart", "no-client-databases-or-runtime");
  console.log(JSON.stringify({ passed: true, cases, packaged: !!executable }));
} finally {
  for (const instance of instances) { instance.ws?.close(); if (!instance.exited) { instance.child.kill("SIGTERM"); await until(() => instance.exited).catch(() => instance.child.kill("SIGKILL")); } }
  await core.close(); await provider.close(); rmSync(root, { recursive: true, force: true });
}
