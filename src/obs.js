'use strict';
// Adds the mirror window to OBS Studio through obs-websocket (v5 protocol,
// built into OBS 28+; enable it in OBS: Tools -> WebSocket Server Settings).

const crypto = require('crypto');
const WebSocket = require('ws');

const INPUT_NAME = 'iPhone mirror (AirBridge)';
// OBS window-capture target: "title:class:exe". Matching by exe (priority 2)
// keeps working when the window is re-created for each mirroring session.
const WINDOW = 'Direct3D12 Renderer:GstD3D12Hwnd:uxplay.exe';

function authString(password, salt, challenge) {
  const sha = (s) => crypto.createHash('sha256').update(s).digest('base64');
  return sha(sha(password + salt) + challenge);
}

/**
 * Connects to obs-websocket and creates a Window Capture source for the mirror
 * in the current scene. Resolves { scene, created } or rejects with a readable Error.
 */
function addMirrorToObs({ password = '', url = 'ws://127.0.0.1:4455', timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, 'obswebsocket.json');
    let nextId = 1;
    const pending = new Map();
    const done = (err, val) => {
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.close();
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => done(new Error('OBS did not answer. Is OBS open with its WebSocket server enabled?')), timeoutMs);
    const request = (requestType, requestData) =>
      new Promise((res) => {
        const requestId = String(nextId++);
        pending.set(requestId, res);
        ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      });

    ws.on('error', (e) =>
      done(new Error(e.code === 'ECONNREFUSED' ? 'Could not reach OBS. Open OBS and turn on Tools → WebSocket Server Settings → Enable.' : `OBS connection failed: ${e.message}`)),
    );
    ws.on('close', (code) => {
      if (code === 4009) done(new Error('OBS rejected the password.'));
      else done(new Error(`OBS closed the connection (code ${code}).`));
    });

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.op === 0) {
        // Hello: identify, with auth if OBS asks for it.
        const auth = msg.d.authentication;
        if (auth && !password) return done(new Error('OBS needs its WebSocket password. Enter it and try again.'));
        const d = { rpcVersion: 1 };
        if (auth) d.authentication = authString(password, auth.salt, auth.challenge);
        ws.send(JSON.stringify({ op: 1, d }));
      } else if (msg.op === 7) {
        const res = pending.get(msg.d.requestId);
        if (res) {
          pending.delete(msg.d.requestId);
          res(msg.d);
        }
      } else if (msg.op === 2) {
        // Identified: do the work.
        try {
          const cur = await request('GetCurrentProgramScene', {});
          if (!cur.requestStatus.result) return done(new Error('Could not read the current OBS scene.'));
          const scene = cur.responseData.sceneName || cur.responseData.currentProgramSceneName;
          const made = await request('CreateInput', {
            sceneName: scene,
            inputName: INPUT_NAME,
            inputKind: 'window_capture',
            inputSettings: { window: WINDOW, priority: 2, method: 2, client_area: true, cursor: false },
            sceneItemEnabled: true,
          });
          if (made.requestStatus.result) return done(null, { scene, created: true });
          // Already exists (code 601): make sure it's in this scene too.
          if (made.requestStatus.code === 601) {
            const has = await request('GetSceneItemId', { sceneName: scene, sourceName: INPUT_NAME });
            if (has.requestStatus.result) return done(null, { scene, created: false, existed: true });
            const item = await request('CreateSceneItem', { sceneName: scene, sourceName: INPUT_NAME, sceneItemEnabled: true });
            return done(null, { scene, created: !!item.requestStatus.result });
          }
          done(new Error(`OBS refused: ${made.requestStatus.comment || made.requestStatus.code}`));
        } catch (e) {
          done(e);
        }
      }
    });
  });
}

module.exports = { addMirrorToObs, authString, INPUT_NAME, WINDOW };
