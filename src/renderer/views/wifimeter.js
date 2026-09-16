'use strict';

/* global NT */

// Live WiFi Signal Meter — poll the current link ~1/s for on-site dead-spot hunting.
(function wifiMeterView() {
  const api = NT.api;
  const s = { root: null, running: false, timer: null, chart: null, samples: [], start: 0, link: null };
  const q = (sel) => s.root.querySelector(sel);

  function html() {
    return `
    <div class="wm-wrap">
      <div class="wm-readout">
        <div class="wm-dbm" id="wmDbm">—</div>
        <div class="wm-dbm-unit">dBm</div>
        <div class="wm-bar"><div class="wm-fill" id="wmFill"></div></div>
        <div class="wm-quality" id="wmQuality"></div>
      </div>
      <div class="wm-link muted" id="wmLink">Press Start, then walk the site — the graph tracks signal in real time.</div>
      <canvas class="wm-chart" height="170"></canvas>
      <div class="stat-row">
        <div class="stat"><div class="stat-val wm-cur">—</div><div class="stat-cap">Current (dBm)</div></div>
        <div class="stat"><div class="stat-val wm-min">—</div><div class="stat-cap">Weakest</div></div>
        <div class="stat"><div class="stat-val wm-max">—</div><div class="stat-cap">Strongest</div></div>
        <div class="stat"><div class="stat-val wm-avg">—</div><div class="stat-cap">Average</div></div>
        <div class="stat"><div class="stat-val wm-n">0</div><div class="stat-cap">Samples</div></div>
      </div>
      <div class="wm-actions"><button class="wm-go btn btn-primary big"><span class="btn-icon">▶</span> <span class="wm-go-label">Start</span></button></div>
      <p class="wm-note muted">Signal guide: <b style="color:var(--up)">≥ −60 dBm</b> excellent · <b style="color:var(--ok)">−60 to −75</b> usable · <b style="color:var(--down)">below −75</b> weak.</p>
    </div>`;
  }

  const quality = (dbm) => (dbm == null ? 0 : Math.max(0, Math.min(100, Math.round(2 * (dbm + 100)))));
  const zone = (dbm) => (dbm == null ? '' : (dbm >= -60 ? 'good' : (dbm >= -75 ? 'ok' : 'bad')));

  function setRunning(on) {
    s.running = on;
    q('.wm-go').classList.toggle('scanning', on);
    q('.wm-go-label').textContent = on ? 'Stop' : 'Start';
    q('.wm-go').querySelector('.btn-icon').textContent = on ? '■' : '▶';
  }

  async function poll() {
    const res = await api.wifiCurrent().catch(() => null);
    if (!res || !res.supported || !res.current) {
      q('#wmLink').textContent = 'No WiFi connection detected (are you on Ethernet, or is WiFi off?).';
      return;
    }
    const c = res.current; s.link = c;
    const dbm = c.signalDbm;
    s.samples.push(dbm);
    const z = zone(dbm);
    const dbmEl = q('#wmDbm'); dbmEl.textContent = dbm != null ? dbm : '—'; dbmEl.className = `wm-dbm ${z}`;
    q('#wmFill').style.width = `${quality(dbm)}%`;
    q('#wmFill').className = `wm-fill ${z}`;
    q('#wmQuality').textContent = `${quality(dbm)}% signal quality`;
    const rate = [c.txMbps ? `TX ${c.txMbps}` : '', c.rxMbps ? `RX ${c.rxMbps}` : ''].filter(Boolean).join(' · ');
    q('#wmLink').innerHTML = `<b>${NT.escapeHtml(c.ssid || '')}</b> · ${NT.escapeHtml(c.band || '')} · Ch ${c.channel ?? '—'} · ${NT.escapeHtml(c.phy || '')} ${rate ? `· ${NT.escapeHtml(rate)} Mbps` : ''}`;
    if (s.chart) s.chart.push(quality(dbm));
    const good = s.samples.filter((x) => x != null);
    q('.wm-cur').textContent = dbm != null ? dbm : '—';
    if (good.length) {
      q('.wm-min').textContent = Math.min(...good);
      q('.wm-max').textContent = Math.max(...good);
      q('.wm-avg').textContent = Math.round(good.reduce((a, b) => a + b, 0) / good.length);
    }
    q('.wm-n').textContent = s.samples.length;
  }

  function start() {
    if (s.running) { stop(true); return; }
    s.samples = []; s.start = Date.now(); if (s.chart) s.chart.clear();
    setRunning(true);
    poll();
    s.timer = setInterval(poll, 1000);
  }

  function stop(save) {
    setRunning(false);
    if (s.timer) { clearInterval(s.timer); s.timer = null; }
    const good = s.samples.filter((x) => x != null);
    if (save && good.length && s.link) {
      NT.saveResult({
        type: 'wifimeter',
        title: 'WiFi Signal Meter',
        summary: `${s.link.ssid || ''} · avg ${Math.round(good.reduce((a, b) => a + b, 0) / good.length)} dBm (${Math.min(...good)}…${Math.max(...good)})`,
        data: {
          ssid: s.link.ssid, band: s.link.band, channel: s.link.channel,
          min: Math.min(...good), max: Math.max(...good), avg: Math.round(good.reduce((a, b) => a + b, 0) / good.length),
          samples: s.samples.length, durationSec: Math.round((Date.now() - s.start) / 1000),
        },
      });
    }
  }

  NT.registerView({
    id: 'wifimeter',
    title: 'WiFi Signal Meter',
    icon: '📶',
    desc: 'Live signal strength — walk the site to find dead spots.',
    group: 'WiFi & Connectivity',
    accent: '#8e44ec',
    build(section) {
      s.root = section; section.innerHTML = html();
      s.chart = new NT.LineChart(q('.wm-chart'), { color: '#8e44ec', unit: '%', max: 100, maxPoints: 120 });
      q('.wm-go').addEventListener('click', start);
    },
    onLeave() { if (s.running) stop(true); },
    demo() {
      const c = { ssid: 'HomeNet-5G', band: '5 GHz', channel: 44, phy: '802.11ac', txMbps: 866.7, rxMbps: 866.7, signalDbm: -52 };
      s.link = c; s.samples = [-49, -51, -52, -55, -58, -54, -50, -48, -52, -53];
      q('#wmDbm').textContent = '-52'; q('#wmDbm').className = 'wm-dbm good';
      q('#wmFill').style.width = '96%'; q('#wmFill').className = 'wm-fill good';
      q('#wmQuality').textContent = '96% signal quality';
      q('#wmLink').innerHTML = '<b>HomeNet-5G</b> · 5 GHz · Ch 44 · 802.11ac · TX 866.7 · RX 866.7 Mbps';
      q('.wm-cur').textContent = '-52'; q('.wm-min').textContent = '-58'; q('.wm-max').textContent = '-48'; q('.wm-avg').textContent = '-52'; q('.wm-n').textContent = '10';
      if (s.chart) s.chart.setData(s.samples.map((d) => Math.max(0, Math.min(100, 2 * (d + 100)))));
    },
  });
}());
