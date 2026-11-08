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
  playAudio: true,
  h265: false,
  uploadsEnabled: true,
  uploadDir: path.join(os.homedir(), 'Downloads', 'AirBridge'),
  uploadPort: 8765,
  maxFileGB: 8,
};

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
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
      this.data[k] = v;
    }
    this.data.deviceName = String(this.data.deviceName).trim().slice(0, 60) || DEFAULTS.deviceName;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return this.all();
  }
}

module.exports = { Settings, DEFAULTS };
