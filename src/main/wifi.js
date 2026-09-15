'use strict';

/**
 * WiFi analyzer. Scans nearby access points and reports the current link, in
 * the spirit of inSSIDer / NetSpot / WiFi Explorer:
 *   - SSID, BSSID, signal (dBm + quality %), channel, band, security, PHY
 *   - current connection: SSID/BSSID, signal, tx/rx rate, channel, band
 *   - channel congestion counts and a best-2.4GHz-channel recommendation
 *
 * Cross-platform via the OS's native tooling:
 *   Windows : netsh wlan show networks mode=bssid / show interfaces
 *   macOS   : airport -s / airport -I
 *   Linux   : nmcli dev wifi / iw
 * Degrades gracefully (supported:false) when no WiFi tooling/adapter exists.
 */

const { exec } = require('child_process');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const AIRPORT = '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport';

function run(cmd, timeout = 8000) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve({ err, out: stdout || '' });
    });
  });
}

// ---- helpers -------------------------------------------------------------
function bandForChannel(channel, freqMhz) {
  if (freqMhz) {
    if (freqMhz >= 5925) return '6 GHz';
    if (freqMhz >= 4900) return '5 GHz';
    return '2.4 GHz';
  }
  if (!channel) return '';
  if (channel >= 1 && channel <= 14) return '2.4 GHz';
  return '5 GHz';
}

function pctToDbm(pct) {
  // Windows reports signal quality %, approximate dBm.
  return Math.round(pct / 2 - 100);
}

function dbmToQuality(dbm) {
  if (dbm == null) return null;
  return Math.max(0, Math.min(100, Math.round(2 * (dbm + 100))));
}

// ---- Windows -------------------------------------------------------------
function parseWindowsNetworks(out) {
  const nets = [];
  const blocks = out.split(/\r?\n\r?\n(?=SSID \d+\s*:)/);
  for (const block of blocks) {
    const ssidM = block.match(/^SSID \d+\s*:\s*(.*)$/m);
    if (!ssidM) continue;
    const ssid = ssidM[1].trim();
    const auth = (block.match(/Authentication\s*:\s*(.*)$/m) || [])[1] || '';
    const enc = (block.match(/Encryption\s*:\s*(.*)$/m) || [])[1] || '';
    const bssidRe = /BSSID \d+\s*:\s*([0-9a-fA-F:]{17})[\s\S]*?Signal\s*:\s*(\d+)%[\s\S]*?Radio type\s*:\s*([^\r\n]*)[\s\S]*?(?:Band\s*:\s*([^\r\n]*)[\s\S]*?)?Channel\s*:\s*(\d+)/g;
    let m;
    while ((m = bssidRe.exec(block)) !== null) {
      const pct = parseInt(m[2], 10);
      const channel = parseInt(m[5], 10);
      nets.push({
        ssid: ssid || '(hidden)',
        bssid: m[1].toLowerCase(),
        signalPct: pct,
        signalDbm: pctToDbm(pct),
        phy: (m[3] || '').trim(),
        band: (m[4] || '').trim() || bandForChannel(channel),
        channel,
        security: (auth + (enc && enc !== 'None' ? ` / ${enc}` : '')).trim(),
      });
    }
  }
  return nets;
}

function parseWindowsInterface(out) {
  const g = (re) => (out.match(re) || [])[1];
  const ssid = g(/^\s*SSID\s*:\s*(.*)$/m);
  if (!ssid) return null;
  const pct = parseInt(g(/^\s*Signal\s*:\s*(\d+)%/m) || '', 10);
  const channel = parseInt(g(/^\s*Channel\s*:\s*(\d+)/m) || '', 10);
  return {
    ssid: ssid.trim(),
    bssid: (g(/^\s*BSSID\s*:\s*([0-9a-fA-F:]{17})/m) || '').toLowerCase(),
    signalPct: Number.isNaN(pct) ? null : pct,
    signalDbm: Number.isNaN(pct) ? null : pctToDbm(pct),
    phy: (g(/^\s*Radio type\s*:\s*(.*)$/m) || '').trim(),
    channel: Number.isNaN(channel) ? null : channel,
    band: bandForChannel(channel),
    rxMbps: parseFloat(g(/^\s*Receive rate \(Mbps\)\s*:\s*([\d.]+)/m) || '') || null,
    txMbps: parseFloat(g(/^\s*Transmit rate \(Mbps\)\s*:\s*([\d.]+)/m) || '') || null,
  };
}

async function scanWindows() {
  const [nets, iface] = await Promise.all([
    run('netsh wlan show networks mode=bssid'),
    run('netsh wlan show interfaces'),
  ]);
  return {
    networks: parseWindowsNetworks(nets.out),
    current: parseWindowsInterface(iface.out),
  };
}

// ---- macOS ---------------------------------------------------------------
function parseAirportScan(out) {
  const nets = [];
  const lines = out.split(/\r?\n/).slice(1); // skip header
  for (const line of lines) {
    // SSID may contain spaces; columns are fixed-width-ish. Use a regex from the end.
    const m = line.match(/^(.*?)\s+([0-9a-fA-F:]{17})\s+(-?\d+)\s+([\d,+\-]+)\s+\S+\s+\S+\s+(.*)$/);
    if (!m) continue;
    const dbm = parseInt(m[3], 10);
    const channel = parseInt(m[4], 10);
    nets.push({
      ssid: m[1].trim() || '(hidden)',
      bssid: m[2].toLowerCase(),
      signalDbm: dbm,
      signalPct: dbmToQuality(dbm),
      channel,
      band: bandForChannel(channel),
      phy: '',
      security: m[5].trim(),
    });
  }
  return nets;
}

function parseAirportInfo(out) {
  const g = (re) => (out.match(re) || [])[1];
  const ssid = g(/^\s*SSID:\s*(.*)$/m);
  if (!ssid) return null;
  const dbm = parseInt(g(/agrCtlRSSI:\s*(-?\d+)/) || '', 10);
  const channel = parseInt(g(/channel:\s*(\d+)/) || '', 10);
  return {
    ssid: ssid.trim(),
    bssid: (g(/BSSID:\s*([0-9a-fA-F:]+)/) || '').toLowerCase(),
    signalDbm: Number.isNaN(dbm) ? null : dbm,
    signalPct: Number.isNaN(dbm) ? null : dbmToQuality(dbm),
    channel: Number.isNaN(channel) ? null : channel,
    band: bandForChannel(channel),
    txMbps: parseFloat(g(/lastTxRate:\s*([\d.]+)/) || '') || null,
    rxMbps: null,
  };
}

async function scanMac() {
  const [scan, info] = await Promise.all([run(`${AIRPORT} -s`), run(`${AIRPORT} -I`)]);
  return { networks: parseAirportScan(scan.out), current: parseAirportInfo(info.out) };
}

// ---- Linux ---------------------------------------------------------------
function nmcliUnescape(s) {
  return s.replace(/\\:/g, ':').replace(/\\\\/g, '\\');
}

function splitNmcli(line) {
  // Split on unescaped ':'
  const fields = [];
  let cur = '';
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\' && i + 1 < line.length) { cur += line[i] + line[i + 1]; i += 1; } else if (line[i] === ':') { fields.push(cur); cur = ''; } else cur += line[i];
  }
  fields.push(cur);
  return fields.map(nmcliUnescape);
}

function parseNmcli(out) {
  const nets = [];
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = splitNmcli(line);
    // Fields: ACTIVE,SSID,BSSID,SIGNAL,CHAN,FREQ,SECURITY
    const [active, ssid, bssid, signal, chan, freq, security] = f;
    const sigPct = parseInt(signal, 10);
    const channel = parseInt(chan, 10);
    const freqMhz = parseInt(freq, 10);
    const net = {
      ssid: ssid || '(hidden)',
      bssid: (bssid || '').toLowerCase(),
      signalPct: Number.isNaN(sigPct) ? null : sigPct,
      signalDbm: Number.isNaN(sigPct) ? null : pctToDbm(sigPct),
      channel: Number.isNaN(channel) ? null : channel,
      band: bandForChannel(channel, freqMhz),
      security: security || 'Open',
      phy: '',
    };
    nets.push(net);
    if (active === 'yes') current = { ...net, txMbps: null, rxMbps: null };
  }
  return { networks: nets, current };
}

async function scanLinux() {
  await run('nmcli dev wifi rescan', 6000).catch(() => {});
  const res = await run('nmcli -t -f ACTIVE,SSID,BSSID,SIGNAL,CHAN,FREQ,SECURITY dev wifi');
  if (!res.out.trim()) return { networks: [], current: null };
  return parseNmcli(res.out);
}

// ---- public --------------------------------------------------------------
function analyze(networks) {
  const byChannel = {};
  const byBand = { '2.4 GHz': 0, '5 GHz': 0, '6 GHz': 0 };
  for (const n of networks) {
    if (n.channel != null) byChannel[n.channel] = (byChannel[n.channel] || 0) + 1;
    if (byBand[n.band] != null) byBand[n.band] += 1;
  }
  // Best 2.4GHz channel among the non-overlapping 1/6/11.
  const count24 = (ch) => networks.filter((n) => n.band === '2.4 GHz' && Math.abs((n.channel || 0) - ch) <= 2).length;
  const best24 = [1, 6, 11].sort((a, b) => count24(a) - count24(b))[0];
  return { byChannel, byBand, recommended24: best24 };
}

async function scan() {
  try {
    let data;
    if (isWin) data = await scanWindows();
    else if (isMac) data = await scanMac();
    else data = await scanLinux();

    const networks = (data.networks || []).sort((a, b) => (b.signalDbm || -999) - (a.signalDbm || -999));
    const supported = networks.length > 0 || !!data.current;
    return {
      supported,
      networks,
      current: data.current || null,
      analysis: analyze(networks),
      platform: process.platform,
    };
  } catch (err) {
    return { supported: false, networks: [], current: null, error: err.message, platform: process.platform };
  }
}

module.exports = { scan, bandForChannel, dbmToQuality };
