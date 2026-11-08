'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UploadServer, sanitizeFilename } = require('../src/uploadServer');
const { buildArgs } = require('../src/receiver');

async function withServer(fn, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-test-'));
  let enabled = true;
  const srv = new UploadServer({
    getUploadDir: () => dir,
    isEnabled: () => enabled,
    deviceName: 'Test <PC>',
    ...opts,
  });
  const port = await srv.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({ srv, dir, base, setEnabled: (v) => (enabled = v) });
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function form(files) {
  const fd = new FormData();
  for (const [name, content] of files) fd.append('file', new Blob([content]), name);
  return fd;
}

test('sanitizeFilename strips paths and reserved names', () => {
  assert.equal(sanitizeFilename('../../evil.txt'), 'evil.txt');
  assert.equal(sanitizeFilename('C:\\Windows\\x.dll'), 'x.dll');
  assert.equal(sanitizeFilename('a<b>:c?.jpg'), 'a_b__c_.jpg');
  assert.equal(sanitizeFilename('CON.txt'), '_CON.txt');
  assert.equal(sanitizeFilename('..'), 'upload');
  assert.equal(sanitizeFilename('trailing. '), 'trailing');
});

test('page and upload require the token', async () => {
  await withServer(async ({ srv, base }) => {
    assert.equal((await fetch(`${base}/`)).status, 403);
    assert.equal((await fetch(`${base}/?t=wrong`)).status, 403);
    const page = await fetch(`${base}/?t=${srv.token}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Test &lt;PC&gt;/);
    const up = await fetch(`${base}/upload?t=bad`, { method: 'POST', body: form([['a.txt', 'x']]) });
    assert.equal(up.status, 403);
  });
});

test('uploads files, de-duplicates names, emits events', async () => {
  await withServer(async ({ srv, dir, base }) => {
    const events = [];
    srv.on('file', (e) => events.push(e));
    const url = `${base}/upload?t=${srv.token}`;
    let r = await fetch(url, { method: 'POST', body: form([['photo.jpg', 'one'], ['../photo.jpg', 'two']]) });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).saved.sort(), ['photo (1).jpg', 'photo.jpg']);
    r = await fetch(url, { method: 'POST', body: form([['ünïcode 文件.txt', 'three']]) });
    assert.deepEqual((await r.json()).saved, ['ünïcode 文件.txt']);
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ['photo (1).jpg', 'photo.jpg', 'ünïcode 文件.txt']);
    assert.equal(events.length, 3);
    assert.equal(fs.readFileSync(path.join(dir, 'ünïcode 文件.txt'), 'utf8'), 'three');
  });
});

test('rejects when uploads are off, and after the token rotates', async () => {
  await withServer(async ({ srv, base, setEnabled }) => {
    setEnabled(false);
    let r = await fetch(`${base}/upload?t=${srv.token}`, { method: 'POST', body: form([['a.txt', 'x']]) });
    assert.equal(r.status, 503);
    setEnabled(true);
    const old = srv.token;
    srv.rotateToken();
    r = await fetch(`${base}/upload?t=${old}`, { method: 'POST', body: form([['a.txt', 'x']]) });
    assert.equal(r.status, 403);
  });
});

test('enforces the size limit and leaves no partial file', async () => {
  await withServer(
    async ({ srv, dir, base }) => {
      const r = await fetch(`${base}/upload?t=${srv.token}`, { method: 'POST', body: form([['big.bin', 'x'.repeat(5000)]]) });
      assert.equal(r.status, 500);
      assert.match((await r.json()).error, /size limit/);
      assert.deepEqual(fs.readdirSync(dir), []);
    },
    { maxFileBytes: 1000 },
  );
});

test('buildArgs maps settings to UxPlay flags', () => {
  const args = buildArgs({ deviceName: 'Den PC', requirePin: true, pin: '0420', fullscreen: true, h265: false }, 'k.pem');
  assert.deepEqual(args.slice(0, 5), ['-n', 'Den PC', '-nh', '-p', '7100']);
  assert.ok(args.includes('-fs'));
  assert.deepEqual(args.slice(args.indexOf('-pin'), args.indexOf('-pin') + 2), ['-pin', '0420']);
  assert.ok(!args.includes('-h265'));
  assert.deepEqual(args.slice(-2), ['-key', 'k.pem']);
});

test('buildArgs turns audio off with -as 0', () => {
  const on = buildArgs({ deviceName: 'PC', playAudio: true });
  const off = buildArgs({ deviceName: 'PC', playAudio: false });
  assert.ok(!on.includes('0'));
  assert.deepEqual(off.slice(off.indexOf('-as'), off.indexOf('-as') + 2), ['-as', '0']);
  assert.equal(off.filter((a) => a === '-as').length, 1);
});
