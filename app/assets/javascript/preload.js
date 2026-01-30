const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  startSync: (data) => ipcRenderer.send('start-sync', data),
  permanentlyDeleteSetting: (data) => ipcRenderer.send('permanently-delete-setting', data),
  onSyncUpdate: (callback) => ipcRenderer.on('sync-update', callback),
  onSyncEnd: (callback) => ipcRenderer.on('sync-end', callback),
  onSyncEnable: (callback) => ipcRenderer.on('sync-enable', callback),
  onError: (callback) => ipcRenderer.on('error', callback)
});
