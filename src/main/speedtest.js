'use strict';

/**
 * Internet speed test — download / upload throughput plus latency and jitter,
 * measured against Cloudflare's public speed endpoints (no API key required):
 *   download: GET  https://speed.cloudflare.com/__down?bytes=N
 *   upload:   POST https://speed.cloudflare.com/__up
 *
 * The engine streams live samples so the UI can animate a gauge, exactly like
 * Ookla / Cloudflare's own web test. Multiple parallel connections are used so
 * fast links (gigabit) are saturated.
 *
 * Emits (via EventEmitter):
 *   'phase'    { phase: 'latency'|'download'|'upload'|'done', label }
 *   'sample'   { phase, mbps, bytes, pct }
 *   'latency'  { min, avg, max, jitter, loss, samples }
 *   'result'   { downloadMbps, uploadMbps, ping, jitter, loss, server, elapsedMs }
 *   'error'    Error
 */

const https = require('https');
const { EventEmitter } = require('events');

const HOST = 'speed.cloudflare.com';

const DEFAULTS = {
  latencyCount: 20,
  downloadSeconds: 12,
  uploadSeconds: 10,
  warmupMs: 1200,
  downloadStreams: 6,
  uploadStreams: 3,
  downloadChunkBytes: 25 * 1024 * 1024,
  localAddress: undefined, // bind to a specific adapter if provided
};

class SpeedTest extends EventEmitter {
  constructor() {
    super();
    this.cancelled = false;
    this.running = false;
  }

  cancel() {
    this.cancelled = true;
  }

  _agent(localAddress) {
    return new https.Agent({ keepAlive: true, maxSockets: 64, localAddress });
  }

  /** One latency probe: time-to-first-byte of a 0-byte download. */
  _probe(agent, timeout = 4000) {
    return new Promise((resolve) => {
      const start = process.hrtime.bigint();
      let settled = false;
      const done = (val) => {
        if (!settled) {
          settled = true;
          resolve(val);
        }
      };
      const req = https.get({
        host: HOST, path: '/__down?bytes=0', agent, timeout,
        headers: { 'User-Agent': 'IP-Scanner-SpeedTest/1.0', 'Cache-Control': 'no-cache' },
      }, (res) => {
        const ttfb = Number(process.hrtime.bigint() - start) / 1e6;
        res.on('data', () => {});
        res.on('end', () => done(ttfb));
        res.resume();
      });
      req.on('timeout', () => { req.destroy(); done(null); });
      req.on('error', () => done(null));
    });
  }

  async _latency(agent, count) {
    const times = [];
    let loss = 0;
    for (let i = 0; i < count && !this.cancelled; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const t = await this._probe(agent);
      if (t == null) loss += 1;
      else {
        times.push(t);
        this.emit('sample', { phase: 'latency', ping: Math.round(t * 100) / 100, pct: (i + 1) / count });
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 40));
    }
    if (times.length === 0) return { min: 0, avg: 0, max: 0, jitter: 0, loss: 100, samples: 0 };
    const min = Math.min(...times);
    const max = Math.max(...times);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    let jitterSum = 0;
    for (let i = 1; i < times.length; i += 1) jitterSum += Math.abs(times[i] - times[i - 1]);
    const jitter = times.length > 1 ? jitterSum / (times.length - 1) : 0;
    const round = (n) => Math.round(n * 100) / 100;
    return {
      min: round(min),
      avg: round(avg),
      max: round(max),
      jitter: round(jitter),
      loss: Math.round((loss / count) * 100),
      samples: times.length,
    };
  }

  /** Run a throughput phase (download or upload) for `seconds`. */
  _throughput(phase, agent, opts) {
    const seconds = phase === 'download' ? opts.downloadSeconds : opts.uploadSeconds;
    const streams = phase === 'download' ? opts.downloadStreams : opts.uploadStreams;
    return new Promise((resolve) => {
      let totalBytes = 0; // counted from steady-state window
      let warmBytes = 0; // counted from t0 (for gauge)
      const start = Date.now();
      let steadyStart = 0;
      let finished = false;
      const active = new Set();

      const uploadBuf = phase === 'upload' ? Buffer.alloc(256 * 1024, 0x61) : null;

      const stop = () => {
        if (finished) return;
        finished = true;
        clearInterval(sampler);
        for (const req of active) {
          try { req.destroy(); } catch (_) { /* ignore */ }
        }
        const elapsed = (Date.now() - (steadyStart || start)) / 1000;
        const mbps = elapsed > 0 ? (totalBytes * 8) / elapsed / 1e6 : 0;
        resolve(Math.round(mbps * 100) / 100);
      };

      const sampler = setInterval(() => {
        const now = Date.now();
        if (!steadyStart && now - start >= opts.warmupMs) {
          steadyStart = now;
          totalBytes = 0;
        }
        const winStart = steadyStart || start;
        const elapsed = (now - winStart) / 1000;
        const bytesForRate = steadyStart ? totalBytes : warmBytes;
        const mbps = elapsed > 0 ? (bytesForRate * 8) / elapsed / 1e6 : 0;
        const pct = Math.min(1, (now - start) / (seconds * 1000));
        this.emit('sample', { phase, mbps: Math.round(mbps * 100) / 100, bytes: warmBytes, pct });
        if (now - start >= seconds * 1000 || this.cancelled) stop();
      }, 200);

      const countBytes = (n) => {
        warmBytes += n;
        if (steadyStart) totalBytes += n;
      };

      const startDownloadWorker = () => {
        if (finished || this.cancelled) return;
        const req = https.get({
          host: HOST,
          path: `/__down?bytes=${opts.downloadChunkBytes}`,
          agent,
          headers: { 'User-Agent': 'IP-Scanner-SpeedTest/1.0', 'Cache-Control': 'no-cache' },
        }, (res) => {
          res.on('data', (chunk) => countBytes(chunk.length));
          res.on('end', () => {
            active.delete(req);
            if (!finished) startDownloadWorker();
          });
          res.on('error', () => { active.delete(req); });
        });
        req.on('error', () => { active.delete(req); if (!finished) setTimeout(startDownloadWorker, 50); });
        active.add(req);
      };

      const startUploadWorker = () => {
        if (finished || this.cancelled) return;
        const req = https.request({
          host: HOST,
          path: '/__up',
          method: 'POST',
          agent,
          headers: {
            'User-Agent': 'IP-Scanner-SpeedTest/1.0',
            'Content-Type': 'application/octet-stream',
            'Transfer-Encoding': 'chunked',
          },
        }, (res) => {
          res.on('data', () => {});
          res.on('end', () => {
            active.delete(req);
            if (!finished) startUploadWorker();
          });
        });
        req.on('error', () => { active.delete(req); if (!finished) setTimeout(startUploadWorker, 50); });
        active.add(req);
        // Pump data until the phase ends.
        const pump = () => {
          if (finished || this.cancelled) { try { req.end(); } catch (_) { /* */ } return; }
          let ok = true;
          while (ok && !finished) {
            ok = req.write(uploadBuf);
            countBytes(uploadBuf.length);
            // Cap a single request's body so connections rotate.
            if (Math.random() < 0.02) { req.end(); return; }
          }
          if (!finished) req.once('drain', pump);
        };
        pump();
      };

      const worker = phase === 'download' ? startDownloadWorker : startUploadWorker;
      for (let i = 0; i < streams; i += 1) worker();
    });
  }

  async run(options = {}) {
    if (this.running) throw new Error('Speed test already running');
    const opts = { ...DEFAULTS, ...options };
    this.running = true;
    this.cancelled = false;
    const agent = this._agent(opts.localAddress);
    const started = Date.now();
    const result = {
      downloadMbps: 0, uploadMbps: 0, ping: 0, jitter: 0, loss: 0, server: `${HOST} (Cloudflare)`,
    };

    try {
      // 1) Latency
      this.emit('phase', { phase: 'latency', label: 'Measuring latency…' });
      const lat = await this._latency(agent, opts.latencyCount);
      result.ping = lat.avg;
      result.jitter = lat.jitter;
      result.loss = lat.loss;
      this.emit('latency', lat);
      if (this.cancelled) throw new Error('cancelled');

      // 2) Download
      this.emit('phase', { phase: 'download', label: 'Testing download…' });
      result.downloadMbps = await this._throughput('download', agent, opts);
      if (this.cancelled) throw new Error('cancelled');

      // 3) Upload
      this.emit('phase', { phase: 'upload', label: 'Testing upload…' });
      result.uploadMbps = await this._throughput('upload', agent, opts);

      result.elapsedMs = Date.now() - started;
      this.emit('phase', { phase: 'done', label: 'Complete' });
      this.emit('result', result);
      return result;
    } catch (err) {
      if (this.cancelled) {
        this.emit('result', { ...result, cancelled: true, elapsedMs: Date.now() - started });
        return { ...result, cancelled: true };
      }
      this.emit('error', err);
      throw err;
    } finally {
      this.running = false;
      try { agent.destroy(); } catch (_) { /* ignore */ }
    }
  }
}

module.exports = { SpeedTest, DEFAULTS };
