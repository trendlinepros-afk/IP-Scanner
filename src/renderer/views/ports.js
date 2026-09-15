'use strict';

/* global NT */

// Port Scanner view — scan TCP ports on a single host.
(function portsView() {
  const api = NT.api;
  const s = { root: null, running: false };
  const q = (sel) => s.root.querySelector(sel);

  function html() {
    return `
    <div class="ps-bar">
      <input class="ps-host range-input" type="text" spellcheck="false" placeholder="Host or IP (e.g. 192.168.1.1)" />
      <input class="ps-ports range-input" type="text" spellcheck="false" placeholder="Ports: 80,443,1-1024" />
      <button class="ps-common btn" title="Fill common service ports">Common</button>
      <button class="ps-go btn btn-primary"><span class="btn-icon">▶</span><span class="ps-go-label">Scan</span></button>
    </div>
    <div class="progress-wrap ps-progress hidden"><div class="progress-bar ps-progressbar"></div></div>
    <div class="results">
      <table class="grid ps-table">
        <thead><tr><th class="col-hop">Port</th><th>State</th><th>Service</th></tr></thead>
        <tbody class="ps-tbody"></tbody>
      </table>
      <div class="empty-state ps-empty"><div class="empty-icon">🔓</div><p>Enter a host and ports, then press <strong>Scan</strong>.</p></div>
    </div>
    <div class="ps-summary muted"></div>`;
  }

  function parsePorts(text) {
    const set = new Set();
    for (const partRaw of text.split(',')) {
      const part = partRaw.trim(); if (!part) continue;
      if (part.includes('-')) { const [a, b] = part.split('-').map((x) => parseInt(x.trim(), 10)); if (a > 0 && b >= a) for (let p = a; p <= b && set.size < 5000; p += 1) set.add(p); } else { const p = parseInt(part, 10); if (p > 0 && p < 65536) set.add(p); }
    }
    return Array.from(set);
  }

  async function scan() {
    const host = q('.ps-host').value.trim(); if (!host) { NT.toast('Enter a host', 'err'); return; }
    let list = parsePorts(q('.ps-ports').value);
    if (list.length === 0) { const common = await api.commonPorts(); list = Object.keys(common).map(Number); }
    s.running = true; q('.ps-go').classList.add('scanning'); q('.ps-progress').classList.remove('hidden'); q('.ps-progressbar').style.width = '40%';
    q('.ps-summary').textContent = `Scanning ${list.length} ports on ${host}…`; q('.ps-tbody').textContent = '';
    try {
      const res = await api.scanPortsHost(host, list, { timeoutMs: 900, concurrency: 64 });
      q('.ps-progressbar').style.width = '100%';
      const svcMap = {}; (res.services || []).forEach((x) => { svcMap[x.port] = x.label; });
      q('.ps-empty').classList.toggle('hidden', res.open.length > 0 || true);
      q('.ps-empty').classList.add('hidden');
      const tbody = q('.ps-tbody'); tbody.textContent = '';
      if (res.open.length === 0) { q('.ps-summary').textContent = `No open ports found (${list.length} scanned).`; }
      else {
        res.open.forEach((p) => { const tr = NT.el('tr'); tr.innerHTML = `<td class="col-hop">${p}</td><td><span class="dot up"></span>open</td><td>${NT.escapeHtml(svcMap[p] || '')}</td>`; tbody.append(tr); });
        q('.ps-summary').textContent = `${res.open.length} open of ${list.length} scanned on ${host}.`;
      }
    } catch (err) { NT.toast(`Scan failed: ${err.message}`, 'err'); }
    finally { s.running = false; q('.ps-go').classList.remove('scanning'); setTimeout(() => q('.ps-progress').classList.add('hidden'), 400); }
  }

  NT.registerView({
    id: 'ports',
    title: 'Port Scanner',
    icon: '🔓',
    desc: 'Scan TCP ports and identify running services.',
    group: 'Discovery & Diagnostics',
    accent: '#c0392b',
    build(section) {
      s.root = section; section.innerHTML = html();
      q('.ps-go').addEventListener('click', scan);
      q('.ps-host').addEventListener('keydown', (e) => { if (e.key === 'Enter') scan(); });
      q('.ps-common').addEventListener('click', async () => { const c = await api.commonPorts(); q('.ps-ports').value = Object.keys(c).map(Number).sort((a, b) => a - b).join(','); });
    },
    demo() {
      q('.ps-host').value = '192.168.1.1'; q('.ps-ports').value = '80,443,22,53,8080'; q('.ps-empty').classList.add('hidden');
      const rows = [[53, 'DNS'], [80, 'HTTP'], [443, 'HTTPS'], [8080, 'HTTP-Alt']];
      const tbody = q('.ps-tbody'); tbody.textContent = '';
      rows.forEach(([p, svc]) => { const tr = NT.el('tr'); tr.innerHTML = `<td class="col-hop">${p}</td><td><span class="dot up"></span>open</td><td>${svc}</td>`; tbody.append(tr); });
      q('.ps-summary').textContent = '4 open of 5 scanned on 192.168.1.1.';
    },
  });
}());
