'use strict';

/**
 * Install Monitor / Traced Programs (Windows).
 *
 * Take a snapshot of the system, run an installer, take a second snapshot and
 * the difference is a "trace": every folder, shortcut, registry key and
 * startup entry the install created. A traced program can later be removed
 * completely — optionally running its own uninstaller first — even if its
 * uninstaller is broken. Traces live under <userData>/system-tools/traces.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const w = require('./winutil');
const uninstaller = require('./uninstaller');

const { IS_WIN, runPowerShell } = w;
const { isProtectedPath, isProtectedRegPath, winNorm } = uninstaller._internals;

let DATA = null;
function configure({ dataDir }) { DATA = path.join(dataDir, 'system-tools'); }
function dataDir(sub) {
  const d = path.join(DATA || path.join(require('os').tmpdir(), 'it-tools'), sub || '');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const snapFile = () => path.join(dataDir(), 'monitor-snapshot.json');

// Second-level folders under these are skipped (huge, OS-managed).
const SKIP_L2 = new Set(['microsoft', 'packages', 'temp', 'windowsapps', 'common files', 'windows defender', 'windows nt',
  'internet explorer', 'windowspowershell', 'modifiablewindowsapps', 'reference assemblies', 'msbuild', 'dotnet']);

function fsRoots(env = process.env) {
  const L = env.LOCALAPPDATA; const A = env.APPDATA; const P = env.ProgramData || 'C:\\ProgramData';
  const deep = [env.ProgramFiles, env['ProgramFiles(x86)'], P, A, L, L && path.join(L, 'Programs')].filter(Boolean);
  const shallow = [
    A && path.join(A, 'Microsoft\\Windows\\Start Menu\\Programs'), path.join(P, 'Microsoft\\Windows\\Start Menu\\Programs'),
    env.USERPROFILE && path.join(env.USERPROFILE, 'Desktop'), path.join(env.PUBLIC || 'C:\\Users\\Public', 'Desktop'),
    A && path.join(A, 'Microsoft\\Windows\\Start Menu\\Programs\\Startup'), path.join(P, 'Microsoft\\Windows\\Start Menu\\Programs\\StartUp'),
  ].filter(Boolean);
  return { deep, shallow };
}

function ls(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; } }

function fsSnapshot() {
  const out = new Set();
  const { deep, shallow } = fsRoots();
  for (const root of deep) {
    for (const e of ls(root)) {
      if (!e.isDirectory()) continue;
      const p1 = path.join(root, e.name);
      out.add(p1);
      if (SKIP_L2.has(e.name.toLowerCase())) continue;
      for (const e2 of ls(p1)) if (e2.isDirectory()) out.add(path.join(p1, e2.name));
    }
  }
  for (const root of shallow) for (const e of ls(root)) if (e.name.toLowerCase() !== 'desktop.ini') out.add(path.join(root, e.name));
  return [...out];
}

const REG_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$keys = New-Object System.Collections.ArrayList
$skip = @('Microsoft','Classes','Policies','WOW6432Node','Clients','RegisteredApplications')
foreach ($root in @('HKCU:\\SOFTWARE','HKLM:\\SOFTWARE','HKLM:\\SOFTWARE\\WOW6432Node')) {
  Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
    $p1 = $root + '\\' + $_.PSChildName; [void]$keys.Add($p1)
    if ($skip -notcontains $_.PSChildName) { Get-ChildItem -LiteralPath $p1 -ErrorAction SilentlyContinue | ForEach-Object { [void]$keys.Add($p1 + '\\' + $_.PSChildName) } }
  }
}
foreach ($root in @('HKCU:\\SOFTWARE\\Classes','HKLM:\\SOFTWARE\\Classes','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths')) {
  Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object { [void]$keys.Add($root + '\\' + $_.PSChildName) }
}
$un = New-Object System.Collections.ArrayList
foreach ($root in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall')) {
  Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty -LiteralPath $_.PSPath
    [void]$un.Add([PSCustomObject]@{ path = ($root + '\\' + $_.PSChildName); name = [string]$p.DisplayName; uninstallString = [string]$p.UninstallString; quietUninstallString = [string]$p.QuietUninstallString; installLocation = [string]$p.InstallLocation; publisher = [string]$p.Publisher; windowsInstaller = $p.WindowsInstaller; key = $_.PSChildName })
  }
}
$run = New-Object System.Collections.ArrayList
foreach ($k in @('HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run')) {
  $i = Get-Item -LiteralPath $k -ErrorAction SilentlyContinue; if ($i) { foreach ($n in $i.GetValueNames()) { if ($n) { [void]$run.Add([PSCustomObject]@{ key = $k; name = $n; data = [string]$i.GetValue($n) }) } } }
}
[PSCustomObject]@{ keys = $keys; uninstall = $un; run = $run } | ConvertTo-Json -Depth 4 -Compress
`;

async function regSnapshot() {
  const raw = await runPowerShell(REG_SCRIPT, { timeout: 180000 });
  let d = {};
  try { d = JSON.parse(raw); } catch (_) { d = {}; }
  const arr = (x) => (Array.isArray(x) ? x : (x ? [x] : []));
  return { keys: arr(d.keys), uninstall: arr(d.uninstall), run: arr(d.run) };
}

async function takeSnapshot() {
  const reg = await regSnapshot();
  return { taken: Date.now(), fs: fsSnapshot(), ...reg };
}

/** Pure diff of two snapshots → trace items (unit-tested). */
function diffSnapshots(before, after) {
  const lc = (s) => String(s).toLowerCase();
  const had = (arr) => new Set(arr.map(lc));
  // Drop entries whose parent is itself new (report the top-most new item).
  const collapse = (paths) => {
    const sorted = [...paths].sort((a, b) => a.length - b.length);
    const kept = [];
    for (const p of sorted) if (!kept.some((k) => lc(p).startsWith(`${lc(k)}\\`))) kept.push(p);
    return kept;
  };
  const bFs = had(before.fs || []);
  const newFs = collapse((after.fs || []).filter((p) => !bFs.has(lc(p))));
  const bKeys = had(before.keys || []);
  const newKeys = collapse((after.keys || []).filter((k) => !bKeys.has(lc(k))));
  const bUn = had((before.uninstall || []).map((u) => u.path));
  const newUn = (after.uninstall || []).filter((u) => !bUn.has(lc(u.path)));
  const bRun = had((before.run || []).map((r) => `${r.key}|${r.name}`));
  const newRun = (after.run || []).filter((r) => !bRun.has(lc(`${r.key}|${r.name}`)));

  const items = [];
  for (const p of newFs) items.push({ kind: /\.(lnk|url)$/i.test(p) ? 'shortcut' : 'folder', path: p, display: p });
  for (const k of newKeys) items.push({ kind: 'registry', path: k, display: k });
  for (const u of newUn) items.push({ kind: 'registry', path: u.path, display: `${u.path}  (entry: ${u.name || 'unnamed'})` });
  for (const r of newRun) items.push({ kind: 'regvalue', path: r.key, value: r.name, display: `${r.key}  →  ${r.name}`, data: r.data });
  return { items, uninstall: newUn };
}

// --- monitor session ------------------------------------------------------
function status() {
  try {
    const s = JSON.parse(fs.readFileSync(snapFile(), 'utf8'));
    return { monitoring: true, since: s.taken };
  } catch (_) { return { monitoring: false }; }
}

async function start() {
  if (!IS_WIN) return { ok: false, error: 'Windows only.' };
  const snap = await takeSnapshot();
  fs.writeFileSync(snapFile(), JSON.stringify(snap));
  return { ok: true, since: snap.taken };
}

function cancel() { try { fs.unlinkSync(snapFile()); } catch (_) { /* */ } return { ok: true }; }

async function stop(name) {
  if (!IS_WIN) return { ok: false, error: 'Windows only.' };
  let before;
  try { before = JSON.parse(fs.readFileSync(snapFile(), 'utf8')); } catch (_) { return { ok: false, error: 'Monitoring is not running.' }; }
  const after = await takeSnapshot();
  const { items, uninstall } = diffSnapshots(before, after);
  const safe = items.filter((it) => (it.kind === 'registry' ? !isProtectedRegPath(it.path) : (it.kind === 'regvalue' ? true : !isProtectedPath(it.path))));
  const guess = (uninstall.find((u) => u.name) || {}).name
    || (safe.find((i) => i.kind === 'folder') ? path.win32.basename(safe.find((i) => i.kind === 'folder').path) : '');
  const trace = {
    id: `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    name: String(name || '').trim() || guess || `Traced program ${new Date().toLocaleString()}`,
    created: Date.now(),
    started: before.taken,
    items: safe,
    uninstall,
  };
  fs.writeFileSync(path.join(dataDir('traces'), `${trace.id}.json`), JSON.stringify(trace, null, 2));
  cancel();
  return { ok: true, trace: summarize(trace) };
}

// --- traces ---------------------------------------------------------------
function readTrace(id) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir('traces'), `${path.basename(String(id))}.json`), 'utf8')); } catch (_) { return null; }
}
function summarize(t) {
  const counts = t.items.reduce((a, i) => { a[i.kind] = (a[i.kind] || 0) + 1; return a; }, {});
  return { id: t.id, name: t.name, created: t.created, removed: t.removed || null, itemCount: t.items.length, counts, hasUninstaller: (t.uninstall || []).some((u) => u.uninstallString) };
}
function listTraces() {
  return ls(dataDir('traces')).filter((e) => e.name.endsWith('.json'))
    .map((e) => readTrace(e.name.replace(/\.json$/, ''))).filter(Boolean).map(summarize).sort((a, b) => b.created - a.created);
}
function getTrace(id) {
  const t = readTrace(id);
  if (!t) return null;
  // Mark which file-system items still exist (registry is re-checked on removal).
  t.items = t.items.map((i) => (i.kind === 'registry' || i.kind === 'regvalue' ? i : { ...i, exists: fs.existsSync(i.path) }));
  return t;
}
function deleteTrace(id) {
  try { fs.unlinkSync(path.join(dataDir('traces'), `${path.basename(String(id))}.json`)); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
}

/**
 * Remove a traced program. Only items that are part of the trace can be
 * deleted (the renderer's selection is intersected with the stored trace).
 */
async function uninstallTrace(id, { runUninstaller = true, paths = null } = {}) {
  const t = readTrace(id);
  if (!t) return { ok: false, error: 'Trace not found' };
  const out = { ok: true, uninstallers: [] };
  if (runUninstaller) {
    for (const u of (t.uninstall || []).filter((x) => x.uninstallString)) {
      const app = { name: u.name, uninstallString: u.uninstallString, quietUninstallString: u.quietUninstallString, windowsInstaller: u.windowsInstaller, key: u.key };
      app.msiGuid = uninstaller._internals.extractMsiGuid(app);
      // eslint-disable-next-line no-await-in-loop
      out.uninstallers.push({ name: u.name, ...(await uninstaller.uninstallApp(app, {})) });
    }
  }
  const wanted = paths ? new Set(paths.map((p) => winNorm(p))) : null;
  const items = t.items.filter((i) => !wanted || wanted.has(winNorm(i.kind === 'regvalue' ? `${i.path}|${i.value}` : i.path)));
  const rm = await uninstaller.removeLeftovers(items, { label: `Traced program: ${t.name}` });
  // Items that are simply gone already (removed by the program's uninstaller) are not failures.
  rm.results = rm.results.map((r) => (!r.ok && /unable to find|cannot find|was not found|not exist/i.test(r.error || '') ? { ...r, ok: true, how: 'already gone' } : r));
  t.removed = Date.now();
  fs.writeFileSync(path.join(dataDir('traces'), `${t.id}.json`), JSON.stringify(t, null, 2));
  return { ...out, ...rm };
}

module.exports = {
  configure, status, start, stop, cancel, listTraces, getTrace, deleteTrace, uninstallTrace,
  _internals: { diffSnapshots },
};
