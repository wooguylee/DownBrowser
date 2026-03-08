const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('downbrowser', {
  getState: () => ipcRenderer.invoke('downbrowser:get-state'),
  act: (action, payload) => ipcRenderer.invoke('downbrowser:action', action, payload),
  pickOutputDir: () => ipcRenderer.invoke('downbrowser:pick-output-dir'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('downbrowser:state', listener);
    return () => ipcRenderer.removeListener('downbrowser:state', listener);
  },
  onLog: (callback) => {
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on('downbrowser:log', listener);
    return () => ipcRenderer.removeListener('downbrowser:log', listener);
  },
});
