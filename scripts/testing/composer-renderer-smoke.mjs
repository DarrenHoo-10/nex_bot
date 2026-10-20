// Real renderer/CSS in an isolated Chrome profile, using synthetic in-memory API
// responses. CDP uses pipes: this fixture needs no listener, Core, or live data.
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const fixture = mkdtempSync(path.join(os.tmpdir(), "nex-composer-renderer-"));
const entry = `
import React from "react";
import { createRoot } from "react-dom/client";
import { AgentDesktop } from "./src/personal/AgentDesktop";
import "./src/personal/agent.css";
import "./src/personal/workspace.css";
import "./src/personal/identity.css";
import "./src/personal/settings.css";
import "./electron/client/style.css";
const sync = { cursor: 1, privacyEpoch: 1, coreId: "fixture", bootId: "fixture" };
const state = { sync, bots: [{ id: "agent", name: "Fixture", instructions: "" }],
  conversations: [], approvals: [], memories: [], delegations: [], devices: [], tasks: [],
  onlineDevices: [], routines: [], occurrences: [], journal: [], node: { unknownCalls: [] } };
const messages = [{ id: "reply", seq: 1, role: "assistant", kind: "text",
  content: "这是可以选中复制的消息正文。 Select this message text.",
  created_at: Date.now() }];
window.fixtureCalls = [];
window.fetch = async (url, options) => {
  if (!String(url).startsWith("/api/")) throw new Error("Fixture forbids external requests");
  window.fixtureCalls.push({ url, body: options?.body });
  const value = url === "/api/state" ? state : url.startsWith("/api/agents/messages")
    ? { sync, messages, streaming: [], hasMore: false } : {};
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
};
window.EventSource = class { addEventListener() {} close() {} };
Object.defineProperty(navigator, "clipboard", { value: { writeText: async value => { window.fixtureCopied = value; } } });
localStorage.clear();
localStorage.setItem("nexbot.selectedAgent", "agent");
createRoot(document.getElementById("root")).render(<AgentDesktop/>);
`;
let child;
try {
  await build({
    stdin: { contents: entry, loader: "tsx", resolveDir: process.cwd() },
    bundle: true, outfile: path.join(fixture, "app.js"), format: "iife", jsx: "automatic",
    loader: { ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" },
  });
  writeFileSync(path.join(fixture, "index.html"), '<meta charset="utf-8"><link rel="stylesheet" href="app.css"><div id="root"></div><script src="app.js"></script>');
  const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  child = spawn(chrome, ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${path.join(fixture, "profile")}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  let serial = 0, buffer = "", stderr = "", stopped;
  const pending = new Map();
  child.stderr.on("data", data => { stderr += data; });
  child.on("error", error => {
    stopped = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  child.on("exit", () => {
    stopped = new Error(`Fixture Chrome exited (${child.exitCode ?? child.signalCode}): ${stderr.slice(-2000)}`);
    for (const waiter of pending.values()) waiter.reject(stopped);
    pending.clear();
  });
  child.stdio[4].on("data", data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf("\0")) !== -1) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      }
    }
  });
  function cdp(method, params = {}, sessionId) {
    if (stopped) return Promise.reject(stopped);
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}; ${stderr.slice(-1000)}`)); }, 15000);
      pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); },
      });
      child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    });
  }
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  const command = (method, params) => cdp(method, params, sessionId);
  const evaluate = async expression => {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(expression) {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(50); }
    throw new Error(`Renderer timed out: ${expression}`);
  }
  async function point(selector) {
    return evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  }
  const move = p => command("Input.dispatchMouseEvent", { type: "mouseMoved", ...p });
  async function click(selector) {
    const p = await point(selector);
    await move(p);
    await command("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...p });
    await command("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...p });
  }
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await command("Page.navigate", { url: pathToFileURL(path.join(fixture, "index.html")).href });
  await until("!!document.querySelector('.message .markdown p')");
  await click(".model-chooser-notice button");
  await until("!!document.querySelector('.model-chooser-notice [data-model-settings]')");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.model-chooser-notice')).display"), "block");
  assert.equal(await evaluate("!!document.querySelector('.composer textarea') && !document.querySelector('.preferences-page')"), true);
  await click(".model-chooser-notice > div > button");

  const body = ".message .markdown p", copy = ".message-tools button[title='复制内容']";
  const from = await point(body), to = await point(copy);
  await move(from);
  await pause(180);
  for (let i = 1; i <= 10; i++) {
    await move({ x: from.x + (to.x - from.x) * i / 10, y: from.y + (to.y - from.y) * i / 10 });
    await pause(30);
    assert.ok(Number(await evaluate("getComputedStyle(document.querySelector('.message-tools')).opacity")) > 0.9);
  }
  await click(copy);
  assert.match(await evaluate("window.fixtureCopied"), /Select this message text/);
  await click(".message-tools button[title='引用回复']");
  assert.equal(await evaluate("!!document.querySelector('.quote-bar')"), true);
  await click("[aria-label='取消引用']");

  const bounds = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(body)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`);
  const start = { x: bounds.x + 2, y: bounds.y + bounds.height / 2 };
  await move(start);
  await command("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...start });
  await command("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, x: bounds.x + bounds.width - 2, y: start.y });
  await command("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: bounds.x + bounds.width - 2, y: start.y });
  assert.ok((await evaluate("window.getSelection().toString()")).length > 10, "Mouse drag selects message text");
  await pause(300);
  assert.ok((await evaluate("window.getSelection().toString()")).length > 10, "Selection survives after mouse release");
  console.log("PASS: inline model settings; hover path; Copy; Quote; mouse text selection. Synthetic API/clipboard only.");
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  rmSync(fixture, { recursive: true, force: true });
}
