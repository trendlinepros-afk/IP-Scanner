'use strict';

/**
 * Export scan results to CSV, HTML, XML or JSON — the same formats Advanced IP
 * Scanner supports, plus JSON for programmatic re-import.
 */

const COLUMNS = [
  ['status', 'Status'],
  ['name', 'Name'],
  ['ip', 'IP'],
  ['mac', 'MAC address'],
  ['vendor', 'Manufacturer'],
  ['responseMs', 'Response (ms)'],
  ['sharesText', 'Shared resources'],
  ['portsText', 'Open ports'],
];

function decorate(host) {
  return {
    ...host,
    sharesText: (host.shares || []).map((s) => s.label).join(', '),
    portsText: (host.ports || []).join(', '),
  };
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(hosts) {
  const rows = [COLUMNS.map(([, label]) => csvEscape(label)).join(',')];
  for (const raw of hosts) {
    const h = decorate(raw);
    rows.push(COLUMNS.map(([key]) => csvEscape(h[key])).join(','));
  }
  return rows.join('\r\n');
}

function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toXml(hosts, meta = {}) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push(`<scan generated="${xmlEscape(new Date().toISOString())}" range="${xmlEscape(meta.range || '')}" count="${hosts.length}">`);
  for (const raw of hosts) {
    const h = decorate(raw);
    lines.push('  <host>');
    for (const [key, label] of COLUMNS) {
      lines.push(`    <${key} label="${xmlEscape(label)}">${xmlEscape(h[key])}</${key}>`);
    }
    lines.push('  </host>');
  }
  lines.push('</scan>');
  return lines.join('\n');
}

function toHtml(hosts, meta = {}) {
  const head = COLUMNS.map(([, label]) => `<th>${xmlEscape(label)}</th>`).join('');
  const body = hosts.map((raw) => {
    const h = decorate(raw);
    const cells = COLUMNS.map(([key]) => {
      const val = key === 'status'
        ? `<span class="dot ${h.status === 'alive' ? 'up' : 'down'}"></span>${xmlEscape(h.status)}`
        : xmlEscape(h[key]);
      return `<td>${val}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>IP Scanner scan — ${xmlEscape(meta.range || '')}</title>
<style>
  body { font-family: "Segoe UI", Roboto, Arial, sans-serif; margin: 24px; color: #1f2430; }
  h1 { font-size: 18px; }
  .meta { color: #667; font-size: 13px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #dde1e8; padding: 6px 10px; text-align: left; }
  th { background: #f3f5f9; }
  tr:nth-child(even) td { background: #fafbfd; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .dot.up { background: #2ecc71; }
  .dot.down { background: #c0392b; }
</style>
</head>
<body>
  <h1>IP Scanner scan results</h1>
  <div class="meta">Range: ${xmlEscape(meta.range || '—')} &nbsp;·&nbsp; ${hosts.length} host(s) &nbsp;·&nbsp; ${xmlEscape(new Date().toLocaleString())}</div>
  <table>
    <thead><tr>${head}</tr></thead>
    <tbody>
${body}
    </tbody>
  </table>
</body>
</html>`;
}

function toJson(hosts, meta = {}) {
  return JSON.stringify({ generated: new Date().toISOString(), meta, hosts }, null, 2);
}

/** Return { content, ext } for the requested format. */
function render(format, hosts, meta = {}) {
  switch ((format || 'csv').toLowerCase()) {
    case 'csv':
      return { content: toCsv(hosts), ext: 'csv' };
    case 'xml':
      return { content: toXml(hosts, meta), ext: 'xml' };
    case 'html':
      return { content: toHtml(hosts, meta), ext: 'html' };
    case 'json':
      return { content: toJson(hosts, meta), ext: 'json' };
    default:
      throw new Error(`Unknown export format: ${format}`);
  }
}

module.exports = { render, toCsv, toXml, toHtml, toJson, COLUMNS };
