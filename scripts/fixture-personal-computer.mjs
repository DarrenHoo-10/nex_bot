// The only native input target in the computer smoke: a disposable blank form.
import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import path from "node:path";
const profile = process.argv.find((a) => a.startsWith("--profile="))?.slice(10);
const output = process.argv.find((a) => a.startsWith("--output="))?.slice(9);
if (!profile || !output || !path.basename(profile).startsWith("nex-computer-target-")) throw new Error("A disposable computer target is required");
app.setPath("userData", profile);
let window;
void app.whenReady().then(async () => {
window = new BrowserWindow({ width: 640, height: 400, title: "NexBot synthetic computer target", autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
globalThis.syntheticComputerWindow = window;
window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
window.webContents.on("will-navigate", (event) => event.preventDefault());
await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent('<title>NexBot synthetic computer target</title><style>body{font:20px sans-serif;margin:24px;background:white}h1{font-size:24px;margin:0 0 20px}textarea{display:block;margin-top:20px;width:100%;box-sizing:border-box;height:180px;font:22px sans-serif}</style><h1>Synthetic computer fixture</h1><label for="test">Synthetic input target</label><textarea id="test" aria-label="Synthetic input target"></textarea>'));
const hwnd = window.getNativeWindowHandle();
window.showInactive();
process.on("message", (message) => {
  if (message?.type === "minimize") { window.minimize(); writeFileSync(output + ".minimized.json", JSON.stringify({ minimized: window.isMinimized() })); }
  if (message?.type === "state") writeFileSync(output + ".restored.json", JSON.stringify({ minimized: window.isMinimized() }));
});
writeFileSync(output, JSON.stringify({ pid: process.pid, windowId: Number(hwnd.length === 8 ? hwnd.readBigUInt64LE() : hwnd.readUInt32LE()), profile, visible: window.isVisible(), title: window.getTitle() }));
app.on("window-all-closed", () => app.quit());
});
