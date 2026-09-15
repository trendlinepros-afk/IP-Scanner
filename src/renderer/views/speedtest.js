'use strict';

/* global window, NT */

// Internet Speed Test view — download/upload/ping/jitter via Cloudflare.
(function speedTestView() {
  const api = NT.api;
  const s = { running: false, phase: null, chart: null, gaugeMax: 100, root: null, raf: null, gaugeVal: 0, wired: false };
  const q = (sel) => s.root.querySelector(sel);

  function html() {
    return `
    <div class="st-wrap">
      <div class="st-conn" title="Traffic goes over this connection">
        <span class="st-conn-icon">📶</span><span class="st-conn-label">Detecting connection…</span>
      </div>
      <div class="st-gauge-wrap">
        <canvas class="st-gauge" width="320" height="220"></canvas>
        <div class="st-phase">Ready</div>
      </div>
      <canvas class="st-chart" height="90"></canvas>
      <div class="st-tiles">
        <div class="st-tile"><div class="st-tile-ico dl">↓</div><div class="st-tile-val st-dl">—</div><div class="st-tile-cap">Download (Mbps)</div></div>
        <div class="st-tile"><div class="st-tile-ico ul">↑</div><div class="st-tile-val st-ul">—</div><div class="st-tile-cap">Upload (Mbps)</div></div>
        <div class="st-tile"><div class="st-tile-ico pg">◷</div><div class="st-tile-val st-ping">—</div><div class="st-tile-cap">Ping (ms)</div></div>
        <div class="st-tile"><div class="st-tile-ico jt">≈</div><div class="st-tile-val st-jitter">—</div><div class="st-tile-cap">Jitter (ms)</div></div>
        <div class="st-tile"><div class="st-tile-ico ls">%</div><div class="st-tile-val st-loss">—</div><div class="st-tile-cap">Loss</div></div>
      </div>
      <div class="st-actions">
        <button class="st-go btn btn-primary big">Start Test</button>
        <span class="st-server muted"></span>
      </div>
      <p class="st-note muted">Measured against Cloudflare's global network. Results reflect the connection currently in use (WiFi or Ethernet). Plug into Ethernet or connect to WiFi and re-run to compare.</p>
    </div>`;
  }

  function niceMax(v) { const steps = [50, 100, 250, 500, 1000, 2500, 5000, 10000]; for (const st of steps) if (v <= st) return st; return Math.ceil(v / 1000) * 1000; }

  function animateGauge() {
    // smooth needle toward target
    const target = s.gaugeTarget || 0;
    s.gaugeVal += (target - s.gaugeVal) * 0.25;
    if (s.gaugeMax < niceMax(Math.max(s.gaugeVal, target))) s.gaugeMax = niceMax(Math.max(s.gaugeVal, target));
    NT.drawGauge(q('.st-gauge'), s.gaugeVal, s.gaugeMax, s.phase === 'upload' ? 'Mbps ↑' : 'Mbps ↓');
    s.raf = window.requestAnimationFrame(animateGauge);
  }

  function setConn() {
    const c = NT._conn || {};
    let label = 'Ethernet'; let icon = '🖧';
    if (c.wifi && c.wifi.current && c.wifi.current.ssid) {
      const cur = c.wifi.current;
      label = `Wi-Fi · ${cur.ssid}${cur.signalDbm != null ? ` (${cur.signalDbm} dBm)` : ''}${cur.band ? ` · ${cur.band}` : ''}`;
      icon = '📶';
    }
    q('.st-conn-icon').textContent = icon; q('.st-conn-label').textContent = label;
  }

  function reset() {
    q('.st-dl').textContent = '—'; q('.st-ul').textContent = '—'; q('.st-ping').textContent = '—'; q('.st-jitter').textContent = '—'; q('.st-loss').textContent = '—';
    s.gaugeTarget = 0; s.gaugeVal = 0; s.gaugeMax = 100; if (s.chart) s.chart.clear();
  }

  function start() {
    if (s.running) { api.cancelSpeedTest(); return; }
    reset(); setConn();
    s.running = true; q('.st-go').textContent = 'Stop'; q('.st-go').classList.add('scanning');
    q('.st-phase').textContent = 'Starting…';
    api.startSpeedTest({});
  }

  function done() { s.running = false; q('.st-go').textContent = 'Start Test'; q('.st-go').classList.remove('scanning'); s.gaugeTarget = 0; }

  function wire() {
    if (s.wired) return; s.wired = true;
    api.on('speed:phase', (p) => {
      s.phase = p.phase; q('.st-phase').textContent = p.label || p.phase;
      if (p.phase === 'download' || p.phase === 'upload') { if (s.chart) s.chart.clear(); s.gaugeMax = 100; }
    });
    api.on('speed:sample', (p) => {
      if (p.phase === 'latency') { q('.st-ping').textContent = p.ping != null ? p.ping.toFixed(1) : '—'; return; }
      s.gaugeTarget = p.mbps || 0;
      if (s.chart) s.chart.push(p.mbps || 0);
      const el = p.phase === 'download' ? '.st-dl' : '.st-ul';
      q(el).textContent = NT.fmt.mbpsNum(p.mbps || 0);
    });
    api.on('speed:latency', (p) => { q('.st-ping').textContent = p.avg != null ? p.avg.toFixed(1) : '—'; q('.st-jitter').textContent = p.jitter != null ? p.jitter.toFixed(1) : '—'; q('.st-loss').textContent = `${p.loss}%`; });
    api.on('speed:result', (r) => {
      done();
      q('.st-phase').textContent = r.cancelled ? 'Stopped' : 'Complete';
      if (!r.cancelled) {
        q('.st-dl').textContent = NT.fmt.mbpsNum(r.downloadMbps); q('.st-ul').textContent = NT.fmt.mbpsNum(r.uploadMbps);
        q('.st-ping').textContent = r.ping != null ? r.ping.toFixed(1) : '—'; q('.st-jitter').textContent = r.jitter != null ? r.jitter.toFixed(1) : '—'; q('.st-loss').textContent = `${r.loss}%`;
        q('.st-server').textContent = r.server ? `Server: ${r.server}` : '';
        NT.toast(`↓ ${NT.fmt.mbps(r.downloadMbps)}  ↑ ${NT.fmt.mbps(r.uploadMbps)}  ${r.ping} ms`, 'ok', 4000);
        NT.saveResult({
          type: 'speedtest',
          title: 'Internet Speed Test',
          summary: `↓ ${NT.fmt.mbps(r.downloadMbps)} · ↑ ${NT.fmt.mbps(r.uploadMbps)} · ${r.ping} ms`,
          data: { downloadMbps: r.downloadMbps, uploadMbps: r.uploadMbps, ping: r.ping, jitter: r.jitter, loss: r.loss, server: r.server, connection: q('.st-conn-label').textContent },
        });
      }
    });
    api.on('speed:error', (p) => { done(); q('.st-phase').textContent = 'Error'; NT.toast(p.message || 'Speed test failed', 'err', 5000); });
  }

  NT.registerView({
    id: 'speedtest',
    title: 'Speed Test',
    icon: '⚡',
    desc: 'Measure internet download, upload, ping and jitter.',
    group: 'Speed & Throughput',
    accent: '#21ba45',
    build(section) {
      s.root = section; section.innerHTML = html();
      s.chart = new NT.LineChart(q('.st-chart'), { color: '#21ba45', unit: '', maxPoints: 100 });
      q('.st-go').addEventListener('click', start);
      wire();
      NT.drawGauge(q('.st-gauge'), 0, 100, 'Mbps');
    },
    onEnter() { setConn(); if (!s.raf) animateGauge(); },
    onLeave() { if (s.running) { api.cancelSpeedTest(); done(); } if (s.raf) { window.cancelAnimationFrame(s.raf); s.raf = null; } },
    demo() {
      setConn(); q('.st-dl').textContent = '482'; q('.st-ul').textContent = '41.7'; q('.st-ping').textContent = '8.4'; q('.st-jitter').textContent = '1.2'; q('.st-loss').textContent = '0%';
      s.phase = 'download'; s.gaugeVal = 482; s.gaugeTarget = 482; s.gaugeMax = 500; q('.st-phase').textContent = 'Complete';
      NT.drawGauge(q('.st-gauge'), 482, 500, 'Mbps ↓'); q('.st-server').textContent = 'Server: speed.cloudflare.com (Cloudflare)';
      if (s.chart) {
        const ramp = [];
        for (let i = 0; i < 60; i += 1) { ramp.push(i < 12 ? 40 * i + Math.random() * 30 : 470 + Math.random() * 24); }
        s.chart.setData(ramp);
      }
    },
  });
}());
