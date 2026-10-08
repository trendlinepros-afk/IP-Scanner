'use strict';

/**
 * Shared Windows helpers for the system tools (uninstaller, startup manager,
 * junk cleaner, install monitor): PowerShell / process spawning, registry
 * path conversions, reg.exe wrappers, elevation detection and Recycle Bin
 * deletion. Pure Node + spawned Windows tools; no native modules.
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';

// Escape a value for a PowerShell single-quoted string literal.
function psEsc(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').replace(/'/g, "''");
}

// UTF-16LE base64 for powershell -EncodedCommand (no shell-quoting issues).
function psEncode(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShell(script, { timeout = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    // Force UTF-8 output so non-ASCII program names survive the pipe.
    const full = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${script}`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', psEncode(full)],
      { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && !stdout) { reject(new Error((stderr || err.message || 'PowerShell failed').toString().trim())); return; }
        resolve((stdout || '').toString());
      },
    );
  });
}

// Parse ConvertTo-Json output that may be an object, an array or empty.
function parseJsonList(raw) {
  let data;
  try { data = JSON.parse(String(raw || '').trim() || 'null'); } catch (_) { return []; }
  if (!data) return [];
  return (Array.isArray(data) ? data : [data]).filter(Boolean);
}

// Run an executable and resolve with its exit code (best effort).
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

// --- registry path conversions -------------------------------------------
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
function regLong(p) {
  return psToRegExe(p)
    .replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\')
    .replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\')
    .replace(/^HKCR\\/i, 'HKEY_CLASSES_ROOT\\')
    .replace(/^HKU\\/i, 'HKEY_USERS\\');
}

function reg(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', args, { windowsHide: true, timeout }, (err, so, se) => {
      if (err) { reject(new Error(((se || so || err.message || '').toString().trim()) || 'reg.exe failed')); return; }
      resolve((so || '').toString());
    });
  });
}

// Delete a key (or a single value when valueName is given).
function regDelete(psPath, valueName) {
  const args = ['delete', psToRegExe(psPath)];
  if (valueName != null && valueName !== '') args.push('/v', String(valueName));
  args.push('/f');
  return reg(args);
}
function regExport(psPath, file) { return reg(['export', psToRegExe(psPath), file, '/y']); }
function regImport(file) { return reg(['import', file]); }
function regSetBinary(psPath, name, hex) {
  return reg(['add', psToRegExe(psPath), '/v', name, '/t', 'REG_BINARY', '/d', hex, '/f']);
}

// --- elevation ------------------------------------------------------------
let _admin = null;
async function isAdmin() {
  if (!IS_WIN) return false;
  if (_admin != null) return _admin;
  try {
    const out = await runPowerShell('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)', { timeout: 15000 });
    _admin = /true/i.test(out);
  } catch (_) { _admin = false; }
  return _admin;
}

// --- deletion -------------------------------------------------------------
// Prefer the Recycle Bin (recoverable) via Electron's shell; fall back to a
// hard delete when unavailable (e.g. under plain Node in tests) or it fails.
async function removePath(p, { recycle = true } = {}) {
  if (recycle) {
    let shell = null;
    try { ({ shell } = require('electron')); } catch (_) { /* not in Electron */ }
    if (shell && typeof shell.trashItem === 'function') {
      try { await shell.trashItem(p); return 'recycled'; } catch (_) { /* fall through */ }
    }
  }
  fs.rmSync(p, { recursive: true, force: true });
  return 'deleted';
}

module.exports = {
  IS_WIN,
  psEsc,
  psEncode,
  runPowerShell,
  parseJsonList,
  runExe,
  runViaCmd,
  hiveShort,
  regToPs,
  psToRegExe,
  regLong,
  regDelete,
  regExport,
  regImport,
  regSetBinary,
  isAdmin,
  removePath,
};
