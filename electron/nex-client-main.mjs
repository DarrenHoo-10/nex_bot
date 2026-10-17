import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = process.argv.find((a) => a.startsWith("--profile="))?.slice(10);
app.setName(process.platform === "darwin" && profile ? "NexBot Client Fixture " + createHash("sha256").update(profile).digest("hex").slice(0, 12) : "NexBot Client");
app.setPath("userData", profile ? path.resolve(profile) : path.join(app.getPath("appData"), "NexBotClient"));
const defaultOrigin = process.env.NEX_CLIENT_DEFAULT_ORIGIN || "https://bot.nexorai.com.cn";
let window, saved, origin, connectionError = "", resuming = false, loginEpoch = 0, repointed = false;
const cancelled = Object.assign(new Error("已取消"), { cancelled: true });
const credentials = path.join(app.getPath("userData"), "connection.bin");
const connectionPage = pathToFileURL(path.join(root, "electron", "client", "index.html")).href;
function validate(event, localOnly = false) {
  const url = event.senderFrame?.url;
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || (url !== connectionPage && (localOnly || !origin || new URL(url).origin !== origin))) throw new Error("Invalid client sender");
}
function coreOrigin(value) {
  const url = new URL(value);
  const privateHost = ["localhost", "[::1]"].includes(url.hostname) || (isIP(url.hostname) === 4 && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname));
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(url.protocol === "http:" && privateHost))) throw new Error("请填写 HTTPS 或私有网络 HTTP 的 Core 根地址");
  return url.origin;
}
async function request(address, route, data, token) {
  const response = await fetch(address + route, { method: data ? "POST" : "GET", headers: { ...(data ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}), redirect: "error", signal: AbortSignal.timeout(15_000) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error ?? "无法连接 Core"), { status: response.status });
  return result;
}
async function login(settings) {
  const old = saved, epoch = loginEpoch;
  const address = coreOrigin(settings.resume ? (saved?.origin || defaultOrigin) : (settings.origin || defaultOrigin));
  let session, identity;
  if (settings.resume) {
    // A token goes to the origin that issued it over HTTPS, so one round trip is enough; a re-pointed or plain-HTTP origin must prove its Core ID first.
    if (repointed || !address.startsWith("https:")) {
      identity = await request(address, "/api/client/identity");
      if (epoch !== loginEpoch) throw cancelled;
      if (identity.version !== 1 || !identity.coreId) throw new Error("Core 不支持客户端协议 v1");
      if (!old || old.coreId !== identity.coreId || identity.loginRequired !== true) throw Object.assign(new Error("Core 身份已变化，请重新登录"), { status: 409 });
    }
    if (!old) throw Object.assign(new Error("Core 身份已变化，请重新登录"), { status: 409 });
    session = await request(address, "/api/session", { token: old.token });
    if (epoch !== loginEpoch) throw cancelled;
    if (session.coreId !== old.coreId || !session.authenticated) throw Object.assign(new Error("Core 身份或登录状态不匹配"), { status: 409 });
    saved = old;
  } else {
    identity = await request(address, "/api/client/identity");
    if (epoch !== loginEpoch) throw cancelled;
    if (identity.version !== 1 || !identity.coreId) throw new Error("Core 不支持客户端协议 v1");
    const host = new URL(address).hostname;
    const localFixture = ["127.0.0.1", "localhost", "[::1]"].includes(host) || (isIP(host) === 4 && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host));
    if (!address.startsWith("https:") && !localFixture) throw new Error("账号登录需要 HTTPS 后端地址，请为服务配置 HTTPS 连接");
    if (identity.loginRequired !== true || !identity.loginMethods?.includes("password")) throw new Error("后端须启用 NexorAI 账号登录");
    if (!identity.initialized) throw new Error("后端尚未关联账号，请先在服务器运行 init 完成初始化");
    const transaction = await request(address, "/api/auth/start", { account: settings.email, name: settings.name });
    session = await request(address, "/api/auth/respond", { ...transaction, password: settings.password });
    if (session.coreId !== identity.coreId) throw new Error("Core 身份在登录期间发生变化");
    saved = { origin: address, name: String(settings.name), token: session.token, coreId: session.coreId, sessionId: session.sessionId, expiresAt: session.expiresAt };
    writeFileSync(credentials, safeStorage.encryptString(JSON.stringify(saved)), { mode: 0o600 });
  }
  // Resuming keeps the HTTP cache and the Agent view preferences in localStorage; a new login starts clean.
  // The cookie has no expiry, so Chromium never writes the token to disk (it is restored from connection.bin).
  if (!settings.resume) await window.webContents.session.clearStorageData({ storages: ["cookies", "localstorage", "indexdb", "websql", "filesystem", "serviceworkers", "cachestorage"] });
  await window.webContents.session.cookies.set({ url: address, name: "nex", value: saved.token, httpOnly: true, sameSite: "strict", secure: address.startsWith("https:"), path: "/" });
  origin = address;
  connectionError = "";
  resuming = false;
  await window.loadURL(origin + "/");
}
if (!app.requestSingleInstanceLock() || process.argv.includes("--quit")) app.quit();
else {
  app.on("second-instance", (_event, args) => { if (args.includes("--quit")) app.quit(); else { window?.show(); window?.focus(); } });
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(async () => {
    mkdirSync(app.getPath("userData"), { recursive: true });
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统加密存储不可用");
    if (existsSync(credentials)) saved = JSON.parse(safeStorage.decryptString(readFileSync(credentials)));
    const overrideOrigin = process.argv.find((a) => a.startsWith("--origin="))?.slice(9) ?? process.env.NEX_CORE_ORIGIN;
    const targetOrigin = overrideOrigin ? coreOrigin(overrideOrigin) : undefined;
    // An explicit override re-points a saved login; resume still verifies the Core ID before any token is sent.
    if (saved && targetOrigin && saved.origin !== targetOrigin) {
      saved = { ...saved, origin: targetOrigin }; repointed = true;
      writeFileSync(credentials, safeStorage.encryptString(JSON.stringify(saved)), { mode: 0o600 });
    }
    window = new BrowserWindow({ width: 1240, height: 880, minWidth: 760, minHeight: 600, title: "NexBot Client", autoHideMenuBar: true, webPreferences: { preload: path.join(root, "electron", "nex-client-preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, partition: `nex-client-${randomBytes(12).toString("hex")}` } });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => { if (url !== connectionPage && (!origin || new URL(url).origin !== origin)) event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ipcMain.handle("client:connection", (event) => { validate(event, true); return { origin: saved?.origin ?? targetOrigin ?? defaultOrigin, name: saved?.name || os.hostname() || "我的电脑", saved: !!saved, resuming, error: connectionError }; });
    ipcMain.handle("client:cancel-resume", (event) => { validate(event, true); loginEpoch++; resuming = false; });
    ipcMain.handle("client:connect", async (event, settings) => {
      validate(event, true); loginEpoch++; resuming = !!settings.resume;
      try { await login(settings); } catch (error) { resuming = false; if (!error.cancelled) connectionError = error.message; throw error; }
    });
    ipcMain.handle("client:remember-login", async (event, loginSession) => {
      validate(event);
      if (!saved || !loginSession || loginSession.coreId !== saved.coreId || !/^[A-Za-z0-9_-]{43}$/.test(loginSession.token)) throw new Error("Invalid login session");
      const verified = await request(origin, "/api/session", { token: loginSession.token });
      if (!verified.authenticated || verified.coreId !== saved.coreId || verified.sessionId !== loginSession.sessionId) throw new Error("登录已失效，请重新连接");
      saved = { ...saved, token: loginSession.token, sessionId: verified.sessionId, expiresAt: verified.expiresAt };
      writeFileSync(credentials, safeStorage.encryptString(JSON.stringify(saved)), { mode: 0o600 });
    });
    ipcMain.handle("client:forget-login", async (event) => {
      validate(event); if (existsSync(credentials)) unlinkSync(credentials);
      saved = undefined; origin = undefined; await window.webContents.session.clearStorageData(); await window.loadURL(connectionPage);
    });
    ipcMain.handle("client:disconnect", async (event) => {
      validate(event);
      if (saved) await request(saved.origin, "/api/auth/logout", {}, saved.token).catch(() => {});
      saved = undefined; origin = undefined;
      if (existsSync(credentials)) unlinkSync(credentials);
      await window.webContents.session.clearStorageData(); await window.loadURL(connectionPage);
    });
    ipcMain.handle("client:external", async (event, value) => { validate(event); const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid URL"); await shell.openExternal(url.href); });
    ipcMain.handle("client:quit", (event) => { validate(event); setTimeout(() => app.quit(), 50); });
    resuming = !!saved;
    await window.loadURL(connectionPage);
    if (profile && process.env.NEX_CLIENT_SMOKE_OUTPUT) writeFileSync(process.env.NEX_CLIENT_SMOKE_OUTPUT, JSON.stringify({ pid: process.pid, profile: app.getPath("userData") }));
    if (saved) try { await login({ resume: true }); } catch (error) {
      if (error.cancelled) return;
      resuming = false; connectionError = error.message;
      if ([401, 403, 409].includes(error.status)) { if (existsSync(credentials)) unlinkSync(credentials); saved = undefined; }
      await window.reload();
    }
  }).catch((error) => { dialog.showErrorBox("NexBot Client 无法启动", error.message); app.quit(); });
}
