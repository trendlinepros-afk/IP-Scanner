'use strict';

/* global NT */

// Ping / Latency Monitor view — continuous ping with live graph (PingPlotter style).
(function pingView() {
  const api = NT.api;
  const s = { root: null, running: false, chart: null, wired: false, lastStats: null, target: '' };
  const q = (sel) => s.root.querySelector(sel);

  function html() {
    return `
    <div class="pm-bar">
      <input class="pm-target range-input" type="text" spellcheck="false" placeholder="Host or IP (e.g. 8.8.8.8)" />
      <select class="pm-interval">
        <option value="500">Every 0.5s</option>
        <option value="1000" selected>Every 1s</option>
        <option value="2000">Every 2s</option>
        <option value="5000">Every 5s</option>
      </select>
      <button class="pm-go btn btn-primary"><span class="btn-icon">▶</span><span class="pm-go-label">Start</span></button>
    </div>
    <div class="stat-row">
      <div class="stat"><div class="stat-val pm-last">—</div><div class="stat-cap">Last (ms)</div></div>
      <div class="stat"><div class="stat-val pm-min">—</div><div class="stat-cap">Min</div></div>
      <div class="stat"><div class="stat-val pm-avg">—</div><div class="stat-cap">Avg</div></div>
      <div class="stat"><div class="stat-val pm-max">—</div><div class="stat-cap">Max</div></div>
      <div class="stat"><div class="stat-val pm-jitter">—</div><div class="stat-cap">Jitter</div></div>
      <div class="stat"><div class="stat-val pm-loss">—</div><div class="stat-cap">Loss</div></div>
      <div class="stat"><div class="stat-val pm-count">0/0</div><div class="stat-cap">Recv/Sent</div></div>
    </div>
    <div class="chart-panel"><canvas class="pm-chart" height="220"></canvas></div>
    <div class="pm-log-wrap"><pre class="pm-log console"></pre></div>`;
  }

  function setRunning(on) { s.running = on; q('.pm-go').classList.toggle('scanning', on); q('.pm-go-label').textContent = on ? 'Stop' : 'Start'; q('.pm-go').querySelector('.btn-icon').textContent = on ? '■' : '▶'; }

  function saveSnapshot() {
    if (s.lastStats && s.lastStats.sent > 0) {
      NT.saveResult({ type: 'ping', title: 'Ping Monitor', summary: `${s.target} · avg ${s.lastStats.avg ?? '—'} ms · ${s.lastStats.lossPct}% loss`, data: { target: s.target, ...s.lastStats } });
    }
  }

  function start() {
    if (s.running) { api.stopLatency(); setRunning(false); saveSnapshot(); return; }
    const target = q('.pm-target').value.trim(); if (!target) { NT.toast('Enter a host or IP', 'err'); return; }
    s.target = target; s.lastStats = null;
    s.chart.clear(); q('.pm-log').textContent = '';
    ['pm-last', 'pm-min', 'pm-avg', 'pm-max', 'pm-jitter', 'pm-loss'].forEach((c) => { q(`.${c}`).textContent = '—'; });
    q('.pm-count').textContent = '0/0';
    setRunning(true);
    api.startLatency(target, { intervalMs: parseInt(q('.pm-interval').value, 10) });
  }

  function wire() {
    if (s.wired) return; s.wired = true;
    api.on('latency:sample', (p) => {
      s.chart.push(p.ok ? p.rtt : null);
      const line = p.ok ? `seq=${p.seq}  time=${p.rtt} ms` : `seq=${p.seq}  timeout`;
      const log = q('.pm-log'); log.textContent += `${line}\n`; if (log.textContent.length > 20000) log.textContent = log.textContent.slice(-15000); log.scrollTop = log.scrollHeight;
    });
    api.on('latency:stats', (st) => {
      s.lastStats = st;
      q('.pm-last').textContent = st.last ?? '—'; q('.pm-min').textContent = st.min ?? '—'; q('.pm-avg').textContent = st.avg ?? '—';
      q('.pm-max').textContent = st.max ?? '—'; q('.pm-jitter').textContent = st.jitter ?? '—'; q('.pm-loss').textContent = `${st.lossPct}%`;
      q('.pm-count').textContent = `${st.recv}/${st.sent}`;
      q('.pm-loss').className = `stat-val pm-loss ${st.lossPct > 5 ? 'bad' : (st.lossPct > 0 ? 'ok' : 'good')}`;
    });
  }

  NT.registerView({
    id: 'ping',
    title: 'Ping Monitor',
    icon: '📡',
    desc: 'Continuous latency graph with jitter and packet loss.',
    group: 'Discovery & Diagnostics',
    accent: '#e08a1e',
    build(section) {
      s.root = section; section.innerHTML = html();
      s.chart = new NT.LineChart(q('.pm-chart'), { color: '#e08a1e', unit: ' ms', maxPoints: 120, minMax: 20 });
      q('.pm-go').addEventListener('click', start);
      q('.pm-target').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
      wire();
    },
    onEnter() {
      if (!q('.pm-target').value) {
        const gw = NT._conn && NT._conn.info && NT._conn.info.gateway;
        q('.pm-target').value = gw || '8.8.8.8';
      }
    },
    onLeave() { if (s.running) { api.stopLatency(); setRunning(false); } },
    demo() {
      const data = [12, 11, 13, 12, 14, 11, 12, 18, 12, 11, 13, 12, 11, 12, 13, 12, 25, 12, 11, 12, 13];
      s.chart.setData(data);
      q('.pm-last').textContent = '12'; q('.pm-min').textContent = '11'; q('.pm-avg').textContent = '12.8'; q('.pm-max').textContent = '25'; q('.pm-jitter').textContent = '1.4'; q('.pm-loss').textContent = '0%'; q('.pm-count').textContent = '21/21';
      q('.pm-target').value = '8.8.8.8';
    },
  });
}());
