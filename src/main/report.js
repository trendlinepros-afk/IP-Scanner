'use strict';

/**
 * Printable PDF report generator.
 *
 * Builds a styled HTML report from a client's saved test history — grouped by
 * type, each run stamped with the date/time it ran. Key metrics are graded
 * good / warning / problem against sensible thresholds (and, for speed, against
 * the client's expected plan speed), a health-summary block shows the latest
 * status with change-since-last-visit deltas, and everything renders to a real,
 * printable PDF via Electron's built-in printToPDF (no external dependencies).
 */

const os = require('os');
const { BrowserWindow } = require('electron');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]));
}

function fmtDateTime(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (_) { return new Date(ts).toISOString(); }
}

const TYPE_LABELS = {
  speedtest: 'Internet Speed Tests',
  quality: 'Connection Quality (Bufferbloat / VoIP)',
  lanspeed: 'LAN Speed Tests',
  ping: 'Ping / Latency Tests',
  wifi: 'WiFi Scans',
  wifimeter: 'WiFi Signal Meter',
  traceroute: 'Traceroutes',
  dns: 'DNS Benchmarks',
  ports: 'Port Scans',
  scan: 'Network Scans',
  netinfo: 'Network Info',
  test: 'Other Tests',
};
const TYPE_ORDER = ['speedtest', 'quality', 'lanspeed', 'ping', 'wifi', 'wifimeter', 'traceroute', 'dns', 'ports', 'scan', 'netinfo', 'test'];

// ---- thresholds ----------------------------------------------------------
const T = {
  latency: (v) => (v == null ? '' : (v < 30 ? 'good' : (v < 80 ? 'warn' : 'bad'))),
  jitter: (v) => (v == null ? '' : (v < 5 ? 'good' : (v < 30 ? 'warn' : 'bad'))),
  loss: (v) => (v == null ? '' : (v <= 0 ? 'good' : (v < 2 ? 'warn' : 'bad'))),
  dns: (v) => (v == null ? '' : (v < 30 ? 'good' : (v < 80 ? 'warn' : 'bad'))),
  signal: (v) => (v == null ? '' : (v >= -60 ? 'good' : (v >= -75 ? 'warn' : 'bad'))),
  mos: (v) => (v == null ? '' : (v >= 4.0 ? 'good' : (v >= 3.6 ? 'warn' : 'bad'))),
  grade: (rank) => (rank == null ? '' : (rank <= 1 ? 'good' : (rank <= 3 ? 'warn' : 'bad'))),
  speedVsExpected: (actual, expected) => {
    if (actual == null || !expected) return '';
    const pct = actual / expected;
    return pct >= 0.9 ? 'good' : (pct >= 0.6 ? 'warn' : 'bad');
  },
};

function mark(value, cls) { return cls ? `<span class="m ${cls}">${value}</span>` : `${value}`; }

function table(headers, rows) {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<table class="t"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function num(n) { return n == null ? '—' : esc(n); }
function bytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

// ---- per-type renderers --------------------------------------------------
function renderSpeed(runs, ctx) {
  const exDown = ctx.client && ctx.client.expectedDownMbps;
  const exUp = ctx.client && ctx.client.expectedUpMbps;
  const rows = runs.map((r) => {
    const d = r.data || {};
    return [
      fmtDateTime(r.timestamp),
      mark(num(d.downloadMbps), T.speedVsExpected(d.downloadMbps, exDown)),
      mark(num(d.uploadMbps), T.speedVsExpected(d.uploadMbps, exUp)),
      mark(num(d.ping), T.latency(d.ping)),
      mark(num(d.jitter), T.jitter(d.jitter)),
      mark(`${d.loss ?? 0}%`, T.loss(d.loss)),
      esc(d.connection || ''),
    ];
  });
  const exp = (exDown || exUp) ? `<div class="muted">Expected plan: ${exDown ? `${exDown}↓` : ''}${exUp ? ` / ${exUp}↑` : ''} Mbps</div>` : '';
  return exp + table(['Date / Time', 'Download (Mbps)', 'Upload (Mbps)', 'Ping (ms)', 'Jitter (ms)', 'Loss', 'Connection'], rows);
}

function renderQuality(runs) {
  const rows = runs.map((r) => {
    const d = r.data || {};
    return [
      fmtDateTime(r.timestamp),
      mark(esc(d.grade || '—'), T.grade(d.gradeRank)),
      num(d.baselineMs),
      num(d.loadedLatencyMs),
      mark(`+${d.bufferbloatMs ?? '—'}`, T.grade(d.gradeRank)),
      mark(num(d.mos), T.mos(d.mos)),
      esc(d.mosRating || ''),
      num(d.downloadMbps),
      num(d.uploadMbps),
    ];
  });
  return table(['Date / Time', 'Bufferbloat', 'Idle (ms)', 'Loaded (ms)', 'Δ Latency', 'VoIP MOS', 'Call Quality', 'Down (Mbps)', 'Up (Mbps)'], rows);
}

function renderLan(runs) {
  const rows = runs.map((r) => { const d = r.data || {}; return [fmtDateTime(r.timestamp), esc(d.mode || ''), num(d.mbps), bytes(d.bytes), `${d.seconds ?? ''}s`, esc(`${d.host || ''}${d.port ? `:${d.port}` : ''}`)]; });
  return table(['Date / Time', 'Direction', 'Throughput (Mbps)', 'Data', 'Duration', 'Server'], rows);
}

function renderPing(runs) {
  const rows = runs.map((r) => { const d = r.data || {}; return [fmtDateTime(r.timestamp), esc(d.target || ''), mark(num(d.avg), T.latency(d.avg)), num(d.min), num(d.max), mark(num(d.jitter), T.jitter(d.jitter)), mark(`${d.lossPct ?? 0}%`, T.loss(d.lossPct)), `${d.recv ?? 0}/${d.sent ?? 0}`]; });
  return table(['Date / Time', 'Target', 'Avg (ms)', 'Min', 'Max', 'Jitter', 'Loss', 'Recv/Sent'], rows);
}

function renderDns(runs) {
  return runs.map((r) => {
    const rows = (r.data && r.data.resolvers || []).map((x) => [esc(x.name), esc(x.ip), mark(num(x.avg), T.dns(x.avg)), num(x.min), num(x.max), `${x.lossPct ?? 0}%`]);
    return `<div class="run"><div class="run-h">${fmtDateTime(r.timestamp)} — ${esc(r.summary || '')}</div>${table(['Resolver', 'IP', 'Avg (ms)', 'Min', 'Max', 'Loss'], rows)}</div>`;
  }).join('');
}

function renderTrace(runs) {
  return runs.map((r) => {
    const rows = (r.data && r.data.hops || []).map((h) => [h.hop, esc(h.host || ''), esc(h.ip || ''), num(h.avg), `${h.loss ?? 0}%`]);
    return `<div class="run"><div class="run-h">${fmtDateTime(r.timestamp)} — ${esc((r.data && r.data.target) || '')} (${rows.length} hops)</div>${table(['#', 'Host', 'IP', 'Avg (ms)', 'Loss'], rows)}</div>`;
  }).join('');
}

function renderWifi(runs) {
  return runs.map((r) => {
    const nets = (r.data && r.data.networks || []).map((n) => [esc(n.ssid), mark(n.signalDbm != null ? `${n.signalDbm} dBm` : '', T.signal(n.signalDbm)), esc(n.band || ''), n.channel ?? '', esc(n.security || ''), esc(n.bssid || '')]);
    const cur = r.data && r.data.current;
    const curLine = cur ? `<div class="muted">Connected: ${esc(cur.ssid)} · ${esc(cur.band || '')} Ch ${cur.channel ?? '—'} · ${mark(`${cur.signalDbm ?? ''} dBm`, T.signal(cur.signalDbm))}</div>` : '';
    return `<div class="run"><div class="run-h">${fmtDateTime(r.timestamp)} — ${nets.length} networks</div>${curLine}${table(['SSID', 'Signal', 'Band', 'Ch', 'Security', 'BSSID'], nets)}</div>`;
  }).join('');
}

function renderWifiMeter(runs) {
  const rows = runs.map((r) => { const d = r.data || {}; return [fmtDateTime(r.timestamp), esc(d.ssid || ''), mark(num(d.avg), T.signal(d.avg)), num(d.min), num(d.max), esc(d.band || ''), d.channel ?? '', `${d.samples ?? ''} @ ${d.durationSec ?? '?'}s`]; });
  return table(['Date / Time', 'SSID', 'Avg (dBm)', 'Min', 'Max', 'Band', 'Ch', 'Samples'], rows);
}

function renderPorts(runs) {
  const rows = runs.map((r) => { const d = r.data || {}; const open = (d.open || []).map((o) => (typeof o === 'object' ? `${o.port}${o.service ? `/${o.service}` : ''}` : o)).join(', '); return [fmtDateTime(r.timestamp), esc(d.host || ''), esc(open || 'none'), d.scanned ?? '']; });
  return table(['Date / Time', 'Host', 'Open ports', 'Scanned'], rows);
}

function renderScan(runs) {
  return runs.map((r) => {
    const d = r.data || {};
    const rows = (d.hosts || []).map((h) => [esc(h.ip), esc(h.name || ''), esc(h.mac || ''), esc(h.vendor || '')]);
    const summary = `<div class="muted">Range ${esc(d.range || '')} — ${d.alive ?? rows.length} alive of ${d.total ?? ''}</div>`;
    return `<div class="run"><div class="run-h">${fmtDateTime(r.timestamp)}</div>${summary}${rows.length ? table(['IP', 'Name', 'MAC', 'Manufacturer'], rows) : ''}</div>`;
  }).join('');
}

function renderNetinfo(runs) {
  return runs.map((r) => {
    const d = r.data || {}; const p = d.public || {};
    const rows = [['Public IP', esc(p.ip || '')], ['ISP', esc(p.isp || '')], ['Gateway', esc(d.gateway || '')], ['DNS', esc((d.dns || []).join(', '))], ['Hostname', esc(d.hostname || '')]];
    return `<div class="run"><div class="run-h">${fmtDateTime(r.timestamp)}</div>${table(['Field', 'Value'], rows)}</div>`;
  }).join('');
}

const RENDERERS = {
  speedtest: renderSpeed, quality: renderQuality, lanspeed: renderLan, ping: renderPing, dns: renderDns, traceroute: renderTrace, wifi: renderWifi, wifimeter: renderWifiMeter, ports: renderPorts, scan: renderScan, netinfo: renderNetinfo,
};

// ---- health summary ------------------------------------------------------
function delta(latest, prev, lowerIsBetter) {
  if (latest == null || prev == null) return '';
  const diff = Math.round((latest - prev) * 10) / 10;
  if (diff === 0) return '<span class="d-flat">— no change</span>';
  const up = diff > 0;
  const better = lowerIsBetter ? !up : up;
  const arrow = up ? '▲' : '▼';
  return `<span class="d-${better ? 'good' : 'bad'}">${arrow} ${up ? '+' : ''}${diff} vs last</span>`;
}

function buildSummary(byType) {
  const latest = (t) => (byType[t] ? byType[t][byType[t].length - 1] : null);
  const prev = (t) => (byType[t] && byType[t].length > 1 ? byType[t][byType[t].length - 2] : null);
  const rows = [];
  const add = (label, valueHtml, status) => rows.push({ label, valueHtml, status });

  const sp = latest('speedtest'); const spP = prev('speedtest');
  if (sp) {
    const d = sp.data || {}; const dp = (spP && spP.data) || {};
    add('Download', `${num(d.downloadMbps)} Mbps ${delta(d.downloadMbps, dp.downloadMbps, false)}`, T.latency == null ? '' : '');
    rows[rows.length - 1].status = ''; // no threshold without expected; leave neutral
    add('Upload', `${num(d.uploadMbps)} Mbps ${delta(d.uploadMbps, dp.uploadMbps, false)}`, '');
    add('Latency (idle)', `${num(d.ping)} ms ${delta(d.ping, dp.ping, true)}`, T.latency(d.ping));
  }
  const q = latest('quality'); const qP = prev('quality');
  if (q) {
    const d = q.data || {}; const dp = (qP && qP.data) || {};
    add('Bufferbloat', `Grade ${esc(d.grade || '—')} (+${d.bufferbloatMs ?? '—'} ms) ${delta(d.bufferbloatMs, dp.bufferbloatMs, true)}`, T.grade(d.gradeRank));
    add('VoIP MOS', `${num(d.mos)} (${esc(d.mosRating || '')}) ${delta(d.mos, dp.mos, false)}`, T.mos(d.mos));
  }
  const pg = latest('ping');
  if (pg) { const d = pg.data || {}; add(`Ping ${esc(d.target || '')}`, `${num(d.avg)} ms avg · ${d.lossPct ?? 0}% loss`, worse(T.latency(d.avg), T.loss(d.lossPct))); }
  const wf = latest('wifi') || latest('wifimeter');
  if (wf) { const d = wf.data || {}; const cur = d.current || d; const sig = cur.signalDbm != null ? cur.signalDbm : d.avg; if (sig != null) add('WiFi signal', `${sig} dBm${cur.ssid ? ` (${esc(cur.ssid)})` : ''}`, T.signal(sig)); }
  const dn = latest('dns');
  if (dn) { const best = (dn.data && dn.data.resolvers || []).filter((x) => x.avg != null).sort((a, b) => a.avg - b.avg)[0]; if (best) add('Fastest DNS', `${esc(best.name)} ${best.avg} ms`, T.dns(best.avg)); }

  const counts = { good: 0, warn: 0, bad: 0 };
  rows.forEach((r) => { if (r.status && counts[r.status] != null) counts[r.status] += 1; });
  const overall = counts.bad ? { cls: 'bad', text: 'Attention needed' } : (counts.warn ? { cls: 'warn', text: 'Minor issues' } : { cls: 'good', text: 'Healthy' });

  if (!rows.length) return '';
  const cells = rows.map((r) => `<div class="sm-item"><span class="dot ${r.status || 'none'}"></span><span class="sm-label">${esc(r.label)}</span><span class="sm-val">${r.valueHtml}</span></div>`).join('');
  return `<div class="summary">
    <div class="sm-head"><span class="sm-title">Health summary</span><span class="badge-status ${overall.cls}">${overall.text}</span>
      <span class="sm-counts">${counts.good} OK · ${counts.warn} warning${counts.warn === 1 ? '' : 's'} · ${counts.bad} problem${counts.bad === 1 ? '' : 's'}</span></div>
    <div class="sm-grid">${cells}</div>
  </div>`;
}

function worse(a, b) {
  const rank = { '': 0, good: 1, warn: 2, bad: 3 };
  return (rank[a] || 0) >= (rank[b] || 0) ? a : b;
}

function buildReportHtml(client, history, meta = {}) {
  const byType = {};
  for (const r of history) { (byType[r.type] = byType[r.type] || []).push(r); }
  const times = history.map((r) => r.timestamp).filter(Boolean);
  const range = times.length ? `${fmtDateTime(Math.min(...times))} – ${fmtDateTime(Math.max(...times))}` : '—';
  const counts = TYPE_ORDER.filter((t) => byType[t]).map((t) => `<span class="chip">${esc(TYPE_LABELS[t])}: ${byType[t].length}</span>`).join(' ');

  let sections = '';
  for (const type of TYPE_ORDER) {
    const runs = byType[type];
    if (!runs || !runs.length) continue;
    const renderer = RENDERERS[type];
    sections += `<section class="sec"><h2>${esc(TYPE_LABELS[type] || type)} <span class="count">(${runs.length})</span></h2>${renderer ? renderer(runs, { client }) : ''}</section>`;
  }
  if (!history.length) sections = '<p class="muted">No tests have been recorded for this client yet.</p>';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Report — ${esc(client.name)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Roboto, Arial, sans-serif; color: #1f2430; font-size: 11px; margin: 0; }
  .cover { border-bottom: 3px solid #2f7de1; padding-bottom: 14px; margin-bottom: 16px; display: flex; align-items: flex-start; justify-content: space-between; }
  .brand { font-size: 22px; font-weight: 700; color: #2f7de1; }
  .brand small { display:block; font-size: 11px; color:#8b94a4; font-weight: 500; }
  h1 { font-size: 18px; margin: 2px 0 4px; }
  .meta { text-align: right; font-size: 11px; color: #5a6474; }
  .client-box { background: #f3f5f9; border: 1px solid #dde1e8; border-radius: 8px; padding: 10px 14px; margin-bottom: 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 2px 20px; }
  .client-box b { color: #5a6474; font-weight: 600; }
  .chips { margin: 8px 0 16px; }
  .chip { display: inline-block; background: #eaf1fb; color: #2f7de1; border-radius: 20px; padding: 2px 10px; font-size: 10px; margin: 0 4px 4px 0; }
  .sec { margin-bottom: 18px; page-break-inside: avoid; }
  h2 { font-size: 13px; border-bottom: 1px solid #dde1e8; padding-bottom: 4px; margin: 0 0 8px; }
  h2 .count { color: #8b94a4; font-weight: 400; font-size: 11px; }
  table.t { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
  table.t th, table.t td { border: 1px solid #dde1e8; padding: 4px 7px; text-align: left; word-break: break-word; }
  table.t th { background: #f3f5f9; font-size: 10px; color: #5a6474; }
  .run { margin-bottom: 10px; page-break-inside: avoid; }
  .run-h { font-weight: 600; margin: 6px 0 4px; }
  .muted { color: #8b94a4; }
  .m.good { color: #1a8f3c; font-weight: 600; }
  .m.warn { color: #b5720b; font-weight: 600; }
  .m.bad { color: #c0392b; font-weight: 600; }
  .summary { border: 1px solid #dde1e8; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; page-break-inside: avoid; }
  .sm-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .sm-title { font-weight: 700; font-size: 13px; }
  .sm-counts { color: #8b94a4; margin-left: auto; }
  .badge-status { padding: 2px 10px; border-radius: 20px; font-size: 10px; font-weight: 700; color: #fff; }
  .badge-status.good { background: #1a8f3c; } .badge-status.warn { background: #b5720b; } .badge-status.bad { background: #c0392b; }
  .sm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 20px; }
  .sm-item { display: flex; align-items: center; gap: 7px; }
  .sm-label { color: #5a6474; min-width: 120px; }
  .sm-val { font-weight: 600; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: 0 0 auto; }
  .dot.good { background: #1a8f3c; } .dot.warn { background: #b5720b; } .dot.bad { background: #c0392b; } .dot.none { background: #c3cad6; }
  .d-good { color: #1a8f3c; font-weight: 400; font-size: 10px; }
  .d-bad { color: #c0392b; font-weight: 400; font-size: 10px; }
  .d-flat { color: #8b94a4; font-weight: 400; font-size: 10px; }
  .footer { margin-top: 20px; border-top: 1px solid #dde1e8; padding-top: 8px; font-size: 10px; color: #8b94a4; display:flex; justify-content: space-between; }
</style></head><body>
  <div class="cover">
    <div>
      <div class="brand">IP Scanner <small>Network Toolkit</small></div>
      <h1>Network Diagnostics Report</h1>
    </div>
    <div class="meta">
      Generated<br><strong>${esc(fmtDateTime(meta.generated || Date.now()))}</strong><br>
      Machine: ${esc(os.hostname())}<br>${esc(process.platform)}
    </div>
  </div>
  <div class="client-box">
    <div><b>Client:</b> ${esc(client.name || '')}</div>
    <div><b>Company:</b> ${esc(client.company || '—')}</div>
    <div><b>Contact:</b> ${esc(client.contact || '—')}</div>
    <div><b>Email:</b> ${esc(client.email || '—')}</div>
    <div><b>Phone:</b> ${esc(client.phone || '—')}</div>
    <div><b>Site:</b> ${esc(client.site || '—')}</div>
    <div><b>Total tests:</b> ${history.length}</div>
    <div><b>Date range:</b> ${esc(range)}</div>
    ${(client.expectedDownMbps || client.expectedUpMbps) ? `<div><b>Expected plan:</b> ${client.expectedDownMbps ? `${esc(client.expectedDownMbps)}↓` : ''}${client.expectedUpMbps ? ` / ${esc(client.expectedUpMbps)}↑` : ''} Mbps</div>` : ''}
    ${client.notes ? `<div style="grid-column:1/3"><b>Notes:</b> ${esc(client.notes)}</div>` : ''}
  </div>
  ${buildSummary(byType)}
  <div class="chips">${counts || '<span class="muted">No tests recorded.</span>'}</div>
  ${sections}
  <div class="footer"><span>IP Scanner — Network Toolkit</span><span>Report for ${esc(client.name || '')}</span></div>
</body></html>`;
}

/** Render the report HTML to a PDF Buffer. */
async function renderPdf(html) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    return pdf;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { buildReportHtml, renderPdf };
