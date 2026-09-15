'use strict';

/**
 * Network information: local adapters, default gateway, DNS servers and the
 * public IP / ISP as seen from the internet.
 */

const os = require('os');
const dns = require('dns');
const https = require('https');
const { exec } = require('child_process');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function run(cmd, timeout = 5000) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (_e, stdout) => resolve(stdout || ''));
  });
}

/** List local IPv4/IPv6 interfaces with basic details. */
function adapters() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.internal) continue;
      out.push({
        name,
        family: a.family,
        address: a.address,
        netmask: a.netmask,
        mac: a.mac,
        cidr: a.cidr,
      });
    }
  }
  return out;
}

/** Best-effort default gateway (IPv4). */
async function defaultGateway() {
  try {
    if (isWin) {
      const out = await run('powershell -NoProfile "(Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Sort-Object RouteMetric | Select-Object -First 1).NextHop"');
      const m = out.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
      if (m) return m[1];
      const ipc = await run('ipconfig');
      const g = ipc.match(/Default Gateway[ .]*:\s*(\d{1,3}(?:\.\d{1,3}){3})/i);
      return g ? g[1] : '';
    }
    if (isMac) {
      const out = await run('route -n get default');
      const m = out.match(/gateway:\s*(\d{1,3}(?:\.\d{1,3}){3})/i);
      return m ? m[1] : '';
    }
    // Linux
    const out = await run('ip route show default');
    const m = out.match(/default via (\d{1,3}(?:\.\d{1,3}){3})/);
    return m ? m[1] : '';
  } catch (_) {
    return '';
  }
}

/** Configured DNS servers. */
function dnsServers() {
  try {
    return dns.getServers();
  } catch (_) {
    return [];
  }
}

/** Fetch JSON over HTTPS with a timeout. Resolves null on any failure. */
function fetchJson(url, timeout = 6000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const req = https.get(url, { timeout, headers: { 'User-Agent': 'IP-Scanner/1.0' } }, (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
          if (data.length > 1e6) req.destroy();
        });
        res.on('end', () => {
          try {
            finish(JSON.parse(data));
          } catch (_) {
            finish(null);
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        finish(null);
      });
      req.on('error', () => finish(null));
    } catch (_) {
      finish(null);
    }
  });
}

/** Public IP + ISP/geo, using ipwho.is with an ipify fallback. */
async function publicInfo() {
  const who = await fetchJson('https://ipwho.is/');
  if (who && who.success !== false && who.ip) {
    return {
      ip: who.ip,
      isp: (who.connection && who.connection.isp) || who.org || '',
      org: (who.connection && who.connection.org) || '',
      city: who.city || '',
      region: who.region || '',
      country: who.country || '',
      countryCode: who.country_code || '',
      lat: who.latitude,
      lon: who.longitude,
      timezone: (who.timezone && who.timezone.id) || '',
    };
  }
  const ipify = await fetchJson('https://api.ipify.org?format=json');
  if (ipify && ipify.ip) return { ip: ipify.ip, isp: '', org: '', city: '', country: '' };
  return { ip: '', isp: '', org: '', city: '', country: '' };
}

/** Aggregate everything for the Network Info view. */
async function summary() {
  const [gateway, pub] = await Promise.all([defaultGateway(), publicInfo()]);
  return {
    hostname: os.hostname(),
    platform: process.platform,
    adapters: adapters(),
    gateway,
    dns: dnsServers(),
    public: pub,
    uptimeSec: os.uptime(),
  };
}

module.exports = { adapters, defaultGateway, dnsServers, publicInfo, summary };
