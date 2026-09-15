'use strict';

/* global NT */

// WiFi Analyzer view — nearby APs, current link, channel congestion.
(function wifiView() {
  const api = NT.api;
  const s = { root: null, scanning: false, auto: null, sortKey: 'signalDbm', sortDir: 'desc' };
  const q = (sel) => s.root.querySelector(sel);

  function html() {
    return `
    <div class="wf-bar">
      <button class="wf-scan btn btn-primary"><span class="btn-icon">⟳</span> Scan</button>
      <label class="chk"><input type="checkbox" class="wf-auto" /> Auto-refresh (5s)</label>
      <div class="spacer"></div>
      <span class="wf-summary muted"></span>
    </div>
    <div class="wf-current card-panel"></div>
    <div class="wf-analysis card-panel"></div>
    <div class="results wf-results">
      <table class="grid wf-table">
        <thead><tr>
          <th data-k="ssid">Network (SSID)</th>
          <th data-k="signalDbm" class="sorted-desc">Signal</th>
          <th data-k="band">Band</th>
          <th data-k="channel">Channel</th>
          <th data-k="security">Security</th>
          <th data-k="bssid">BSSID</th>
          <th data-k="phy">PHY</th>
        </tr></thead>
        <tbody class="wf-tbody"></tbody>
      </table>
      <div class="empty-state wf-empty"><div class="empty-icon">📶</div><p class="wf-empty-msg">Press <strong>Scan</strong> to list nearby WiFi networks.</p></div>
    </div>`;
  }

  const sigClass = (dbm) => (dbm == null ? '' : (dbm >= -60 ? 'good' : (dbm >= -75 ? 'ok' : 'bad')));
  function signalCell(n) {
    const dbm = n.signalDbm; const pct = n.signalPct != null ? n.signalPct : (dbm != null ? Math.max(0, Math.min(100, 2 * (dbm + 100))) : 0);
    return `<div class="sig"><div class="sig-bar"><div class="sig-fill ${sigClass(dbm)}" style="width:${pct}%"></div></div><span class="sig-txt">${dbm != null ? `${dbm} dBm` : `${pct}%`}</span></div>`;
  }

  function renderCurrent(cur) {
    const panel = q('.wf-current');
    if (!cur) { panel.innerHTML = '<div class="panel-title">Current connection</div><div class="muted">Not connected to WiFi (or running on Ethernet).</div>'; return; }
    const rate = [cur.txMbps ? `TX ${cur.txMbps} Mbps` : '', cur.rxMbps ? `RX ${cur.rxMbps} Mbps` : ''].filter(Boolean).join(' · ');
    panel.innerHTML = `
      <div class="panel-title">Current connection</div>
      <div class="wf-cur-grid">
        <div class="wf-cur-main">
          <div class="wf-cur-ssid">${NT.escapeHtml(cur.ssid)}</div>
          <div class="wf-cur-sub">${NT.escapeHtml(cur.band || '')} · Ch ${cur.channel ?? '—'} · ${NT.escapeHtml(cur.phy || '')}</div>
          <div class="wf-cur-sub mac">${NT.escapeHtml(cur.bssid || '')}</div>
        </div>
        <div class="wf-cur-sig">${signalCell(cur)}<div class="wf-cur-rate muted">${NT.escapeHtml(rate)}</div></div>
      </div>`;
  }

  function renderAnalysis(a, networks) {
    const panel = q('.wf-analysis');
    if (!a) { panel.innerHTML = ''; return; }
    const bands = a.byBand || {};
    const bandBadges = Object.entries(bands).filter(([, c]) => c > 0).map(([b, c]) => `<span class="badge">${b}: ${c}</span>`).join(' ');
    // 2.4GHz channel congestion 1..13
    let bars = '';
    for (let ch = 1; ch <= 13; ch += 1) {
      const count = (a.byChannel && a.byChannel[ch]) || 0;
      const h = Math.min(100, count * 28 + (count ? 12 : 0));
      const rec = a.recommended24 === ch ? ' rec' : '';
      bars += `<div class="cong-col"><div class="cong-bar${rec}" style="height:${h}%" title="${count} network(s)"></div><div class="cong-lbl">${ch}</div></div>`;
    }
    panel.innerHTML = `
      <div class="panel-title">Channel analysis</div>
      <div class="wf-badges">${bandBadges || '<span class="muted">—</span>'}</div>
      <div class="cong-title muted">2.4 GHz channel usage — recommended channel <strong>${a.recommended24}</strong></div>
      <div class="cong-graph">${bars}</div>`;
  }

  function render(data) {
    q('.wf-empty').classList.toggle('hidden', (data.networks || []).length > 0);
    renderCurrent(data.current);
    renderAnalysis(data.analysis, data.networks || []);
    const nets = (data.networks || []).slice().sort((a, b) => {
      let av = a[s.sortKey]; let bv = b[s.sortKey];
      if (s.sortKey === 'signalDbm') { av = av == null ? -999 : av; bv = bv == null ? -999 : bv; }
      if (typeof av === 'string') { av = av.toLowerCase(); bv = (bv || '').toLowerCase(); }
      if (av < bv) return s.sortDir === 'asc' ? -1 : 1;
      if (av > bv) return s.sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    const tbody = q('.wf-tbody'); tbody.textContent = '';
    for (const n of nets) {
      const tr = NT.el('tr');
      tr.innerHTML = `<td>${NT.escapeHtml(n.ssid)}</td><td>${signalCell(n)}</td><td>${NT.escapeHtml(n.band || '')}</td>`
        + `<td class="num">${n.channel ?? ''}</td><td>${NT.escapeHtml(n.security || '')}</td><td class="mac">${NT.escapeHtml(n.bssid || '')}</td><td>${NT.escapeHtml(n.phy || '')}</td>`;
      tbody.append(tr);
    }
    q('.wf-summary').textContent = `${nets.length} network(s)`;
  }

  async function scan() {
    if (s.scanning) return; s.scanning = true; q('.wf-scan').classList.add('scanning'); q('.wf-summary').textContent = 'Scanning…';
    try {
      const data = await api.wifiScan();
      if (!data.supported) { q('.wf-empty-msg').innerHTML = data.error ? `WiFi scan failed: ${NT.escapeHtml(data.error)}` : 'No WiFi adapter detected, or WiFi scanning is not available on this system.'; q('.wf-empty').classList.remove('hidden'); q('.wf-tbody').textContent = ''; renderCurrent(null); q('.wf-analysis').innerHTML = ''; q('.wf-summary').textContent = 'Not available'; }
      else render(data);
    } catch (err) { NT.toast(`WiFi scan error: ${err.message}`, 'err'); }
    finally { s.scanning = false; q('.wf-scan').classList.remove('scanning'); }
  }

  NT.registerView({
    id: 'wifi',
    title: 'WiFi Analyzer',
    icon: '📶',
    desc: 'Nearby networks, signal, channels, security & congestion.',
    group: 'WiFi & Connectivity',
    accent: '#8e44ec',
    build(section) {
      s.root = section; section.innerHTML = html();
      q('.wf-scan').addEventListener('click', scan);
      q('.wf-auto').addEventListener('change', (e) => {
        if (e.target.checked) { s.auto = setInterval(scan, 5000); scan(); } else if (s.auto) { clearInterval(s.auto); s.auto = null; }
      });
      section.querySelectorAll('th[data-k]').forEach((th) => th.addEventListener('click', () => {
        const k = th.dataset.k; if (s.sortKey === k) s.sortDir = s.sortDir === 'asc' ? 'desc' : 'asc'; else { s.sortKey = k; s.sortDir = k === 'signalDbm' ? 'desc' : 'asc'; }
        section.querySelectorAll('th[data-k]').forEach((h) => h.classList.remove('sorted-asc', 'sorted-desc'));
        th.classList.add(s.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc'); scan();
      }));
    },
    onEnter() { if (NT._demo) return; scan(); },
    onLeave() { if (s.auto) { clearInterval(s.auto); s.auto = null; q('.wf-auto').checked = false; } },
    demo() {
      render({
        current: { ssid: 'HomeNet-5G', bssid: 'f0:9f:c2:aa:bb:cc', signalDbm: -47, band: '5 GHz', channel: 44, phy: '802.11ac', txMbps: 866.7, rxMbps: 866.7 },
        analysis: { byBand: { '2.4 GHz': 6, '5 GHz': 9, '6 GHz': 1 }, byChannel: { 1: 3, 6: 2, 11: 4, 44: 2, 149: 3 }, recommended24: 6 },
        networks: [
          { ssid: 'HomeNet-5G', bssid: 'f0:9f:c2:aa:bb:cc', signalDbm: -47, signalPct: 92, band: '5 GHz', channel: 44, security: 'WPA2-Personal', phy: '802.11ac' },
          { ssid: 'HomeNet', bssid: 'f0:9f:c2:aa:bb:cd', signalDbm: -52, signalPct: 84, band: '2.4 GHz', channel: 6, security: 'WPA2-Personal', phy: '802.11n' },
          { ssid: 'Neighbor_2.4', bssid: '20:e5:2a:11:22:33', signalDbm: -68, signalPct: 60, band: '2.4 GHz', channel: 11, security: 'WPA2', phy: '802.11n' },
          { ssid: 'CoffeeShop', bssid: 'ac:84:c6:44:55:66', signalDbm: -79, signalPct: 40, band: '2.4 GHz', channel: 1, security: 'Open', phy: '802.11n' },
          { ssid: 'ATT-Fiber-9931', bssid: '3c:4a:92:77:88:99', signalDbm: -83, signalPct: 32, band: '5 GHz', channel: 149, security: 'WPA3', phy: '802.11ax' },
        ],
      });
    },
  });
}());
