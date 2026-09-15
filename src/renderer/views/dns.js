'use strict';

/* global NT */

// DNS Benchmark view — compares resolver response times.
(function dnsView() {
  const api = NT.api;
  const s = { root: null, running: false, rows: new Map(), wired: false };
  const q = (sel) => s.root.querySelector(sel);

  function html() {
    return `
    <div class="dn-bar">
      <button class="dn-go btn btn-primary"><span class="btn-icon">▶</span><span class="dn-go-label">Run benchmark</span></button>
      <div class="spacer"></div>
      <span class="dn-summary muted">Tests popular public resolvers plus your system DNS.</span>
    </div>
    <div class="results">
      <table class="grid dn-table">
        <thead><tr><th class="col-hop">#</th><th>Resolver</th><th>IP</th><th class="col-ms">Avg</th><th class="col-ms">Min</th><th class="col-ms">Max</th><th class="col-loss">Loss</th><th>Speed</th></tr></thead>
        <tbody class="dn-tbody"></tbody>
      </table>
    </div>`;
  }

  function render() {
    const rows = Array.from(s.rows.values());
    rows.sort((a, b) => (a.avg == null ? 1 : b.avg == null ? -1 : a.avg - b.avg));
    const maxAvg = Math.max(1, ...rows.filter((r) => r.avg != null).map((r) => r.avg));
    const tbody = q('.dn-tbody'); tbody.textContent = '';
    rows.forEach((r, i) => {
      const barW = r.avg != null ? Math.max(4, 100 - (r.avg / maxAvg) * 100) : 0; // faster = fuller
      const lossCls = r.lossPct >= 50 ? 'bad' : (r.lossPct > 0 ? 'ok' : 'good');
      const tr = NT.el('tr'); if (i === 0 && r.avg != null) tr.classList.add('selected');
      tr.innerHTML = `<td class="col-hop">${i + 1}</td><td>${NT.escapeHtml(r.name)}${r.system ? ' <span class="badge">system</span>' : ''}</td>`
        + `<td class="mac">${NT.escapeHtml(r.ip)}</td><td class="num">${r.avg != null ? r.avg : '—'}</td><td class="num">${r.min != null ? r.min : '—'}</td>`
        + `<td class="num">${r.max != null ? r.max : '—'}</td><td class="num ${lossCls}">${r.lossPct}%</td>`
        + `<td><div class="lat-bar"><div class="lat-fill good" style="width:${barW}%"></div></div></td>`;
      tbody.append(tr);
    });
  }

  function run() {
    if (s.running) { api.cancelDnsBench(); return; }
    s.rows.clear(); render(); s.running = true;
    q('.dn-go').classList.add('scanning'); q('.dn-go-label').textContent = 'Running…'; q('.dn-summary').textContent = 'Benchmarking resolvers…';
    api.startDnsBench({ rounds: 2 });
  }

  function wire() {
    if (s.wired) return; s.wired = true;
    api.on('dns:resolverDone', (r) => { s.rows.set(r.ip, r); render(); });
    api.on('dns:result', (all) => { all.forEach((r) => s.rows.set(r.ip, r)); render(); s.running = false; q('.dn-go').classList.remove('scanning'); q('.dn-go-label').textContent = 'Run benchmark'; const best = all.find((r) => r.avg != null); q('.dn-summary').textContent = best ? `Fastest: ${best.name} (${best.avg} ms avg)` : 'No resolver responded.'; });
    api.on('dns:error', (p) => { s.running = false; q('.dn-go').classList.remove('scanning'); q('.dn-go-label').textContent = 'Run benchmark'; NT.toast(p.message || 'DNS benchmark failed', 'err'); });
  }

  NT.registerView({
    id: 'dns',
    title: 'DNS Benchmark',
    icon: '🧩',
    desc: 'Find the fastest DNS resolver for your connection.',
    group: 'Discovery & Diagnostics',
    accent: '#6a5acd',
    build(section) { s.root = section; section.innerHTML = html(); q('.dn-go').addEventListener('click', run); wire(); },
    onLeave() { if (s.running) api.cancelDnsBench(); },
    demo() {
      [
        { name: 'Cloudflare', ip: '1.1.1.1', avg: 8.2, min: 6.1, max: 14.0, lossPct: 0 },
        { name: 'Google', ip: '8.8.8.8', avg: 11.4, min: 9.0, max: 18.2, lossPct: 0 },
        { name: 'System', ip: '192.168.1.1', avg: 13.9, min: 10.1, max: 22.5, lossPct: 0, system: true },
        { name: 'Quad9', ip: '9.9.9.9', avg: 16.7, min: 12.4, max: 28.1, lossPct: 0 },
        { name: 'OpenDNS', ip: '208.67.222.222', avg: 24.3, min: 18.0, max: 41.0, lossPct: 0 },
      ].forEach((r) => s.rows.set(r.ip, r));
      render(); q('.dn-summary').textContent = 'Fastest: Cloudflare (8.2 ms avg)';
    },
  });
}());
