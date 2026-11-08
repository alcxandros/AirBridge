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
    o.textContent = `${a.address} (${a.name})`;
    o.selected = a.address === up.chosenAddress;
    sel.append(o);
  }
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

const set = (patch) => api.updateSettings(patch).then(render);

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
