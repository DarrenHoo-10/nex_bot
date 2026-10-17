// Isolated Core + synthetic identity + scripted fake model for native macOS/iOS client verification.
// Foreground launcher: node --experimental-strip-types scripts/fixture-native-client.mjs [--port=N]
// Never touches user data. Owns one temp root and removes only that on exit.
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { startFakeIdentity } from "../server/personal-os/testing/fake-identity.ts";
import { startFakeModel } from "../server/runtime/pi/p0/fake-model.ts";
import { startFakeMcp } from "../server/personal-os/testing/fake-mcp.ts";

const coreEntry = path.resolve("dist-personal/server/core/index.js");
if (!existsSync(coreEntry)) { console.error("dist-personal/server/core/index.js is missing. Run `pnpm build:core` first."); process.exit(2); }
const portArg = process.argv.find((a) => a.startsWith("--port="));
const port = portArg ? Number(portArg.slice(7)) : 0;
if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error("Invalid --port"); process.exit(2); }

const PASSWORD = " synthetic password ";
const root = mkdtempSync(path.join(os.tmpdir(), "nex-native-fixture-"));
const { createPersonalApp } = await import(pathToFileURL(coreEntry).href);
const identity = await startFakeIdentity();
const model = await startFakeModel();
const mcp = await startFakeMcp();

// Thin proxy in front of the fake model so `reply` can stream slowly in many deltas.
const streamQueue = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proxy = createServer((req, res) => { void (async () => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const custom = req.method === "POST" && req.url.includes("/chat/completions") ? streamQueue.shift() : undefined;
  if (custom) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify({ id: "chatcmpl-native", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
    frame({ role: "assistant", content: "" });
    const chars = [...custom]; const size = Math.max(1, Math.ceil(chars.length / 12));
    for (let i = 0; i < chars.length; i += size) { if (res.destroyed) return; frame({ content: chars.slice(i, i + size).join("") }); await sleep(450); }
    frame({}, "stop", { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    res.end("data: [DONE]\n\n"); return;
  }
  if (req.method === "POST" && model.scripts.length === 0) model.scripts.push({ kind: "openai-text", text: "收到。这是夹具模型的默认回复。" });
  const upstream = await fetch(model.origin + req.url, { method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json" }, ...(req.method === "POST" ? { body } : {}) });
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
  res.end(Buffer.from(await upstream.arrayBuffer()));
})().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`;

let token = "synthetic-native-bootstrap", core;
let closed = false;
async function cleanup() {
  if (closed) return; closed = true;
  for (const step of [() => core?.close(), () => mcp.close(), () => new Promise((r) => { proxy.close(r); proxy.closeAllConnections(); }), () => model.close(), () => identity.close()]) await Promise.resolve().then(step).catch(() => {});
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("nex-native-fixture-")) { console.error("Refusing unsafe cleanup of " + root); return; }
  rmSync(root, { recursive: true, force: true });
}
const die = async (code) => { await cleanup(); process.exit(code); };
process.on("SIGINT", () => void die(0)); process.on("SIGTERM", () => void die(0));

try {
  core = await createPersonalApp({ dir: path.join(root, "core"), key: randomBytes(32), token, uiDir: path.resolve("dist-personal/server/ui"), memoryRuntime: false, identity: { fixtureOrigin: identity.origin }, host: "127.0.0.1", port, ...(port ? { strictPort: true } : {}) });
} catch (error) { console.error("Core failed to start: " + (error instanceof Error ? error.message : error)); await die(1); }

async function raw(route, data, auth = token, cookie) {
  const response = await fetch(core.origin + "/api/" + route, { headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(cookie ? { Cookie: cookie } : {}), "Content-Type": "application/json" }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${route}: ${response.status} ${value.error ?? ""}`);
  return value;
}
const api = (route, data) => raw(route, data);

try {
  const bootstrap = await fetch(core.origin + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
  const transaction = await raw("auth/start", { account: "owner@example.test", name: "fixture-controller" }, null, cookie);
  token = (await raw("auth/respond", { ...transaction, password: PASSWORD }, null, cookie)).token;
  await api("config", { provider: "openai", endpoint: proxyOrigin + "/v1", model: "fixture-model", apiKey: "synthetic-only" });
  await api("bots", { name: "工作助手", instructions: "整理信息、调用工具，帮助你推进每天的工作。" });
  await api("bots", { name: "研究伙伴", instructions: "关注问题的依据，整理资料和研究结论。" });
} catch (error) { console.error("Fixture setup failed: " + (error instanceof Error ? error.message : error)); await die(1); }

const bots = async () => (await api("state")).bots;
async function botByName(name) { const found = (await bots()).find((b) => b.name === name || b.id === name); if (!found) throw new Error("No such agent: " + name); return found; }
async function settle(timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { await sleep(150); const s = await api("state"); if (!(s.tasks ?? []).some((t) => !t.ended_at) && !(s.approvals ?? []).length) return; }
  throw new Error("Timed out waiting for tasks to settle");
}
async function sendInput(name, text) { const bot = await botByName(name); return api("agents/input", { botId: bot.id, text, clientId: randomBytes(16).toString("hex") }); }

try { await sendInput("工作助手", "你好，请做个自我介绍。"); await settle(); await sendInput("研究伙伴", "你好，今天有什么研究计划？"); await settle(); }
catch (error) { console.error("Seed history failed: " + (error instanceof Error ? error.message : error)); }

console.log(`
==== NexBot native-client fixture ====
Core origin : ${core.origin}
Account     : owner@example.test
Password    : ${JSON.stringify(PASSWORD)}   (leading and trailing spaces are intentional)
2nd account : other@example.test (same password). Plain createPersonalApp has no accountWorkspaces mode,
              so Core is bound to the owner identity; expect other@ to be refused at auth/respond.
Agents      : 工作助手, 研究伙伴 (each has seeded history)
Fake MCP    : ${mcp.origin}/mcp   (add it as a connector, test, then grant; tools: echo, private_tool. SSE transport: ${mcp.origin}/sse)
Model       : configured (state.config present)
Temp dir    : ${root}
PID         : ${process.pid}
Commands (stdin): reply <text> | approval | send <agent> <text> | history <agent> <n> | revoke-others | forget <agent> |
                  memory <agent> <title> | <content> | routine <agent> <name> | peer | status | quit
Ctrl-C or "quit" stops everything and removes only the temp dir.
======================================`);

async function status() {
  const s = await api("state"), clients = await api("clients");
  console.log(JSON.stringify({ bots: s.bots.map((b) => ({ id: b.id, name: b.name })), pendingApprovals: (s.approvals ?? []).map((a) => ({ id: a.id, hash: a.argument_hash, tool: a.tool_name, botId: a.bot_id, taskId: a.task_id })), sessions: clients.sessions.map((c) => ({ id: c.session_id, name: c.name, current: c.session_id === clients.currentSessionId })), pendingStreamedReplies: streamQueue.length, queuedModelScripts: model.scripts.length, sync: s.sync }, null, 1));
}
async function command(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd) return;
  // A literal \n in the argument becomes a line break, so Markdown lists can be scripted from one stdin line.
  if (cmd === "reply") { const arg = line.trim().slice(cmd.length).trim().replaceAll("\\n", "\n"); if (!arg) throw new Error("usage: reply <text>"); streamQueue.push(arg); console.log("OK next model reply streams: " + arg); }
  else if (cmd === "approval") {
    const host = (await api("state")).hostDeviceId; if (!host) throw new Error("No host device");
    model.scripts.push({ kind: "openai-tool", calls: [{ id: "fixture-" + randomBytes(4).toString("hex"), name: "broker", args: JSON.stringify({ action: "device.exec", risk: "dangerous", riskReason: "夹具审批验证", deviceId: host, command: "echo fixture-approved" }) }] }, { kind: "openai-text", text: "审批后命令已完成。" });
    console.log("OK next model turn requests an approval-gated device.exec on the host device. Now `send <agent> <text>`.");
  }
  else if (cmd === "send") { const name = rest[0], text = rest.slice(1).join(" "); if (!name || !text) throw new Error("usage: send <agent> <text>"); const r = await sendInput(name, text); console.log("OK sent " + JSON.stringify(r)); }
  else if (cmd === "history") { const name = rest[0], n = Number(rest[1]); if (!name || !(n > 0 && n <= 200)) throw new Error("usage: history <agent> <n<=200>"); for (let i = 1; i <= n; i++) { await sendInput(name, `历史消息 ${i}`); await settle(); } console.log(`OK ${n} turns added`); }
  else if (cmd === "revoke-others") {
    const { sessions, currentSessionId } = await api("clients"); let count = 0;
    for (const s of sessions) if (s.session_id !== currentSessionId && !s.revoked_at) { await api("clients/revoke", { sessionId: s.session_id }); count++; }
    console.log(`OK revoked ${count} other session(s)`);
  }
  else if (cmd === "forget") { const bot = await botByName(rest[0] ?? ""); const preview = await api("memory/forget-preview", { botId: bot.id }).catch((e) => ({ error: e.message })); console.log("forget preview (no mutation): " + JSON.stringify(preview).slice(0, 400)); }
  else if (cmd === "memory") {
    const m = line.trim().slice(cmd.length).trim().match(/^(\S+)\s+(.+?)\s*\|\s*(.+)$/); if (!m) throw new Error("usage: memory <agent> <title> | <content>");
    const bot = await botByName(m[1]); const r = await api("memory", { botId: bot.id, title: m[2], content: m[3], scope: "bot", expectedVersion: 0 }); console.log("OK memory " + JSON.stringify(r));
  }
  else if (cmd === "routine") {
    const name = rest.slice(1).join(" "); if (!rest[0] || !name) throw new Error("usage: routine <agent> <name>");
    const bot = await botByName(rest[0]); const r = await api("routines", { botId: bot.id, name, prompt: `请完成例行任务：${name}`, scheduleKind: "daily", localTime: "09:00", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    console.log("OK routine " + JSON.stringify(r));
  }
  else if (cmd === "peer") {
    const peer = await botByName("研究伙伴");
    model.scripts.push({ kind: "openai-tool", calls: [{ id: "fixture-" + randomBytes(4).toString("hex"), name: "broker", args: JSON.stringify({ action: "agent.delegate", botId: peer.id, message: "请简短说明你今天的研究重点。" }) }] }, { kind: "openai-text", text: "已联系研究伙伴。" });
    console.log("OK next model turn makes 工作助手 delegate to 研究伙伴 (agent.delegate). Now `send 工作助手 <text>`.");
  }
  else if (cmd === "status") await status();
  else if (cmd === "quit" || cmd === "exit") await die(0);
  else console.log("Unknown command: " + cmd);
}
const rl = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on("line", (line) => { chain = chain.then(() => command(line)).catch((e) => console.log("ERR " + (e instanceof Error ? e.message : e))); });
// Piped stdin that ends (not a TTY) must not tear the fixture down; stay attached until signal or `quit`.
rl.on("close", () => { chain = chain.then(() => new Promise(() => {})); setInterval(() => {}, 1 << 30); });
