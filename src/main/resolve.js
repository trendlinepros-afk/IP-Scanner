'use strict';

/**
 * Resolve a friendly host name for an IP address.
 *  1. Reverse DNS (PTR) lookup.
 *  2. NetBIOS name via `nbtstat -A` (Windows only) as a fallback / enrichment.
 */

const dns = require('dns');
const { exec } = require('child_process');

const isWin = process.platform === 'win32';

function reverseDns(ip, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, timeoutMs);
    dns.reverse(ip, (err, hostnames) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err || !hostnames || hostnames.length === 0) return resolve(null);
      resolve(hostnames[0]);
    });
  });
}

function netbiosName(ip, timeoutMs = 2000) {
  if (!isWin) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = exec(`nbtstat -A ${ip}`, { windowsHide: true, timeout: timeoutMs }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      // Look for the <00> UNIQUE registered name (the computer name).
      const lines = stdout.split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^\s*([^\s]+)\s+<00>\s+UNIQUE\s+Registered/i);
        if (m && m[1] && m[1] !== '__MSBROWSE__') return resolve(m[1].trim());
      }
      resolve(null);
    });
    child.on('error', () => resolve(null));
  });
}

/**
 * Best-effort host name. Prefers DNS; falls back to NetBIOS on Windows.
 */
async function resolveName(ip) {
  const dnsName = await reverseDns(ip);
  if (dnsName) return dnsName;
  const nb = await netbiosName(ip);
  return nb || '';
}

module.exports = { resolveName, reverseDns, netbiosName };
