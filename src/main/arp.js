'use strict';

/**
 * Read the system ARP cache to map IPv4 addresses to MAC addresses.
 * The cache is populated as a side effect of pinging hosts, so this is called
 * after the discovery sweep.  Cross-platform parsing for Windows/macOS/Linux.
 */

const { exec } = require('child_process');

const isWin = process.platform === 'win32';

function run(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(stdout || '');
    });
  });
}

/** Normalise a MAC to aa:bb:cc:dd:ee:ff (lowercase), or null if invalid. */
function normalize(mac) {
  if (!mac) return null;
  const hex = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 12) return null;
  if (hex === '000000000000' || hex === 'ffffffffffff') return null;
  return hex.match(/.{2}/g).join(':');
}

/**
 * Return a Map<ip, mac> from the full ARP table.
 */
async function readArpTable() {
  const map = new Map();
  const out = await run(isWin ? 'arp -a' : 'arp -a -n');

  if (isWin) {
    // Windows:  192.168.1.1    00-11-22-33-44-55   dynamic
    const re = /(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F]{2}(?:-[0-9a-fA-F]{2}){5})/g;
    let m;
    while ((m = re.exec(out)) !== null) {
      const mac = normalize(m[2]);
      if (mac) map.set(m[1], mac);
    }
  } else {
    // BSD/macOS: host (192.168.1.1) at 0:11:22:33:44:55 on en0
    // Linux:     192.168.1.1 ether 00:11:22:33:44:55 C eth0
    const reParen = /\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([0-9a-fA-F:]+)/g;
    let m;
    while ((m = reParen.exec(out)) !== null) {
      const mac = normalize(m[2]);
      if (mac) map.set(m[1], mac);
    }
    const reLinux = /(\d{1,3}(?:\.\d{1,3}){3})\s+(?:ether\s+)?([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/g;
    while ((m = reLinux.exec(out)) !== null) {
      const mac = normalize(m[2]);
      if (mac && !map.has(m[1])) map.set(m[1], mac);
    }
  }

  // Linux `ip neigh` is more reliable when available.
  if (!isWin) {
    const neigh = await run('ip neigh show 2>/dev/null');
    const re = /(\d{1,3}(?:\.\d{1,3}){3})\s+.*?lladdr\s+([0-9a-fA-F:]+)/g;
    let m;
    while ((m = re.exec(neigh)) !== null) {
      const mac = normalize(m[2]);
      if (mac) map.set(m[1], mac);
    }
  }

  return map;
}

/** Look up a single IP's MAC from the ARP cache. */
async function lookupMac(ip) {
  const table = await readArpTable();
  return table.get(ip) || null;
}

module.exports = { readArpTable, lookupMac, normalize };
