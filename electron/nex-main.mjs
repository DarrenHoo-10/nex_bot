import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, Tray, Menu, Notification } from "electron";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profileArg = process.argv.find((arg) => arg.startsWith("--profile="))?.slice(10);
if (profileArg) app.setPath("userData", path.resolve(profileArg));
else app.setPath("userData", path.join(app.getPath("appData"), "NexBot"));
app.setName("NexBot");
const ownsLock = app.requestSingleInstanceLock();
let mainWindow, server, origin, tray, preferences, activeLogin, exiting = false;
const keepAlive = !profileArg || process.argv.includes("--background-fixture");
function showWindow() { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } }
const dataDir = path.join(app.getPath("userData"), "personal-os");
function validate(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw new Error("Invalid desktop sender");
}
async function validateBusiness(event) {
  validate(event);
  if (!activeLogin) throw new Error("请先登录");
  const response = await fetch(origin + "/api/auth/status", { headers: { Authorization: `Bearer ${activeLogin.token}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !(await response.json()).authenticated) throw new Error("登录已失效，请重新登录");
}
if (!ownsLock || process.argv.includes("--quit")) app.quit();
else {
  app.on("second-instance", (_event, args) => { if (args.includes("--quit")) app.quit(); else showWindow(); });
  app.on("before-quit", (event) => {
    if (exiting || !server) return;
    event.preventDefault(); exiting = true;
    const child = server;
    const shutdown = (graceful) => {
      if (profileArg && process.env.NEX_SMOKE_OUTPUT) writeFileSync(process.env.NEX_SMOKE_OUTPUT + ".shutdown.json", JSON.stringify({ graceful }));
      app.exit(0);
    };
    const timer = setTimeout(() => { child.kill(); shutdown(false); }, 45000);
    child.once("close", (code) => { clearTimeout(timer); shutdown(code === 0); });
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
    // Structured errors use IPC. Unread diagnostic pipes can retain handles
    // and delay the child's close event, particularly after Windows shutdown.
    server = fork(entry, [], { execArgv: [], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: dataDir, USERPROFILE: app.getPath("home"), ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const boot = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Core 启动超时")), 30_000);
      server.once("error", reject);
      server.on("message", (event) => { if (event.type === "ready") { clearTimeout(timer); resolve(event.origin); } if (event.type === "error") { clearTimeout(timer); reject(new Error(event.error)); } });
      server.once("exit", () => { if (!origin) reject(new Error("Core 启动失败")); else if (!exiting) dialog.showErrorBox("NexBot Core 已停止", "后台运行意外中断，请重启应用；持久化任务与审批会保留。"); });
    });
    const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) ?? network.port);
    const publicOrigin = process.argv.find((arg) => arg.startsWith("--public-origin="))?.slice(16);
    let identity;
    if (profileArg && process.env.NEX_IDENTITY_FIXTURE_URL) {
      const fixture = new URL(process.env.NEX_IDENTITY_FIXTURE_URL);
      if (fixture.protocol !== "http:" || fixture.hostname !== "127.0.0.1" || fixture.pathname !== "/" || fixture.username || fixture.password || fixture.search || fixture.hash) throw new Error("Invalid isolated identity fixture");
      identity = { fixtureOrigin: fixture.origin };
    }
    server.send({ type: "boot", dir: dataDir, key, token, uiDir: path.join(resources, "ui"), host: process.argv.includes("--lan") || network.enabled ? "0.0.0.0" : "127.0.0.1", port, ...(publicOrigin ? { publicOrigin } : {}), ...(identity ? { identity } : {}), ...(profileArg && process.argv.includes("--memory-fixture-disabled") ? { memoryRuntime: false } : {}) });
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
    const loginFile = path.join(app.getPath("userData"), "account-session.bin");
    async function rememberLogin(login) {
      if (!login || typeof login.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(login.token)) throw new Error("Invalid login session");
      const result = await fetch(origin + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: login.token }), signal: AbortSignal.timeout(10_000) });
      const verified = await result.json();
      if (!result.ok || !verified.authenticated || verified.coreId !== login.coreId || verified.sessionId !== login.sessionId) throw new Error("登录已失效，请重新登录");
      activeLogin = { token: login.token, coreId: verified.coreId, sessionId: verified.sessionId, expiresAt: verified.expiresAt };
      writeFileSync(loginFile, safeStorage.encryptString(JSON.stringify(activeLogin)), { mode: 0o600 });
      await mainWindow.webContents.session.cookies.set({ url: origin, name: "nex", value: login.token, httpOnly: true, sameSite: "strict", path: "/", expirationDate: Number(verified.expiresAt) / 1000 });
    }
    ipcMain.handle("nex:remember-login", async (event, login) => { validate(event); await rememberLogin(login); });
    ipcMain.handle("nex:forget-login", async (event) => { validate(event); activeLogin = undefined; if (existsSync(loginFile)) unlinkSync(loginFile); await mainWindow.webContents.session.clearStorageData(); });
    if (existsSync(loginFile)) try { await rememberLogin(JSON.parse(safeStorage.decryptString(readFileSync(loginFile)))); } catch { activeLogin = undefined; unlinkSync(loginFile); await mainWindow.webContents.session.clearStorageData(); }
    ipcMain.handle("nex:folder", async (event) => { await validateBusiness(event); const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] }); return result.canceled ? null : result.filePaths[0]; });
    ipcMain.handle("nex:data", async (event) => { await validateBusiness(event); await shell.openPath(dataDir); });
    ipcMain.handle("nex:preferences", (event) => { validate(event); return preferences; });
    ipcMain.handle("nex:save-preferences", async (event, settings) => {
      await validateBusiness(event);
      if (typeof settings.openAtLogin !== "boolean" || typeof settings.notifications !== "boolean") throw new Error("无效的常驻设置");
      const next = { openAtLogin: settings.openAtLogin, notifications: settings.notifications };
      if (!profileArg) app.setLoginItemSettings({ openAtLogin: next.openAtLogin, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: [] });
      writeFileSync(preferencesFile, JSON.stringify(next), { mode: 0o600 }); preferences = next;
    });
    ipcMain.handle("nex:quit", (event) => { validate(event); setTimeout(() => app.quit(), 50); });
    ipcMain.handle("nex:close-window", (event) => { validate(event); setTimeout(() => mainWindow.close(), 50); });
    ipcMain.handle("nex:network", async (event, settings) => {
      await validateBusiness(event);
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
