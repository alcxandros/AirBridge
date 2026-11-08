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

test('the page loads without a token, but every API needs one', async () => {
  await withServer(async ({ srv, base }) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Test &lt;PC&gt;/);
    for (const p of ['/api/state', '/api/whoami', '/airbridge-ca.crt', '/dl/aaaaaaaaaaaaaaaa']) {
      assert.equal((await fetch(`${base}${p}?t=wrong`)).status, 403, p);
    }
    const up = await fetch(`${base}/upload?t=bad`, { method: 'POST', body: form([['a.txt', 'x']]) });
    assert.equal(up.status, 403);
    assert.equal((await fetch(`${base}/api/whoami?t=${srv.token}`)).status, 200);
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

// ---- remembered phones, HTTPS, recording ----
const { DeviceStore } = require('../src/devices');
const tlsCa = require('../src/tls');

function memSettings(init = {}) {
  const data = { devices: [], ...init };
  return { get: (k) => data[k], update: (p) => Object.assign(data, p), data };
}

test('DeviceStore pairs, verifies, renames duplicates, forgets', () => {
  const s = memSettings();
  const store = new DeviceStore(s);
  const a = store.pair('iPhone');
  const b = store.pair('iPhone');
  assert.equal(b.name, 'iPhone 2');
  assert.match(a.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(store.verify(a.token), { id: a.id, name: 'iPhone' });
  assert.equal(store.verify('f'.repeat(64)), null);
  assert.equal(store.verify('short'), null);
  assert.ok(!JSON.stringify(s.data).includes(a.token)); // only hashes are stored
  store.forget(a.id);
  assert.equal(store.verify(a.token), null);
  assert.ok(store.verify(b.token));
});

test('pairing: QR session -> device token that survives New link; forgetting disconnects', async () => {
  const devices = new DeviceStore(memSettings());
  await withServer(
    async ({ srv, base }) => {
      const paired = [];
      srv.on('paired', (d) => paired.push(d.name));
      const who = await (await fetch(`${base}/api/whoami?t=${srv.token}`)).json();
      assert.equal(who.kind, 'session');
      const r = await fetch(`${base}/api/pair?t=${srv.token}`, { method: 'POST', body: JSON.stringify({ name: 'iPhone' }) });
      const d = await r.json();
      assert.equal(d.name, 'iPhone');
      assert.deepEqual(paired, ['iPhone']);
      // Device tokens can't pair again.
      assert.equal((await fetch(`${base}/api/pair?t=${d.token}`, { method: 'POST', body: '{}' })).status, 400);
      const me = await (await fetch(`${base}/api/whoami?t=${d.token}`)).json();
      assert.equal(me.kind, 'device');

      const wsBase = base.replace('http', 'ws');
      const sess = await wsOpen(`${wsBase}/ws?t=${srv.token}`);
      const dev = await wsOpen(`${wsBase}/ws?t=${d.token}`);
      const sessClosed = new Promise((r) => sess.ws.once('close', (c) => r(c)));
      srv.rotateToken(); // New link: QR pages drop, the remembered phone stays
      assert.equal(await sessClosed, 4001);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(dev.ws.readyState, WebSocket.OPEN);
      assert.equal((await fetch(`${base}/api/state?t=${d.token}`)).status, 200);

      const devClosed = new Promise((r) => dev.ws.once('close', (c) => r(c)));
      devices.forget(d.id);
      srv.closeDevice(d.id);
      assert.equal(await devClosed, 4001);
      assert.equal((await fetch(`${base}/api/state?t=${d.token}`)).status, 403);
    },
    { devices },
  );
});

test('local CA: name-constrained, issues a cert that works over HTTPS for LAN IPs only', async () => {
  const ca = tlsCa.createCa('test');
  const caX = new (require('crypto').X509Certificate)(ca.certPem);
  assert.ok(caX.ca);
  const leaf = tlsCa.issueServerCert({ caKeyPem: ca.keyPem, caCertPem: ca.certPem, ips: ['192.168.50.7'], host: 'MY-PC' });
  const leafX = new (require('crypto').X509Certificate)(leaf.certPem);
  assert.ok(leafX.checkIssued(caX) && leafX.verify(caX.publicKey));
  assert.match(leafX.subjectAltName, /IP Address:192\.168\.50\.7/);
  assert.match(leafX.subjectAltName, /DNS:my-pc\.local/);
  assert.ok(!/CN=/.test(leafX.subject));

  // Serve the phone page over https and fetch it trusting only our CA.
  // (Connect to 127.0.0.1 but verify as the LAN IP, since this test can't bind it.)
  await withServer(
    async ({ srv }) => {
      const port = await srv.startTls(0, { key: leaf.keyPem, cert: leaf.certPem }, '127.0.0.1');
      const https = require('https');
      const get = (servername) =>
        new Promise((resolve) => {
          const req = https.get(
            { host: '127.0.0.1', port, agent: false, path: `/api/whoami?t=${srv.token}`, ca: ca.certPem, checkServerIdentity: (h, cert) => require('tls').checkServerIdentity(servername, cert) },
            (r) => {
              let b = '';
              r.on('data', (c) => (b += c));
              r.on('end', () => resolve({ ok: true, body: JSON.parse(b) }));
            },
          );
          req.on('error', (e) => resolve({ ok: false, err: e.code || e.message }));
        });
      const good = await get('192.168.50.7');
      assert.ok(good.ok, good.err);
      assert.equal(good.body.tlsPort, port);
      const bad = await get('10.9.9.9'); // not in the certificate
      assert.equal(bad.ok, false);
      const der = await fetch(`http://127.0.0.1:${srv.port}/airbridge-ca.crt?t=${srv.token}`);
      assert.equal(der.status, 200);
      assert.equal(der.headers.get('content-type'), 'application/x-x509-ca-cert');
      assert.ok(new (require('crypto').X509Certificate)(Buffer.from(await der.arrayBuffer())).ca);
    },
    { getCaCert: () => ca.certPem },
  );
});

test('buildArgs: recording prefix uses forward slashes', () => {
  const a = buildArgs({ deviceName: 'PC', recordSessions: true, recordPrefix: 'C:\\Users\\A B\\Videos\\AirBridge 2026-11-07' });
  assert.deepEqual(a.slice(a.indexOf('-mp4'), a.indexOf('-mp4') + 2), ['-mp4', 'C:/Users/A B/Videos/AirBridge 2026-11-07']);
  assert.ok(!buildArgs({ deviceName: 'PC', recordSessions: false, recordPrefix: 'x' }).includes('-mp4'));
});

// ---- sharing the PC screen to the phone ----
const { castSignal, pointerMsg } = require('../src/phoneServer');
const { tapToAbsolute, unionRect } = require('../src/pointer');

test('castSignal keeps only well-formed answers and ICE candidates', () => {
  assert.deepEqual(castSignal({ sdp: { type: 'answer', sdp: 'v=0', extra: 1 } }), { sdp: { type: 'answer', sdp: 'v=0' } });
  assert.equal(castSignal({ sdp: { type: 'offer', sdp: 'v=0' } }), null); // phones only answer
  assert.equal(castSignal({ sdp: { type: 'answer', sdp: 'x'.repeat(70000) } }), null);
  assert.deepEqual(castSignal({ candidate: { candidate: 'candidate:1 1 udp 1 192.168.1.5 5000 typ host', sdpMid: '0', sdpMLineIndex: 0, junk: true } }), {
    candidate: { candidate: 'candidate:1 1 udp 1 192.168.1.5 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
  });
  assert.equal(castSignal({ candidate: { candidate: 5 } }), null);
  assert.equal(castSignal('nope'), null);
});

test('pointerMsg validates taps', () => {
  assert.deepEqual(pointerMsg({ x: 0.5, y: 0.25, b: 'r' }), { x: 0.5, y: 0.25, b: 'r' });
  assert.deepEqual(pointerMsg({ x: 0, y: 1 }), { x: 0, y: 1, b: 'l' });
  assert.equal(pointerMsg({ x: 1.2, y: 0.5 }), null);
  assert.equal(pointerMsg({ x: 'a', y: 0.5 }), null);
});

test('tapToAbsolute maps taps across multi-monitor desktops', () => {
  const left = { x: 0, y: 0, width: 1920, height: 1080 };
  const right = { x: 1920, y: -200, width: 2560, height: 1440 };
  const virt = unionRect([left, right]);
  assert.deepEqual(virt, { x: 0, y: -200, width: 4480, height: 1440 });
  // Top-left of the right-hand monitor.
  const [ax, ay] = tapToAbsolute({ x: 0, y: 0 }, right, virt);
  assert.equal(ax, Math.round((1920 * 65535) / 4479));
  assert.equal(ay, 0);
  // Bottom-right corner of the whole desktop.
  assert.deepEqual(tapToAbsolute({ x: 1, y: 1 }, right, virt), [65535, 65535]);
  // Centre of a single-monitor desktop.
  assert.deepEqual(tapToAbsolute({ x: 0.5, y: 0.5 }, left, left), [32768, 32768]);
});

test('screen-share signaling only flows while sharing is on; taps need remote control', async () => {
  let casting = false;
  let remote = false;
  await withServer(
    async ({ srv, base }) => {
      const events = [];
      srv.on('cast', (e) => events.push(e.type));
      srv.on('pointer', (p) => events.push(`tap ${p.x},${p.y}`));
      const { ws, first } = await wsOpen(`${base.replace('http', 'ws')}/ws?t=${srv.token}`);
      assert.equal((await first).cast, false);
      ws.send(JSON.stringify({ type: 'cast-join' }));
      ws.send(JSON.stringify({ type: 'tap', x: 0.5, y: 0.5 }));
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(events, []); // sharing off, remote off
      casting = true;
      remote = true;
      ws.send(JSON.stringify({ type: 'cast-join' }));
      ws.send(JSON.stringify({ type: 'cast-signal', data: { sdp: { type: 'answer', sdp: 'v=0' } } }));
      ws.send(JSON.stringify({ type: 'cast-signal', data: { evil: true } }));
      ws.send(JSON.stringify({ type: 'tap', x: 0.5, y: 0.5 }));
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(events, ['join', 'signal', 'tap 0.5,0.5']);
      // Messages to one viewer reach only that connection.
      const got = new Promise((r) => ws.once('message', (d) => r(JSON.parse(d.toString()))));
      const client = [...srv.wss.clients][0].id;
      srv.sendTo(client, { type: 'cast-signal', data: { sdp: { type: 'offer', sdp: 'v=0' } } });
      assert.equal((await got).type, 'cast-signal');
      // Closing the page tells the caster the viewer left.
      ws.close();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(events.at(-1), 'leave');
    },
    { castActive: () => casting, remoteEnabled: () => remote },
  );
});

test('settings reject unknown values for enum settings', () => {
  const { Settings } = require('../src/settings');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-enum-'));
  const s = new Settings(dir);
  assert.equal(s.update({ castAudio: 'phone' }).castAudio, 'phone');
  assert.equal(s.update({ castAudio: 'loud' }).castAudio, 'phone');
  assert.equal(s.update({ castQuality: 'ultra' }).castQuality, 'sharp');
  fs.rmSync(dir, { recursive: true, force: true });
});
