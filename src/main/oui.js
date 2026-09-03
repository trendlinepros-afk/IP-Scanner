'use strict';

/**
 * MAC address -> manufacturer lookup.
 *
 * Ships with a curated set of common OUI prefixes (data/oui.json).  If a full
 * IEEE OUI database is present (resources/oui-full.txt or data/oui-full.json)
 * it is loaded on top of the curated set for far better coverage.  Everything
 * degrades gracefully to "Unknown" when a prefix is not recognised.
 */

const fs = require('fs');
const path = require('path');

let table = null;

/** Normalise any MAC representation to 12 uppercase hex chars, or null. */
function normalizeMac(mac) {
  if (!mac) return null;
  const hex = String(mac).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return hex.length === 12 ? hex : null;
}

function candidatePaths() {
  // In a packaged app, extraResources land under process.resourcesPath.
  const resourcesPath = process.resourcesPath || path.join(__dirname, '..', '..');
  return {
    curated: [
      path.join(__dirname, '..', '..', 'data', 'oui.json'),
      path.join(resourcesPath, 'data', 'oui.json'),
      path.join(resourcesPath, 'app.asar', 'data', 'oui.json'),
    ],
    fullJson: [
      path.join(__dirname, '..', '..', 'data', 'oui-full.json'),
      path.join(resourcesPath, 'resources', 'oui-full.json'),
    ],
    fullText: [
      path.join(resourcesPath, 'resources', 'oui-full.txt'),
      path.join(__dirname, '..', '..', 'resources', 'oui-full.txt'),
    ],
  };
}

function firstExisting(paths) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

/**
 * Parse an IEEE "oui.txt" style file. Lines look like:
 *   00-0C-29   (hex)    VMware, Inc.
 */
function parseIeeeText(text) {
  const map = {};
  const re = /^([0-9A-Fa-f]{2}[-:]?[0-9A-Fa-f]{2}[-:]?[0-9A-Fa-f]{2})\s+\(hex\)\s+(.+)$/;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(re);
    if (m) {
      const prefix = m[1].replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
      map[prefix] = m[2].trim();
    }
  }
  return map;
}

function load() {
  if (table) return table;
  table = {};

  const paths = candidatePaths();

  const curatedPath = firstExisting(paths.curated);
  if (curatedPath) {
    try {
      Object.assign(table, JSON.parse(fs.readFileSync(curatedPath, 'utf8')));
    } catch (err) {
      // Keep going with an empty/partial table.
    }
  }

  const fullJsonPath = firstExisting(paths.fullJson);
  if (fullJsonPath) {
    try {
      Object.assign(table, JSON.parse(fs.readFileSync(fullJsonPath, 'utf8')));
    } catch (_) {
      /* ignore */
    }
  }

  const fullTextPath = firstExisting(paths.fullText);
  if (fullTextPath) {
    try {
      Object.assign(table, parseIeeeText(fs.readFileSync(fullTextPath, 'utf8')));
    } catch (_) {
      /* ignore */
    }
  }

  // Normalise keys to compact uppercase (handles any stray separators/spaces).
  const normalized = {};
  for (const [k, v] of Object.entries(table)) {
    const key = k.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (key.length >= 6) normalized[key.slice(0, 6)] = v;
  }
  table = normalized;
  return table;
}

/** Look up the vendor for a MAC address. Returns '' when unknown. */
function lookup(mac) {
  const norm = normalizeMac(mac);
  if (!norm) return '';
  const t = load();
  const prefix = norm.slice(0, 6);
  if (t[prefix]) return t[prefix];
  // Locally-administered address (2nd-least-significant bit of first octet).
  const firstOctet = parseInt(norm.slice(0, 2), 16);
  if (firstOctet & 0x02) return 'Locally administered';
  return '';
}

/** How many prefixes are loaded (useful for diagnostics / About box). */
function size() {
  return Object.keys(load()).length;
}

module.exports = { lookup, normalizeMac, size };
