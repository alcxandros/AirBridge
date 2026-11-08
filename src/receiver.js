'use strict';
// Supervises the bundled UxPlay process (the AirPlay mirroring/audio engine).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'uxplay.exe' : 'uxplay';

// Fixed ports so firewall rules and troubleshooting stay predictable.
// UxPlay uses TCP n..n+2 and UDP n..n+2.
const BASE_PORT = 7100;

/** Locate the UxPlay bundle: packaged resources, then ./vendor, then PATH. */
function findUxPlay(resourcesPath, appRoot) {
  const candidates = [
    resourcesPath && path.join(resourcesPath, 'uxplay'),
    appRoot && path.join(appRoot, 'vendor', 'uxplay'),
  ].filter(Boolean);
  for (const root of candidates) {
    const exe = path.join(root, 'bin', EXE);
    if (fs.existsSync(exe)) return { exe, root };
  }
  return IS_WIN ? null : { exe: 'uxplay', root: null };
}

function buildArgs(settings, keyFile) {
  const args = ['-n', settings.deviceName, '-nh', '-p', String(BASE_PORT)];
  if (IS_WIN) args.push('-vs', 'd3d12videosink');
  if (settings.audioMode === 'phone') {
    // AirBridge patch: advertise no audio support so iOS may keep sound on the phone.
    args.push('-noaudiofeat');
  } else if (settings.audioMode === 'off') {
    args.push('-as', '0'); // accept the audio stream but don't play it
  } else if (IS_WIN) {
    // Only well-formed endpoint ids reach the GStreamer pipeline string.
    const dev = settings.audioDevice || '';
    args.push('-as', /^\{[\w.]+\}\.\{[0-9a-f-]+\}$/i.test(dev) ? `wasapisink device="${dev}"` : 'wasapisink');
  }
  if (settings.keepWindowOpen) args.push('-nc');
  // UxPlay writes "<prefix>.<n>.<codecs>.mp4", one file per mirroring session.
  // Forward slashes: backslashes are escape characters in GStreamer pipeline strings.
  if (settings.recordSessions && settings.recordPrefix) args.push('-mp4', settings.recordPrefix.replace(/\\/g, '/'));
  if (settings.fullscreen) args.push('-fs');
  if (settings.h265) args.push('-h265');
  if (settings.requirePin && /^\d{4}$/.test(settings.pin || '')) args.push('-pin', settings.pin);
  if (keyFile) args.push('-key', keyFile); // stable identity so iOS remembers the receiver
  return args;
}

class Receiver extends EventEmitter {
  constructor({ resourcesPath, appRoot, dataDir }) {
    super();
    this.bundle = findUxPlay(resourcesPath, appRoot);
    this.dataDir = dataDir;
    this.proc = null;
    this.state = 'stopped'; // stopped | starting | running | error | missing
    this.lastError = '';
    this.client = null;
    this.wantRunning = false;
    this.restarts = [];
    this.logTail = [];
  }

  status() {
    return {
      state: this.bundle ? this.state : 'missing',
      error: this.lastError,
      client: this.client,
      ports: { tcp: [BASE_PORT, BASE_PORT + 1, BASE_PORT + 2], udp: [BASE_PORT, BASE_PORT + 1, BASE_PORT + 2] },
      exe: this.bundle && this.bundle.exe,
    };
  }

  setState(state, error = '') {
    this.state = state;
    this.lastError = error;
    this.emit('status', this.status());
  }

  env() {
    const env = { ...process.env };
    const root = this.bundle.root;
    if (root) {
      // Keep GStreamer inside our bundle and away from any system install.
      env.PATH = path.join(root, 'bin') + path.delimiter + env.PATH;
      env.GST_PLUGIN_SYSTEM_PATH_1_0 = path.join(root, 'lib', 'gstreamer-1.0');
      env.GST_PLUGIN_PATH_1_0 = '';
      env.GST_PLUGIN_SCANNER_1_0 = path.join(root, 'libexec', 'gstreamer-1.0', IS_WIN ? 'gst-plugin-scanner.exe' : 'gst-plugin-scanner');
      env.GST_REGISTRY_1_0 = path.join(this.dataDir, 'gst-registry.bin');
      // Scan plugins in-process: the separate scanner is a console exe and would flash a window.
      env.GST_REGISTRY_FORK = 'no';
    }
    env.HOME = env.HOME || this.dataDir;
    return env;
  }

  // If AirBridge was killed (crash, Task Manager), its uxplay.exe keeps running
  // and holds the ports. Windows doesn't kill children with the parent, so
  // clean up any copy of *our* bundled exe before the first start.
  killStale() {
    if (!IS_WIN || !this.bundle || !this.bundle.root || this.staleChecked) return Promise.resolve();
    this.staleChecked = true;
    const { execFile } = require('child_process');
    const exe = this.bundle.exe.replace(/'/g, "''");
    const cmd = `Get-CimInstance Win32_Process -Filter "Name='${EXE}'" | Where-Object ExecutablePath -eq '${exe}' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }`;
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
        const pids = String(stdout || '').trim();
        if (pids) this.log(`stopped leftover uxplay (pid ${pids.split(/\s+/).join(', ')})`);
        resolve();
      });
    });
  }

  async start(settings) {
    this.wantRunning = true;
    this.settings = settings;
    if (!this.bundle) return this.setState('missing', 'UxPlay is not bundled. Run "npm run build:uxplay" first.');
    if (this.proc) return;
    await this.killStale();
    if (this.proc || !this.wantRunning) return;

    fs.mkdirSync(this.dataDir, { recursive: true });
    let run = settings;
    if (settings.recordSessions && settings.recordDir) {
      try {
        fs.mkdirSync(settings.recordDir, { recursive: true });
        const d = new Date();
        const p2 = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
        run = { ...settings, recordPrefix: path.join(settings.recordDir, `AirBridge ${stamp}`) };
      } catch (e) {
        this.log(`cannot create recordings folder: ${e.message}`);
      }
    }
    const args = buildArgs(run, path.join(this.dataDir, 'uxplay-key.pem'));
    this.log(`> ${EXE} ${args.join(' ')}`);
    this.setState('starting');

    // windowsHide must stay false: Windows applies it to UxPlay's first window,
    // which is the mirrored screen. The bundled uxplay.exe is GUI-subsystem, so
    // no console appears anyway.
    const proc = spawn(this.bundle.exe, args, { env: this.env(), windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;

    const onLine = (line) => {
      this.log(line);
      if (/Initialized server socket|using network ports/i.test(line) && this.state === 'starting') this.setState('running');
      if (/AirBridge: all clients disconnected/.test(line) && this.client) {
        this.client = null;
        this.emit('status', this.status());
      }
      const rec = line.match(/Started recording to: (.+)$/);
      if (rec) this.emit('recording', rec[1].trim());
      const m = line.match(/connection request from (.+?) \((.+?)\)/i);
      if (m) {
        this.client = { name: m[1], model: m[2], at: Date.now() };
        this.emit('status', this.status());
      }
    };
    lines(proc.stdout, onLine);
    lines(proc.stderr, onLine);

    proc.on('error', (err) => {
      this.proc = null;
      this.setState('error', `Could not start UxPlay: ${err.message}`);
    });

    proc.on('exit', (code, signal) => {
      this.proc = null;
      this.client = null;
      this.log(`uxplay exited (code ${code}${signal ? ', ' + signal : ''})`);
      if (!this.wantRunning) return this.setState('stopped');
      // Crash-restart, but give up after 5 crashes in a minute.
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < 60000).concat(now);
      if (this.restarts.length > 5) {
        this.wantRunning = false;
        return this.setState('error', `UxPlay keeps exiting (code ${code}). See the log for details.`);
      }
      this.setState('starting', `Restarting after exit code ${code}`);
      setTimeout(() => this.wantRunning && this.start(this.settings), 1500);
    });
  }

  stop() {
    this.wantRunning = false;
    return new Promise((resolve) => {
      const p = this.proc;
      if (!p) {
        this.setState('stopped');
        return resolve();
      }
      const t = setTimeout(() => p.kill('SIGKILL'), 3000);
      p.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      // No console to send Ctrl+C to on Windows; UxPlay has no state worth flushing.
      p.kill();
    });
  }

  async restart(settings) {
    await this.stop();
    this.restarts = [];
    this.start(settings);
  }

  log(line) {
    this.logTail.push(line);
    if (this.logTail.length > 400) this.logTail.splice(0, this.logTail.length - 400);
    this.emit('log', line);
  }
}

function lines(stream, cb) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.search(/\r?\n/)) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(buf[i] === '\r' ? i + 2 : i + 1);
      if (line.trim()) cb(line);
    }
  });
}

module.exports = { Receiver, buildArgs, findUxPlay, BASE_PORT };
