import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, Tray, Menu, Notification } from "electron";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profileArg = process.argv.find((arg) => arg.startsWith("--profile="))?.slice(10);
if (profileArg) app.setPath("userData", path.resolve(profileArg));
else app.setPath("userData", path.join(app.getPath("appData"), "NexBot"));
app.setName("NexBot");
const ownsLock = app.requestSingleInstanceLock();
let mainWindow, server, origin, tray, preferences, exiting = false;
const keepAlive = !profileArg || process.argv.includes("--background-fixture");
function showWindow() { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } }
const dataDir = path.join(app.getPath("userData"), "personal-os");
function validate(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || new URL(event.senderFrame.url).origin !== origin) throw new Error("Invalid desktop sender");
}
if (!ownsLock || process.argv.includes("--quit")) app.quit();
else {
  app.on("second-instance", (_event, args) => { if (args.includes("--quit")) app.quit(); else showWindow(); });
  app.on("before-quit", (event) => {
    if (exiting || !server) return;
    event.preventDefault(); exiting = true;
    const child = server;
    const timer = setTimeout(() => { child.kill(); app.exit(0); }, 45000);
    child.once("close", () => { clearTimeout(timer); app.exit(0); });
    if (child.connected) child.send({ type: "quit" }); else child.kill();
  });
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(async () => {
    mkdirSync(app.getPath("userData"), { recursive: true, mode: 0o700 });
    const keyPath = path.join(app.getPath("userData"), "vault-key.bin");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统加密存储不可用，无法安全保存 API Key。");
    let key;
    if (existsSync(keyPath)) key = safeStorage.decryptString(readFileSync(keyPath));
    else { key = randomBytes(32).toString("base64"); writeFileSync(keyPath, safeStorage.encryptString(key), { mode: 0o600 }); }
    const token = randomBytes(32).toString("base64url");
    const networkFile = path.join(app.getPath("userData"), "network.json");
    const network = existsSync(networkFile) ? JSON.parse(readFileSync(networkFile, "utf8")) : { enabled: false, port: 8799 };
    const resources = app.isPackaged ? process.resourcesPath : path.join(root, "dist-personal");
    const preferencesFile = path.join(app.getPath("userData"), "preferences.json");
    preferences = existsSync(preferencesFile) ? JSON.parse(readFileSync(preferencesFile, "utf8")) : { openAtLogin: false, notifications: !profileArg };
    if (keepAlive) {
      tray = new Tray(app.isPackaged ? path.join(resources, "icon.ico") : path.join(root, "build", "icon.ico"));
      tray.setToolTip("NexBot · 个人 Agent 正在运行");
      tray.setContextMenu(Menu.buildFromTemplate([{ label: "打开 NexBot", click: showWindow }, { type: "separator" }, { label: "退出 NexBot", click: () => app.quit() }]));
      tray.on("double-click", showWindow);
    }
    const entry = path.join(resources, "core", "index.js");
    server = fork(entry, [], { execArgv: [], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: dataDir, USERPROFILE: app.getPath("home"), ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const boot = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Core 启动超时")), 30_000);
      server.once("error", reject);
      server.on("message", (event) => { if (event.type === "ready") { clearTimeout(timer); resolve(event.origin); } if (event.type === "error") { clearTimeout(timer); reject(new Error(event.error)); } });
      server.once("exit", () => { if (!origin) reject(new Error("Core 启动失败")); else if (!exiting) dialog.showErrorBox("NexBot Core 已停止", "后台运行意外中断，请重启应用；持久化任务与审批会保留。"); });
    });
    const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) ?? network.port);
    server.send({ type: "boot", dir: dataDir, key, token, uiDir: path.join(resources, "ui"), host: process.argv.includes("--lan") || network.enabled ? "0.0.0.0" : "127.0.0.1", port, ...(profileArg && process.argv.includes("--memory-fixture-disabled") ? { memoryRuntime: false } : {}) });
    origin = await boot;
    server.on("message", (event) => {
      if (event.type !== "inbox" || !mainWindow || exiting) return;
      tray?.setToolTip(`NexBot · ${event.unread ? event.unread + " 条未读消息" : "个人 Agent 正在运行"}`);
      if (!mainWindow.isFocused() && preferences.notifications && Notification.isSupported()) {
        const notice = new Notification({ title: String(event.name ?? "NexBot"), body: "有新的任务消息，打开 NexBot 查看。" });
        notice.on("click", showWindow); notice.show();
      }
    });
    mainWindow = new BrowserWindow({ width: 1240, height: 880, minWidth: 760, minHeight: 600, title: "NexBot · Personal AI OS", backgroundColor: "#fafbf9", autoHideMenuBar: true, show: false, webPreferences: { preload: path.join(root, "electron", "nex-preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mainWindow.webContents.on("will-navigate", (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
    mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ipcMain.handle("nex:folder", async (event) => { validate(event); const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] }); return result.canceled ? null : result.filePaths[0]; });
    ipcMain.handle("nex:data", async (event) => { validate(event); await shell.openPath(dataDir); });
    ipcMain.handle("nex:preferences", (event) => { validate(event); return preferences; });
    ipcMain.handle("nex:save-preferences", (event, settings) => {
      validate(event);
      if (typeof settings.openAtLogin !== "boolean" || typeof settings.notifications !== "boolean") throw new Error("无效的常驻设置");
      const next = { openAtLogin: settings.openAtLogin, notifications: settings.notifications };
      if (!profileArg) app.setLoginItemSettings({ openAtLogin: next.openAtLogin, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: [] });
      writeFileSync(preferencesFile, JSON.stringify(next), { mode: 0o600 }); preferences = next;
    });
    ipcMain.handle("nex:quit", (event) => { validate(event); setTimeout(() => app.quit(), 50); });
    ipcMain.handle("nex:close-window", (event) => { validate(event); setTimeout(() => mainWindow.close(), 50); });
    ipcMain.handle("nex:network", async (event, settings) => {
      validate(event);
      if (!Number.isSafeInteger(settings.port) || settings.port < 1024 || settings.port > 65535 || typeof settings.enabled !== "boolean") throw new Error("无效的网络配置");
      writeFileSync(networkFile, JSON.stringify({ enabled: settings.enabled, port: settings.port }), { mode: 0o600 });
      app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== "--lan" && !arg.startsWith("--port=")) });
      app.quit();
    });
    ipcMain.handle("nex:external", async (event, url) => { validate(event); const parsed = new URL(url); if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Invalid URL"); await shell.openExternal(parsed.href); });
    mainWindow.once("ready-to-show", () => mainWindow.show());
    mainWindow.on("close", (event) => { if (keepAlive && !exiting) { event.preventDefault(); mainWindow.hide(); } });
    await mainWindow.loadURL(`${origin}/#token=${encodeURIComponent(token)}`);
    // Only explicit disposable fixture launches expose smoke metadata. The
    // profile requirement keeps tests away from the installed user's workspace.
    if (process.env.NEX_SMOKE_OUTPUT && profileArg) {
      writeFileSync(process.env.NEX_SMOKE_OUTPUT, JSON.stringify({ origin, token, dataDir, pid: process.pid }));
    }
  }).catch((error) => { dialog.showErrorBox("NexBot 无法启动", error.message); app.quit(); });
}
