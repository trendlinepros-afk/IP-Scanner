'use strict';

/**
 * Backup manager for the system tools. Before anything is deleted, registry
 * keys are exported to .reg files and file/folder removals are recorded (they
 * go to the Recycle Bin). A backup can later be restored (re-imports the .reg
 * files) or discarded. Stored under <userData>/system-tools/backups/<id>/.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const w = require('./winutil');

let ROOT = null;

function configure({ dataDir }) { ROOT = path.join(dataDir, 'system-tools', 'backups'); }
function root() {
  if (!ROOT) ROOT = path.join(require('os').tmpdir(), 'it-tools-backups');
  fs.mkdirSync(ROOT, { recursive: true });
  return ROOT;
}

function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'backup.json'), 'utf8')); } catch (_) { return null; }
}
function writeManifest(dir, m) { fs.writeFileSync(path.join(dir, 'backup.json'), JSON.stringify(m, null, 2)); }

/** Start a backup session; returns a handle used while deleting. */
function begin(label) {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(root(), id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { id, label: String(label || 'Backup'), created: Date.now(), registry: [], files: [] };
  writeManifest(dir, manifest);
  let n = 0;
  return {
    id,
    dir,
    /** Export a registry key before it (or one of its values) is deleted. */
    async saveRegistry(psPath, valueName) {
      n += 1;
      const file = path.join(dir, `reg-${String(n).padStart(3, '0')}.reg`);
      await w.regExport(psPath, file);
      manifest.registry.push({ path: psPath, value: valueName || null, file: path.basename(file) });
      writeManifest(dir, manifest);
    },
    recordFile(p, how) {
      manifest.files.push({ path: p, how });
      writeManifest(dir, manifest);
    },
    finish() {
      // Drop empty sessions so the list only shows meaningful backups.
      if (!manifest.registry.length && !manifest.files.length) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* */ }
        return null;
      }
      return manifest;
    },
  };
}

function list() {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root(), { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = readManifest(path.join(root(), e.name));
    if (m) out.push({ ...m, dir: path.join(root(), e.name), registryCount: m.registry.length, fileCount: m.files.length });
  }
  return out.sort((a, b) => b.created - a.created);
}

async function restore(id) {
  const dir = path.join(root(), path.basename(String(id)));
  const m = readManifest(dir);
  if (!m) return { ok: false, error: 'Backup not found' };
  const results = [];
  for (const r of m.registry) {
    try { await w.regImport(path.join(dir, r.file)); results.push({ path: r.path, ok: true }); } catch (err) { results.push({ path: r.path, ok: false, error: err.message }); }
  }
  m.restored = Date.now();
  writeManifest(dir, m);
  return { ok: results.every((r) => r.ok), results, files: m.files };
}

function remove(id) {
  const dir = path.join(root(), path.basename(String(id)));
  if (!readManifest(dir)) return { ok: false, error: 'Backup not found' };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

module.exports = { configure, begin, list, restore, remove, root };
