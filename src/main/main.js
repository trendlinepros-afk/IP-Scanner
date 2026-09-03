'use strict';

/**
 * NetSweep — Electron main process.
 * Owns the application window, native menu, IPC surface and the auto-updater.
 */

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, Menu, shell, dialog, nativeTheme,
} = require('electron');

const { Scanner } = require('./scanner');
const network = require('./network');
const tools = require('./tools');
const exporter = require('./export');
const wol = require('./wol');
const store = require('./store');
const oui = require('./oui');
const ports = require('./ports');
const { UpdateManager } = require('./updater');

const isDev = !app.isPackaged || process.env.NODE_ENV === 'development';
// electron-builder's portable target exposes this env var at runtime.
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;

let mainWindow = null;
let scanner = null;
let updateManager = null;

function getWindow() {
  return mainWindow;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 740,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#1e2430',
    title: 'NetSweep',
    icon: resolveIcon(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // Headless smoke test (used by CI / `npm run smoke`): boot the full UI, fail
  // on any renderer/preload error, then exit. Enabled only via env var.
  if (process.env.NETSWEEP_SMOKE) wireSmokeTest();
  if (process.env.NETSWEEP_SHOT) wireScreenshot(process.env.NETSWEEP_SHOT);

  // Open external links in the OS browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^ftp:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function wireSmokeTest() {
  const wc = mainWindow.webContents;
  let failed = false;
  const fail = (why) => {
    failed = true;
    // eslint-disable-next-line no-console
    console.error('SMOKE_FAIL', why);
  };
  wc.on('console-message', (_e, level, message) => {
    // level 3 === error
    if (level >= 3) fail(`console error: ${message}`);
  });
  wc.on('did-fail-load', (_e, code, desc) => fail(`did-fail-load ${code} ${desc}`));
  wc.on('render-process-gone', (_e, details) => fail(`render-process-gone ${details.reason}`));
  wc.on('preload-error', (_e, _p, err) => fail(`preload-error ${err.message}`));
  wc.on('did-finish-load', () => {
    setTimeout(() => {
      // Ask the renderer whether it booted (table exists, appInfo resolved).
      wc.executeJavaScript(
        "(function(){try{return !!document.getElementById('table') && !!window.netsweep && document.getElementById('appVersion').textContent;}catch(e){return 'ERR:'+e.message;}})()",
      ).then((res) => {
        if (typeof res === 'string' && res.startsWith('ERR:')) fail(res);
        // eslint-disable-next-line no-console
        if (!failed) console.log('SMOKE_OK', JSON.stringify(res));
        setTimeout(() => app.exit(failed ? 1 : 0), 200);
      }).catch((err) => {
        fail(`executeJavaScript ${err.message}`);
        app.exit(1);
      });
    }, 1500);
  });
}

function wireScreenshot(outPath) {
  const wc = mainWindow.webContents;
  const sample = [
    { status: 'alive', name: 'gateway.local', ip: '192.168.1.1', mac: 'f0:9f:c2:1a:2b:3c', vendor: 'Ubiquiti Networks', responseMs: 1, shares: [{ type: 'http', label: 'HTTP' }, { type: 'https', label: 'HTTPS' }] },
    { status: 'alive', name: 'DESKTOP-A12B', ip: '192.168.1.14', mac: 'b8:ca:3a:44:55:66', vendor: 'Dell Inc.', responseMs: 2, shares: [{ type: 'smb', label: 'File shares' }] },
    { status: 'alive', name: 'macbook-pro', ip: '192.168.1.22', mac: 'a4:5e:60:77:88:99', vendor: 'Apple, Inc.', responseMs: 4, shares: [] },
    { status: 'alive', name: 'raspberrypi', ip: '192.168.1.30', mac: 'b8:27:eb:aa:bb:cc', vendor: 'Raspberry Pi Foundation', responseMs: 3, shares: [{ type: 'http', label: 'HTTP' }] },
    { status: 'alive', name: 'NAS-STORAGE', ip: '192.168.1.40', mac: '00:90:a9:12:34:56', vendor: 'Western Digital', responseMs: 2, shares: [{ type: 'smb', label: 'File shares' }, { type: 'http', label: 'HTTP' }] },
    { status: 'alive', name: 'HP-LaserJet', ip: '192.168.1.50', mac: '3c:4a:92:de:ad:be', vendor: 'Hewlett Packard', responseMs: 6, shares: [{ type: 'http', label: 'HTTP' }] },
    { status: 'alive', name: 'echo-dot', ip: '192.168.1.61', mac: '68:54:3d:0a:0b:0c', vendor: 'Amazon Technologies', responseMs: 8, shares: [] },
    { status: 'alive', name: 'living-room-tv', ip: '192.168.1.72', mac: '84:25:db:11:22:33', vendor: 'Samsung Electronics', responseMs: 5, shares: [] },
    { status: 'dead', name: '', ip: '192.168.1.99', mac: '', vendor: '', responseMs: null, shares: [] },
  ];
  wc.on('did-finish-load', () => {
    setTimeout(() => {
      const script = `(function(){
        var tbody=document.getElementById('tbody'); tbody.innerHTML='';
        var hosts=${JSON.stringify(sample)};
        function esc(s){return String(s).replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
        hosts.forEach(function(h){
          var badges=(h.shares||[]).map(function(s){return '<span class="share-badge">'+s.label+'</span>';}).join('');
          var tr=document.createElement('tr'); if(h.status!=='alive')tr.className='dead';
          tr.innerHTML='<td class="col-status"><span class="dot '+(h.status==='alive'?'up':'down')+'"></span>'+(h.status==='alive'?'Alive':'Dead')+'</td>'+
            '<td>'+esc(h.name)+'</td><td>'+h.ip+'</td><td class="mac">'+h.mac+'</td><td>'+esc(h.vendor)+'</td>'+
            '<td class="num">'+(h.responseMs==null?'':h.responseMs)+'</td><td>'+badges+'</td>';
          tbody.appendChild(tr);
        });
        document.getElementById('emptyState').classList.add('hidden');
        document.getElementById('hostCount').textContent='9 hosts';
        document.getElementById('aliveCount').textContent='8 alive';
        document.getElementById('statusSummary').textContent='Done · 8 of 254 alive in 3.2s';
        document.getElementById('elapsed').textContent='3.2s';
        var sel=document.getElementById('range'); if(sel) sel.value='192.168.1.1-254';
        return true;
      })()`;
      wc.executeJavaScript(script).then(() => setTimeout(async () => {
        try {
          const img = await wc.capturePage();
          fs.writeFileSync(outPath, img.toPNG());
          // eslint-disable-next-line no-console
          console.log('SHOT_OK', outPath);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('SHOT_FAIL', err.message);
        }
        app.exit(0);
      }, 400)).catch(() => app.exit(1));
    }, 1200);
  });
}

function resolveIcon() {
  const candidates = [
    path.join(__dirname, '..', '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    path.join(process.resourcesPath || '', 'build', 'icon.png'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {
      /* ignore */
    }
  }
  return undefined;
}

// --------------------------------------------------------------------------
// Application menu
// --------------------------------------------------------------------------
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Scan', accelerator: 'CmdOrCtrl+N', click: () => send('menu:new-scan') },
        { label: 'Start / Stop', accelerator: 'F5', click: () => send('menu:toggle-scan') },
        { type: 'separator' },
        {
          label: 'Export Results…',
          accelerator: 'CmdOrCtrl+E',
          click: () => send('menu:export'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'copy' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('menu:settings') },
        { label: 'Check for Updates…', click: () => send('menu:check-updates') },
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Project on GitHub',
          click: () => shell.openExternal('https://github.com/trendlinepros-afk/ip-scanner'),
        },
        { label: 'About NetSweep', click: () => send('menu:about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// --------------------------------------------------------------------------
// IPC surface
// --------------------------------------------------------------------------
function registerIpc() {
  // --- Environment / interfaces ---
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    name: 'NetSweep',
    platform: process.platform,
    isPortable,
    isDev,
    electron: process.versions.electron,
    node: process.versions.node,
    ouiCount: oui.size(),
    updatesSupported: updateManager ? updateManager.supported() : false,
  }));

  ipcMain.handle('net:interfaces', () => network.listInterfaces());
  ipcMain.handle('net:primary', () => network.primaryInterface());
  ipcMain.handle('net:defaultPorts', () => ports.DEFAULT_PORTS);

  // --- Scan lifecycle ---
  ipcMain.handle('scan:start', async (_e, { range, options }) => {
    if (scanner && scanner.isRunning()) return { ok: false, error: 'Scan already running' };
    scanner = new Scanner();
    scanner.on('start', (p) => send('scan:start', p));
    scanner.on('progress', (p) => send('scan:progress', p));
    scanner.on('phase', (p) => send('scan:phase', p));
    scanner.on('enrichProgress', (p) => send('scan:enrichProgress', p));
    scanner.on('host', (h) => send('scan:host', h));
    scanner.on('done', (p) => send('scan:done', p));
    scanner.on('error', (err) => send('scan:error', { message: err.message }));

    const merged = { ...store.getSettings(), ...(options || {}) };
    store.setLastRange(range);
    // Fire and forget; events drive the UI.
    scanner.scan(range, merged).catch((err) => send('scan:error', { message: err.message }));
    return { ok: true };
  });

  ipcMain.handle('scan:cancel', () => {
    if (scanner && scanner.isRunning()) {
      scanner.cancel();
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.handle('scan:rescanHost', async (_e, { ip, options }) => {
    if (!scanner) scanner = new Scanner();
    const merged = { ...store.getSettings(), ...(options || {}) };
    const record = await scanner.rescanHost(ip, merged);
    return record;
  });

  ipcMain.handle('scan:shares', async (_e, { ip }) => ports.listSmbShares(ip));

  // --- Remote tools ---
  ipcMain.handle('tool:ping', (_e, { ip, count }) => tools.ping(ip, count));
  ipcMain.handle('tool:traceroute', (_e, { ip }) => tools.traceroute(ip));
  ipcMain.handle('tool:nslookup', (_e, { host }) => tools.nslookup(host));
  ipcMain.handle('tool:rdp', (_e, { ip }) => tools.rdp(ip));
  ipcMain.handle('tool:ssh', (_e, { ip, user }) => tools.ssh(ip, user));
  ipcMain.handle('tool:telnet', (_e, { ip }) => tools.telnet(ip));
  ipcMain.handle('tool:openShares', (_e, { ip }) => tools.openShares(ip));
  ipcMain.handle('tool:openUrl', (_e, { url }) => tools.openUrl(url));
  ipcMain.handle('tool:shutdown', (_e, { ip }) => tools.shutdown(ip));
  ipcMain.handle('tool:wol', async (_e, { mac, address }) => {
    try {
      return await wol.wake(mac, { address });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // --- Favorites & settings ---
  ipcMain.handle('store:getSettings', () => store.getSettings());
  ipcMain.handle('store:setSettings', (_e, patch) => store.setSettings(patch || {}));
  ipcMain.handle('store:getFavorites', () => store.getFavorites());
  ipcMain.handle('store:addFavorite', (_e, fav) => store.addFavorite(fav));
  ipcMain.handle('store:removeFavorite', (_e, { ip }) => store.removeFavorite(ip));
  ipcMain.handle('store:getLastRange', () => store.getLastRange());

  // --- Theme ---
  ipcMain.handle('theme:set', (_e, { theme }) => {
    if (['light', 'dark', 'system'].includes(theme)) nativeTheme.themeSource = theme;
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  });

  // --- Export ---
  ipcMain.handle('export:save', async (_e, { format, hosts, meta }) => {
    const { content, ext } = exporter.render(format, hosts, meta);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export scan results',
      defaultPath: `netsweep-scan.${ext}`,
      filters: [
        { name: format.toUpperCase(), extensions: [ext] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, filePath };
  });

  ipcMain.handle('export:openFile', (_e, { filePath }) => shell.openPath(filePath));
  ipcMain.handle('export:showInFolder', (_e, { filePath }) => shell.showItemInFolder(filePath));

  // --- Updates ---
  ipcMain.handle('update:check', () => updateManager.check());
  ipcMain.handle('update:status', () => updateManager.status());
  ipcMain.handle('update:install', () => updateManager.installNow());
}

// --------------------------------------------------------------------------
// Single-instance lock + lifecycle
// --------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    store.init(app);

    // Apply persisted theme.
    const settings = store.getSettings();
    if (['light', 'dark', 'system'].includes(settings.theme)) {
      nativeTheme.themeSource = settings.theme;
    }

    updateManager = new UpdateManager(getWindow, { isPortable, isDev });

    registerIpc();
    buildMenu();
    createWindow();

    // Optional silent update check shortly after launch.
    if (settings.autoCheckUpdates && updateManager.supported()) {
      setTimeout(() => updateManager.checkSilently(), 4000);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
