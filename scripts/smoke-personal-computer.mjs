// Genuine SDK observations and approved input against our own synthetic app.
// No user applications, live profiles, API keys or external model are touched.
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startFakeModel } from "../server/runtime/pi/p0/fake-model.ts";
const exe = path.resolve("dist-personal/electron/electron.exe");
// Use the same DPI-aware Windows host executable as the shipped Core. A
// standalone node.exe has a different manifest and virtualizes UI coordinates.
if (process.platform === "win32" && !process.versions.electron) {
  const runner = spawn(exe, ["--experimental-strip-types", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { windowsHide: true, stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  const code = await new Promise((resolve, reject) => { runner.once("error", reject); runner.once("exit", (code) => resolve(code ?? 1)); });
  process.exit(code);
}
const resources = path.resolve(process.argv.find((a) => a.startsWith("--resources="))?.slice(12) ?? "dist-personal");
const root = mkdtempSync(path.join(os.tmpdir(), "nex-computer-fixture-"));
const profile = mkdtempSync(path.join(root, "nex-computer-target-")), output = path.join(root, "target.json");
const target = spawn(exe, [path.resolve("scripts/fixture-personal-computer.mjs"), `--profile=${profile}`, `--output=${output}`, "--remote-debugging-port=0"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE } });
let targetLog = "";
target.stderr.on("data", (data) => { targetLog = (targetLog + data).slice(-3000); });
target.stdout.on("data", (data) => { targetLog = (targetLog + data).slice(-3000); });
let app, fake, socket, seq = 0, targetExited = false;
target.once("exit", (code, signal) => { targetExited = true; targetLog += `\nOwned target exited code=${code}, signal=${signal}`; });
const pending = new Map();
async function until(check, timeout = 30000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end || targetExited) throw new Error("Computer fixture timeout: " + targetLog); await new Promise((r) => setTimeout(r, 40)); } }
function cdp(method, params) { const id = ++seq; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }); }
async function value() { return (await cdp("Runtime.evaluate", { expression: "document.querySelector('#test').value", returnByValue: true })).result.value; }
const cases = [];
function cleanupOwned() {
  if (path.dirname(root).toLowerCase() !== os.tmpdir().toLowerCase() || !path.basename(root).startsWith("nex-computer-fixture-")) throw new Error("Unsafe computer fixture cleanup");
  rmSync(root, { recursive: true, force: true });
}
try {
  await until(() => existsSync(output) && existsSync(path.join(profile, "DevToolsActivePort")), 120000);
  const native = JSON.parse(readFileSync(output, "utf8"));
  if (process.argv.includes("--inspect-fixture")) { writeFileSync(path.resolve("release/personal-os/computer-target-debug.json"), JSON.stringify(native)); await new Promise((r) => setTimeout(r, 45000)); }
  const debugPort = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
  const page = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((page) => page.type === "page");
  socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => socket.once("open", r));
  socket.on("message", (raw) => { const event = JSON.parse(raw); const reply = pending.get(event.id); if (reply) { pending.delete(event.id); if (event.error) reply.reject(new Error(JSON.stringify(event.error))); else reply.resolve(event.result); } });
  const { createPersonalApp } = await import(pathToFileURL(path.join(resources, "core/index.js")));
  fake = await startFakeModel();
  app = await createPersonalApp({ dir: path.join(root, "core"), key: randomBytes(32), token: "synthetic-computer-owner", memoryRuntime: false });
  app.store.saveConfig({ provider: "openai", endpoint: fake.origin + "/v1", model: "synthetic-vision", apiKey: "synthetic-key" });
  const botId = app.store.createBot("合成操作助手");
  await until(() => app.node.status === "已连接");
  if (!app.node.computer.available()) throw new Error("Computer runtime absent from packaged resources");
  app.node.configure({ ...app.node.config, computer: true });
  await until(() => app.node.status === "已连接" && app.gateway.inventory()[0].granted.computer);
  const deviceId = app.gateway.hostDeviceId, window = { pid: native.pid, window_id: native.windowId };
  async function tool(operation, parameters, approve = false) {
    const inputId = randomBytes(8).toString("hex");
    fake.scripts.push({ kind: "openai-tool", calls: [{ id: inputId, name: "broker", args: JSON.stringify({ action: "device.computer", deviceId, operation, parameters }) }] }, { kind: "openai-text", text: "合成操作结果收到" });
    const taskId = app.agents.send(botId, "合成 computer use 验证", inputId).taskId;
    if (approve) {
      await until(() => !!app.store.get("SELECT id FROM approvals WHERE status='pending'"));
      if (await value()) throw new Error("Native input occurred before approval");
      const approval = app.store.get("SELECT * FROM approvals WHERE status='pending'");
      if (app.store.get("SELECT bot_id FROM tool_calls WHERE id=?", approval.tool_call_id)?.bot_id !== botId) throw new Error("Approval not in executing Agent's feed");
      app.runtime.decide(approval.id, approval.argument_hash, true);
    }
    await until(() => { const task = app.store.get("SELECT status,result_summary FROM tasks WHERE id=?", taskId); if (task?.status === "failed") throw new Error(task.result_summary); return task?.status === "succeeded"; });
    await until(() => app.runtime.workers.size === 0);
    const call = app.store.get("SELECT result_json FROM tool_calls WHERE task_id=?", taskId);
    return JSON.parse(call.result_json);
  }
  const schemas = await tool("tools", {}); if (!schemas.tools.some((tool) => tool.name === "type_text")) throw new Error("Native tool schema missing"); cases.push("pinned native SDK schemas");
  const listed = await tool("list_windows", {});
  const matched = listed.structured?.windows?.find((item) => Number(item.window_id) === native.windowId);
  if (!matched) throw new Error("Synthetic native window not found: " + JSON.stringify({ own: listed.structured?.windows?.filter((item) => item.title?.includes("Synthetic computer") || item.title?.includes("synthetic computer")), native }));
  window.pid = matched.pid; cases.push("exact native window discovery");
  const observed = await tool("get_window_state", { ...window, include_accessibility_tree: true });
  if (observed.isError || !observed.images?.[0]?.data) throw new Error("Native window screenshot failed: " + JSON.stringify({ ...observed, images: undefined }));
  const screenshotBytes = Buffer.from(observed.images[0].data, "base64");
  writeFileSync(path.resolve("release/personal-os/native-computer-window-smoke.png"), screenshotBytes);
  const geometry = (await cdp("Runtime.evaluate", { expression: "({innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio})", returnByValue: true })).result.value;
  writeFileSync(path.resolve("release/personal-os/native-computer-geometry.json"), JSON.stringify({ geometry, structured: observed.structured }, null, 2));
  if (observed.images[0].mimeType !== "image/png") throw new Error("Unexpected native screenshot format");
  const bounds = observed.structured.window_bounds, scale = Math.min(1, 1280 / Math.max(bounds.width, bounds.height));
  if (Math.abs(screenshotBytes.readUInt32BE(16) - bounds.width * scale) > 8 || Math.abs(screenshotBytes.readUInt32BE(20) - bounds.height * scale) > 8) throw new Error("Native screenshot is clipped at the current desktop DPI");
  cases.push("full window screenshot at desktop DPI");
  if (!fake.requests.at(-1).body.includes("data:image/")) throw new Error("Model never received native screenshot"); cases.push("real screenshot transported as vision image through DCP and Pi");
  // Focus only the synthetic work surface; the actual test input still travels
  // through native SDK, durable DCP and Core approval rather than DevTools.
  await cdp("Runtime.evaluate", { expression: "document.querySelector('#test').focus()" });
  await tool("get_window_state", { ...window, include_accessibility_tree: true });
  const text = "合成电脑输入验证";
  let typed = await tool("type_text", { ...window, text, delivery_mode: "background" }, true);
  if (typed.isError && JSON.stringify(typed).includes("background_unavailable")) {
    if (await value()) throw new Error("Refused background input changed the target");
    await tool("get_window_state", { ...window, include_accessibility_tree: true });
    typed = await tool("type_text", { ...window, text, delivery_mode: "foreground" }, true);
    cases.push("foreground escalation requires fresh observation and separate approval");
  }
  if (typed.isError || await value() !== text) throw new Error("Native text input not verified: " + JSON.stringify(typed));
  cases.push("approved native Unicode input, no input before approval");
  const count = app.node.journal.prepare("SELECT COUNT(*) n FROM node_calls WHERE capability='device.computer'").get().n;
  if (count < 5) throw new Error("DCP durable calls missing"); cases.push("durable native call receipts");
  await cdp("Page.close", {}); await until(() => targetExited, 10000);
  writeFileSync(path.resolve("release/personal-os/native-computer-result.json"), JSON.stringify({ success: true, resources, cases }, null, 2));
  console.log(JSON.stringify({ success: true, cases }, null, 2));
} finally {
  socket?.close(); if (app) await app.close(); if (fake) await fake.close();
  if (!targetExited) { target.kill(); await new Promise((r) => target.once("exit", r)); }
  cleanupOwned();
}
