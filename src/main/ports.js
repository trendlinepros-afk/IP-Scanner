'use strict';

/**
 * TCP port scanning and higher-level "service"/share detection.
 *
 * Advanced IP Scanner surfaces shared resources (HTTP, HTTPS, FTP and Windows
 * file shares).  We detect the open service ports here and, on Windows, can
 * enumerate SMB shares with `net view`.
 */

const net = require('net');
const { exec } = require('child_process');

const isWin = process.platform === 'win32';

/** Well-known ports we understand, with a friendly label. */
const COMMON_SERVICES = {
  20: 'FTP-Data',
  21: 'FTP',
  22: 'SSH',
  23: 'Telnet',
  25: 'SMTP',
  53: 'DNS',
  80: 'HTTP',
  110: 'POP3',
  135: 'MS-RPC',
  139: 'NetBIOS',
  143: 'IMAP',
  443: 'HTTPS',
  445: 'SMB',
  515: 'Printer',
  548: 'AFP',
  554: 'RTSP',
  631: 'IPP',
  993: 'IMAPS',
  995: 'POP3S',
  1433: 'MSSQL',
  1521: 'Oracle',
  3306: 'MySQL',
  3389: 'RDP',
  5432: 'PostgreSQL',
  5900: 'VNC',
  5985: 'WinRM',
  8080: 'HTTP-Alt',
  8443: 'HTTPS-Alt',
  9100: 'JetDirect',
};

/** The default port set used to derive the "Shared resources" column. */
const DEFAULT_PORTS = [21, 22, 80, 135, 139, 443, 445, 3389, 5900, 8080];

/** Check whether a single TCP port is open. Resolves boolean, never rejects. */
function checkPort(ip, port, timeoutMs = 900) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try {
      socket.connect(port, ip);
    } catch (_) {
      done(false);
    }
  });
}

/**
 * Scan a list of ports on a host with limited internal concurrency.
 * Returns an array of open port numbers.
 */
async function scanPorts(ip, ports = DEFAULT_PORTS, opts = {}) {
  const timeoutMs = opts.timeoutMs || 900;
  const concurrency = opts.concurrency || 24;
  const open = [];
  let idx = 0;

  async function worker() {
    while (idx < ports.length) {
      const port = ports[idx++];
      // eslint-disable-next-line no-await-in-loop
      if (await checkPort(ip, port, timeoutMs)) open.push(port);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, ports.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  open.sort((a, b) => a - b);
  return open;
}

/** Map open ports to a friendly "shares/services" summary. */
function summarizeServices(openPorts) {
  const shares = [];
  const services = [];
  for (const p of openPorts) {
    const label = COMMON_SERVICES[p] || `TCP/${p}`;
    services.push({ port: p, label });
    if (p === 80 || p === 8080) shares.push({ type: 'http', label: 'HTTP', url: null });
    if (p === 443 || p === 8443) shares.push({ type: 'https', label: 'HTTPS', url: null });
    if (p === 21) shares.push({ type: 'ftp', label: 'FTP', url: null });
    if (p === 445 || p === 139) shares.push({ type: 'smb', label: 'File shares', url: null });
  }
  return { shares, services };
}

/**
 * Enumerate SMB shares for a host (Windows only, best effort).
 * Returns an array of share names, e.g. ["Users", "Public"].
 */
function listSmbShares(ip, timeoutMs = 4000) {
  if (!isWin) return Promise.resolve([]);
  return new Promise((resolve) => {
    exec(`net view \\\\${ip} /all`, { windowsHide: true, timeout: timeoutMs }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const shares = [];
      for (const line of stdout.split(/\r?\n/)) {
        // "ShareName   Disk   Comment"
        const m = line.match(/^(\S+)\s+Disk/i);
        if (m && !m[1].startsWith('---')) shares.push(m[1]);
      }
      resolve(shares);
    });
  });
}

module.exports = {
  COMMON_SERVICES,
  DEFAULT_PORTS,
  checkPort,
  scanPorts,
  summarizeServices,
  listSmbShares,
};
