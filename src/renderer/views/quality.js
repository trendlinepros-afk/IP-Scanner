'use strict';

/* global NT */

// Connection Quality view — bufferbloat (latency under load) + VoIP MOS.
(function qualityView() {
  const api = NT.api;
  const s = { root: null, running: false, chart: null, wired: false };
  const q = (sel) => s.root.querySelector(sel);

  function html() {
    return `
    <div class="ql-wrap">
      <div class="ql-grade-wrap">
        <div class="ql-grade" id="qlGrade">–</div>
        <div class="ql-grade-cap">Bufferbloat grade</div>
      </div>
      <div class="ql-phase" id="qlPhase">Ready — measures latency while idle, then under download &amp; upload load.</div>
      <canvas class="ql-chart" height="150"></canvas>
      <div class="ql-tiles">
        <div class="stat"><div class="stat-val ql-idle">—</div><div class="stat-cap">Idle latency (ms)</div></div>
        <div class="stat"><div class="stat-val ql-loaded">—</div><div class="stat-cap">Under load (ms)</div></div>
        <div class="stat"><div class="stat-val ql-bloat">—</div><div class="stat-cap">Bufferbloat (+ms)</div></div>
        <div class="stat"><div class="stat-val ql-mos">—</div><div class="stat-cap">VoIP MOS</div></div>
        <div class="stat"><div class="stat-val ql-rating">—</div><div class="stat-cap">Call quality</div></div>
      </div>
      <div class="ql-tiles">
        <div class="stat"><div class="stat-val ql-dl">—</div><div class="stat-cap">Download (Mbps)</div></div>
        <div class="stat"><div class="stat-val ql-ul">—</div><div class="stat-cap">Upload (Mbps)</div></div>
        <div class="stat"><div class="stat-val ql-jit">—</div><div class="stat-cap">Idle jitter (ms)</div></div>
        <div class="stat"><div class="stat-val ql-loss">—</div><div class="stat-cap">Idle loss</div></div>
      </div>
      <div class="ql-actions"><button class="ql-go btn btn-primary big">Start Test</button></div>
      <p class="ql-note muted">Bufferbloat is how much your latency spikes when the connection is busy — the top cause of laggy video calls and gaming on an otherwise "fast" line. MOS (1–4.5) estimates VoIP call quality from latency, jitter and loss.</p>
    </div>`;
  }

  const gradeClass = (rank) => (rank == null ? '' : (rank <= 1 ? 'good' : (rank <= 3 ? 'warn' : 'bad')));
  const mosClass = (m) => (m == null ? '' : (m >= 4.0 ? 'good' : (m >= 3.6 ? 'warn' : 'bad')));

  function setRunning(on) { s.running = on; q('.ql-go').classList.toggle('scanning', on); q('.ql-go').textContent = on ? 'Stop' : 'Start Test'; }
  function reset() {
    ['ql-idle', 'ql-loaded', 'ql-bloat', 'ql-mos', 'ql-rating', 'ql-dl', 'ql-ul', 'ql-jit', 'ql-loss'].forEach((c) => { q(`.${c}`).textContent = '—'; });
    const g = q('#qlGrade'); g.textContent = '–'; g.className = 'ql-grade';
    if (s.chart) s.chart.clear();
  }

  function start() {
    if (s.running) { api.cancelQuality(); return; }
    reset(); setRunning(true);
    q('#qlPhase').textContent = 'Starting…';
    api.startQuality({});
  }

  function wire() {
    if (s.wired) return; s.wired = true;
    api.on('quality:phase', (p) => { q('#qlPhase').textContent = p.label || p.phase; });
    api.on('quality:sample', (p) => { if (p.latency != null && s.chart) s.chart.push(p.latency); });
    api.on('quality:result', (r) => {
      setRunning(false);
      if (r.cancelled) { q('#qlPhase').textContent = 'Stopped'; return; }
      const g = q('#qlGrade'); g.textContent = r.grade; g.className = `ql-grade ${gradeClass(r.gradeRank)}`;
      q('.ql-idle').textContent = r.baselineMs != null ? r.baselineMs : '—';
      q('.ql-loaded').textContent = r.loadedLatencyMs != null ? r.loadedLatencyMs : '—';
      q('.ql-bloat').textContent = `+${r.bufferbloatMs}`;
      q('.ql-bloat').className = `stat-val ql-bloat ${gradeClass(r.gradeRank)}`;
      q('.ql-mos').textContent = r.mos; q('.ql-mos').className = `stat-val ql-mos ${mosClass(r.mos)}`;
      q('.ql-rating').textContent = r.mosRating;
      q('.ql-dl').textContent = NT.fmt.mbpsNum(r.downloadMbps);
      q('.ql-ul').textContent = NT.fmt.mbpsNum(r.uploadMbps);
      q('.ql-jit').textContent = r.idle && r.idle.jitter != null ? r.idle.jitter : '—';
      q('.ql-loss').textContent = r.idle ? `${r.idle.loss}%` : '—';
      q('#qlPhase').textContent = `Complete — bufferbloat grade ${r.grade}, VoIP ${r.mosRating} (MOS ${r.mos})`;
      NT.saveResult({ type: 'quality', title: 'Connection Quality', summary: `Bufferbloat ${r.grade} (+${r.bufferbloatMs} ms) · MOS ${r.mos} (${r.mosRating})`, data: r });
    });
    api.on('quality:error', (p) => { setRunning(false); q('#qlPhase').textContent = 'Error'; NT.toast(p.message || 'Quality test failed', 'err', 5000); });
  }

  NT.registerView({
    id: 'quality',
    title: 'Connection Quality',
    icon: '🩺',
    desc: 'Bufferbloat (latency under load) + VoIP call-quality score.',
    group: 'Speed & Throughput',
    accent: '#16a2b8',
    build(section) {
      s.root = section; section.innerHTML = html();
      s.chart = new NT.LineChart(q('.ql-chart'), { color: '#16a2b8', unit: ' ms', maxPoints: 140, minMax: 40 });
      q('.ql-go').addEventListener('click', start);
      wire();
    },
    onLeave() { if (s.running) { api.cancelQuality(); setRunning(false); } },
    demo() {
      const g = q('#qlGrade'); g.textContent = 'A'; g.className = 'ql-grade good';
      q('.ql-idle').textContent = '11'; q('.ql-loaded').textContent = '34'; q('.ql-bloat').textContent = '+23'; q('.ql-bloat').className = 'stat-val ql-bloat good';
      q('.ql-mos').textContent = '4.301'; q('.ql-mos').className = 'stat-val ql-mos good'; q('.ql-rating').textContent = 'Excellent';
      q('.ql-dl').textContent = '478'; q('.ql-ul').textContent = '41'; q('.ql-jit').textContent = '1.1'; q('.ql-loss').textContent = '0%';
      q('#qlPhase').textContent = 'Complete — bufferbloat grade A, VoIP Excellent (MOS 4.30)';
      const data = []; for (let i = 0; i < 100; i += 1) { if (i < 20) data.push(10 + Math.random() * 3); else if (i < 60) data.push(30 + Math.random() * 8); else data.push(28 + Math.random() * 10); }
      if (s.chart) s.chart.setData(data);
    },
  });
}());
