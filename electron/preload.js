// Exposes a tiny, safe bridge for app updates to the (sandboxed) page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apidockUpdater', {
  version: () => ipcRenderer.invoke('update:version'),
  check: () => ipcRenderer.invoke('update:check'),
  // Downloads the update, then restarts into the new version.
  install: () => ipcRenderer.invoke('update:install'),
  onStatus: (cb) => {
    const listener = (_e, status) => cb(status);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
});
