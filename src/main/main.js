'use strict';

/**
 * IP Scanner — Electron main process.
 * Owns the application window, native menu, IPC surface and the auto-updater.
 */

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, Menu, shell, dialog, nativeTheme, screen,
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
const { SpeedTest } = require('./speedtest');
const wifi = require('./wifi');
const { LatencyMonitor } = require('./latency');
const { Traceroute } = require('./traceroute');
const { LanSpeedServer, LanSpeedClient } = require('./lanspeed');
const { DnsBenchmark } = require('./dns');
const netinfo = require('./netinfo');
const clients = require('./clients');
const report = require('./report');
const { AutoRun } = require('./autorun');

const isDev = !app.isPackaged || process.env.NODE_ENV === 'development';
// electron-builder's portable target exposes this env var at runtime.
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;

let mainWindow = null;
let scanner = null;
let updateManager = null;

// Stateful tool singletons.
let speedTest = null;
let latencyMonitor = null;
let tracerouteRunner = null;
let lanServer = null;
let lanClient = null;
let dnsBench = null;
let autoRun = null;

function getWindow() {
  return mainWindow;
}

function createWindow() {
  // Size to fit the display so every tool card is visible without scrolling,
  // but never larger than the available work area.
  let width = 1280;
  let height = 940;
  try {
    const wa = screen.getPrimaryDisplay().workAreaSize;
    width = Math.min(width, wa.width - 40);
    height = Math.min(height, wa.height - 40);
  } catch (_) { /* fall back to defaults */ }

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 900,
    minHeight: 600,
    center: true,
    backgroundColor: '#1e2430',
    title: 'IP Scanner',
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
  if (process.env.IPSCANNER_SMOKE) wireSmokeTest();
  if (process.env.IPSCANNER_SHOT) wireScreenshot(process.env.IPSCANNER_SHOT);

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
      // Ask the renderer whether it booted (home cards rendered, API present).
      wc.executeJavaScript(
        "(function(){try{var c=document.querySelectorAll('.tool-card').length;if(!window.ipScanner)return 'ERR: no api';if(c===0)return 'ERR: no cards';return 'cards='+c;}catch(e){return 'ERR:'+e.message;}})()",
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
  const view = process.env.IPSCANNER_SHOT_VIEW || 'home';
  wc.on('did-finish-load', () => {
    setTimeout(() => {
      // app.js exposes window.__demoNav(view) which navigates and injects
      // representative demo data so screenshots look realistic.
      const script = `(function(){try{ if(window.__demoNav){window.__demoNav(${JSON.stringify(view)});return 'ok';} return 'no-demoNav'; }catch(e){return 'ERR:'+e.message;}})()`;
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
      }, 600)).catch(() => app.exit(1));
    }, 1200);
  });
}

async function runSelfTest() {
  /* eslint-disable no-console */
  try {
    const c = clients.createClient({ name: `SelfTest ${Date.now()}`, company: 'QA', contact: 'Tester' });
    clients.saveResult(c.id, { type: 'speedtest', title: 'Internet Speed Test', summary: '↓ 482 / ↑ 41.7 Mbps', data: { downloadMbps: 482, uploadMbps: 41.7, ping: 8.4, jitter: 1.2, loss: 0, server: 'cloudflare', connection: 'Ethernet' } });
    clients.saveResult(c.id, { type: 'ping', title: 'Ping Monitor', summary: '8.8.8.8 avg 12ms', data: { target: '8.8.8.8', avg: 12, min: 11, max: 25, jitter: 1.4, lossPct: 0, sent: 21, recv: 21 } });
    clients.saveResult(c.id, { type: 'dns', title: 'DNS Benchmark', summary: 'Fastest Cloudflare', data: { resolvers: [{ name: 'Cloudflare', ip: '1.1.1.1', avg: 8.2, min: 6, max: 14, lossPct: 0 }] } });
    const history = clients.getHistory(c.id);
    const html = report.buildReportHtml(c, history, { generated: Date.now() });
    const pdf = await report.renderPdf(html);
    const file = path.join(c.dir, 'reports', 'selftest.pdf');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, pdf);
    const okPdf = pdf && pdf.length > 1000 && pdf.slice(0, 5).toString() === '%PDF-';
    const list = clients.listClients();
    const found = list.find((x) => x.id === c.id);
    console.log('SELFTEST', JSON.stringify({ ok: !!okPdf && !!found && found.testCount === 3, pdfBytes: pdf.length, tests: found && found.testCount, dir: c.dir }));
    clients.deleteClient(c.id); // clean up
  } catch (err) {
    console.error('SELFTEST_FAIL', err.message);
  } finally {
    app.exit(0);
  }
  /* eslint-enable no-console */
}

async function runAutoRunTest() {
  /* eslint-disable no-console */
  try {
    const c = clients.createClient({ name: `AutoRunTest ${Date.now()}`, company: 'QA' });
    const ar = new AutoRun();
    const progress = [];
    ar.on('progress', (p) => progress.push(`${p.name}:${p.status}`));
    // Skip the slow/network-heavy steps for a fast, deterministic check.
    const res = await ar.run(c.id, { skip: ['speedtest', 'traceroute', 'dns', 'wifi'], runSeconds: 2, pingTarget: '127.0.0.1' });
    const history = clients.getHistory(c.id);
    const pdfOk = res.reportPath && fs.existsSync(res.reportPath) && fs.statSync(res.reportPath).size > 1000;
    console.log('AUTORUN_TEST', JSON.stringify({ ok: !!pdfOk && history.length >= 1, results: res.count, saved: history.length, steps: progress.length, reportPath: res.reportPath }));
    clients.deleteClient(c.id);
  } catch (err) {
    console.error('AUTORUN_TEST_FAIL', err.message);
  } finally {
    app.exit(0);
  }
  /* eslint-enable no-console */
}

async function runSampleReport(outPath) {
  /* eslint-disable no-console */
  try {
    const now = Date.now();
    const day = 86400e3;
    const client = { name: 'Acme Corp', company: 'Acme Corporation', contact: 'Jane Doe', email: 'jane@acme.example', phone: '(555) 010-4477', site: 'HQ — 2nd floor', notes: 'Recurring monthly network health check. Compare WiFi vs wired drops in the conference rooms.' };
    const history = [
      { type: 'speedtest', title: 'Internet Speed Test', timestamp: now - 6 * day, summary: '', data: { downloadMbps: 452.1, uploadMbps: 39.8, ping: 9.1, jitter: 1.6, loss: 0, server: 'speed.cloudflare.com', connection: 'Wi-Fi · HomeNet-5G (-52 dBm)' } },
      { type: 'speedtest', title: 'Internet Speed Test', timestamp: now - 6 * day + 3600e3, summary: '', data: { downloadMbps: 934.5, uploadMbps: 41.2, ping: 6.8, jitter: 0.9, loss: 0, server: 'speed.cloudflare.com', connection: 'Ethernet' } },
      { type: 'speedtest', title: 'Internet Speed Test', timestamp: now - 2 * day, summary: '', data: { downloadMbps: 478.0, uploadMbps: 40.1, ping: 8.7, jitter: 1.2, loss: 0, server: 'speed.cloudflare.com', connection: 'Wi-Fi · HomeNet-5G (-49 dBm)' } },
      { type: 'speedtest', title: 'Internet Speed Test', timestamp: now - 3600e3, summary: '', data: { downloadMbps: 941.2, uploadMbps: 42.0, ping: 6.5, jitter: 0.8, loss: 0, server: 'speed.cloudflare.com', connection: 'Ethernet' } },
      { type: 'lanspeed', title: 'LAN Speed Test', timestamp: now - 2 * day + 1200e3, summary: '', data: { mode: 'download', mbps: 942, bytes: 1.18e9, seconds: 10, host: '192.168.1.20', port: 5201 } },
      { type: 'lanspeed', title: 'LAN Speed Test', timestamp: now - 2 * day + 1500e3, summary: '', data: { mode: 'download', mbps: 289, bytes: 3.6e8, seconds: 10, host: '192.168.1.20', port: 5201 } },
      { type: 'ping', title: 'Ping Monitor', timestamp: now - day, summary: '', data: { target: '8.8.8.8', avg: 12.4, min: 11, max: 33, jitter: 1.8, lossPct: 0, sent: 120, recv: 120 } },
      { type: 'wifi', title: 'WiFi Scan', timestamp: now - day + 600e3, summary: '', data: { current: { ssid: 'HomeNet-5G', band: '5 GHz', channel: 44, signalDbm: -49 }, networks: [{ ssid: 'HomeNet-5G', signalDbm: -49, band: '5 GHz', channel: 44, security: 'WPA2', bssid: 'f0:9f:c2:aa:bb:cc' }, { ssid: 'Neighbor_2.4', signalDbm: -68, band: '2.4 GHz', channel: 11, security: 'WPA2', bssid: '20:e5:2a:11:22:33' }] } },
      { type: 'dns', title: 'DNS Benchmark', timestamp: now - 5400e3, summary: '', data: { resolvers: [{ name: 'Cloudflare', ip: '1.1.1.1', avg: 8.2, min: 6.1, max: 14, lossPct: 0 }, { name: 'Google', ip: '8.8.8.8', avg: 11.4, min: 9, max: 18, lossPct: 0 }, { name: 'System', ip: '192.168.1.1', avg: 13.9, min: 10, max: 22, lossPct: 0 }] } },
      { type: 'traceroute', title: 'Traceroute', timestamp: now - 5000e3, summary: '', data: { target: 'cloudflare.com', hops: [{ hop: 1, host: '', ip: '192.168.1.1', avg: 1, loss: 0 }, { hop: 2, host: 'core1.isp.net', ip: '96.120.10.1', avg: 11.3, loss: 0 }, { hop: 3, host: 'cloudflare.com', ip: '104.16.132.229', avg: 12.3, loss: 0 }] } },
    ];
    const html = report.buildReportHtml(client, history, { generated: now });
    const pdf = await report.renderPdf(html);
    fs.writeFileSync(outPath, pdf);
    console.log('SAMPLE_OK', JSON.stringify({ bytes: pdf.length, path: outPath }));
  } catch (err) {
    console.error('SAMPLE_FAIL', err.message);
  } finally {
    app.exit(0);
  }
  /* eslint-enable no-console */
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
        { label: 'Home', accelerator: 'CmdOrCtrl+H', click: () => send('menu:home') },
        { type: 'separator' },
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
        { label: 'About IP Scanner', click: () => send('menu:about') },
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
    name: 'IP Scanner',
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
      defaultPath: `ip-scanner-scan.${ext}`,
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

  // --- Internet speed test ---
  ipcMain.handle('speed:start', (_e, options) => {
    if (speedTest && speedTest.running) return { ok: false, error: 'Speed test already running' };
    speedTest = new SpeedTest();
    speedTest.on('phase', (p) => send('speed:phase', p));
    speedTest.on('sample', (p) => send('speed:sample', p));
    speedTest.on('latency', (p) => send('speed:latency', p));
    speedTest.on('result', (p) => send('speed:result', p));
    speedTest.on('error', (err) => send('speed:error', { message: err.message }));
    speedTest.run(options || {}).catch((err) => send('speed:error', { message: err.message }));
    return { ok: true };
  });
  ipcMain.handle('speed:cancel', () => {
    if (speedTest) speedTest.cancel();
    return { ok: true };
  });

  // --- WiFi analyzer ---
  ipcMain.handle('wifi:scan', () => wifi.scan());

  // --- Latency monitor ---
  ipcMain.handle('latency:start', (_e, { target, options }) => {
    if (!latencyMonitor) {
      latencyMonitor = new LatencyMonitor();
      latencyMonitor.on('sample', (p) => send('latency:sample', p));
      latencyMonitor.on('stats', (p) => send('latency:stats', p));
    }
    latencyMonitor.start(target, options || {});
    return { ok: true };
  });
  ipcMain.handle('latency:stop', () => {
    if (latencyMonitor) latencyMonitor.stop();
    return { ok: true };
  });

  // --- Traceroute ---
  ipcMain.handle('trace:start', (_e, { target, options }) => {
    if (!tracerouteRunner) {
      tracerouteRunner = new Traceroute();
      tracerouteRunner.on('hop', (h) => send('trace:hop', h));
      tracerouteRunner.on('done', () => send('trace:done', {}));
      tracerouteRunner.on('error', (err) => send('trace:error', { message: err.message }));
    }
    tracerouteRunner.run(target, options || {});
    return { ok: true };
  });
  ipcMain.handle('trace:stop', () => {
    if (tracerouteRunner) tracerouteRunner.stop();
    return { ok: true };
  });

  // --- LAN speed test ---
  ipcMain.handle('lan:serverStart', async (_e, { port }) => {
    if (!lanServer) {
      lanServer = new LanSpeedServer();
      lanServer.on('client', (c) => send('lan:client', c));
      lanServer.on('clientDone', (c) => send('lan:clientDone', c));
    }
    try {
      const info = await lanServer.start(port || undefined);
      return { ok: true, info };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('lan:serverStop', () => {
    if (lanServer) lanServer.stop();
    return { ok: true };
  });
  ipcMain.handle('lan:serverInfo', () => (lanServer ? lanServer.info() : { listening: false }));
  ipcMain.handle('lan:clientRun', async (_e, options) => {
    lanClient = new LanSpeedClient();
    lanClient.on('sample', (s) => send('lan:sample', s));
    try {
      const result = await lanClient.run(options || {});
      send('lan:result', result);
      return { ok: true, result };
    } catch (err) {
      send('lan:error', { message: err.message });
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('lan:clientCancel', () => {
    if (lanClient) lanClient.cancel();
    return { ok: true };
  });

  // --- DNS benchmark ---
  ipcMain.handle('dns:start', (_e, options) => {
    dnsBench = new DnsBenchmark();
    dnsBench.on('resolverDone', (r) => send('dns:resolverDone', r));
    dnsBench.on('result', (r) => send('dns:result', r));
    dnsBench.run(options || {}).catch((err) => send('dns:error', { message: err.message }));
    return { ok: true };
  });
  ipcMain.handle('dns:cancel', () => {
    if (dnsBench) dnsBench.cancel();
    return { ok: true };
  });

  // --- Port scanner (single host) ---
  ipcMain.handle('ports:scan', async (_e, { ip, portList, options }) => {
    const open = await ports.scanPorts(ip, portList && portList.length ? portList : undefined, options || {});
    const { services } = ports.summarizeServices(open);
    return { ip, open, services };
  });
  ipcMain.handle('ports:common', () => ports.COMMON_SERVICES);

  // --- Network info ---
  ipcMain.handle('netinfo:summary', () => netinfo.summary());

  // --- Auto Run All Tools ---
  ipcMain.handle('autorun:start', (_e, { clientId, options }) => {
    if (autoRun && autoRun.running) return { ok: false, error: 'Auto-run already in progress' };
    autoRun = new AutoRun();
    autoRun.on('start', (p) => send('autorun:start', p));
    autoRun.on('progress', (p) => send('autorun:progress', p));
    autoRun.on('done', (p) => {
      send('autorun:done', p);
      if (p.reportPath) shell.openPath(p.reportPath);
    });
    autoRun.run(clientId, options || {}).catch((err) => send('autorun:done', { error: err.message }));
    return { ok: true };
  });
  ipcMain.handle('autorun:cancel', () => {
    if (autoRun) autoRun.cancel();
    return { ok: true };
  });

  // --- Clients ---
  ipcMain.handle('clients:list', () => clients.listClients());
  ipcMain.handle('clients:create', (_e, info) => clients.createClient(info || {}));
  ipcMain.handle('clients:get', (_e, { id }) => clients.getClient(id));
  ipcMain.handle('clients:update', (_e, { id, patch }) => clients.updateClient(id, patch || {}));
  ipcMain.handle('clients:delete', (_e, { id }) => clients.deleteClient(id));
  ipcMain.handle('clients:openFolder', (_e, { id }) => clients.openFolder(id));
  ipcMain.handle('clients:history', (_e, { id }) => clients.getHistory(id));
  ipcMain.handle('clients:saveResult', (_e, { id, record }) => clients.saveResult(id, record));
  ipcMain.handle('clients:deleteResult', (_e, { id, resultId }) => clients.deleteResult(id, resultId));
  ipcMain.handle('clients:clearHistory', (_e, { id }) => clients.clearHistory(id));

  // --- PDF report ---
  ipcMain.handle('report:generate', async (_e, { id, open }) => {
    try {
      const client = clients.getClient(id);
      if (!client) return { ok: false, error: 'Client not found' };
      const history = clients.getHistory(id);
      const html = report.buildReportHtml(client, history, { generated: Date.now() });
      const pdf = await report.renderPdf(html);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = path.join(client.dir, 'reports', `Report-${stamp}.pdf`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, pdf);
      if (open !== false) shell.openPath(file);
      return { ok: true, path: file, count: history.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('report:saveAs', async (_e, { id }) => {
    const client = clients.getClient(id);
    if (!client) return { ok: false, error: 'Client not found' };
    const history = clients.getHistory(id);
    const html = report.buildReportHtml(client, history, { generated: Date.now() });
    const pdf = await report.renderPdf(html);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save report as PDF',
      defaultPath: `${client.name} Network Report.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, pdf);
    shell.openPath(filePath);
    return { ok: true, path: filePath };
  });
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

  app.whenReady().then(async () => {
    store.init(app);

    // Headless self-test: exercise the client store + PDF report generation.
    if (process.env.IPSCANNER_SELFTEST) {
      await runSelfTest();
      return;
    }
    if (process.env.IPSCANNER_SAMPLE_REPORT) {
      await runSampleReport(process.env.IPSCANNER_SAMPLE_REPORT);
      return;
    }
    if (process.env.IPSCANNER_AUTORUN_TEST) {
      await runAutoRunTest();
      return;
    }

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
