'use strict';

/**
 * Preload: exposes a minimal, typed API to the renderer over contextBridge.
 * The renderer has no direct Node access — every privileged action goes through
 * a named IPC channel handled in the main process.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Whitelisted event channels the renderer may subscribe to.
const EVENT_CHANNELS = [
  // scanner
  'scan:start', 'scan:progress', 'scan:phase', 'scan:enrichProgress',
  'scan:host', 'scan:done', 'scan:error',
  // speed test
  'speed:phase', 'speed:sample', 'speed:latency', 'speed:result', 'speed:error',
  // latency monitor
  'latency:sample', 'latency:stats',
  // traceroute
  'trace:hop', 'trace:done', 'trace:error',
  // lan speed
  'lan:client', 'lan:clientDone', 'lan:sample', 'lan:result', 'lan:error',
  // dns
  'dns:resolverDone', 'dns:result', 'dns:error',
  // updates
  'update:state',
  // menu
  'menu:new-scan', 'menu:toggle-scan', 'menu:export', 'menu:settings',
  'menu:check-updates', 'menu:about', 'menu:home',
];

const api = {
  // Environment
  appInfo: () => ipcRenderer.invoke('app:info'),
  interfaces: () => ipcRenderer.invoke('net:interfaces'),
  primaryInterface: () => ipcRenderer.invoke('net:primary'),
  defaultPorts: () => ipcRenderer.invoke('net:defaultPorts'),

  // Scan lifecycle
  startScan: (range, options) => ipcRenderer.invoke('scan:start', { range, options }),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  rescanHost: (ip, options) => ipcRenderer.invoke('scan:rescanHost', { ip, options }),
  listShares: (ip) => ipcRenderer.invoke('scan:shares', { ip }),

  // Remote tools
  ping: (ip, count) => ipcRenderer.invoke('tool:ping', { ip, count }),
  traceroute: (ip) => ipcRenderer.invoke('tool:traceroute', { ip }),
  nslookup: (host) => ipcRenderer.invoke('tool:nslookup', { host }),
  rdp: (ip) => ipcRenderer.invoke('tool:rdp', { ip }),
  ssh: (ip, user) => ipcRenderer.invoke('tool:ssh', { ip, user }),
  telnet: (ip) => ipcRenderer.invoke('tool:telnet', { ip }),
  openShares: (ip) => ipcRenderer.invoke('tool:openShares', { ip }),
  openUrl: (url) => ipcRenderer.invoke('tool:openUrl', { url }),
  shutdown: (ip) => ipcRenderer.invoke('tool:shutdown', { ip }),
  wakeOnLan: (mac, address) => ipcRenderer.invoke('tool:wol', { mac, address }),

  // Internet speed test
  startSpeedTest: (options) => ipcRenderer.invoke('speed:start', options),
  cancelSpeedTest: () => ipcRenderer.invoke('speed:cancel'),

  // WiFi analyzer
  wifiScan: () => ipcRenderer.invoke('wifi:scan'),

  // Latency monitor
  startLatency: (target, options) => ipcRenderer.invoke('latency:start', { target, options }),
  stopLatency: () => ipcRenderer.invoke('latency:stop'),

  // Traceroute (streaming)
  startTrace: (target, options) => ipcRenderer.invoke('trace:start', { target, options }),
  stopTrace: () => ipcRenderer.invoke('trace:stop'),

  // LAN speed test
  lanServerStart: (port) => ipcRenderer.invoke('lan:serverStart', { port }),
  lanServerStop: () => ipcRenderer.invoke('lan:serverStop'),
  lanServerInfo: () => ipcRenderer.invoke('lan:serverInfo'),
  lanClientRun: (options) => ipcRenderer.invoke('lan:clientRun', options),
  lanClientCancel: () => ipcRenderer.invoke('lan:clientCancel'),

  // DNS benchmark
  startDnsBench: (options) => ipcRenderer.invoke('dns:start', options),
  cancelDnsBench: () => ipcRenderer.invoke('dns:cancel'),

  // Port scanner
  scanPortsHost: (ip, portList, options) => ipcRenderer.invoke('ports:scan', { ip, portList, options }),
  commonPorts: () => ipcRenderer.invoke('ports:common'),

  // Network info
  netInfo: () => ipcRenderer.invoke('netinfo:summary'),

  // Favorites & settings
  getSettings: () => ipcRenderer.invoke('store:getSettings'),
  setSettings: (patch) => ipcRenderer.invoke('store:setSettings', patch),
  getFavorites: () => ipcRenderer.invoke('store:getFavorites'),
  addFavorite: (fav) => ipcRenderer.invoke('store:addFavorite', fav),
  removeFavorite: (ip) => ipcRenderer.invoke('store:removeFavorite', { ip }),
  getLastRange: () => ipcRenderer.invoke('store:getLastRange'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', { theme }),

  // Export
  exportSave: (format, hosts, meta) => ipcRenderer.invoke('export:save', { format, hosts, meta }),
  openFile: (filePath) => ipcRenderer.invoke('export:openFile', { filePath }),
  showInFolder: (filePath) => ipcRenderer.invoke('export:showInFolder', { filePath }),

  // Updates
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  installUpdate: () => ipcRenderer.invoke('update:install'),

  // Events
  on: (channel, listener) => {
    if (!EVENT_CHANNELS.includes(channel)) return () => {};
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('ipScanner', api);
