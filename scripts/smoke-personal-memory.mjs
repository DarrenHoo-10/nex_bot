// Production EXE, native Hindsight and CPU models; only synthetic data and a
// disposable profile. No fixture ML, no memory disable flag, no paid provider.
import { createServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";
const root = mkdtempSync(path.join(os.tmpdir(), "nex-exe-memory-")), profile = path.join(root, "profile"), output = path.join(root, "ready.json");
const executable = process.argv.find((arg) => arg.startsWith("--exe="))?.slice(6);
if (!executable) throw new Error("--exe is required");
const requests = [], factText = "合成测试项目雪鹭，每周星期二开会，使用中文交流。";
const provider = createServer((req, res) => { void (async () => {
  const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
  const prompt = body.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  const evidence = body.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
  const ids = [...new Set((evidence || prompt).match(/[0-9a-f]{8}-[0-9a-f-]{27}/gi) ?? [])];
  const schema = body.response_format?.json_schema?.schema;
  const consolidated = Boolean(schema?.properties?.creates) || /new facts/i.test(prompt) && /observations/i.test(prompt);
  const json = consolidated ? { creates: [{ text: "雪鹭每周星期二开会，偏好中文沟通。", source_fact_ids: ids, reason: "合成测试" }], updates: [], deletes: [] } : { facts: [{ what: factText, when: "每周星期二", where: "N/A", who: "合成项目雪鹭", why: "N/A", fact_type: "world", fact_kind: "conversation", entities: ["合成项目雪鹭"], occurred_start: null, occurred_end: null, causal_relations: null }] };
  const call = evidence ? { name: "done", arguments: { answer: "根据来源，雪鹭在每周星期二开会。", memory_ids: ids } } : { name: "recall", arguments: { query: "雪鹭开会时间", reason: "查找合成证据", max_tokens: 1500 } };
  const tools = Array.isArray(body.tools);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id: "synthetic-exe", model: "fixture", object: "chat.completion", choices: [{ index: 0, message: tools ? { role: "assistant", content: null, tool_calls: [{ id: "fixture-" + requests.length, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: "assistant", content: JSON.stringify(json) }, finish_reason: tools ? "tool_calls" : "stop" }], usage: { prompt_tokens: 50, completion_tokens: 25 } }));
})().catch(() => { res.writeHead(500); res.end(); }); });
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, NEX_SMOKE_OUTPUT: output };
const child = spawn(executable, [`--profile=${profile}`, "--port=0", "--remote-debugging-port=0"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let exited = false, logs = "", ws, seq = 0, ready;
const pending = new Map();
child.once("close", () => { exited = true; });
for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { logs = (logs + data.toString()).slice(-7000); });
async function until(check, timeout = 180000) { const deadline = Date.now() + timeout; while (!(await check())) { if (exited || Date.now() > deadline) throw new Error("Production memory fixture failed: " + logs); await new Promise((resolve) => setTimeout(resolve, 300)); } }
async function call(route, value) {
  const response = await fetch(`${ready.origin}/api/${route}`, { headers: { Authorization: `Bearer ${ready.token}`, "Content-Type": "application/json" }, ...(value ? { method: "POST", body: JSON.stringify(value) } : {}), signal: AbortSignal.timeout(125000) });
  const body = await response.json(); if (!response.ok) throw new Error(body.error); return body;
}
async function command(method, params) { const id = ++seq; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout")); }, 15000); pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; }
try {
  await until(() => existsSync(output) && existsSync(path.join(profile, "DevToolsActivePort")), executable.includes("Portable") ? 900000 : 60000); ready = JSON.parse(readFileSync(output, "utf8"));
  const initial = await call("state"); if (initial.bots.length || requests.length) throw new Error("Unexpected default Agent/model call");
  const port = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(), target = targets.find((item) => item.type === "page" && item.url.startsWith(ready.origin));
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve) => ws.once("open", resolve));
  ws.on("message", (raw) => { const event = JSON.parse(raw.toString()); if (event.id) { const callback = pending.get(event.id); pending.delete(event.id); if (event.error) callback?.reject(new Error(event.error.message)); else callback?.resolve(event.result); } });
  const bot = await call("bots", { name: "任意联系人" }), peer = await call("bots", { name: "隔离联系人" });
  await call("config", { provider: "openai", endpoint: `http://127.0.0.1:${provider.address().port}/v1`, model: "synthetic-model", apiKey: "synthetic-only-key" });
  await until(async () => (await call("state")).memoryEngine.service === "ready"); console.log("Packaged native service ready");
  const doc = await call("memory", { botId: bot.id, title: "合成会议偏好", content: factText });
  let recall;
  await until(async () => { const state = await call("state"); if (state.memoryEngine.failed) throw new Error("Native retention failed"); recall = await call("memory/recall", { botId: bot.id, query: "雪鹭什么时候开会" }); return recall.facts.some((fact) => fact.text.includes("星期二")); }, 90000);
  if ((await call("memory/recall", { botId: peer.id, query: "雪鹭开会" })).facts.length) throw new Error("Private memory crossed banks");
  await until(async () => (await call("memory/recall", { botId: bot.id, query: "雪鹭会议交流偏好" })).facts.some((fact) => fact.sourceClass === "synthesized" && fact.refs.length > 0), 60000);
  const ref = recall.facts[0].ref; if (!(await call("memory/expand", { botId: bot.id, ref })).content.includes("雪鹭")) throw new Error("Original source missing");
  console.log("Default native extraction and bank isolation passed");
  // Exercise the actual memory workbench, including source expansion and the
  // confirmation preview; paid transport is the loopback provider above.
  await until(() => evaluate("!!document.querySelector('.agents button')"));
  await evaluate("document.querySelector('.agents button').click();[...document.querySelectorAll('.inspector-tabs button')].find(b=>b.textContent==='记忆').click()");
  await until(() => evaluate("!!document.querySelector('.memory-workbench')"));
  await evaluate("(()=>{const input=document.querySelector('.memory-workbench input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'雪鹭什么时候开会');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await until(() => evaluate("!document.querySelector('.memory-workbench form button[type=button]').disabled"));
  await evaluate("document.querySelector('.memory-workbench form button[type=button]').click()");
  await until(() => evaluate("document.querySelector('.memory-workbench').innerText.includes('综合完成')"), 125000);
  if (!(await evaluate("document.querySelector('.memory-workbench').innerText.includes('星期二')"))) throw new Error("Synthesis missing answer");
  await evaluate("[...document.querySelectorAll('.memory-workbench article button')].find(b=>b.textContent==='来源 1').click()");
  await until(() => evaluate("document.querySelector('.memory-workbench').innerText.includes('使用中文交流')"));
  writeFileSync(path.resolve("release/personal-os/desktop-memory-smoke.png"), Buffer.from((await command("Page.captureScreenshot", { format: "png" })).data, "base64"));
  await evaluate("(()=>{const input=document.querySelector('.memory-workbench input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'雪鹭');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await until(() => evaluate("document.querySelector('.memory-workbench input').value==='雪鹭'"));
  await evaluate("[...document.querySelectorAll('.memory-workbench button')].find(b=>b.textContent==='预览遗忘范围').click()");
  await until(() => evaluate("!!document.querySelector('.memory-workbench .modal')"));
  if (!(await evaluate("(()=>{const shade=document.querySelector('.memory-workbench .modal-backdrop'),modal=shade?.querySelector('.modal'),r=modal?.getBoundingClientRect();return shade&&getComputedStyle(shade).position==='fixed'&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()"))) throw new Error("Forget preview is not a visible centered modal");
  writeFileSync(path.resolve("release/personal-os/desktop-forget-preview.png"), Buffer.from((await command("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const plan = await call("memory/forget-preview", { botId: bot.id, documentId: doc.documentId });
  if (plan.documents.length !== 1) throw new Error("Wrong forgetting preview");
  await evaluate("document.querySelector('.memory-workbench .modal .danger').click()");
  await until(async () => { const state = await call("state"); return state.memories.length === 0 && state.memoryEngine.forgetting === 0; }, 60000);
  if ((await call("memory/recall", { botId: bot.id, query: "雪鹭" })).facts.length) throw new Error("Forgotten data returned");
  const invoices = requests.length;
  await evaluate("void window.nex.quit(); true"); await until(() => exited, executable.includes("Portable") ? 180000 : 40000);
  const result = { passed: true, productionMemory: true, defaultExtraction: true, nativeObservationWithSource: true, privateIsolation: true, reflectWithSource: true, forgetViaRenderer: true, modelRequests: invoices, executable: path.basename(executable) };
  writeFileSync(path.resolve("release/personal-os/exe-memory-result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally {
  ws?.close();
  if (!exited && child.pid) { const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); await new Promise((resolve) => killer.once("close", resolve)); }
  await new Promise((resolve) => { provider.close(resolve); provider.closeAllConnections(); });
  if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("nex-exe-memory-")) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); }
    catch { console.warn("Owned fixture retained for diagnostics:", root); }
  }
}
