'use strict';
// LAN server for the phone page (opened via QR code). Everything needs the
// session token. Features:
//   POST /upload           phone -> PC files, streamed into the chosen folder
//   GET  /dl/:id           PC -> phone files the user shared in the app
//   POST /api/clipboard    phone -> PC text
//   POST /api/link         phone -> PC: open a URL in the PC's browser
//   GET  /api/state        shared files, PC clipboard text, enabled features
//   GET  /api/whoami       session or paired device; HTTPS port
//   POST /api/pair         QR session -> long-lived device token (remembered phone)
//   GET  /airbridge-ca.crt local CA for HTTPS (installed on the phone once)
//   WS   /ws               live state pushes; remote mouse/keyboard input;
//                          WebRTC signaling for viewing the PC screen (cast-*)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const Busboy = require('busboy');
const { WebSocketServer } = require('ws');

const PAGE = fs.readFileSync(path.join(__dirname, 'web', 'phone.html'), 'utf8');

const KEY_NAMES = new Set([
  'enter', 'backspace', 'tab', 'esc', 'space', 'delete', 'left', 'right', 'up', 'down',
  'home', 'end', 'pageup', 'pagedown', 'win', 'volup', 'voldown', 'mute',
  'playpause', 'next', 'prev', 'f11', 'f5',
]);

const clampInt = (v, lim) => Math.max(-lim, Math.min(lim, Math.round(Number(v) || 0)));

/**
 * Turns one remote message from the phone into helper command lines
 * (see native/helper.cpp). Returns [] for anything invalid.
 */
function inputToCommands(msg) {
  if (!msg || typeof msg !== 'object') return [];
  const btn = ['l', 'r', 'm'].includes(msg.b) ? msg.b : 'l';
  switch (msg.type) {
    case 'm': {
      const dx = clampInt(msg.dx, 2000), dy = clampInt(msg.dy, 2000);
      return dx || dy ? [`m ${dx} ${dy}`] : [];
    }
    case 'c': return [`c ${btn}`];
    case 'd': return [`d ${btn}`];
    case 'u': return [`u ${btn}`];
    case 'w': { const n = clampInt(msg.n, 2400); return n ? [`w ${n}`] : []; }
    case 'h': { const n = clampInt(msg.n, 2400); return n ? [`h ${n}`] : []; }
    case 'k': return KEY_NAMES.has(msg.k) ? [`k ${msg.k}`] : [];
    case 't': {
      // Newlines become Enter presses; other control characters are dropped.
      const parts = String(msg.s || '').slice(0, 2000).replace(/\r\n?/g, '\n').split('\n');
      const out = [];
      parts.forEach((p, i) => {
        const clean = p.replace(/[\u0000-\u001f\u007f]/g, '');
        if (clean) out.push(`t ${clean}`);
        if (i < parts.length - 1) out.push('k enter');
      });
      return out;
    }
    default: return [];
  }
}

/** WebRTC answer / ICE candidate from a phone, reduced to the expected shape. */
function castSignal(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.sdp && data.sdp.type === 'answer' && typeof data.sdp.sdp === 'string' && data.sdp.sdp.length < 60000) {
    return { sdp: { type: 'answer', sdp: data.sdp.sdp } };
  }
  const c = data.candidate;
  if (c && typeof c === 'object' && typeof c.candidate === 'string' && c.candidate.length < 1000) {
    return {
      candidate: {
        candidate: c.candidate,
        sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 32) : null,
        sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null,
      },
    };
  }
  return null;
}

const POWER_ACTIONS = ['lock', 'sleep', 'restart', 'shutdown', 'cancel'];

/**
 * Pointer on the shared screen: x, y as fractions (0..1) of the picture.
 * a: 'click' (default), 'move' (pointer follows the finger), 'down' / 'up' (drag).
 */
function pointerMsg(msg) {
  const x = Number(msg.x), y = Number(msg.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  const a = ['click', 'move', 'down', 'up'].includes(msg.a) ? msg.a : 'click';
  return { x, y, b: ['l', 'r'].includes(msg.b) ? msg.b : 'l', a };
}

// Only plain web links may be opened on the PC.
function normalizeLink(raw) {
  let s = String(raw || '').trim();
  if (!s || s.length > 4000) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[\w-]+(\.[\w-]+)+([/?#:].*)?$/.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Windows-reserved names and characters; also strips any path component.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
function sanitizeFilename(name) {
  let base = String(name || '').split(/[\\/]/).pop();
  base = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!base || base === '.' || base === '..') base = 'upload';
  if (RESERVED.test(base)) base = '_' + base;
  if (base.length > 200) {
    const ext = path.extname(base).slice(0, 20);
    base = base.slice(0, 200 - ext.length) + ext;
  }
  return base;
}

// Move tmp to "name.ext", "name (1).ext", ... without ever overwriting:
// a hard link fails with EEXIST if the name is taken, even when two uploads
// finish at the same moment. Falls back to rename where links aren't supported.
function claimName(tmp, dir, name, cb, i = 0) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const candidate = path.join(dir, i ? `${stem} (${i})${ext}` : name);
  if (i > 9999) return cb(new Error('too many duplicates'));
  fs.link(tmp, candidate, (err) => {
    if (!err) return fs.unlink(tmp, () => cb(null, candidate));
    if (err.code === 'EEXIST') return claimName(tmp, dir, name, cb, i + 1);
    if (fs.existsSync(candidate)) return claimName(tmp, dir, name, cb, i + 1);
    fs.rename(tmp, candidate, (err2) => cb(err2, candidate));
  });
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

class PhoneServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {() => string} opts.getUploadDir   folder to save into (read per upload)
   * @param {() => boolean} opts.isEnabled     whether uploads are currently accepted
   * @param {() => boolean} [opts.remoteEnabled] whether remote mouse/keyboard is allowed
   * @param {() => Array<{id,name,size,path}>} [opts.getShared] files shared to the phone
   * @param {() => ({text,at}|null)} [opts.getClip] PC clipboard text sent to the phone
   * @param {number} [opts.maxFileBytes]       per-file size cap
   * @param {string} [opts.deviceName]         shown on the phone page
   * @param {object} [opts.devices]            DeviceStore (verify/pair/touch) for remembered phones
   * @param {() => (string|null)} [opts.getCaCert] local CA certificate (PEM) offered to phones
   * @param {Buffer} [opts.icon]               PNG for the home-screen icon
   *
   * Two kinds of token are accepted: the QR "session" token (changes on restart
   * and with New link) and per-phone device tokens issued by /api/pair.
   *
   * Events: 'file' (saved upload), 'clipboard' ({text}), 'link' ({url}),
   *         'input' (helper command line), 'clients' (number of open phone pages),
   *         'paired' ({id, name})
   */
  constructor(opts) {
    super();
    this.opts = { remoteEnabled: () => false, castActive: () => false, castScreens: () => null, getShared: () => [], getClip: () => null, getCaCert: () => null, devices: null, ...opts };
    this.token = crypto.randomBytes(16).toString('hex');
    this.server = null;
    this.tlsServer = null;
    this.wss = null;
    this.port = null;
    this.tlsPort = null;
  }

  /** Who is calling: { kind: 'session' } | { kind: 'device', id, name } | null */
  auth(t) {
    t = String(t || '');
    if (safeEqual(t, this.token)) return { kind: 'session' };
    const d = this.opts.devices && this.opts.devices.verify(t);
    if (d) {
      this.opts.devices.touch(d.id);
      return { kind: 'device', id: d.id, name: d.name };
    }
    return null;
  }

  rotateToken() {
    this.token = crypto.randomBytes(16).toString('hex');
    // Pages still on the old QR link stop working immediately; paired phones stay.
    if (this.wss) for (const ws of this.wss.clients) if (ws.who && ws.who.kind === 'session') ws.close(4001, 'token rotated');
    return this.token;
  }

  /** Disconnect a phone that was just forgotten. */
  closeDevice(id) {
    if (!this.wss) return;
    for (const ws of this.wss.clients) if (ws.who && ws.who.id === id) ws.close(4001, 'device forgotten');
  }

  start(port = 0, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      if (!this.wss) this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
      this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  /** Also serve the same page and API over HTTPS (cert from the local CA). */
  startTls(port, { key, cert }, host = '0.0.0.0') {
    const https = require('https');
    return new Promise((resolve, reject) => {
      this.tlsServer = https.createServer({ key, cert }, (req, res) => this.handle(req, res));
      if (!this.wss) this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
      this.tlsServer.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
      this.tlsServer.on('tlsClientError', () => {}); // phones without the CA yet: expected
      this.tlsServer.once('error', reject);
      this.tlsServer.listen(port, host, () => {
        this.tlsPort = this.tlsServer.address().port;
        resolve(this.tlsPort);
      });
    });
  }

  /** Swap in a new certificate (e.g. after the PC's IP address changed). */
  updateTls({ key, cert }) {
    if (this.tlsServer) this.tlsServer.setSecureContext({ key, cert });
  }

  stop() {
    const close = (srv) =>
      new Promise((resolve) => {
        if (!srv) return resolve();
        srv.close(() => resolve());
        srv.closeAllConnections?.();
      });
    if (this.wss) {
      for (const ws of this.wss.clients) ws.terminate();
      this.wss.close();
    }
    const done = Promise.all([close(this.server), close(this.tlsServer)]);
    this.server = this.tlsServer = this.wss = null;
    this.tlsPort = null;
    return done;
  }

  state() {
    return {
      device: this.opts.deviceName || 'your computer',
      uploads: !!this.opts.isEnabled(),
      remote: !!this.opts.remoteEnabled(),
      cast: !!this.opts.castActive(),
      // While sharing: the PC's monitors, so the phone can switch between them.
      screens: this.opts.castActive() ? this.opts.castScreens() : null,
      shared: this.opts.getShared().map(({ id, name, size }) => ({ id, name, size })),
      clip: this.opts.getClip(),
    };
  }

  /** Push fresh state to every open phone page. */
  broadcast() {
    if (!this.wss) return;
    const msg = JSON.stringify({ type: 'state', ...this.state() });
    for (const ws of this.wss.clients) if (ws.readyState === 1) ws.send(msg);
  }

  clientCount() {
    return this.wss ? this.wss.clients.size : 0;
  }

  upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://local');
    const who = url.pathname === '/ws' ? this.auth(url.searchParams.get('t')) : null;
    if (!who) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws.who = who;
      ws.id = crypto.randomBytes(6).toString('hex');
      this.emit('clients', this.clientCount());
      ws.send(JSON.stringify({ type: 'state', ...this.state() }));
      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        // Screen viewing (PC -> phone): WebRTC signaling, only while sharing is on.
        if (msg.type === 'cast-join' || msg.type === 'cast-leave' || msg.type === 'cast-signal') {
          if (!this.opts.castActive()) return;
          if (msg.type === 'cast-signal') {
            const sig = castSignal(msg.data);
            if (sig) this.emit('cast', { client: ws.id, type: 'signal', data: sig });
          } else {
            ws.watching = msg.type === 'cast-join';
            this.emit('cast', { client: ws.id, type: msg.type === 'cast-join' ? 'join' : 'leave' });
          }
          return;
        }
        // Pick which monitor is shared (only while sharing is on).
        if (msg.type === 'cast-display') {
          const screens = this.opts.castActive() && this.opts.castScreens();
          if (screens && screens.list.some((d) => d.id === String(msg.id))) this.emit('cast-display', String(msg.id));
          return;
        }
        if (!this.opts.remoteEnabled()) return;
        // PC power: lock, sleep, restart, shut down (and cancel a pending restart/shutdown).
        if (msg.type === 'power') {
          if (POWER_ACTIONS.includes(msg.action)) this.emit('power', { action: msg.action, from: ws.who && ws.who.name });
          return;
        }
        // Tap on the shared screen: click at that point.
        if (msg.type === 'tap') {
          const p = pointerMsg(msg);
          if (p) this.emit('pointer', p);
          return;
        }
        for (const line of inputToCommands(msg)) this.emit('input', line);
      });
      ws.on('close', () => {
        if (ws.watching) this.emit('cast', { client: ws.id, type: 'leave' });
        this.emit('clients', this.clientCount());
      });
    });
  }

  /** Send a message to one phone page (by connection id). */
  sendTo(client, obj) {
    if (!this.wss) return;
    for (const ws of this.wss.clients) if (ws.id === client && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  watcherCount() {
    return this.wss ? [...this.wss.clients].filter((ws) => ws.watching).length : 0;
  }

  handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const send = (code, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(body);
    };

    // The page itself holds no secrets; it signs in with the token from its URL
    // or from storage, and explains what to do when that's no longer valid.
    if (req.method === 'GET' && url.pathname === '/') {
      const html = PAGE.replace(/__DEVICE__/g, () => escapeHtml(this.opts.deviceName || 'your computer'));
      return send(200, html, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && (url.pathname === '/icon.png' || url.pathname === '/apple-touch-icon.png') && this.opts.icon) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      return res.end(this.opts.icon);
    }
    // Lets the http page check whether this phone already trusts the local CA.
    if (req.method === 'GET' && url.pathname === '/api/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      return res.end('{"ok":true}');
    }

    const who = this.auth(url.searchParams.get('t'));
    if (!who) {
      return send(403, JSON.stringify({ error: 'expired' }), 'application/json');
    }

    if (req.method === 'GET' && url.pathname === '/api/whoami') {
      return send(200, JSON.stringify({ kind: who.kind, name: who.name || null, tlsPort: this.tlsPort, hasCa: !!this.opts.getCaCert() }), 'application/json');
    }

    if (req.method === 'POST' && url.pathname === '/api/pair') {
      if (who.kind !== 'session' || !this.opts.devices) return send(400, JSON.stringify({ error: 'Already paired.' }), 'application/json');
      return readJson(req)
        .then((body) => {
          const d = this.opts.devices.pair(body.name);
          this.emit('paired', { id: d.id, name: d.name });
          send(200, JSON.stringify(d), 'application/json');
        })
        .catch(() => send(400, JSON.stringify({ error: 'Bad request.' }), 'application/json'));
    }

    if (req.method === 'GET' && url.pathname === '/airbridge-ca.crt') {
      const pem = this.opts.getCaCert();
      if (!pem) return send(404, 'No certificate yet.');
      const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="AirBridge-local-CA.crt"',
        'Cache-Control': 'no-store',
      });
      return res.end(der);
    }

    if (req.method === 'POST' && url.pathname === '/upload') {
      if (!this.opts.isEnabled()) return send(503, 'Uploads are turned off on the computer.');
      return this.receive(req, res, send);
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      return send(200, JSON.stringify(this.state()), 'application/json');
    }

    const dl = url.pathname.match(/^\/dl\/([a-f0-9]{8,64})$/);
    if (req.method === 'GET' && dl) return this.download(dl[1], req, res, send);

    if (req.method === 'POST' && (url.pathname === '/api/clipboard' || url.pathname === '/api/link')) {
      return readJson(req)
        .then((body) => {
          if (url.pathname === '/api/clipboard') {
            const text = String(body.text || '').slice(0, 100000);
            if (!text.trim()) return send(400, JSON.stringify({ error: 'Nothing to send.' }), 'application/json');
            this.emit('clipboard', { text });
            return send(200, JSON.stringify({ ok: true }), 'application/json');
          }
          const link = normalizeLink(body.url);
          if (!link) return send(400, JSON.stringify({ error: 'That isn\u2019t a web link (http or https).' }), 'application/json');
          this.emit('link', { url: link });
          send(200, JSON.stringify({ ok: true, url: link }), 'application/json');
        })
        .catch(() => send(400, JSON.stringify({ error: 'Bad request.' }), 'application/json'));
    }

    send(404, 'Not found');
  }

  download(id, req, res, send) {
    const item = this.opts.getShared().find((f) => f.id === id);
    if (!item) return send(404, 'That file is no longer shared.');
    fs.stat(item.path, (err, st) => {
      if (err || !st.isFile()) return send(404, 'That file is no longer on the computer.');
      const ascii = item.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(item.name)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(item.path).on('error', () => res.destroy()).pipe(res);
    });
  }

  receive(req, res, send) {
    const dir = this.opts.getUploadDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return send(500, 'Cannot open the upload folder on the computer.');
    }

    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { fileSize: this.opts.maxFileBytes || 8 * 1024 ** 3, files: 500 },
        defParamCharset: 'utf8',
      });
    } catch (e) {
      return send(400, 'Bad upload request.');
    }

    const saved = [];
    const pending = [];
    const active = [];
    let failed = null;
    const peer = req.socket.remoteAddress;

    busboy.on('file', (_field, stream, info) => {
      const name = sanitizeFilename(info.filename);
      const tmp = path.join(dir, `.${name}.${crypto.randomBytes(4).toString('hex')}.part`);
      const out = fs.createWriteStream(tmp);
      let bytes = 0;
      stream.on('data', (c) => (bytes += c.length));
      const done = new Promise((resolve) => {
        out.on('error', (err) => {
          failed = failed || `Could not write ${name}: ${err.code || err.message}`;
          stream.resume();
          fs.rm(tmp, { force: true }, () => resolve());
        });
        out.on('finish', () => {
          if (stream.truncated) {
            failed = failed || `${name} is larger than the size limit.`;
            return fs.rm(tmp, { force: true }, () => resolve());
          }
          if (failed) return fs.rm(tmp, { force: true }, () => resolve());
          claimName(tmp, dir, name, (err, finalPath) => {
            if (err) {
              failed = failed || `Could not save ${name}.`;
              fs.rm(tmp, { force: true }, () => resolve());
            } else {
              const entry = { name: path.basename(finalPath), path: finalPath, bytes, from: peer, at: Date.now() };
              saved.push(entry);
              this.emit('file', entry);
              resolve();
            }
          });
        });
      });
      pending.push(done);
      active.push({ out, stream });
      stream.pipe(out);
    });

    busboy.on('error', () => {
      failed = failed || 'Upload interrupted.';
    });

    busboy.on('close', async () => {
      await Promise.all(pending);
      if (failed) return send(saved.length ? 207 : 500, JSON.stringify({ saved: saved.map((s) => s.name), error: failed }), 'application/json');
      send(200, JSON.stringify({ saved: saved.map((s) => s.name) }), 'application/json');
    });

    // Phone went away mid-upload: stop writing and delete the partial files.
    req.on('close', () => {
      if (req.complete) return;
      failed = failed || 'Upload cancelled.';
      req.unpipe(busboy);
      for (const { out, stream } of active) {
        stream.unpipe(out);
        stream.resume();
        out.destroy(new Error('aborted'));
      }
    });

    req.pipe(busboy);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

module.exports = { POWER_ACTIONS, PhoneServer, sanitizeFilename, inputToCommands, normalizeLink, castSignal, pointerMsg };
