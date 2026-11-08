'use strict';
const {
  app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, clipboard, safeStorage, Notification, desktopCapturer, screen,
} = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const { Settings } = require('./settings');
const { Receiver } = require('./receiver');
const { PhoneServer } = require('./phoneServer');
const { DeviceStore } = require('./devices');
const { Helper } = require('./helper');
const { addMirrorToObs } = require('./obs');
const tlsCa = require('./tls');
const { lanAddresses, publicNetworks } = require('./netinfo');
const { ScreenCaster } = require('./cast');
const { tapToAbsolute, unionRect } = require('./pointer');

// WebRTC to phones on the LAN: offer real host addresses instead of
// randomised .local names, which some networks can't resolve.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

// Development: AIRBRIDGE_PROFILE=<dir> runs a separate copy with its own
// settings, so it can run next to an installed AirBridge.
if (process.env.AIRBRIDGE_PROFILE && !app.isPackaged) app.setPath('userData', path.resolve(process.env.AIRBRIDGE_PROFILE));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Started by Windows at sign-in: stay in the tray.
const START_HIDDEN = process.argv.includes('--hidden');

let win = null;
let tray = null;
let quitting = false;
let settings;
let devices;
let receiver;
let phone;
let helper;
let uploadError = '';
let chosenAddress = null;
let publicNets = [];
let audioOutputs = [];
let phoneClients = 0;
let pcClip = null; // { text, at } sent to the phone
let tlsInfo = { enabled: false, port: null, fingerprint: null, error: '' };
let tlsIps = '';
let caPem = null;
let caKeyPem = null;
let caster;
let lastRecording = null;
let lastScreenshot = null;
const received = []; // files uploaded from the phone
const shared = []; // files shared to the phone: { id, path, name, size }
const phoneTexts = []; // clipboard texts received from the phone
const links = []; // links received from the phone

const ICON = path.join(__dirname, 'renderer', 'icon.png');

async function refreshNetworks() {
  publicNets = await publicNetworks();
  refreshTlsCert();
  pushState();
}

async function refreshAudioOutputs() {
  audioOutputs = await helper.audioOutputs();
  pushState();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function chosenLanAddress() {
  const addrs = lanAddresses();
  return addrs.find((a) => a.address === chosenAddress) || addrs[0] || null;
}

// The QR code always uses plain http: a phone that hasn't installed the local
// CA yet couldn't open an https link. The page then offers to switch to https.
function phoneUrl() {
  const addr = chosenLanAddress();
  if (!addr || !phone.port) return null;
  return `http://${addr.address}:${phone.port}/?t=${phone.token}`;
}

async function snapshot() {
  const url = phoneUrl();
  const { obsPasswordEnc, caKeyEnc, caCert, devices: _d, ...publicSettings } = settings.all();
  return {
    settings: { ...publicSettings, hasObsPassword: !!obsPasswordEnc },
    receiver: receiver.status(),
    uploads: {
      url,
      qr: url ? await QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: 'M' }) : null,
      port: phone.port,
      error: uploadError,
      addresses: lanAddresses(),
      chosenAddress: (chosenLanAddress() || {}).address || null,
    },
    devices: devices.list(),
    tls: tlsInfo,
    received,
    shared: shared.map(({ id, name, size }) => ({ id, name, size })),
    pcClip,
    phoneTexts,
    links,
    phoneClients,
    remoteAvailable: helper.available(),
    canStartWithWindows: app.isPackaged && process.platform === 'win32',
    lastRecording,
    lastScreenshot,
    cast: caster.state,
    displays: ScreenCaster.displays(),
    audioOutputs,
    publicNetworks: publicNets,
    log: receiver.logTail.slice(-200),
    version: app.getVersion(),
  };
}

let pushTimer = null;
async function pushState() {
  send('state', await snapshot());
  // The tray menu mirrors the same state; rebuild it at most a few times a second.
  if (!pushTimer) pushTimer = setTimeout(() => ((pushTimer = null), buildTrayMenu()), 250);
}

function notify(title, body, onClick) {
  if (!Notification.isSupported() || (win && win.isVisible() && win.isFocused())) return;
  const n = new Notification({ title, body, silent: true, icon: ICON });
  if (onClick) n.on('click', onClick);
  n.show();
}

// ---- Secrets (OBS password, CA key): OS-encrypted via safeStorage (DPAPI on Windows) ----

const secrets = {
  available: () => safeStorage.isAsyncEncryptionAvailable().catch(() => false),
  encrypt: async (text) => (await safeStorage.encryptStringAsync(text)).toString('base64'),
  /** Returns the plain text, or null if it can't be decrypted (e.g. copied from another PC). */
  decrypt: async (b64) => {
    try {
      return (await safeStorage.decryptStringAsync(Buffer.from(b64, 'base64'))).result;
    } catch {
      return null;
    }
  },
};

// ---- HTTPS: local CA + server certificate ----

async function loadOrCreateCa() {
  const canEncrypt = await secrets.available();
  if (settings.get('caCert') && settings.get('caKeyEnc') && canEncrypt) {
    const key = await secrets.decrypt(settings.get('caKeyEnc'));
    if (key) {
      caKeyPem = key;
      caPem = settings.get('caCert');
      return;
    }
  }
  const ca = tlsCa.createCa();
  caKeyPem = ca.keyPem;
  caPem = ca.certPem;
  // Without OS encryption the key is not stored; phones then re-install the CA after a restart.
  if (canEncrypt) settings.update({ caCert: caPem, caKeyEnc: await secrets.encrypt(caKeyPem) });
}

function serverCert() {
  const ips = lanAddresses().map((a) => a.address);
  tlsIps = ips.join(',');
  return tlsCa.issueServerCert({ caKeyPem, caCertPem: caPem, ips: ips.length ? ips : ['192.168.0.1'] });
}

// Re-issue the certificate when the PC's addresses change (new Wi-Fi, DHCP).
function refreshTlsCert() {
  if (!phone || !phone.tlsServer || !caPem) return;
  const ips = lanAddresses().map((a) => a.address).join(',');
  if (ips === tlsIps) return;
  const c = serverCert();
  phone.updateTls({ key: c.keyPem, cert: c.certPem });
}

async function startTls() {
  tlsInfo = { enabled: false, port: null, fingerprint: null, error: '' };
  if (!settings.get('httpsEnabled')) return;
  try {
    if (!caPem) await loadOrCreateCa();
    const c = serverCert();
    const wanted = settings.get('uploadPort') + 1;
    try {
      await phone.startTls(wanted, { key: c.keyPem, cert: c.certPem });
    } catch {
      await phone.startTls(0, { key: c.keyPem, cert: c.certPem });
    }
    tlsInfo = { enabled: true, port: phone.tlsPort, fingerprint: tlsCa.fingerprint(caPem), error: '' };
  } catch (e) {
    tlsInfo.error = `HTTPS unavailable: ${e.message}`;
  }
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
      uploadError = `Port ${wanted} was busy, using ${phone.port} instead. Remembered phones need the usual port, so close whatever is using it.`;
    } catch (e2) {
      uploadError = `Phone server failed: ${e2.message}`;
    }
  }
  await startTls();
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

// ---- Screenshots of the mirror window ----

function stamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
}

async function takeScreenshot() {
  const pid = receiver.proc && receiver.proc.pid;
  if (!pid) return { ok: false, error: 'Screen mirroring is off.' };
  const wins = (await helper.windowsOf(pid)).filter((w) => w.width > 0 && w.height > 0);
  const w = wins.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!w) return { ok: false, error: 'No mirror window yet. Start mirroring from the phone first.' };
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: w.width, height: w.height } });
  const src = sources.find((s) => s.id.startsWith(`window:${w.hwnd}:`));
  if (!src || src.thumbnail.isEmpty()) return { ok: false, error: 'Could not capture the mirror window. Is it minimised?' };
  const dir = settings.get('screenshotDir');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `AirBridge ${stamp()}.png`);
  fs.writeFileSync(file, src.thumbnail.toPNG());
  lastScreenshot = file;
  notify('Screenshot saved', path.basename(file), () => shell.showItemInFolder(file));
  pushState();
  return { ok: true, file };
}

// ---- Sharing the PC screen to phones ----

function castOptions() {
  return { audio: settings.get('castAudio'), quality: settings.get('castQuality'), displayId: settings.get('castDisplay') };
}

function startCast() {
  caster.start(castOptions());
}

function stopCast() {
  caster.stop();
}

/** Tap on the shared picture -> move the real cursor there and click. */
function clickAt({ x, y, b }) {
  if (!caster.state.active || process.platform !== 'win32') return;
  const phys = (d) => screen.dipToScreenRect(null, d.bounds);
  const display = phys(caster.display());
  const virtual = unionRect(screen.getAllDisplays().map(phys));
  const [ax, ay] = tapToAbsolute({ x, y }, display, virtual);
  helper.input(`a ${ax} ${ay}`);
  helper.input(`c ${b}`);
}

// ---- Windows sign-in ----

function applyStartWithWindows() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  app.setLoginItemSettings({ openAtLogin: !!settings.get('startWithWindows'), args: ['--hidden'] });
}

// ---- Window and tray ----

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 860,
    minWidth: 760,
    minHeight: 600,
    show: !START_HIDDEN,
    title: 'AirBridge',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: ICON,
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

function showWindow() {
  win.show();
  win.focus();
}

function receiverStatusText() {
  const rx = receiver.status();
  if (rx.state === 'running') return rx.client ? `Mirroring: connected to ${rx.client.name}` : 'Mirroring: ready';
  return {
    starting: 'Mirroring: starting…',
    stopped: 'Mirroring: off',
    error: 'Mirroring: problem (open AirBridge)',
    missing: 'Mirroring: engine missing',
  }[rx.state] || `Mirroring: ${rx.state}`;
}

const short = (s, n = 40) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function buildTrayMenu() {
  if (!tray) return;
  const status = receiverStatusText();
  const cs = caster.state;
  const castLabel = cs.active ? `Sharing screen to phone${cs.viewers ? ` (${cs.viewers} watching)` : ''}` : 'Share screen to phone';
  tray.setToolTip(`AirBridge — ${status.replace('Mirroring: ', '')}${cs.active ? ' · sharing your screen' : ''}`);
  const recent = received.slice(0, 5);
  const texts = phoneTexts.slice(0, 5);
  const menu = Menu.buildFromTemplate([
    { label: status, enabled: false },
    {
      label: 'Screen mirroring',
      type: 'checkbox',
      checked: settings.get('receiverEnabled'),
      click: (item) => updateSettings({ receiverEnabled: item.checked }),
    },
    { label: 'Take screenshot', enabled: !!receiver.status().client, click: () => takeScreenshot() },
    {
      label: 'Record sessions',
      type: 'checkbox',
      checked: settings.get('recordSessions'),
      click: (item) => updateSettings({ recordSessions: item.checked }),
    },
    { type: 'separator' },
    {
      label: castLabel,
      type: 'checkbox',
      checked: cs.active || cs.starting,
      click: (item) => (item.checked ? startCast() : stopCast()),
    },
    { label: 'Send clipboard to phone', click: () => sendClipboardToPhone() },
    {
      label: 'Text from phone',
      enabled: texts.length > 0,
      submenu: texts.length
        ? texts.map((t) => ({ label: short(t.text.replace(/\s+/g, ' ')), click: () => clipboard.writeText(t.text) }))
        : [{ label: 'Nothing yet', enabled: false }],
    },
    {
      label: 'Recent files',
      submenu: [
        ...(recent.length ? recent.map((f) => ({ label: short(f.name), click: () => shell.showItemInFolder(f.path) })) : [{ label: 'Nothing yet', enabled: false }]),
        { type: 'separator' },
        { label: 'Open upload folder', click: () => shell.openPath(settings.get('uploadDir')) },
      ],
    },
    { type: 'separator' },
    { label: 'Show QR code / Open AirBridge', click: showWindow },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on('click', showWindow);
  buildTrayMenu();
}

async function sendClipboardToPhone() {
  // Electron 45's clipboard API is async (readText/writeText return Promises).
  const text = await clipboard.readText();
  if (typeof text !== 'string' || !text) return false;
  pcClip = { text: text.slice(0, 100000), at: Date.now() };
  phone.broadcast();
  pushState();
  return true;
}

// Settings the page may never set directly.
const PRIVATE_KEYS = ['obsPasswordEnc', 'caKeyEnc', 'caCert', 'devices'];
const RECEIVER_KEYS = ['deviceName', 'requirePin', 'pin', 'fullscreen', 'h265', 'audioMode', 'audioDevice', 'keepWindowOpen', 'recordSessions', 'recordDir'];

async function updateSettings(patch) {
  for (const k of PRIVATE_KEYS) delete patch[k];
  const before = settings.all();
  if (patch.requirePin && !settings.get('pin')) {
    patch.pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  }
  const after = settings.update(patch);
  phone.opts.deviceName = after.deviceName;
  if (before.remoteEnabled && !after.remoteEnabled) helper.stopInput();
  if (before.startWithWindows !== after.startWithWindows) applyStartWithWindows();
  if (before.httpsEnabled !== after.httpsEnabled) await startPhoneServer();
  // Changing what is shared restarts the capture; phones reconnect by themselves.
  if (caster.state.active && ['castAudio', 'castQuality', 'castDisplay'].some((k) => before[k] !== after[k])) startCast();

  const receiverChanged = RECEIVER_KEYS.some((k) => before[k] !== after[k]);
  if (before.receiverEnabled !== after.receiverEnabled) {
    if (after.receiverEnabled) receiver.restart(after);
    else await receiver.stop();
  } else if (receiverChanged && after.receiverEnabled) {
    receiver.restart(after);
  }
  phone.broadcast();
  pushState();
  return snapshot();
}

app.on('second-instance', () => {
  if (win) showWindow();
});

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData');
  const resourcesPath = app.isPackaged ? process.resourcesPath : null;
  const appRoot = path.join(__dirname, '..');
  settings = new Settings(dataDir);
  devices = new DeviceStore(settings);
  receiver = new Receiver({ resourcesPath, appRoot, dataDir });
  helper = new Helper({ resourcesPath, appRoot });
  caster = new ScreenCaster();
  phone = new PhoneServer({
    castActive: () => caster.state.active,
    getUploadDir: () => settings.get('uploadDir'),
    isEnabled: () => settings.get('uploadsEnabled'),
    remoteEnabled: () => settings.get('remoteEnabled') && helper.available(),
    getShared: () => shared,
    getClip: () => pcClip,
    getCaCert: () => (tlsInfo.enabled ? caPem : null),
    devices,
    icon: fs.readFileSync(ICON),
    maxFileBytes: settings.get('maxFileGB') * 1024 ** 3,
    deviceName: settings.get('deviceName'),
  });

  receiver.on('status', pushState);
  receiver.on('log', (line) => send('log', line));
  receiver.on('recording', (file) => {
    lastRecording = file;
    pushState();
  });
  phone.on('file', (entry) => {
    received.unshift(entry);
    received.splice(100);
    notify('File from phone', entry.name, () => shell.showItemInFolder(entry.path));
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
    else notify('Link from phone', url, () => shell.openExternal(url));
    pushState();
  });
  phone.on('paired', ({ name }) => {
    notify('Phone remembered', `${name} can now connect without the QR code.`);
    pushState();
  });
  phone.on('input', (line) => helper.input(line));
  phone.on('pointer', clickAt);
  phone.on('cast', ({ client, type, data }) => {
    if (type === 'join') caster.join(client);
    else if (type === 'leave') caster.leave(client);
    else if (type === 'signal') caster.signal(client, data);
  });
  caster.on('signal', (client, data) => phone.sendTo(client, { type: 'cast-signal', data }));
  caster.on('log', (line) => receiver.log(`[screen share] ${line}`));
  let wasActive = false;
  caster.on('state', (s) => {
    if (s.active !== wasActive) {
      wasActive = s.active;
      phone.broadcast(); // phones on the Screen tab start or stop watching
    }
    pushState();
  });
  phone.on('clients', (n) => {
    phoneClients = n;
    if (n === 0) helper.stopInput();
    pushState();
  });

  createWindow();
  createTray();
  applyStartWithWindows();
  await startPhoneServer();
  if (settings.get('receiverEnabled')) receiver.start(settings.all());
  pushState();
  refreshNetworks();
  refreshAudioOutputs();
  win.on('show', () => {
    refreshNetworks();
    refreshAudioOutputs();
  });
  // Notice IP changes (new Wi-Fi) even while the window stays hidden.
  setInterval(refreshTlsCert, 60000).unref();
});

app.on('before-quit', async (e) => {
  quitting = true;
  if (helper) helper.stopInput();
  if (caster) caster.stop();
  if (receiver && receiver.proc) {
    e.preventDefault();
    await receiver.stop();
    app.quit();
  }
});

// ---- IPC from the renderer ----

ipcMain.handle('get-state', () => snapshot());
ipcMain.handle('update-settings', (_e, patch) => updateSettings({ ...patch }));

ipcMain.handle('new-pin', async () => {
  settings.update({ pin: String(crypto.randomInt(0, 10000)).padStart(4, '0') });
  if (settings.get('receiverEnabled')) receiver.restart(settings.all());
  return snapshot();
});

async function chooseDir(key, title) {
  const res = await dialog.showOpenDialog(win, { title, defaultPath: settings.get(key), properties: ['openDirectory', 'createDirectory'] });
  if (!res.canceled && res.filePaths[0]) return updateSettings({ [key]: res.filePaths[0] });
  return snapshot();
}
ipcMain.handle('choose-folder', () => chooseDir('uploadDir', 'Choose where received files are saved'));
ipcMain.handle('choose-record-folder', () => chooseDir('recordDir', 'Choose where recordings are saved'));

ipcMain.handle('open-network-settings', () => shell.openExternal('ms-settings:network-status'));
ipcMain.handle('open-folder', () => shell.openPath(settings.get('uploadDir')));
ipcMain.handle('open-record-folder', () => {
  fs.mkdirSync(settings.get('recordDir'), { recursive: true });
  return shell.openPath(settings.get('recordDir'));
});
ipcMain.handle('show-file', (_e, p) => {
  // Only reveal files AirBridge itself created.
  if (received.some((r) => r.path === p) || p === lastScreenshot || p === lastRecording) shell.showItemInFolder(p);
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

// Remembered phones
ipcMain.handle('forget-device', (_e, id) => {
  devices.forget(id);
  phone.closeDevice(id);
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

// Screenshot
ipcMain.handle('screenshot', () => takeScreenshot());

// Share PC screen to phones
ipcMain.handle('cast', (_e, on) => {
  if (on) startCast();
  else stopCast();
  return snapshot();
});

// OBS
ipcMain.handle('add-to-obs', async (_e, password) => {
  let pw = typeof password === 'string' ? password : '';
  const canEncrypt = await secrets.available();
  if (!pw && settings.get('obsPasswordEnc') && canEncrypt) pw = (await secrets.decrypt(settings.get('obsPasswordEnc'))) || '';
  try {
    const res = await addMirrorToObs({ password: pw });
    if (pw && canEncrypt) settings.update({ obsPasswordEnc: await secrets.encrypt(pw) });
    // OBS can only capture the window while it exists, so keep it open between sessions.
    if (!settings.get('keepWindowOpen')) await updateSettings({ keepWindowOpen: true });
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
