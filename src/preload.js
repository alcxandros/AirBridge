'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  // Dropped files: the sandboxed page can't see paths, so resolve them here.
  shareFiles: (files) => ipcRenderer.invoke('share-paths', files.map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  chooseShareFiles: () => ipcRenderer.invoke('choose-share-files'),
  unshare: (id) => ipcRenderer.invoke('unshare', id),
  sendClipboard: () => ipcRenderer.invoke('send-clipboard'),
  copyText: (t) => ipcRenderer.invoke('copy-text', t),
  openLink: (u) => ipcRenderer.invoke('open-link', u),
  addToObs: (pw) => ipcRenderer.invoke('add-to-obs', pw),
  forgetDevice: (id) => ipcRenderer.invoke('forget-device', id),
  cast: (on) => ipcRenderer.invoke('cast', on),
  screenshot: () => ipcRenderer.invoke('screenshot'),
  chooseRecordFolder: () => ipcRenderer.invoke('choose-record-folder'),
  openRecordFolder: () => ipcRenderer.invoke('open-record-folder'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onLog: (cb) => ipcRenderer.on('log', (_e, l) => cb(l)),
});
