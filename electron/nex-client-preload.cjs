const { contextBridge, ipcRenderer } = require("electron");
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
});
