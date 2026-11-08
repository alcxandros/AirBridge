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

function render(s) {
  state = s;
  const st = s.settings;
  $('theme').value = st.theme;
  accent = st.accent;
  applyAccent();
  $('version').textContent = 'v' + s.version;
  $('publicWarn').classList.toggle('hidden', !s.publicNetworks.length);
  $('publicNames').textContent = s.publicNetworks.join(', ');

  // Mirroring card
  $('receiverEnabled').checked = st.receiverEnabled;
  const rx = s.receiver;
  $('rxDot').className = 'dot ' + rx.state;
  let text = STATE_TEXT[rx.state] || rx.state;
  if (rx.state === 'running' && rx.client) text = `Connected: ${rx.client.name}`;
  if (rx.error) text += ` — ${rx.error}`;
  $('rxText').textContent = text;
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
  $('pinValue').textContent = st.pin;
  $('log').textContent = s.log.join('\n');

  // Files card
  $('uploadsEnabled').checked = st.uploadsEnabled;
  $('qr').classList.toggle('disabled', !st.uploadsEnabled);
  const up = s.uploads;
  if (up.qr) $('qr').src = up.qr;
  $('url').textContent = up.url || 'No Wi-Fi or Ethernet network found.';
  $('uploadError').textContent = up.error;
  $('uploadError').classList.toggle('hidden', !up.error);
  const sel = $('address');
  sel.innerHTML = '';
  for (const a of up.addresses) {
    const o = document.createElement('option');
    o.value = a.address;
    o.textContent = a.tailscale ? `${a.address} (Tailscale: works at home and away)` : `${a.address} (${a.name})`;
    o.selected = a.address === up.chosenAddress;
    sel.append(o);
  }
  const ts = up.addresses.find((a) => a.tailscale);
  const usingTs = ts && ts.address === up.chosenAddress;
  $('awayHint').innerHTML = '';
  $('awayHint').append(
    usingTs
      ? 'Using Tailscale: phones signed in to the same Tailscale account can connect from anywhere. Scan the QR code again on each phone after switching.'
      : ts
        ? 'To use AirBridge away from home, pick the Tailscale address above and scan the QR code again.'
        : 'Away from home? Install Tailscale (free) on this PC and your phone, sign in to the same account on both, and a Tailscale address will appear above.',
  );
  $('uploadDir').textContent = st.uploadDir;

  const ul = $('received');
  ul.innerHTML = '';
  if (!s.received.length) ul.innerHTML = '<li class="empty">Nothing yet.</li>';
  for (const f of s.received) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'link';
    b.textContent = f.name;
    b.title = 'Show in folder';
    b.onclick = () => api.showFile(f.path);
    const meta = document.createElement('span');
    meta.textContent = `${fmtBytes(f.bytes)} · ${new Date(f.at).toLocaleTimeString()}`;
    li.append(b, meta);
    ul.append(li);
  }
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

function li(text, actions = [], title = '') {
  const el = document.createElement('li');
  const span = document.createElement('span');
  span.className = 'text';
  span.textContent = text;
  span.title = title || text;
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
  $('phoneClients').textContent = s.phoneClients ? `${s.phoneClients} phone page${s.phoneClients > 1 ? 's' : ''} open` : 'No phone connected';
  fill($('sharedList'), s.shared.map((f) => li(`${f.name} · ${fmtBytes(f.size)}`, [['Remove', () => api.unshare(f.id).then(render)]])));
  $('autoCopyClipboard').checked = st.autoCopyClipboard;
  fill($('phoneTexts'), s.phoneTexts.slice(0, 5).map((t) => li(t.text, [['Copy', () => api.copyText(t.text)]])));
  $('autoOpenLinks').checked = st.autoOpenLinks;
  fill($('linkList'), s.links.slice(0, 8).map((l) => li(l.url, [['Open', () => api.openLink(l.url)]])), "Use “Clipboard & links” on the phone.");
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
  $('recordDir').textContent = st.recordDir;
  $('screenshot').disabled = !(s.receiver.state === 'running' && s.receiver.client);
  $('screenshot').title = $('screenshot').disabled ? 'Start mirroring from the phone first' : 'Save a PNG of the mirrored screen';
  // Devices
  fill(
    $('deviceList'),
    s.devices
      .slice()
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((d) => li(`${d.name} · last seen ${ago(d.lastSeen)}`, [['Remove', () => api.forgetDevice(d.id).then(render)]])),
    'None yet.',
  );
  // HTTPS
  $('httpsEnabled').checked = st.httpsEnabled;
  const t = s.tls;
  $('tlsInfo').textContent = t.error
    ? t.error
    : t.enabled
      ? `HTTPS on port ${t.port}. The phone page walks through installing the certificate. Its fingerprint starts ${t.fingerprint.slice(0, 23)}.`
      : 'Off. Phones use plain HTTP on your home network.';
}

function renderCast(s) {
  const c = s.cast;
  const st = s.settings;
  $('castOn').checked = c.active || c.starting;
  const watching = c.viewers ? `${c.viewers} phone${c.viewers > 1 ? 's' : ''} watching` : 'no phone watching yet';
  $('castDot').className = 'dot ' + (c.active ? 'sharing' : c.starting ? 'starting' : c.error ? 'error' : '');
  $('castText').textContent = c.error
    ? c.error
    : c.active
      ? `Sharing ${c.width}×${c.height}, ${watching}. Open “Screen & remote” on the phone.`
      : c.starting
        ? 'Starting…'
        : 'Off';
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

const set = (patch) => api.updateSettings(patch).then(render);

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
$('requirePin').onchange =(e) => set({ requirePin: e.target.checked });
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
  msg.textContent = res.ok ? `Saved ${res.file}` : res.error;
  if (res.ok) {
    msg.style.cursor = 'pointer';
    msg.onclick = () => api.showFile(res.file);
  }
};
$('chooseShare').onclick =() => api.chooseShareFiles().then(render);
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
  const pre = $('log');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.textContent += (pre.textContent ? '\n' : '') + line;
  if (atBottom) pre.scrollTop = pre.scrollHeight;
});
api.getState().then(render);
