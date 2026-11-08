'use strict';
// Runs in a hidden window. Captures the screen (main process picks the
// display via setDisplayMediaRequestHandler) and keeps one RTCPeerConnection
// per watching phone. Signaling goes main <-> phone server <-> phone page.

// (named "bridge": a top-level "caster" would clash with the global the preload defines)
const bridge = window.caster;
let stream = null;
let options = { audio: false, quality: 'sharp' };
const peers = new Map(); // viewer id -> RTCPeerConnection

const QUALITY = {
  // Sharp: text stays crisp, frame rate drops under load.
  sharp: { fps: 30, maxBitrate: 10_000_000, hint: 'detail', degradation: 'maintain-resolution' },
  // Smooth: for video and games, resolution drops under load instead.
  smooth: { fps: 60, maxBitrate: 14_000_000, hint: 'motion', degradation: 'maintain-framerate' },
};

function report() {
  bridge.send({ type: 'viewers', count: [...peers.values()].filter((p) => p.connectionState === 'connected').length });
}

async function start(opts) {
  options = { ...options, ...opts };
  const q = QUALITY[options.quality] || QUALITY.sharp;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      // The display's native size (sent by main), capped at 4K.
      video: {
        frameRate: { ideal: q.fps, max: q.fps },
        width: { ideal: Math.min(options.width || 1920, 3840), max: 3840 },
        height: { ideal: Math.min(options.height || 1080, 2160), max: 2160 },
      },
      audio: !!options.audio,
    });
    const [video] = stream.getVideoTracks();
    video.contentHint = q.hint;
    // If Windows ends the capture (display unplugged, etc.), tell main.
    video.addEventListener('ended', () => {
      stop();
      bridge.send({ type: 'error', message: 'Screen capture ended.' });
    });
    bridge.send({ type: 'started', width: video.getSettings().width, height: video.getSettings().height });
  } catch (e) {
    bridge.send({ type: 'error', message: `Could not capture the screen: ${e.message}` });
  }
}

function stop() {
  for (const id of [...peers.keys()]) dropViewer(id);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  report();
}

function preferH264(pc) {
  // H.264 is hardware-decoded on iPhones and most Android phones.
  const caps = RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities('video');
  if (!caps) return;
  const h264 = caps.codecs.filter((c) => /h264/i.test(c.mimeType));
  const rest = caps.codecs.filter((c) => !/h264/i.test(c.mimeType));
  for (const t of pc.getTransceivers()) {
    if (t.sender.track && t.sender.track.kind === 'video' && t.setCodecPreferences && h264.length) t.setCodecPreferences([...h264, ...rest]);
  }
}

async function addViewer(id) {
  if (!stream) return;
  dropViewer(id);
  const q = QUALITY[options.quality] || QUALITY.sharp;
  // LAN only: no STUN/TURN servers, host candidates are enough.
  const pc = new RTCPeerConnection({ iceServers: [] });
  peers.set(id, pc);
  for (const track of stream.getTracks()) pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
  preferH264(pc);
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    const p = sender.getParameters();
    p.degradationPreference = q.degradation;
    p.encodings = (p.encodings && p.encodings.length ? p.encodings : [{}]).map((e) => ({ ...e, maxBitrate: q.maxBitrate, maxFramerate: q.fps }));
    sender.setParameters(p).catch(() => {});
  }
  pc.onicecandidate = (e) => bridge.send({ type: 'signal', id, data: { candidate: e.candidate ? e.candidate.toJSON() : null } });
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) dropViewer(id);
    report();
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  bridge.send({ type: 'signal', id, data: { sdp: pc.localDescription.toJSON() } });
}

function dropViewer(id) {
  const pc = peers.get(id);
  if (!pc) return;
  peers.delete(id);
  try {
    pc.close();
  } catch {}
  report();
}

async function onSignal(id, data) {
  const pc = peers.get(id);
  if (!pc || !data) return;
  try {
    if (data.sdp && data.sdp.type === 'answer') await pc.setRemoteDescription(data.sdp);
    else if (data.candidate) await pc.addIceCandidate(data.candidate);
  } catch (e) {
    bridge.send({ type: 'log', message: `viewer ${id}: ${e.message}` });
  }
}

bridge.onCommand((cmd) => {
  if (cmd.type === 'start') start(cmd.options);
  else if (cmd.type === 'stop') stop();
  else if (cmd.type === 'join') addViewer(cmd.id);
  else if (cmd.type === 'leave') dropViewer(cmd.id);
  else if (cmd.type === 'signal') onSignal(cmd.id, cmd.data);
});
bridge.send({ type: 'ready' });
