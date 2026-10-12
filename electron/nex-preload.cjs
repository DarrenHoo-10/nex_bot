const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("nex", {
  rememberLogin: (session) => ipcRenderer.invoke("nex:remember-login", session),
  forgetLogin: () => ipcRenderer.invoke("nex:forget-login"),
  chooseFolder: () => ipcRenderer.invoke("nex:folder"),
  openData: () => ipcRenderer.invoke("nex:data"),
  openExternal: (url) => ipcRenderer.invoke("nex:external", url),
  configureNetwork: (settings) => ipcRenderer.invoke("nex:network", settings),
  preferences: () => ipcRenderer.invoke("nex:preferences"),
  savePreferences: (settings) => ipcRenderer.invoke("nex:save-preferences", settings),
  quit: () => ipcRenderer.invoke("nex:quit"),
  closeWindow: () => ipcRenderer.invoke("nex:close-window"),
});
