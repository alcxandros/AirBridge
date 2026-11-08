'use strict';
// App updates from GitHub Releases (electron-updater). Checks shortly after
// start and every few hours when "check automatically" is on, downloads in the
// background, and installs when the user clicks "Restart to update" (or on quit).

const { EventEmitter } = require('events');

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

class Updater extends EventEmitter {
  constructor({ packaged, currentVersion }) {
    super();
    this.packaged = packaged;
    this.state = { status: packaged ? 'idle' : 'dev', current: currentVersion, version: null, progress: 0, error: '', checkedAt: null };
    this.timer = null;
    this.au = null;
    if (!packaged) return;
    // Loaded lazily: electron-updater expects a packaged app.
    const { autoUpdater } = require('electron-updater');
    this.au = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: '' }));
    autoUpdater.on('update-available', (info) => this.set({ status: 'downloading', version: info.version, progress: 0 }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'none', checkedAt: Date.now() }));
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', progress: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => {
      this.set({ status: 'ready', version: info.version, progress: 100, checkedAt: Date.now() });
      this.emit('ready', info.version);
    });
    autoUpdater.on('error', (e) => this.set({ status: 'error', error: friendly(e), checkedAt: Date.now() }));
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  /** Turn automatic checks on/off. */
  setAuto(on) {
    clearInterval(this.timer);
    this.timer = null;
    if (!this.au || !on) return;
    setTimeout(() => this.check(), 15000).unref();
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  check() {
    if (!this.au) return Promise.resolve(this.state);
    if (['checking', 'downloading', 'ready'].includes(this.state.status)) return Promise.resolve(this.state);
    return this.au.checkForUpdates().then(() => this.state, (e) => {
      this.set({ status: 'error', error: friendly(e) });
      return this.state;
    });
  }

  install() {
    if (this.au && this.state.status === 'ready') this.au.quitAndInstall(false, true);
  }
}

function friendly(e) {
  const m = String((e && e.message) || e || '');
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|net::ERR_/i.test(m)) return "Couldn't reach GitHub. Check the internet connection.";
  if (/404/.test(m)) return 'No published release found yet.';
  return m.split('\n')[0].slice(0, 200);
}

module.exports = { Updater };
