const { contextBridge, ipcRenderer } = require("electron");
if (process.platform === "win32" && process.isMainFrame) {
  window.addEventListener("DOMContentLoaded", () => {
    let previous;
    const syncTheme = () => {
      const dark = document.querySelector(".workspace-stage")?.getAttribute("data-dark") === "1";
      if (dark !== previous) { previous = dark; ipcRenderer.send("client:chrome-theme", dark); }
    };
    new MutationObserver(syncTheme).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-dark"] });
    syncTheme();
  });
}
contextBridge.exposeInMainWorld("nex", {
  mode: "client",
  deviceState: () => ipcRenderer.invoke("client:device-state"),
  setDevicePaused: (paused) => ipcRenderer.invoke("client:device-paused", paused),
  reconcileDevice: (id, version) => ipcRenderer.invoke("client:device-reconcile", id, version),
  stopDevice: () => ipcRenderer.invoke("client:device-stop"),
  listModels: (settings) => ipcRenderer.invoke("client:list-models", settings),
  rememberLogin: (session) => ipcRenderer.invoke("client:remember-login", session),
  forgetLogin: () => ipcRenderer.invoke("client:forget-login"),
  connect: (settings) => ipcRenderer.invoke("client:connect", settings),
  connection: () => ipcRenderer.invoke("client:connection"),
  cancelResume: () => ipcRenderer.invoke("client:cancel-resume"),
  disconnect: () => ipcRenderer.invoke("client:disconnect"),
  openExternal: (url) => ipcRenderer.invoke("client:external", url),
  preferences: () => Promise.resolve({ openAtLogin: false, notifications: false }),
  quit: () => ipcRenderer.invoke("client:quit"),
  closeWindow: () => ipcRenderer.invoke("client:quit"),
  updateState: () => ipcRenderer.invoke("client:update-state"),
  installUpdate: () => ipcRenderer.invoke("client:update-install"),
  onUpdateState: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, state) => { if (state && typeof state.status === "string") callback(state); };
    ipcRenderer.on("nex:update-state", listener);
    return () => ipcRenderer.removeListener("nex:update-state", listener);
  },
  onClipboardImage: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => {
      if (!payload || typeof payload.name !== "string" || typeof payload.type !== "string" || !payload.bytes) return;
      let bytes = payload.bytes;
      if (!(bytes instanceof Uint8Array)) {
        try { bytes = new Uint8Array(bytes); } catch { return; }
      }
      if (!bytes.byteLength) return;
      callback({ name: payload.name, type: payload.type, bytes });
    };
    ipcRenderer.on("nex:clipboard-image", listener);
    return () => ipcRenderer.removeListener("nex:clipboard-image", listener);
  },
});
