// Two real Electron clients, one disposable Core, synthetic model and data.
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { startFakeIdentity } from "../server/personal-os/testing/fake-identity.ts";
import { startFakeModel } from "../server/runtime/pi/p0/fake-model.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "nex-two-client-fixture-"));
const coreFile = path.resolve(process.argv.find((a) => a.startsWith("--core="))?.slice(7) ?? "dist-personal/server/core/index.js");
const ui = path.resolve(process.argv.find((a) => a.startsWith("--ui="))?.slice(5) ?? "dist-personal/server/ui");
const executable = process.argv.find((a) => a.startsWith("--exe="))?.slice(6);
const { createPersonalApp } = await import(pathToFileURL(coreFile).href);
const fake = await startFakeModel(), identityProvider = await startFakeIdentity();
let token = "synthetic-two-client-owner";
const core = await createPersonalApp({ dir: path.join(root, "core"), key: randomBytes(32), token, uiDir: ui, memoryRuntime: false, identity: { fixtureOrigin: identityProvider.origin } });
const clients = [], cases = [];
async function until(check, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw new Error("Two-client fixture timeout"); await new Promise((resolve) => setTimeout(resolve, 80)); }
}
async function call(route, data) {
  const response = await fetch(core.origin + "/api/" + route, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
}
async function launch(index) {
  const profile = path.join(root, `client-${index}`), ready = path.join(root, `ready-${index}.json`);
  const child = spawn(executable ?? path.resolve("dist-personal/electron", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron.exe"), [...(executable ? [] : [path.resolve("electron/nex-client-main.mjs")]), `--profile=${profile}`, "--remote-debugging-port=0"], { windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, NEX_CLIENT_SMOKE_OUTPUT: ready }, stdio: ["ignore", "pipe", "pipe"] });
  const client = { child, profile, ready, exited: false, ws: undefined, logs: "", sequence: 0, replies: new Map() }; clients.push(client);
  child.stdout.on("data", (value) => { client.logs = (client.logs + value.toString()).slice(-5000); }); child.stderr.on("data", (value) => { client.logs = (client.logs + value.toString()).slice(-5000); }); child.once("close", () => { client.exited = true; });
  try { await until(() => { if (client.exited) throw new Error("Client exited: " + client.logs); return existsSync(ready) && existsSync(path.join(profile, "DevToolsActivePort")); }, 180_000); }
  catch (error) { throw new Error(`${error.message}; bootstrap=${existsSync(ready)}, devtools=${existsSync(path.join(profile, "DevToolsActivePort"))}; ${client.logs}`); }
  const port = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(), target = targets.find((t) => t.type === "page");
  client.ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve) => client.ws.once("open", resolve));
  client.ws.on("message", (raw) => { const event = JSON.parse(raw.toString()), pending = client.replies.get(event.id); if (pending) { client.replies.delete(event.id); if (event.error) pending.reject(new Error(event.error.message)); else pending.resolve(event.result); } });
  client.command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++client.sequence; const timer = setTimeout(() => { client.replies.delete(id); reject(new Error("Client command timeout: " + method)); }, 30_000); client.replies.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } }); client.ws.send(JSON.stringify({ id, method, params })); });
  client.evaluate = async (expression) => { const result = await client.command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  if (index === 1) writeFileSync(path.resolve("release/personal-client/client-connection.png"), Buffer.from((await client.command("Page.captureScreenshot", { format: "png" })).data, "base64"));
  await client.evaluate(`document.getElementById('origin').value=${JSON.stringify(core.origin)};document.getElementById('name').value='合成客户端 ${index}';document.getElementById('email').value='owner@example.test';document.getElementById('password').value=' synthetic password ';document.querySelector('form').requestSubmit();true`);
  await until(async () => { const error = await client.evaluate("document.getElementById('error')?.textContent"); if (error) throw new Error("Client login: " + error); return client.evaluate("!!document.querySelector('.workspace-brand')"); });
  return client;
}
async function send(client, content) {
  await client.evaluate(`(()=>{const input=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(content)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(() => client.evaluate("!!document.querySelector('.send')&&!document.querySelector('.send').disabled"));
  await client.evaluate("document.querySelector('.composer').requestSubmit();true");
}
try {
  const bootstrap = await fetch(core.origin + '/api/session', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
  const cookie = bootstrap.headers.get('set-cookie').split(';',1)[0];
  const transaction = await (await fetch(core.origin + '/api/auth/start',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({account:'owner@example.test',name:'合成主设备'})})).json();
  const owner = await (await fetch(core.origin + '/api/auth/respond',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({...transaction,password:' synthetic password '})})).json();
  if(!owner.token) throw new Error('Synthetic owner association failed'); token = owner.token;
  const a = await launch(1), b = await launch(2);
  if ((await call("state")).bots.length) throw new Error("Default Agents seeded");
  await call("config", { provider: "openai", endpoint: fake.origin + "/v1", model: "fixture", apiKey: "synthetic-client-model" });
  const bot = await call("bots", { name: "合成个人助理", instructions: "" });
  for (const client of [a, b]) await until(() => client.evaluate("!!document.querySelector('.composer')&&document.querySelector('header').textContent.includes('合成个人助理')"));
  cases.push("independent-login", "zero-default-Agents", "shared-contact");
  fake.scripts.push({ kind: "openai-text", text: "合成双端消息已同步" });
  await send(a, "合成来自第一端的问候");
  for (const client of [a, b]) await until(() => client.evaluate("document.querySelector('.transcript')?.textContent.includes('合成双端消息已同步')"));
  cases.push("real-SDK-message-sync");
  await until(() => !core.runtime.workers.size);
  fake.scripts.push({ kind: "openai-tool", calls: [{ id: "client-chat-schedule", name: "broker", args: JSON.stringify({ action: "routine.save", name: "合成延迟问候", prompt: "合成主动问好", scheduleKind: "once", delaySeconds: 2 }) }] }, { kind: "openai-text", text: "合成定时问候已安排" }, { kind: "openai-text", text: "合成定时主动你好" });
  await send(b, "合成两秒后问好");
  for (const client of [a, b]) await until(() => client.evaluate("document.querySelector('.transcript')?.textContent.includes('合成定时主动你好')"));
  if ((await call("state")).approvals.length) throw new Error("Scheduling requested approval");
  cases.push("chat-scheduling", "shared-proactive-result");
  await until(() => !core.runtime.workers.size);
  const note = await call("memory", { botId: bot.id, title: "合成审批记忆", content: "合成双端撤回测试", scope: "bot" });
  fake.scripts.push({ kind: "openai-tool", calls: [{ id: "two-client-danger", name: "broker", args: JSON.stringify({ action: "memory.delete", documentId: note.documentId, expectedVersion: note.version }) }] }, { kind: "openai-text", text: "合成记忆已获批撤回" });
  await send(b, "合成撤回自己的一条记忆");
  for (const client of [a, b]) await until(() => client.evaluate("document.querySelector('.approval')?.textContent.includes('需要你的批准')"));
  await a.evaluate("document.querySelector('.approval .primary').click();true");
  for (const client of [a, b]) await until(() => client.evaluate("!!document.querySelector('.transcript')&&!document.querySelector('.approval')&&document.querySelector('.transcript').textContent.includes('合成记忆已获批撤回')"));
  if (core.store.get("SELECT status FROM memory_documents WHERE id=?", note.documentId)?.status !== "deleted") throw new Error("Approved withdrawal was not committed");
  const decided = core.store.get("SELECT decided_by_session_id FROM approvals WHERE tool_call_id IN (SELECT id FROM tool_calls WHERE provider_tool_call_id='two-client-danger')");
  if (decided?.decided_by_session_id !== (await call("clients")).sessions.find((s) => s.name === "合成客户端 1").session_id) throw new Error("Approval did not record actual client session");
  cases.push("two-client-approval-sync", "actual-deciding-session");
  await b.command("Network.enable");
  await b.command("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await until(() => b.evaluate("!document.querySelector('.transcript')"));
  for (let i = 0; i < 450; i++) core.agents.publish(bot.id, "assistant", "message", `合成断线补齐 ${i}`, `two-client:${i}`);
  await b.command("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await until(() => b.evaluate("document.querySelector('.transcript')?.textContent.includes('合成断线补齐 449')"));
  // Initial reconnect is a snapshot; loading earlier pages must preserve them
  // on subsequent incremental refreshes rather than dropping the cached page.
  for (let i = 0; i < 4; i++) { await b.evaluate("document.querySelector('.older')?.click();true"); await new Promise((resolve) => setTimeout(resolve, 400)); }
  await until(() => b.evaluate("document.querySelector('.transcript')?.textContent.includes('合成双端消息已同步')"));
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (!await b.evaluate("document.querySelector('.transcript').textContent.includes('合成双端消息已同步')")) throw new Error("History cache lost on refresh");
  cases.push("offline-cache-clearing", "large-reconnect-gap", "history-pages-preserved");
  const plan = await call("memory/forget-preview", { botId: bot.id, query: "合成来自第一端的问候" });
  await call("memory/forget", { botId: bot.id, query: "合成来自第一端的问候", revision: plan.revision });
  for (const client of [a, b]) await until(() => client.evaluate("!!document.querySelector('.transcript')&&!document.body.textContent.includes('合成双端消息已同步')&&!document.body.textContent.includes('合成来自第一端的问候')"));
  cases.push("two-client-privacy-invalidation");
  const sessions = await call("clients");
  const first = sessions.sessions.find((s) => s.name === "合成客户端 1");
  await call("clients/revoke", { sessionId: first.session_id });
  await until(() => a.evaluate("!document.querySelector('.transcript')"));
  if (!await b.evaluate("!!document.querySelector('.transcript')")) throw new Error("Revoking one client disabled the other");
  cases.push("independent-session-revocation");
  writeFileSync(path.resolve("release/personal-client/client-contact.png"), Buffer.from((await b.command("Page.captureScreenshot", { format: "png" })).data, "base64"));
  await b.evaluate("document.querySelector('.workspace-account-name').click();true");
  await until(() => b.evaluate("!!document.querySelector('.account-menu')"));
  await b.evaluate("[...document.querySelectorAll('.account-menu button')].find(b=>b.textContent.includes('设置')).click();true");
  await until(() => b.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='退出登录')"));
  if (await b.evaluate("typeof window.nex.configureNode !== 'undefined'||typeof window.nex.nodeState !== 'undefined'")) throw new Error("Shell exposes local device execution");
  await b.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='退出登录').click();true");
  await until(() => b.evaluate("!!document.getElementById('connection')&&!document.querySelector('.workspace-brand')"));
  if (existsSync(path.join(b.profile,'connection.bin'))) throw new Error('Client logout retained login credentials');
  cases.push('client-account-logout','shell-has-no-device-executor');
  for (const client of clients) {
    if (existsSync(path.join(client.profile, "personal-os", "core.db")) || existsSync(path.join(client.profile, "memory")) || existsSync(path.join(client.profile, "device")) || existsSync(path.join(client.profile, "device-key.bin"))) throw new Error("Thin client created Core or memory database");
    await client.evaluate("void window.nex.quit();true");
    await until(() => client.exited, 60_000);
  }
  if ((await call("state")).bots.length !== 1) throw new Error("Client exit stopped primary Core");
  cases.push("no-client-memory-service", "client-exit-preserves-Core");
  const report = { passed: true, cases, packagedClient: !!executable, coreBundle: coreFile, modelRequests: fake.requests.length };
  const output = path.resolve(process.argv.find((a) => a.startsWith("--output="))?.slice(9) ?? "release/personal-os/two-client-result.json");
  writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally {
  for (const client of clients) {
    client.ws?.close();
    if (!client.exited && client.child.pid) { if (process.platform === "win32") { const killer = spawn("taskkill.exe", ["/PID", String(client.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); await new Promise((resolve) => killer.once("close", resolve)); } else client.child.kill("SIGTERM"); }
  }
  await core.close(); await fake.close(); await identityProvider.close();
  if (path.dirname(root).toLowerCase() === os.tmpdir().toLowerCase() && path.basename(root).startsWith("nex-two-client-fixture-")) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); } catch { console.warn("Owned two-client fixture retained:", root); }
  }
}
