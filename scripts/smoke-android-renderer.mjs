// Tests the APK asset bundle in hidden Electron with a fixture native bridge.
// This checks the shared renderer, not Android WebView or device behavior.
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
mkdirSync(path.join(root, "profile"));
const output = path.resolve(process.argv[2] || "release/android-workspace", "screenshots"); mkdirSync(output, { recursive: true });
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
writeFileSync(preload, `if(window.top===window){const fetchOriginal=window.fetch.bind(window), Events=window.EventSource;const streams=new Map();const native={request:async(id,path,method,body)=>{try{const r=await fetchOriginal(path,{method,headers:{'Content-Type':'application/json'},...(method==='GET'?{}:{body})});window.__nexReply(id,{status:r.status,body:await r.text()});}catch(e){window.__nexReply(id,{error:e.message});}},action:(id)=>window.__nexReply(id,{value:true}),subscribe:id=>{const s=new Events('/api/events');streams.set(id,s);for(const event of ['change','revoked'])s.addEventListener(event,e=>window.__nexEvent(id,event,e.data));},unsubscribe:id=>{streams.get(id)?.close();streams.delete(id);}};window.addEventListener('DOMContentLoaded',()=>{const channel=new MessageChannel();channel.port1.onmessage=({data})=>{const{method,args}=JSON.parse(data);native[method](...args);};window.dispatchEvent(new MessageEvent('message',{data:'nex-workspace-port',source:null,ports:[channel.port2]}));},{once:true});}`);
writeFileSync(entry, `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, "profile"))});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:412,height:915,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:false,sandbox:false,offscreen:true,backgroundThrottling:false}});await w.loadURL(${JSON.stringify(origin)});});`);
const stagedElectron = path.resolve("dist-personal/electron", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron.exe");
const electron = existsSync(stagedElectron) ? stagedElectron : createRequire(import.meta.url)("electron");
const child = spawn(electron, [entry, "--remote-debugging-port=0"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
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

  const port=Number(readFileSync(activePort,'utf8').split('\n')[0]);
  const run=spawn(process.execPath,['scripts/smoke-android-workspace.mjs',path.resolve(process.argv[2] || "release/android-workspace", "fixture.json"),String(port),origin],{stdio:'inherit',windowsHide:true});
  const code=await new Promise(resolve=>run.on('exit',resolve));
  if(code!==0) throw new Error('Bundled Android renderer smoke failed');
  await click('.contact-heading.clickable'); await button('设置','.inspector-tabs'); await click('.profile-avatar-button');
  await wait('!!document.querySelector(".avatar-picker")'); await shot('roles');
} finally {
  c?.close();
  if (child.exitCode == null) {
    if (process.platform === "win32") {
      const kill = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      await new Promise(resolve => kill.on("exit", resolve));
    } else { child.kill("SIGTERM"); }
  }
  server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
}
