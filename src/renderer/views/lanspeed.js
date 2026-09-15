'use strict';

/* global window, NT */

// LAN Speed Test view — iperf-like TCP throughput between two machines.
(function lanSpeedView() {
  const api = NT.api;
  const s = { root: null, running: false, serverOn: false, chart: null, gaugeMax: 100, gaugeVal: 0, gaugeTarget: 0, raf: null, wired: false };
  const q = (sel) => s.root.querySelector(sel);

  function html() {
    return `
    <div class="ls-cols">
      <div class="card-panel ls-client">
        <div class="panel-title">Run a test (client)</div>
        <div class="ls-form">
          <label>Server host <input class="ls-host range-input" type="text" spellcheck="false" placeholder="192.168.1.20" /></label>
          <label>Port <input class="ls-port" type="number" value="5201" /></label>
          <label>Direction
            <select class="ls-mode"><option value="download">Download (server → me)</option><option value="upload">Upload (me → server)</option></select>
          </label>
          <label>Duration
            <select class="ls-secs"><option value="5">5s</option><option value="10" selected>10s</option><option value="20">20s</option></select>
          </label>
          <label>Streams <input class="ls-streams" type="number" value="4" min="1" max="16" /></label>
        </div>
        <div class="ls-gauge-wrap"><canvas class="ls-gauge" width="300" height="200"></canvas></div>
        <canvas class="ls-chart" height="80"></canvas>
        <div class="ls-actions"><button class="ls-run btn btn-primary big">Run</button><span class="ls-result muted"></span></div>
      </div>
      <div class="card-panel ls-server">
        <div class="panel-title">Server</div>
        <p class="muted">Start the server on one machine, then run the client on another and point it here. Great for comparing WiFi vs Ethernet.</p>
        <div class="ls-actions"><button class="ls-server-btn btn">Start server</button></div>
        <div class="ls-server-info"></div>
        <div class="drawer-console-wrap"><div class="drawer-console-head"><span>Incoming tests</span></div><pre class="ls-log console"></pre></div>
      </div>
    </div>`;
  }

  function niceMax(v) { const steps = [50, 100, 250, 500, 1000, 2500, 5000, 10000]; for (const st of steps) if (v <= st) return st; return Math.ceil(v / 1000) * 1000; }
  function animate() {
    s.gaugeVal += (s.gaugeTarget - s.gaugeVal) * 0.25;
    if (s.gaugeMax < niceMax(Math.max(s.gaugeVal, s.gaugeTarget))) s.gaugeMax = niceMax(Math.max(s.gaugeVal, s.gaugeTarget));
    NT.drawGauge(q('.ls-gauge'), s.gaugeVal, s.gaugeMax, 'Mbps');
    s.raf = window.requestAnimationFrame(animate);
  }

  async function run() {
    if (s.running) { api.lanClientCancel(); return; }
    const host = q('.ls-host').value.trim(); if (!host) { NT.toast('Enter the server host', 'err'); return; }
    const opts = { host, port: parseInt(q('.ls-port').value, 10) || 5201, mode: q('.ls-mode').value, seconds: parseInt(q('.ls-secs').value, 10), streams: parseInt(q('.ls-streams').value, 10) || 4 };
    s.running = true; q('.ls-run').textContent = 'Stop'; q('.ls-run').classList.add('scanning'); q('.ls-result').textContent = '';
    s.gaugeMax = 100; s.gaugeVal = 0; s.gaugeTarget = 0; if (s.chart) s.chart.clear();
    const res = await api.lanClientRun(opts);
    s.running = false; q('.ls-run').textContent = 'Run'; q('.ls-run').classList.remove('scanning'); s.gaugeTarget = 0;
    if (!res.ok) NT.toast(res.error || 'LAN test failed', 'err', 5000);
  }

  async function toggleServer() {
    if (s.serverOn) { await api.lanServerStop(); s.serverOn = false; q('.ls-server-btn').textContent = 'Start server'; q('.ls-server-btn').classList.remove('scanning'); q('.ls-server-info').innerHTML = ''; return; }
    const res = await api.lanServerStart(parseInt(q('.ls-port').value, 10) || 5201);
    if (!res.ok) { NT.toast(res.error || 'Could not start server', 'err'); return; }
    s.serverOn = true; q('.ls-server-btn').textContent = 'Stop server'; q('.ls-server-btn').classList.add('scanning');
    const info = res.info;
    q('.ls-server-info').innerHTML = `<div class="ls-listen">Listening on port <strong>${info.port}</strong></div>`
      + `<div class="muted">On the other machine, use one of these as the server host:</div>`
      + `<div class="ls-addrs">${(info.addresses || []).map((a) => `<code>${a}</code>`).join(' ')}</div>`;
  }

  function wire() {
    if (s.wired) return; s.wired = true;
    api.on('lan:sample', (p) => { s.gaugeTarget = p.mbps || 0; if (s.chart) s.chart.push(p.mbps || 0); });
    api.on('lan:result', (r) => {
      q('.ls-result').textContent = `${r.mode}: ${NT.fmt.mbps(r.mbps)} (${NT.fmt.bytes(r.bytes)} in ${r.seconds}s)`;
      NT.toast(`LAN ${r.mode}: ${NT.fmt.mbps(r.mbps)}`, 'ok', 4000);
      NT.saveResult({ type: 'lanspeed', title: 'LAN Speed Test', summary: `${r.mode} ${NT.fmt.mbps(r.mbps)} → ${r.host}`, data: r });
    });
    api.on('lan:error', (p) => NT.toast(p.message || 'LAN test error', 'err', 5000));
    api.on('lan:client', (c) => { const log = q('.ls-log'); log.textContent += `▶ ${c.remote} started ${c.mode === 'D' ? 'download' : 'upload'}\n`; log.scrollTop = log.scrollHeight; });
    api.on('lan:clientDone', (c) => { const log = q('.ls-log'); log.textContent += `✔ ${c.remote} done${c.mbps ? ` — ${NT.fmt.mbps(c.mbps)}` : ''}\n`; log.scrollTop = log.scrollHeight; });
  }

  NT.registerView({
    id: 'lanspeed',
    title: 'LAN Speed Test',
    icon: '🚀',
    desc: 'Measure throughput between two devices (WiFi vs Ethernet).',
    group: 'Speed & Throughput',
    accent: '#d81b60',
    build(section) {
      s.root = section; section.innerHTML = html();
      s.chart = new NT.LineChart(q('.ls-chart'), { color: '#d81b60', maxPoints: 100 });
      q('.ls-run').addEventListener('click', run);
      q('.ls-server-btn').addEventListener('click', toggleServer);
      wire();
      NT.drawGauge(q('.ls-gauge'), 0, 100, 'Mbps');
    },
    onEnter() { if (!s.raf) animate(); },
    onLeave() { if (s.running) api.lanClientCancel(); if (s.raf) { window.cancelAnimationFrame(s.raf); s.raf = null; } },
    demo() {
      s.gaugeVal = 940; s.gaugeTarget = 940; s.gaugeMax = 1000; NT.drawGauge(q('.ls-gauge'), 940, 1000, 'Mbps');
      if (s.chart) s.chart.setData([300, 620, 810, 900, 935, 942, 940, 938, 941, 940]);
      q('.ls-host').value = '192.168.1.20'; q('.ls-result').textContent = 'download: 940 Mbps (1.1 GB in 10s)';
      q('.ls-server-info').innerHTML = '<div class="ls-listen">Listening on port <strong>5201</strong></div><div class="ls-addrs"><code>192.168.1.42</code></div>';
    },
  });
}());
