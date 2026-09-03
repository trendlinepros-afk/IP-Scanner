'use strict';

/**
 * Auto-update integration built on electron-updater against GitHub Releases.
 *
 * Flow (matches the requested behaviour):
 *   1. User clicks "Check for updates".
 *   2. We query GitHub for a newer release.
 *   3. If found, we download it (streaming progress to the UI).
 *   4. When the download completes we show a dialog offering
 *      "Restart & Install"  /  "Later".
 *
 * The updater is only meaningful for the *installed* (NSIS) build.  In the
 * portable build or in development it reports "unsupported" instead of erroring,
 * and the UI hides/greys the button accordingly.
 */

const { dialog } = require('electron');

let autoUpdater = null;
let log = null;

function loadDeps() {
  if (autoUpdater) return true;
  try {
    // eslint-disable-next-line global-require
    autoUpdater = require('electron-updater').autoUpdater;
    try {
      // eslint-disable-next-line global-require
      log = require('electron-log');
      log.transports.file.level = 'info';
      autoUpdater.logger = log;
    } catch (_) {
      /* logging is optional */
    }
    return true;
  } catch (_) {
    return false;
  }
}

class UpdateManager {
  /**
   * @param {import('electron').BrowserWindow} getWindow function returning the main window
   * @param {object} opts { isPortable, isDev }
   */
  constructor(getWindow, opts = {}) {
    this.getWindow = getWindow;
    this.isPortable = !!opts.isPortable;
    this.isDev = !!opts.isDev;
    this.state = 'idle'; // idle | checking | available | downloading | downloaded | none | error | unsupported
    this.info = null;
    this.error = null;
    this.progress = null;
    this.wired = false;
  }

  supported() {
    // Auto-update requires the packaged NSIS installer with app-update.yml.
    if (this.isPortable) return false;
    if (this.isDev) return false;
    if (!loadDeps()) return false;
    return true;
  }

  _send(channel, payload) {
    const win = this.getWindow && this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  _setState(state, extra = {}) {
    this.state = state;
    this._send('update:state', { state, info: this.info, error: this.error, progress: this.progress, ...extra });
  }

  wire() {
    if (this.wired || !this.supported()) return;
    this.wired = true;

    autoUpdater.autoDownload = false; // we control download timing
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => this._setState('checking'));

    autoUpdater.on('update-available', (info) => {
      this.info = { version: info.version, releaseNotes: info.releaseNotes, releaseName: info.releaseName, releaseDate: info.releaseDate };
      this._setState('available');
      // Immediately begin downloading so the user gets the promised
      // "downloads updates and then a popup" experience.
      autoUpdater.downloadUpdate().catch((err) => {
        this.error = err.message;
        this._setState('error');
      });
    });

    autoUpdater.on('update-not-available', (info) => {
      this.info = { version: info && info.version };
      this._setState('none');
    });

    autoUpdater.on('download-progress', (p) => {
      this.progress = {
        percent: Math.round(p.percent),
        transferred: p.transferred,
        total: p.total,
        bytesPerSecond: p.bytesPerSecond,
      };
      this._setState('downloading');
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.info = { version: info.version, releaseNotes: info.releaseNotes, releaseName: info.releaseName };
      this._setState('downloaded');
      this._promptInstall();
    });

    autoUpdater.on('error', (err) => {
      this.error = (err && err.message) || String(err);
      this._setState('error');
    });
  }

  async _promptInstall() {
    const win = this.getWindow && this.getWindow();
    const version = (this.info && this.info.version) || '';
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart & Install', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `IP Scanner ${version} has been downloaded.`,
      detail: 'Would you like to restart and install it now, or later?',
      noLink: true,
    });
    if (response === 0) {
      // isSilent = false so the NSIS UI shows; isForceRunAfter = true to relaunch.
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
    }
  }

  /** Invoked by the "Check for updates" button. */
  async check() {
    if (!this.supported()) {
      this._setState('unsupported');
      return { supported: false, state: 'unsupported' };
    }
    this.wire();
    this.error = null;
    try {
      this._setState('checking');
      await autoUpdater.checkForUpdates();
      return { supported: true, state: this.state, info: this.info };
    } catch (err) {
      this.error = err.message;
      this._setState('error');
      return { supported: true, state: 'error', error: err.message };
    }
  }

  /** Install a downloaded update now (triggered from the UI, not just dialog). */
  installNow() {
    if (this.state === 'downloaded' && this.supported()) {
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
      return { ok: true };
    }
    return { ok: false, reason: 'No update is ready to install' };
  }

  status() {
    return {
      supported: this.supported(),
      state: this.supported() ? this.state : 'unsupported',
      info: this.info,
      error: this.error,
      progress: this.progress,
    };
  }

  /** Silent check at startup (only if enabled in settings and supported). */
  async checkSilently() {
    if (!this.supported()) return;
    this.wire();
    try {
      await autoUpdater.checkForUpdates();
    } catch (_) {
      /* ignore silent-check failures */
    }
  }
}

module.exports = { UpdateManager };
