// 화면(renderer)에 노출하는 최소한의 기능. Node 기능은 넘기지 않는다(contextIsolation + sandbox).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chzzk', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setServerUrl: (url) => ipcRenderer.invoke('config:set-server', url),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  reportSmoke: (result) => ipcRenderer.invoke('smoke:result', result),
});
