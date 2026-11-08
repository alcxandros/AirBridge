'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, clipboard, safeStorage, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const { Settings } = require('./settings');
const { Receiver } = require('./receiver');
const { PhoneServer } = require('./phoneServer');
const { Helper } = require('./helper');
const { addMirrorToObs } = require('./obs');
const { lanAddresses, publicNetworks } = require('./netinfo');

// Development: AIRBRIDGE_PROFILE=<dir> runs a separate copy with its own
// settings, so it can run next to an installed AirBridge.
if (process.env.AIRBRIDGE_PROFILE && !app.isPackaged) app.setPath('userData', path.resolve(process.env.AIRBRIDGE_PROFILE));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let tray = null;
let quitting = false;
let settings;
let receiver;
let phone;
let helper;
let uploadError = '';
let chosenAddress = null;
let publicNets = [];
let audioOutputs = [];
let phoneClients = 0;
let pcClip = null; // { text, at } sent to the phone
const received = []; // files uploaded from the phone
const shared = []; // files shared to the phone: { id, path, name, size }
const phoneTexts = []; // clipboard texts received from the phone
const links = []; // links received from the phone

async function refreshNetworks() {
  publicNets = await publicNetworks();
  pushState();
}

async function refreshAudioOutputs() {
  audioOutputs = await helper.audioOutputs();
  pushState();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function phoneUrl() {
  const addrs = lanAddresses();
  const addr = addrs.find((a) => a.address === chosenAddress) || addrs[0];
  if (!addr || !phone.port) return null;
  return `http://${addr.address}:${phone.port}/?t=${phone.token}`;
}

async function snapshot() {
  const url = phoneUrl();
  const { obsPasswordEnc, ...publicSettings } = settings.all();
  return {
    settings: { ...publicSettings, hasObsPassword: !!obsPasswordEnc },
    receiver: receiver.status(),
    uploads: {
      url,
      qr: url ? await QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: 'M' }) : null,
      port: phone.port,
      error: uploadError,
      addresses: lanAddresses(),
      chosenAddress: chosenAddress || (lanAddresses()[0] || {}).address || null,
    },
    received,
    shared: shared.map(({ id, name, size }) => ({ id, name, size })),
    pcClip,
    phoneTexts,
    links,
    phoneClients,
    remoteAvailable: helper.available(),
    audioOutputs,
    publicNetworks: publicNets,
    log: receiver.logTail.slice(-200),
    version: app.getVersion(),
  };
}

async function pushState() {
  send('state', await snapshot());
}

function notify(title, body) {
  if (Notification.isSupported() && (!win || !win.isFocused())) new Notification({ title, body, silent: true }).show();
}

async function startPhoneServer() {
  await phone.stop();
  uploadError = '';
  const wanted = settings.get('uploadPort');
  try {
    await phone.start(wanted);
  } catch (e) {
    // Port taken: fall back to any free port (the QR code carries it anyway).
    try {
      await phone.start(0);
      uploadError = `Port ${wanted} was busy, using ${phone.port} instead.`;
    } catch (e2) {
      uploadError = `Phone server failed: ${e2.message}`;
    }
  }
}

function addShared(paths) {
  for (const p of paths) {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile() || shared.some((s) => s.path === p)) continue;
    shared.unshift({ id: crypto.randomBytes(8).toString('hex'), path: p, name: path.basename(p), size: st.size });
  }
  shared.splice(200);
  phone.broadcast();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 820,
    minWidth: 760,
    minHeight: 600,
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
  // Dropping files anywhere must not navigate the window away.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
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
    { label: 'Send clipboard to phone', click: () => sendClipboardToPhone() },
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

// Electron 45's clipboard API is async (readText/writeText return Promises).
async function sendClipboardToPhone() {
  const text = await clipboard.readText();
  if (typeof text !== 'string' || !text) return false;
  pcClip = { text: text.slice(0, 100000), at: Date.now() };
  phone.broadcast();
  pushState();
  return true;
}

app.on('second-instance', () => {
  if (win) {
    win.show();
    win.focus();
  }
});

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData');
  const resourcesPath = app.isPackaged ? process.resourcesPath : null;
  const appRoot = path.join(__dirname, '..');
  settings = new Settings(dataDir);
  receiver = new Receiver({ resourcesPath, appRoot, dataDir });
  helper = new Helper({ resourcesPath, appRoot });
  phone = new PhoneServer({
    getUploadDir: () => settings.get('uploadDir'),
    isEnabled: () => settings.get('uploadsEnabled'),
    remoteEnabled: () => settings.get('remoteEnabled') && helper.available(),
    getShared: () => shared,
    getClip: () => pcClip,
    maxFileBytes: settings.get('maxFileGB') * 1024 ** 3,
    deviceName: settings.get('deviceName'),
  });

  receiver.on('status', pushState);
  receiver.on('log', (line) => send('log', line));
  phone.on('file', (entry) => {
    received.unshift(entry);
    received.splice(100);
    pushState();
  });
  phone.on('clipboard', ({ text }) => {
    phoneTexts.unshift({ text, at: Date.now() });
    phoneTexts.splice(20);
    if (settings.get('autoCopyClipboard')) {
      Promise.resolve(clipboard.writeText(text)).catch(() => {});
      notify('Copied from phone', text.slice(0, 120));
    }
    pushState();
  });
  phone.on('link', ({ url }) => {
    const opened = settings.get('autoOpenLinks');
    links.unshift({ url, at: Date.now(), opened });
    links.splice(30);
    if (opened) shell.openExternal(url);
    else notify('Link from phone', url);
    pushState();
  });
  phone.on('input', (line) => helper.input(line));
  phone.on('clients', (n) => {
    phoneClients = n;
    if (n === 0) helper.stopInput();
    pushState();
  });

  createWindow();
  createTray();
  await startPhoneServer();
  if (settings.get('receiverEnabled')) receiver.start(settings.all());
  pushState();
  refreshNetworks();
  refreshAudioOutputs();
  win.on('show', () => {
    refreshNetworks();
    refreshAudioOutputs();
  });
});

app.on('before-quit', async (e) => {
  quitting = true;
  if (helper) helper.stopInput();
  if (receiver && receiver.proc) {
    e.preventDefault();
    await receiver.stop();
    app.quit();
  }
});

// ---- IPC from the renderer ----

ipcMain.handle('get-state', () => snapshot());

ipcMain.handle('update-settings', async (_e, patch) => {
  delete patch.obsPasswordEnc; // only set through 'add-to-obs'
  const before = settings.all();
  if (patch.requirePin && !settings.get('pin')) {
    patch.pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  }
  const after = settings.update(patch);
  phone.opts.deviceName = after.deviceName;
  if (before.remoteEnabled && !after.remoteEnabled) helper.stopInput();

  const receiverKeys = ['deviceName', 'requirePin', 'pin', 'fullscreen', 'h265', 'audioMode', 'audioDevice', 'keepWindowOpen'];
  const receiverChanged = receiverKeys.some((k) => before[k] !== after[k]);
  if (before.receiverEnabled !== after.receiverEnabled) {
    if (after.receiverEnabled) receiver.restart(after);
    else await receiver.stop();
  } else if (receiverChanged && after.receiverEnabled) {
    receiver.restart(after);
  }
  phone.broadcast();
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
ipcMain.handle('open-folder', () => shell.openPath(settings.get('uploadDir')));
ipcMain.handle('show-file', (_e, p) => {
  // Only reveal files this session actually received or shared.
  if (received.some((r) => r.path === p)) shell.showItemInFolder(p);
});
ipcMain.handle('new-link', () => {
  phone.rotateToken();
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

// Files for the phone to download
ipcMain.handle('share-paths', (_e, paths) => {
  if (Array.isArray(paths)) addShared(paths.filter((p) => typeof p === 'string'));
  return snapshot();
});
ipcMain.handle('choose-share-files', async () => {
  const res = await dialog.showOpenDialog(win, { title: 'Choose files to send to the phone', properties: ['openFile', 'multiSelections'] });
  if (!res.canceled) addShared(res.filePaths);
  return snapshot();
});
ipcMain.handle('unshare', (_e, id) => {
  const i = shared.findIndex((s) => s.id === id);
  if (i >= 0) shared.splice(i, 1);
  phone.broadcast();
  return snapshot();
});

// Clipboard and links
ipcMain.handle('send-clipboard', async () => ({ ok: await sendClipboardToPhone() }));
ipcMain.handle('copy-text', (_e, text) => clipboard.writeText(String(text)));
ipcMain.handle('open-link', (_e, url) => {
  if (links.some((l) => l.url === url)) shell.openExternal(url);
});

// OBS
ipcMain.handle('add-to-obs', async (_e, password) => {
  let pw = typeof password === 'string' ? password : '';
  const canEncrypt = safeStorage.isEncryptionAvailable();
  if (!pw && settings.get('obsPasswordEnc') && canEncrypt) {
    try {
      pw = safeStorage.decryptString(Buffer.from(settings.get('obsPasswordEnc'), 'base64'));
    } catch {
      pw = '';
    }
  }
  try {
    const res = await addMirrorToObs({ password: pw });
    if (pw && canEncrypt) settings.update({ obsPasswordEnc: safeStorage.encryptString(pw).toString('base64') });
    // OBS can only capture the window while it exists, so keep it open between sessions.
    if (!settings.get('keepWindowOpen')) {
      settings.update({ keepWindowOpen: true });
      if (settings.get('receiverEnabled')) receiver.restart(settings.all());
    }
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
