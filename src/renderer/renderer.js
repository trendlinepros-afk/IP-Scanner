'use strict';

/* global window, document */

// IP Scanner renderer. All privileged work goes through window.ipScanner (preload).
const api = window.ipScanner;

// ---- State ---------------------------------------------------------------
const state = {
  hosts: new Map(), // ip -> record
  favorites: new Map(), // ip -> fav
  scanning: false,
  sortKey: 'ip',
  sortDir: 'asc',
  filterText: '',
  aliveOnly: false,
  selectedIp: null,
  lastRange: '',
  scanStarted: 0,
  settings: null,
  info: null,
};

// ---- DOM helpers ---------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function ipToInt(ip) {
  const p = String(ip).split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function toast(msg, kind, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${kind || ''}`;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---- Rendering the grid --------------------------------------------------
function sharesHtml(host) {
  if (!host.shares || host.shares.length === 0) return '';
  return host.shares.map((s) => `<span class="share-badge" data-share="${s.type}">${s.label}</span>`).join('');
}

function passesFilter(host) {
  if (state.aliveOnly && host.status !== 'alive') return false;
  const q = state.filterText.trim().toLowerCase();
  if (!q) return true;
  return [host.ip, host.name, host.mac, host.vendor]
    .filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
}

function sortedHosts() {
  const arr = Array.from(state.hosts.values()).filter(passesFilter);
  const { sortKey, sortDir } = state;
  arr.sort((a, b) => {
    let av;
    let bv;
    if (sortKey === 'ip') {
      av = ipToInt(a.ip); bv = ipToInt(b.ip);
    } else if (sortKey === 'responseMs') {
      av = a.responseMs == null ? Infinity : a.responseMs;
      bv = b.responseMs == null ? Infinity : b.responseMs;
    } else if (sortKey === 'status') {
      av = a.status === 'alive' ? 0 : 1; bv = b.status === 'alive' ? 0 : 1;
    } else if (sortKey === 'sharesText') {
      av = (a.shares || []).length; bv = (b.shares || []).length;
    } else {
      av = (a[sortKey] || '').toString().toLowerCase();
      bv = (b[sortKey] || '').toString().toLowerCase();
    }
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return ipToInt(a.ip) - ipToInt(b.ip);
  });
  return arr;
}

function renderGrid() {
  const tbody = $('tbody');
  const rows = sortedHosts();
  tbody.textContent = '';

  for (const host of rows) {
    const tr = el('tr');
    tr.dataset.ip = host.ip;
    if (host.status !== 'alive') tr.classList.add('dead');
    if (host.ip === state.selectedIp) tr.classList.add('selected');

    const statusTd = el('td', 'col-status');
    statusTd.innerHTML = `<span class="dot ${host.status === 'alive' ? 'up' : 'down'}"></span>${host.status === 'alive' ? 'Alive' : 'Dead'}`;

    const nameTd = el('td');
    const isFav = state.favorites.has(host.ip);
    nameTd.innerHTML = `${escapeHtml(host.name || '')}${isFav ? '<span class="fav-star">★</span>' : ''}`;

    const ipTd = el('td'); ipTd.textContent = host.ip;
    const macTd = el('td', 'mac'); macTd.textContent = host.mac || '';
    const vendorTd = el('td'); vendorTd.textContent = host.vendor || '';
    const msTd = el('td', 'num'); msTd.textContent = host.responseMs != null ? host.responseMs : '';
    const shareTd = el('td'); shareTd.innerHTML = sharesHtml(host);

    tr.append(statusTd, nameTd, ipTd, macTd, vendorTd, msTd, shareTd);
    tbody.append(tr);
  }

  $('emptyState').classList.toggle('hidden', state.hosts.size > 0);
  updateStatusBar();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function updateStatusBar() {
  const total = state.hosts.size;
  const alive = Array.from(state.hosts.values()).filter((h) => h.status === 'alive').length;
  $('hostCount').textContent = `${total} host${total === 1 ? '' : 's'}`;
  $('aliveCount').textContent = `${alive} alive`;
}

// ---- Scan lifecycle ------------------------------------------------------
async function startScan() {
  if (state.scanning) {
    await api.cancelScan();
    return;
  }
  const range = $('range').value.trim();
  if (!range) {
    toast('Enter an IP range first', 'err');
    return;
  }
  state.hosts.clear();
  state.selectedIp = null;
  renderGrid();
  $('progressWrap').classList.remove('hidden');
  $('progressBar').style.width = '0%';
  state.scanStarted = Date.now();
  const res = await api.startScan(range, {});
  if (!res.ok) toast(res.error || 'Could not start scan', 'err');
}

function setScanningUI(on) {
  state.scanning = on;
  const btn = $('scanBtn');
  btn.classList.toggle('scanning', on);
  $('scanBtnLabel').textContent = on ? 'Stop' : 'Scan';
  btn.querySelector('.btn-icon').textContent = on ? '■' : '▶';
}

function wireScanEvents() {
  api.on('scan:start', (p) => {
    setScanningUI(true);
    $('statusSummary').textContent = `Scanning ${p.total} addresses…`;
  });

  api.on('scan:progress', (p) => {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    $('progressBar').style.width = `${pct}%`;
    $('progressText').textContent = `${p.done}/${p.total} · ${p.alive} alive`;
    $('statusSummary').textContent = `Scanning… ${pct}%`;
  });

  api.on('scan:phase', (p) => {
    if (p.phase === 'enrich') $('statusSummary').textContent = `Resolving ${p.count} hosts…`;
  });

  api.on('scan:enrichProgress', (p) => {
    $('progressText').textContent = `Details ${p.done}/${p.total}`;
  });

  api.on('scan:host', (host) => {
    state.hosts.set(host.ip, host);
    renderGrid();
    if (state.selectedIp === host.ip) renderDrawer(host);
  });

  api.on('scan:done', (p) => {
    setScanningUI(false);
    $('progressWrap').classList.add('hidden');
    const secs = (p.elapsedMs / 1000).toFixed(1);
    $('elapsed').textContent = `${secs}s`;
    $('statusSummary').textContent = p.cancelled
      ? `Stopped · ${p.alive} alive`
      : `Done · ${p.alive} of ${p.total} alive in ${secs}s`;
    toast(p.cancelled ? 'Scan stopped' : `Scan complete — ${p.alive} host(s) alive`, p.cancelled ? '' : 'ok');
  });

  api.on('scan:error', (p) => {
    setScanningUI(false);
    $('progressWrap').classList.add('hidden');
    toast(p.message || 'Scan error', 'err');
    $('statusSummary').textContent = 'Error';
  });
}

// ---- Context menu --------------------------------------------------------
function hideCtxMenu() { $('ctxMenu').classList.add('hidden'); }

function buildCtxMenu(host, x, y) {
  const menu = $('ctxMenu');
  menu.textContent = '';
  const isFav = state.favorites.has(host.ip);
  const hasHttp = (host.shares || []).some((s) => s.type === 'http');
  const hasHttps = (host.shares || []).some((s) => s.type === 'https');
  const hasFtp = (host.shares || []).some((s) => s.type === 'ftp');
  const hasSmb = (host.shares || []).some((s) => s.type === 'smb');

  const items = [
    { icon: '🔍', label: 'Details', act: () => selectHost(host.ip, true) },
    { icon: '⟳', label: 'Rescan this host', act: () => rescanHost(host.ip) },
    { sep: true },
    { icon: '📁', label: 'Explore file shares', dis: !hasSmb, act: () => api.openShares(host.ip) },
    { icon: '🌐', label: 'Open HTTP', dis: !hasHttp, act: () => api.openUrl(`http://${host.ip}`) },
    { icon: '🔒', label: 'Open HTTPS', dis: !hasHttps, act: () => api.openUrl(`https://${host.ip}`) },
    { icon: '📶', label: 'Open FTP', dis: !hasFtp, act: () => api.openUrl(`ftp://${host.ip}`) },
    { sep: true },
    { icon: '🖥', label: 'Remote Desktop (RDP)', act: () => api.rdp(host.ip) },
    { icon: '⌨', label: 'SSH', act: () => api.ssh(host.ip) },
    { icon: '📞', label: 'Telnet', act: () => api.telnet(host.ip) },
    { sep: true },
    { icon: '📡', label: 'Ping', act: () => runToolInDrawer(host, 'ping') },
    { icon: '🧭', label: 'Traceroute', act: () => runToolInDrawer(host, 'traceroute') },
    { icon: '🔎', label: 'NSLookup', act: () => runToolInDrawer(host, 'nslookup') },
    { icon: '⏻', label: 'Wake-on-LAN', dis: !host.mac, act: () => wakeHost(host) },
    { sep: true },
    { icon: isFav ? '★' : '☆', label: isFav ? 'Remove from favorites' : 'Add to favorites', act: () => toggleFavorite(host) },
    { icon: '📋', label: 'Copy IP', act: () => copyText(host.ip) },
    { icon: '📋', label: 'Copy row', act: () => copyText(`${host.status}\t${host.name}\t${host.ip}\t${host.mac}\t${host.vendor}`) },
  ];

  for (const item of items) {
    if (item.sep) { menu.append(el('div', 'ctx-sep')); continue; }
    const row = el('div', `ctx-item${item.dis ? ' disabled' : ''}`);
    row.append(el('span', 'ctx-ico', item.icon), el('span', null, item.label));
    row.addEventListener('click', () => { hideCtxMenu(); if (!item.dis) item.act(); });
    menu.append(row);
  }

  menu.classList.remove('hidden');
  // Keep on-screen.
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 6);
  const py = Math.min(y, window.innerHeight - rect.height - 6);
  menu.style.left = `${Math.max(4, px)}px`;
  menu.style.top = `${Math.max(4, py)}px`;
}

// ---- Host actions --------------------------------------------------------
async function rescanHost(ip) {
  toast(`Rescanning ${ip}…`);
  const rec = await api.rescanHost(ip, {});
  state.hosts.set(ip, rec);
  renderGrid();
  if (state.selectedIp === ip) renderDrawer(rec);
}

async function wakeHost(host) {
  if (!host.mac) return toast('No MAC address known for this host', 'err');
  const res = await api.wakeOnLan(host.mac);
  toast(res.ok ? `Magic packet sent to ${host.mac}` : `WoL failed: ${res.error}`, res.ok ? 'ok' : 'err');
  return res;
}

async function toggleFavorite(host) {
  if (state.favorites.has(host.ip)) {
    await api.removeFavorite(host.ip);
    state.favorites.delete(host.ip);
  } else {
    await api.addFavorite({ ip: host.ip, name: host.name, mac: host.mac });
    state.favorites.set(host.ip, { ip: host.ip, name: host.name, mac: host.mac });
  }
  renderGrid();
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied', 'ok', 1200), () => toast('Copy failed', 'err'));
}

// ---- Drawer --------------------------------------------------------------
function selectHost(ip, openDrawer) {
  state.selectedIp = ip;
  renderGrid();
  const host = state.hosts.get(ip);
  if (host && openDrawer) {
    renderDrawer(host);
    $('drawer').classList.remove('hidden');
  }
}

function renderDrawer(host) {
  $('drawerTitle').textContent = host.name || host.ip;
  const body = $('drawerBody');
  body.textContent = '';

  const kv = el('dl', 'kv');
  const add = (k, v) => {
    kv.append(el('dt', null, k), el('dd', null, v || '—'));
  };
  add('Status', host.status === 'alive' ? 'Alive' : 'Dead');
  add('IP address', host.ip);
  add('Host name', host.name);
  add('MAC address', host.mac);
  add('Manufacturer', host.vendor);
  add('Response', host.responseMs != null ? `${host.responseMs} ms (${host.method || '—'})` : '—');
  add('Open ports', (host.ports || []).join(', '));
  add('Services', (host.services || []).map((s) => `${s.port}/${s.label}`).join(', '));
  body.append(kv);

  const actions = el('div', 'drawer-actions');
  const mkBtn = (label, fn) => { const b = el('button', 'btn tiny', label); b.addEventListener('click', fn); return b; };
  actions.append(
    mkBtn('Ping', () => runToolInDrawer(host, 'ping')),
    mkBtn('Traceroute', () => runToolInDrawer(host, 'traceroute')),
    mkBtn('RDP', () => api.rdp(host.ip)),
    mkBtn('SSH', () => api.ssh(host.ip)),
    mkBtn('Shares', () => api.openShares(host.ip)),
    mkBtn('Wake-on-LAN', () => wakeHost(host)),
    mkBtn('Rescan', () => rescanHost(host.ip)),
    mkBtn(state.favorites.has(host.ip) ? 'Unfavorite' : 'Favorite', () => toggleFavorite(host)),
  );
  body.append(actions);
}

async function runToolInDrawer(host, tool) {
  selectHost(host.ip, true);
  const cons = $('console');
  cons.textContent += `\n$ ${tool} ${host.ip}\n`;
  cons.scrollTop = cons.scrollHeight;
  let res;
  if (tool === 'ping') res = await api.ping(host.ip, 4);
  else if (tool === 'traceroute') res = await api.traceroute(host.ip);
  else if (tool === 'nslookup') res = await api.nslookup(host.name || host.ip);
  cons.textContent += (res && res.output ? res.output : '(no output)') + '\n';
  cons.scrollTop = cons.scrollHeight;
}

// ---- Export --------------------------------------------------------------
async function doExport(format) {
  const hosts = sortedHosts();
  if (hosts.length === 0) { toast('Nothing to export', 'err'); return; }
  const res = await api.exportSave(format, hosts, { range: state.lastRange });
  $('exportModal').classList.add('hidden');
  if (res.ok) {
    toast(`Exported ${hosts.length} rows`, 'ok');
    setTimeout(() => api.showInFolder(res.filePath), 300);
  } else if (!res.canceled) {
    toast('Export failed', 'err');
  }
}

// ---- Updates -------------------------------------------------------------
function openUpdateModal() {
  $('updateModal').classList.remove('hidden');
  checkForUpdates();
}

async function checkForUpdates() {
  const supported = state.info && state.info.updatesSupported;
  if (!supported) {
    renderUpdateState({ state: 'unsupported' });
    return;
  }
  renderUpdateState({ state: 'checking' });
  await api.checkForUpdates();
}

function renderUpdateState(payload) {
  const s = payload.state;
  const msg = $('updateMessage');
  const icon = $('updateStatusIcon');
  const notes = $('updateNotes');
  const progWrap = $('updateProgressWrap');
  const installBtn = $('updateInstallBtn');
  const checkBtn = $('updateCheckBtn');

  progWrap.classList.add('hidden');
  installBtn.classList.add('hidden');
  notes.classList.add('hidden');
  checkBtn.disabled = false;

  const versionText = payload.info && payload.info.version ? ` (v${payload.info.version})` : '';

  switch (s) {
    case 'unsupported':
      icon.textContent = 'ℹ';
      msg.textContent = state.info && state.info.isPortable
        ? 'Auto-update is available in the installed version. You are running the portable build.'
        : 'Auto-update is only active in the installed application (not in development).';
      break;
    case 'checking':
      icon.textContent = '⭯'; msg.textContent = 'Checking for updates…'; checkBtn.disabled = true;
      break;
    case 'available':
      icon.textContent = '⬇'; msg.textContent = `Update available${versionText}. Downloading…`; checkBtn.disabled = true;
      break;
    case 'downloading': {
      icon.textContent = '⬇';
      msg.textContent = `Downloading update${versionText}…`;
      progWrap.classList.remove('hidden');
      const p = payload.progress || {};
      $('updateProgressBar').style.width = `${p.percent || 0}%`;
      const mb = (n) => (n ? (n / 1048576).toFixed(1) : '0');
      $('updateProgressText').textContent = `${p.percent || 0}% · ${mb(p.transferred)}/${mb(p.total)} MB`;
      checkBtn.disabled = true;
      break;
    }
    case 'downloaded':
      icon.textContent = '✅';
      msg.textContent = `Update${versionText} downloaded and ready to install.`;
      installBtn.classList.remove('hidden');
      if (payload.info && payload.info.releaseNotes) {
        notes.textContent = stripHtml(payload.info.releaseNotes);
        notes.classList.remove('hidden');
      }
      break;
    case 'none':
      icon.textContent = '✔'; msg.textContent = 'You are running the latest version.';
      break;
    case 'error':
      icon.textContent = '⚠'; msg.textContent = `Update error: ${payload.error || 'unknown'}`;
      break;
    default:
      icon.textContent = '⭯'; msg.textContent = 'Ready to check for updates.';
  }
}

function stripHtml(s) {
  if (typeof s !== 'string') return String(s || '');
  return s.replace(/<[^>]+>/g, '').trim();
}

// ---- Settings ------------------------------------------------------------
function openSettings() {
  const s = state.settings;
  $('setTimeout').value = s.timeoutMs;
  $('setConcurrency').value = s.concurrency;
  $('setResolve').checked = s.resolveNames;
  $('setPorts').checked = s.scanPorts;
  $('setTcp').checked = s.tcpFallback;
  $('setPortList').value = (s.portList || []).join(', ');
  $('setTheme').value = s.theme || 'system';
  $('setAutoUpdate').checked = s.autoCheckUpdates;
  $('settingsModal').classList.remove('hidden');
}

async function saveSettings() {
  const portList = $('setPortList').value.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => n > 0 && n < 65536);
  const patch = {
    timeoutMs: Math.max(200, parseInt($('setTimeout').value, 10) || 1000),
    concurrency: Math.max(1, Math.min(512, parseInt($('setConcurrency').value, 10) || 64)),
    resolveNames: $('setResolve').checked,
    scanPorts: $('setPorts').checked,
    tcpFallback: $('setTcp').checked,
    portList: portList.length ? portList : undefined,
    theme: $('setTheme').value,
    autoCheckUpdates: $('setAutoUpdate').checked,
  };
  state.settings = await api.setSettings(patch);
  await api.setTheme(state.settings.theme);
  $('settingsModal').classList.add('hidden');
  toast('Settings saved', 'ok');
}

// ---- Interfaces ----------------------------------------------------------
async function loadInterfaces() {
  const ifaces = await api.interfaces();
  const sel = $('iface');
  sel.textContent = '';
  const auto = el('option', null, 'Auto (custom range)');
  auto.value = '';
  sel.append(auto);
  for (const iface of ifaces) {
    const o = el('option', null, `${iface.name} — ${iface.address}`);
    o.value = iface.suggestedRange;
    o.dataset.address = iface.address;
    sel.append(o);
  }
  const primary = await api.primaryInterface();
  const last = await api.getLastRange();
  if (last) {
    $('range').value = last;
    state.lastRange = last;
  } else if (primary) {
    $('range').value = primary.suggestedRange;
    state.lastRange = primary.suggestedRange;
    // Select the matching option.
    for (const opt of sel.options) {
      if (opt.dataset.address === primary.address) { sel.value = opt.value; break; }
    }
  }
}

// ---- Wiring --------------------------------------------------------------
function wireDom() {
  $('scanBtn').addEventListener('click', startScan);
  $('range').addEventListener('keydown', (e) => { if (e.key === 'Enter') startScan(); });
  $('range').addEventListener('change', () => { state.lastRange = $('range').value.trim(); });
  $('iface').addEventListener('change', (e) => {
    if (e.target.value) { $('range').value = e.target.value; state.lastRange = e.target.value; }
  });

  $('filter').addEventListener('input', (e) => { state.filterText = e.target.value; renderGrid(); });
  $('aliveOnly').addEventListener('change', (e) => { state.aliveOnly = e.target.checked; renderGrid(); });

  // Sorting
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else { state.sortKey = key; state.sortDir = 'asc'; }
      document.querySelectorAll('th[data-sort]').forEach((h) => h.classList.remove('sorted-asc', 'sorted-desc'));
      th.classList.add(state.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      renderGrid();
    });
  });

  // Row interactions
  const tbody = $('tbody');
  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    const badge = e.target.closest('.share-badge');
    if (badge) {
      const host = state.hosts.get(tr.dataset.ip);
      const type = badge.dataset.share;
      if (type === 'smb') api.openShares(host.ip);
      else if (type === 'http') api.openUrl(`http://${host.ip}`);
      else if (type === 'https') api.openUrl(`https://${host.ip}`);
      else if (type === 'ftp') api.openUrl(`ftp://${host.ip}`);
      return;
    }
    selectHost(tr.dataset.ip, false);
  });
  tbody.addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr'); if (tr) selectHost(tr.dataset.ip, true);
  });
  tbody.addEventListener('contextmenu', (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    e.preventDefault();
    selectHost(tr.dataset.ip, false);
    buildCtxMenu(state.hosts.get(tr.dataset.ip), e.clientX, e.clientY);
  });
  window.addEventListener('click', hideCtxMenu);
  window.addEventListener('resize', hideCtxMenu);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideCtxMenu(); closeAllModals(); } });

  // Drawer
  $('drawerClose').addEventListener('click', () => $('drawer').classList.add('hidden'));
  $('consoleClear').addEventListener('click', () => { $('console').textContent = ''; });

  // Toolbar buttons
  $('exportBtn').addEventListener('click', () => $('exportModal').classList.remove('hidden'));
  $('settingsBtn').addEventListener('click', openSettings);
  $('updateBtn').addEventListener('click', openUpdateModal);

  // Settings modal
  $('settingsSave').addEventListener('click', saveSettings);
  $('settingsCancel').addEventListener('click', () => $('settingsModal').classList.add('hidden'));
  $('settingsClose').addEventListener('click', () => $('settingsModal').classList.add('hidden'));

  // Update modal
  $('updateClose').addEventListener('click', () => $('updateModal').classList.add('hidden'));
  $('updateLaterBtn').addEventListener('click', () => $('updateModal').classList.add('hidden'));
  $('updateCheckBtn').addEventListener('click', checkForUpdates);
  $('updateInstallBtn').addEventListener('click', () => api.installUpdate());

  // Export modal
  $('exportClose').addEventListener('click', () => $('exportModal').classList.add('hidden'));
  document.querySelectorAll('.export-fmt').forEach((b) => b.addEventListener('click', () => doExport(b.dataset.fmt)));

  // About modal
  $('aboutClose').addEventListener('click', () => $('aboutModal').classList.add('hidden'));
  $('aboutOk').addEventListener('click', () => $('aboutModal').classList.add('hidden'));

  // Update events from main
  api.on('update:state', (payload) => renderUpdateState(payload));

  // Menu events from main process
  api.on('menu:new-scan', () => { state.hosts.clear(); renderGrid(); });
  api.on('menu:toggle-scan', startScan);
  api.on('menu:export', () => $('exportModal').classList.remove('hidden'));
  api.on('menu:settings', openSettings);
  api.on('menu:check-updates', openUpdateModal);
  api.on('menu:about', showAbout);
}

function closeAllModals() {
  ['settingsModal', 'updateModal', 'exportModal', 'aboutModal'].forEach((id) => $(id).classList.add('hidden'));
}

function showAbout() {
  const i = state.info || {};
  $('aboutBody').innerHTML = `
    <p><strong>IP Scanner</strong> v${escapeHtml(i.version || '?')}</p>
    <p class="muted">An open network / IP scanner — Advanced IP Scanner alternative.</p>
    <dl class="kv">
      <dt>Platform</dt><dd>${escapeHtml(i.platform || '')}</dd>
      <dt>Build</dt><dd>${i.isPortable ? 'Portable' : (i.isDev ? 'Development' : 'Installed')}</dd>
      <dt>Electron</dt><dd>${escapeHtml(i.electron || '')}</dd>
      <dt>Node</dt><dd>${escapeHtml(i.node || '')}</dd>
      <dt>OUI entries</dt><dd>${i.ouiCount || 0}</dd>
      <dt>Auto-update</dt><dd>${i.updatesSupported ? 'Enabled' : 'Not in this build'}</dd>
    </dl>`;
  $('aboutModal').classList.remove('hidden');
}

// ---- Boot ----------------------------------------------------------------
async function boot() {
  state.info = await api.appInfo();
  state.settings = await api.getSettings();
  $('appVersion').textContent = `IP Scanner v${state.info.version}${state.info.isPortable ? ' · portable' : ''}`;
  await api.setTheme(state.settings.theme || 'system');

  const favs = await api.getFavorites();
  favs.forEach((f) => state.favorites.set(f.ip, f));

  await loadInterfaces();
  wireScanEvents();
  wireDom();
  renderGrid();
}

boot().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Boot failed', err);
  toast(`Startup error: ${err.message}`, 'err', 6000);
});
