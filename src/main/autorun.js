'use strict';

/**
 * "Auto Run All Tools" orchestrator.
 *
 * Runs every diagnostic once, in sequence, saving a timestamped result to the
 * active client after each, then builds and returns a PDF report. Tools that
 * normally run continuously (ping) or open-ended (scans) are time-boxed so the
 * whole run finishes on its own — e.g. ping 8.8.8.8 for 10 s then record
 * best / worst / average.
 *
 * Emits: 'start' { total }, 'progress' { index, total, name, status, error },
 *        'done' { clientId, reportPath, count, cancelled }.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { SpeedTest } = require('./speedtest');
const wifi = require('./wifi');
const { LatencyMonitor } = require('./latency');
const { Traceroute } = require('./traceroute');
const { DnsBenchmark } = require('./dns');
const { QualityTest } = require('./quality');
const { Scanner } = require('./scanner');
const ports = require('./ports');
const netinfo = require('./netinfo');
const network = require('./network');
const clients = require('./clients');
const report = require('./report');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function runTrace(target, timeoutMs = 40000) {
  return new Promise((resolve) => {
    const tr = new Traceroute();
    const hops = [];
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { tr.stop(); } catch (_) { /* */ }
      resolve(hops.length ? { type: 'traceroute', title: 'Traceroute', summary: `${target} · ${hops.length} hops`, data: { target, hops } } : null);
    };
    const timer = setTimeout(done, timeoutMs);
    tr.on('hop', (h) => hops.push(h));
    tr.on('done', done);
    tr.on('error', done);
    tr.run(target, { maxHops: 20 });
  });
}

function runScan(range, timeboxMs = 25000) {
  return new Promise((resolve) => {
    if (!range) return resolve(null);
    const sc = new Scanner();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hosts = sc.results().filter((h) => h.status === 'alive').map((h) => ({ ip: h.ip, name: h.name, mac: h.mac, vendor: h.vendor }));
      resolve({ type: 'scan', title: 'Network Scan', summary: `${range} · ${hosts.length} alive`, data: { range, alive: hosts.length, hosts } });
    };
    const timer = setTimeout(() => { try { sc.cancel(); } catch (_) { /* */ } }, timeboxMs);
    sc.on('done', finish);
    sc.on('error', finish);
    sc.scan(range, { resolveNames: false, scanPorts: false, tcpFallback: true, concurrency: 128, timeoutMs: 700 }).catch(finish);
    return undefined;
  });
}

class AutoRun extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.cancelled = false;
    this._active = null;
  }

  cancel() {
    this.cancelled = true;
    if (this._active) {
      try { if (this._active.cancel) this._active.cancel(); else if (this._active.stop) this._active.stop(); } catch (_) { /* */ }
    }
  }

  async run(clientId, opts = {}) {
    if (this.running) throw new Error('Auto-run already in progress');
    this.running = true;
    this.cancelled = false;
    const pingTarget = opts.pingTarget || '8.8.8.8';
    const runSeconds = opts.runSeconds || 10;
    const traceTarget = opts.traceTarget || 'cloudflare.com';

    // Gather once up-front: WiFi link + gateway + local range.
    let wifiData = null;
    try { wifiData = await wifi.scan(); } catch (_) { /* */ }
    let gateway = '';
    try { gateway = await netinfo.defaultGateway(); } catch (_) { /* */ }
    let range = '';
    try { const p = network.primaryInterface(); if (p) range = p.suggestedRange; } catch (_) { /* */ }
    const connLabel = (wifiData && wifiData.current && wifiData.current.ssid) ? `Wi-Fi · ${wifiData.current.ssid}` : 'Ethernet';

    const allSteps = [
      {
        key: 'netinfo',
        name: 'Network Info',
        run: async () => {
          const sum = await netinfo.summary();
          return { type: 'netinfo', title: 'Network Info', summary: `${(sum.public && sum.public.isp) || ''} · GW ${sum.gateway || '—'}`, data: { public: sum.public, gateway: sum.gateway, dns: sum.dns, hostname: sum.hostname } };
        },
      },
      {
        key: 'speedtest',
        name: 'Internet Speed Test',
        run: async () => {
          const st = new SpeedTest();
          this._active = st;
          const r = await st.run({ downloadSeconds: 6, uploadSeconds: 5, latencyCount: 15 });
          return { type: 'speedtest', title: 'Internet Speed Test', summary: `↓ ${r.downloadMbps} / ↑ ${r.uploadMbps} Mbps · ${r.ping} ms`, data: { downloadMbps: r.downloadMbps, uploadMbps: r.uploadMbps, ping: r.ping, jitter: r.jitter, loss: r.loss, server: r.server, connection: connLabel } };
        },
      },
      {
        key: 'quality',
        name: 'Connection Quality (bufferbloat / VoIP)',
        run: async () => {
          const qt = new QualityTest();
          this._active = qt;
          const r = await qt.run({ idleMs: 3000, loadMs: 7000 });
          if (r.cancelled) return null;
          return { type: 'quality', title: 'Connection Quality', summary: `Bufferbloat ${r.grade} (+${r.bufferbloatMs} ms) · MOS ${r.mos} (${r.mosRating})`, data: r };
        },
      },
      {
        key: 'wifi',
        name: 'WiFi Scan',
        run: async () => {
          if (!wifiData || !wifiData.supported) return null;
          return { type: 'wifi', title: 'WiFi Scan', summary: `${wifiData.networks.length} networks${wifiData.current ? ` · on ${wifiData.current.ssid}` : ''}`, data: { current: wifiData.current, networks: wifiData.networks, analysis: wifiData.analysis } };
        },
      },
      {
        key: 'ping',
        name: `Ping Monitor (${pingTarget}, ${runSeconds}s)`,
        run: async () => {
          const m = new LatencyMonitor();
          this._active = m;
          m.start(pingTarget, { intervalMs: 1000 });
          await delay(runSeconds * 1000);
          const st = m.stats();
          m.stop();
          return { type: 'ping', title: 'Ping Monitor', summary: `${pingTarget} · best ${st.min ?? '—'} / worst ${st.max ?? '—'} / avg ${st.avg ?? '—'} ms · ${st.lossPct}% loss`, data: { target: pingTarget, durationSec: runSeconds, ...st } };
        },
      },
      { key: 'traceroute', name: 'Traceroute', run: () => runTrace(traceTarget) },
      {
        key: 'dns',
        name: 'DNS Benchmark',
        run: async () => {
          const b = new DnsBenchmark();
          this._active = b;
          const all = await b.run({ rounds: 1 });
          const best = all.find((r) => r.avg != null);
          return { type: 'dns', title: 'DNS Benchmark', summary: best ? `Fastest ${best.name} (${best.avg} ms)` : 'No response', data: { resolvers: all } };
        },
      },
      {
        key: 'ports',
        name: 'Port Scan (gateway)',
        run: async () => {
          if (!gateway) return null;
          const open = await ports.scanPorts(gateway, ports.DEFAULT_PORTS, { timeoutMs: 900 });
          const { services } = ports.summarizeServices(open);
          return { type: 'ports', title: 'Port Scan', summary: `${gateway} · ${open.length} open`, data: { host: gateway, open: open.map((p) => ({ port: p, service: (services.find((x) => x.port === p) || {}).label || '' })), scanned: ports.DEFAULT_PORTS.length } };
        },
      },
      { key: 'scan', name: `Network Scan (${range || 'LAN'})`, run: () => runScan(range) },
    ];

    const skip = new Set(opts.skip || []);
    const steps = allSteps.filter((s) => !skip.has(s.key));

    this.emit('start', { total: steps.length });
    const results = [];
    for (let i = 0; i < steps.length; i += 1) {
      if (this.cancelled) break;
      const step = steps[i];
      this.emit('progress', { index: i, total: steps.length, name: step.name, status: 'running' });
      try {
        // eslint-disable-next-line no-await-in-loop
        const rec = await step.run();
        if (rec) {
          clients.saveResult(clientId, rec);
          results.push(rec);
          this.emit('progress', { index: i, total: steps.length, name: step.name, status: 'done', summary: rec.summary });
        } else {
          this.emit('progress', { index: i, total: steps.length, name: step.name, status: 'skipped' });
        }
      } catch (err) {
        this.emit('progress', { index: i, total: steps.length, name: step.name, status: 'error', error: err.message });
      }
      this._active = null;
    }

    // Build the PDF report of everything recorded for this client.
    let reportPath = null;
    try {
      const client = clients.getClient(clientId);
      const history = clients.getHistory(clientId);
      const html = report.buildReportHtml(client, history, { generated: Date.now() });
      const pdf = await report.renderPdf(html);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      reportPath = path.join(client.dir, 'reports', `AutoRun-${stamp}.pdf`);
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, pdf);
    } catch (err) {
      this.emit('progress', { index: steps.length, total: steps.length, name: 'PDF Report', status: 'error', error: err.message });
    }

    this.running = false;
    this.emit('done', { clientId, reportPath, count: results.length, cancelled: this.cancelled });
    return { ok: true, reportPath, count: results.length };
  }
}

module.exports = { AutoRun };
