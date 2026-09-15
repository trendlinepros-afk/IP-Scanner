'use strict';

/**
 * Printable PDF report generator.
 *
 * Builds a styled HTML report from a client's saved test history — every test
 * grouped by type, each run stamped with the date/time it ran, speed tests and
 * the rest laid out in clean tables — then renders it to a real, printable PDF
 * with Electron's built-in printToPDF (no external dependencies).
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
  lanspeed: 'LAN Speed Tests',
  ping: 'Ping / Latency Tests',
  traceroute: 'Traceroutes',
  wifi: 'WiFi Scans',
  dns: 'DNS Benchmarks',
  ports: 'Port Scans',
  scan: 'Network Scans',
  test: 'Other Tests',
};
const TYPE_ORDER = ['speedtest', 'lanspeed', 'ping', 'wifi', 'traceroute', 'dns', 'ports', 'scan', 'test'];

function table(headers, rows) {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<table class="t"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ---- per-type renderers --------------------------------------------------
function renderSpeed(runs) {
  const rows = runs.map((r) => {
    const d = r.data || {};
    return [fmtDateTime(r.timestamp), num(d.downloadMbps), num(d.uploadMbps), num(d.ping), num(d.jitter), `${d.loss ?? 0}%`, esc(d.connection || ''), esc(d.server || '')];
  });
  return table(['Date / Time', 'Download (Mbps)', 'Upload (Mbps)', 'Ping (ms)', 'Jitter (ms)', 'Loss', 'Connection', 'Server'], rows);
}

function renderLan(runs) {
  const rows = runs.map((r) => { const d = r.data || {}; return [fmtDateTime(r.timestamp), esc(d.mode || ''), num(d.mbps), bytes(d.bytes), `${d.seconds ?? ''}s`, esc(`${d.host || ''}${d.port ? `:${d.port}` : ''}`)]; });
  return table(['Date / Time', 'Direction', 'Throughput (Mbps)', 'Data', 'Duration', 'Server'], rows);
}

function renderPing(runs) {
  const rows = runs.map((r) => { const d = r.data || {}; return [fmtDateTime(r.timestamp), esc(d.target || ''), num(d.avg), num(d.min), num(d.max), num(d.jitter), `${d.lossPct ?? 0}%`, `${d.recv ?? 0}/${d.sent ?? 0}`]; });
  return table(['Date / Time', 'Target', 'Avg (ms)', 'Min', 'Max', 'Jitter', 'Loss', 'Recv/Sent'], rows);
}

function renderDns(runs) {
  return runs.map((r) => {
    const rows = (r.data && r.data.resolvers || []).map((x) => [esc(x.name), esc(x.ip), num(x.avg), num(x.min), num(x.max), `${x.lossPct ?? 0}%`]);
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
    const nets = (r.data && r.data.networks || []).map((n) => [esc(n.ssid), n.signalDbm != null ? `${n.signalDbm} dBm` : '', esc(n.band || ''), n.channel ?? '', esc(n.security || ''), esc(n.bssid || '')]);
    const cur = r.data && r.data.current;
    const curLine = cur ? `<div class="muted">Connected: ${esc(cur.ssid)} · ${esc(cur.band || '')} Ch ${cur.channel ?? '—'} · ${cur.signalDbm ?? ''} dBm</div>` : '';
    return `<div class="run"><div class="run-h">${fmtDateTime(r.timestamp)} — ${nets.length} networks</div>${curLine}${table(['SSID', 'Signal', 'Band', 'Ch', 'Security', 'BSSID'], nets)}</div>`;
  }).join('');
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

const RENDERERS = { speedtest: renderSpeed, lanspeed: renderLan, ping: renderPing, dns: renderDns, traceroute: renderTrace, wifi: renderWifi, ports: renderPorts, scan: renderScan };

function num(n) { return n == null ? '—' : esc(n); }
function bytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
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
    sections += `<section class="sec"><h2>${esc(TYPE_LABELS[type] || type)} <span class="count">(${runs.length})</span></h2>${renderer ? renderer(runs) : ''}</section>`;
  }
  if (!history.length) sections = '<p class="muted">No tests have been recorded for this client yet.</p>';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Report — ${esc(client.name)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Roboto, Arial, sans-serif; color: #1f2430; font-size: 11px; margin: 0; }
  .cover { border-bottom: 3px solid #2f7de1; padding-bottom: 14px; margin-bottom: 18px; display: flex; align-items: flex-start; justify-content: space-between; }
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
    ${client.notes ? `<div style="grid-column:1/3"><b>Notes:</b> ${esc(client.notes)}</div>` : ''}
  </div>
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
