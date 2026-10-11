const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("nex", {
  mode: "client",
  connect: (settings) => ipcRenderer.invoke("client:connect", settings),
  connection: () => ipcRenderer.invoke("client:connection"),
  disconnect: () => ipcRenderer.invoke("client:disconnect"),
  chooseFolder: () => ipcRenderer.invoke("client:folder"),
  nodeState: () => ipcRenderer.invoke("client:node-state"),
  configureNode: (settings) => ipcRenderer.invoke("client:node-config", settings),
  reconcileNode: (settings) => ipcRenderer.invoke("client:node-reconcile", settings),
  openExternal: (url) => ipcRenderer.invoke("client:external", url),
  preferences: () => Promise.resolve({ openAtLogin: false, notifications: false }),
  quit: () => ipcRenderer.invoke("client:quit"),
  closeWindow: () => ipcRenderer.invoke("client:quit"),
});
