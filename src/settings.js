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
  h265: false,
  uploadsEnabled: true,
  uploadDir: path.join(os.homedir(), 'Downloads', 'AirBridge'),
  uploadPort: 8765,
  maxFileGB: 8,
};

const AUDIO_MODES = ['pc', 'off', 'phone'];

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
      if (k === 'audioMode' && !AUDIO_MODES.includes(v)) continue;
      this.data[k] = v;
    }
    if (!AUDIO_MODES.includes(this.data.audioMode)) this.data.audioMode = DEFAULTS.audioMode;
    this.data.deviceName =String(this.data.deviceName).trim().slice(0, 60) || DEFAULTS.deviceName;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return this.all();
  }
}

module.exports = { Settings, DEFAULTS };
