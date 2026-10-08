'use strict';

/**
 * Startup Manager (Windows): programs that launch at sign-in from the Run /
 * RunOnce registry keys and the Startup folders. Entries can be enabled or
 * disabled the same way Task Manager does it (the StartupApproved keys — the
 * original entry is left untouched), or deleted (backed up first).
 */

const w = require('./winutil');
const backups = require('./backups');

const { IS_WIN, runPowerShell, parseJsonList } = w;

const SA = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved';
const RUN_KEYS = [
  { key: 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run', approved: `HKCU:\\${SA}\\Run`, scope: 'user' },
  { key: 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run', approved: `HKLM:\\${SA}\\Run`, scope: 'machine' },
  { key: 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run', approved: `HKLM:\\${SA}\\Run32`, scope: 'machine32' },
  { key: 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce', approved: '', scope: 'user-once' },
  { key: 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce', approved: '', scope: 'machine-once' },
];

const psArr = (rows) => rows.map((r) => `@{k='${w.psEsc(r.key)}';a='${w.psEsc(r.approved)}';s='${r.scope}'}`).join(',');

/** Raw Run / RunOnce values (also used by the uninstaller's Advanced scan). */
async function readRunValues() {
  if (!IS_WIN) return [];
  const script = `$o=New-Object System.Collections.ArrayList; foreach($r in @(${psArr(RUN_KEYS)})){ $i=Get-Item -LiteralPath $r.k -ErrorAction SilentlyContinue; if($i){ foreach($n in $i.GetValueNames()){ if($n){ [void]$o.Add([PSCustomObject]@{key=$r.k;name=$n;data=[string]$i.GetValue($n)}) } } } }; $o | ConvertTo-Json -Compress`;
  return parseJsonList(await runPowerShell(script, { timeout: 30000 }));
}

const LIST_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$o = New-Object System.Collections.ArrayList
function Approved($k, $n) { if (-not $k) { return -1 }; try { $i = Get-Item -LiteralPath $k -ErrorAction Stop; $b = $i.GetValue($n); if ($b -is [byte[]] -and $b.Length -gt 0) { return [int]$b[0] } } catch {}; return -1 }
foreach ($r in @(__RUNS__)) {
  $i = Get-Item -LiteralPath $r.k -ErrorAction SilentlyContinue
  if ($i) { foreach ($n in $i.GetValueNames()) { if ($n) {
    [void]$o.Add([PSCustomObject]@{ source='registry'; key=$r.k; approvedKey=$r.a; name=$n; data=[string]$i.GetValue($n); scope=$r.s; state=(Approved $r.a $n) })
  } } }
}
$sh = $null; try { $sh = New-Object -ComObject WScript.Shell } catch {}
foreach ($f in @(
  @{ d=[Environment]::GetFolderPath('Startup'); a='HKCU:\\${SA}\\StartupFolder'; s='user' },
  @{ d=[Environment]::GetFolderPath('CommonStartup'); a='HKLM:\\${SA}\\StartupFolder'; s='machine' }
)) {
  if ($f.d -and (Test-Path -LiteralPath $f.d)) {
    Get-ChildItem -LiteralPath $f.d -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'desktop.ini' } | ForEach-Object {
      $t = ''; if ($sh -and $_.Extension -eq '.lnk') { try { $t = $sh.CreateShortcut($_.FullName).TargetPath } catch {} }
      [void]$o.Add([PSCustomObject]@{ source='folder'; key=$_.FullName; approvedKey=$f.a; name=$_.Name; data=$t; scope=$f.s; state=(Approved $f.a $_.Name) })
    }
  }
}
$o | ConvertTo-Json -Compress
`;

/** StartupApproved first byte: even (02/06) = enabled, odd (03/07) = disabled, missing = enabled. */
function isEnabledState(state) { const s = Number(state); return !(Number.isFinite(s) && s >= 0 && s % 2 === 1); }

function normalize(rows) {
  return rows.map((r) => ({
    id: `${r.source}|${r.key}|${r.name}`,
    source: r.source,
    key: r.key,
    approvedKey: r.approvedKey || '',
    name: String(r.name || '').replace(/\.lnk$/i, ''),
    valueName: String(r.name || ''),
    command: String(r.data || (r.source === 'folder' ? r.key : '')),
    scope: r.scope,
    machine: /^machine/.test(r.scope),
    once: /once$/.test(r.scope),
    enabled: isEnabledState(r.state),
    canToggle: !!r.approvedKey,
  })).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

async function list() {
  if (!IS_WIN) return { supported: false, entries: [] };
  const raw = await runPowerShell(LIST_SCRIPT.replace('__RUNS__', psArr(RUN_KEYS)), { timeout: 45000 });
  return { supported: true, entries: normalize(parseJsonList(raw)), admin: await w.isAdmin() };
}

// Re-read and look the entry up server-side so the renderer can only act on
// entries that genuinely exist (never on arbitrary keys or paths).
async function find(id) {
  const { entries } = await list();
  const e = entries.find((x) => x.id === id);
  if (!e) throw new Error('Startup entry not found (it may have changed — refresh).');
  return e;
}

const needsAdminMsg = (e, err) => (e.machine ? `${err.message} — this entry is machine-wide; run IT Tools as administrator.` : err.message);

async function setEnabled(id, enabled) {
  if (!IS_WIN) return { ok: false, error: 'Windows only.' };
  try {
    const e = await find(id);
    if (!e.canToggle) return { ok: false, error: 'Run-once entries can only be deleted, not disabled.' };
    try {
      await w.regSetBinary(e.approvedKey, e.valueName, enabled ? '020000000000000000000000' : '030000000000000000000000');
    } catch (err) { return { ok: false, error: needsAdminMsg(e, err) }; }
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

async function remove(id) {
  if (!IS_WIN) return { ok: false, error: 'Windows only.' };
  let e;
  try { e = await find(id); } catch (err) { return { ok: false, error: err.message }; }
  const session = backups.begin(`Startup entry: ${e.name}`);
  try {
    if (e.source === 'registry') {
      await session.saveRegistry(e.key, e.valueName);
      await w.regDelete(e.key, e.valueName);
    } else {
      const how = await w.removePath(e.key, { recycle: true });
      session.recordFile(e.key, how);
    }
    if (e.approvedKey) await w.regDelete(e.approvedKey, e.valueName).catch(() => {});
    const m = session.finish();
    return { ok: true, backupId: m ? m.id : null };
  } catch (err) {
    session.finish();
    return { ok: false, error: needsAdminMsg(e, err) };
  }
}

module.exports = { list, setEnabled, remove, readRunValues, _internals: { isEnabledState, normalize } };
