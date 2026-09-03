'use strict';

/**
 * Lightweight persistent store for settings, favorites and the last-used scan
 * range.  Uses electron-store when available and falls back to a hand-rolled
 * JSON file in userData so the module also works in plain-node unit contexts.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  settings: {
    timeoutMs: 1000,
    concurrency: 64,
    resolveNames: true,
    scanPorts: true,
    tcpFallback: true,
    theme: 'system',
    autoCheckUpdates: true,
    portList: [21, 22, 80, 135, 139, 443, 445, 3389, 5900, 8080],
  },
  lastRange: '',
  favorites: [], // [{ ip, name, mac }]
};

let backing = null;

function init(app) {
  if (backing) return backing;
  try {
    // eslint-disable-next-line global-require
    const Store = require('electron-store');
    const store = new Store({ name: 'ip-scanner-config', defaults: DEFAULTS });
    backing = {
      get: (k) => store.get(k),
      set: (k, v) => store.set(k, v),
      all: () => store.store,
    };
    return backing;
  } catch (_) {
    // Fallback: JSON file in userData.
    const dir = app && app.getPath ? app.getPath('userData') : process.cwd();
    const file = path.join(dir, 'ip-scanner-config.json');
    let data = { ...DEFAULTS };
    try {
      data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (_) {
      /* first run */
    }
    const persist = () => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
      } catch (_) {
        /* ignore */
      }
    };
    backing = {
      get: (k) => data[k],
      set: (k, v) => {
        data[k] = v;
        persist();
      },
      all: () => data,
    };
    return backing;
  }
}

function ensure() {
  if (!backing) init(null);
  return backing;
}

// ---- Settings ----------------------------------------------------------
function getSettings() {
  return { ...DEFAULTS.settings, ...(ensure().get('settings') || {}) };
}
function setSettings(patch) {
  const merged = { ...getSettings(), ...patch };
  ensure().set('settings', merged);
  return merged;
}

// ---- Last range --------------------------------------------------------
function getLastRange() {
  return ensure().get('lastRange') || '';
}
function setLastRange(range) {
  ensure().set('lastRange', range || '');
}

// ---- Favorites ---------------------------------------------------------
function getFavorites() {
  return ensure().get('favorites') || [];
}
function addFavorite(fav) {
  const list = getFavorites();
  if (!list.some((f) => f.ip === fav.ip)) {
    list.push({ ip: fav.ip, name: fav.name || '', mac: fav.mac || '' });
    ensure().set('favorites', list);
  }
  return list;
}
function removeFavorite(ip) {
  const list = getFavorites().filter((f) => f.ip !== ip);
  ensure().set('favorites', list);
  return list;
}

module.exports = {
  init,
  DEFAULTS,
  getSettings,
  setSettings,
  getLastRange,
  setLastRange,
  getFavorites,
  addFavorite,
  removeFavorite,
};
