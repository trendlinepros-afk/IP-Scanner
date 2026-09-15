'use strict';

/* global window, document */

/**
 * App shell for the IP Scanner network toolkit.
 * Provides a global `NT` namespace: shared helpers, a view router, a card-based
 * home page, reusable canvas chart/gauge widgets, and the shared Settings /
 * Update / About modals. Tool views register themselves via NT.registerView().
 */

const NT = {};
window.NT = NT;

NT.api = window.ipScanner;

// ---- tiny DOM helpers ----------------------------------------------------
NT.$ = (id) => document.getElementById(id);
NT.el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
NT.escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

NT.toast = (msg, kind, ms = 2600) => {
  const t = NT.$('toast');
  t.textContent = msg;
  t.className = `toast ${kind || ''}`;
  t.classList.remove('hidden');
  clearTimeout(NT._toastT);
  NT._toastT = setTimeout(() => t.classList.add('hidden'), ms);
};

// ---- formatting ----------------------------------------------------------
NT.fmt = {
  mbps: (n) => (n == null ? '—' : (n >= 1000 ? `${(n / 1000).toFixed(2)} Gbps` : `${n.toFixed(n < 10 ? 2 : 1)} Mbps`)),
  mbpsNum: (n) => (n == null ? '—' : (n >= 100 ? n.toFixed(0) : n.toFixed(1))),
  ms: (n) => (n == null ? '—' : `${(Math.round(n * 10) / 10)} ms`),
  bytes: (n) => {
    if (n == null) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
  },
  pct: (n) => (n == null ? '—' : `${Math.round(n)}%`),
  date: (ts) => { if (!ts) return '—'; try { return new Date(ts).toLocaleString(); } catch (_) { return String(ts); } },
  ago: (ts) => {
    if (!ts) return 'never';
    const sdiff = Math.max(0, (Date.now() - ts) / 1000);
    if (sdiff < 60) return 'just now';
    if (sdiff < 3600) return `${Math.floor(sdiff / 60)}m ago`;
    if (sdiff < 86400) return `${Math.floor(sdiff / 3600)}h ago`;
    return `${Math.floor(sdiff / 86400)}d ago`;
  },
};

// ---- state ---------------------------------------------------------------
NT.state = { settings: null, info: null, view: 'home' };
NT.activeClient = null;
NT._views = [];
NT._built = {};

/**
 * Register a tool view.
 * def = { id, title, icon, desc, group, accent, build(section), onEnter(), onLeave() }
 */
NT.registerView = (def) => { NT._views.push(def); };

NT._viewById = (id) => NT._views.find((v) => v.id === id);

// ---- router --------------------------------------------------------------
NT._hideAll = () => {
  NT.$('view-clients').classList.add('hidden');
  NT.$('view-home').classList.add('hidden');
  NT.$('appbar').classList.add('hidden');
  NT._views.forEach((v) => { const s = NT.$(`view-${v.id}`); if (s) s.classList.add('hidden'); });
};

NT.showView = (id) => {
  const def = NT._viewById(id);
  if (!def) return;
  if (!NT.activeClient) { NT.showClients(); return; }
  // Leave current
  const cur = NT._viewById(NT.state.view);
  if (cur && cur.onLeave) { try { cur.onLeave(); } catch (_) { /* */ } }

  // Build lazily
  const section = NT.$(`view-${id}`);
  if (!NT._built[id]) {
    try { def.build(section); } catch (err) { NT.toast(`Failed to open ${def.title}: ${err.message}`, 'err'); return; }
    NT._built[id] = true;
  }

  NT._hideAll();
  section.classList.remove('hidden');

  // App bar
  NT.$('appbar').classList.remove('hidden');
  NT.$('viewIcon').textContent = def.icon || '';
  NT.$('viewTitle').textContent = def.title;

  NT.state.view = id;
  window.scrollTo(0, 0);
  if (def.onEnter) { try { def.onEnter(); } catch (_) { /* */ } }
};

NT.goHome = () => {
  if (!NT.activeClient) { NT.showClients(); return; }
  const cur = NT._viewById(NT.state.view);
  if (cur && cur.onLeave) { try { cur.onLeave(); } catch (_) { /* */ } }
  NT._hideAll();
  NT.$('view-home').classList.remove('hidden');
  NT.state.view = 'home';
  window.scrollTo(0, 0);
};

NT.showClients = () => {
  const cur = NT._viewById(NT.state.view);
  if (cur && cur.onLeave) { try { cur.onLeave(); } catch (_) { /* */ } }
  NT._hideAll();
  NT.$('view-clients').classList.remove('hidden');
  NT.state.view = 'clients';
  NT._renderClients();
  window.scrollTo(0, 0);
};

// ---- reusable canvas widgets --------------------------------------------
/** Responsive live line chart. */
NT.LineChart = class {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = [];
    this.max = opts.max || null; // fixed max, else auto
    this.maxPoints = opts.maxPoints || 120;
    this.color = opts.color || '#4a94ec';
    this.fill = opts.fill !== false;
    this.unit = opts.unit || '';
    this.minMax = opts.minMax || 0; // floor for auto max
  }

  push(v) { this.data.push(v); if (this.data.length > this.maxPoints) this.data.shift(); this.draw(); }

  setData(arr) { this.data = arr.slice(-this.maxPoints); this.draw(); }

  clear() { this.data = []; this.draw(); }

  draw() {
    const c = this.canvas; const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 300; const h = c.clientHeight || 120;
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const vals = this.data.filter((x) => x != null);
    let max = this.max || (vals.length ? Math.max(...vals) : 1);
    max = Math.max(max * 1.15, this.minMax, 1);
    const pad = 4;

    // grid
    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue('--border').trim() || '#333';
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.globalAlpha = 0.5;
    for (let i = 1; i < 4; i += 1) { const y = (h / 4) * i; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.globalAlpha = 1;

    if (this.data.length < 2) return;
    const n = this.maxPoints;
    const step = w / (n - 1);
    const x0 = w - (this.data.length - 1) * step;
    const yFor = (v) => h - pad - (v / max) * (h - pad * 2);

    // fill
    if (this.fill) {
      ctx.beginPath();
      let started = false;
      this.data.forEach((v, i) => {
        const x = x0 + i * step;
        if (v == null) { started = false; return; }
        if (!started) { ctx.moveTo(x, yFor(v)); started = true; } else ctx.lineTo(x, yFor(v));
      });
      ctx.lineTo(x0 + (this.data.length - 1) * step, h);
      ctx.lineTo(x0, h);
      ctx.closePath();
      ctx.globalAlpha = 0.12; ctx.fillStyle = this.color; ctx.fill(); ctx.globalAlpha = 1;
    }

    // line
    ctx.beginPath(); ctx.strokeStyle = this.color; ctx.lineWidth = 2;
    let started = false;
    this.data.forEach((v, i) => {
      const x = x0 + i * step;
      if (v == null) { started = false; return; }
      if (!started) { ctx.moveTo(x, yFor(v)); started = true; } else ctx.lineTo(x, yFor(v));
    });
    ctx.stroke();

    // max label
    ctx.fillStyle = css.getPropertyValue('--text-muted').trim() || '#888';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(`${Math.round(max)}${this.unit}`, 4, 12);
  }
};

/** Arc speed gauge. value/max in same unit; label shows number + caption. */
NT.drawGauge = (canvas, value, max, caption) => {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 260; const h = canvas.clientHeight || 180;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2; const cy = h * 0.82; const r = Math.min(w / 2, h * 0.82) - 12;
  const start = Math.PI * 0.85; const end = Math.PI * 2.15;
  const css = getComputedStyle(document.documentElement);
  const track = css.getPropertyValue('--border').trim() || '#333';
  const accent = css.getPropertyValue('--accent').trim() || '#4a94ec';
  const text = css.getPropertyValue('--text').trim() || '#eee';
  const muted = css.getPropertyValue('--text-muted').trim() || '#888';

  ctx.lineCap = 'round';
  ctx.lineWidth = 12;
  ctx.strokeStyle = track;
  ctx.beginPath(); ctx.arc(cx, cy, r, start, end); ctx.stroke();

  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  ctx.strokeStyle = accent;
  ctx.beginPath(); ctx.arc(cx, cy, r, start, start + (end - start) * frac); ctx.stroke();

  ctx.fillStyle = text; ctx.textAlign = 'center';
  ctx.font = `700 ${Math.round(r * 0.42)}px system-ui, sans-serif`;
  ctx.fillText(NT.fmt.mbpsNum(value), cx, cy - r * 0.12);
  ctx.fillStyle = muted; ctx.font = '13px system-ui, sans-serif';
  ctx.fillText(caption || 'Mbps', cx, cy + r * 0.18);
};

// ---- home page -----------------------------------------------------------
NT._buildHome = () => {
  const grid = NT.$('cardGrid');
  grid.textContent = '';
  const groups = {};
  NT._views.forEach((v) => {
    if (v.hidden) return;
    (groups[v.group || 'Tools'] = groups[v.group || 'Tools'] || []).push(v);
  });
  const order = ['Speed & Throughput', 'WiFi & Connectivity', 'Discovery & Diagnostics', 'Tools'];
  const groupNames = Object.keys(groups).sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  for (const g of groupNames) {
    const section = NT.el('div', 'card-group');
    section.append(NT.el('h2', 'card-group-title', g));
    const cards = NT.el('div', 'cards');
    for (const v of groups[g]) {
      const card = NT.el('button', 'tool-card');
      card.dataset.tool = v.id;
      if (v.accent) card.style.setProperty('--card-accent', v.accent);
      card.innerHTML = `
        <div class="tool-icon">${v.icon || '◆'}</div>
        <div class="tool-meta">
          <div class="tool-name">${NT.escapeHtml(v.title)}</div>
          <div class="tool-desc">${NT.escapeHtml(v.desc || '')}</div>
        </div>
        <div class="tool-arrow">›</div>`;
      card.addEventListener('click', () => NT.showView(v.id));
      cards.append(card);
    }
    section.append(cards);
    grid.append(section);
  }
};

// ---- app bar / connection pill ------------------------------------------
NT.refreshNetPill = async () => {
  try {
    const [wifi, info] = await Promise.all([NT.api.wifiScan().catch(() => null), NT.api.netInfo().catch(() => null)]);
    let label = 'Ethernet';
    let icon = '🖧';
    if (wifi && wifi.current && wifi.current.ssid) { label = wifi.current.ssid; icon = '📶'; }
    const pill = NT.$('netPill');
    pill.textContent = `${icon} ${label}`;
    NT._conn = { wifi, info };
    // Home hero status
    const hero = NT.$('heroStatus');
    if (hero) {
      const pub = info && info.public ? info.public : {};
      hero.innerHTML = `
        <div class="hs-row"><span class="hs-k">Connection</span><span class="hs-v">${icon} ${NT.escapeHtml(label)}</span></div>
        <div class="hs-row"><span class="hs-k">Public IP</span><span class="hs-v">${NT.escapeHtml(pub.ip || '…')}</span></div>
        <div class="hs-row"><span class="hs-k">ISP</span><span class="hs-v">${NT.escapeHtml(pub.isp || '—')}</span></div>
        <div class="hs-row"><span class="hs-k">Gateway</span><span class="hs-v">${NT.escapeHtml((info && info.gateway) || '—')}</span></div>`;
    }
  } catch (_) { /* ignore */ }
};

// ---- Settings modal ------------------------------------------------------
NT.openSettings = () => {
  const s = NT.state.settings;
  NT.$('setTimeout').value = s.timeoutMs;
  NT.$('setConcurrency').value = s.concurrency;
  NT.$('setResolve').checked = s.resolveNames;
  NT.$('setPorts').checked = s.scanPorts;
  NT.$('setTcp').checked = s.tcpFallback;
  NT.$('setPortList').value = (s.portList || []).join(', ');
  NT.$('setTheme').value = s.theme || 'system';
  NT.$('setAutoUpdate').checked = s.autoCheckUpdates;
  NT.$('settingsModal').classList.remove('hidden');
};
NT._saveSettings = async () => {
  const portList = NT.$('setPortList').value.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => n > 0 && n < 65536);
  const patch = {
    timeoutMs: Math.max(200, parseInt(NT.$('setTimeout').value, 10) || 1000),
    concurrency: Math.max(1, Math.min(512, parseInt(NT.$('setConcurrency').value, 10) || 64)),
    resolveNames: NT.$('setResolve').checked,
    scanPorts: NT.$('setPorts').checked,
    tcpFallback: NT.$('setTcp').checked,
    portList: portList.length ? portList : undefined,
    theme: NT.$('setTheme').value,
    autoCheckUpdates: NT.$('setAutoUpdate').checked,
  };
  NT.state.settings = await NT.api.setSettings(patch);
  await NT.api.setTheme(NT.state.settings.theme);
  NT.$('settingsModal').classList.add('hidden');
  NT.toast('Settings saved', 'ok');
};

// ---- Update modal --------------------------------------------------------
NT.openUpdate = () => { NT.$('updateModal').classList.remove('hidden'); NT._checkUpdates(); };
NT._checkUpdates = async () => {
  if (!(NT.state.info && NT.state.info.updatesSupported)) { NT._renderUpdate({ state: 'unsupported' }); return; }
  NT._renderUpdate({ state: 'checking' });
  await NT.api.checkForUpdates();
};
NT._stripHtml = (s) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : String(s || ''));
NT._renderUpdate = (p) => {
  const s = p.state;
  const msg = NT.$('updateMessage'); const icon = NT.$('updateStatusIcon');
  const notes = NT.$('updateNotes'); const progWrap = NT.$('updateProgressWrap');
  const installBtn = NT.$('updateInstallBtn'); const checkBtn = NT.$('updateCheckBtn');
  progWrap.classList.add('hidden'); installBtn.classList.add('hidden'); notes.classList.add('hidden'); checkBtn.disabled = false;
  const ver = p.info && p.info.version ? ` (v${p.info.version})` : '';
  switch (s) {
    case 'unsupported':
      icon.textContent = 'ℹ';
      msg.textContent = NT.state.info && NT.state.info.isPortable
        ? 'Auto-update is available in the installed version. You are running the portable build.'
        : 'Auto-update is only active in the installed application (not in development).';
      break;
    case 'checking': icon.textContent = '⭯'; msg.textContent = 'Checking for updates…'; checkBtn.disabled = true; break;
    case 'available': icon.textContent = '⬇'; msg.textContent = `Update available${ver}. Downloading…`; checkBtn.disabled = true; break;
    case 'downloading': {
      icon.textContent = '⬇'; msg.textContent = `Downloading update${ver}…`; progWrap.classList.remove('hidden');
      const pr = p.progress || {}; NT.$('updateProgressBar').style.width = `${pr.percent || 0}%`;
      const mb = (n) => (n ? (n / 1048576).toFixed(1) : '0');
      NT.$('updateProgressText').textContent = `${pr.percent || 0}% · ${mb(pr.transferred)}/${mb(pr.total)} MB`;
      checkBtn.disabled = true; break;
    }
    case 'downloaded':
      icon.textContent = '✅'; msg.textContent = `Update${ver} downloaded and ready.`; installBtn.classList.remove('hidden');
      if (p.info && p.info.releaseNotes) { notes.textContent = NT._stripHtml(p.info.releaseNotes); notes.classList.remove('hidden'); }
      break;
    case 'none': icon.textContent = '✔'; msg.textContent = 'You are running the latest version.'; break;
    case 'error': icon.textContent = '⚠'; msg.textContent = `Update error: ${p.error || 'unknown'}`; break;
    default: icon.textContent = '⭯'; msg.textContent = 'Ready to check for updates.';
  }
};

// ---- About ---------------------------------------------------------------
NT.showAbout = () => {
  const i = NT.state.info || {};
  NT.$('aboutBody').innerHTML = `
    <p><strong>IP Scanner</strong> — Network Toolkit v${NT.escapeHtml(i.version || '?')}</p>
    <p class="muted">Speed tests, WiFi analysis, latency, traceroute, LAN throughput, DNS benchmarking, device discovery and more.</p>
    <dl class="kv">
      <dt>Platform</dt><dd>${NT.escapeHtml(i.platform || '')}</dd>
      <dt>Build</dt><dd>${i.isPortable ? 'Portable' : (i.isDev ? 'Development' : 'Installed')}</dd>
      <dt>Electron</dt><dd>${NT.escapeHtml(i.electron || '')}</dd>
      <dt>Node</dt><dd>${NT.escapeHtml(i.node || '')}</dd>
      <dt>Auto-update</dt><dd>${i.updatesSupported ? 'Enabled' : 'Not in this build'}</dd>
    </dl>`;
  NT.$('aboutModal').classList.remove('hidden');
};

NT._closeModals = () => ['settingsModal', 'updateModal', 'aboutModal', 'exportModal', 'clientModal', 'historyModal'].forEach((id) => NT.$(id).classList.add('hidden'));

// ---- Clients -------------------------------------------------------------
NT._clients = [];
NT._clientFilter = '';

NT._renderClients = async () => {
  if (NT._demo) {
    NT._clients = [
      { id: 'a', name: 'Acme Corp', company: 'Acme Corporation', testCount: 12, lastActivity: Date.now() - 3600e3 },
      { id: 'b', name: 'Riverside Dental', company: 'Riverside Dental Group', testCount: 5, lastActivity: Date.now() - 26 * 3600e3 },
      { id: 'c', name: 'Main St. Cafe', company: 'Main Street Cafe', testCount: 3, lastActivity: Date.now() - 3 * 86400e3 },
      { id: 'd', name: 'Northgate Offices', company: 'Northgate Property Mgmt', testCount: 21, lastActivity: Date.now() - 90 * 60e3 },
    ];
  } else {
    NT._clients = await NT.api.listClients().catch(() => []);
  }
  const grid = NT.$('clientsGrid'); grid.textContent = '';
  const q = NT._clientFilter.trim().toLowerCase();
  const list = NT._clients.filter((c) => !q || [c.name, c.company, c.contact].filter(Boolean).some((v) => v.toLowerCase().includes(q)));
  NT.$('clientsEmpty').classList.toggle('hidden', NT._clients.length > 0);
  for (const c of list) {
    const card = NT.el('button', 'client-card');
    card.innerHTML = `
      <div class="client-avatar">${NT.escapeHtml((c.name || '?').slice(0, 1).toUpperCase())}</div>
      <div class="client-info">
        <div class="client-name">${NT.escapeHtml(c.name)}</div>
        <div class="client-sub">${NT.escapeHtml(c.company || c.contact || '')}</div>
        <div class="client-stats"><span>${c.testCount} test${c.testCount === 1 ? '' : 's'}</span><span>·</span><span>${NT.fmt.ago(c.lastActivity)}</span></div>
      </div>
      <div class="client-open">›</div>`;
    card.addEventListener('click', () => NT.openClient(c.id));
    grid.append(card);
  }
  if (NT._clients.length && list.length === 0) grid.innerHTML = '<p class="muted" style="padding:20px">No clients match your search.</p>';
};

NT.openClient = async (id) => {
  const client = await NT.api.getClient(id);
  if (!client) { NT.toast('Client not found', 'err'); NT._renderClients(); return; }
  NT.activeClient = client;
  NT.$('clientBarName').innerHTML = `<strong>${NT.escapeHtml(client.name)}</strong>${client.company ? ` <span class="muted">· ${NT.escapeHtml(client.company)}</span>` : ''}`;
  NT.goHome();
  NT.refreshNetPill();
};

// Client create / edit modal
NT._editingClient = null;
NT.openClientModal = (client) => {
  NT._editingClient = client || null;
  NT.$('clientModalTitle').textContent = client ? 'Edit Client' : 'New Client';
  NT.$('cmSave').textContent = client ? 'Save' : 'Create';
  NT.$('cmDelete').classList.toggle('hidden', !client);
  NT.$('cmName').value = client ? client.name : '';
  NT.$('cmCompany').value = client ? client.company || '' : '';
  NT.$('cmContact').value = client ? client.contact || '' : '';
  NT.$('cmEmail').value = client ? client.email || '' : '';
  NT.$('cmPhone').value = client ? client.phone || '' : '';
  NT.$('cmSite').value = client ? client.site || '' : '';
  NT.$('cmNotes').value = client ? client.notes || '' : '';
  NT.$('clientModal').classList.remove('hidden');
  setTimeout(() => NT.$('cmName').focus(), 30);
};
NT._saveClientModal = async () => {
  const info = {
    name: NT.$('cmName').value.trim(),
    company: NT.$('cmCompany').value.trim(),
    contact: NT.$('cmContact').value.trim(),
    email: NT.$('cmEmail').value.trim(),
    phone: NT.$('cmPhone').value.trim(),
    site: NT.$('cmSite').value.trim(),
    notes: NT.$('cmNotes').value.trim(),
  };
  if (!info.name) { NT.toast('Client name is required', 'err'); return; }
  NT.$('clientModal').classList.add('hidden');
  if (NT._editingClient) {
    const updated = await NT.api.updateClient(NT._editingClient.id, info);
    if (NT.activeClient && NT.activeClient.id === updated.id) { NT.activeClient = updated; NT.$('clientBarName').innerHTML = `<strong>${NT.escapeHtml(updated.name)}</strong>${updated.company ? ` <span class="muted">· ${NT.escapeHtml(updated.company)}</span>` : ''}`; }
    NT.toast('Client updated', 'ok');
    if (NT.state.view === 'clients') NT._renderClients();
  } else {
    const created = await NT.api.createClient(info);
    NT.toast(`Client "${created.name}" created`, 'ok');
    NT.openClient(created.id);
  }
};
NT._deleteClientModal = async () => {
  if (!NT._editingClient) return;
  const c = NT._editingClient;
  if (!window.confirm(`Delete client "${c.name}" and all of its saved test results and reports? This cannot be undone.`)) return;
  await NT.api.deleteClient(c.id);
  NT.$('clientModal').classList.add('hidden');
  if (NT.activeClient && NT.activeClient.id === c.id) { NT.activeClient = null; NT.showClients(); } else NT._renderClients();
  NT.toast('Client deleted', 'ok');
};

// ---- Result saving (called by tool views) -------------------------------
NT.saveResult = async (record) => {
  if (!NT.activeClient) return null;
  try {
    const res = await NT.api.saveResult(NT.activeClient.id, record);
    if (res && res.ok) NT.toast('Saved to client report', 'ok', 1500);
    return res;
  } catch (_) { return null; }
};

// ---- History modal -------------------------------------------------------
NT._typeIcon = { speedtest: '⚡', lanspeed: '🚀', wifi: '📶', ping: '📡', traceroute: '🧭', dns: '🧩', ports: '🔓', scan: '🖧', test: '◆' };
NT.openHistory = async () => {
  if (!NT.activeClient) return;
  NT.$('historyTitle').textContent = `Test history — ${NT.activeClient.name}`;
  NT.$('historyModal').classList.remove('hidden');
  await NT._renderHistory();
};
NT._renderHistory = async () => {
  const history = await NT.api.clientHistory(NT.activeClient.id).catch(() => []);
  NT.$('historyCount').textContent = `${history.length} test${history.length === 1 ? '' : 's'} recorded`;
  const list = NT.$('historyList'); list.textContent = '';
  if (!history.length) { list.innerHTML = '<p class="muted" style="padding:16px">No tests recorded yet. Run a diagnostic and it will be saved here.</p>'; return; }
  history.slice().reverse().forEach((r) => {
    const row = NT.el('div', 'history-item');
    row.innerHTML = `
      <div class="hi-ico">${NT._typeIcon[r.type] || '◆'}</div>
      <div class="hi-main"><div class="hi-title">${NT.escapeHtml(r.title)}</div><div class="hi-sum">${NT.escapeHtml(r.summary || '')}</div></div>
      <div class="hi-time">${NT.escapeHtml(NT.fmt.date(r.timestamp))}</div>
      <button class="btn tiny hi-del" title="Delete">✕</button>`;
    row.querySelector('.hi-del').addEventListener('click', async () => { await NT.api.deleteResult(NT.activeClient.id, r.id); NT._renderHistory(); });
    list.append(row);
  });
};

// ---- PDF report ----------------------------------------------------------
NT.generateReport = async () => {
  if (!NT.activeClient) return;
  NT.toast('Generating PDF report…');
  const res = await NT.api.generateReport(NT.activeClient.id, true);
  if (res.ok) NT.toast(`Report saved (${res.count} tests) and opened`, 'ok', 4000);
  else NT.toast(`Report failed: ${res.error || 'unknown'}`, 'err', 5000);
};

// ---- init ----------------------------------------------------------------
NT.init = async () => {
  NT.state.info = await NT.api.appInfo();
  NT.state.settings = await NT.api.getSettings();
  await NT.api.setTheme(NT.state.settings.theme || 'system');
  NT.$('appVersion').textContent = `IP Scanner v${NT.state.info.version}${NT.state.info.isPortable ? ' · portable' : ''}`;

  // Create a section container per registered view.
  const views = NT.$('views');
  NT._views.forEach((v) => {
    const s = NT.el('section', 'view hidden');
    s.id = `view-${v.id}`;
    views.append(s);
  });

  NT._buildHome();

  // Shell wiring
  NT.$('backBtn').addEventListener('click', NT.goHome);
  NT.$('settingsBtn').addEventListener('click', NT.openSettings);
  NT.$('updateBtn').addEventListener('click', NT.openUpdate);
  NT.$('homeSettings').addEventListener('click', NT.openSettings);
  NT.$('homeUpdate').addEventListener('click', NT.openUpdate);
  NT.$('homeAbout').addEventListener('click', NT.showAbout);
  NT.$('netPill').addEventListener('click', () => NT.showView('netinfo'));

  // Settings modal
  NT.$('settingsSave').addEventListener('click', NT._saveSettings);
  NT.$('settingsCancel').addEventListener('click', () => NT.$('settingsModal').classList.add('hidden'));
  NT.$('settingsClose').addEventListener('click', () => NT.$('settingsModal').classList.add('hidden'));
  // Update modal
  NT.$('updateClose').addEventListener('click', () => NT.$('updateModal').classList.add('hidden'));
  NT.$('updateLaterBtn').addEventListener('click', () => NT.$('updateModal').classList.add('hidden'));
  NT.$('updateCheckBtn').addEventListener('click', NT._checkUpdates);
  NT.$('updateInstallBtn').addEventListener('click', () => NT.api.installUpdate());
  NT.api.on('update:state', (p) => NT._renderUpdate(p));
  // About modal
  NT.$('aboutClose').addEventListener('click', () => NT.$('aboutModal').classList.add('hidden'));
  NT.$('aboutOk').addEventListener('click', () => NT.$('aboutModal').classList.add('hidden'));

  // Clients screen wiring
  if (NT.$('appVersion2')) NT.$('appVersion2').textContent = `IP Scanner v${NT.state.info.version}`;
  NT.$('newClientBtn').addEventListener('click', () => NT.openClientModal(null));
  NT.$('clientsSettingsBtn').addEventListener('click', NT.openSettings);
  NT.$('clientSearch').addEventListener('input', (e) => { NT._clientFilter = e.target.value; NT._renderClients(); });

  // Client context bar (on the dashboard)
  NT.$('toClientsBtn').addEventListener('click', NT.showClients);
  NT.$('clientHistoryBtn').addEventListener('click', NT.openHistory);
  NT.$('clientReportBtn').addEventListener('click', NT.generateReport);
  NT.$('clientFolderBtn').addEventListener('click', () => { if (NT.activeClient) NT.api.openClientFolder(NT.activeClient.id); });
  NT.$('clientEditBtn').addEventListener('click', () => { if (NT.activeClient) NT.openClientModal(NT.activeClient); });

  // Client modal
  NT.$('cmSave').addEventListener('click', NT._saveClientModal);
  NT.$('cmCancel').addEventListener('click', () => NT.$('clientModal').classList.add('hidden'));
  NT.$('clientModalClose').addEventListener('click', () => NT.$('clientModal').classList.add('hidden'));
  NT.$('cmDelete').addEventListener('click', NT._deleteClientModal);
  NT.$('cmName').addEventListener('keydown', (e) => { if (e.key === 'Enter') NT._saveClientModal(); });

  // History modal
  NT.$('historyClose').addEventListener('click', () => NT.$('historyModal').classList.add('hidden'));
  NT.$('historyReport').addEventListener('click', NT.generateReport);
  NT.$('historyClear').addEventListener('click', async () => { if (NT.activeClient && window.confirm('Clear all saved tests for this client?')) { await NT.api.clearHistory(NT.activeClient.id); NT._renderHistory(); } });

  // Global keys + menu events
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { NT._closeModals(); if (NT.hideCtx) NT.hideCtx(); } });
  NT.api.on('menu:home', NT.goHome);
  NT.api.on('menu:settings', NT.openSettings);
  NT.api.on('menu:check-updates', NT.openUpdate);
  NT.api.on('menu:about', NT.showAbout);

  NT.refreshNetPill();
  setInterval(() => { if (NT.state.view === 'home') NT.refreshNetPill(); }, 30000);

  // Open to the Clients screen.
  NT.showClients();
};

// ---- demo navigation for screenshots ------------------------------------
NT.__demoNav = (view) => {
  NT._demo = true; // suppress live auto-loads so demo data is shown
  if (view === 'clients') { NT.activeClient = null; NT.showClients(); return; }
  // Ensure an active client so the dashboard and tools render.
  if (!NT.activeClient) NT.activeClient = { id: '__demo__', name: 'Acme Corp', company: 'Acme Corporation' };
  NT.$('clientBarName').innerHTML = '<strong>Acme Corp</strong> <span class="muted">· Acme Corporation</span>';
  if (view === 'home' || !view) { NT.goHome(); return; }
  NT.showView(view);
  const def = NT._viewById(view);
  if (def && def.demo) { try { def.demo(); } catch (_) { /* */ } }
};
window.__demoNav = NT.__demoNav;
