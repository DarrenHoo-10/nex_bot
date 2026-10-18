// Reproducible mobile reference images of the APK's exact asset bundle.
// Uses an offscreen Electron renderer because this host's headless emulator has no screenshot surface.
import { createServer, request } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { connectAndroidWorkspace } from "./testing/android-workspace-cdp.mjs";
const fixture = JSON.parse(readFileSync(path.join(process.argv[2] || "release/android-workspace", "fixture.json"), "utf8"));
const check = await fetch(fixture.origin + "/api/auth/status", { headers: { Authorization: `Bearer ${fixture.token}` } });
if ((await check.json()).account?.displayName !== "演示账号") throw new Error("Not the owned fixture");
const login = async (route, data) => (await fetch(fixture.origin + "/api/" + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })).json();
const transaction = await login("auth/start", { account: "owner@example.test", name: "演示手机" });
const mobileSession = await login("auth/respond", { ...transaction, password: " synthetic password " });
if (!mobileSession.token) throw new Error("Fixture mobile login failed");
const assets = path.resolve("android/app/build/generated/workspaceAssets/workspace");
const root = mkdtempSync(path.join(os.tmpdir(), "nex-android-capture-"));
const output = path.resolve("doc/ui"); mkdirSync(output, { recursive: true });
const server = createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    const proxy = request(fixture.origin + req.url, { method: req.method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${mobileSession.token}` } }, upstream => { res.writeHead(upstream.statusCode, { "Content-Type": upstream.headers["content-type"] || "application/json" }); upstream.pipe(res); });
    proxy.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(proxy); req.on("close", () => { if (!req.complete) proxy.destroy(); }); res.on("close", () => proxy.destroy()); return;
  }
  const file = path.resolve(assets, req.url === "/" ? "index.html" : "." + req.url.split("?")[0]);
  if (!file.startsWith(assets + path.sep) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" })[path.extname(file)] || "application/octet-stream"); res.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const preload = path.join(root, "preload.cjs"), entry = path.join(root, "main.cjs");
writeFileSync(preload, `const fetchOriginal=window.fetch.bind(window), Events=window.EventSource;const streams=new Map();window.NexAndroid={request:async(id,path,method,body)=>{try{const r=await fetchOriginal(path,{method,headers:{'Content-Type':'application/json'},...(method==='GET'?{}:{body})});window.__nexReply(id,{status:r.status,body:await r.text()});}catch(e){window.__nexReply(id,{error:e.message});}},action:(id)=>window.__nexReply(id,{value:true}),subscribe:id=>{const s=new Events('/api/events');streams.set(id,s);for(const event of ['change','revoked'])s.addEventListener(event,e=>window.__nexEvent(id,event,e.data));},unsubscribe:id=>{streams.get(id)?.close();streams.delete(id);}};`);
writeFileSync(entry, `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, "profile"))});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:412,height:915,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:false,sandbox:false,offscreen:true,backgroundThrottling:false}});await w.loadURL(${JSON.stringify(origin)});});`);
const child = spawn(createRequire(import.meta.url)("electron"), [entry, "--remote-debugging-port=0"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA,
  USERPROFILE: process.env.USERPROFILE, TEMP: os.tmpdir(), TMP: os.tmpdir(),
} });
let logs = "";
child.stdout.on("data", data => logs += data); child.stderr.on("data", data => logs += data);
let c;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async expression => { const end = Date.now() + 20000; while (!await c.evaluate(expression)) { if (Date.now() > end) throw new Error(expression); await delay(100); } };
const click = selector => c.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const button = (text, selector = "body") => c.evaluate(`[...document.querySelector(${JSON.stringify(selector)}).querySelectorAll('button')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)}).click()`);
const shot = async name => { await delay(250); writeFileSync(path.join(output, `android-${name}.png`), Buffer.from((await c.command("Page.captureScreenshot", { format: "png" })).data, "base64")); };
try {
  const activePort = path.join(root, "profile/DevToolsActivePort");
  const end = Date.now() + 20000; while (!existsSync(activePort)) { if (Date.now() > end || child.exitCode != null) throw new Error("Renderer boot failed: " + logs); await delay(100); }
  c = await connectAndroidWorkspace(Number(readFileSync(activePort, "utf8").split("\n")[0]), origin);
  await c.command("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 1, mobile: true });
  await wait("!!document.querySelector('.contact-item')");
  await shot("contacts"); await click(".workspace-account-name"); await shot("account-menu"); await button("设置", ".account-menu");
  await wait("!!document.querySelector('.ds-session-item')"); await shot("settings-account");
  for (const [label, name] of [["模型", "model"], ["记忆服务", "memory"], ["连接器", "connectors"], ["设备", "devices"]]) {
    await button(label, ".preferences-nav"); await delay(700); await shot(`settings-${name}`);
    if (name === "model") {
      await c.evaluate("document.querySelector('[data-model-limits]').scrollIntoView({block:'center'})"); await shot("model-limits");
      await c.evaluate("document.querySelector('.preferences-heading').scrollIntoView({block:'start'})");
    }
  }
  await click(".mobile-menu"); await click(`[data-agent='${fixture.bot}']`); await wait("!!document.querySelector('.composer-add')"); await shot("chat");
  await click(".composer-add"); await shot("composer-menu");
  await c.evaluate("[...document.querySelectorAll('.composer-command-menu button')].find(b=>b.querySelector('small')?.textContent==='model').click()");
  await wait("[...document.querySelectorAll('.composer-model-menu button')].some(b=>b.textContent==='fixture-reasoning')"); await shot("model-selector");
  await c.evaluate("window.dispatchEvent(new Event('nex-android-back'))"); await click(".permission-trigger"); await shot("permissions"); await click(".permission-trigger");
  await click(".contact-heading.clickable"); await shot("assistant-work"); await button("设置", ".inspector-tabs"); await shot("assistant-settings");
  console.log("14 Android shared-renderer mobile references captured");
} finally {
  c?.close();
  if (child.exitCode == null) { const kill = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); await new Promise(resolve => kill.on("exit", resolve)); }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
