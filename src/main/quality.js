'use strict';

/**
 * Connection quality: bufferbloat (latency under load) + VoIP call quality.
 *
 * Measures HTTPS round-trip latency while the link is idle, then again while
 * the download and upload are saturated (via Cloudflare's speed endpoints).
 * The rise in latency under load is "bufferbloat", graded A+..F the way
 * Waveform / DSLReports do. A VoIP Mean Opinion Score (MOS, 1..4.5) is derived
 * from latency, jitter and loss using the simplified ITU E-model.
 *
 * Emits: 'phase' { phase, label }, 'sample' { phase, latency, ts },
 *        'result' <summary>, 'error'.
 */

const https = require('https');
const { EventEmitter } = require('events');

const HOST = 'speed.cloudflare.com';

const DEFAULTS = {
  idleMs: 4000,
  loadMs: 9000,
  probeIntervalMs: 200,
  downStreams: 6,
  upStreams: 3,
  downChunk: 25 * 1024 * 1024,
};

function round(n, d = 1) { const f = 10 ** d; return Math.round(n * f) / f; }

/** Grade the latency increase under load. Returns { grade, className }. */
function bufferbloatGrade(increaseMs) {
  if (increaseMs < 5) return { grade: 'A+', rank: 0 };
  if (increaseMs < 30) return { grade: 'A', rank: 1 };
  if (increaseMs < 60) return { grade: 'B', rank: 2 };
  if (increaseMs < 100) return { grade: 'C', rank: 3 };
  if (increaseMs < 200) return { grade: 'D', rank: 4 };
  return { grade: 'F', rank: 5 };
}

/** Simplified E-model MOS from latency (ms), jitter (ms) and loss (%). */
function computeMos(latency, jitter, lossPct) {
  const effLatency = latency + jitter * 2 + 10;
  let r = effLatency < 160 ? 93.2 - effLatency / 40 : 93.2 - (effLatency - 120) / 10;
  r -= lossPct * 2.5;
  if (r < 0) r = 0;
  let mos = 1 + 0.035 * r + r * (r - 60) * (100 - r) * 7e-6;
  if (mos < 1) mos = 1;
  if (mos > 4.5) mos = 4.5;
  return round(mos, 2);
}

function mosRating(mos) {
  if (mos >= 4.3) return 'Excellent';
  if (mos >= 4.0) return 'Good';
  if (mos >= 3.6) return 'Fair';
  if (mos >= 3.1) return 'Poor';
  return 'Bad';
}

function stats(latencies) {
  const good = latencies.filter((x) => x != null);
  const loss = latencies.length ? Math.round(((latencies.length - good.length) / latencies.length) * 100) : 0;
  if (!good.length) return { avg: null, min: null, max: null, jitter: null, loss, samples: 0 };
  const min = Math.min(...good);
  const max = Math.max(...good);
  const avg = good.reduce((a, b) => a + b, 0) / good.length;
  let js = 0;
  for (let i = 1; i < good.length; i += 1) js += Math.abs(good[i] - good[i - 1]);
  const jitter = good.length > 1 ? js / (good.length - 1) : 0;
  return { avg: round(avg), min: round(min), max: round(max), jitter: round(jitter), loss, samples: good.length };
}

class QualityTest extends EventEmitter {
  constructor() {
    super();
    this.cancelled = false;
    this.running = false;
    this._sockets = new Set();
  }

  cancel() { this.cancelled = true; this._stopLoad(); }

  _agent() { return new https.Agent({ keepAlive: true, maxSockets: 32 }); }

  _probe(agent, timeout = 3000) {
    return new Promise((resolve) => {
      const start = process.hrtime.bigint();
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const req = https.get({ host: HOST, path: '/__down?bytes=0', agent, timeout, headers: { 'Cache-Control': 'no-cache' } }, (res) => {
        const ttfb = Number(process.hrtime.bigint() - start) / 1e6;
        res.on('data', () => {});
        res.on('end', () => finish(ttfb));
        res.resume();
      });
      req.on('timeout', () => { req.destroy(); finish(null); });
      req.on('error', () => finish(null));
    });
  }

  _startDownloadLoad(agent, opts) {
    const spawn = () => {
      if (!this._loading || this.cancelled) return;
      const req = https.get({ host: HOST, path: `/__down?bytes=${opts.downChunk}`, agent, headers: { 'Cache-Control': 'no-cache' } }, (res) => {
        res.on('data', (c) => { this._loadBytes += c.length; });
        res.on('end', () => { this._sockets.delete(req); if (this._loading) spawn(); });
        res.on('error', () => { this._sockets.delete(req); });
      });
      req.on('error', () => { this._sockets.delete(req); if (this._loading) setTimeout(spawn, 50); });
      this._sockets.add(req);
    };
    for (let i = 0; i < opts.downStreams; i += 1) spawn();
  }

  _startUploadLoad(agent, opts) {
    const buf = Buffer.alloc(256 * 1024, 0x61);
    const spawn = () => {
      if (!this._loading || this.cancelled) return;
      const req = https.request({ host: HOST, path: '/__up', method: 'POST', agent, headers: { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' } }, (res) => {
        res.on('data', () => {});
        res.on('end', () => { this._sockets.delete(req); if (this._loading) spawn(); });
      });
      req.on('error', () => { this._sockets.delete(req); if (this._loading) setTimeout(spawn, 50); });
      this._sockets.add(req);
      const pump = () => {
        if (!this._loading || this.cancelled || req.destroyed) { try { req.end(); } catch (_) { /* */ } return; }
        let ok = true;
        while (ok && this._loading) { ok = req.write(buf); this._loadBytes += buf.length; if (Math.random() < 0.02) { req.end(); return; } }
        if (this._loading) req.once('drain', pump);
      };
      pump();
    };
    for (let i = 0; i < opts.upStreams; i += 1) spawn();
  }

  _stopLoad() {
    this._loading = false;
    for (const s of this._sockets) { try { s.destroy(); } catch (_) { /* */ } }
    this._sockets.clear();
  }

  /** Probe latency repeatedly for `durationMs`, returning the array of samples. */
  async _probeLoop(agent, phase, durationMs, opts) {
    const samples = [];
    const end = Date.now() + durationMs;
    while (Date.now() < end && !this.cancelled) {
      // eslint-disable-next-line no-await-in-loop
      const t = await this._probe(agent);
      samples.push(t);
      this.emit('sample', { phase, latency: t == null ? null : round(t), ts: Date.now() });
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, opts.probeIntervalMs));
    }
    return samples;
  }

  async run(options = {}) {
    if (this.running) throw new Error('Quality test already running');
    const opts = { ...DEFAULTS, ...options };
    this.running = true;
    this.cancelled = false;
    const agent = this._agent();
    const started = Date.now();

    try {
      // 1. Idle
      this.emit('phase', { phase: 'idle', label: 'Measuring idle latency…' });
      const idle = stats(await this._probeLoop(agent, 'idle', opts.idleMs, opts));
      if (this.cancelled) throw new Error('cancelled');

      // 2. Download load
      this.emit('phase', { phase: 'download', label: 'Latency under download load…' });
      this._loading = true; this._loadBytes = 0;
      const dlStart = Date.now();
      this._startDownloadLoad(agent, opts);
      const download = stats(await this._probeLoop(agent, 'download', opts.loadMs, opts));
      const dlBytes = this._loadBytes; const dlSecs = (Date.now() - dlStart) / 1000;
      this._stopLoad();
      const downloadMbps = dlSecs > 0 ? round((dlBytes * 8) / dlSecs / 1e6, 1) : 0;
      if (this.cancelled) throw new Error('cancelled');

      // 3. Upload load
      this.emit('phase', { phase: 'upload', label: 'Latency under upload load…' });
      this._loading = true; this._loadBytes = 0;
      const ulStart = Date.now();
      this._startUploadLoad(agent, opts);
      const upload = stats(await this._probeLoop(agent, 'upload', opts.loadMs, opts));
      const ulBytes = this._loadBytes; const ulSecs = (Date.now() - ulStart) / 1000;
      this._stopLoad();
      const uploadMbps = ulSecs > 0 ? round((ulBytes * 8) / ulSecs / 1e6, 1) : 0;

      const baseline = idle.min != null ? idle.min : (idle.avg || 0);
      const loadedAvg = Math.max(download.avg || 0, upload.avg || 0);
      const increase = round(Math.max(0, loadedAvg - baseline));
      const g = bufferbloatGrade(increase);
      const mos = computeMos(idle.avg || 0, idle.jitter || 0, idle.loss || 0);

      const result = {
        idle, download, upload,
        baselineMs: round(baseline),
        loadedLatencyMs: round(loadedAvg),
        bufferbloatMs: increase,
        grade: g.grade,
        gradeRank: g.rank,
        mos,
        mosRating: mosRating(mos),
        downloadMbps,
        uploadMbps,
        elapsedMs: Date.now() - started,
      };
      this.emit('phase', { phase: 'done', label: 'Complete' });
      this.emit('result', result);
      return result;
    } catch (err) {
      this._stopLoad();
      if (this.cancelled) { this.emit('result', { cancelled: true }); return { cancelled: true }; }
      this.emit('error', err);
      throw err;
    } finally {
      this.running = false;
      try { agent.destroy(); } catch (_) { /* */ }
    }
  }
}

module.exports = { QualityTest, bufferbloatGrade, computeMos, mosRating, DEFAULTS };
