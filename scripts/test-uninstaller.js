'use strict';

/**
 * Unit tests for the uninstaller engine's pure logic: app-list parsing/filtering
 * and the safety guards that decide what may be flagged/deleted as a leftover.
 * The Windows-only spawning paths (powershell/msiexec/reg) are not exercised here.
 *
 *   node scripts/test-uninstaller.js
 */

const assert = require('assert');
const u = require('../src/main/uninstaller');

const {
  normName, friendlyStoreName, looksLikeUpdate, extractMsiGuid,
  isProtectedPath, isProtectedRegPath, candidateFolders, candidateRegistryKeys,
  folderLeafMatches, hiveShort, regToPs, psToRegExe,
} = u._internals;

let passed = 0;
function ok(name, fn) {
  try { fn(); passed += 1; } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`FAIL: ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}

// ---- parseAppsJson -------------------------------------------------------
const sample = JSON.stringify([
  { type: 'program', key: 'Chrome', name: 'Google Chrome', publisher: 'Google LLC', version: '128.0', uninstallString: 'C:\\Program Files\\Google\\Chrome\\uninstall.exe', estimatedSize: 512000, scope: 'machine' },
  { type: 'program', key: '{11112222-3333-4444-5555-666677778888}', name: 'Widget MSI', windowsInstaller: 1, uninstallString: 'MsiExec.exe /I{11112222-3333-4444-5555-666677778888}', scope: 'machine' },
  { type: 'program', key: 'KB5001', name: 'KB5001330 Security Update', uninstallString: 'x', scope: 'machine' }, // update → filtered
  { type: 'program', key: 'Sys', name: 'Hidden System Thing', systemComponent: 1, uninstallString: 'x', scope: 'machine' }, // system → filtered
  { type: 'program', key: 'NoUninstall', name: 'Orphan Entry', scope: 'machine' }, // no uninstall method → filtered
  { type: 'program', key: 'UpdFor', name: 'Update for Microsoft Office', uninstallString: 'x', scope: 'machine' }, // update → filtered
  { type: 'store', key: 'Microsoft.WindowsCalculator_1', name: 'Microsoft.WindowsCalculator', publisher: 'CN=Microsoft', version: '11.0', packageFullName: 'Microsoft.WindowsCalculator_8wek' },
  { type: 'store', name: 'Microsoft.VCLibs.140.00', isFramework: true, packageFullName: 'x' }, // framework → filtered
  { type: 'store', name: 'Some.Resource', resourceId: 'en-US', packageFullName: 'y' }, // resource → filtered
  { type: 'store', name: 'Microsoft.NonRemovable', nonRemovable: true, packageFullName: 'z' }, // non-removable → filtered
]);

ok('parseAppsJson filters + normalizes', () => {
  const apps = u.parseAppsJson(sample);
  const names = apps.map((a) => a.name);
  assert.ok(names.includes('Google Chrome'), 'keeps Chrome');
  assert.ok(names.includes('Widget MSI'), 'keeps MSI app');
  assert.ok(names.includes('Windows Calculator'), 'store friendly name');
  assert.ok(!names.some((n) => /KB5001|Security Update|Update for/.test(n)), 'drops updates');
  assert.ok(!names.includes('Hidden System Thing'), 'drops system component');
  assert.ok(!names.includes('Orphan Entry'), 'drops entries with no uninstall method');
  assert.ok(!names.some((n) => /VCLibs|Resource|NonRemovable/.test(n)), 'drops store frameworks/resources/non-removable');
  // sorted ascending by name
  const sorted = apps.map((a) => a.name.toLowerCase());
  assert.deepStrictEqual(sorted, sorted.slice().sort(), 'sorted by name');
});

ok('parseAppsJson extracts MSI GUID', () => {
  const apps = u.parseAppsJson(sample);
  const msi = apps.find((a) => a.name === 'Widget MSI');
  assert.strictEqual(msi.msiGuid, '{11112222-3333-4444-5555-666677778888}');
  assert.strictEqual(msi.type, 'program');
});

ok('parseAppsJson dedupes and tolerates single object / junk', () => {
  assert.deepStrictEqual(u.parseAppsJson('not json'), []);
  assert.deepStrictEqual(u.parseAppsJson('null'), []);
  const one = u.parseAppsJson(JSON.stringify({ type: 'program', key: 'A', name: 'Solo', uninstallString: 'x' }));
  assert.strictEqual(one.length, 1);
});

// ---- friendlyStoreName ---------------------------------------------------
ok('friendlyStoreName humanizes identity names', () => {
  assert.strictEqual(friendlyStoreName('Microsoft.WindowsCalculator'), 'Windows Calculator');
  assert.strictEqual(friendlyStoreName('SpotifyAB.SpotifyMusic'), 'Spotify Music');
  assert.strictEqual(friendlyStoreName('Plain'), 'Plain');
});

// ---- looksLikeUpdate -----------------------------------------------------
ok('looksLikeUpdate matches patches, not apps', () => {
  assert.ok(looksLikeUpdate({ name: 'KB5001330' }));
  assert.ok(looksLikeUpdate({ name: 'Security Update for Windows' }));
  assert.ok(looksLikeUpdate({ name: 'Update for Office' }));
  assert.ok(looksLikeUpdate({ name: 'X', parentKeyName: 'ParentProduct' }));
  assert.ok(!looksLikeUpdate({ name: 'Google Chrome' }));
});

// ---- extractMsiGuid ------------------------------------------------------
ok('extractMsiGuid from key and strings', () => {
  const g = '{ABCDEF01-2345-6789-ABCD-EF0123456789}';
  assert.strictEqual(extractMsiGuid({ windowsInstaller: 1, key: g }), g);
  assert.strictEqual(extractMsiGuid({ uninstallString: `MsiExec.exe /X${g}` }), g);
  assert.strictEqual(extractMsiGuid({ uninstallString: 'C:\\app\\uninst.exe /S' }), null);
});

// ---- filesystem safety ---------------------------------------------------
const ENV = {
  windir: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramData: 'C:\\ProgramData',
  APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\me',
};

ok('isProtectedPath refuses system + base dirs, allows app subfolders', () => {
  // protected
  assert.ok(isProtectedPath('C:\\', ENV));
  assert.ok(isProtectedPath('C:', ENV));
  assert.ok(isProtectedPath('C:\\Windows', ENV));
  assert.ok(isProtectedPath('C:\\Windows\\System32\\drivers', ENV), 'anything under Windows');
  assert.ok(isProtectedPath('C:\\Program Files', ENV));
  assert.ok(isProtectedPath('C:\\Program Files (x86)', ENV));
  assert.ok(isProtectedPath('C:\\Program Files\\Common Files\\Shared', ENV), 'Common Files subtree');
  assert.ok(isProtectedPath('C:\\Users', ENV));
  assert.ok(isProtectedPath('C:\\Users\\me\\AppData\\Local', ENV));
  assert.ok(isProtectedPath('', ENV));
  assert.ok(isProtectedPath('relativepath', ENV));
  // allowed leftovers
  assert.ok(!isProtectedPath('C:\\Program Files\\Widget', ENV));
  assert.ok(!isProtectedPath('C:\\Users\\me\\AppData\\Local\\Widget', ENV));
  assert.ok(!isProtectedPath('C:\\ProgramData\\Widget', ENV));
});

// ---- registry safety -----------------------------------------------------
ok('isProtectedRegPath refuses shallow/system keys, allows app keys', () => {
  assert.ok(isProtectedRegPath('HKCU:\\SOFTWARE'), 'software root');
  assert.ok(isProtectedRegPath('HKLM:\\SOFTWARE\\Microsoft'), 'Microsoft');
  assert.ok(isProtectedRegPath('HKLM:\\SOFTWARE\\Windows'));
  assert.ok(isProtectedRegPath('HKCU:\\SOFTWARE\\WOW6432Node'), 'wow node alone');
  assert.ok(isProtectedRegPath('HKCU:\\Environment'), 'not under Software');
  assert.ok(isProtectedRegPath('HKLM:'), 'hive only');
  assert.ok(!isProtectedRegPath('HKCU:\\SOFTWARE\\Widget'));
  assert.ok(!isProtectedRegPath('HKLM:\\SOFTWARE\\WOW6432Node\\Widget'));
  assert.ok(!isProtectedRegPath('HKCU:\\SOFTWARE\\WidgetCo\\Widget'));
});

// ---- candidate generation ------------------------------------------------
ok('candidateFolders builds from name, never publisher, never protected', () => {
  const app = { name: 'Widget', rawName: 'Widget', publisher: 'Microsoft Corporation', installLocation: 'C:\\Program Files\\Widget' };
  const folders = candidateFolders(app, ENV).map((f) => f.toLowerCase());
  assert.ok(folders.includes('c:\\program files\\widget'), 'includes installLocation');
  assert.ok(folders.some((f) => f.includes('appdata\\local\\widget')), 'local appdata guess');
  // must never generate a publisher-named folder like C:\Program Files\Microsoft
  assert.ok(!folders.some((f) => /\\microsoft$/.test(f)), 'no publisher folder');
});

ok('candidateFolders skips short/generic names', () => {
  const app = { name: 'Go', rawName: 'Go', publisher: 'x' }; // too short
  const folders = candidateFolders(app, ENV);
  assert.strictEqual(folders.length, 0);
});

ok('candidateRegistryKeys excludes protected leaves, includes own key + publisher\\name', () => {
  const app = {
    name: 'Widget', rawName: 'Widget', publisher: 'WidgetCo',
    regPath: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Widget',
  };
  const keys = candidateRegistryKeys(app);
  assert.ok(keys.some((k) => /Uninstall\\Widget$/.test(k)), 'own uninstall key (converted to PS form)');
  assert.ok(keys.some((k) => k === 'HKCU:\\SOFTWARE\\Widget'));
  assert.ok(keys.some((k) => k === 'HKLM:\\SOFTWARE\\WidgetCo\\Widget'));
  // a system-named app must not produce a dangerous single-segment key
  const sys = candidateRegistryKeys({ name: 'Windows', rawName: 'Windows', publisher: 'Microsoft' });
  assert.ok(!sys.some((k) => /:\\SOFTWARE\\Windows$/i.test(k)), 'no Software\\Windows');
});

ok('folderLeafMatches respects name similarity', () => {
  const app = { name: 'Widget', rawName: 'Widget' };
  assert.ok(folderLeafMatches('C:\\Program Files\\Widget', app));
  assert.ok(folderLeafMatches('C:\\Program Files\\WidgetPro', app));
  assert.ok(!folderLeafMatches('C:\\Program Files\\Chrome', app));
});

// ---- registry path conversions ------------------------------------------
ok('hive path conversions round-trip', () => {
  assert.strictEqual(hiveShort('HKEY_LOCAL_MACHINE\\SOFTWARE\\X'), 'HKLM\\SOFTWARE\\X');
  assert.strictEqual(regToPs('HKLM\\SOFTWARE\\X'), 'HKLM:\\SOFTWARE\\X');
  assert.strictEqual(psToRegExe('HKCU:\\SOFTWARE\\X'), 'HKCU\\SOFTWARE\\X');
  assert.strictEqual(psToRegExe(regToPs(hiveShort('HKEY_CURRENT_USER\\SOFTWARE\\X'))), 'HKCU\\SOFTWARE\\X');
});

ok('normName strips punctuation', () => {
  assert.strictEqual(normName('7-Zip 24.07 (x64)'), '7zip2407x64');
});

// eslint-disable-next-line no-console
console.log(`UNINSTALLER_TESTS ${JSON.stringify({ ok: process.exitCode ? false : true, passed })}`);
