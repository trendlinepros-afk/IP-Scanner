'use strict';

/* global NT, document, window, navigator */

/**
 * App Uninstaller — a Revo Uninstaller Pro-style system tool.
 * Tabs: Programs · Traced Programs · Forced Uninstall · Startup · Junk Cleaner · Backups.
 * This file holds the shared shell (tabs, modal / menu / review helpers) and the
 * Programs tab; the other tabs live in uninstaller-tools.js and register via
 * NT.UN.addTab(). Standalone: lives in the Clients screen's "Other Tools".
 */
(function uninstallerView() {
  const api = NT.api;
  const esc = NT.escapeHtml;
  const UN = { tabs: [], admin: false, supported: true, root: null, current: null };
  NT.UN = UN;

  UN.addTab = (def) => { UN.tabs.push(def); };

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------
  UN.fmtSize = (kb) => (kb && kb > 0 ? NT.fmt.bytes(kb * 1024) : '—');
  UN.fmtDate = (d) => {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(d || ''));
    return m ? `${m[1]}-${m[2]}-${m[3]}` : (d ? String(d) : '');
  };
  UN.dateMs = (d) => {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(d || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : 0;
  };
  // First executable in a command line.
  UN.exeOf = (cmd) => {
    const s = String(cmd || '').trim();
    if (s.startsWith('"')) { const e = s.indexOf('"', 1); return e > 0 ? s.slice(1, e) : ''; }
    const m = /^(.+?\.(exe|com|bat|cmd))(\s|$)/i.exec(s);
    return m ? m[1] : '';
  };
  UN.dirOf = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '');

  /** Generic modal. buttons: [{ label, cls, onClick(ctx) → false keeps it open }] */
  UN.modal = ({ title, body, wide, buttons = [], onClose }) => {
    const m = NT.el('div', 'modal un-modal');
    m.innerHTML = `<div class="modal-card ${wide ? 'wide un-wide' : ''}">
      <div class="modal-head"><h2></h2><button class="btn icon-btn un-x">✕</button></div>
      <div class="modal-body"></div><div class="modal-foot"><div class="spacer"></div></div></div>`;
    m.querySelector('h2').textContent = title;
    const bodyEl = m.querySelector('.modal-body');
    if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
    const ctx = { el: m, body: bodyEl, q: (s) => m.querySelector(s), close: () => { m.remove(); if (onClose) onClose(); }, buttons: {} };
    const foot = m.querySelector('.modal-foot');
    buttons.forEach((b) => {
      const btn = NT.el('button', `btn ${b.cls || ''}`, b.label);
      if (b.id) ctx.buttons[b.id] = btn;
      btn.addEventListener('click', async () => { const r = b.onClick ? await b.onClick(ctx) : undefined; if (r !== false) ctx.close(); });
      foot.append(btn);
    });
    m.querySelector('.un-x').addEventListener('click', ctx.close);
    document.body.append(m);
    return ctx;
  };
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const all = document.querySelectorAll('.un-modal');
    if (all.length && !all[all.length - 1].classList.contains('un-busy')) all[all.length - 1].querySelector('.un-x').click();
    UN.closeMenu();
  });

  UN.confirm = (title, html, okLabel = 'OK', danger = false) => new Promise((resolve) => {
    let answered = false;
    UN.modal({
      title,
      body: `<p>${html}</p>`,
      buttons: [
        { label: okLabel, cls: danger ? 'danger' : 'btn-primary', onClick: () => { answered = true; resolve(true); } },
        { label: 'Cancel', onClick: () => { answered = true; resolve(false); } },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });

  /** Floating context menu. items: [{ label, icon, onClick, disabled, sep, danger }] */
  UN.closeMenu = () => { const m = document.querySelector('.un-menu'); if (m) m.remove(); };
  UN.menu = (x, y, items) => {
    UN.closeMenu();
    const m = NT.el('div', 'un-menu');
    items.forEach((it) => {
      if (it.sep) { m.append(NT.el('div', 'un-menu-sep')); return; }
      const b = NT.el('button', `un-menu-item${it.danger ? ' danger' : ''}`);
      b.innerHTML = `<span class="un-menu-ico">${it.icon || ''}</span><span>${esc(it.label)}</span>`;
      b.disabled = !!it.disabled;
      b.addEventListener('click', () => { UN.closeMenu(); it.onClick(); });
      m.append(b);
    });
    document.body.append(m);
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    m.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
    setTimeout(() => document.addEventListener('mousedown', function off(e) {
      if (!m.contains(e.target)) { UN.closeMenu(); document.removeEventListener('mousedown', off); }
    }), 0);
  };

  const KIND = {
    registry: { icon: '🗄', label: 'Registry key' },
    regvalue: { icon: '🔑', label: 'Registry value' },
    folder: { icon: '📁', label: 'Folder' },
    file: { icon: '📄', label: 'File' },
    shortcut: { icon: '🔗', label: 'Shortcut' },
  };
  UN.KIND = KIND;
  UN.itemKey = (it) => (it.kind === 'regvalue' ? `${it.path}|${it.value}` : it.path);

  /**
   * Review & delete leftovers. groups: [{ title, items }]. onDelete(items) must
   * resolve to { results: [{ path, value, ok, error, how }], backupId }.
   */
  UN.openReview = ({ title, intro, groups, extraHtml, deleteLabel = 'Delete selected', onDelete, onDone }) => {
    const total = groups.reduce((a, g) => a + g.items.length, 0);
    const body = NT.el('div', 'un-review');
    body.innerHTML = `
      ${intro ? `<p class="muted un-review-intro">${intro}</p>` : ''}
      <div class="unin-left-warn">🛡 A backup is made automatically: registry items are exported to .reg files (restore them from the <b>Backups</b> tab) and files &amp; folders go to the Recycle Bin.</div>
      ${extraHtml || ''}
      <div class="unin-left-toolbar">
        <label class="checkbox inline"><input type="checkbox" class="un-r-all" checked /><span>Select all</span></label>
        <button class="btn tiny un-r-reg">Registry only</button><button class="btn tiny un-r-fs">Files only</button><button class="btn tiny un-r-none">None</button>
        <div class="spacer"></div><span class="un-r-count muted"></span>
      </div>
      <div class="unin-left-list"></div>`;
    const list = body.querySelector('.unin-left-list');
    const rows = [];
    groups.forEach((g) => {
      if (groups.length > 1 || g.title) list.append(NT.el('div', 'unin-left-group', g.title || ''));
      const sections = [['Registry', g.items.filter((i) => i.kind === 'registry' || i.kind === 'regvalue')],
        ['Files, folders & shortcuts', g.items.filter((i) => i.kind !== 'registry' && i.kind !== 'regvalue')]];
      sections.forEach(([label, items]) => {
        if (!items.length) return;
        list.append(NT.el('div', 'un-left-sub', `${label} (${items.length})`));
        items.forEach((it) => {
          const row = NT.el('label', 'unin-left-item');
          const gone = it.exists === false;
          const meta = it.kind === 'registry' ? `${it.values || 0} value(s)${it.subkeys ? ` · ${it.subkeys} subkey(s)` : ''}`
            : (it.kind === 'regvalue' ? (it.data ? String(it.data).slice(0, 60) : '') : (it.sizeBytes != null ? NT.fmt.bytes(it.sizeBytes) : ''));
          row.innerHTML = `
            <input type="checkbox" class="unin-left-check" ${gone ? 'disabled' : 'checked'} />
            <span class="unin-left-kind" title="${KIND[it.kind] ? KIND[it.kind].label : it.kind}">${KIND[it.kind] ? KIND[it.kind].icon : '•'}</span>
            <span class="unin-left-path" title="${esc(it.display || it.path)}">${esc(it.display || it.path)}</span>
            <span class="unin-left-size muted">${gone ? 'already removed' : esc(meta)}</span>`;
          if (gone) row.classList.add('removed');
          const cb = row.querySelector('input');
          cb.addEventListener('change', update);
          rows.push({ it, cb, row });
          list.append(row);
        });
      });
    });
    const ctx = UN.modal({
      title: title || `Leftovers found (${total})`,
      body,
      wide: true,
      buttons: [
        { id: 'del', label: deleteLabel, cls: 'danger', onClick: () => doDelete().then(() => false) },
        { id: 'close', label: 'Close', onClick: () => { if (onDone) onDone(); } },
      ],
    });
    function update() {
      const live = rows.filter((r) => !r.cb.disabled);
      const n = live.filter((r) => r.cb.checked).length;
      body.querySelector('.un-r-count').textContent = `${n} of ${live.length} selected`;
      body.querySelector('.un-r-all').checked = n > 0 && n === live.length;
      ctx.buttons.del.disabled = n === 0;
    }
    const setAll = (fn) => { rows.forEach((r) => { if (!r.cb.disabled) r.cb.checked = fn(r.it); }); update(); };
    body.querySelector('.un-r-all').addEventListener('change', (e) => setAll(() => e.target.checked));
    body.querySelector('.un-r-reg').addEventListener('click', () => setAll((i) => i.kind === 'registry' || i.kind === 'regvalue'));
    body.querySelector('.un-r-fs').addEventListener('click', () => setAll((i) => i.kind !== 'registry' && i.kind !== 'regvalue'));
    body.querySelector('.un-r-none').addEventListener('click', () => setAll(() => false));
    async function doDelete() {
      const chosen = rows.filter((r) => r.cb.checked && !r.cb.disabled);
      if (!chosen.length) return;
      if (!(await UN.confirm('Delete leftovers', `Delete <b>${chosen.length}</b> selected item(s)? A backup is created first.`, 'Delete', true))) return;
      ctx.buttons.del.disabled = true; ctx.buttons.del.textContent = 'Deleting…';
      ctx.el.classList.add('un-busy');
      try {
        const res = await onDelete(chosen.map((r) => r.it));
        const results = (res && res.results) || [];
        let ok = 0; let fail = 0;
        chosen.forEach((r) => {
          const hit = results.find((x) => x.path === r.it.path && (r.it.kind !== 'regvalue' || x.value === r.it.value));
          if (hit && hit.ok) { ok += 1; r.row.classList.add('removed'); r.cb.checked = false; r.cb.disabled = true; r.row.querySelector('.unin-left-size').textContent = hit.how === 'recycled' ? 'moved to Recycle Bin' : 'removed'; }
          else if (hit) { fail += 1; r.row.classList.add('failed'); r.row.querySelector('.unin-left-size').textContent = hit.error || 'failed'; }
        });
        NT.toast(fail ? `${ok} removed, ${fail} failed${UN.admin ? '' : ' — some items need administrator rights'}.` : `${ok} item(s) removed${res && res.backupId ? ' · backup saved' : ''}.`, fail ? 'err' : 'ok', 5000);
      } catch (err) { NT.toast(`Delete failed: ${err.message}`, 'err'); }
      ctx.el.classList.remove('un-busy');
      ctx.buttons.del.textContent = deleteLabel;
      update();
    }
    update();
    return ctx;
  };

  UN.adminHint = () => (UN.admin ? '' : ' <a href="#" class="un-elevate-link">Run as administrator</a> for machine-wide items.');
  UN.elevate = async () => {
    if (!(await UN.confirm('Run as administrator', 'IT Tools will restart with administrator rights (Windows will ask for permission) and reopen the uninstaller.', 'Restart as admin'))) return;
    const res = await api.relaunchAsAdmin('uninstaller');
    if (!res || !res.ok) NT.toast((res && res.error) || 'Could not elevate', 'err', 4000);
  };
  document.addEventListener('click', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('un-elevate-link')) { e.preventDefault(); UN.elevate(); }
  });

  // ---------------------------------------------------------------------------
  // Programs tab
  // ---------------------------------------------------------------------------
  const P = {
    el: null, apps: [], selected: new Set(), filter: '', cat: 'all', showSystem: false,
    sortKey: 'name', sortDir: 1, loaded: false, icons: {}, run: null, progress: null,
  };
  const pq = (s) => P.el.querySelector(s);

  function programsHtml() {
    return `
      <div class="unin-toolbar">
        <input class="unin-search filter-input" spellcheck="false" placeholder="Search programs…" />
        <div class="spacer"></div>
        <button class="btn un-export" title="Export the list">⇩ Export</button>
        <button class="btn unin-refresh" title="Reload the list">⟳ Refresh</button>
        <button class="btn btn-primary unin-uninstall" disabled>Uninstall selected</button>
      </div>
      <div class="unin-toolbar">
        <div class="un-chips">
          <button class="un-chip on" data-cat="all">All</button>
          <button class="un-chip" data-cat="program">Desktop programs</button>
          <button class="un-chip" data-cat="store">Store apps</button>
          <button class="un-chip" data-cat="recent">Recently installed</button>
          <button class="un-chip" data-cat="large">Large (500 MB+)</button>
        </div>
        <label class="checkbox inline un-sys"><input type="checkbox" class="un-showsys" /><span>Show system components</span></label>
      </div>
      <div class="unin-table-wrap">
        <table class="unin-table">
          <thead><tr>
            <th class="unin-c-check"><input type="checkbox" class="unin-all" title="Select all" /></th>
            <th class="unin-c-name sortable" data-sort="name">Name</th>
            <th class="unin-c-pub sortable" data-sort="publisher">Publisher</th>
            <th class="unin-c-ver">Version</th>
            <th class="unin-c-size sortable" data-sort="size">Size</th>
            <th class="unin-c-date sortable" data-sort="date">Installed</th>
            <th class="unin-c-type">Type</th>
            <th class="unin-c-act"></th>
          </tr></thead>
          <tbody class="unin-tbody"></tbody>
        </table>
        <div class="unin-empty muted hidden"></div>
      </div>
      <div class="un-status muted"><span class="un-status-l">—</span><div class="spacer"></div><span class="un-status-r">Tip: right-click a program for more actions · double-click to uninstall</span></div>`;
  }

  function visibleApps() {
    const q = P.filter.trim().toLowerCase();
    const now = Date.now();
    let list = P.apps.filter((a) => {
      if (a.system && !P.showSystem) return false;
      if (P.cat === 'program' && a.type !== 'program') return false;
      if (P.cat === 'store' && a.type !== 'store') return false;
      if (P.cat === 'recent' && !(UN.dateMs(a.installDate) > now - 30 * 86400e3)) return false;
      if (P.cat === 'large' && !(a.sizeKB > 500 * 1024)) return false;
      return !q || [a.name, a.publisher, a.version].filter(Boolean).some((v) => v.toLowerCase().includes(q));
    });
    const k = P.sortKey; const dir = P.sortDir;
    list = list.slice().sort((a, b) => {
      if (k === 'size') return ((a.sizeKB || 0) - (b.sizeKB || 0)) * dir;
      if (k === 'date') return (UN.dateMs(a.installDate) - UN.dateMs(b.installDate)) * dir;
      return String(a[k] || '').toLowerCase().localeCompare(String(b[k] || '').toLowerCase()) * dir;
    });
    return list;
  }

  function iconHtml(a) {
    const src = a.iconPath && P.icons[a.iconPath];
    if (src) return `<img class="un-ico" src="${src}" alt="" />`;
    return `<span class="un-ico un-ico-fb ${a.type}">${a.type === 'store' ? '▦' : '◆'}</span>`;
  }

  function render() {
    const tbody = pq('.unin-tbody');
    const list = visibleApps();
    const frag = document.createDocumentFragment();
    for (const a of list) {
      const tr = NT.el('tr', 'unin-row');
      const sel = P.selected.has(a.id);
      if (sel) tr.classList.add('sel');
      if (a.system) tr.classList.add('sys');
      tr.innerHTML = `
        <td class="unin-c-check"><input type="checkbox" class="unin-check" ${sel ? 'checked' : ''} /></td>
        <td class="unin-c-name"><div class="un-namecell"><span class="un-ico-wrap" data-icon="${esc(a.iconPath || '')}">${iconHtml(a)}</span><span class="unin-name" title="${esc(a.name)}">${esc(a.name)}</span></div></td>
        <td class="unin-c-pub" title="${esc(a.publisher || '')}">${esc(a.publisher || '—')}</td>
        <td class="unin-c-ver" title="${esc(a.version || '')}">${esc(a.version || '—')}</td>
        <td class="unin-c-size">${UN.fmtSize(a.sizeKB)}</td>
        <td class="unin-c-date">${esc(UN.fmtDate(a.installDate)) || '—'}</td>
        <td class="unin-c-type"><span class="unin-badge ${a.type}">${a.type === 'store' ? 'Store app' : 'Program'}</span>${a.system ? '<span class="unin-badge sysb">System</span>' : ''}</td>
        <td class="unin-c-act"><button class="btn tiny un-more" title="More actions">⋯</button></td>`;
      const toggle = (on) => {
        if (on) P.selected.add(a.id); else P.selected.delete(a.id);
        tr.classList.toggle('sel', on);
        tr.querySelector('.unin-check').checked = on;
        updateStatus();
      };
      tr.querySelector('.unin-check').addEventListener('click', (e) => { e.stopPropagation(); toggle(e.target.checked); });
      tr.querySelector('.un-more').addEventListener('click', (e) => { e.stopPropagation(); const r = e.target.getBoundingClientRect(); rowMenu(a, r.left, r.bottom); });
      tr.addEventListener('click', () => toggle(!P.selected.has(a.id)));
      tr.addEventListener('dblclick', (e) => { e.preventDefault(); openConfirm([a]); });
      tr.addEventListener('contextmenu', (e) => { e.preventDefault(); rowMenu(a, e.clientX, e.clientY); });
      frag.append(tr);
    }
    tbody.textContent = '';
    tbody.append(frag);
    const empty = pq('.unin-empty');
    if (!UN.supported) { empty.innerHTML = '🪟 The App Uninstaller works on Windows. On this platform it opens in preview mode.'; empty.classList.remove('hidden'); }
    else if (!list.length) { empty.textContent = P.loaded ? 'No programs match.' : 'Loading installed programs…'; empty.classList.remove('hidden'); }
    else empty.classList.add('hidden');
    pq('.unin-table').querySelectorAll('th.sortable').forEach((th) => {
      th.classList.toggle('sorted', th.dataset.sort === P.sortKey);
      th.dataset.dir = th.dataset.sort === P.sortKey ? (P.sortDir > 0 ? 'asc' : 'desc') : '';
    });
    updateStatus();
  }

  function updateStatus() {
    const vis = visibleApps();
    const chosen = P.apps.filter((a) => P.selected.has(a.id));
    const kb = chosen.reduce((s, a) => s + (a.sizeKB || 0), 0);
    const totalKb = vis.reduce((s, a) => s + (a.sizeKB || 0), 0);
    pq('.un-status-l').textContent = `${vis.length} program${vis.length === 1 ? '' : 's'} shown (${UN.fmtSize(totalKb)})`
      + (chosen.length ? ` · ${chosen.length} selected (${UN.fmtSize(kb)})` : '');
    const btn = pq('.unin-uninstall');
    btn.disabled = chosen.length === 0;
    btn.textContent = chosen.length > 1 ? `Uninstall ${chosen.length} selected` : 'Uninstall selected';
    pq('.unin-all').checked = vis.length > 0 && vis.every((a) => P.selected.has(a.id));
  }

  async function loadIcons() {
    const paths = [...new Set(P.apps.map((a) => a.iconPath).filter((p) => p && !(p in P.icons)))];
    if (!paths.length || !api.fileIcons) return;
    for (let i = 0; i < paths.length; i += 80) {
      // eslint-disable-next-line no-await-in-loop
      const got = await api.fileIcons(paths.slice(i, i + 80)).catch(() => ({}));
      Object.assign(P.icons, got);
      P.el.querySelectorAll('.un-ico-wrap').forEach((w) => {
        const src = P.icons[w.dataset.icon];
        if (src && !w.querySelector('img')) w.innerHTML = `<img class="un-ico" src="${src}" alt="" />`;
      });
    }
  }

  async function load() {
    if (NT._demo) return;
    P.loaded = false; P.selected.clear();
    pq('.un-status-l').textContent = 'Loading installed programs…';
    render();
    try {
      const res = await api.listInstalledApps();
      UN.supported = !!(res && res.supported);
      UN.setAdmin(!!(res && res.admin));
      P.apps = (res && res.apps) || [];
    } catch (err) {
      P.apps = [];
      NT.toast(`Could not list programs: ${err.message}`, 'err');
    }
    P.loaded = true;
    render();
    loadIcons();
  }
  UN.reloadPrograms = load;

  // --- row actions -----------------------------------------------------------
  function rowMenu(a, x, y) {
    const isProg = a.type === 'program';
    const canRepair = isProg && (a.msiGuid || a.modifyPath) && (a.canRepair !== false || a.canModify !== false);
    UN.menu(x, y, [
      { icon: '🗑', label: 'Uninstall…', onClick: () => openConfirm([a]) },
      { icon: '🛠', label: a.msiGuid ? 'Repair' : 'Modify / Repair', disabled: !canRepair, onClick: () => repair(a) },
      { icon: '🔎', label: 'Forced uninstall (scan for remnants)…', onClick: () => UN.showTab('forced', { name: a.name, publisher: a.publisher, folder: a.installLocation }) },
      { sep: true },
      { icon: '📂', label: 'Open install folder', disabled: !a.installLocation, onClick: () => api.openAppFolder(a.installLocation).then((r) => { if (!r.ok) NT.toast(r.error, 'err'); }) },
      { icon: '🗄', label: 'Open in Registry Editor', disabled: !isProg || !a.regPath, onClick: () => api.openInRegedit(a).then((r) => { if (!r.ok) NT.toast(r.error, 'err'); }) },
      { icon: '🌐', label: 'Search online', onClick: () => api.searchOnline(`${a.name} ${a.publisher || ''}`.trim()) },
      { icon: '📋', label: 'Copy name', onClick: () => { navigator.clipboard.writeText(a.name).then(() => NT.toast('Copied', 'ok', 1200)).catch(() => {}); } },
      { icon: 'ℹ️', label: 'Properties', onClick: () => properties(a) },
      { sep: true },
      { icon: '✂', label: 'Remove entry from list…', danger: true, disabled: !isProg || !a.regPath, onClick: () => removeEntry(a) },
    ]);
  }

  async function repair(a) {
    NT.toast(`Starting ${a.msiGuid ? 'repair' : 'modify'} for ${a.name}…`);
    const r = await api.repairApp(a);
    NT.toast(r.ok ? 'Done.' : (r.error || 'Repair failed'), r.ok ? 'ok' : 'err', 4000);
  }

  async function removeEntry(a) {
    if (!(await UN.confirm('Remove entry', `Remove <b>${esc(a.name)}</b> from the programs list? This only deletes its Uninstall registry entry (backed up first) — use it for broken entries whose uninstaller no longer works. Files are not touched.`, 'Remove entry', true))) return;
    const r = await api.removeUninstallEntry(a);
    const res = r && r.results && r.results[0];
    if (res && res.ok) { NT.toast('Entry removed · backup saved', 'ok'); P.apps = P.apps.filter((x) => x.id !== a.id); P.selected.delete(a.id); render(); }
    else NT.toast((res && res.error) || (r && r.error) || 'Failed', 'err', 5000);
  }

  function properties(a) {
    const rows = [
      ['Name', a.name], ['Version', a.version], ['Publisher', a.publisher], ['Type', a.type === 'store' ? 'Store app' : 'Desktop program'],
      ['Installed', UN.fmtDate(a.installDate)], ['Estimated size', UN.fmtSize(a.sizeKB)], ['Install location', a.installLocation],
      ['Uninstall command', a.uninstallString], ['Quiet uninstall', a.quietUninstallString], ['Modify command', a.modifyPath],
      ['MSI product code', a.msiGuid], ['Package', a.packageFullName], ['Registry key', a.regPath], ['Scope', a.scope],
      ['Website', a.urlInfo], ['Help', a.helpLink], ['Comments', a.comments], ['Install source', a.installSource],
    ].filter((r) => r[1]);
    UN.modal({
      title: a.name,
      wide: true,
      body: `<dl class="kv un-props">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`,
      buttons: [{ label: 'Close', cls: 'btn-primary' }],
    });
  }

  // --- uninstall flow --------------------------------------------------------
  function openConfirm(apps) {
    const chosen = apps || P.apps.filter((a) => P.selected.has(a.id));
    if (!chosen.length) return;
    const body = `
      <p class="muted">${chosen.length} program${chosen.length === 1 ? '' : 's'} will be uninstalled, one after another:</p>
      <ul class="unin-confirm-list">${chosen.slice(0, 50).map((a) => `<li>${esc(a.name)}</li>`).join('')}${chosen.length > 50 ? `<li class="muted">…and ${chosen.length - 50} more</li>` : ''}</ul>
      <label class="field checkbox"><input type="checkbox" class="u-scan" checked /><span><b>Scan for leftovers afterwards</b> (registry cleaner) — review &amp; delete what each program left behind.</span></label>
      <div class="un-modes">
        <label class="un-mode"><input type="radio" name="umode" value="safe" /><span><b>Safe</b><small>Install folder and the program's own registry entry only.</small></span></label>
        <label class="un-mode"><input type="radio" name="umode" value="moderate" checked /><span><b>Moderate</b> <em>recommended</em><small>+ name-matched registry keys, AppData / ProgramData folders, Start-menu shortcuts.</small></span></label>
        <label class="un-mode"><input type="radio" name="umode" value="advanced" /><span><b>Advanced</b><small>+ desktop shortcuts, startup entries, App Paths &amp; file associations, temp folders, empty publisher folders.</small></span></label>
      </div>
      <label class="field checkbox"><input type="checkbox" class="u-rp" ${UN.admin ? '' : 'disabled'} /><span>Create a System Restore point first${UN.admin ? '' : ' <span class="muted">(requires administrator)</span>'}</span></label>
      <label class="field checkbox"><input type="checkbox" class="u-silent" /><span>Silent / unattended where supported (skip each program's own uninstaller prompts)</span></label>
      ${UN.admin ? '' : `<p class="muted small">Some programs prompt for administrator permission (UAC).${UN.adminHint()}</p>`}`;
    const ctx = UN.modal({
      title: chosen.length === 1 ? `Uninstall ${chosen[0].name}` : `Uninstall ${chosen.length} programs`,
      body,
      buttons: [
        {
          label: 'Uninstall', cls: 'btn-primary',
          onClick: (c) => startUninstall(chosen, {
            scanAfter: c.q('.u-scan').checked,
            mode: (c.q('input[name="umode"]:checked') || {}).value || 'moderate',
            restorePoint: c.q('.u-rp').checked,
            silent: c.q('.u-silent').checked,
          }),
        },
        { label: 'Cancel' },
      ],
    });
    const sync = () => ctx.el.querySelectorAll('.un-mode input').forEach((r) => { r.disabled = !ctx.q('.u-scan').checked; });
    ctx.q('.u-scan').addEventListener('change', sync);
  }

  function stepRow(key, name) {
    const box = P.progress.q('.autorun-steps');
    let row = box.querySelector(`[data-step="${key}"]`);
    if (!row) {
      row = NT.el('div', 'autorun-step');
      row.dataset.step = key;
      row.innerHTML = '<span class="ar-ico">◷</span><span class="ar-name"></span><span class="ar-sum muted"></span>';
      box.append(row);
    }
    row.querySelector('.ar-name').textContent = name;
    return row;
  }

  function startUninstall(chosen, opts) {
    P.run = { apps: chosen, leftovers: [], mode: opts.mode };
    P.progress = UN.modal({
      title: 'Uninstalling…',
      body: `<div class="progress-wrap" style="margin-bottom:12px"><div class="progress-bar un-pbar"></div></div>
             <div class="autorun-steps"></div><p class="muted un-pmsg" style="margin-top:12px"></p>`,
      buttons: [
        { id: 'cancel', label: 'Cancel', cls: 'danger', onClick: () => { api.cancelUninstall(); P.progress.q('.un-pmsg').textContent = 'Cancelling after the current program…'; return false; } },
        { id: 'review', label: 'Review leftovers', cls: 'btn-primary', onClick: () => { reviewLeftovers(); } },
        { id: 'done', label: 'Done', onClick: () => { load(); } },
      ],
    });
    P.progress.el.classList.add('un-busy');
    P.progress.buttons.review.classList.add('hidden');
    P.progress.buttons.done.classList.add('hidden');
    P.progress.q('.un-pmsg').textContent = opts.scanAfter ? `Uninstalling, then scanning for leftovers (${opts.mode} mode)…` : 'Uninstalling…';
    if (opts.restorePoint) stepRow('rp', 'System Restore point');
    chosen.forEach((a, i) => stepRow(i, a.name));
    api.uninstallApps(chosen, opts).then((r) => { if (r && !r.ok) { NT.toast(r.error, 'err'); P.progress.close(); } });
  }

  function onProgress(p) {
    if (!P.progress) return;
    const row = stepRow(p.index < 0 ? 'rp' : p.index, p.app);
    const ico = row.querySelector('.ar-ico'); const sum = row.querySelector('.ar-sum');
    row.classList.remove('running');
    const set = (i, s, cls) => { ico.textContent = i; sum.textContent = s; if (cls) row.classList.add(cls); };
    if (p.phase === 'uninstalling') set('⟳', 'uninstalling…', 'running');
    else if (p.phase === 'restorepoint') set('⟳', 'creating restore point…', 'running');
    else if (p.phase === 'scanning') set('🔎', 'scanning for leftovers…', 'running');
    else if (p.phase === 'done') set('✔', p.reboot ? 'done — restart may be required' : 'done', 'ok');
    else if (p.phase === 'error') set('✕', p.error || 'failed', 'err');
    const total = p.total || 1;
    const done = p.index < 0 ? 0 : Math.min(total, p.index + (p.phase === 'done' || p.phase === 'error' ? 1 : 0));
    P.progress.q('.un-pbar').style.width = `${Math.round((done / total) * 100)}%`;
  }

  function onDone(p) {
    if (!P.progress) return;
    P.run.leftovers = (p && p.leftovers) || [];
    const res = (p && p.results) || [];
    const ok = res.filter((r) => r.ok).length; const fail = res.length - ok;
    const left = P.run.leftovers.reduce((a, g) => a + g.items.length, 0);
    P.progress.q('.un-pbar').style.width = '100%';
    P.progress.el.classList.remove('un-busy');
    P.progress.el.querySelector('h2').textContent = 'Uninstall complete';
    P.progress.q('.un-pmsg').textContent = p && p.error ? `Finished with an error: ${p.error}`
      : `${ok} uninstalled${fail ? `, ${fail} failed` : ''}${left ? ` · ${left} leftover item(s) found.` : (p && p.cancelled ? ' · cancelled.' : ' · no leftovers found.')}`;
    P.progress.buttons.cancel.classList.add('hidden');
    P.progress.buttons.done.classList.remove('hidden');
    if (left) { P.progress.buttons.review.classList.remove('hidden'); P.progress.buttons.review.textContent = `Review ${left} leftover item(s)`; }
  }

  function reviewLeftovers() {
    const groups = (P.run && P.run.leftovers) || [];
    if (!groups.length) return;
    UN.openReview({
      title: `Leftovers found (${groups.reduce((a, g) => a + g.items.length, 0)})`,
      intro: `Scan mode: <b>${esc(P.run.mode)}</b>. These items were left behind by the program's own uninstaller — review before deleting.`,
      groups: groups.map((g) => ({ title: g.app, items: g.items })),
      onDelete: (items) => api.removeLeftovers(items, `Leftovers: ${groups.map((g) => g.app).join(', ').slice(0, 80)}`),
      onDone: load,
    });
  }

  const programsTab = {
    id: 'programs',
    label: 'Programs',
    icon: '📦',
    build(el) {
      P.el = el;
      el.innerHTML = programsHtml();
      pq('.unin-search').addEventListener('input', (e) => { P.filter = e.target.value; render(); });
      pq('.unin-refresh').addEventListener('click', load);
      pq('.unin-uninstall').addEventListener('click', () => openConfirm());
      pq('.un-showsys').addEventListener('change', (e) => { P.showSystem = e.target.checked; render(); });
      pq('.un-export').addEventListener('click', (e) => {
        const r = e.target.getBoundingClientRect();
        const rows = visibleApps();
        UN.menu(r.left, r.bottom, [
          { icon: '📊', label: `Export ${rows.length} programs as CSV (Excel)`, onClick: () => api.exportAppList('csv', rows) },
          { icon: '🌐', label: `Export ${rows.length} programs as HTML`, onClick: () => api.exportAppList('html', rows) },
        ]);
      });
      el.querySelectorAll('.un-chip').forEach((c) => c.addEventListener('click', () => {
        el.querySelectorAll('.un-chip').forEach((x) => x.classList.toggle('on', x === c));
        P.cat = c.dataset.cat; render();
      }));
      pq('.unin-all').addEventListener('change', (e) => {
        visibleApps().forEach((a) => { if (e.target.checked) P.selected.add(a.id); else P.selected.delete(a.id); });
        render();
      });
      pq('.unin-table').querySelectorAll('th.sortable').forEach((th) => th.addEventListener('click', () => {
        const k = th.dataset.sort;
        if (P.sortKey === k) P.sortDir *= -1; else { P.sortKey = k; P.sortDir = k === 'name' || k === 'publisher' ? 1 : -1; }
        render();
      }));
      api.on('uninstall:progress', onProgress);
      api.on('uninstall:done', onDone);
      render();
    },
    onShow() { if (!P.loaded && !NT._demo) load(); },
    demo() {
      UN.supported = true; P.loaded = true;
      P.apps = [
        { id: '1', type: 'program', name: 'Google Chrome', publisher: 'Google LLC', version: '128.0.6613.120', sizeKB: 512000, installDate: '20240712', regPath: 'x', installLocation: 'C:\\Program Files\\Google\\Chrome' },
        { id: '2', type: 'program', name: '7-Zip 24.07 (x64)', publisher: 'Igor Pavlov', version: '24.07', sizeKB: 5600, installDate: '20240515', regPath: 'x' },
        { id: '3', type: 'program', name: 'Node.js', publisher: 'Node.js Foundation', version: '20.16.0', sizeKB: 89000, installDate: '20240803', regPath: 'x', msiGuid: '{x}' },
        { id: '4', type: 'program', name: 'Zoom Workplace', publisher: 'Zoom Video Communications, Inc.', version: '6.1.6', sizeKB: 402000, installDate: '20240901', regPath: 'x' },
        { id: '5', type: 'program', name: 'VLC media player', publisher: 'VideoLAN', version: '3.0.21', sizeKB: 178000, installDate: '20240220', regPath: 'x' },
        { id: '6', type: 'store', name: 'Windows Calculator', publisher: 'Microsoft Corporation', version: '11.2408.2.0', sizeKB: null },
        { id: '7', type: 'store', name: 'Spotify', publisher: 'Spotify AB', version: '1.245.0.0', sizeKB: null },
        { id: '8', type: 'program', name: 'Notepad++ (64-bit x64)', publisher: 'Notepad++ Team', version: '8.6.9', sizeKB: 12800, installDate: '20240610', regPath: 'x' },
        { id: '9', type: 'program', name: 'Microsoft Visual Studio Code', publisher: 'Microsoft Corporation', version: '1.92.2', sizeKB: 356000, installDate: '20240817', regPath: 'x' },
        { id: '10', type: 'program', name: 'Affinity Photo 2', publisher: 'Serif (Europe) Ltd', version: '2.6.5.3782', sizeKB: 1572864, installDate: '20251106', regPath: 'x' },
        { id: '11', type: 'program', name: 'AMD Chipset Software', publisher: 'Advanced Micro Devices, Inc.', version: '8.07.16.1035', sizeKB: 23552, installDate: '20250310', regPath: 'x' },
        { id: '12', type: 'program', name: 'Apple Software Update', publisher: 'Apple Inc.', version: '2.7.0.3', sizeKB: 4198, installDate: '20250414', regPath: 'x' },
        { id: '13', type: 'store', name: 'Armoury Crate', publisher: 'ASUSTeK COMPUTER INC.', version: '6.5.14.0', sizeKB: null },
        { id: '14', type: 'program', name: 'Discord', publisher: 'Discord Inc.', version: '1.0.9163', sizeKB: 98304, installDate: '20250902', regPath: 'x' },
        { id: '15', type: 'program', name: 'Steam', publisher: 'Valve Corporation', version: '2.10.91.91', sizeKB: 790000, installDate: '20250121', regPath: 'x' },
      ];
      P.selected = new Set(['2', '4']);
      render();
    },
  };
  UN.addTab(programsTab);

  // ---------------------------------------------------------------------------
  // Shell: tabs + admin badge
  // ---------------------------------------------------------------------------
  UN.setAdmin = (on) => {
    UN.admin = !!on;
    if (!UN.root) return;
    const b = UN.root.querySelector('.un-admin');
    b.innerHTML = UN.admin ? '<span class="un-admin-on">🛡 Administrator</span>' : '<button class="btn tiny un-elevate">🛡 Run as administrator</button>';
    const btn = b.querySelector('.un-elevate');
    if (btn) btn.addEventListener('click', UN.elevate);
  };

  UN.showTab = (id, arg) => {
    const def = UN.tabs.find((t) => t.id === id) || UN.tabs[0];
    UN.current = def.id;
    UN.root.querySelectorAll('.un-tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === def.id));
    UN.root.querySelectorAll('.un-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.tab !== def.id));
    if (def.onShow) { try { def.onShow(arg); } catch (_) { /* */ } }
  };

  NT.registerView({
    id: 'uninstaller',
    title: 'App Uninstaller',
    icon: '🗑',
    desc: 'Revo-style uninstaller: bulk uninstall, leftover & registry cleaner, install monitor, forced uninstall, startup manager, junk cleaner.',
    group: 'Other Tools',
    accent: '#e0654a',
    standalone: true,
    build(section) {
      section.classList.add('view-unin');
      section.innerHTML = '<div class="unin-wrap"><div class="un-tabs"><div class="un-tabbar"></div><div class="spacer"></div><div class="un-admin"></div></div></div>';
      UN.root = section;
      const wrap = section.querySelector('.unin-wrap');
      const bar = section.querySelector('.un-tabbar');
      UN.tabs.forEach((t) => {
        const b = NT.el('button', 'un-tab');
        b.dataset.tab = t.id;
        b.innerHTML = `<span>${t.icon}</span> ${esc(t.label)}`;
        b.addEventListener('click', () => UN.showTab(t.id));
        bar.append(b);
        const panel = NT.el('div', `un-panel hidden un-panel-${t.id}`);
        panel.dataset.tab = t.id;
        wrap.append(panel);
        t.build(panel);
      });
      UN.setAdmin(UN.admin);
      if (!NT._demo && api.isAdmin) api.isAdmin().then(UN.setAdmin).catch(() => {});
      UN.showTab('programs');
    },
    onEnter() { if (UN.current) UN.showTab(UN.current); },
    onLeave() { UN.closeMenu(); },
    demo(sub) {
      UN.setAdmin(true);
      const t = UN.tabs.find((x) => x.id === (sub || 'programs')) || UN.tabs[0];
      UN.tabs.forEach((x) => { if (x.demo) x.demo(); });
      UN.showTab(t.id);
    },
  });
}());
