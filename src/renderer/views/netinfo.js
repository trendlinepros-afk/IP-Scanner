'use strict';

/* global NT */

// Network Info view — adapters, gateway, DNS, public IP / ISP.
(function netinfoView() {
  const api = NT.api;
  const s = { root: null, loading: false };
  const q = (sel) => s.root.querySelector(sel);

  function html() {
    return `
    <div class="ni-bar"><button class="ni-refresh btn btn-primary"><span class="btn-icon">⟳</span> Refresh</button><div class="spacer"></div><span class="ni-status muted"></span></div>
    <div class="ni-grid">
      <div class="card-panel ni-public"><div class="panel-title">Internet</div><div class="ni-public-body">Loading…</div></div>
      <div class="card-panel ni-local"><div class="panel-title">This machine</div><div class="ni-local-body">Loading…</div></div>
    </div>
    <div class="card-panel ni-adapters"><div class="panel-title">Network adapters</div>
      <table class="grid ni-table"><thead><tr><th>Adapter</th><th>Family</th><th>IP address</th><th>Netmask</th><th>MAC</th></tr></thead><tbody class="ni-tbody"></tbody></table>
    </div>`;
  }

  function kv(pairs) { return `<dl class="kv">${pairs.map(([k, v]) => `<dt>${NT.escapeHtml(k)}</dt><dd>${NT.escapeHtml(v == null || v === '' ? '—' : String(v))}</dd>`).join('')}</dl>`; }

  async function load() {
    if (s.loading) return; s.loading = true; q('.ni-status').textContent = 'Loading…';
    try {
      const info = await api.netInfo();
      const p = info.public || {};
      q('.ni-public-body').innerHTML = kv([
        ['Public IP', p.ip], ['ISP', p.isp], ['Organization', p.org],
        ['Location', [p.city, p.region, p.country].filter(Boolean).join(', ')], ['Timezone', p.timezone],
      ]);
      const loc = [
        ['Hostname', info.hostname], ['Platform', info.platform],
        ['Default gateway', info.gateway], ['DNS servers', (info.dns || []).join(', ')],
        ['Uptime', info.uptimeSec ? `${Math.floor(info.uptimeSec / 3600)}h ${Math.floor((info.uptimeSec % 3600) / 60)}m` : '—'],
      ];
      q('.ni-local-body').innerHTML = kv(loc);
      const tbody = q('.ni-tbody'); tbody.textContent = '';
      for (const a of info.adapters || []) {
        const tr = NT.el('tr');
        tr.innerHTML = `<td>${NT.escapeHtml(a.name)}</td><td>${NT.escapeHtml(a.family)}</td><td class="mac">${NT.escapeHtml(a.address)}</td><td class="mac">${NT.escapeHtml(a.netmask || '')}</td><td class="mac">${NT.escapeHtml(a.mac || '')}</td>`;
        tbody.append(tr);
      }
      q('.ni-status').textContent = '';
    } catch (err) { NT.toast(`Failed to load network info: ${err.message}`, 'err'); q('.ni-status').textContent = 'Error'; }
    finally { s.loading = false; }
  }

  NT.registerView({
    id: 'netinfo',
    title: 'Network Info',
    icon: 'ℹ️',
    desc: 'Adapters, gateway, DNS, public IP and ISP details.',
    group: 'WiFi & Connectivity',
    accent: '#0aa1a1',
    build(section) { s.root = section; section.innerHTML = html(); q('.ni-refresh').addEventListener('click', load); },
    onEnter() { if (NT._demo) return; load(); },
    demo() {
      q('.ni-public-body').innerHTML = kv([['Public IP', '203.0.113.24'], ['ISP', 'Comcast Cable'], ['Organization', 'Comcast'], ['Location', 'Austin, Texas, United States'], ['Timezone', 'America/Chicago']]);
      q('.ni-local-body').innerHTML = kv([['Hostname', 'DESKTOP-A12B'], ['Platform', 'win32'], ['Default gateway', '192.168.1.1'], ['DNS servers', '1.1.1.1, 8.8.8.8'], ['Uptime', '5h 12m']]);
      const tbody = q('.ni-tbody'); tbody.textContent = '';
      [['Wi-Fi', 'IPv4', '192.168.1.42', '255.255.255.0', 'a4:5e:60:77:88:99'], ['Ethernet', 'IPv4', '192.168.1.43', '255.255.255.0', 'b8:ca:3a:44:55:66']]
        .forEach((r) => { const tr = NT.el('tr'); tr.innerHTML = `<td>${r[0]}</td><td>${r[1]}</td><td class="mac">${r[2]}</td><td class="mac">${r[3]}</td><td class="mac">${r[4]}</td>`; tbody.append(tr); });
    },
  });
}());
