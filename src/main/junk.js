'use strict';

/**
 * Junk Files Cleaner (Windows): temp folders, crash dumps, error reports,
 * thumbnail / browser caches, the Windows Update download cache and the
 * Recycle Bin. Only the *contents* of a fixed set of known junk locations are
 * ever deleted; recently modified files are skipped (they may be in use).
 * The renderer can only pass category ids — never paths.
 */

const fs = require('fs');
const path = require('path');
const w = require('./winutil');

const { IS_WIN } = w;
const HOUR = 3600e3;

function profiles(dir, sub) {
  // Chromium profiles: Default, Profile 1, Profile 2, …
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  return ents.filter((e) => e.isDirectory() && (e.name === 'Default' || /^Profile \d+$/.test(e.name)))
    .flatMap((e) => sub.map((s) => path.join(dir, e.name, s)));
}
function firefoxCaches(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  return ents.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name, 'cache2'));
}

/** Category definitions (resolved against the environment at call time). */
function categories(env = process.env) {
  const L = env.LOCALAPPDATA; const P = env.ProgramData || 'C:\\ProgramData'; const W = env.windir || 'C:\\Windows';
  const chromiumSub = ['Cache', 'Code Cache', 'GPUCache', 'Service Worker\\CacheStorage'];
  return [
    { id: 'usertemp', name: 'User temporary files', desc: 'Your %TEMP% folder', roots: [env.TEMP].filter(Boolean), minAgeH: 24 },
    { id: 'wintemp', name: 'Windows temporary files', desc: 'C:\\Windows\\Temp (administrator)', roots: [path.join(W, 'Temp')], minAgeH: 24, admin: true },
    { id: 'dumps', name: 'Crash dumps', desc: 'Application crash dump files', roots: [L && path.join(L, 'CrashDumps'), path.join(W, 'Minidump')].filter(Boolean), minAgeH: 1 },
    { id: 'wer', name: 'Windows Error Reporting', desc: 'Queued and archived error reports', roots: [path.join(P, 'Microsoft\\Windows\\WER\\ReportArchive'), path.join(P, 'Microsoft\\Windows\\WER\\ReportQueue'), L && path.join(L, 'Microsoft\\Windows\\WER\\ReportArchive'), L && path.join(L, 'Microsoft\\Windows\\WER\\ReportQueue')].filter(Boolean), minAgeH: 1 },
    { id: 'thumbs', name: 'Thumbnail cache', desc: 'Explorer thumbnail databases (rebuilt automatically)', roots: [L && path.join(L, 'Microsoft\\Windows\\Explorer')].filter(Boolean), match: /^(thumbcache|iconcache)_.*\.db$/i, flat: true, minAgeH: 0 },
    { id: 'inetcache', name: 'Internet cache', desc: 'Windows / legacy Edge web cache', roots: [L && path.join(L, 'Microsoft\\Windows\\INetCache')].filter(Boolean), minAgeH: 0 },
    { id: 'chrome', name: 'Google Chrome cache', desc: 'Cached web content (close Chrome first for best results)', roots: L ? profiles(path.join(L, 'Google\\Chrome\\User Data'), chromiumSub) : [], minAgeH: 0 },
    { id: 'edge', name: 'Microsoft Edge cache', desc: 'Cached web content (close Edge first for best results)', roots: L ? profiles(path.join(L, 'Microsoft\\Edge\\User Data'), chromiumSub) : [], minAgeH: 0 },
    { id: 'brave', name: 'Brave cache', desc: 'Cached web content', roots: L ? profiles(path.join(L, 'BraveSoftware\\Brave-Browser\\User Data'), chromiumSub) : [], minAgeH: 0 },
    { id: 'firefox', name: 'Firefox cache', desc: 'Cached web content', roots: L ? firefoxCaches(path.join(L, 'Mozilla\\Firefox\\Profiles')) : [], minAgeH: 0 },
    { id: 'wu', name: 'Windows Update downloads', desc: 'Already-installed update packages (administrator)', roots: [path.join(W, 'SoftwareDistribution\\Download')], minAgeH: 24, admin: true },
    { id: 'recycle', name: 'Recycle Bin', desc: 'Empty the Recycle Bin on all drives (also removes uninstaller file backups)', special: 'recycle' },
  ];
}

// Never operate on a drive root or a too-shallow path.
function safeRoot(r) {
  const n = String(r || '').replace(/\//g, '\\').replace(/\\+$/, '');
  return path.win32.isAbsolute(n) && n.split('\\').filter(Boolean).length >= 3;
}

/** Walk files under root; cb(fullPath, stat) for files matching the filter. */
function walk(root, cat, cb, budget) {
  const cutoff = Date.now() - (cat.minAgeH || 0) * HOUR;
  const visit = (dir, depth) => {
    if (budget.n <= 0) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      budget.n -= 1;
      if (budget.n <= 0) return;
      const fp = path.join(dir, e.name);
      try {
        if (e.isSymbolicLink()) continue; // never follow links out of the junk root
        if (e.isDirectory()) { if (!cat.flat) visit(fp, depth + 1); continue; }
        if (!e.isFile()) continue;
        if (cat.match && !cat.match.test(e.name)) continue;
        const st = fs.statSync(fp);
        if (st.mtimeMs > cutoff) continue;
        cb(fp, st, dir);
      } catch (_) { /* ignore */ }
    }
  };
  visit(root, 0);
}

async function recycleInfo() {
  const out = await w.runPowerShell("$s=0;$n=0; try { (New-Object -ComObject Shell.Application).NameSpace(10).Items() | ForEach-Object { $n++; try { $s += [int64]$_.ExtendedProperty('Size') } catch {} } } catch {}; \"$n|$s\"", { timeout: 60000 }).catch(() => '0|0');
  const [n, s] = String(out).trim().split('|').map((x) => Number(x) || 0);
  return { files: n, bytes: s };
}

async function scan() {
  if (!IS_WIN) return { supported: false, categories: [] };
  const admin = await w.isAdmin();
  const result = [];
  for (const cat of categories()) {
    if (cat.special === 'recycle') {
      // eslint-disable-next-line no-await-in-loop
      const r = await recycleInfo();
      result.push({ id: cat.id, name: cat.name, desc: cat.desc, files: r.files, bytes: r.bytes, available: true });
      continue;
    }
    const roots = cat.roots.filter((r) => safeRoot(r) && fs.existsSync(r));
    let files = 0; let bytes = 0;
    const budget = { n: 250000 };
    for (const r of roots) walk(r, cat, (_p, st) => { files += 1; bytes += st.size; }, budget);
    result.push({ id: cat.id, name: cat.name, desc: cat.desc, files, bytes, available: roots.length > 0, needsAdmin: !!cat.admin && !admin });
  }
  return { supported: true, admin, categories: result };
}

async function clean(ids) {
  if (!IS_WIN) return { supported: false, results: [] };
  const wanted = new Set((ids || []).map(String));
  const results = [];
  for (const cat of categories()) {
    if (!wanted.has(cat.id)) continue;
    if (cat.special === 'recycle') {
      // eslint-disable-next-line no-await-in-loop
      const before = await recycleInfo();
      // eslint-disable-next-line no-await-in-loop
      await w.runPowerShell('Clear-RecycleBin -Force -ErrorAction SilentlyContinue', { timeout: 120000 }).catch(() => {});
      results.push({ id: cat.id, name: cat.name, freed: before.bytes, deleted: before.files, failed: 0 });
      continue;
    }
    let freed = 0; let deleted = 0; let failed = 0;
    const dirs = new Set();
    const budget = { n: 250000 };
    for (const root of cat.roots.filter((r) => safeRoot(r) && fs.existsSync(r))) {
      walk(root, cat, (fp, st, dir) => {
        try { fs.unlinkSync(fp); freed += st.size; deleted += 1; if (dir !== root) dirs.add(dir); } catch (_) { failed += 1; }
      }, budget);
      // Remove now-empty sub-folders (deepest first); keep the junk root itself.
      [...dirs].filter((d) => d.startsWith(root + path.sep)).sort((a, b) => b.length - a.length)
        .forEach((d) => { try { fs.rmdirSync(d); } catch (_) { /* not empty / in use */ } });
    }
    results.push({ id: cat.id, name: cat.name, freed, deleted, failed });
  }
  return { supported: true, results };
}

module.exports = { scan, clean, _internals: { categories, safeRoot, walk } };
