'use strict';

/* global NT, document, window */

/**
 * App Uninstaller — a Revo-Uninstaller-style tool.
 *  - Lists installed programs (registry Uninstall keys) and Store apps.
 *  - Bulk-select with checkboxes; uninstall one or many.
 *  - Optional post-uninstall scan for leftover registry entries + files/folders,
 *    which you can review and delete (the built-in registry cleaner).
 * Standalone: lives in the Clients screen's "Other Tools" section, needs no client.
 * Windows-only; degrades to a clear notice elsewhere.
 */
(function uninstallerView() {
  const api = NT.api;
  const s = {
    root: null, supported: true, loaded: false, apps: [], selected: new Set(),
    filter: '', sortKey: 'name', sortDir: 1, wired: false, run: null,
  };
  const q = (sel) => s.root.querySelector(sel);

  const TYPE_BADGE = { program: 'Program', store: 'Store app' };
  const KIND_ICON = { registry: '🗄', folder: '📁', file: '📄' };

  function fmtSize(app) {
    if (app.sizeKB && app.sizeKB > 0) return NT.fmt.bytes(app.sizeKB * 1024);
    return '—';
  }
  function fmtInstallDate(d) {
    if (!d) return '';
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(d));
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return String(d);
  }

  function shellHtml() {
    return `
    <div class="unin-wrap">
      <div class="unin-toolbar">
        <input class="unin-search filter-input" spellcheck="false" placeholder="Search programs…" />
        <span class="unin-count muted">—</span>
        <div class="spacer"></div>
        <button class="unin-refresh btn" title="Reload the list">⟳ Refresh</button>
        <button class="unin-uninstall btn btn-primary" disabled>Uninstall selected</button>
      </div>
      <p class="unin-note muted">Select one or more programs, then <b>Uninstall selected</b>. You'll be asked whether to scan for
      leftover registry entries &amp; files afterwards. Some programs may prompt for administrator permission (UAC).</p>
      <div class="unin-table-wrap">
        <table class="unin-table">
          <thead><tr>
            <th class="unin-c-check"><input type="checkbox" class="unin-all" title="Select all" /></th>
            <th class="unin-c-name sortable" data-sort="name">Name</th>
            <th class="unin-c-pub sortable" data-sort="publisher">Publisher</th>
            <th class="unin-c-ver">Version</th>
            <th class="unin-c-size sortable" data-sort="size">Size</th>
            <th class="unin-c-type">Type</th>
          </tr></thead>
          <tbody class="unin-tbody"></tbody>
        </table>
      </div>
      <div class="unin-empty muted hidden"></div>
    </div>`;
  }

  // --- dialogs (built once, appended to <body>) ---------------------------
  function buildDialogs() {
    if (document.getElementById('uninConfirmModal')) return;
    const html = `
    <div id="uninConfirmModal" class="modal hidden">
      <div class="modal-card">
        <div class="modal-head"><h2>Uninstall programs</h2><button id="uninConfirmClose" class="btn icon-btn">✕</button></div>
        <div class="modal-body">
          <p id="uninConfirmCount" class="muted"></p>
          <ul id="uninConfirmList" class="unin-confirm-list"></ul>
          <label class="field checkbox"><input id="uninScanAfter" type="checkbox" checked /><span><b>Scan for leftovers afterwards</b> — find leftover registry entries and files/folders and let me review &amp; delete them.</span></label>
          <label class="field checkbox"><input id="uninSilent" type="checkbox" /><span>Silent / unattended where supported (skip the program's own uninstaller prompts).</span></label>
        </div>
        <div class="modal-foot">
          <div class="spacer"></div>
          <button id="uninConfirmGo" class="btn btn-primary">Uninstall</button>
          <button id="uninConfirmCancel" class="btn">Cancel</button>
        </div>
      </div>
    </div>

    <div id="uninProgressModal" class="modal hidden">
      <div class="modal-card">
        <div class="modal-head"><h2>Uninstalling…</h2><button id="uninProgressClose" class="btn icon-btn hidden">✕</button></div>
        <div class="modal-body">
          <div class="progress-wrap" style="margin-bottom:12px"><div id="uninProgressBar" class="progress-bar"></div></div>
          <div id="uninProgressSteps" class="autorun-steps"></div>
          <p id="uninProgressMsg" class="muted" style="margin-top:12px">Working…</p>
        </div>
        <div class="modal-foot">
          <div class="spacer"></div>
          <button id="uninReviewBtn" class="btn btn-primary hidden">Review leftovers</button>
          <button id="uninProgressDone" class="btn hidden">Done</button>
          <button id="uninProgressCancel" class="btn danger">Cancel</button>
        </div>
      </div>
    </div>

    <div id="uninLeftoversModal" class="modal hidden">
      <div class="modal-card wide">
        <div class="modal-head"><h2>Leftover items found</h2><button id="uninLeftClose" class="btn icon-btn">✕</button></div>
        <div class="modal-body">
          <div class="unin-left-warn">⚠ Review carefully. Deleting removes these registry entries, files and folders permanently. Only checked items are deleted. Registry / <code>Program Files</code> items may require running as administrator.</div>
          <div class="unin-left-toolbar"><label class="checkbox inline"><input id="uninLeftAll" type="checkbox" checked /><span>Select all</span></label><span id="uninLeftCount" class="muted"></span></div>
          <div id="uninLeftList" class="unin-left-list"></div>
        </div>
        <div class="modal-foot">
          <div class="spacer"></div>
          <button id="uninLeftDelete" class="btn danger">Delete selected</button>
          <button id="uninLeftKeep" class="btn">Keep all / Close</button>
        </div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    wireDialogs();
  }

  const $g = (id) => document.getElementById(id);

  function wireDialogs() {
    $g('uninConfirmClose').addEventListener('click', () => $g('uninConfirmModal').classList.add('hidden'));
    $g('uninConfirmCancel').addEventListener('click', () => $g('uninConfirmModal').classList.add('hidden'));
    $g('uninConfirmGo').addEventListener('click', startUninstall);
    $g('uninProgressDone').addEventListener('click', () => { $g('uninProgressModal').classList.add('hidden'); load(); });
    $g('uninProgressClose').addEventListener('click', () => { $g('uninProgressModal').classList.add('hidden'); load(); });
    $g('uninProgressCancel').addEventListener('click', () => { api.cancelUninstall(); $g('uninProgressMsg').textContent = 'Cancelling after the current program…'; });
    $g('uninReviewBtn').addEventListener('click', () => { $g('uninProgressModal').classList.add('hidden'); openLeftovers(s.run && s.run.leftovers); });
    $g('uninLeftClose').addEventListener('click', () => { $g('uninLeftoversModal').classList.add('hidden'); load(); });
    $g('uninLeftKeep').addEventListener('click', () => { $g('uninLeftoversModal').classList.add('hidden'); load(); });
    $g('uninLeftAll').addEventListener('change', (e) => {
      $g('uninLeftList').querySelectorAll('.unin-left-check').forEach((c) => { c.checked = e.target.checked; });
      updateLeftCount();
    });
    $g('uninLeftDelete').addEventListener('click', deleteLeftovers);
  }

  // --- rendering ----------------------------------------------------------
  function sortedFiltered() {
    const query = s.filter.trim().toLowerCase();
    let list = s.apps.filter((a) => !query
      || [a.name, a.publisher, a.version].filter(Boolean).some((v) => v.toLowerCase().includes(query)));
    const k = s.sortKey; const dir = s.sortDir;
    list = list.slice().sort((a, b) => {
      let av; let bv;
      if (k === 'size') { av = a.sizeKB || 0; bv = b.sizeKB || 0; return (av - bv) * dir; }
      av = String(a[k] || '').toLowerCase(); bv = String(b[k] || '').toLowerCase();
      return av.localeCompare(bv) * dir;
    });
    return list;
  }

  function render() {
    const tbody = q('.unin-tbody');
    const list = sortedFiltered();
    tbody.textContent = '';
    for (const a of list) {
      const tr = NT.el('tr', 'unin-row');
      if (s.selected.has(a.id)) tr.classList.add('sel');
      tr.dataset.id = a.id;
      const checked = s.selected.has(a.id) ? 'checked' : '';
      tr.innerHTML = `
        <td class="unin-c-check"><input type="checkbox" class="unin-check" ${checked} /></td>
        <td class="unin-c-name"><span class="unin-ico">${a.type === 'store' ? '🟦' : '📦'}</span><span class="unin-name" title="${NT.escapeHtml(a.name)}">${NT.escapeHtml(a.name)}</span>${a.installDate ? `<span class="unin-date muted">${NT.escapeHtml(fmtInstallDate(a.installDate))}</span>` : ''}</td>
        <td class="unin-c-pub" title="${NT.escapeHtml(a.publisher || '')}">${NT.escapeHtml(a.publisher || '—')}</td>
        <td class="unin-c-ver">${NT.escapeHtml(a.version || '—')}</td>
        <td class="unin-c-size">${fmtSize(a)}</td>
        <td class="unin-c-type"><span class="unin-badge ${a.type}">${TYPE_BADGE[a.type] || a.type}</span></td>`;
      const toggle = (on) => {
        if (on) s.selected.add(a.id); else s.selected.delete(a.id);
        tr.classList.toggle('sel', on);
        tr.querySelector('.unin-check').checked = on;
        updateToolbar();
      };
      tr.querySelector('.unin-check').addEventListener('click', (e) => { e.stopPropagation(); toggle(e.target.checked); });
      tr.addEventListener('click', () => toggle(!s.selected.has(a.id)));
      tbody.append(tr);
    }
    const emptyEl = q('.unin-empty');
    if (!s.supported) {
      emptyEl.innerHTML = '🪟 The App Uninstaller is available on Windows only. On this platform it runs in preview mode.';
      emptyEl.classList.remove('hidden');
    } else if (list.length === 0) {
      emptyEl.textContent = s.apps.length ? 'No programs match your search.' : 'No programs found.';
      emptyEl.classList.remove('hidden');
    } else {
      emptyEl.classList.add('hidden');
    }
    // reflect header sort indicators
    q('.unin-table').querySelectorAll('th.sortable').forEach((th) => {
      th.classList.toggle('sorted', th.dataset.sort === s.sortKey);
      th.dataset.dir = th.dataset.sort === s.sortKey ? (s.sortDir > 0 ? 'asc' : 'desc') : '';
    });
    updateToolbar();
  }

  function updateToolbar() {
    const n = s.selected.size;
    q('.unin-count').textContent = `${s.apps.length} program${s.apps.length === 1 ? '' : 's'}${n ? ` · ${n} selected` : ''}`;
    const btn = q('.unin-uninstall');
    btn.disabled = n === 0;
    btn.textContent = n > 1 ? `Uninstall ${n} selected` : 'Uninstall selected';
    const all = q('.unin-all');
    const visible = sortedFiltered();
    all.checked = visible.length > 0 && visible.every((a) => s.selected.has(a.id));
  }

  async function load() {
    if (NT._demo) return;
    q('.unin-count').textContent = 'Loading…';
    s.selected.clear();
    try {
      const res = await api.listInstalledApps();
      s.supported = !!(res && res.supported);
      s.apps = (res && res.apps) || [];
    } catch (err) {
      s.supported = false; s.apps = [];
      NT.toast(`Could not list programs: ${err.message}`, 'err');
    }
    s.loaded = true;
    render();
  }

  // --- uninstall flow -----------------------------------------------------
  function openConfirm() {
    const chosen = s.apps.filter((a) => s.selected.has(a.id));
    if (!chosen.length) return;
    $g('uninConfirmCount').textContent = `${chosen.length} program${chosen.length === 1 ? '' : 's'} will be uninstalled:`;
    const ul = $g('uninConfirmList'); ul.textContent = '';
    chosen.slice(0, 40).forEach((a) => { const li = NT.el('li', '', a.name); ul.append(li); });
    if (chosen.length > 40) ul.append(NT.el('li', 'muted', `…and ${chosen.length - 40} more`));
    $g('uninScanAfter').checked = true;
    $g('uninSilent').checked = false;
    $g('uninConfirmModal').classList.remove('hidden');
  }

  function stepRow(i, name) {
    let row = document.getElementById(`unin-step-${i}`);
    if (!row) {
      row = NT.el('div', 'autorun-step');
      row.id = `unin-step-${i}`;
      row.innerHTML = '<span class="ar-ico">◷</span><span class="ar-name"></span><span class="ar-sum muted"></span>';
      $g('uninProgressSteps').append(row);
    }
    row.querySelector('.ar-name').textContent = name;
    return row;
  }

  function startUninstall() {
    const chosen = s.apps.filter((a) => s.selected.has(a.id));
    if (!chosen.length) return;
    const silent = $g('uninSilent').checked;
    const scanAfter = $g('uninScanAfter').checked;
    s.run = { apps: chosen, leftovers: null };
    $g('uninConfirmModal').classList.add('hidden');
    $g('uninProgressSteps').textContent = '';
    $g('uninProgressBar').style.width = '0%';
    $g('uninProgressMsg').textContent = scanAfter ? 'Uninstalling, then scanning for leftovers…' : 'Uninstalling…';
    $g('uninReviewBtn').classList.add('hidden');
    $g('uninProgressDone').classList.add('hidden');
    $g('uninProgressClose').classList.add('hidden');
    $g('uninProgressCancel').classList.remove('hidden');
    chosen.forEach((a, i) => stepRow(i, a.name));
    $g('uninProgressModal').classList.remove('hidden');
    api.uninstallApps(chosen, { silent, scanAfter });
  }

  function onProgress(p) {
    const row = stepRow(p.index, p.app);
    const ico = row.querySelector('.ar-ico');
    const sum = row.querySelector('.ar-sum');
    row.classList.remove('running');
    if (p.phase === 'uninstalling') { ico.textContent = '⟳'; row.classList.add('running'); sum.textContent = 'uninstalling…'; }
    else if (p.phase === 'scanning') { ico.textContent = '🔎'; row.classList.add('running'); sum.textContent = 'scanning for leftovers…'; }
    else if (p.phase === 'done') { ico.textContent = '✔'; row.classList.add('ok'); sum.textContent = p.reboot ? 'done (reboot may be required)' : 'done'; }
    else if (p.phase === 'error') { ico.textContent = '✕'; row.classList.add('err'); sum.textContent = p.error || 'failed'; }
    const total = p.total || (s.run && s.run.apps.length) || 1;
    const done = Math.min(total, p.index + (p.phase === 'done' || p.phase === 'error' ? 1 : 0));
    $g('uninProgressBar').style.width = `${Math.round((done / total) * 100)}%`;
  }

  function onDone(p) {
    if (s.run) s.run.leftovers = (p && p.leftovers) || [];
    $g('uninProgressBar').style.width = '100%';
    $g('uninProgressCancel').classList.add('hidden');
    const okCount = ((p && p.results) || []).filter((r) => r.ok).length;
    const failCount = ((p && p.results) || []).filter((r) => !r.ok).length;
    const leftCount = ((p && p.leftovers) || []).reduce((a, g) => a + (g.items ? g.items.length : 0), 0);
    if (p && p.error) { $g('uninProgressMsg').textContent = `Finished with an error: ${p.error}`; }
    else {
      $g('uninProgressMsg').textContent = `${okCount} uninstalled${failCount ? `, ${failCount} failed` : ''}`
        + (leftCount ? ` · ${leftCount} leftover item(s) found.` : (p && p.cancelled ? ' · cancelled.' : ' · no leftovers found.'));
    }
    if (leftCount > 0) { $g('uninReviewBtn').classList.remove('hidden'); $g('uninReviewBtn').textContent = `Review ${leftCount} leftover item(s)`; }
    $g('uninProgressDone').classList.remove('hidden');
    $g('uninProgressClose').classList.remove('hidden');
  }

  // --- leftovers review ---------------------------------------------------
  function openLeftovers(groups) {
    const list = $g('uninLeftList'); list.textContent = '';
    (groups || []).forEach((g) => {
      const head = NT.el('div', 'unin-left-group', g.app);
      list.append(head);
      (g.items || []).forEach((it) => {
        const row = NT.el('label', 'unin-left-item');
        const size = it.kind === 'registry' ? `${it.values || 0} value(s)` : (it.sizeBytes != null ? NT.fmt.bytes(it.sizeBytes) : '');
        row.innerHTML = `
          <input type="checkbox" class="unin-left-check" checked />
          <span class="unin-left-kind" title="${it.kind}">${KIND_ICON[it.kind] || '•'}</span>
          <span class="unin-left-path">${NT.escapeHtml(it.display || it.path)}</span>
          <span class="unin-left-size muted">${NT.escapeHtml(size)}</span>`;
        const cb = row.querySelector('.unin-left-check');
        cb._item = it;
        cb.addEventListener('change', updateLeftCount);
        list.append(row);
      });
    });
    $g('uninLeftAll').checked = true;
    updateLeftCount();
    $g('uninLeftoversModal').classList.remove('hidden');
  }

  function updateLeftCount() {
    const boxes = [...$g('uninLeftList').querySelectorAll('.unin-left-check')];
    const n = boxes.filter((b) => b.checked).length;
    $g('uninLeftCount').textContent = `${n} of ${boxes.length} selected`;
    $g('uninLeftDelete').disabled = n === 0;
  }

  async function deleteLeftovers() {
    const boxes = [...$g('uninLeftList').querySelectorAll('.unin-left-check')];
    const items = boxes.filter((b) => b.checked).map((b) => b._item).filter(Boolean);
    if (!items.length) return;
    if (!window.confirm(`Permanently delete ${items.length} leftover item(s)? This cannot be undone.`)) return;
    $g('uninLeftDelete').disabled = true;
    $g('uninLeftDelete').textContent = 'Deleting…';
    try {
      const res = await api.removeLeftovers(items);
      const results = (res && res.results) || [];
      const ok = results.filter((r) => r.ok).length;
      const fail = results.filter((r) => !r.ok);
      // Reflect per-row outcome.
      boxes.forEach((b) => {
        if (!b.checked || !b._item) return;
        const r = results.find((x) => x.path === b._item.path);
        const row = b.closest('.unin-left-item');
        if (r && r.ok) { row.classList.add('removed'); b.disabled = true; b.checked = false; }
        else if (r) { row.classList.add('failed'); row.title = r.error || 'failed'; }
      });
      NT.toast(fail.length ? `${ok} removed, ${fail.length} failed (may need admin).` : `${ok} leftover item(s) removed.`, fail.length ? 'err' : 'ok', 4000);
    } catch (err) {
      NT.toast(`Delete failed: ${err.message}`, 'err');
    }
    $g('uninLeftDelete').textContent = 'Delete selected';
    updateLeftCount();
  }

  NT.registerView({
    id: 'uninstaller',
    title: 'App Uninstaller',
    icon: '🗑',
    desc: 'Remove installed programs & Store apps — with a leftover registry/file cleaner. Bulk select supported.',
    group: 'Other Tools',
    accent: '#e0654a',
    standalone: true,
    build(section) {
      s.root = section;
      section.innerHTML = shellHtml();
      buildDialogs();
      q('.unin-search').addEventListener('input', (e) => { s.filter = e.target.value; render(); });
      q('.unin-refresh').addEventListener('click', load);
      q('.unin-uninstall').addEventListener('click', openConfirm);
      q('.unin-all').addEventListener('change', (e) => {
        const visible = sortedFiltered();
        visible.forEach((a) => { if (e.target.checked) s.selected.add(a.id); else s.selected.delete(a.id); });
        render();
      });
      q('.unin-table').querySelectorAll('th.sortable').forEach((th) => {
        th.addEventListener('click', () => {
          const k = th.dataset.sort;
          if (s.sortKey === k) s.sortDir *= -1; else { s.sortKey = k; s.sortDir = 1; }
          render();
        });
      });
      if (!s.wired) {
        api.on('uninstall:progress', onProgress);
        api.on('uninstall:done', onDone);
        s.wired = true;
      }
    },
    onEnter() { if (!NT._demo && !s.loaded) load(); },
    demo() {
      s.supported = true; s.loaded = true;
      s.apps = [
        { id: '1', type: 'program', name: 'Google Chrome', publisher: 'Google LLC', version: '128.0.6613.120', sizeKB: 512000, installDate: '20240712' },
        { id: '2', type: 'program', name: '7-Zip 24.07 (x64)', publisher: 'Igor Pavlov', version: '24.07', sizeKB: 5600, installDate: '20240515' },
        { id: '3', type: 'program', name: 'Node.js', publisher: 'Node.js Foundation', version: '20.16.0', sizeKB: 89000, installDate: '20240803' },
        { id: '4', type: 'program', name: 'Zoom Workplace', publisher: 'Zoom Video Communications, Inc.', version: '6.1.6', sizeKB: 402000, installDate: '20240901' },
        { id: '5', type: 'program', name: 'VLC media player', publisher: 'VideoLAN', version: '3.0.21', sizeKB: 178000, installDate: '20240220' },
        { id: '6', type: 'store', name: 'Windows Calculator', publisher: 'Microsoft Corporation', version: '11.2408.2.0', sizeKB: null },
        { id: '7', type: 'store', name: 'Spotify', publisher: 'Spotify AB', version: '1.245.0.0', sizeKB: null },
        { id: '8', type: 'program', name: 'Notepad++ (64-bit x64)', publisher: 'Notepad++ Team', version: '8.6.9', sizeKB: 12800, installDate: '20240610' },
        { id: '9', type: 'program', name: 'Microsoft Visual Studio Code', publisher: 'Microsoft Corporation', version: '1.92.2', sizeKB: 356000, installDate: '20240817' },
      ];
      s.selected = new Set(['2', '4']);
      render();
    },
  });
}());
