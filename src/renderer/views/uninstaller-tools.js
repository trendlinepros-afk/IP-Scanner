'use strict';

/* global NT, document */

/**
 * App Uninstaller — Pro tabs: Traced Programs (install monitor), Forced
 * Uninstall, Startup Manager, Junk Files Cleaner and Backups. Each registers
 * with NT.UN.addTab() (defined in uninstaller.js, which loads first).
 */
(function uninstallerTools() {
  const api = NT.api;
  const esc = NT.escapeHtml;
  const UN = NT.UN;
  const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString() : '—');

  // ---------------------------------------------------------------------------
  // Traced Programs (install monitor)
  // ---------------------------------------------------------------------------
  const T = { el: null, loaded: false, status: { monitoring: false }, traces: [], busy: false };
  const tq = (s) => T.el.querySelector(s);

  function renderMonitor() {
    const box = tq('.un-monitor');
    const s = T.status;
    if (T.busy) {
      box.innerHTML = `<div class="un-mon-state"><span class="un-spin"></span><div><b>${esc(T.busy)}</b><div class="muted small">This can take up to a minute.</div></div></div>`;
      return;
    }
    if (!s.monitoring) {
      box.innerHTML = `
        <div class="un-mon-state"><span class="un-dot off"></span><div><b>Install Monitor is idle</b>
        <div class="muted small">Start monitoring, then install a program. IT Tools records every folder, shortcut, registry key and startup entry it creates — so you can later remove it completely, even if its own uninstaller is broken.</div></div></div>
        <div class="un-mon-actions"><button class="btn btn-primary un-mon-start">● Start monitoring</button></div>`;
      tq('.un-mon-start').addEventListener('click', startMonitor);
      return;
    }
    box.innerHTML = `
      <div class="un-mon-state"><span class="un-dot on"></span><div><b>Monitoring since ${esc(new Date(s.since).toLocaleTimeString())}</b>
      <div class="muted small">Run the installer now (button below or as usual). When it has finished, give the trace a name and press <b>Stop &amp; save trace</b>.</div></div></div>
      <div class="un-mon-actions">
        <button class="btn un-mon-run">▶ Run installer…</button>
        <input class="filter-input un-mon-name" placeholder="Program name (optional)" spellcheck="false" />
        <button class="btn btn-primary un-mon-stop">■ Stop &amp; save trace</button>
        <button class="btn un-mon-cancel">Cancel</button>
      </div>`;
    tq('.un-mon-run').addEventListener('click', async () => { const r = await api.monitorRunInstaller(); if (r && r.error) NT.toast(r.error, 'err'); });
    tq('.un-mon-stop').addEventListener('click', stopMonitor);
    tq('.un-mon-cancel').addEventListener('click', async () => { await api.monitorCancel(); T.status = { monitoring: false }; renderMonitor(); });
  }

  async function startMonitor() {
    T.busy = 'Taking a system snapshot…'; renderMonitor();
    const r = await api.monitorStart().catch((err) => ({ ok: false, error: err.message }));
    T.busy = false;
    if (!r.ok) NT.toast(r.error || 'Could not start monitoring', 'err', 5000);
    else T.status = { monitoring: true, since: r.since };
    renderMonitor();
  }

  async function stopMonitor() {
    const name = tq('.un-mon-name') ? tq('.un-mon-name').value : '';
    T.busy = 'Comparing snapshots…'; renderMonitor();
    const r = await api.monitorStop(name).catch((err) => ({ ok: false, error: err.message }));
    T.busy = false;
    if (!r.ok) { NT.toast(r.error || 'Failed', 'err', 5000); renderMonitor(); return; }
    T.status = { monitoring: false };
    renderMonitor();
    NT.toast(`Trace saved: ${r.trace.name} (${r.trace.itemCount} items)`, 'ok', 4000);
    loadTraces();
  }

  function renderTraces() {
    const tb = tq('tbody');
    tb.textContent = '';
    T.traces.forEach((t) => {
      const tr = NT.el('tr', 'unin-row');
      const parts = Object.entries(t.counts || {}).map(([k, n]) => `${n} ${UN.KIND[k] ? UN.KIND[k].label.toLowerCase() : k}${n === 1 ? '' : 's'}`).join(', ');
      tr.innerHTML = `
        <td><b>${esc(t.name)}</b>${t.hasUninstaller ? ' <span class="unin-badge">has uninstaller</span>' : ''}</td>
        <td>${esc(fmtTime(t.created))}</td>
        <td title="${esc(parts)}">${t.itemCount} <span class="muted small">${esc(parts)}</span></td>
        <td>${t.removed ? `<span class="muted">Removed ${esc(fmtTime(t.removed))}</span>` : '<span class="un-ok">Installed</span>'}</td>
        <td class="un-actions"><button class="btn tiny btn-primary t-un">Uninstall…</button><button class="btn tiny t-del" title="Delete trace">✕</button></td>`;
      tr.querySelector('.t-un').addEventListener('click', () => uninstallTrace(t));
      tr.querySelector('.t-del').addEventListener('click', async () => {
        if (!(await UN.confirm('Delete trace', `Delete the trace for <b>${esc(t.name)}</b>? The program itself is not affected.`, 'Delete', true))) return;
        await api.deleteTrace(t.id); loadTraces();
      });
      tb.append(tr);
    });
    tq('.un-t-empty').classList.toggle('hidden', T.traces.length > 0);
  }

  async function uninstallTrace(t) {
    const full = NT._demo ? T.demoTrace : await api.getTrace(t.id);
    if (!full) { NT.toast('Trace not found', 'err'); return; }
    UN.openReview({
      title: `Uninstall traced program — ${full.name}`,
      intro: `Everything this program created while it was being monitored on ${esc(fmtTime(full.started))}.`,
      groups: [{ title: '', items: full.items }],
      extraHtml: (full.uninstall || []).some((u) => u.uninstallString)
        ? '<label class="field checkbox"><input type="checkbox" class="t-run" checked /><span>Run the program\'s own uninstaller first, then remove what is left</span></label>' : '',
      deleteLabel: 'Uninstall traced program',
      onDelete: (items) => {
        const run = document.querySelector('.un-modal .t-run');
        return api.uninstallTrace(full.id, !!(run && run.checked), items.map(UN.itemKey));
      },
      onDone: loadTraces,
    });
  }

  async function loadTraces() {
    if (NT._demo) return;
    T.traces = await api.listTraces().catch(() => []);
    T.loaded = true;
    renderTraces();
  }

  UN.addTab({
    id: 'traces',
    label: 'Traced Programs',
    icon: '🛰',
    build(el) {
      T.el = el;
      el.innerHTML = `
        <div class="un-card un-monitor"></div>
        <div class="un-section-head"><h3>Traced programs</h3><div class="spacer"></div><button class="btn tiny t-refresh">⟳ Refresh</button></div>
        <div class="unin-table-wrap">
          <table class="unin-table"><thead><tr><th>Program</th><th>Traced</th><th>Items</th><th>Status</th><th class="unin-c-act2"></th></tr></thead><tbody></tbody></table>
          <div class="unin-empty muted un-t-empty">No traced programs yet. Start the Install Monitor before installing something new.</div>
        </div>`;
      tq('.t-refresh').addEventListener('click', loadTraces);
      renderMonitor();
    },
    async onShow() {
      if (NT._demo) return;
      T.status = await api.monitorStatus().catch(() => ({ monitoring: false }));
      renderMonitor();
      if (!T.loaded) loadTraces();
    },
    demo() {
      T.status = { monitoring: true, since: Date.now() - 4 * 60e3 };
      T.traces = [
        { id: 'a', name: 'Blender 4.2', created: Date.now() - 3 * 86400e3, itemCount: 9, counts: { folder: 3, shortcut: 2, registry: 3, regvalue: 1 }, hasUninstaller: true },
        { id: 'b', name: 'OBS Studio', created: Date.now() - 12 * 86400e3, itemCount: 14, counts: { folder: 4, shortcut: 3, registry: 7 }, hasUninstaller: true },
        { id: 'c', name: 'PortableTool Setup', created: Date.now() - 40 * 86400e3, removed: Date.now() - 20 * 86400e3, itemCount: 3, counts: { folder: 2, shortcut: 1 } },
      ];
      T.demoTrace = { id: 'a', name: 'Blender 4.2', started: Date.now() - 3 * 86400e3, uninstall: [{ uninstallString: 'x' }], items: [] };
      renderMonitor(); renderTraces();
    },
  });

  // ---------------------------------------------------------------------------
  // Forced Uninstall
  // ---------------------------------------------------------------------------
  const F = { el: null };
  const fq = (s) => F.el.querySelector(s);

  async function forcedScan() {
    const opts = { name: fq('.f-name').value.trim(), publisher: fq('.f-pub').value.trim(), folder: fq('.f-folder').value.trim(), mode: fq('.f-mode').value };
    if (opts.name.length < 3 && !opts.folder) { NT.toast('Enter the program name (3+ characters) or choose its folder.', 'err'); return; }
    const btn = fq('.f-go'); btn.disabled = true; btn.textContent = 'Scanning…';
    const res = await api.forcedScan(opts).catch((err) => ({ items: [], error: err.message }));
    btn.disabled = false; btn.textContent = '🔎 Scan for remnants';
    if (res.error) { NT.toast(res.error, 'err', 5000); return; }
    if (!res.supported && res.supported !== undefined) { NT.toast('Forced Uninstall works on Windows only.', 'err'); return; }
    if (!res.items || !res.items.length) { NT.toast(`No remnants of "${opts.name || opts.folder}" were found.`, 'ok', 4000); return; }
    UN.openReview({
      title: `Remnants of ${opts.name || opts.folder} (${res.items.length})`,
      intro: `${esc(opts.mode)} scan. Only items matching the name / folder you entered are listed — review before deleting.`,
      groups: [{ title: '', items: res.items }],
      onDelete: (items) => api.removeLeftovers(items, `Forced uninstall: ${opts.name || opts.folder}`),
      onDone: () => UN.reloadPrograms && UN.reloadPrograms(),
    });
  }

  UN.addTab({
    id: 'forced',
    label: 'Forced Uninstall',
    icon: '🔎',
    build(el) {
      F.el = el;
      el.innerHTML = `
        <div class="un-card un-form">
          <h3>Forced Uninstall</h3>
          <p class="muted">Remove the remnants of programs that are already partially uninstalled, broken, or missing from the list. IT Tools searches the registry, program folders, AppData, shortcuts and startup entries for anything matching the program — and finds orphaned uninstall entries too.</p>
          <div class="field-row">
            <label class="field"><span>Program name *</span><input class="f-name" type="text" placeholder="e.g. Adobe Reader" spellcheck="false" /></label>
            <label class="field"><span>Publisher (optional)</span><input class="f-pub" type="text" placeholder="e.g. Adobe" spellcheck="false" /></label>
          </div>
          <label class="field"><span>Install folder (optional)</span>
            <div class="un-inline"><input class="f-folder" type="text" placeholder="C:\\Program Files\\…" spellcheck="false" /><button class="btn f-browse">Browse…</button></div></label>
          <label class="field"><span>Scan mode</span>
            <select class="f-mode"><option value="safe">Safe</option><option value="moderate">Moderate</option><option value="advanced" selected>Advanced (recommended for forced uninstall)</option></select></label>
          <div class="un-form-foot"><button class="btn btn-primary f-go">🔎 Scan for remnants</button></div>
        </div>`;
      fq('.f-browse').addEventListener('click', async () => { const p = await api.pickFolder(); if (p) fq('.f-folder').value = p; });
      fq('.f-go').addEventListener('click', forcedScan);
      fq('.f-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') forcedScan(); });
    },
    onShow(arg) {
      if (arg) { fq('.f-name').value = arg.name || ''; fq('.f-pub').value = arg.publisher || ''; fq('.f-folder').value = arg.folder || ''; }
      setTimeout(() => fq('.f-name').focus(), 30);
    },
    demo() { fq('.f-name').value = 'Adobe Acrobat Reader'; fq('.f-pub').value = 'Adobe'; },
  });

  // ---------------------------------------------------------------------------
  // Startup Manager
  // ---------------------------------------------------------------------------
  const S = { el: null, entries: [], loaded: false, icons: {} };
  const sq = (s) => S.el.querySelector(s);
  const scopeLabel = (e) => {
    const where = e.source === 'folder' ? 'Startup folder' : `Registry (${e.once ? 'RunOnce' : 'Run'}${e.scope === 'machine32' ? ', 32-bit' : ''})`;
    return `${e.machine ? 'All users' : 'Current user'} · ${where}`;
  };

  function renderStartup() {
    const tb = sq('tbody'); tb.textContent = '';
    S.entries.forEach((e) => {
      const tr = NT.el('tr', `unin-row${e.enabled ? '' : ' un-off'}`);
      const exe = UN.exeOf(e.command) || (e.source === 'folder' ? e.command : '');
      const icon = exe && S.icons[exe] ? `<img class="un-ico" src="${S.icons[exe]}" alt="" />` : '<span class="un-ico un-ico-fb">⚡</span>';
      tr.innerHTML = `
        <td class="unin-c-check"><label class="un-switch" title="${e.canToggle ? (e.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable') : 'Run-once entries cannot be disabled'}"><input type="checkbox" ${e.enabled ? 'checked' : ''} ${e.canToggle ? '' : 'disabled'} /><span></span></label></td>
        <td class="unin-c-name"><div class="un-namecell">${icon}<span class="unin-name">${esc(e.name)}</span></div></td>
        <td class="un-cmd" title="${esc(e.command)}">${esc(e.command)}</td>
        <td class="un-scope">${esc(scopeLabel(e))}</td>
        <td class="un-actions"><button class="btn tiny s-open" title="Open file location" ${exe ? '' : 'disabled'}>📂</button><button class="btn tiny s-del" title="Delete entry">✕</button></td>`;
      tr.querySelector('input').addEventListener('change', async (ev) => {
        const r = NT._demo ? { ok: true } : await api.setStartupEnabled(e.id, ev.target.checked);
        if (r.ok) { e.enabled = ev.target.checked; tr.classList.toggle('un-off', !e.enabled); NT.toast(`${e.name} ${e.enabled ? 'enabled' : 'disabled'} at startup`, 'ok', 1800); }
        else { ev.target.checked = !ev.target.checked; NT.toast(r.error || 'Failed', 'err', 5000); }
      });
      tr.querySelector('.s-open').addEventListener('click', () => api.openAppFolder(UN.dirOf(exe)).then((r) => { if (!r.ok) NT.toast(r.error, 'err'); }));
      tr.querySelector('.s-del').addEventListener('click', async () => {
        if (!(await UN.confirm('Delete startup entry', `Delete <b>${esc(e.name)}</b> from startup? It is backed up first (restore from the Backups tab). Tip: <i>disabling</i> is reversible without a backup.`, 'Delete', true))) return;
        const r = await api.removeStartup(e.id);
        if (r.ok) { NT.toast('Startup entry deleted · backup saved', 'ok'); loadStartup(); } else NT.toast(r.error || 'Failed', 'err', 5000);
      });
      tb.append(tr);
    });
    const on = S.entries.filter((e) => e.enabled).length;
    sq('.s-count').textContent = `${S.entries.length} startup item(s) · ${on} enabled · ${S.entries.length - on} disabled`;
    sq('.s-empty').classList.toggle('hidden', S.entries.length > 0);
  }

  async function loadStartup() {
    if (NT._demo) return;
    sq('.s-count').textContent = 'Loading…';
    const r = await api.listStartup().catch(() => ({ entries: [] }));
    if (r.admin != null) UN.setAdmin(r.admin);
    S.entries = r.entries || []; S.loaded = true;
    if (r.supported === false) sq('.s-empty').textContent = 'The Startup Manager works on Windows only.';
    renderStartup();
    const exes = [...new Set(S.entries.map((e) => UN.exeOf(e.command) || (e.source === 'folder' ? e.command : '')).filter(Boolean))];
    if (exes.length) { Object.assign(S.icons, await api.fileIcons(exes).catch(() => ({}))); renderStartup(); }
  }

  UN.addTab({
    id: 'startup',
    label: 'Startup',
    icon: '⚡',
    build(el) {
      S.el = el;
      el.innerHTML = `
        <div class="unin-toolbar"><span class="muted s-count"></span><div class="spacer"></div><span class="muted small s-hint"></span><button class="btn s-refresh">⟳ Refresh</button></div>
        <div class="unin-table-wrap">
          <table class="unin-table"><thead><tr><th class="unin-c-check">On</th><th>Name</th><th>Command</th><th>Location</th><th class="unin-c-act2"></th></tr></thead><tbody></tbody></table>
          <div class="unin-empty muted hidden s-empty">No startup items found.</div>
        </div>`;
      sq('.s-refresh').addEventListener('click', loadStartup);
      sq('.s-hint').innerHTML = 'Disabling works like Task Manager — it can be turned back on any time.';
    },
    onShow() { if (!S.loaded && !NT._demo) loadStartup(); },
    demo() {
      S.entries = [
        { id: '1', name: 'Discord', command: '"C:\\Users\\me\\AppData\\Local\\Discord\\Update.exe" --processStart Discord.exe', scope: 'user', source: 'registry', enabled: true, canToggle: true },
        { id: '2', name: 'Steam', command: '"C:\\Program Files (x86)\\Steam\\steam.exe" -silent', scope: 'user', source: 'registry', enabled: false, canToggle: true },
        { id: '3', name: 'SecurityHealth', command: '%windir%\\system32\\SecurityHealthSystray.exe', scope: 'machine', machine: true, source: 'registry', enabled: true, canToggle: true },
        { id: '4', name: 'Spotify', command: 'C:\\Users\\me\\AppData\\Roaming\\Spotify\\Spotify.exe /minimized', scope: 'user', source: 'registry', enabled: false, canToggle: true },
        { id: '5', name: 'OneDrive', command: '"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background', scope: 'user', source: 'registry', enabled: true, canToggle: true },
        { id: '6', name: 'Send to OneNote', command: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\ONENOTEM.EXE', scope: 'user', source: 'folder', enabled: true, canToggle: true },
      ];
      renderStartup();
    },
  });

  // ---------------------------------------------------------------------------
  // Junk Files Cleaner
  // ---------------------------------------------------------------------------
  const J = { el: null, cats: [], scanned: false };
  const jq = (s) => J.el.querySelector(s);

  function renderJunk() {
    const tb = jq('tbody'); tb.textContent = '';
    J.cats.forEach((c) => {
      const tr = NT.el('tr', 'unin-row');
      const usable = c.available && c.bytes + c.files > 0;
      tr.innerHTML = `
        <td class="unin-c-check"><input type="checkbox" ${usable && !c.needsAdmin && c.id !== 'recycle' ? 'checked' : ''} ${usable ? '' : 'disabled'} /></td>
        <td><b>${esc(c.name)}</b><div class="muted small">${esc(c.desc)}${c.needsAdmin ? ' · needs administrator' : ''}</div></td>
        <td class="un-num">${c.available ? c.files.toLocaleString() : '—'}</td>
        <td class="un-num"><b>${c.available ? NT.fmt.bytes(c.bytes) : '—'}</b></td>`;
      tr.querySelector('input').addEventListener('change', updateJunk);
      tr.addEventListener('click', (e) => { if (e.target.tagName !== 'INPUT') { const cb = tr.querySelector('input'); if (!cb.disabled) { cb.checked = !cb.checked; updateJunk(); } } });
      tr._cat = c;
      tb.append(tr);
    });
    jq('.j-empty').classList.toggle('hidden', J.cats.length > 0);
    updateJunk();
  }
  function selectedCats() { return [...jq('tbody').children].filter((tr) => tr.querySelector('input').checked).map((tr) => tr._cat); }
  function updateJunk() {
    const sel = selectedCats();
    const total = J.cats.reduce((a, c) => a + (c.bytes || 0), 0);
    jq('.j-total').innerHTML = J.scanned ? `Found <b>${NT.fmt.bytes(total)}</b> of junk · <b>${NT.fmt.bytes(sel.reduce((a, c) => a + c.bytes, 0))}</b> selected` : 'Scan to see how much space you can free.';
    jq('.j-clean').disabled = !sel.length;
  }
  async function scanJunk() {
    if (NT._demo) return;
    const b = jq('.j-scan'); b.disabled = true; b.textContent = 'Scanning…';
    const r = await api.scanJunk().catch(() => ({ categories: [] }));
    b.disabled = false; b.textContent = '🔎 Scan';
    if (r.supported === false) { jq('.j-empty').textContent = 'The Junk Files Cleaner works on Windows only.'; }
    if (r.admin != null) UN.setAdmin(r.admin);
    J.cats = r.categories || []; J.scanned = true;
    renderJunk();
  }
  async function cleanJunk() {
    const sel = selectedCats();
    if (!sel.length) return;
    if (!(await UN.confirm('Clean junk files', `Permanently delete junk from <b>${sel.length}</b> location(s) (${NT.fmt.bytes(sel.reduce((a, c) => a + c.bytes, 0))})? Files in use are skipped automatically.`, 'Clean', true))) return;
    const b = jq('.j-clean'); b.disabled = true; b.textContent = 'Cleaning…';
    const r = await api.cleanJunk(sel.map((c) => c.id)).catch((err) => ({ results: [], error: err.message }));
    b.textContent = '🧹 Clean selected';
    const freed = (r.results || []).reduce((a, x) => a + (x.freed || 0), 0);
    const failed = (r.results || []).reduce((a, x) => a + (x.failed || 0), 0);
    NT.toast(`Freed ${NT.fmt.bytes(freed)}${failed ? ` · ${failed} file(s) in use were skipped` : ''}.`, 'ok', 5000);
    scanJunk();
  }

  UN.addTab({
    id: 'junk',
    label: 'Junk Cleaner',
    icon: '🧹',
    build(el) {
      J.el = el;
      el.innerHTML = `
        <div class="unin-toolbar"><span class="j-total"></span><div class="spacer"></div><button class="btn j-scan">🔎 Scan</button><button class="btn btn-primary j-clean" disabled>🧹 Clean selected</button></div>
        <div class="unin-table-wrap">
          <table class="unin-table"><thead><tr><th class="unin-c-check"></th><th>Location</th><th class="un-num">Files</th><th class="un-num">Size</th></tr></thead><tbody></tbody></table>
          <div class="unin-empty muted j-empty">Press <b>Scan</b> to find temporary files, caches, crash dumps and other junk.</div>
        </div>`;
      jq('.j-scan').addEventListener('click', scanJunk);
      jq('.j-clean').addEventListener('click', cleanJunk);
      updateJunk();
    },
    onShow() { if (!J.scanned && !NT._demo) scanJunk(); },
    demo() {
      J.scanned = true;
      J.cats = [
        { id: 'usertemp', name: 'User temporary files', desc: 'Your %TEMP% folder', files: 3412, bytes: 1.9e9, available: true },
        { id: 'wintemp', name: 'Windows temporary files', desc: 'C:\\Windows\\Temp (administrator)', files: 288, bytes: 412e6, available: true },
        { id: 'dumps', name: 'Crash dumps', desc: 'Application crash dump files', files: 6, bytes: 840e6, available: true },
        { id: 'wer', name: 'Windows Error Reporting', desc: 'Queued and archived error reports', files: 41, bytes: 96e6, available: true },
        { id: 'thumbs', name: 'Thumbnail cache', desc: 'Explorer thumbnail databases (rebuilt automatically)', files: 12, bytes: 210e6, available: true },
        { id: 'chrome', name: 'Google Chrome cache', desc: 'Cached web content (close Chrome first for best results)', files: 5210, bytes: 1.1e9, available: true },
        { id: 'edge', name: 'Microsoft Edge cache', desc: 'Cached web content (close Edge first for best results)', files: 980, bytes: 230e6, available: true },
        { id: 'wu', name: 'Windows Update downloads', desc: 'Already-installed update packages (administrator)', files: 77, bytes: 2.4e9, available: true },
        { id: 'recycle', name: 'Recycle Bin', desc: 'Empty the Recycle Bin on all drives (also removes uninstaller file backups)', files: 54, bytes: 3.2e9, available: true },
      ];
      renderJunk();
    },
  });

  // ---------------------------------------------------------------------------
  // Backups
  // ---------------------------------------------------------------------------
  const B = { el: null, list: [], loaded: false };
  const bq = (s) => B.el.querySelector(s);

  function renderBackups() {
    const tb = bq('tbody'); tb.textContent = '';
    B.list.forEach((b) => {
      const tr = NT.el('tr', 'unin-row');
      tr.innerHTML = `
        <td>${esc(fmtTime(b.created))}</td>
        <td><b>${esc(b.label)}</b>${b.restored ? ` <span class="muted small">· restored ${esc(fmtTime(b.restored))}</span>` : ''}</td>
        <td class="un-num">${b.registryCount}</td>
        <td class="un-num">${b.fileCount}</td>
        <td class="un-actions"><button class="btn tiny btn-primary b-restore" ${b.registryCount ? '' : 'disabled'}>Restore registry</button><button class="btn tiny b-open" title="Open backup folder">📂</button><button class="btn tiny b-del" title="Delete backup">✕</button></td>`;
      tr.querySelector('.b-restore').addEventListener('click', async () => {
        if (!(await UN.confirm('Restore backup', `Re-import the ${b.registryCount} registry item(s) saved in <b>${esc(b.label)}</b>?${b.fileCount ? ' Files and folders from this backup are in the Recycle Bin — restore them from there.' : ''}`, 'Restore'))) return;
        const r = await api.restoreBackup(b.id);
        NT.toast(r.ok ? 'Registry restored' : `Some items failed: ${((r.results || []).find((x) => !x.ok) || {}).error || r.error || ''}`, r.ok ? 'ok' : 'err', 5000);
        loadBackups();
      });
      tr.querySelector('.b-open').addEventListener('click', () => api.openBackupFolder(b.id));
      tr.querySelector('.b-del').addEventListener('click', async () => {
        if (!(await UN.confirm('Delete backup', `Delete the backup <b>${esc(b.label)}</b>? You will no longer be able to restore it.`, 'Delete', true))) return;
        await api.deleteBackup(b.id); loadBackups();
      });
      tb.append(tr);
    });
    bq('.b-empty').classList.toggle('hidden', B.list.length > 0);
  }
  async function loadBackups() {
    if (NT._demo) return;
    B.list = await api.listBackups().catch(() => []); B.loaded = true;
    renderBackups();
  }

  UN.addTab({
    id: 'backups',
    label: 'Backups',
    icon: '🛡',
    build(el) {
      B.el = el;
      el.innerHTML = `
        <div class="unin-toolbar"><span class="muted">Every deletion made by these tools is backed up first. Registry items are saved as .reg files and can be restored here; deleted files &amp; folders are in the Recycle Bin.</span><div class="spacer"></div><button class="btn b-folder">📂 Open backups folder</button><button class="btn b-refresh">⟳ Refresh</button></div>
        <div class="unin-table-wrap">
          <table class="unin-table"><thead><tr><th>Created</th><th>Description</th><th class="un-num">Registry</th><th class="un-num">Files</th><th class="unin-c-act2"></th></tr></thead><tbody></tbody></table>
          <div class="unin-empty muted hidden b-empty">No backups yet.</div>
        </div>`;
      bq('.b-refresh').addEventListener('click', loadBackups);
      bq('.b-folder').addEventListener('click', () => api.openBackupFolder(null));
    },
    onShow() { if (!NT._demo) loadBackups(); },
    demo() {
      B.list = [
        { id: '1', created: Date.now() - 3600e3, label: 'Leftovers: Zoom Workplace, 7-Zip 24.07 (x64)', registryCount: 6, fileCount: 4 },
        { id: '2', created: Date.now() - 2 * 86400e3, label: 'Startup entry: Spotify', registryCount: 1, fileCount: 0 },
        { id: '3', created: Date.now() - 9 * 86400e3, label: 'Traced program: OBS Studio', registryCount: 7, fileCount: 7, restored: Date.now() - 8 * 86400e3 },
      ];
      renderBackups();
    },
  });
}());
