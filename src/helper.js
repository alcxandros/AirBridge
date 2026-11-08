'use strict';
// Wrapper around native/helper.cpp (airbridge-helper.exe): audio device list
// and mouse/keyboard injection for the phone remote. Windows only.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';

function findHelper(resourcesPath, appRoot) {
  if (!IS_WIN) return null;
  for (const root of [resourcesPath && path.join(resourcesPath, 'helper'), appRoot && path.join(appRoot, 'vendor', 'helper')]) {
    if (!root) continue;
    const exe = path.join(root, 'airbridge-helper.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

/** Parses `airbridge-helper audio` output into [{id, name, isDefault}]. */
function parseAudioList(stdout) {
  return String(stdout)
    .split(/\r?\n/)
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 3 && p[1])
    .map(([mark, id, name]) => ({ id, name, isDefault: mark === '*' }));
}

class Helper {
  constructor({ resourcesPath, appRoot }) {
    this.exe = findHelper(resourcesPath, appRoot);
    this.proc = null;
    this.held = new Set();
  }

  available() {
    return !!this.exe;
  }

  audioOutputs() {
    if (!this.exe) return Promise.resolve([]);
    return new Promise((resolve) => {
      execFile(this.exe, ['audio'], { windowsHide: true, timeout: 5000 }, (err, stdout) => resolve(err ? [] : parseAudioList(stdout)));
    });
  }

  /** Send one command line to the long-running input process (started on demand). */
  input(line) {
    if (!this.exe) return;
    if (!this.proc) {
      const log = process.env.AIRBRIDGE_INPUT_LOG;
      this.proc = spawn(this.exe, ['input'], { windowsHide: true, stdio: ['pipe', 'ignore', log ? 'pipe' : 'ignore'] });
      if (log) this.proc.stderr.on('data', (d) => fs.appendFileSync(log, `[helper] ${d}`));
      const p = this.proc;
      p.on('exit', () => {
        // Ignore a stopped process exiting after a new one has started.
        if (this.proc !== p) return;
        this.proc = null;
        this.held.clear();
      });
      this.proc.stdin.on('error', () => {});
    }
    this.proc.stdin.write(line + '\n');
    // Remember a button the phone is holding ("Hold" for drag) so it can be released.
    const m = line.match(/^([du]) ([lrm])$/);
    if (m) {
      if (m[1] === 'd') this.held.add(m[2]);
      else this.held.delete(m[2]);
    }
    if (process.env.AIRBRIDGE_INPUT_LOG) fs.appendFileSync(process.env.AIRBRIDGE_INPUT_LOG, line + '\n');
  }

  /** Release buttons the phone left held down, then stop the input process. */
  stopInput() {
    if (process.env.AIRBRIDGE_INPUT_LOG) fs.appendFileSync(process.env.AIRBRIDGE_INPUT_LOG, `stopInput (running=${!!this.proc}, held=${[...this.held]})\n`);
    if (!this.proc) return;
    for (const b of this.held) this.proc.stdin.write(`u ${b}\n`);
    this.held.clear();
    this.proc.stdin.end();
    this.proc = null;
  }
}

module.exports = { Helper, parseAudioList };
