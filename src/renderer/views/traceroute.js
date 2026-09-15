'use strict';

/* global NT */

// Traceroute view — live hop-by-hop path with per-hop latency.
(function tracerouteView() {
  const api = NT.api;
  const s = { root: null, running: false, wired: false, maxAvg: 1, hops: [], target: '' };
  const q = (sel) => s.root.querySelector(sel);

  function html() {
    return `
    <div class="tr-bar">
      <input class="tr-target range-input" type="text" spellcheck="false" placeholder="Host or IP (e.g. cloudflare.com)" />
      <button class="tr-go btn btn-primary"><span class="btn-icon">▶</span><span class="tr-go-label">Trace</span></button>
      <div class="spacer"></div>
      <span class="tr-summary muted"></span>
    </div>
    <div class="results">
      <table class="grid tr-table">
        <thead><tr><th class="col-hop">#</th><th>Host</th><th>IP</th><th class="col-ms">Best</th><th class="col-ms">Avg</th><th class="col-ms">Last</th><th class="col-loss">Loss</th><th>Latency</th></tr></thead>
        <tbody class="tr-tbody"></tbody>
      </table>
      <div class="empty-state tr-empty"><div class="empty-icon">🧭</div><p>Enter a destination and press <strong>Trace</strong> to map the route.</p></div>
    </div>`;
  }

  function setRunning(on) { s.running = on; q('.tr-go').classList.toggle('scanning', on); q('.tr-go-label').textContent = on ? 'Stop' : 'Trace'; q('.tr-go').querySelector('.btn-icon').textContent = on ? '■' : '▶'; }

  function addHop(h) {
    q('.tr-empty').classList.add('hidden');
    s.hops.push(h);
    const best = h.times.filter((t) => t != null); const bestV = best.length ? Math.min(...best) : null; const lastV = h.times.length ? h.times[h.times.length - 1] : null;
    if (h.avg && h.avg > s.maxAvg) s.maxAvg = h.avg;
    const barW = h.avg ? Math.min(100, (h.avg / s.maxAvg) * 100) : 0;
    const lossCls = h.loss >= 100 ? 'bad' : (h.loss > 0 ? 'ok' : 'good');
    const tr = NT.el('tr');
    tr.innerHTML = `<td class="col-hop">${h.hop}</td><td>${NT.escapeHtml(h.host || (h.ip ? '' : '*'))}</td><td class="mac">${NT.escapeHtml(h.ip || '')}</td>`
      + `<td class="num">${bestV != null ? bestV : ''}</td><td class="num">${h.avg != null ? h.avg : ''}</td><td class="num">${lastV != null ? lastV : ''}</td>`
      + `<td class="num ${lossCls}">${h.loss}%</td><td><div class="lat-bar"><div class="lat-fill" style="width:${barW}%"></div></div></td>`;
    q('.tr-tbody').append(tr);
  }

  function start() {
    if (s.running) { api.stopTrace(); setRunning(false); return; }
    const target = q('.tr-target').value.trim(); if (!target) { NT.toast('Enter a destination', 'err'); return; }
    q('.tr-tbody').textContent = ''; s.maxAvg = 1; s.hops = []; s.target = target; q('.tr-summary').textContent = `Tracing ${target}…`;
    setRunning(true); api.startTrace(target, {});
  }

  function wire() {
    if (s.wired) return; s.wired = true;
    api.on('trace:hop', (h) => addHop(h));
    api.on('trace:done', () => {
      setRunning(false); q('.tr-summary').textContent = `Done — ${s.hops.length} hops`;
      if (s.hops.length) NT.saveResult({ type: 'traceroute', title: 'Traceroute', summary: `${s.target} · ${s.hops.length} hops`, data: { target: s.target, hops: s.hops } });
    });
    api.on('trace:error', (p) => { setRunning(false); NT.toast(p.message || 'Traceroute failed', 'err'); q('.tr-summary').textContent = 'Error'; });
  }

  NT.registerView({
    id: 'traceroute',
    title: 'Traceroute',
    icon: '🧭',
    desc: 'Map the network path and latency to any destination.',
    group: 'Discovery & Diagnostics',
    accent: '#16a2b8',
    build(section) {
      s.root = section; section.innerHTML = html();
      q('.tr-go').addEventListener('click', start);
      q('.tr-target').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
      wire();
    },
    onEnter() { if (!q('.tr-target').value) q('.tr-target').value = 'cloudflare.com'; },
    onLeave() { if (s.running) { api.stopTrace(); setRunning(false); } },
    demo() {
      q('.tr-target').value = 'cloudflare.com'; q('.tr-tbody').textContent = ''; s.maxAvg = 20;
      [
        { hop: 1, host: '', ip: '192.168.1.1', times: [1, 1, 1], avg: 1, loss: 0 },
        { hop: 2, host: '', ip: '10.0.0.1', times: [8, 9, 8], avg: 8.3, loss: 0 },
        { hop: 3, host: 'core1.isp.net', ip: '96.120.10.1', times: [11, 12, 11], avg: 11.3, loss: 0 },
        { hop: 4, host: '', ip: '', times: [null, null, null], avg: null, loss: 100 },
        { hop: 5, host: 'cloudflare.com', ip: '104.16.132.229', times: [12, 13, 12], avg: 12.3, loss: 0 },
      ].forEach(addHop);
      q('.tr-summary').textContent = 'Done — 5 hops';
    },
  });
}());
