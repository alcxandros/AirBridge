'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const { Settings } = require('./settings');
const { Receiver } = require('./receiver');
const { UploadServer } = require('./uploadServer');
const { lanAddresses, publicNetworks } = require('./netinfo');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let tray = null;
let quitting = false;
let settings;
let receiver;
let uploads;
let uploadError = '';
let chosenAddress = null;
let publicNets = [];
const received = [];

async function refreshNetworks() {
  publicNets = await publicNetworks();
  pushState();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function uploadUrl() {
  const addrs = lanAddresses();
  const addr = addrs.find((a) => a.address === chosenAddress) || addrs[0];
  if (!addr || !uploads.port) return null;
  return `http://${addr.address}:${uploads.port}/?t=${uploads.token}`;
}

async function snapshot() {
  const url = uploadUrl();
  return {
    settings: settings.all(),
    receiver: receiver.status(),
    uploads: {
      url,
      qr: url ? await QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: 'M' }) : null,
      port: uploads.port,
      error: uploadError,
      addresses: lanAddresses(),
      chosenAddress: chosenAddress || (lanAddresses()[0] || {}).address || null,
    },
    received,
    publicNetworks: publicNets,
    log: receiver.logTail.slice(-200),
    version: app.getVersion(),
  };
}

async function pushState() {
  send('state', await snapshot());
}

async function startUploads() {
  await uploads.stop();
  uploadError = '';
  const wanted = settings.get('uploadPort');
  try {
    await uploads.start(wanted);
  } catch (e) {
    // Port taken: fall back to any free port (the QR code carries it anyway).
    try {
      await uploads.start(0);
      uploadError = `Port ${wanted} was busy, using ${uploads.port} instead.`;
    } catch (e2) {
      uploadError = `Upload server failed: ${e2.message}`;
    }
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    title: 'AirBridge',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Closing the window keeps the receiver running in the tray.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('AirBridge');
  const menu = Menu.buildFromTemplate([
    { label: 'Open AirBridge', click: () => win.show() },
    { label: 'Open upload folder', click: () => shell.openPath(settings.get('uploadDir')) },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => win.show());
}

app.on('second-instance', () => {
  if (win) {
    win.show();
    win.focus();
  }
});

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData');
  settings = new Settings(dataDir);
  receiver = new Receiver({
    resourcesPath: app.isPackaged ? process.resourcesPath : null,
    appRoot: path.join(__dirname, '..'),
    dataDir,
  });
  uploads = new UploadServer({
    getUploadDir: () => settings.get('uploadDir'),
    isEnabled: () => settings.get('uploadsEnabled'),
    maxFileBytes: settings.get('maxFileGB') * 1024 ** 3,
    deviceName: settings.get('deviceName'),
  });

  receiver.on('status', pushState);
  receiver.on('log', (line) => send('log', line));
  uploads.on('file', (entry) => {
    received.unshift(entry);
    received.splice(100);
    pushState();
  });

  createWindow();
  createTray();
  await startUploads();
  if (settings.get('receiverEnabled')) receiver.start(settings.all());
  pushState();
  refreshNetworks();
  win.on('show', refreshNetworks);
});

app.on('before-quit', async (e) => {
  quitting = true;
  if (receiver && receiver.proc) {
    e.preventDefault();
    await receiver.stop();
    app.quit();
  }
});

// ---- IPC from the renderer ----

ipcMain.handle('get-state', () => snapshot());

ipcMain.handle('update-settings', async (_e, patch) => {
  const before = settings.all();
  if (patch.requirePin && !settings.get('pin')) {
    patch.pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  }
  const after = settings.update(patch);
  uploads.opts.deviceName = after.deviceName;

  const receiverKeys = ['deviceName', 'requirePin', 'pin', 'fullscreen', 'h265', 'audioMode'];
  const receiverChanged = receiverKeys.some((k) => before[k] !== after[k]);
  if (before.receiverEnabled !== after.receiverEnabled) {
    if (after.receiverEnabled) receiver.restart(after);
    else await receiver.stop();
  } else if (receiverChanged && after.receiverEnabled) {
    receiver.restart(after);
  }
  return snapshot();
});

ipcMain.handle('new-pin', async () => {
  settings.update({ pin: String(crypto.randomInt(0, 10000)).padStart(4, '0') });
  if (settings.get('receiverEnabled')) receiver.restart(settings.all());
  return snapshot();
});

ipcMain.handle('choose-folder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose where received files are saved',
    defaultPath: settings.get('uploadDir'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!res.canceled && res.filePaths[0]) settings.update({ uploadDir: res.filePaths[0] });
  return snapshot();
});

ipcMain.handle('open-network-settings', () => shell.openExternal('ms-settings:network-status'));
ipcMain.handle('open-folder',() => shell.openPath(settings.get('uploadDir')));
ipcMain.handle('show-file', (_e, p) => {
  // Only reveal files this session actually received.
  if (received.some((r) => r.path === p)) shell.showItemInFolder(p);
});
ipcMain.handle('new-link', () => {
  uploads.rotateToken();
  return snapshot();
});
ipcMain.handle('choose-address', (_e, addr) => {
  if (lanAddresses().some((a) => a.address === addr)) chosenAddress = addr;
  return snapshot();
});
ipcMain.handle('restart-receiver', () => {
  receiver.restart(settings.all());
  return snapshot();
});
