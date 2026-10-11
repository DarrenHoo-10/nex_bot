import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = process.argv.find((a) => a.startsWith("--profile="))?.slice(10);
app.setName("NexBot Client");
app.setPath("userData", profile ? path.resolve(profile) : path.join(app.getPath("appData"), "NexBotClient"));
let window, saved, origin, device, key, connectionError = "", exiting = false, approvedRoot;
const credentials = path.join(app.getPath("userData"), "connection.bin");
const connectionPage = pathToFileURL(path.join(root, "electron", "client", "index.html")).href;
function validate(event, localOnly = false) {
  const url = event.senderFrame?.url;
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || (url !== connectionPage && (localOnly || !origin || new URL(url).origin !== origin))) throw new Error("Invalid client sender");
}
function coreOrigin(value) {
  const url = new URL(value);
  const privateHost = url.hostname === "localhost" || (isIP(url.hostname) === 4 && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname));
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(url.protocol === "http:" && privateHost))) throw new Error("请填写 HTTPS 或私有网络 HTTP 的 Core 根地址");
  return url.origin;
}
async function request(address, route, data, token) {
  const response = await fetch(address + route, { method: data ? "POST" : "GET", headers: { ...(data ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}), redirect: "error", signal: AbortSignal.timeout(15_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "无法连接 Core");
  return result;
}
async function stopNode() { if (device) { const current = device; device = undefined; await current.close(); } }
async function login(settings) {
  const old = saved;
  const address = coreOrigin(settings.resume ? saved?.origin : settings.origin);
  const identity = await request(address, "/api/client/identity");
  if (identity.version !== 1 || !identity.coreId) throw new Error("Core 不支持客户端协议 v1");
  let session;
  if (settings.resume) {
    if (!old || old.coreId !== identity.coreId) throw new Error("Core 身份已变化，请重新生成连接码登录");
    session = await request(address, "/api/session", { token: old.token });
    if (session.coreId !== old.coreId) throw new Error("Core 身份不匹配");
    saved = old;
  } else {
    session = await request(address, "/api/client/login", { code: settings.code, name: settings.name });
    if (session.coreId !== identity.coreId) throw new Error("Core 身份在登录期间发生变化");
    if (old && (old.origin !== address || old.coreId !== session.coreId)) {
      await stopNode();
      const resources = app.isPackaged ? process.resourcesPath : path.join(root, "dist-personal");
      const { clearClientGrant } = await import(pathToFileURL(path.join(resources, "client-node", "client-node.js")).href);
      clearClientGrant(path.join(app.getPath("userData"), "device"));
    }
    saved = { origin: address, name: String(settings.name), token: session.token, coreId: session.coreId, sessionId: session.sessionId };
    writeFileSync(credentials, safeStorage.encryptString(JSON.stringify(saved)), { mode: 0o600 });
  }
  await window.webContents.session.clearStorageData();
  await window.webContents.session.cookies.set({ url: address, name: "nex", value: saved.token, httpOnly: true, sameSite: "strict", secure: address.startsWith("https:"), path: "/" });
  origin = address;
  if (!device) {
    const resources = app.isPackaged ? process.resourcesPath : path.join(root, "dist-personal");
    const { createClientNode } = await import(pathToFileURL(path.join(resources, "client-node", "client-node.js")).href);
    device = createClientNode(path.join(app.getPath("userData"), "device"), Buffer.from(key, "base64"), () => {}, origin);
  }
  connectionError = "";
  await window.loadURL(origin + "/");
}
if (!app.requestSingleInstanceLock() || process.argv.includes("--quit")) app.quit();
else {
  app.on("second-instance", (_event, args) => { if (args.includes("--quit")) app.quit(); else { window?.show(); window?.focus(); } });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (exiting) return;
    event.preventDefault(); exiting = true;
    void stopNode().finally(() => app.exit(0));
  });
  app.whenReady().then(async () => {
    mkdirSync(app.getPath("userData"), { recursive: true });
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 加密存储不可用");
    const keyFile = path.join(app.getPath("userData"), "device-key.bin");
    key = existsSync(keyFile) ? safeStorage.decryptString(readFileSync(keyFile)) : randomBytes(32).toString("base64");
    if (!existsSync(keyFile)) writeFileSync(keyFile, safeStorage.encryptString(key));
    if (existsSync(credentials)) saved = JSON.parse(safeStorage.decryptString(readFileSync(credentials)));
    window = new BrowserWindow({ width: 1240, height: 880, minWidth: 760, minHeight: 600, title: "NexBot Client", autoHideMenuBar: true, webPreferences: { preload: path.join(root, "electron", "nex-client-preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, partition: `nex-client-${randomBytes(12).toString("hex")}` } });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => { if (url !== connectionPage && (!origin || new URL(url).origin !== origin)) event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ipcMain.handle("client:connection", (event) => { validate(event, true); return { origin: saved?.origin, name: saved?.name, saved: !!saved, error: connectionError }; });
    ipcMain.handle("client:connect", async (event, settings) => { validate(event, true); try { await login(settings); } catch (error) { connectionError = error.message; throw error; } });
    ipcMain.handle("client:disconnect", async (event) => {
      validate(event); await stopNode();
      if (saved) await request(saved.origin, "/api/client/logout", {}, saved.token).catch(() => {});
      // Remove the local grant only after its in-flight execution is stopped.
      const resources = app.isPackaged ? process.resourcesPath : path.join(root, "dist-personal");
      const { clearClientGrant } = await import(pathToFileURL(path.join(resources, "client-node", "client-node.js")).href);
      clearClientGrant(path.join(app.getPath("userData"), "device"));
      saved = undefined; origin = undefined; approvedRoot = undefined;
      if (existsSync(credentials)) unlinkSync(credentials);
      await window.webContents.session.clearStorageData(); await window.loadURL(connectionPage);
    });
    ipcMain.handle("client:folder", async (event) => { validate(event); const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] }); approvedRoot = result.canceled ? undefined : result.filePaths[0]; return approvedRoot ?? null; });
    ipcMain.handle("client:node-state", (event) => { validate(event); return device?.node.publicState() ?? { status: "未连接", origin: "", root: "", exec: false, connected: false, unknownCalls: [] }; });
    ipcMain.handle("client:node-config", async (event, settings) => {
      validate(event); if (!device || coreOrigin(settings.origin) !== origin) throw new Error("本机 Device Node 必须连接当前 Core");
      if (settings.root && settings.root !== device.node.config?.root && settings.root !== approvedRoot) throw new Error("请点击目录按钮，在本机选择允许共享的目录");
      if (settings.exec === true && !device.node.config?.exec) { const consent = await dialog.showMessageBox(window, { type: "warning", message: "允许此 Core 在本机执行终端命令？", detail: "命令拥有你的 Windows 用户权限，不受共享目录限制。每次执行仍须在 Agent 消息中批准。", buttons: ["取消", "允许"], defaultId: 0, cancelId: 0 }); if (consent.response !== 1) throw new Error("未授予本机终端权限"); }
      if (settings.computer === true && !device.node.config?.computer) { const consent = await dialog.showMessageBox(window, { type: "warning", message: "允许此 Core 查看和控制本机窗口？", detail: "窗口截图会发送给你在 Core 配置的模型。点击、输入等操作仍须在执行 Agent 的消息中批准。", buttons: ["取消", "允许"], defaultId: 0, cancelId: 0 }); if (consent.response !== 1) throw new Error("未授予本机屏幕控制权限"); }
      return device.node.configure(settings);
    });
    ipcMain.handle("client:node-reconcile", (event, settings) => { validate(event); device?.node.reconcile(settings.callId, settings.version); });
    ipcMain.handle("client:external", async (event, value) => { validate(event); const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid URL"); await shell.openExternal(url.href); });
    ipcMain.handle("client:quit", (event) => { validate(event); setTimeout(() => app.quit(), 50); });
    await window.loadURL(connectionPage);
    if (profile && process.env.NEX_CLIENT_SMOKE_OUTPUT) writeFileSync(process.env.NEX_CLIENT_SMOKE_OUTPUT, JSON.stringify({ pid: process.pid, profile: app.getPath("userData") }));
    if (saved) try { await login({ resume: true }); } catch (error) { connectionError = error.message; await window.reload(); }
  }).catch((error) => { dialog.showErrorBox("NexBot Client 无法启动", error.message); app.quit(); });
}
