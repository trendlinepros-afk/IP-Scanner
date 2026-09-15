'use strict';

/**
 * Continuous latency monitor (PingPlotter / MTR style).
 * Sends one ICMP echo per interval and streams each result plus running
 * statistics (min/avg/max/jitter/loss) so the UI can draw a live graph.
 *
 * Emits: 'sample' { seq, rtt, ok, ts }, 'stats' { ... }.
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function singlePing(ip, timeoutMs) {
  return new Promise((resolve) => {
    let args;
    if (isWin) args = ['-n', '1', '-w', String(timeoutMs), ip];
    else if (isMac) args = ['-c', '1', '-W', String(timeoutMs), ip];
    else args = ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), ip];

    let out = '';
    let settled = false;
    const child = spawn('ping', args, { windowsHide: true });
    const done = (rtt) => {
      if (settled) return;
      settled = true;
      resolve(rtt);
    };
    const killer = setTimeout(() => { try { child.kill(); } catch (_) { /* */ } done(null); }, timeoutMs + 1500);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(killer); done(null); });
    child.on('close', () => {
      clearTimeout(killer);
      const m = out.match(/time[=<]\s*([\d.]+)\s*ms/i);
      if (m && /ttl[=:]/i.test(out)) return done(parseFloat(m[1]));
      if (m) return done(parseFloat(m[1]));
      done(null);
    });
  });
}

class LatencyMonitor extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.timer = null;
    this.reset();
  }

  reset() {
    this.seq = 0;
    this.sent = 0;
    this.recv = 0;
    this.lost = 0;
    this.min = null;
    this.max = null;
    this.sum = 0;
    this.last = null;
    this.prev = null;
    this.jitterSum = 0;
    this.jitterN = 0;
  }

  start(target, options = {}) {
    if (this.running) this.stop();
    const intervalMs = Math.max(200, options.intervalMs || 1000);
    const timeoutMs = options.timeoutMs || 2000;
    this.running = true;
    this.reset();

    const tick = async () => {
      if (!this.running) return;
      this.seq += 1;
      this.sent += 1;
      const seq = this.seq;
      const rtt = await singlePing(target, timeoutMs);
      if (!this.running) return;
      const ok = rtt != null;
      if (ok) {
        this.recv += 1;
        this.last = rtt;
        this.sum += rtt;
        this.min = this.min == null ? rtt : Math.min(this.min, rtt);
        this.max = this.max == null ? rtt : Math.max(this.max, rtt);
        if (this.prev != null) { this.jitterSum += Math.abs(rtt - this.prev); this.jitterN += 1; }
        this.prev = rtt;
      } else {
        this.lost += 1;
      }
      this.emit('sample', { seq, rtt: ok ? Math.round(rtt * 100) / 100 : null, ok, ts: Date.now() });
      this.emit('stats', this.stats());
    };

    // Fire immediately, then on an interval. Guard against overlap.
    let busy = false;
    this.timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try { await tick(); } finally { busy = false; }
    }, intervalMs);
    tick();
  }

  stats() {
    const round = (n) => (n == null ? null : Math.round(n * 100) / 100);
    return {
      sent: this.sent,
      recv: this.recv,
      lost: this.lost,
      lossPct: this.sent ? Math.round((this.lost / this.sent) * 100) : 0,
      min: round(this.min),
      max: round(this.max),
      avg: this.recv ? round(this.sum / this.recv) : null,
      jitter: this.jitterN ? round(this.jitterSum / this.jitterN) : null,
      last: round(this.last),
    };
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

module.exports = { LatencyMonitor, singlePing };
