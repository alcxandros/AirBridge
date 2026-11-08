'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { PhoneServer, sanitizeFilename, inputToCommands, normalizeLink } = require('../src/phoneServer');
const { buildArgs } = require('../src/receiver');
const { parseAudioList } = require('../src/helper');
const { authString } = require('../src/obs');

async function withServer(fn, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-test-'));
  let enabled = true;
  const srv = new PhoneServer({
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

test('buildArgs maps the three sound modes', () => {
  const pc = buildArgs({ deviceName: 'PC', audioMode: 'pc' });
  const off = buildArgs({ deviceName: 'PC', audioMode: 'off' });
  const phone = buildArgs({ deviceName: 'PC', audioMode: 'phone' });
  assert.ok(!pc.includes('0') && !pc.includes('-noaudiofeat'));
  assert.deepEqual(off.slice(off.indexOf('-as'), off.indexOf('-as') + 2), ['-as', '0']);
  assert.equal(off.filter((a) => a === '-as').length, 1);
  assert.ok(phone.includes('-noaudiofeat') && !phone.includes('-as'));
});

test('settings migrate the old playAudio checkbox', () => {
  const { Settings } = require('../src/settings');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-settings-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ playAudio: false }));
  const s = new Settings(dir);
  assert.equal(s.get('audioMode'), 'off');
  assert.equal(s.update({ audioMode: 'bogus' }).audioMode, 'off');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('downloads serve only shared files, with the original name', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-share-'));
  const file = path.join(tmp, 'résumé final.pdf');
  fs.writeFileSync(file, 'PDFDATA');
  const shared = [{ id: 'aaaaaaaaaaaaaaaa', path: file, name: 'résumé final.pdf', size: 7 }];
  await withServer(
    async ({ srv, base }) => {
      const r = await fetch(`${base}/dl/aaaaaaaaaaaaaaaa?t=${srv.token}`);
      assert.equal(r.status, 200);
      assert.equal(await r.text(), 'PDFDATA');
      assert.match(r.headers.get('content-disposition'), /filename\*=UTF-8''r%C3%A9sum%C3%A9%20final\.pdf/);
      assert.equal((await fetch(`${base}/dl/bbbbbbbbbbbbbbbb?t=${srv.token}`)).status, 404);
      assert.equal((await fetch(`${base}/dl/aaaaaaaaaaaaaaaa?t=nope`)).status, 403);
      const st = await (await fetch(`${base}/api/state?t=${srv.token}`)).json();
      assert.deepEqual(st.shared, [{ id: 'aaaaaaaaaaaaaaaa', name: 'résumé final.pdf', size: 7 }]);
      assert.equal(st.shared[0].path, undefined); // never leak PC paths
    },
    { getShared: () => shared },
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('clipboard and link endpoints emit events and validate input', async () => {
  await withServer(async ({ srv, base }) => {
    const got = [];
    srv.on('clipboard', (c) => got.push(['clip', c.text]));
    srv.on('link', (l) => got.push(['link', l.url]));
    const post = (p, body) => fetch(`${base}${p}?t=${srv.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('/api/clipboard', { text: 'héllo\nworld' })).status, 200);
    assert.equal((await post('/api/clipboard', { text: '   ' })).status, 400);
    assert.equal((await post('/api/link', { url: 'example.com/page?a=1' })).status, 200);
    assert.equal((await post('/api/link', { url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await post('/api/link', { url: 'file:///C:/Windows' })).status, 400);
    const bad = await fetch(`${base}/api/link?t=${srv.token}`, { method: 'POST', body: '{not json' });
    assert.equal(bad.status, 400);
    assert.deepEqual(got, [['clip', 'héllo\nworld'], ['link', 'https://example.com/page?a=1']]);
  });
});

test('normalizeLink only allows http(s)', () => {
  assert.equal(normalizeLink('https://a.b/c'), 'https://a.b/c');
  assert.equal(normalizeLink('youtube.com/watch?v=x'), 'https://youtube.com/watch?v=x');
  assert.equal(normalizeLink('ms-settings:privacy'), null);
  assert.equal(normalizeLink('not a link'), null);
});

test('inputToCommands validates and translates remote messages', () => {
  assert.deepEqual(inputToCommands({ type: 'm', dx: 5.4, dy: -99999 }), ['m 5 -2000']);
  assert.deepEqual(inputToCommands({ type: 'm', dx: 0, dy: 0 }), []);
  assert.deepEqual(inputToCommands({ type: 'c', b: 'r' }), ['c r']);
  assert.deepEqual(inputToCommands({ type: 'c', b: 'x' }), ['c l']);
  assert.deepEqual(inputToCommands({ type: 'k', k: 'playpause' }), ['k playpause']);
  assert.deepEqual(inputToCommands({ type: 'k', k: 'alt+f4' }), []);
  assert.deepEqual(inputToCommands({ type: 't', s: 'hi\r\nthere\u0007' }), ['t hi', 'k enter', 't there']);
  assert.deepEqual(inputToCommands({ type: 'w', n: 12 }), ['w 12']);
  assert.deepEqual(inputToCommands({ type: 'exec', cmd: 'calc' }), []);
  assert.deepEqual(inputToCommands(null), []);
});

function wsOpen(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const first = new Promise((r) => ws.once('message', (d) => r(JSON.parse(d.toString()))));
    ws.once('open', () => resolve({ ws, first }));
    ws.once('error', reject);
  });
}

test('websocket: token required, remote gated by setting, rotation disconnects', async () => {
  let remote = false;
  await withServer(
    async ({ srv, base }) => {
      const wsBase = base.replace('http', 'ws');
      await assert.rejects(wsOpen(`${wsBase}/ws?t=wrong`));
      const inputs = [];
      srv.on('input', (l) => inputs.push(l));
      const { ws, first } = await wsOpen(`${wsBase}/ws?t=${srv.token}`);
      const hello = await first;
      assert.equal(hello.type, 'state');
      assert.equal(hello.remote, false);
      assert.equal(srv.clientCount(), 1);
      ws.send(JSON.stringify({ type: 'c', b: 'l' }));
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(inputs, []); // remote off: ignored
      remote = true;
      ws.send(JSON.stringify({ type: 'c', b: 'l' }));
      ws.send('garbage');
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(inputs, ['c l']);
      const closed = new Promise((r) => ws.once('close', (code) => r(code)));
      srv.rotateToken();
      assert.equal(await closed, 4001);
    },
    { remoteEnabled: () => remote },
  );
});

test('buildArgs: audio device, injection guard, keep window open', () => {
  const dev = '{0.0.0.00000000}.{6f0d5ded-7e15-4bfe-b015-265df90bc188}';
  const a = buildArgs({ deviceName: 'PC', audioMode: 'pc', audioDevice: dev, keepWindowOpen: true });
  if (process.platform === 'win32') assert.ok(a.includes(`wasapisink device="${dev}"`));
  assert.ok(a.includes('-nc'));
  const evil = buildArgs({ deviceName: 'PC', audioMode: 'pc', audioDevice: 'x" ! filesink location=C:/evil' });
  assert.ok(!evil.some((x) => x.includes('filesink')));
});

test('parseAudioList reads helper output', () => {
  const out = ' \t{0.0.0.00000000}.{aa}\tSpeakers (Realtek)\r\n*\t{0.0.0.00000000}.{bb}\tHeadset\r\n\r\n';
  assert.deepEqual(parseAudioList(out), [
    { id: '{0.0.0.00000000}.{aa}', name: 'Speakers (Realtek)', isDefault: false },
    { id: '{0.0.0.00000000}.{bb}', name: 'Headset', isDefault: true },
  ]);
});

test('addMirrorToObs speaks obs-websocket v5 (mock server)', async () => {
  const { addMirrorToObs, WINDOW } = require('../src/obs');
  const wss = new WebSocket.Server({ port: 0, handleProtocols: (p) => (p.has('obswebsocket.json') ? 'obswebsocket.json' : false) });
  await new Promise((r) => wss.once('listening', r));
  const port = wss.address().port;
  const seen = [];
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ op: 0, d: { rpcVersion: 1, authentication: { salt: 'SALT', challenge: 'CHAL' } } }));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.op === 1) {
        if (m.d.authentication !== authString('pw', 'SALT', 'CHAL')) return ws.close(4009);
        return ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      }
      if (m.op === 6) {
        seen.push(m.d);
        const reply = (responseData, result = true, code = 100) =>
          ws.send(JSON.stringify({ op: 7, d: { requestType: m.d.requestType, requestId: m.d.requestId, requestStatus: { result, code }, responseData } }));
        if (m.d.requestType === 'GetCurrentProgramScene') reply({ sceneName: 'Gaming' });
        else if (m.d.requestType === 'CreateInput') reply({ inputUuid: 'x' });
      }
    });
  });
  try {
    await assert.rejects(addMirrorToObs({ password: 'wrong', url: `ws://127.0.0.1:${port}` }), /password/);
    const res = await addMirrorToObs({ password: 'pw', url: `ws://127.0.0.1:${port}` });
    assert.deepEqual(res, { scene: 'Gaming', created: true });
    const create = seen.find((d) => d.requestType === 'CreateInput');
    assert.equal(create.requestData.sceneName, 'Gaming');
    assert.equal(create.requestData.inputKind, 'window_capture');
    assert.equal(create.requestData.inputSettings.window, WINDOW);
    await assert.rejects(addMirrorToObs({ url: 'ws://127.0.0.1:1' }), /Could not reach OBS/);
  } finally {
    wss.close();
  }
});
