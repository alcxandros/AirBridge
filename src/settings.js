'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  deviceName: os.hostname(),
  receiverEnabled: true,
  requirePin: false,
  pin: '',
  fullscreen: false,
  // 'pc': play on this PC; 'off': PC accepts but discards audio (phone is
  // silent too); 'phone': advertise no audio so iOS may keep it (experimental).
  audioMode: 'pc',
  audioDevice: '', // WASAPI endpoint id; '' = Windows default output
  keepWindowOpen: false, // keep the mirror window between sessions (for OBS)
  obsPasswordEnc: '', // OBS WebSocket password, encrypted with Electron safeStorage
  remoteEnabled: false,
  autoOpenLinks: true,
  autoCopyClipboard: true,
  devices: [], // paired phones: { id, name, hash, created, lastSeen } (see devices.js)
  startWithWindows: false,
  recordSessions: false,
  recordDir: path.join(os.homedir(), 'Videos', 'AirBridge'),
  screenshotDir: path.join(os.homedir(), 'Pictures', 'AirBridge'),
  httpsEnabled: true,
  caKeyEnc: '', // local CA private key (PEM), encrypted with safeStorage
  caCert: '', // local CA certificate (PEM)
  // Sharing the PC screen to phones. Sharing itself is never saved as "on".
  castAudio: 'off', // 'off' | 'both' (PC and phone) | 'phone' (phone only, PC muted)
  castQuality: 'sharp', // 'sharp' (text) | 'smooth' (video, games)
  castDisplay: '', // Electron display id; '' = main display
  phoneAddress: '', // address in the QR code; '' = best local network address
  h265: false,
  uploadsEnabled: true,
  uploadDir: path.join(os.homedir(), 'Downloads', 'AirBridge'),
  uploadPort: 8765,
  maxFileGB: 8,
};

const AUDIO_MODES = ['pc', 'off', 'phone'];
// Settings that only accept one of a fixed list of values.
const ENUMS = { audioMode: AUDIO_MODES, castAudio: ['off', 'both', 'phone'], castQuality: ['sharp', 'smooth'] };

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // 0.1.0 had a playAudio checkbox.
      if (saved.playAudio === false && !saved.audioMode) saved.audioMode = 'off';
      delete saved.playAudio;
      Object.assign(this.data, saved);
    } catch {
      /* first run or unreadable: keep defaults */
    }
  }

  get(key) {
    return this.data[key];
  }

  all() {
    return { ...this.data };
  }

  update(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULTS)) continue;
      if (typeof v !== typeof DEFAULTS[k]) continue;
      if (ENUMS[k] && !ENUMS[k].includes(v)) continue;
      this.data[k] = v;
    }
    for (const [k, allowed] of Object.entries(ENUMS)) if (!allowed.includes(this.data[k])) this.data[k] = DEFAULTS[k];
    this.data.deviceName =String(this.data.deviceName).trim().slice(0, 60) || DEFAULTS.deviceName;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return this.all();
  }
}

module.exports = { Settings, DEFAULTS };
