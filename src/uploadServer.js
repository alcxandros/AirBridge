'use strict';
// LAN file-drop server: the phone opens the page via a QR code and uploads
// files, which are streamed straight into the chosen folder.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const Busboy = require('busboy');

const PAGE = fs.readFileSync(path.join(__dirname, 'web', 'upload.html'), 'utf8');

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

class UploadServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {() => string} opts.getUploadDir  folder to save into (read per upload)
   * @param {() => boolean} opts.isEnabled    whether uploads are currently accepted
   * @param {number} [opts.maxFileBytes]      per-file size cap
   * @param {string} [opts.deviceName]        shown on the phone page
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.token = crypto.randomBytes(16).toString('hex');
    this.server = null;
    this.port = null;
  }

  rotateToken() {
    this.token = crypto.randomBytes(16).toString('hex');
    return this.token;
  }

  start(port = 0, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.on('error', reject);
      this.server.listen(port, host, () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
      this.server = null;
    });
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

    if (!safeEqual(url.searchParams.get('t') || '', this.token)) {
      return send(403, 'This link has expired. Scan the QR code on your computer again.');
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const html = PAGE.replace(/__DEVICE__/g, () => escapeHtml(this.opts.deviceName || 'your computer'));
      return send(200, html, 'text/html; charset=utf-8');
    }

    if (req.method === 'POST' && url.pathname === '/upload') {
      if (!this.opts.isEnabled()) return send(503, 'Uploads are turned off on the computer.');
      return this.receive(req, res, send);
    }

    send(404, 'Not found');
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

module.exports = { UploadServer, sanitizeFilename };
