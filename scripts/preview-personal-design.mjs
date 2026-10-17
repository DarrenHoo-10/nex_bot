// Visible, disposable design preview of the real bundled Core and renderer.
// All accounts, messages, model responses and MCP tools are local fixtures.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { startFakeIdentity } from "../server/personal-os/testing/fake-identity.ts";
import { startFakeModel } from "../server/runtime/pi/p0/fake-model.ts";
import { startFakeMcp } from "../server/personal-os/testing/fake-mcp.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "nex-design-preview-"));
const { createPersonalApp } = await import(pathToFileURL(path.resolve("dist-personal/server/core/index.js")).href);
let core, identity, model, mcp, child;
try {
  identity = await startFakeIdentity(); model = await startFakeModel(); mcp = await startFakeMcp();
  core = await createPersonalApp({ dir: path.join(root, "core"), key: randomBytes(32), token: "synthetic-design-bootstrap", hostDevice: false, memoryRuntime: false, uiDir: path.resolve("dist-personal/server/ui"), identity: { fixtureOrigin: identity.origin } });
  const operator = core.store.get("SELECT * FROM user_sessions WHERE id=?", core.store.session);
  const start = core.identity.start({ account: "owner@example.test", name: "设计预览" }, operator);
  const session = await core.identity.respond({ ...start, password: " synthetic password " }, operator);
  const api = async (route, data) => { const response = await fetch(core.origin + "/api/" + route, { method: data ? "POST" : "GET", headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" }, ...(data ? { body: JSON.stringify(data) } : {}) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); return result; };
  await api("config", { provider: "openai", endpoint: model.origin + "/v1", model: "design-preview", apiKey: "synthetic-only" });
  const bot = await api("bots", { name: "个人助手", instructions: "陪你整理日常、推进工作，把需要关注的事放在眼前。" });
  const research = await api("bots", { name: "研究伙伴", instructions: "寻找依据，整理资料，帮你看清问题。" });
  const writer = await api("bots", { name: "写作搭档", instructions: "一起梳理想法，把文字写得清楚自然。" });
  for (const [id, shape, color] of [[bot.id, "soft", "teal"], [research.id, "bud", "plum"], [writer.id, "bean", "clay"]]) await api("bots/appearance", { id, version: 0, appearance: { kind: "companion", shape, color } });
  const connector = await api("connectors/save", { name: "示例知识库", url: mcp.origin + "/mcp", transport: "http" });
  await api("connectors/test", { id: connector.id, version: 1 });
  const configured = (await api("state")).connectors[0];
  await api("connectors/grant", { id: connector.id, botId: bot.id, version: configured.version, tools: ["echo"] });
  core.agents.publish(bot.id, "user", "message", "帮我把今天的工作安排得清楚一点。", "design-input", null, null, Date.now() - 180_000);
  core.agents.publish(bot.id, "assistant", "message", "我们先把注意力放在最重要的事情上。\n\n**今天，先做好这三件事**\n\n1. **确认优先级** — 把最需要推进的工作放在第一位。\n2. **补齐资料** — 需要查询时，我会通过已授权的连接器协助你。\n3. **留出收尾时间** — 整理进展，把下一步说清楚。\n\n你想从哪一件开始？", "design-reply", null, null, Date.now() - 170_000);
  core.agents.publish(research.id, "assistant", "message", "资料准备好了，我们可以一起看看。", "research-reply");
  core.agents.publish(writer.id, "assistant", "message", "有了想法，随时来找我一起写。", "writer-reply");
  core.runtime.memory.write(bot.id, { title: "交流偏好（示例）", content: "先说结论，再给具体步骤；优先使用中文。" });
  // Delay each request at consumption time, so real thinking/done states remain visible.
  for (let i = 0; i < 100; i++) model.scripts.push({ kind: "openai-text", text: "收到。这是独立设计预览，消息由本机演示模型回复。\n\n你可以继续发消息，观察思考与完成的表情；也可以打开右侧的**更换头像**，尝试 20 个角色组合、状态动效和经典图库。\n\n在右侧切换 **工作 / 资料 / 设置**，查看新的信息组织方式。", get waitFor() { return new Promise(resolve => setTimeout(resolve, 2400)); } });
  const profile = path.join(root, "renderer"); mkdirSync(profile);
  const entry = path.join(root, "preview.cjs"), icon = path.resolve("electron/client/nexbot-icon.png");
  writeFileSync(entry, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(profile)});app.setName('NexBot 设计预览');app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1440,height:960,minWidth:390,minHeight:600,title:'NexBot · 设计预览（独立演示数据）',icon:${JSON.stringify(icon)},autoHideMenuBar:true,webPreferences:{sandbox:true,contextIsolation:true}});w.removeMenu();w.on('page-title-updated',e=>e.preventDefault());w.webContents.setWindowOpenHandler(()=>({action:'deny'}));await w.webContents.session.cookies.set({url:${JSON.stringify(core.origin)},name:'nex',value:${JSON.stringify(session.token)},httpOnly:true,sameSite:'strict',path:'/'});await w.loadURL(${JSON.stringify(core.origin)});w.show();});app.on('window-all-closed',()=>app.quit());`);
  const electron = path.resolve("dist-personal/electron", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron.exe");
  if (!existsSync(electron)) throw new Error("Prepare the client runtime first");
  child = spawn(electron, [entry], { windowsHide: false, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, TEMP: os.tmpdir(), TMP: os.tmpdir() }, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", () => {});
  console.log("NexBot design preview opened with isolated synthetic data. Close its window to stop the fixture.");
  await new Promise((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
} finally {
  await core?.close(); await model?.close(); await identity?.close(); await mcp?.close();
  if (path.dirname(root).toLowerCase() === os.tmpdir().toLowerCase() && path.basename(root).startsWith("nex-design-preview-")) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
