'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('airbridge', {
  getState: () => ipcRenderer.invoke('get-state'),
  updateSettings: (patch) => ipcRenderer.invoke('update-settings', patch),
  newPin: () => ipcRenderer.invoke('new-pin'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  openNetworkSettings: () => ipcRenderer.invoke('open-network-settings'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  showFile: (p) => ipcRenderer.invoke('show-file', p),
  newLink: () => ipcRenderer.invoke('new-link'),
  chooseAddress: (a) => ipcRenderer.invoke('choose-address', a),
  restartReceiver: () => ipcRenderer.invoke('restart-receiver'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onLog: (cb) => ipcRenderer.on('log', (_e, l) => cb(l)),
});
