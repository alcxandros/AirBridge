'use strict';
// "Reverse mirroring": streams the PC screen to phones over WebRTC.
// Owns a hidden caster window (src/caster/) and relays signaling messages
// between it and the phone server.

const { BrowserWindow, desktopCapturer, ipcMain, screen, session } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

class ScreenCaster extends EventEmitter {
  constructor({ helperExe } = {}) {
    super();
    // On Windows, system sound comes from airbridge-helper's WASAPI loopback:
    // Chromium's own loopback fails on some audio drivers (unsupported format).
    this.helperExe = helperExe || null;
    this.audioProc = null;
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
        const audio = this.useHelperAudio() ? undefined : this.options.audio === 'phone' ? 'loopbackWithMute' : this.options.audio === 'both' ? 'loopback' : undefined;
        callback(audio ? { video: src, audio } : { video: src });
      } catch {
        callback(null);
      }
    });

    this.ready = false;
    // Capture at the display's native size: smaller looks soft, larger only upscales.
    const size = ScreenCaster.physicalSize(this.display());
    const helperAudio = this.useHelperAudio();
    this.pending = [
      { type: 'start', options: { audio: this.options.audio !== 'off' && !helperAudio, externalAudio: helperAudio, quality: this.options.quality, ...size } },
    ];
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
        // The sound pipeline (AudioContext) must run without a click.
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    this.win.on('closed', () => {
      this.win = null;
      this.ready = false;
      if (this.state.active || this.state.starting) this.setState({ active: false, starting: false, viewers: 0 });
    });
    this.win.loadFile(path.join(__dirname, 'caster', 'caster.html'));
  }

  useHelperAudio() {
    return process.platform === 'win32' && !!this.helperExe && this.options.audio !== 'off';
  }

  /** Starts the helper's loopback capture and forwards float32 stereo PCM to the caster page. */
  startAudio() {
    this.stopAudio();
    const proc = spawn(this.helperExe, this.options.audio === 'phone' ? ['loopback', 'mute'] : ['loopback'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.audioProc = proc;
    let header = Buffer.alloc(0);
    let rest = Buffer.alloc(0);
    let started = false;
    proc.stdout.on('data', (d) => {
      if (this.audioProc !== proc || !this.win) return;
      if (!started) {
        header = Buffer.concat([header, d]);
        const nl = header.indexOf(10);
        if (nl < 0) return;
        const m = /^fmt (\d+) 2$/.exec(header.subarray(0, nl).toString().trim());
        if (!m) return this.audioFailed(proc, 'unexpected output');
        started = true;
        this.win.webContents.send('caster-command', { type: 'audio-format', rate: Number(m[1]) });
        d = header.subarray(nl + 1);
      }
      // Keep whole float samples; carry a partial one over to the next chunk.
      const buf = rest.length ? Buffer.concat([rest, d]) : d;
      const usable = buf.length - (buf.length % 8);
      rest = Buffer.from(buf.subarray(usable));
      if (usable) {
        const pcm = new Float32Array(usable / 4);
        Buffer.from(pcm.buffer).set(buf.subarray(0, usable));
        this.win.webContents.send('caster-audio', pcm);
      }
    });
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.stdin.on('error', () => {});
    proc.on('error', (e) => this.audioFailed(proc, e.message));
    proc.on('exit', (code) => {
      if (this.audioProc === proc && code) this.audioFailed(proc, err.trim() || `exit code ${code}`);
    });
  }

  audioFailed(proc, why) {
    if (this.audioProc !== proc) return;
    this.stopAudio();
    // Keep the picture going without sound rather than stopping the share.
    this.emit('log', `PC sound capture failed (${why}); sharing without sound.`);
  }

  stopAudio() {
    const p = this.audioProc;
    this.audioProc = null;
    // Closing stdin makes the helper stop and restore the PC's mute state.
    if (p) p.stdin.end();
  }

  stop() {
    this.stopAudio();
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
        if (this.useHelperAudio()) this.startAudio();
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
