'use strict';

/**
 * App Uninstaller + leftover / registry cleaner (Windows).
 *
 * Modeled on Revo Uninstaller Pro:
 *   - Enumerate installed programs (all Uninstall roots) and Store apps, with
 *     icons, sizes, dates and details. System components are flagged.
 *   - Uninstall one or many (bulk); silent where supported; optional System
 *     Restore point first.
 *   - Leftover scan in three modes — Safe, Moderate, Advanced — finding
 *     registry keys/values, folders, files and shortcuts left behind.
 *   - Forced Uninstall: hunt remnants of broken / already-removed programs.
 *   - Repair / Modify, Remove entry, open in Registry Editor, export the list.
 *   - Every deletion is backed up first (registry → .reg, files → Recycle Bin).
 *
 * SAFETY: leftover detection is conservative and every deletion is
 * re-validated here (never trusting the renderer): protected system paths,
 * shallow/critical registry keys and folders shared with other installed
 * programs are refused.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const w = require('./winutil');
const backups = require('./backups');

const { IS_WIN, psEsc, runPowerShell, parseJsonList, hiveShort, regToPs, psToRegExe } = w;

const MODES = ['safe', 'moderate', 'advanced'];
const modeRank = (m) => Math.max(0, MODES.indexOf(MODES.includes(m) ? m : 'moderate'));

// --------------------------------------------------------------------------
// Pure helpers (unit-tested)
// --------------------------------------------------------------------------
function normName(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function uniq(arr) { return [...new Set(arr)]; }
function sanitizeSeg(s) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, '').trim(); }

const GUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond…" → "Microsoft Corporation"
function cleanPublisher(s) {
  const v = String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, '').trim();
  if (!/^(CN|O|OU|L|S|C|E)=/i.test(v)) return v; // already a plain name
  const field = (k) => {
    const m = new RegExp(`(?:^|,\\s*)${k}=("([^"]*)"|[^,]*)`, 'i').exec(v);
    return m ? (m[2] != null ? m[2] : m[1]).trim() : '';
  };
  for (const name of [field('CN'), field('O')]) if (name && !GUIDISH.test(name)) return name;
  return '';
}

// "Microsoft.WindowsCalculator" → "Windows Calculator"
function friendlyStoreName(identityName) {
  let n = String(identityName == null ? '' : identityName);
  const dot = n.lastIndexOf('.');
  if (dot >= 0) n = n.slice(dot + 1);
  n = n.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_]+/g, ' ').trim();
  return n || String(identityName || '');
}

// DisplayIcon: "\"C:\\App\\app.exe\",0" → "C:\\App\\app.exe"
function parseIconPath(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (s.startsWith('"')) { const end = s.indexOf('"', 1); s = end > 0 ? s.slice(1, end) : s.slice(1); }
  s = s.replace(/,\s*-?\d+\s*$/, '').trim();
  return s.replace(/^"|"$/g, '');
}

// First executable path in a command line (quoted or not).
function exeFromCommand(cmd) {
  const s = String(cmd == null ? '' : cmd).trim();
  if (!s) return '';
  if (s.startsWith('"')) { const end = s.indexOf('"', 1); return end > 0 ? s.slice(1, end) : ''; }
  const m = /^(.+?\.(exe|com|bat|cmd))(\s|$)/i.exec(s);
  return m ? m[1] : s.split(/\s+/)[0];
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
  for (const s of [app.uninstallString, app.quietUninstallString, app.modifyPath]) {
    const v = String(s || '');
    if (/msiexec/i.test(v)) { const m = v.match(GUID_RE); if (m) return m[0]; }
  }
  return null;
}

// --- filesystem safety ----------------------------------------------------
function winNorm(p) { return String(p == null ? '' : p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase(); }

function startMenuDirs(e) {
  return [
    e.APPDATA ? `${e.APPDATA}\\Microsoft\\Windows\\Start Menu\\Programs` : null,
    `${e.ProgramData || 'C:\\ProgramData'}\\Microsoft\\Windows\\Start Menu\\Programs`,
  ].filter(Boolean);
}
function desktopDirs(e) {
  return [e.USERPROFILE ? `${e.USERPROFILE}\\Desktop` : null, `${e.PUBLIC || 'C:\\Users\\Public'}\\Desktop`].filter(Boolean);
}

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
  add(e.TEMP); add(e.TMP);
  add(e.USERPROFILE);
  add(e.PUBLIC);
  add('C:\\Users');
  startMenuDirs(e).forEach(add);
  startMenuDirs(e).forEach((d) => add(`${d}\\Startup`));
  desktopDirs(e).forEach(add);
  return s;
}

function isProtectedPath(p, env) {
  const n = winNorm(p);
  if (!n) return true;
  if (/^[a-z]:$/.test(n)) return true; // bare drive root
  if (!n.includes('\\')) return true; // no separator → refuse
  const e = env || process.env;
  const win = winNorm(e.windir || e.SystemRoot || 'C:\\Windows');
  if (n === win || n.startsWith(`${win}\\`)) return true; // anything inside Windows
  for (const cf of [winNorm(`${e.ProgramFiles || 'C:\\Program Files'}\\Common Files`),
    winNorm(`${e['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\Common Files`)]) {
    if (n === cf || n.startsWith(`${cf}\\`)) return true; // shared Common Files
  }
  if (protectedPaths(e).has(n)) return true; // an exact base dir
  return false;
}

// Folder is shared with (or contains) another still-installed program.
function sharedWithOthers(folder, otherLocations) {
  const f = winNorm(folder);
  return (otherLocations || []).some((loc) => {
    const l = winNorm(loc);
    return l && (l === f || l.startsWith(`${f}\\`));
  });
}

// --- registry safety ------------------------------------------------------
const PROTECTED_REG_LEAVES = new Set([
  'microsoft', 'windows', 'windowsnt', 'classes', 'policies', 'clients',
  'wow6432node', 'currentversion', 'run', 'runonce', 'explorer', 'shell',
  'installer', 'uninstall', 'google', 'intel', 'nvidia', 'realtek', 'amd',
  'apple', 'adobe', 'oracle', 'python', 'nodejs', 'khronos', 'odbc',
]);
// Container keys that must never be deleted wholesale (relative to SOFTWARE).
const PROTECTED_REG_CONTAINERS = new Set([
  'microsoft\\windows', 'microsoft\\windows\\currentversion',
  'microsoft\\windows\\currentversion\\run', 'microsoft\\windows\\currentversion\\runonce',
  'microsoft\\windows\\currentversion\\uninstall', 'microsoft\\windows\\currentversion\\app paths',
  'microsoft\\windows\\currentversion\\explorer', 'microsoft\\windows nt',
  'microsoft\\windows nt\\currentversion', 'classes', 'classes\\applications', 'policies',
]);

function isProtectedRegPath(p) {
  const n = String(p == null ? '' : p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const parts = n.split('\\').filter(Boolean);
  if (parts.length < 3) return true; // need at least hive\software\<x>
  const idx = parts.indexOf('software');
  if (idx === -1) return true; // only ever touch ...\SOFTWARE\...
  let after = parts.slice(idx + 1);
  if (after[0] === 'wow6432node') after = after.slice(1);
  if (after.length < 1) return true; // Software (or WOW6432Node) root itself
  if (after.length === 1 && PROTECTED_REG_LEAVES.has(after[0])) return true;
  if (PROTECTED_REG_CONTAINERS.has(after.join('\\'))) return true;
  return false;
}

// A single *value* may be removed from a key like ...\Run, but the key must
// still be under SOFTWARE and deep enough to be specific.
function isProtectedRegValue(keyPath, valueName) {
  if (!valueName) return true;
  const n = String(keyPath || '').toLowerCase();
  const parts = n.split('\\').filter(Boolean);
  return parts.length < 3 || !parts.includes('software');
}

// --- leftover candidate generation ---------------------------------------
const GENERIC_EXES = new Set(['unins000.exe', 'unins001.exe', 'uninstall.exe', 'uninst.exe', 'setup.exe', 'msiexec.exe',
  'update.exe', 'explorer.exe', 'rundll32.exe', 'cmd.exe', 'powershell.exe', 'helper.exe', 'installer.exe']);

function appExeNames(app) {
  const out = [];
  for (const p of [app.iconPath, exeFromCommand(app.uninstallString)]) {
    const b = path.win32.basename(String(p || '')).toLowerCase();
    if (/\.exe$/.test(b) && !GENERIC_EXES.has(b) && !/^unins/.test(b)) out.push(b);
  }
  return uniq(out);
}

function appNames(app) {
  return uniq([app.name, app.rawName].filter(Boolean).map(sanitizeSeg).filter((n) => normName(n).length >= 4));
}

function candidateFolders(app, env, mode = 'moderate') {
  const e = env || process.env;
  const rank = modeRank(mode);
  const out = new Set();
  if (app.installLocation) out.add(String(app.installLocation).replace(/[\\/]+$/, ''));
  if (rank >= 1) {
    const bases = [
      e.ProgramFiles, e['ProgramFiles(x86)'], e.LOCALAPPDATA, e.APPDATA, e.ProgramData,
      e.LOCALAPPDATA ? path.win32.join(e.LOCALAPPDATA, 'Programs') : null,
    ].filter(Boolean);
    if (rank >= 2 && e.TEMP) bases.push(e.TEMP);
    const names = appNames(app).filter((n) => !n.includes('\\') && !n.includes('/'));
    const pub = sanitizeSeg(app.publisher);
    for (const base of bases) {
      for (const n of names) {
        out.add(path.win32.join(base, n));
        if (pub && !pub.includes('\\') && normName(pub).length >= 3) out.add(path.win32.join(base, pub, n));
      }
    }
  }
  return [...out].filter((f) => f && !isProtectedPath(f, e) && folderLeafMatches(f, app));
}

function folderLeafMatches(folder, app) {
  // installLocation is authoritative (came from the app's own registry entry).
  if (app.installLocation && winNorm(folder) === winNorm(app.installLocation)) return true;
  const leaf = normName(path.win32.basename(String(folder)).replace(/\.lnk$/i, ''));
  if (leaf.length < 4) return false;
  const cands = uniq([app.name, app.rawName].filter(Boolean).map(normName)).filter((c) => c.length >= 4);
  return cands.some((c) => leaf === c || leaf.startsWith(c) || c.startsWith(leaf));
}

function candidateRegistryKeys(app, mode = 'moderate') {
  const rank = modeRank(mode);
  const keys = [];
  if (app.regPath) keys.push(regToPs(hiveShort(app.regPath))); // the app's own Uninstall key
  if (rank >= 1) {
    const roots = ['HKCU:\\SOFTWARE', 'HKLM:\\SOFTWARE', 'HKLM:\\SOFTWARE\\WOW6432Node', 'HKCU:\\SOFTWARE\\WOW6432Node'];
    const names = appNames(app).filter((n) => !n.includes('\\') && !PROTECTED_REG_LEAVES.has(normName(n)));
    for (const n of names) for (const r of roots) keys.push(`${r}\\${n}`);
    const pub = sanitizeSeg(app.publisher);
    if (pub && !pub.includes('\\') && normName(pub).length >= 3) {
      for (const n of names) for (const r of roots) keys.push(`${r}\\${pub}\\${n}`);
    }
  }
  if (rank >= 2) {
    for (const exe of appExeNames(app)) {
      keys.push(`HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`);
      keys.push(`HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`);
      keys.push(`HKCU:\\SOFTWARE\\Classes\\Applications\\${exe}`);
      keys.push(`HKLM:\\SOFTWARE\\Classes\\Applications\\${exe}`);
    }
  }
  return uniq(keys).filter((k) => !isProtectedRegPath(k));
}

// Does a Run/RunOnce entry belong to this app?
function runValueMatches(entry, app) {
  const data = String(entry.data || '');
  if (app.installLocation && winNorm(data).includes(winNorm(app.installLocation)) && winNorm(app.installLocation).split('\\').length >= 3) return true;
  const exe = normName(path.win32.basename(exeFromCommand(data)).replace(/\.exe$/i, ''));
  const name = normName(entry.name);
  return [app.name, app.rawName].filter(Boolean).map(normName).filter((c) => c.length >= 4)
    .some((c) => name === c || name.startsWith(c) || (exe.length >= 4 && (exe.startsWith(c) || c.startsWith(exe))));
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
        key = $_.PSChildName; regPath = $_.Name; name = $p.DisplayName; version = $p.DisplayVersion
        publisher = $p.Publisher; installDate = $p.InstallDate; installLocation = $p.InstallLocation
        uninstallString = $p.UninstallString; quietUninstallString = $p.QuietUninstallString
        modifyPath = $p.ModifyPath; noModify = $p.NoModify; noRepair = $p.NoRepair; noRemove = $p.NoRemove
        displayIcon = $p.DisplayIcon; urlInfo = $p.URLInfoAbout; helpLink = $p.HelpLink; comments = $p.Comments
        installSource = $p.InstallSource; estimatedSize = $p.EstimatedSize; systemComponent = $p.SystemComponent
        releaseType = $p.ReleaseType; parentKeyName = $p.ParentKeyName; windowsInstaller = $p.WindowsInstaller
        scope = $r.Scope; type = 'program'
      })
    }
  }
}
try {
  $start = @{}
  try { Get-StartApps | ForEach-Object { $pfn = ($_.AppID -split '!')[0]; if (-not $start.ContainsKey($pfn)) { $start[$pfn] = $_.Name } } } catch {}
  Get-AppxPackage -PackageTypeFilter Main -ErrorAction SilentlyContinue | ForEach-Object {
    $pkg = $_
    $disp = $start[$pkg.PackageFamilyName]
    $pubName = ''; $logo = ''
    if ($disp -and $pkg.InstallLocation) {
      try {
        [xml]$m = Get-Content -LiteralPath (Join-Path $pkg.InstallLocation 'AppxManifest.xml') -ErrorAction Stop
        $pubName = [string]$m.Package.Properties.PublisherDisplayName
        $rel = [string]$m.Package.Properties.Logo
        if ($rel) {
          $full = Join-Path $pkg.InstallLocation $rel
          if (Test-Path -LiteralPath $full) { $logo = $full } else {
            $dir = Split-Path $full -Parent; $base = [IO.Path]::GetFileNameWithoutExtension($full); $ext = [IO.Path]::GetExtension($full)
            $f = Get-ChildItem -LiteralPath $dir -Filter ($base + '*' + $ext) -ErrorAction SilentlyContinue | Sort-Object { if ($_.Name -match 'scale-100|targetsize-32') { 0 } else { 1 } } | Select-Object -First 1
            if ($f) { $logo = $f.FullName }
          }
        }
      } catch {}
    }
    [void]$apps.Add([PSCustomObject]@{
      key = $pkg.PackageFullName; name = $pkg.Name; displayName = $disp; version = [string]$pkg.Version
      publisher = $pkg.Publisher; publisherDisplayName = $pubName; installLocation = $pkg.InstallLocation
      packageFullName = $pkg.PackageFullName; packageFamilyName = $pkg.PackageFamilyName
      isFramework = $pkg.IsFramework; nonRemovable = $pkg.NonRemovable; resourceId = $pkg.ResourceId
      signatureKind = [string]$pkg.SignatureKind; logoPath = $logo; scope = 'store'; type = 'store'
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
    installLocation: e.installLocation ? String(e.installLocation).trim().replace(/^"|"$/g, '') : '',
    uninstallString: e.uninstallString ? String(e.uninstallString) : '',
    quietUninstallString: e.quietUninstallString ? String(e.quietUninstallString) : '',
    modifyPath: e.modifyPath ? String(e.modifyPath) : '',
    canModify: !(e.noModify === 1 || e.noModify === '1'),
    canRepair: !(e.noRepair === 1 || e.noRepair === '1'),
    iconPath: parseIconPath(e.displayIcon),
    urlInfo: e.urlInfo ? String(e.urlInfo) : '',
    helpLink: e.helpLink ? String(e.helpLink) : '',
    comments: e.comments ? String(e.comments) : '',
    installSource: e.installSource ? String(e.installSource) : '',
    sizeKB: Number.isFinite(est) && est > 0 ? est : null,
    scope: e.scope || '',
    windowsInstaller: e.windowsInstaller,
    releaseType: e.releaseType,
    parentKeyName: e.parentKeyName,
  };
}

/**
 * Normalize the raw JSON from LIST_SCRIPT into a clean, de-duplicated, sorted
 * app list. System components / background Store packages are kept but
 * flagged `system: true` so the UI can hide them by default.
 */
function parseAppsJson(raw) {
  const data = parseJsonList(raw);
  const out = [];
  const seen = new Set();
  for (const e of data) {
    if (!e || !e.name) continue;
    if (e.type === 'store') {
      if (e.isFramework === true || e.nonRemovable === true) continue;
      if (e.resourceId) continue; // language/resource sub-packages
      const id = `store:${e.packageFullName || e.key || e.name}`;
      if (seen.has(id)) continue; seen.add(id);
      const disp = e.displayName && !/^ms-resource:/i.test(e.displayName) ? String(e.displayName) : '';
      const pubDisp = e.publisherDisplayName && !/^ms-resource:/i.test(e.publisherDisplayName) ? String(e.publisherDisplayName) : '';
      out.push({
        id,
        type: 'store',
        name: disp || friendlyStoreName(e.name),
        rawName: String(e.name),
        version: e.version ? String(e.version) : '',
        publisher: pubDisp || cleanPublisher(e.publisher),
        installDate: '',
        installLocation: e.installLocation ? String(e.installLocation) : '',
        packageFullName: e.packageFullName || '',
        packageFamilyName: e.packageFamilyName || '',
        iconPath: e.logoPath ? String(e.logoPath) : '',
        sizeKB: null,
        msiGuid: null,
        scope: 'store',
        // Packages with no Start-menu entry are background/OS components.
        system: !disp || /^system$/i.test(String(e.signatureKind || '')),
      });
    } else {
      const app = normalizeProgramFields(e);
      if (looksLikeUpdate(app)) continue;
      const msiGuid = extractMsiGuid(app);
      if (!app.uninstallString && !app.quietUninstallString && !msiGuid) continue;
      const id = `prog:${app.scope}:${e.key || app.name}`;
      if (seen.has(id)) continue; seen.add(id);
      app.id = id;
      app.type = 'program';
      app.msiGuid = msiGuid;
      app.system = e.systemComponent === 1 || e.systemComponent === '1';
      out.push(app);
    }
  }
  out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return out;
}

async function listApps() {
  if (!IS_WIN) return { supported: false, platform: process.platform, apps: [], admin: false };
  const [raw, admin] = await Promise.all([runPowerShell(LIST_SCRIPT, { timeout: 120000 }), w.isAdmin()]);
  return { supported: true, apps: parseAppsJson(raw), admin };
}

// --------------------------------------------------------------------------
// Uninstall / repair / misc actions
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
      const code = await w.runExe('msiexec.exe', args, { hide: silent });
      return { ok: code === 0 || code === 3010, code, reboot: code === 3010 };
    }
    const cmd = (silent && app.quietUninstallString) ? app.quietUninstallString : app.uninstallString;
    if (!cmd) return { ok: false, error: 'No uninstall command is registered for this program.' };
    const code = await w.runViaCmd(cmd, { hide: silent });
    return { ok: code === 0 || code === 3010, code };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function repairApp(app) {
  if (!IS_WIN) return { ok: false, error: 'Windows only.' };
  try {
    if (app.msiGuid) {
      const code = await w.runExe('msiexec.exe', ['/fa', app.msiGuid]);
      return { ok: code === 0 || code === 3010, code };
    }
    if (app.modifyPath) {
      const code = await w.runViaCmd(app.modifyPath);
      return { ok: code === 0, code };
    }
    return { ok: false, error: 'This program does not offer Repair / Modify.' };
  } catch (err) { return { ok: false, error: err.message }; }
}

/** Open Registry Editor at a key (sets regedit's LastKey, then launches it). */
async function openInRegedit(psPath) {
  if (!IS_WIN) return { ok: false, error: 'Windows only.' };
  const target = `Computer\\${w.regLong(psPath)}`;
  try {
    await runPowerShell(`Set-ItemProperty -Path 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Applets\\Regedit' -Name LastKey -Value '${psEsc(target)}' -Force -ErrorAction SilentlyContinue; Start-Process regedit.exe -ArgumentList '-m'`, { timeout: 20000 });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

async function createRestorePoint(description) {
  if (!IS_WIN) return { ok: false, error: 'Windows only.' };
  if (!(await w.isAdmin())) return { ok: false, error: 'Creating a restore point requires running IT Tools as administrator.' };
  const out = await runPowerShell(`try { Checkpoint-Computer -Description '${psEsc(description || 'IT Tools: before uninstall')}' -RestorePointType APPLICATION_UNINSTALL -ErrorAction Stop; 'OK' } catch { 'ERR:' + $_.Exception.Message }`, { timeout: 180000 })
    .catch((err) => `ERR:${err.message}`);
  if (/ERR:/.test(out)) return { ok: false, error: (out.split('ERR:')[1] || '').trim() || 'Restore point failed (System Protection may be off, or one was already created in the last 24h).' };
  return { ok: true };
}

/** Render the program list as CSV or HTML for export. */
function exportList(format, apps) {
  const cols = [['name', 'Name'], ['version', 'Version'], ['publisher', 'Publisher'], ['size', 'Size (MB)'],
    ['installDate', 'Installed'], ['type', 'Type'], ['installLocation', 'Location'], ['uninstallString', 'Uninstall command']];
  const rows = (apps || []).map((a) => ({ ...a, size: a.sizeKB ? (a.sizeKB / 1024).toFixed(1) : '' }));
  if (format === 'html') {
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Installed programs</title><style>body{font-family:Segoe UI,Arial,sans-serif;margin:24px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #ddd;padding:5px 8px;text-align:left}th{background:#f3f5f9}</style></head><body><h1>Installed programs</h1><p>${rows.length} programs · ${esc(new Date().toLocaleString())}</p><table><thead><tr>${cols.map((c) => `<th>${c[1]}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c[0]])}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
  }
  const q = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
  return [cols.map((c) => q(c[1])).join(','), ...rows.map((r) => cols.map((c) => q(r[c[0]])).join(','))].join('\r\n');
}

// --------------------------------------------------------------------------
// Leftover scan + removal
// --------------------------------------------------------------------------
async function checkRegistryKeys(psPaths) {
  if (!IS_WIN || !psPaths.length) return [];
  const arr = psPaths.map((p) => `'${psEsc(p)}'`).join(',');
  const script = `$paths=@(${arr}); $o=New-Object System.Collections.ArrayList; foreach($p in $paths){ if(Test-Path -LiteralPath $p){ $v=0; $s=0; try{ $k=Get-Item -LiteralPath $p; $v=($k.GetValueNames()).Count; $s=$k.SubKeyCount }catch{}; [void]$o.Add([PSCustomObject]@{path=$p; values=$v; subkeys=$s}) } } $o | ConvertTo-Json -Compress`;
  return parseJsonList(await runPowerShell(script, { timeout: 30000 }));
}

async function findUninstallEntries(name) {
  const n = sanitizeSeg(name);
  if (!IS_WIN || normName(n).length < 3) return [];
  const script = `$o=New-Object System.Collections.ArrayList; foreach($r in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall')){ Get-ChildItem -Path $r -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue; if($p.DisplayName -and $p.DisplayName -like '*${psEsc(n).replace(/[*?[\]]/g, '')}*'){ [void]$o.Add([PSCustomObject]@{path=($r + '\\' + $_.PSChildName); name=$p.DisplayName; location=$p.InstallLocation}) } } }; $o | ConvertTo-Json -Compress`;
  return parseJsonList(await runPowerShell(script, { timeout: 60000 }));
}

function lsSafe(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; } }

/**
 * Find leftovers for an app. opts.mode: 'safe' | 'moderate' | 'advanced'.
 * opts.otherLocations: install folders of programs that remain installed —
 * any candidate folder shared with them is skipped.
 */
async function scanLeftovers(app, opts = {}) {
  if (!IS_WIN) return { supported: false, items: [] };
  if (!app) return { supported: true, items: [] };
  const mode = MODES.includes(opts.mode) ? opts.mode : 'moderate';
  const rank = modeRank(mode);
  const env = process.env;
  const others = opts.otherLocations || [];
  const items = [];
  const seen = new Set();
  const addFs = (p, kind) => {
    const key = winNorm(p);
    if (seen.has(key) || isProtectedPath(p, env) || sharedWithOthers(p, others)) return;
    seen.add(key);
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) items.push({ kind: 'folder', path: p, display: p, sizeBytes: dirSizeSafe(p) });
      else if (st.isFile()) items.push({ kind: kind || 'file', path: p, display: p, sizeBytes: st.size });
    } catch (_) { /* not present */ }
  };

  // Folders (install location + name-matched locations).
  for (const f of candidateFolders(app, env, mode)) addFs(f);

  if (rank >= 1) {
    // Start Menu folders / shortcuts.
    for (const dir of startMenuDirs(env)) {
      for (const ent of lsSafe(dir)) {
        if ((ent.isDirectory() || /\.lnk$/i.test(ent.name)) && folderLeafMatches(ent.name, app)) addFs(path.win32.join(dir, ent.name), 'shortcut');
      }
    }
  }
  if (rank >= 2) {
    // Desktop shortcuts.
    for (const dir of desktopDirs(env)) {
      for (const ent of lsSafe(dir)) if (/\.lnk$/i.test(ent.name) && folderLeafMatches(ent.name, app)) addFs(path.win32.join(dir, ent.name), 'shortcut');
    }
    // Publisher folder that would be left empty (contains only this product).
    const pub = sanitizeSeg(app.publisher);
    if (pub && normName(pub).length >= 3 && !pub.includes('\\')) {
      for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData, env.APPDATA, env.LOCALAPPDATA].filter(Boolean)) {
        const dir = path.win32.join(base, pub);
        const ents = lsSafe(dir);
        if (ents.length && ents.every((x) => x.isDirectory() && folderLeafMatches(x.name, app))) addFs(dir);
      }
    }
  }

  // Registry keys (existence confirmed via PowerShell).
  const keys = candidateRegistryKeys(app, mode);
  if (keys.length) {
    const existing = await checkRegistryKeys(keys).catch(() => []);
    for (const k of existing) {
      if (isProtectedRegPath(k.path)) continue;
      items.push({ kind: 'registry', path: k.path, display: k.path, values: k.values || 0, subkeys: k.subkeys || 0 });
    }
  }

  // Startup (Run/RunOnce) values pointing at the app.
  if (rank >= 2) {
    const runs = await require('./startup').readRunValues().catch(() => []);
    for (const r of runs) {
      if (runValueMatches(r, app) && !isProtectedRegValue(r.key, r.name)) {
        items.push({ kind: 'regvalue', path: r.key, value: r.name, display: `${r.key}  →  ${r.name}`, data: r.data });
      }
    }
  }
  return { supported: true, mode, items };
}

/** Forced Uninstall: hunt remnants of a broken / already-removed program. */
async function forcedScan({ name, publisher, folder, mode } = {}) {
  if (!IS_WIN) return { supported: false, items: [] };
  const n = sanitizeSeg(name);
  if (normName(n).length < 3 && !folder) return { supported: true, items: [], error: 'Enter a program name (3+ characters) or pick its folder.' };
  const app = { name: n, rawName: n, publisher: sanitizeSeg(publisher), installLocation: folder ? String(folder) : '' };
  const installed = await listApps().catch(() => ({ apps: [] }));
  const others = (installed.apps || []).filter((a) => !folderLeafMatches(a.name, app)).map((a) => a.installLocation).filter(Boolean);
  const res = await scanLeftovers(app, { mode: mode || 'advanced', otherLocations: others });
  // Orphaned / broken Uninstall entries with a matching name.
  if (n) {
    for (const ent of await findUninstallEntries(n).catch(() => [])) {
      if (!isProtectedRegPath(ent.path) && !res.items.some((i) => i.path === ent.path)) {
        res.items.unshift({ kind: 'registry', path: ent.path, display: `${ent.path}  (entry: ${ent.name})`, values: 0 });
      }
    }
  }
  return res;
}

/**
 * Delete user-selected leftover items, backing each up first. Re-validates
 * safety here (defense in depth) — never trusts the renderer's list blindly.
 * opts: { backup = true, recycle = true, label }
 */
async function removeLeftovers(items, opts = {}) {
  if (!IS_WIN) return { supported: false, results: [] };
  const doBackup = opts.backup !== false;
  const session = doBackup ? backups.begin(opts.label || 'Leftover cleanup') : null;
  const results = [];
  for (const it of (items || [])) {
    const p = it && it.path;
    try {
      if (!p || typeof p !== 'string') throw new Error('invalid item');
      if (it.kind === 'registry') {
        if (isProtectedRegPath(p)) throw new Error('protected registry key — refused');
        if (session) await session.saveRegistry(p);
        await w.regDelete(p);
        results.push({ path: p, kind: it.kind, ok: true });
      } else if (it.kind === 'regvalue') {
        if (isProtectedRegValue(p, it.value)) throw new Error('protected registry value — refused');
        if (session) await session.saveRegistry(p, it.value);
        await w.regDelete(p, it.value);
        results.push({ path: p, value: it.value, kind: it.kind, ok: true });
      } else {
        if (!path.win32.isAbsolute(p) && !path.isAbsolute(p)) throw new Error('path is not absolute');
        if (isProtectedPath(p)) throw new Error('protected system path — refused');
        const how = await w.removePath(p, { recycle: opts.recycle !== false });
        if (session) session.recordFile(p, how);
        results.push({ path: p, kind: it.kind, ok: true, how });
      }
    } catch (err) {
      results.push({ path: p, value: it && it.value, kind: it && it.kind, ok: false, error: err.message });
    }
  }
  const manifest = session ? session.finish() : null;
  return { supported: true, results, backupId: manifest ? manifest.id : null };
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
    const mode = MODES.includes(opts.mode) ? opts.mode : 'moderate';
    const total = list.length;
    const results = [];
    const leftovers = [];
    let restorePoint = null;
    try {
      if (opts.restorePoint) {
        this.emit('progress', { index: -1, total, app: 'System Restore point', phase: 'restorepoint' });
        restorePoint = await createRestorePoint(`IT Tools: before uninstalling ${list.map((a) => a.name).slice(0, 3).join(', ')}`);
        this.emit('progress', { index: -1, total, app: 'System Restore point', phase: restorePoint.ok ? 'done' : 'error', error: restorePoint.error });
      }
      // Locations of programs that stay installed (never flag shared folders).
      let others = [];
      if (scanAfter) {
        const ids = new Set(list.map((a) => a.id));
        const all = await listApps().catch(() => ({ apps: [] }));
        others = (all.apps || []).filter((a) => !ids.has(a.id)).map((a) => a.installLocation).filter(Boolean);
      }
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
          const scan = await scanLeftovers(app, { mode, otherLocations: others }).catch(() => ({ items: [] }));
          if (scan.items && scan.items.length) leftovers.push({ id: app.id, app: app.name, items: scan.items });
        }
        this.emit('progress', {
          index: i, total, app: app.name, phase: r.ok ? 'done' : 'error', error: r.error, reboot: r.reboot,
        });
      }
    } finally {
      this.running = false;
    }
    const done = { results, leftovers, cancelled: this._cancel, restorePoint };
    this.emit('done', done);
    return done;
  }
}

module.exports = {
  IS_WIN,
  MODES,
  listApps,
  parseAppsJson,
  uninstallApp,
  repairApp,
  openInRegedit,
  createRestorePoint,
  exportList,
  scanLeftovers,
  forcedScan,
  removeLeftovers,
  Uninstaller,
  // exported for tests / sibling modules
  _internals: {
    normName,
    winNorm,
    cleanPublisher,
    friendlyStoreName,
    parseIconPath,
    exeFromCommand,
    looksLikeUpdate,
    extractMsiGuid,
    isProtectedPath,
    isProtectedRegPath,
    isProtectedRegValue,
    sharedWithOthers,
    candidateFolders,
    candidateRegistryKeys,
    folderLeafMatches,
    runValueMatches,
    hiveShort,
    regToPs,
    psToRegExe,
    dirSizeSafe,
  },
};
