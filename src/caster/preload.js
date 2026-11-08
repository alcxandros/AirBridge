'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('caster', {
  send: (msg) => ipcRenderer.send('caster-event', msg),
  onCommand: (cb) => ipcRenderer.on('caster-command', (_e, cmd) => cb(cmd)),
});
