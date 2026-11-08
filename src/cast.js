'use strict';
// "Reverse mirroring": streams the PC screen to phones over WebRTC.
// Owns a hidden caster window (src/caster/) and relays signaling messages
// between it and the phone server.

const { BrowserWindow, desktopCapturer, ipcMain, screen, session } = require('electron');
const path = require('path');
const { EventEmitter } = require('events');

class ScreenCaster extends EventEmitter {
  constructor() {
    super();
    this.win = null;
    this.state = { active: false, starting: false, viewers: 0, error: '', display: null, width: 0, height: 0 };
    this.options = { audio: 'off', quality: 'sharp', displayId: '' };
    this.pending = []; // commands queued until the caster page is ready
    this.ready = false;
    ipcMain.on('caster-event', (e, msg) => {
      if (this.win && e.sender === this.win.webContents) this.onEvent(msg);
    });
  }

  /** Displays for the picker: [{ id, label, primary }] */
  static displays() {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => {
      const { width, height } = ScreenCaster.physicalSize(d);
      return { id: String(d.id), label: `${d.label || `Display ${i + 1}`} (${width}×${height})${d.id === primary ? ', main' : ''}`, primary: d.id === primary };
    });
  }

  /** A display's size in real pixels (Windows scaling undone). */
  static physicalSize(d) {
    if (process.platform === 'win32') {
      const r = screen.dipToScreenRect(null, d.bounds);
      return { width: r.width, height: r.height };
    }
    return { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  }

  /** The Electron Display being shared (or that would be). */
  display() {
    const all = screen.getAllDisplays();
    return all.find((d) => String(d.id) === String(this.options.displayId)) || screen.getPrimaryDisplay();
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  command(cmd) {
    if (!this.win) return;
    if (!this.ready) this.pending.push(cmd);
    else this.win.webContents.send('caster-command', cmd);
  }

  start(options = {}) {
    this.options = { ...this.options, ...options };
    if (this.win) this.stop();
    this.setState({ active: false, starting: true, error: '', viewers: 0 });

    // A private in-memory session, so the capture handler only applies to the caster.
    const ses = session.fromPartition('airbridge-caster', { cache: false });
    ses.setDisplayMediaRequestHandler(async (_req, callback) => {
      try {
        const display = this.display();
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
        if (!src) return callback(null);
        const audio = this.options.audio === 'phone' ? 'loopbackWithMute' : this.options.audio === 'both' ? 'loopback' : undefined;
        callback(audio ? { video: src, audio } : { video: src });
      } catch {
        callback(null);
      }
    });

    this.ready = false;
    // Capture at the display's native size: smaller looks soft, larger only upscales.
    const size = ScreenCaster.physicalSize(this.display());
    this.pending = [{ type: 'start', options: { audio: this.options.audio !== 'off', quality: this.options.quality, ...size } }];
    this.win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'caster', 'preload.js'),
        session: ses,
        contextIsolation: true,
        sandbox: true,
        // Keep encoding at full speed while the window is hidden.
        backgroundThrottling: false,
      },
    });
    this.win.on('closed', () => {
      this.win = null;
      this.ready = false;
      if (this.state.active || this.state.starting) this.setState({ active: false, starting: false, viewers: 0 });
    });
    this.win.loadFile(path.join(__dirname, 'caster', 'caster.html'));
  }

  stop() {
    if (!this.win) return;
    const w = this.win;
    this.win = null;
    this.ready = false;
    this.pending = [];
    try {
      w.webContents.send('caster-command', { type: 'stop' });
    } catch {}
    // Closing the window ends the capture (Windows' capture indicator goes away too).
    setTimeout(() => !w.isDestroyed() && w.destroy(), 200);
    this.setState({ active: false, starting: false, viewers: 0 });
    this.emit('stopped');
  }

  join(id) {
    if (this.state.active) this.command({ type: 'join', id });
  }

  leave(id) {
    this.command({ type: 'leave', id });
  }

  signal(id, data) {
    this.command({ type: 'signal', id, data });
  }

  onEvent(msg) {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        for (const c of this.pending.splice(0)) this.win.webContents.send('caster-command', c);
        break;
      case 'started':
        this.setState({ active: true, starting: false, error: '', width: msg.width, height: msg.height });
        this.emit('started');
        break;
      case 'error':
        this.setState({ error: msg.message });
        this.stop();
        break;
      case 'viewers':
        this.setState({ viewers: msg.count });
        break;
      case 'signal':
        this.emit('signal', msg.id, msg.data);
        break;
      case 'log':
        this.emit('log', msg.message);
        break;
    }
  }
}

module.exports = { ScreenCaster };
