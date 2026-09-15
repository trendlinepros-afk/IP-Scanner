'use strict';

/* global window, document, NT */

// IP Scanner view — device discovery (Advanced IP Scanner style).
(function scannerView() {
  const api = NT.api;
  const s = {
    hosts: new Map(), favorites: new Map(), scanning: false,
    sortKey: 'ip', sortDir: 'asc', filterText: '', aliveOnly: false,
    selectedIp: null, lastRange: '', wired: false, root: null,
  };

  const ipToInt = (ip) => { const p = String(ip).split('.').map(Number); return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0; };
  const q = (sel) => s.root.querySelector(sel);

  function html() {
    return `
    <div class="sc-toolbar">
      <select class="sc-iface iface-select" title="Network interface"></select>
      <input class="sc-range range-input" type="text" spellcheck="false" placeholder="e.g. 192.168.1.1-254  or  10.0.0.0/24" />
      <button class="sc-scan btn btn-primary"><span class="btn-icon">▶</span><span class="sc-scan-label">Scan</span></button>
      <div class="spacer"></div>
      <button class="sc-export btn">Export</button>
    </div>
    <div class="progress-wrap sc-progress hidden"><div class="progress-bar sc-progressbar"></div><div class="progress-text sc-progresstext"></div></div>
    <div class="filter-row">
      <input class="sc-filter filter-input" type="text" spellcheck="false" placeholder="Filter by IP, name, MAC or vendor…" />
      <label class="chk"><input type="checkbox" class="sc-aliveonly" /> Alive only</label>
      <div class="spacer"></div>
      <span class="sc-summary status-summary">Ready</span>
    </div>
    <div class="results">
      <table class="grid sc-table">
        <thead><tr>
          <th data-sort="status" class="col-status">Status</th>
          <th data-sort="name">Name</th>
          <th data-sort="ip" class="sorted-asc">IP</th>
          <th data-sort="mac">MAC address</th>
          <th data-sort="vendor">Manufacturer</th>
          <th data-sort="responseMs" class="col-ms">ms</th>
          <th data-sort="sharesText">Shared resources</th>
        </tr></thead>
        <tbody class="sc-tbody"></tbody>
      </table>
      <div class="empty-state sc-empty">
        <div class="empty-icon">🖧</div>
        <p>Enter an IP range and press <strong>Scan</strong> to discover devices on your network.</p>
        <p class="empty-hint">The range is prefilled from your active adapter.</p>
      </div>
    </div>
    <div class="statusbar">
      <span class="sc-hostcount">0 hosts</span>
      <span class="sc-alivecount pill up">0 alive</span>
      <span class="sc-elapsed"></span>
      <div class="spacer"></div>
    </div>
    <aside class="drawer sc-drawer hidden">
      <div class="drawer-head"><h2 class="sc-drawer-title">Host</h2><button class="sc-drawer-close btn icon-btn">✕</button></div>
      <div class="sc-drawer-body drawer-body"></div>
      <div class="drawer-console-wrap">
        <div class="drawer-console-head"><span>Console</span><button class="sc-console-clear btn tiny">Clear</button></div>
        <pre class="sc-console console"></pre>
      </div>
    </aside>`;
  }

  const passesFilter = (h) => {
    if (s.aliveOnly && h.status !== 'alive') return false;
    const query = s.filterText.trim().toLowerCase();
    if (!query) return true;
    return [h.ip, h.name, h.mac, h.vendor].filter(Boolean).some((v) => String(v).toLowerCase().includes(query));
  };

  function sorted() {
    const arr = Array.from(s.hosts.values()).filter(passesFilter);
    const { sortKey, sortDir } = s;
    arr.sort((a, b) => {
      let av; let bv;
      if (sortKey === 'ip') { av = ipToInt(a.ip); bv = ipToInt(b.ip); } else if (sortKey === 'responseMs') { av = a.responseMs == null ? Infinity : a.responseMs; bv = b.responseMs == null ? Infinity : b.responseMs; } else if (sortKey === 'status') { av = a.status === 'alive' ? 0 : 1; bv = b.status === 'alive' ? 0 : 1; } else if (sortKey === 'sharesText') { av = (a.shares || []).length; bv = (b.shares || []).length; } else { av = (a[sortKey] || '').toString().toLowerCase(); bv = (b[sortKey] || '').toString().toLowerCase(); }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return ipToInt(a.ip) - ipToInt(b.ip);
    });
    return arr;
  }

  const sharesHtml = (h) => (h.shares || []).map((x) => `<span class="share-badge" data-share="${x.type}">${x.label}</span>`).join('');

  function render() {
    const tbody = q('.sc-tbody'); tbody.textContent = '';
    for (const h of sorted()) {
      const tr = NT.el('tr'); tr.dataset.ip = h.ip;
      if (h.status !== 'alive') tr.classList.add('dead');
      if (h.ip === s.selectedIp) tr.classList.add('selected');
      const fav = s.favorites.has(h.ip) ? '<span class="fav-star">★</span>' : '';
      tr.innerHTML = `<td class="col-status"><span class="dot ${h.status === 'alive' ? 'up' : 'down'}"></span>${h.status === 'alive' ? 'Alive' : 'Dead'}</td>`
        + `<td>${NT.escapeHtml(h.name || '')}${fav}</td><td>${h.ip}</td><td class="mac">${NT.escapeHtml(h.mac || '')}</td>`
        + `<td>${NT.escapeHtml(h.vendor || '')}</td><td class="num">${h.responseMs != null ? h.responseMs : ''}</td><td>${sharesHtml(h)}</td>`;
      tbody.append(tr);
    }
    q('.sc-empty').classList.toggle('hidden', s.hosts.size > 0);
    const total = s.hosts.size; const alive = Array.from(s.hosts.values()).filter((h) => h.status === 'alive').length;
    q('.sc-hostcount').textContent = `${total} host${total === 1 ? '' : 's'}`;
    q('.sc-alivecount').textContent = `${alive} alive`;
  }

  async function startScan() {
    if (s.scanning) { await api.cancelScan(); return; }
    const range = q('.sc-range').value.trim();
    if (!range) { NT.toast('Enter an IP range first', 'err'); return; }
    s.hosts.clear(); s.selectedIp = null; render();
    q('.sc-progress').classList.remove('hidden'); q('.sc-progressbar').style.width = '0%';
    const res = await api.startScan(range, {});
    if (!res.ok) NT.toast(res.error || 'Could not start scan', 'err');
  }

  function setScanning(on) {
    s.scanning = on;
    const btn = q('.sc-scan'); btn.classList.toggle('scanning', on);
    q('.sc-scan-label').textContent = on ? 'Stop' : 'Scan';
    btn.querySelector('.btn-icon').textContent = on ? '■' : '▶';
  }

  // Context menu
  function ctx(host, x, y) {
    const menu = NT.$('ctxMenu'); menu.textContent = '';
    const has = (t) => (host.shares || []).some((sh) => sh.type === t);
    const fav = s.favorites.has(host.ip);
    const items = [
      { i: '🔍', l: 'Details', a: () => select(host.ip, true) },
      { i: '⟳', l: 'Rescan this host', a: () => rescan(host.ip) },
      { sep: 1 },
      { i: '📁', l: 'Explore file shares', d: !has('smb'), a: () => api.openShares(host.ip) },
      { i: '🌐', l: 'Open HTTP', d: !has('http'), a: () => api.openUrl(`http://${host.ip}`) },
      { i: '🔒', l: 'Open HTTPS', d: !has('https'), a: () => api.openUrl(`https://${host.ip}`) },
      { i: '📶', l: 'Open FTP', d: !has('ftp'), a: () => api.openUrl(`ftp://${host.ip}`) },
      { sep: 1 },
      { i: '🖥', l: 'Remote Desktop (RDP)', a: () => api.rdp(host.ip) },
      { i: '⌨', l: 'SSH', a: () => api.ssh(host.ip) },
      { i: '📞', l: 'Telnet', a: () => api.telnet(host.ip) },
      { sep: 1 },
      { i: '📡', l: 'Ping', a: () => tool(host, 'ping') },
      { i: '🧭', l: 'Traceroute', a: () => tool(host, 'traceroute') },
      { i: '⏻', l: 'Wake-on-LAN', d: !host.mac, a: () => wake(host) },
      { sep: 1 },
      { i: fav ? '★' : '☆', l: fav ? 'Remove favorite' : 'Add to favorites', a: () => toggleFav(host) },
      { i: '📋', l: 'Copy IP', a: () => copy(host.ip) },
    ];
    for (const it of items) {
      if (it.sep) { menu.append(NT.el('div', 'ctx-sep')); continue; }
      const row = NT.el('div', `ctx-item${it.d ? ' disabled' : ''}`);
      row.append(NT.el('span', 'ctx-ico', it.i), NT.el('span', null, it.l));
      row.addEventListener('click', () => { NT.hideCtx(); if (!it.d) it.a(); });
      menu.append(row);
    }
    menu.classList.remove('hidden');
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 6))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 6))}px`;
  }
  NT.hideCtx = () => NT.$('ctxMenu').classList.add('hidden');

  async function rescan(ip) { NT.toast(`Rescanning ${ip}…`); const rec = await api.rescanHost(ip, {}); s.hosts.set(ip, rec); render(); if (s.selectedIp === ip) drawer(rec); }
  async function wake(h) { if (!h.mac) return NT.toast('No MAC known', 'err'); const r = await api.wakeOnLan(h.mac); return NT.toast(r.ok ? `Magic packet sent to ${h.mac}` : `WoL failed: ${r.error}`, r.ok ? 'ok' : 'err'); }
  async function toggleFav(h) { if (s.favorites.has(h.ip)) { await api.removeFavorite(h.ip); s.favorites.delete(h.ip); } else { await api.addFavorite({ ip: h.ip, name: h.name, mac: h.mac }); s.favorites.set(h.ip, h); } render(); }
  function copy(t) { navigator.clipboard.writeText(t).then(() => NT.toast('Copied', 'ok', 1200), () => NT.toast('Copy failed', 'err')); }

  function select(ip, open) { s.selectedIp = ip; render(); const h = s.hosts.get(ip); if (h && open) { drawer(h); q('.sc-drawer').classList.remove('hidden'); } }
  function drawer(h) {
    q('.sc-drawer-title').textContent = h.name || h.ip;
    const body = q('.sc-drawer-body'); body.textContent = '';
    const dl = NT.el('dl', 'kv');
    const add = (k, v) => { dl.append(NT.el('dt', null, k), NT.el('dd', null, v || '—')); };
    add('Status', h.status === 'alive' ? 'Alive' : 'Dead'); add('IP address', h.ip); add('Host name', h.name);
    add('MAC address', h.mac); add('Manufacturer', h.vendor);
    add('Response', h.responseMs != null ? `${h.responseMs} ms (${h.method || '—'})` : '—');
    add('Open ports', (h.ports || []).join(', ')); add('Services', (h.services || []).map((x) => `${x.port}/${x.label}`).join(', '));
    body.append(dl);
    const actions = NT.el('div', 'drawer-actions');
    const mk = (l, fn) => { const b = NT.el('button', 'btn tiny', l); b.addEventListener('click', fn); return b; };
    actions.append(mk('Ping', () => tool(h, 'ping')), mk('Traceroute', () => tool(h, 'traceroute')), mk('RDP', () => api.rdp(h.ip)), mk('SSH', () => api.ssh(h.ip)), mk('Shares', () => api.openShares(h.ip)), mk('Wake-on-LAN', () => wake(h)), mk('Rescan', () => rescan(h.ip)));
    body.append(actions);
  }
  async function tool(h, t) {
    select(h.ip, true);
    const cons = q('.sc-console'); cons.textContent += `\n$ ${t} ${h.ip}\n`; cons.scrollTop = cons.scrollHeight;
    let res;
    if (t === 'ping') res = await api.ping(h.ip, 4); else if (t === 'traceroute') res = await api.traceroute(h.ip);
    cons.textContent += `${res && res.output ? res.output : '(no output)'}\n`; cons.scrollTop = cons.scrollHeight;
  }

  async function doExport(fmt) {
    const hosts = sorted(); if (hosts.length === 0) { NT.toast('Nothing to export', 'err'); return; }
    const res = await api.exportSave(fmt, hosts, { range: s.lastRange });
    NT.$('exportModal').classList.add('hidden');
    if (res.ok) { NT.toast(`Exported ${hosts.length} rows`, 'ok'); setTimeout(() => api.showInFolder(res.filePath), 300); } else if (!res.canceled) NT.toast('Export failed', 'err');
  }

  async function loadIfaces() {
    const ifaces = await api.interfaces(); const sel = q('.sc-iface'); sel.textContent = '';
    const auto = NT.el('option', null, 'Auto (custom range)'); auto.value = ''; sel.append(auto);
    for (const i of ifaces) { const o = NT.el('option', null, `${i.name} — ${i.address}`); o.value = i.suggestedRange; o.dataset.address = i.address; sel.append(o); }
    const primary = await api.primaryInterface(); const last = await api.getLastRange();
    if (last) { q('.sc-range').value = last; s.lastRange = last; } else if (primary) { q('.sc-range').value = primary.suggestedRange; s.lastRange = primary.suggestedRange; for (const o of sel.options) if (o.dataset.address === primary.address) { sel.value = o.value; break; } }
  }

  function wireEvents() {
    if (s.wired) return; s.wired = true;
    api.on('scan:start', (p) => { setScanning(true); q('.sc-summary').textContent = `Scanning ${p.total} addresses…`; });
    api.on('scan:progress', (p) => { const pct = p.total ? Math.round((p.done / p.total) * 100) : 0; q('.sc-progressbar').style.width = `${pct}%`; q('.sc-progresstext').textContent = `${p.done}/${p.total} · ${p.alive} alive`; q('.sc-summary').textContent = `Scanning… ${pct}%`; });
    api.on('scan:phase', (p) => { if (p.phase === 'enrich') q('.sc-summary').textContent = `Resolving ${p.count} hosts…`; });
    api.on('scan:enrichProgress', (p) => { q('.sc-progresstext').textContent = `Details ${p.done}/${p.total}`; });
    api.on('scan:host', (h) => { s.hosts.set(h.ip, h); render(); if (s.selectedIp === h.ip) drawer(h); });
    api.on('scan:done', (p) => {
      setScanning(false); q('.sc-progress').classList.add('hidden'); const secs = (p.elapsedMs / 1000).toFixed(1); q('.sc-elapsed').textContent = `${secs}s`;
      q('.sc-summary').textContent = p.cancelled ? `Stopped · ${p.alive} alive` : `Done · ${p.alive} of ${p.total} alive in ${secs}s`;
      NT.toast(p.cancelled ? 'Scan stopped' : `Scan complete — ${p.alive} alive`, p.cancelled ? '' : 'ok');
      if (!p.cancelled) {
        const hosts = Array.from(s.hosts.values()).filter((h) => h.status === 'alive').map((h) => ({ ip: h.ip, name: h.name, mac: h.mac, vendor: h.vendor }));
        NT.saveResult({ type: 'scan', title: 'Network Scan', summary: `${s.lastRange} · ${p.alive} of ${p.total} alive`, data: { range: s.lastRange, alive: p.alive, total: p.total, hosts } });
      }
    });
    api.on('scan:error', (p) => { setScanning(false); q('.sc-progress').classList.add('hidden'); NT.toast(p.message || 'Scan error', 'err'); q('.sc-summary').textContent = 'Error'; });
    api.on('menu:toggle-scan', () => { if (NT.state.view === 'scanner') startScan(); });
    api.on('menu:export', () => { if (NT.state.view === 'scanner') NT.$('exportModal').classList.remove('hidden'); });
    api.on('menu:new-scan', () => { if (NT.state.view === 'scanner') { s.hosts.clear(); render(); } });
  }

  NT.registerView({
    id: 'scanner',
    title: 'IP Scanner',
    icon: '🖧',
    desc: 'Discover every device on your LAN — IP, MAC, vendor, shares.',
    group: 'Discovery & Diagnostics',
    accent: '#2f7de1',
    build(section) {
      s.root = section; section.innerHTML = html();
      q('.sc-scan').addEventListener('click', startScan);
      q('.sc-range').addEventListener('keydown', (e) => { if (e.key === 'Enter') startScan(); });
      q('.sc-range').addEventListener('change', () => { s.lastRange = q('.sc-range').value.trim(); });
      q('.sc-iface').addEventListener('change', (e) => { if (e.target.value) { q('.sc-range').value = e.target.value; s.lastRange = e.target.value; } });
      q('.sc-filter').addEventListener('input', (e) => { s.filterText = e.target.value; render(); });
      q('.sc-aliveonly').addEventListener('change', (e) => { s.aliveOnly = e.target.checked; render(); });
      q('.sc-export').addEventListener('click', () => NT.$('exportModal').classList.remove('hidden'));
      section.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (s.sortKey === key) s.sortDir = s.sortDir === 'asc' ? 'desc' : 'asc'; else { s.sortKey = key; s.sortDir = 'asc'; }
        section.querySelectorAll('th[data-sort]').forEach((h) => h.classList.remove('sorted-asc', 'sorted-desc'));
        th.classList.add(s.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc'); render();
      }));
      const tbody = q('.sc-tbody');
      tbody.addEventListener('click', (e) => {
        const tr = e.target.closest('tr'); if (!tr) return;
        const badge = e.target.closest('.share-badge');
        if (badge) { const h = s.hosts.get(tr.dataset.ip); const t = badge.dataset.share; if (t === 'smb') api.openShares(h.ip); else if (t === 'http') api.openUrl(`http://${h.ip}`); else if (t === 'https') api.openUrl(`https://${h.ip}`); else if (t === 'ftp') api.openUrl(`ftp://${h.ip}`); return; }
        select(tr.dataset.ip, false);
      });
      tbody.addEventListener('dblclick', (e) => { const tr = e.target.closest('tr'); if (tr) select(tr.dataset.ip, true); });
      tbody.addEventListener('contextmenu', (e) => { const tr = e.target.closest('tr'); if (!tr) return; e.preventDefault(); select(tr.dataset.ip, false); ctx(s.hosts.get(tr.dataset.ip), e.clientX, e.clientY); });
      window.addEventListener('click', () => NT.hideCtx());
      q('.sc-drawer-close').addEventListener('click', () => q('.sc-drawer').classList.add('hidden'));
      q('.sc-console-clear').addEventListener('click', () => { q('.sc-console').textContent = ''; });
      // Shared export modal (scanner-owned)
      NT.$('exportClose').addEventListener('click', () => NT.$('exportModal').classList.add('hidden'));
      document.querySelectorAll('.export-fmt').forEach((b) => b.addEventListener('click', () => doExport(b.dataset.fmt)));
      wireEvents();
      loadIfaces();
      render();
    },
    demo() {
      const sample = [
        ['alive', 'gateway.local', '192.168.1.1', 'f0:9f:c2:1a:2b:3c', 'Ubiquiti Networks', 1, [{ type: 'http', label: 'HTTP' }, { type: 'https', label: 'HTTPS' }]],
        ['alive', 'DESKTOP-A12B', '192.168.1.14', 'b8:ca:3a:44:55:66', 'Dell Inc.', 2, [{ type: 'smb', label: 'File shares' }]],
        ['alive', 'macbook-pro', '192.168.1.22', 'a4:5e:60:77:88:99', 'Apple, Inc.', 4, []],
        ['alive', 'NAS-STORAGE', '192.168.1.40', '00:90:a9:12:34:56', 'Western Digital', 2, [{ type: 'smb', label: 'File shares' }, { type: 'http', label: 'HTTP' }]],
        ['dead', '', '192.168.1.99', '', '', null, []],
      ];
      s.hosts.clear();
      sample.forEach(([status, name, ip, mac, vendor, responseMs, shares]) => s.hosts.set(ip, { status, name, ip, mac, vendor, responseMs, shares, ports: [] }));
      q('.sc-summary').textContent = 'Done · 4 of 254 alive in 3.2s'; render();
    },
  });
}());
