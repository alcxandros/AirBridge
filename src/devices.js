'use strict';
// Remembered phones. Scanning the QR code once "pairs" a phone: it gets its
// own long-lived token, so its home-screen web app keeps working after the
// PC restarts or the QR link changes. Only SHA-256 hashes of tokens are stored.

const crypto = require('crypto');

const MAX_DEVICES = 20;
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

class DeviceStore {
  /** @param {{get:Function, update:Function}} settings  persisted 'devices' array */
  constructor(settings) {
    this.settings = settings;
  }

  list() {
    return (this.settings.get('devices') || []).map(({ id, name, created, lastSeen }) => ({ id, name, created, lastSeen }));
  }

  /** Returns { id, name } for a valid device token, else null. */
  verify(token) {
    if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
    const h = Buffer.from(hash(token), 'hex');
    for (const d of this.settings.get('devices') || []) {
      const dh = Buffer.from(d.hash, 'hex');
      if (dh.length === h.length && crypto.timingSafeEqual(dh, h)) return { id: d.id, name: d.name };
    }
    return null;
  }

  /** Creates a device and returns its token (shown to the phone once). */
  pair(rawName) {
    const devices = [...(this.settings.get('devices') || [])];
    let name = String(rawName || 'Phone').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || 'Phone';
    // "iPhone", "iPhone 2", ... so devices are told apart in the list.
    const base = name;
    for (let i = 2; devices.some((d) => d.name === name); i++) name = `${base} ${i}`;
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    devices.push({ id: crypto.randomBytes(6).toString('hex'), name, hash: hash(token), created: now, lastSeen: now });
    // Over the limit: forget the device unused for longest.
    devices.sort((a, b) => b.lastSeen - a.lastSeen);
    devices.splice(MAX_DEVICES);
    this.settings.update({ devices });
    const id = devices.find((d) => d.hash === hash(token)).id;
    return { id, name, token };
  }

  /** Updates "last seen", at most once a minute per device to spare the disk. */
  touch(id) {
    const devices = this.settings.get('devices') || [];
    const d = devices.find((x) => x.id === id);
    if (!d || Date.now() - d.lastSeen < 60000) return;
    this.settings.update({ devices: devices.map((x) => (x.id === id ? { ...x, lastSeen: Date.now() } : x)) });
  }

  forget(id) {
    this.settings.update({ devices: (this.settings.get('devices') || []).filter((d) => d.id !== id) });
  }

  forgetAll() {
    this.settings.update({ devices: [] });
  }
}

module.exports = { DeviceStore, hash };
