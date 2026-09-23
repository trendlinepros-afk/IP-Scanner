'use strict';

/**
 * App Uninstaller + Registry / leftover cleaner (Windows).
 *
 * Modeled on Revo Uninstaller's core workflow:
 *   1. Enumerate installed programs (registry Uninstall keys, all three roots)
 *      plus Store / UWP apps.
 *   2. Uninstall one or many (bulk) — silently where the program supports it.
 *   3. Optionally scan for *leftover* registry entries and files/folders the
 *      program's own uninstaller left behind, and let the user delete them.
 *
 * Everything is pure Node + spawned Windows tools (powershell / msiexec / reg);
 * no native modules. On non-Windows platforms every entry point degrades to a
 * clear "Windows only" response.
 *
 * SAFETY: leftover detection is deliberately conservative, and deletion is
 * re-validated in the main process (never trusts the renderer): protected
 * system paths and shallow/critical registry keys are refused even if the UI
 * asks for them. Deletion is always explicit and user-selected.
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const IS_WIN = process.platform === 'win32';

// --------------------------------------------------------------------------
// PowerShell / process helpers
// --------------------------------------------------------------------------

// Escape a value for a PowerShell single-quoted string literal.
function psEsc(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').replace(/'/g, "''");
}

// Encode a script as UTF-16LE base64 for powershell -EncodedCommand. This
// sidesteps all shell-quoting problems for multi-line scripts.
function psEncode(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShell(script, { timeout = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', psEncode(script)],
      { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && !stdout) { reject(new Error((stderr || err.message || 'PowerShell failed').toString().trim())); return; }
        resolve((stdout || '').toString());
      },
    );
  });
}

// Run an executable and resolve with its exit code (best effort). Uninstallers
// that relaunch themselves from a temp copy may return before finishing; that
// is an inherent limitation of Windows uninstallers.
function runExe(exe, args, { hide = false, timeout = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(exe, args, { windowsHide: hide }); } catch (_) { resolve(-1); return; }
    let done = false;
    const finish = (c) => { if (!done) { done = true; resolve(c); } };
    child.on('exit', (code) => finish(code == null ? 0 : code));
    child.on('error', () => finish(-1));
    const t = setTimeout(() => finish(0), timeout);
    if (t.unref) t.unref();
  });
}

function runViaCmd(command, { hide = false, timeout = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('cmd.exe', ['/d', '/s', '/c', command], { windowsHide: hide, windowsVerbatimArguments: true });
    } catch (_) { resolve(-1); return; }
    let done = false;
    const finish = (c) => { if (!done) { done = true; resolve(c); } };
    child.on('exit', (code) => finish(code == null ? 0 : code));
    child.on('error', () => finish(-1));
    const t = setTimeout(() => finish(0), timeout);
    if (t.unref) t.unref();
  });
}

function regDelete(psPath) {
  return new Promise((resolve, reject) => {
    const regExe = psToRegExe(psPath);
    execFile('reg.exe', ['delete', regExe, '/f'], { windowsHide: true, timeout: 30000 }, (err, _so, se) => {
      if (err) { reject(new Error(((se || err.message || '').toString().trim()) || 'reg delete failed')); return; }
      resolve(true);
    });
  });
}

// --------------------------------------------------------------------------
// Pure helpers (unit-tested) — normalization, matching, safety
// --------------------------------------------------------------------------

function normName(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function uniq(arr) { return [...new Set(arr)]; }
function sanitizeSeg(s) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, '').trim(); }

function cleanPublisher(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, '').trim();
}

// "Microsoft.WindowsCalculator_8wekyb..." → "Windows Calculator"
function friendlyStoreName(identityName) {
  let n = String(identityName == null ? '' : identityName);
  const dot = n.lastIndexOf('.');
  if (dot >= 0) n = n.slice(dot + 1);
  n = n.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_]+/g, ' ').trim();
  return n || String(identityName || '');
}

function looksLikeUpdate(app) {
  const n = String(app.name || '');
  if (/^KB\d{5,}/i.test(n)) return true;
  if (/\bhotfix\b/i.test(n)) return true;
  if (/\bupdate for\b/i.test(n)) return true;
  if (/security update/i.test(n)) return true;
  if (app.releaseType && /update|hotfix|securityupdate/i.test(String(app.releaseType))) return true;
  if (app.parentKeyName) return true; // a component/patch of a parent product
  return false;
}

const GUID_RE = /\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}/;
function extractMsiGuid(app) {
  const wi = app.windowsInstaller;
  if ((wi === 1 || wi === '1') && app.key && GUID_RE.test(app.key)) return app.key.match(GUID_RE)[0];
  const us = String(app.uninstallString || '');
  if (/msiexec/i.test(us)) { const m = us.match(GUID_RE); if (m) return m[0]; }
  const qs = String(app.quietUninstallString || '');
  if (/msiexec/i.test(qs)) { const m = qs.match(GUID_RE); if (m) return m[0]; }
  return null;
}

// --- filesystem safety ----------------------------------------------------
function winNorm(p) { return String(p == null ? '' : p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase(); }

function protectedPaths(env) {
  const e = env || process.env;
  const s = new Set();
  const add = (p) => { if (p) s.add(winNorm(p)); };
  const win = e.windir || e.SystemRoot || 'C:\\Windows';
  add(win);
  add(`${win}\\System32`);
  add(e.ProgramFiles || 'C:\\Program Files');
  add(e['ProgramFiles(x86)'] || 'C:\\Program Files (x86)');
  add(e.CommonProgramFiles || 'C:\\Program Files\\Common Files');
  add(e['CommonProgramFiles(x86)'] || 'C:\\Program Files (x86)\\Common Files');
  add(e.ProgramData || 'C:\\ProgramData');
  add(e.APPDATA);
  add(e.LOCALAPPDATA);
  add(`${e.LOCALAPPDATA || 'C:\\Users\\x\\AppData\\Local'}\\Programs`);
  add(e.USERPROFILE);
  add('C:\\Users');
  return s;
}

function isProtectedPath(p, env) {
  const n = winNorm(p);
  if (!n) return true;
  if (/^[a-z]:$/.test(n)) return true; // bare drive root, e.g. "c:"
  if (!n.includes('\\')) return true; // no separator → refuse
  const e = env || process.env;
  const win = winNorm(e.windir || e.SystemRoot || 'C:\\Windows');
  if (n === win || n.startsWith(`${win}\\`)) return true; // anything inside Windows
  for (const cf of [winNorm((e.ProgramFiles || 'C:\\Program Files') + '\\Common Files'),
    winNorm((e['ProgramFiles(x86)'] || 'C:\\Program Files (x86)') + '\\Common Files')]) {
    if (n === cf || n.startsWith(`${cf}\\`)) return true; // shared Common Files
  }
  if (protectedPaths(e).has(n)) return true; // an exact base dir
  return false;
}

// --- registry safety ------------------------------------------------------
const PROTECTED_REG_LEAVES = new Set([
  'microsoft', 'windows', 'windowsnt', 'classes', 'policies', 'clients',
  'wow6432node', 'currentversion', 'run', 'runonce', 'explorer', 'shell',
  'installer', 'uninstall', 'google', 'intel', 'nvidia', 'realtek', 'amd',
  'apple', 'adobe', 'oracle', 'python', 'nodejs', 'khronos', 'odbc',
]);

function isProtectedRegPath(p) {
  const n = String(p == null ? '' : p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const parts = n.split('\\').filter(Boolean);
  // parts[0] = "hkcu:" | "hklm:" | "hklm" ... ; require at least hive\software\<x>
  if (parts.length < 3) return true;
  const idx = parts.indexOf('software');
  if (idx === -1) return true; // only ever touch ...\SOFTWARE\...
  const after = parts.slice(idx + 1);
  if (after.length < 1) return true; // Software root itself
  // A single key directly under Software must not be a well-known system key.
  if (after.length === 1 && PROTECTED_REG_LEAVES.has(after[0])) return true;
  if (after[0] === 'wow6432node' && after.length < 2) return true;
  return false;
}

function hiveShort(p) {
  return String(p == null ? '' : p)
    .replace(/^HKEY_LOCAL_MACHINE/i, 'HKLM')
    .replace(/^HKEY_CURRENT_USER/i, 'HKCU')
    .replace(/^HKEY_CLASSES_ROOT/i, 'HKCR')
    .replace(/^HKEY_USERS/i, 'HKU')
    .replace(/^HKEY_CURRENT_CONFIG/i, 'HKCC');
}
function regToPs(regExePath) { return hiveShort(regExePath).replace(/^(HKLM|HKCU|HKCR|HKU|HKCC)\\/i, '$1:\\'); }
function psToRegExe(psPath) { return String(psPath || '').replace(/^(HKLM|HKCU|HKCR|HKU|HKCC):\\/i, '$1\\'); }

// --- leftover candidate generation ---------------------------------------
function candidateFolders(app, env) {
  const e = env || process.env;
  const out = new Set();
  if (app.installLocation) out.add(String(app.installLocation).replace(/[\\/]+$/, ''));
  const bases = [
    e.ProgramFiles, e['ProgramFiles(x86)'], e.LOCALAPPDATA, e.APPDATA, e.ProgramData,
    e.LOCALAPPDATA ? path.win32.join(e.LOCALAPPDATA, 'Programs') : null,
  ].filter(Boolean);
  const names = uniq([app.name, app.rawName].filter(Boolean).map(sanitizeSeg).filter((n) => normName(n).length >= 4));
  for (const base of bases) {
    for (const n of names) {
      if (n.includes('\\') || n.includes('/')) continue;
      out.add(path.win32.join(base, n));
    }
  }
  return [...out].filter((f) => f && !isProtectedPath(f, e) && folderLeafMatches(f, app));
}

function folderLeafMatches(folder, app) {
  // installLocation is authoritative (came from the app's own registry entry).
  if (app.installLocation && winNorm(folder) === winNorm(app.installLocation)) return true;
  const leaf = normName(path.win32.basename(String(folder)));
  if (leaf.length < 4) return false;
  const cands = uniq([app.name, app.rawName].filter(Boolean).map(normName)).filter((c) => c.length >= 4);
  return cands.some((c) => leaf === c || leaf.startsWith(c) || c.startsWith(leaf));
}

function candidateRegistryKeys(app) {
  const keys = [];
  if (app.regPath) keys.push(regToPs(hiveShort(app.regPath))); // the app's own Uninstall key
  const roots = ['HKCU:\\SOFTWARE', 'HKLM:\\SOFTWARE', 'HKLM:\\SOFTWARE\\WOW6432Node', 'HKCU:\\SOFTWARE\\WOW6432Node'];
  const names = uniq([app.name, app.rawName].filter(Boolean).map(sanitizeSeg)
    .filter((n) => n && !n.includes('\\') && normName(n).length >= 4 && !PROTECTED_REG_LEAVES.has(normName(n))));
  for (const n of names) for (const r of roots) keys.push(`${r}\\${n}`);
  const pub = sanitizeSeg(app.publisher);
  if (pub && !pub.includes('\\') && normName(pub).length >= 3) {
    for (const n of names) for (const r of roots) keys.push(`${r}\\${pub}\\${n}`);
  }
  return uniq(keys).filter((k) => !isProtectedRegPath(k));
}

// Bounded directory size (informational only).
function dirSizeSafe(dir, cap = 4000) {
  let total = 0; let count = 0; let stop = false;
  const walk = (d) => {
    if (stop) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      count += 1;
      if (count > cap) { stop = true; return; }
      const fp = path.join(d, ent.name);
      try {
        if (ent.isDirectory()) walk(fp);
        else if (ent.isFile()) total += fs.statSync(fp).size;
      } catch (_) { /* ignore */ }
    }
  };
  walk(dir);
  return total;
}

// --------------------------------------------------------------------------
// Enumerate installed apps
// --------------------------------------------------------------------------
const LIST_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$roots = @(
  @{ Path = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; Scope = 'machine' },
  @{ Path = 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; Scope = 'machine32' },
  @{ Path = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; Scope = 'user' }
)
$apps = New-Object System.Collections.ArrayList
foreach ($r in $roots) {
  Get-ChildItem -Path $r.Path -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
    if ($p -and $p.DisplayName) {
      [void]$apps.Add([PSCustomObject]@{
        key = $_.PSChildName
        regPath = $_.Name
        name = $p.DisplayName
        version = $p.DisplayVersion
        publisher = $p.Publisher
        installDate = $p.InstallDate
        installLocation = $p.InstallLocation
        uninstallString = $p.UninstallString
        quietUninstallString = $p.QuietUninstallString
        estimatedSize = $p.EstimatedSize
        systemComponent = $p.SystemComponent
        releaseType = $p.ReleaseType
        parentKeyName = $p.ParentKeyName
        windowsInstaller = $p.WindowsInstaller
        scope = $r.Scope
        type = 'program'
      })
    }
  }
}
try {
  Get-AppxPackage -ErrorAction SilentlyContinue | ForEach-Object {
    [void]$apps.Add([PSCustomObject]@{
      key = $_.PackageFullName
      name = $_.Name
      version = $_.Version
      publisher = $_.Publisher
      installLocation = $_.InstallLocation
      packageFullName = $_.PackageFullName
      packageFamilyName = $_.PackageFamilyName
      isFramework = $_.IsFramework
      nonRemovable = $_.NonRemovable
      resourceId = $_.ResourceId
      signatureKind = $_.SignatureKind
      scope = 'store'
      type = 'store'
    })
  }
} catch {}
$apps | ConvertTo-Json -Depth 3 -Compress
`;

function normalizeProgramFields(e) {
  const est = Number(e.estimatedSize);
  return {
    key: e.key || '',
    regPath: e.regPath || '',
    name: String(e.name).trim(),
    rawName: String(e.name).trim(),
    version: e.version ? String(e.version) : '',
    publisher: cleanPublisher(e.publisher),
    installDate: e.installDate ? String(e.installDate) : '',
    installLocation: e.installLocation ? String(e.installLocation).trim() : '',
    uninstallString: e.uninstallString ? String(e.uninstallString) : '',
    quietUninstallString: e.quietUninstallString ? String(e.quietUninstallString) : '',
    sizeKB: Number.isFinite(est) && est > 0 ? est : null,
    scope: e.scope || '',
    windowsInstaller: e.windowsInstaller,
    releaseType: e.releaseType,
    parentKeyName: e.parentKeyName,
  };
}

/**
 * Normalize the raw JSON from LIST_SCRIPT into a clean, de-duplicated,
 * filtered, sorted app list. Exported for unit testing.
 */
function parseAppsJson(raw) {
  let data;
  try { data = JSON.parse(raw); } catch (_) { return []; }
  if (!data) return [];
  if (!Array.isArray(data)) data = [data];
  const out = [];
  const seen = new Set();
  for (const e of data) {
    if (!e || !e.name) continue;
    if (e.type === 'store') {
      if (e.isFramework === true || e.nonRemovable === true) continue;
      if (e.resourceId) continue; // language/resource sub-packages
      const id = `store:${e.packageFullName || e.key || e.name}`;
      if (seen.has(id)) continue; seen.add(id);
      out.push({
        id,
        type: 'store',
        name: friendlyStoreName(e.name),
        rawName: String(e.name),
        version: e.version ? String(e.version) : '',
        publisher: cleanPublisher(e.publisher),
        installDate: '',
        installLocation: e.installLocation ? String(e.installLocation) : '',
        packageFullName: e.packageFullName || '',
        packageFamilyName: e.packageFamilyName || '',
        sizeKB: null,
        msiGuid: null,
        scope: 'store',
      });
    } else {
      if (e.systemComponent === 1 || e.systemComponent === '1') continue;
      const app = normalizeProgramFields(e);
      if (looksLikeUpdate(app)) continue;
      const msiGuid = extractMsiGuid(app);
      if (!app.uninstallString && !app.quietUninstallString && !msiGuid) continue;
      const id = `prog:${app.scope}:${e.key || app.name}`;
      if (seen.has(id)) continue; seen.add(id);
      app.id = id;
      app.type = 'program';
      app.msiGuid = msiGuid;
      out.push(app);
    }
  }
  out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return out;
}

async function listApps() {
  if (!IS_WIN) return { supported: false, platform: process.platform, apps: [] };
  const raw = await runPowerShell(LIST_SCRIPT);
  return { supported: true, apps: parseAppsJson(raw) };
}

// --------------------------------------------------------------------------
// Uninstall
// --------------------------------------------------------------------------
async function uninstallApp(app, opts = {}) {
  if (!IS_WIN) return { ok: false, error: 'Uninstalling is only available on Windows.' };
  if (!app) return { ok: false, error: 'No application specified.' };
  const silent = !!opts.silent;
  try {
    if (app.type === 'store') {
      const pkg = app.packageFullName || app.rawName || app.name;
      const out = await runPowerShell(`try { Remove-AppxPackage -Package '${psEsc(pkg)}' -ErrorAction Stop; 'OK' } catch { 'ERR:' + $_.Exception.Message }`);
      if (/(^|\n)\s*ERR:/.test(out)) return { ok: false, error: (out.split(/ERR:/)[1] || '').trim() || 'Removal failed' };
      return { ok: true };
    }
    if (app.msiGuid) {
      const args = ['/x', app.msiGuid];
      if (silent) args.push('/qn', '/norestart'); else args.push('/qb');
      const code = await runExe('msiexec.exe', args, { hide: silent });
      return { ok: code === 0 || code === 3010, code, reboot: code === 3010 };
    }
    const cmd = (silent && app.quietUninstallString) ? app.quietUninstallString : app.uninstallString;
    if (!cmd) return { ok: false, error: 'No uninstall command is registered for this program.' };
    const code = await runViaCmd(cmd, { hide: silent });
    return { ok: code === 0 || code === 3010, code };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// --------------------------------------------------------------------------
// Leftover scan + removal
// --------------------------------------------------------------------------
async function checkRegistryKeys(psPaths) {
  if (!IS_WIN || !psPaths.length) return [];
  const arr = psPaths.map((p) => `'${psEsc(p)}'`).join(',');
  const script = `$paths=@(${arr}); $o=New-Object System.Collections.ArrayList; foreach($p in $paths){ if(Test-Path -LiteralPath $p){ $v=0; try{ $v=((Get-Item -LiteralPath $p).GetValueNames()).Count }catch{}; [void]$o.Add([PSCustomObject]@{path=$p; values=$v}) } } $o | ConvertTo-Json -Compress`;
  const out = await runPowerShell(script, { timeout: 30000 });
  let data; try { data = JSON.parse(out); } catch (_) { return []; }
  if (!data) return [];
  if (!Array.isArray(data)) data = [data];
  return data.filter(Boolean);
}

async function scanLeftovers(app) {
  if (!IS_WIN) return { supported: false, items: [] };
  if (!app) return { supported: true, items: [] };
  const items = [];
  // Files / folders (via Node fs)
  for (const f of candidateFolders(app)) {
    try {
      const st = fs.statSync(f);
      if (st.isDirectory()) {
        if (isProtectedPath(f)) continue;
        items.push({ kind: 'folder', path: f, display: f, sizeBytes: dirSizeSafe(f) });
      } else if (st.isFile()) {
        items.push({ kind: 'file', path: f, display: f, sizeBytes: st.size });
      }
    } catch (_) { /* not present — nothing to clean */ }
  }
  // Registry keys (existence confirmed via PowerShell)
  const keys = candidateRegistryKeys(app);
  if (keys.length) {
    const existing = await checkRegistryKeys(keys).catch(() => []);
    for (const k of existing) {
      if (isProtectedRegPath(k.path)) continue;
      items.push({ kind: 'registry', path: k.path, display: k.path, values: k.values || 0 });
    }
  }
  return { supported: true, items };
}

/**
 * Delete user-selected leftover items. Re-validates safety here (defense in
 * depth) — never trusts the renderer's list blindly.
 */
async function removeLeftovers(items) {
  if (!IS_WIN) return { supported: false, results: [] };
  const results = [];
  for (const it of (items || [])) {
    const p = it && it.path;
    try {
      if (!p || typeof p !== 'string') throw new Error('invalid item');
      if (it.kind === 'registry') {
        if (isProtectedRegPath(p)) throw new Error('protected registry key — refused');
        await regDelete(p);
        results.push({ path: p, kind: it.kind, ok: true });
      } else {
        if (!path.win32.isAbsolute(p) && !path.isAbsolute(p)) throw new Error('path is not absolute');
        if (isProtectedPath(p)) throw new Error('protected system path — refused');
        fs.rmSync(p, { recursive: true, force: true });
        results.push({ path: p, kind: it.kind, ok: true });
      }
    } catch (err) {
      results.push({ path: p, kind: it && it.kind, ok: false, error: err.message });
    }
  }
  return { supported: true, results };
}

// --------------------------------------------------------------------------
// Bulk orchestrator (streams progress)
// --------------------------------------------------------------------------
class Uninstaller extends EventEmitter {
  constructor() { super(); this.running = false; this._cancel = false; }

  cancel() { this._cancel = true; }

  async run(apps, opts = {}) {
    this.running = true; this._cancel = false;
    const list = Array.isArray(apps) ? apps : [];
    const silent = !!opts.silent;
    const scanAfter = !!opts.scanAfter;
    const total = list.length;
    const results = [];
    const leftovers = [];
    try {
      for (let i = 0; i < list.length; i += 1) {
        if (this._cancel) break;
        const app = list[i];
        this.emit('progress', { index: i, total, app: app.name, phase: 'uninstalling' });
        // eslint-disable-next-line no-await-in-loop
        const r = await uninstallApp(app, { silent });
        results.push({ id: app.id, app: app.name, ...r });
        if (r.ok && scanAfter && !this._cancel) {
          this.emit('progress', { index: i, total, app: app.name, phase: 'scanning' });
          // eslint-disable-next-line no-await-in-loop
          const scan = await scanLeftovers(app).catch(() => ({ items: [] }));
          if (scan.items && scan.items.length) leftovers.push({ id: app.id, app: app.name, items: scan.items });
        }
        this.emit('progress', {
          index: i, total, app: app.name, phase: r.ok ? 'done' : 'error', error: r.error, reboot: r.reboot,
        });
      }
    } finally {
      this.running = false;
    }
    const done = { results, leftovers, cancelled: this._cancel };
    this.emit('done', done);
    return done;
  }
}

module.exports = {
  IS_WIN,
  listApps,
  parseAppsJson,
  uninstallApp,
  scanLeftovers,
  removeLeftovers,
  Uninstaller,
  // exported for tests
  _internals: {
    normName,
    friendlyStoreName,
    looksLikeUpdate,
    extractMsiGuid,
    isProtectedPath,
    isProtectedRegPath,
    candidateFolders,
    candidateRegistryKeys,
    folderLeafMatches,
    hiveShort,
    regToPs,
    psToRegExe,
    dirSizeSafe,
  },
};
