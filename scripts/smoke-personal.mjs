// Production bundle + real Electron renderer, always disposable profiles and
// a loopback synthetic provider. This never opens the installed user's data.
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { startFakeModel } from "../server/runtime/pi/p0/fake-model.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "nex-desktop-fixture-"));
const output = path.join(root, "ready.json"), profile = path.join(root, "profile");
const packageExe = process.argv.find((arg) => arg.startsWith("--exe="))?.slice(6);
const executable = packageExe || path.resolve("dist-personal/electron/electron.exe");
const fake = await startFakeModel();
const childEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, NEX_SMOKE_OUTPUT: output };
const child = spawn(executable, [...(packageExe ? [] : [path.resolve("electron/nex-main.mjs")]), `--profile=${profile}`, "--port=0", "--background-fixture", "--remote-debugging-port=0"], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", exited = false;
child.stdout.on("data", (data) => { logs = (logs + data.toString()).slice(-7000); });
child.stderr.on("data", (data) => { logs = (logs + data.toString()).slice(-7000); });
child.once("close", () => { exited = true; });
let ws, sequence = 0;
const replies = new Map();
async function until(check, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) { if (exited || Date.now() > deadline) throw new Error("Desktop fixture failed: " + logs); await new Promise((resolve) => setTimeout(resolve, 70)); }
}
async function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { replies.delete(id); reject(new Error("Desktop command timed out: " + method + " " + logs)); }, 10_000);
    replies.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ": " + result.exceptionDetails.exception?.description);
  return result.result.value;
}
try {
  await until(() => existsSync(output) && existsSync(path.join(profile, "DevToolsActivePort")));
  const ready = JSON.parse(readFileSync(output, "utf8"));
  const port = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((t) => t.type === "page" && t.url.startsWith(ready.origin));
  if (!target) throw new Error("No fixture renderer target");
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve) => ws.once("open", resolve));
  ws.once("close", () => { for (const pending of replies.values()) pending.reject(new Error("Fixture renderer connection closed")); replies.clear(); });
  ws.on("message", (raw) => { const event = JSON.parse(raw.toString()); if (event.id) { const reply = replies.get(event.id); replies.delete(event.id); if (event.error) reply?.reject(new Error(event.error.message)); else reply?.resolve(event.result); } });
  await until(() => evaluate("document.querySelector('.brand')?.textContent.includes('NexBot')"));
  if (await evaluate("document.body.textContent.includes('新对话')||document.body.textContent.includes('最近对话')")) throw new Error("Conversation navigation still visible");
  const call = async (route, value) => {
    const response = await fetch(`${ready.origin}/api/${route}`, { headers: { Authorization: `Bearer ${ready.token}`, "Content-Type": "application/json" }, ...(value ? { method: "POST", body: JSON.stringify(value) } : {}) });
    const json = await response.json(); if (!response.ok) throw new Error(json.error); return json;
  };
  const unauth = await fetch(`${ready.origin}/api/state`); if (unauth.status !== 401) throw new Error("Unauthenticated state leaked");
  if ((await call("state")).bots.length !== 0 || fake.requests.length !== 0) throw new Error("Fresh Core created default Agents or model calls");
  await until(() => evaluate("document.querySelector('.welcome')?.innerText.includes('创建你的第一个 Agent')&&!document.querySelector('.composer')"));
  await evaluate("document.querySelector('.welcome button').click()");
  await evaluate("document.querySelector('.modal input[name=name]').value='Alpha';document.querySelector('.modal form').requestSubmit()");
  await until(async () => (await call("state")).bots.length === 1);
  await call("bots", { name: "Beta" });
  await call("bots", { name: "Gamma" });
  await evaluate("[...document.querySelectorAll('nav button')].find(b=>b.textContent==='设置').click()");
  const fixtureEndpoint = fake.origin + "/gateway/v1";
  await evaluate(`(()=>{const input=document.querySelector('input[name=endpoint]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(fixtureEndpoint)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(() => evaluate(`document.querySelector('[data-model-request-url]')?.textContent===${JSON.stringify(fixtureEndpoint + "/chat/completions")}`));
  await evaluate("document.querySelector('input[name=model]').value='fixture-model';document.querySelector('input[name=apiKey]').value='fixture-api-key';document.querySelector('form').requestSubmit()");
  await until(async () => (await call("state")).config?.configured === 1);
  if ((await call("state")).config.endpoint !== fixtureEndpoint) throw new Error("Endpoint input was not saved");
  await evaluate("document.querySelector('.agents button').click()");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='编辑身份').click()");
  const identityValidity = await evaluate("(()=>{const form=document.querySelector('.modal form');form.querySelector('input[name=name]').value='私人秘书';const field=form.querySelector('textarea[name=instructions]');field.value='';return {required:field.required,valid:form.checkValidity()};})()");
  if (identityValidity.required || !identityValidity.valid) throw new Error("Supplementary Agent identity is still required");
  await evaluate("document.querySelector('.modal form').requestSubmit()");
  await until(() => evaluate("!document.querySelector('.modal')&&document.querySelector('header')?.textContent.includes('私人秘书')"));
  if ((await call("state")).bots[0].instructions !== "") throw new Error("Blank identity was not saved");
  await evaluate("document.querySelector('[aria-label=\"添加 Agent\"]').click()");
  await evaluate("document.querySelector('.modal input[name=name]').value='消息助手';document.querySelector('.modal form').requestSubmit()");
  await until(async () => (await call("state")).bots.some((b) => b.name === "消息助手" && b.instructions === ""));
  if (fake.requests.length !== 0) throw new Error("Identity changes unexpectedly called a model");
  await evaluate("document.querySelector('.agents button').click()");
  fake.scripts.push({ kind: "openai-text", text: "打包应用聊天验证成功" });
  await evaluate("(()=>{const t=document.querySelector('.composer textarea');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(t,'你好，验证安装应用');t.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await until(() => evaluate("!document.querySelector('.send').disabled"));
  await evaluate("document.querySelector('.composer').requestSubmit()");
  await until(async () => (await call("state")).tasks.some((t) => t.status === "succeeded"));
  if (fake.requests[0].url !== "/gateway/v1/chat/completions") throw new Error("Wrong model request path");
  const identityPrompt = JSON.parse(fake.requests[0].body).messages.find((m) => m.role === "system" || m.role === "developer")?.content;
  if (!identityPrompt?.includes('"name":"私人秘书"') || !identityPrompt.includes('"name":"消息助手"')) throw new Error("Current self/peer identity missing from model request");
  await until(() => evaluate("document.querySelector('.transcript')?.textContent.includes('打包应用聊天验证成功')"));
  await evaluate("[...document.querySelectorAll('.inspector-tabs button')].find(b=>b.textContent==='记忆').click()");
  const state = await call("state");
  await call("memory", { botId: state.bots[0].id, title: "桌面验收记忆", content: "打包后的记忆可持久化", scope: "bot" });
  await until(() => evaluate("document.querySelector('.inspector-content')?.textContent.includes('桌面验收记忆')"));
  const originalBot = state.bots[0].id;
  await evaluate("document.querySelectorAll('.agents button')[1].click()");
  await until(() => evaluate("document.querySelector('header')?.textContent.includes('Beta')"));
  await evaluate("document.querySelector('.agents button').click()");
  await until(() => evaluate("document.querySelector('.transcript')?.textContent.includes('打包应用聊天验证成功')"));
  const routineName = "后台主动工作验证";
  await call("routines", { botId: originalBot, name: routineName, prompt: "无需新用户消息，按计划主动汇报", scheduleKind: "once", runAt: Date.now() + 12_000, timeZone: "Asia/Shanghai" });
  fake.scripts.push({ kind: "openai-text", text: "我已按计划完成工作，这是主动汇报。" });
  await evaluate("void window.nex.closeWindow(); true");
  await until(() => evaluate("document.visibilityState==='hidden'"));
  await until(async () => (await call("state")).tasks.filter((t) => t.status === "succeeded").length === 2);
  if (exited || fake.requests.length !== 2) throw new Error("Agent stopped working when window closed");
  const restore = spawn(executable, [...(packageExe ? [] : [path.resolve("electron/nex-main.mjs")]), `--profile=${profile}`, "--port=0"], { env: childEnv, stdio: "ignore", windowsHide: true });
  await new Promise((resolve, reject) => { restore.once("error", reject); restore.once("close", resolve); });
  await until(() => evaluate("document.visibilityState==='visible'"));
  await until(() => evaluate("document.querySelector('.transcript')?.textContent.includes('主动汇报')"));
  const peerId = state.bots.find((b) => b.name === "Gamma")?.id;
  if (!peerId) throw new Error("Gamma fixture contact missing");
  const peerReply = "WRITER_FOLDED_REPLY\n一只蜗牛沿着石缝爬向山顶，最终找到了老松树。\n选对方向，比一味求快更重要。";
  const parentReply = "我已收到 Gamma 的回复，这是给你的答复。";
  fake.scripts.push(
    { kind: "openai-tool", calls: [{ id: "desktop-a2a", name: "broker", args: JSON.stringify({ action: "agent.delegate", botId: peerId, message: "帮我写一个寓言故事" }) }] },
    { kind: "openai-text", text: peerReply },
    { kind: "openai-text", text: parentReply },
  );
  await evaluate("(()=>{const t=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'请联系 Gamma 帮我写寓言');t.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await until(() => evaluate("!document.querySelector('.send').disabled"));
  await evaluate("document.querySelector('.composer').requestSubmit()");
  await until(async () => (await call("state")).delegations.some((d) => d.status === "succeeded"));
  await until(() => evaluate(`document.querySelector('.transcript')?.innerText.includes(${JSON.stringify(parentReply)})&&!!document.querySelector('[data-a2a-direction=returned]')`));
  if ((await call("state")).approvals.length) throw new Error("A2A requested owner approval");
  const senderPresentation = await evaluate(`(()=>{const sent=document.querySelector('[data-a2a-direction=sent]'),returned=document.querySelector('[data-a2a-direction=returned]');return {sent:sent?.innerText,returned:returned?.innerText,duplicate:document.querySelector('.transcript').innerText.includes(${JSON.stringify(peerReply.split("\n")[0])}),resultBubble:!!returned?.querySelector('.bubble')};})()`);
  if (!senderPresentation.sent?.includes("已发消息给") || !senderPresentation.sent.includes("Gamma") || !senderPresentation.returned?.includes("消息来自") || !senderPresentation.returned.includes("Gamma") || senderPresentation.duplicate || senderPresentation.resultBubble) throw new Error("A2A sender still displays a duplicate result: " + JSON.stringify(senderPresentation));
  await evaluate("document.querySelector('[data-a2a-direction=returned] .a2a-contact').click()");
  await until(() => evaluate("document.querySelector('header')?.textContent.includes('Gamma')&&!!document.querySelector('.a2a-reply .folded-reply')"));
  const receiverPresentation = await evaluate("(()=>{const reply=document.querySelector('.a2a-reply'),fold=reply.querySelector('.folded-reply');return {author:reply.querySelector('.message-author').innerText,received:document.querySelector('[data-a2a-direction=received]').innerText,open:fold.open,bodyHeight:fold.querySelector('.folded-body').getBoundingClientRect().height,preview:fold.querySelector('summary').innerText,taskCard:!!document.querySelector('.folded-request,.a2a-request-content'),oldTaskLabel:document.querySelector('.transcript').innerText.includes('展开任务')};})()");
  if (!receiverPresentation.author.includes("Gamma") || !receiverPresentation.received.includes("消息来自") || !receiverPresentation.received.includes("私人秘书") || receiverPresentation.open || receiverPresentation.bodyHeight || !receiverPresentation.preview.includes("已回复给私人秘书") || !receiverPresentation.preview.includes("展开") || receiverPresentation.taskCard || receiverPresentation.oldTaskLabel) throw new Error("Gamma reply status or incoming presentation is incorrect: " + JSON.stringify(receiverPresentation));
  await evaluate("document.querySelector('.a2a-reply .folded-reply summary').click()");
  const expanded = await evaluate(`(()=>{const fold=document.querySelector('.a2a-reply .folded-reply');return fold.open&&fold.querySelector('.folded-body').getBoundingClientRect().height>0&&fold.innerText.includes(${JSON.stringify(peerReply.split("\n")[0])})&&fold.querySelector('summary').innerText.includes('收起')&&!fold.innerText.includes('已向 私人秘书 返回结果');})()`);
  if (!expanded) throw new Error("Gamma reply cannot expand to its complete body");
  await call("agents/read", { botId: peerId, seq: 0 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (!(await evaluate("document.querySelector('.a2a-reply .folded-reply').open"))) throw new Error("SSE reload reset the expanded reply");
  await evaluate("document.querySelector('.a2a-reply .folded-reply summary').click()");
  if (await evaluate("document.querySelector('.a2a-reply .folded-reply').open")) throw new Error("Gamma reply cannot collapse");
  const a2aScreenshot = path.resolve("release/personal-os/desktop-a2a-smoke.png");
  writeFileSync(a2aScreenshot, Buffer.from((await command("Page.captureScreenshot", { format: "png" })).data, "base64"));
  await evaluate("document.querySelector('[data-a2a-direction=received] .a2a-contact').click()");
  await until(() => evaluate("document.querySelector('header')?.textContent.includes('私人秘书')&&!!document.querySelector('[data-a2a-direction=returned]')"));
  if (fake.requests.length !== 5) throw new Error("Unexpected A2A model request count: " + fake.requests.length);
  await evaluate("[...document.querySelectorAll('.inspector-tabs button')].find(b=>b.textContent==='详情').click()");
  const shot = await command("Page.captureScreenshot", { format: "png" });
  const screenshot = path.resolve("release/personal-os/desktop-smoke.png");
  writeFileSync(screenshot, Buffer.from(shot.data, "base64"));
  const dom = await evaluate("({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,title:document.title,errors:document.querySelector('[role=alert]')?.textContent})");
  if (dom.overflow || dom.errors) throw new Error("Renderer layout/error failed: " + JSON.stringify(dom));
  await evaluate("void window.nex.quit(); true"); await until(() => exited, 10_000);
  console.log(JSON.stringify({ passed: true, runtime: "fixed-pi", cases: ["zero-default-Agents", "explicit-Agent-creation", "automatic-A2A", "desktop-boot", "vault", "API-key-settings", "model-request-preview", "optional-Agent-identity", "silent-identity-refresh", "persistent-Agent-contact", "SDK-chat", "private-memory", "background-routine", "tray-hide-restore", "compact-A2A-markers", "receiver-reply-collapse", "A2A-peer-navigation", "renderer", "graceful-shutdown"], dom, screenshot, a2aScreenshot }));
} finally {
  ws?.close();
  if (!exited) { if (process.platform === "win32" && child.pid) { const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); await new Promise((resolve) => killer.once("close", resolve)); } else child.kill(); }
  await fake.close();
  if (path.dirname(root).toLowerCase() === os.tmpdir().toLowerCase() && path.basename(root).startsWith("nex-desktop-fixture-")) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); } catch { console.warn("Owned fixture directory retained for diagnostics:", root); }
  }
}
