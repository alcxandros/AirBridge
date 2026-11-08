'use strict';
const api = window.airbridge;
const $ = (id) => document.getElementById(id);
let state = null;

const STATE_TEXT = {
  running: 'Ready — visible to Apple devices on this network',
  starting: 'Starting…',
  stopped: 'Off',
  error: 'Problem',
  missing: 'Receiver engine not installed',
};

const fmtBytes = (n) => (n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- pages (sidebar) ----
function showPage(name) {
  if (!$('page-' + name)) name = 'connect';
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.page === name));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('on', p.id === 'page-' + name));
  try { localStorage.setItem('page', name); } catch {}
}
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => showPage(b.dataset.page)));
try { showPage(localStorage.getItem('page') || 'connect'); } catch { showPage('connect'); }

// ---- streamer mode: hide personal details; click one to show it for 10 s ----
const revealed = new Map(); // key -> timer
const streamer = () => !!(state && state.streamer && state.streamer.on);
const hidden = (key) => streamer() && !revealed.has(key);
function reveal(key) {
  clearTimeout(revealed.get(key));
  revealed.set(key, setTimeout(() => { revealed.delete(key); if (state) render(state); }, 10000));
  if (state) render(state);
}
// Folder paths contain the Windows user name, often a real name.
const maskPath = (p) => (streamer() ? String(p || '').replace(/^([A-Za-z]:\\Users\\)[^\\]+/i, '$1•••') : p);

function render(s) {
  state = s;
  const st = s.settings;
  $('theme').value = st.theme;
  accent = st.accent;
  applyAccent();
  $('version').textContent = 'AirBridge v' + s.version;
  renderUpdate(s);
  renderStreamer(s);
  $('publicWarn').classList.toggle('hidden', !s.publicNetworks.length);
  $('publicNames').textContent = s.publicNetworks.join(', ');

  // Mirror iPhone
  $('receiverEnabled').checked = st.receiverEnabled;
  const rx = s.receiver;
  $('rxDot').className = 'dot ' + rx.state;
  $('navMirrorDot').className = 'dot ' + (rx.state === 'running' && rx.client ? 'running' : rx.state === 'error' || rx.state === 'missing' ? 'error' : '');
  let text = STATE_TEXT[rx.state] || rx.state;
  if (rx.state === 'running' && rx.client) text = `Connected: ${streamer() ? 'an Apple device' : rx.client.name}`;
  if (rx.error) text += ` — ${rx.error}`;
  $('rxText').textContent = text;
  $('navMirror').textContent = !st.receiverEnabled ? 'Off' : rx.state === 'running' ? (rx.client ? 'Mirroring now' : 'Ready') : STATE_TEXT[rx.state] || rx.state;
  $('nameEcho').textContent = st.deviceName;
  if (document.activeElement !== $('deviceName')) $('deviceName').value = st.deviceName;
  $('audioMode').value = st.audioMode;
  $('audioHint').classList.toggle('hidden', st.audioMode !== 'phone');
  renderAudioDevices(s);
  $('keepWindowOpen').checked = st.keepWindowOpen;
  $('obsPassword').placeholder = st.hasObsPassword ? 'Saved password (leave empty to reuse)' : 'OBS WebSocket password (if set)';
  renderBridge(s);
  renderExtras(s);
  renderCast(s);
  $('requirePin').checked = st.requirePin;
  $('fullscreen').checked = st.fullscreen;
  $('h265').checked = st.h265;
  $('pinRow').classList.toggle('hidden', !st.requirePin);
  $('pinValue').textContent = hidden('pin') ? '••••' : st.pin;
  $('pinReveal').classList.toggle('hidden', !hidden('pin'));
  // The log can show phone names and folder paths.
  $('log').classList.toggle('hidden', streamer());
  $('logHidden').classList.toggle('hidden', !streamer());
  if (!streamer()) $('log').textContent = s.log.join('\n');

  // Connect a phone
  $('qr').classList.toggle('disabled', !st.uploadsEnabled);
  const up = s.uploads;
  if (up.qr) $('qr').src = up.qr;
  const qrHidden = hidden('qr');
  $('qrBox').classList.toggle('blurred', qrHidden);
  $('qrReveal').classList.toggle('hidden', !qrHidden);
  $('url').textContent = qrHidden ? 'Link hidden in streamer mode.' : up.url || 'No Wi-Fi or Ethernet network found.';
  $('uploadError').textContent = up.error;
  $('uploadError').classList.toggle('hidden', !up.error);
  const sel = $('address');
  if (document.activeElement !== sel) {
    sel.innerHTML = '';
    for (const a of up.addresses) {
      const o = document.createElement('option');
      o.value = a.address;
      o.textContent = a.tailscale ? `${a.address} (Tailscale: works at home and away)` : `${a.address} (${a.name})`;
      o.selected = a.address === up.chosenAddress;
      sel.append(o);
    }
  }
  const ts = up.addresses.find((a) => a.tailscale);
  const usingTs = ts && ts.address === up.chosenAddress;
  $('awayHint').textContent = usingTs
    ? 'Using Tailscale: phones signed in to the same Tailscale account can connect from anywhere. Scan the QR code again on each phone after switching.'
    : ts
      ? 'To use AirBridge away from home, pick the Tailscale address above and scan the QR code again.'
      : 'Away from home? Install Tailscale (free) on this PC and your phone, sign in to the same account on both, and a Tailscale address will appear above.';
  $('navConnect').textContent = s.phoneClients ? `${plural(s.phoneClients, 'phone')} connected` : 'No phone connected';

  // Files
  $('uploadsEnabled').checked = st.uploadsEnabled;
  $('uploadDir').textContent = maskPath(st.uploadDir);
  const ul = $('received');
  ul.innerHTML = '';
  if (!s.received.length) ul.innerHTML = '<li class="empty">Nothing yet.</li>';
  s.received.forEach((f, i) => {
    const el = document.createElement('li');
    const key = 'rcv:' + f.path;
    const b = document.createElement('button');
    b.className = 'link';
    if (hidden(key)) {
      b.textContent = `File ${i + 1} (hidden, click to show)`;
      b.classList.add('masked');
      b.onclick = () => reveal(key);
    } else {
      b.textContent = f.name;
      b.title = 'Show in folder';
      b.onclick = () => api.showFile(f.path);
    }
    const meta = document.createElement('span');
    meta.textContent = `${fmtBytes(f.bytes)} · ${new Date(f.at).toLocaleTimeString()}`;
    el.append(b, meta);
    ul.append(el);
  });
  $('navFiles').textContent = [s.received.length && `${s.received.length} received`, s.shared.length && `${s.shared.length} shared`].filter(Boolean).join(' · ');
}

function renderAudioDevices(s) {
  const sel = $('audioDevice');
  $('audioDeviceRow').classList.toggle('hidden', s.settings.audioMode !== 'pc' || !s.audioOutputs.length);
  if (document.activeElement === sel) return;
  sel.innerHTML = '';
  const def = s.audioOutputs.find((d) => d.isDefault);
  const opts = [{ id: '', name: `Windows default${def ? ` (${def.name})` : ''}` }, ...s.audioOutputs];
  // Keep a saved device visible even while it's unplugged.
  if (s.settings.audioDevice && !s.audioOutputs.some((d) => d.id === s.settings.audioDevice)) {
    opts.push({ id: s.settings.audioDevice, name: 'Saved device (not connected)' });
  }
  for (const d of opts) {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.name;
    o.selected = d.id === s.settings.audioDevice;
    sel.append(o);
  }
}

/** A list row. With `secret` set, streamer mode shows a placeholder until clicked. */
function li(text, actions = [], { secret = null, placeholder = 'Hidden, click to show' } = {}) {
  const el = document.createElement('li');
  const span = document.createElement('span');
  span.className = 'text';
  if (secret && hidden(secret)) {
    span.textContent = placeholder;
    span.classList.add('masked');
    span.onclick = () => reveal(secret);
  } else {
    span.textContent = text;
    span.title = text;
  }
  const box = document.createElement('span');
  box.className = 'row-actions';
  for (const [label, fn] of actions) {
    const b = document.createElement('button');
    b.className = 'link';
    b.textContent = label;
    b.onclick = fn;
    box.append(b);
  }
  el.append(span, box);
  return el;
}

function fill(ul, items, empty) {
  ul.innerHTML = '';
  if (!items.length && empty) {
    const e = document.createElement('li');
    e.className = 'empty';
    e.textContent = empty;
    ul.append(e);
  }
  for (const i of items) ul.append(i);
}

function renderBridge(s) {
  const st = s.settings;
  fill(
    $('sharedList'),
    s.shared.map((f, i) => li(`${f.name} · ${fmtBytes(f.size)}`, [['Remove', () => api.unshare(f.id).then(render)]], { secret: 'shr:' + f.id, placeholder: `File ${i + 1} · ${fmtBytes(f.size)} (hidden)` })),
  );
  $('autoCopyClipboard').checked = st.autoCopyClipboard;
  fill(
    $('phoneTexts'),
    s.phoneTexts.slice(0, 8).map((t, i) => li(t.text, [['Copy', () => api.copyText(t.text)]], { secret: 'txt:' + t.at, placeholder: `Text ${i + 1} (hidden, click to show)` })),
    'Nothing yet.',
  );
  $('autoOpenLinks').checked = st.autoOpenLinks;
  fill(
    $('linkList'),
    s.links.slice(0, 10).map((l, i) => li(l.url, [['Open', () => api.openLink(l.url)]], { secret: 'lnk:' + l.at, placeholder: `Link ${i + 1} (hidden, click to show)` })),
    'Nothing yet.',
  );
  $('navClip').textContent = [s.phoneTexts.length && plural(s.phoneTexts.length, 'text'), s.links.length && plural(s.links.length, 'link')].filter(Boolean).join(' · ');
  $('remoteEnabled').checked = st.remoteEnabled;
  $('remoteEnabled').disabled = !s.remoteAvailable;
  if (!s.remoteAvailable) $('remoteHint').textContent = 'Remote control needs the AirBridge helper (Windows build).';
}

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

function renderExtras(s) {
  const st = s.settings;
  // Start with Windows
  $('startWithWindows').checked = st.startWithWindows;
  $('startWithWindows').disabled = !s.canStartWithWindows;
  $('startHint').classList.toggle('hidden', s.canStartWithWindows);
  // Capture
  $('recordSessions').checked = st.recordSessions;
  $('recordHint').classList.toggle('hidden', !st.recordSessions);
  $('recordDir').textContent = maskPath(st.recordDir);
  $('screenshot').disabled = !(s.receiver.state === 'running' && s.receiver.client);
  $('screenshot').title = $('screenshot').disabled ? 'Start mirroring from the phone first' : 'Save a PNG of the mirrored screen';
  // Remembered phones (names can include a real name: "Alex's iPhone")
  fill(
    $('deviceList'),
    s.devices
      .slice()
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((d, i) => li(`${d.name} · last seen ${ago(d.lastSeen)}`, [['Remove', () => api.forgetDevice(d.id).then(render)]], { secret: 'dev:' + d.id, placeholder: `Phone ${i + 1} · last seen ${ago(d.lastSeen)}` })),
    'None yet.',
  );
  // HTTPS
  $('httpsEnabled').checked = st.httpsEnabled;
  const t = s.tls;
  $('tlsInfo').textContent = t.error
    ? t.error
    : t.enabled
      ? `On, port ${t.port}. Certificate fingerprint starts ${t.fingerprint.slice(0, 23)}.`
      : 'Off. Phones use plain HTTP on your home network.';
}

function renderCast(s) {
  const c = s.cast;
  const st = s.settings;
  $('castOn').checked = c.active || c.starting;
  const watching = c.viewers ? `${plural(c.viewers, 'phone')} watching` : 'no phone watching yet';
  $('castDot').className = 'dot ' + (c.active ? 'sharing' : c.starting ? 'starting' : c.error ? 'error' : '');
  $('navScreenDot').className = 'dot ' + (c.active ? 'sharing' : '');
  $('castText').textContent = c.error
    ? c.error
    : c.active
      ? `Sharing ${c.width}×${c.height}, ${watching}.`
      : c.starting
        ? 'Starting…'
        : 'Not sharing';
  $('navScreen').textContent = c.active ? `Sharing · ${watching}` : st.remoteEnabled ? 'Remote control on' : '';
  $('castBanner').classList.toggle('hidden', !c.active);
  $('castBannerViewers').textContent = c.active ? `· ${watching}` : '';
  const sel = $('castDisplay');
  if (document.activeElement !== sel) {
    sel.innerHTML = '';
    for (const d of s.displays) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.label;
      o.selected = st.castDisplay ? d.id === st.castDisplay : d.primary;
      sel.append(o);
    }
  }
  $('castAudio').value = st.castAudio;
  $('castQuality').value = st.castQuality;
}

function renderStreamer(s) {
  const on = streamer();
  const st = s.settings;
  const obs = s.streamer && s.streamer.obsRunning;
  document.body.classList.toggle('streamer', on);
  $('streamerMode').checked = on;
  $('streamerAuto').checked = st.streamerAuto;
  $('streamerChip').classList.toggle('on', on);
  $('streamerChipText').textContent = on ? 'Streamer mode on' : 'Streamer mode';
  $('streamerBanner').classList.toggle('hidden', !on);
  $('streamerWhy').textContent = !st.streamerMode && obs ? 'OBS is running.' : '';
  $('streamerState').textContent = st.streamerAuto ? (obs ? 'OBS is running, so streamer mode is on.' : "OBS isn't running right now.") : '';
  $('navSettings').textContent = on ? 'Streamer mode on' : '';
  if (!on && revealed.size) {
    for (const t of revealed.values()) clearTimeout(t);
    revealed.clear();
  }
}

const set = (patch) => api.updateSettings(patch).then(render);

// Turning it off by hand also stops the OBS automation, so it really goes off.
function setStreamer(on) {
  set(on ? { streamerMode: true } : { streamerMode: false, streamerAuto: false });
}
$('streamerMode').onchange = (e) => setStreamer(e.target.checked);
$('streamerChip').onclick = () => setStreamer(!streamer());
$('streamerAuto').onchange = (e) => set({ streamerAuto: e.target.checked });
$('qrReveal').onclick = () => reveal('qr');
$('pinReveal').onclick = () => reveal('pin');
$('openRepo').onclick = () => api.openRepo();

// ---- updates ----
function renderUpdate(s) {
  const u = s.update || { status: 'dev' };
  $('autoUpdate').checked = s.settings.autoUpdate;
  $('autoUpdate').disabled = u.status === 'dev';
  $('checkUpdate').classList.toggle('hidden', u.status === 'dev' || ['checking', 'downloading', 'ready'].includes(u.status));
  const when = u.checkedAt ? ` (checked ${new Date(u.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : '';
  $('updateText').textContent = {
    dev: 'Updates work in the installed app.',
    idle: `You have v${u.current}.`,
    checking: 'Checking for updates…',
    none: `v${u.current} is the latest version${when}.`,
    downloading: `Downloading v${u.version}… ${u.progress || 0}%`,
    ready: `v${u.version} is ready to install.`,
    error: `Update check failed: ${u.error}`,
  }[u.status] || '';
  $('updateBanner').classList.toggle('hidden', u.status !== 'ready');
  $('updateVersion').textContent = u.version || '';
}
$('autoUpdate').onchange = (e) => set({ autoUpdate: e.target.checked });
$('checkUpdate').onclick = () => api.checkUpdate().then(render);
$('installUpdate').onclick = () => api.installUpdate();

// ---- appearance: theme (main process sets nativeTheme) and accent colour ----
// [light, dark] shades; the same list is in web/phone.html.
const ACCENTS = { blue: ['#2f6fec', '#5b8ff5'], purple: ['#7a4fe0', '#a585f5'], teal: ['#0e8a87', '#35c2bd'], orange: ['#c8620f', '#f29a4a'], pink: ['#c9346f', '#f07ab0'] };
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
let accent = 'blue';
function applyAccent() {
  const [light, dark] = ACCENTS[accent] || ACCENTS.blue;
  document.documentElement.style.setProperty('--accent', darkQuery.matches ? dark : light);
  for (const b of $('accents').children) {
    b.classList.toggle('on', b.dataset.accent === accent);
    b.setAttribute('aria-checked', String(b.dataset.accent === accent));
  }
}
darkQuery.addEventListener('change', applyAccent);
for (const [name, [light]] of Object.entries(ACCENTS)) {
  const b = document.createElement('button');
  b.dataset.accent = name;
  b.title = name[0].toUpperCase() + name.slice(1);
  b.setAttribute('role', 'radio');
  b.style.background = light;
  b.onclick = () => set({ accent: name });
  $('accents').append(b);
}
$('theme').onchange = (e) => set({ theme: e.target.value });

$('receiverEnabled').onchange = (e) => set({ receiverEnabled: e.target.checked });
$('audioMode').onchange = (e) => set({ audioMode: e.target.value });
$('requirePin').onchange = (e) => set({ requirePin: e.target.checked });
$('fullscreen').onchange = (e) => set({ fullscreen: e.target.checked });
$('h265').onchange = (e) => set({ h265: e.target.checked });
$('deviceName').onchange = (e) => set({ deviceName: e.target.value });
$('newPin').onclick = () => api.newPin().then(render);
$('restart').onclick = () => api.restartReceiver().then(render);
$('uploadsEnabled').onchange = (e) => set({ uploadsEnabled: e.target.checked });
$('chooseFolder').onclick = () => api.chooseFolder().then(render);
$('openFolder').onclick = () => api.openFolder();
$('fixNetwork').onclick = () => api.openNetworkSettings();
$('audioDevice').onchange = (e) => set({ audioDevice: e.target.value });
$('keepWindowOpen').onchange = (e) => set({ keepWindowOpen: e.target.checked });
$('addToObs').onclick = async () => {
  const msg = $('obsMsg');
  msg.className = 'small';
  msg.textContent = 'Connecting to OBS…';
  const res = await api.addToObs($('obsPassword').value);
  $('obsPassword').value = '';
  if (res.ok) {
    msg.className = 'small ok';
    msg.textContent = res.existed
      ? `Already in scene “${res.scene}”.`
      : `Added to scene “${res.scene}”. Start mirroring and it shows up in OBS.`;
  } else {
    msg.className = 'small err';
    msg.textContent = res.error;
  }
  api.getState().then(render);
};
$('autoCopyClipboard').onchange = (e) => set({ autoCopyClipboard: e.target.checked });
$('autoOpenLinks').onchange = (e) => set({ autoOpenLinks: e.target.checked });
$('remoteEnabled').onchange = (e) => set({ remoteEnabled: e.target.checked });
$('startWithWindows').onchange = (e) => set({ startWithWindows: e.target.checked });
$('httpsEnabled').onchange = (e) => set({ httpsEnabled: e.target.checked });
$('recordSessions').onchange = (e) => {
  // Turning recording on or off restarts the receiver, which drops a live session.
  if (state && state.receiver.client && !confirm('This restarts the receiver, so the phone will stop mirroring. Start mirroring again afterwards. Continue?')) {
    e.target.checked = !e.target.checked;
    return;
  }
  set({ recordSessions: e.target.checked });
};
$('chooseRecordDir').onclick = () => api.chooseRecordFolder().then(render);
$('openRecordDir').onclick = () => api.openRecordFolder();
$('castOn').onchange = (e) => api.cast(e.target.checked).then(render);
$('castBannerStop').onclick = () => api.cast(false).then(render);
$('castDisplay').onchange = (e) => set({ castDisplay: e.target.value });
$('castAudio').onchange = (e) => set({ castAudio: e.target.value });
$('castQuality').onchange = (e) => set({ castQuality: e.target.value });
$('screenshot').onclick = async () => {
  const res = await api.screenshot();
  const msg = $('captureMsg');
  msg.className = res.ok ? 'small ok' : 'small err';
  msg.textContent = res.ok ? `Saved ${maskPath(res.file)}` : res.error;
  if (res.ok) {
    msg.style.cursor = 'pointer';
    msg.onclick = () => api.showFile(res.file);
  }
};
$('chooseShare').onclick = () => api.chooseShareFiles().then(render);
$('sendClip').onclick = async () => {
  const res = await api.sendClipboard();
  $('clipMsg').className = res.ok ? 'small ok' : 'small err';
  $('clipMsg').textContent = res.ok ? "Sent. It's under “Clipboard & links” on the phone." : 'Your clipboard has no text.';
};

// Drag files from Explorer onto the drop zone (and ignore drops elsewhere).
const drop = $('drop');
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (e.dataTransfer.files.length) api.shareFiles(Array.from(e.dataTransfer.files)).then(render);
});
$('newLink').onclick = () => api.newLink().then(render);
$('address').onchange = (e) => api.chooseAddress(e.target.value).then(render);

api.onState(render);
api.onLog((line) => {
  if (streamer()) return; // re-filled from state when streamer mode goes off
  const pre = $('log');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.textContent += (pre.textContent ? '\n' : '') + line;
  if (atBottom) pre.scrollTop = pre.scrollHeight;
});
api.getState().then(render);
