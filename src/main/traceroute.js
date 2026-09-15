'use strict';

/**
 * Streaming traceroute. Runs the OS traceroute/tracert and parses each hop as
 * it appears, emitting a structured row so the UI can build a live hop table
 * with per-hop latency and loss.
 *
 * Emits: 'hop' { hop, host, ip, times:[ms|null], avg, loss }, 'done', 'error'.
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const isWin = process.platform === 'win32';

function parseWindowsHop(line) {
  // "  1     1 ms     1 ms     1 ms  192.168.1.1"
  // "  2     *        *        *     Request timed out."
  // "  3    10 ms    9 ms    11 ms  host.name [1.2.3.4]"
  const m = line.match(/^\s*(\d+)\s+(.*)$/);
  if (!m) return null;
  const hop = parseInt(m[1], 10);
  const rest = m[2];
  const times = [];
  const timeRe = /(\*|<?\d+)\s*ms|\*/g;
  // Collect up to 3 timing tokens from the front.
  const tokens = rest.split(/\s{2,}/);
  let host = '';
  let ip = '';
  for (const tok of tokens) {
    const t = tok.trim();
    if (!t) continue;
    if (t === '*') { times.push(null); continue; }
    const tm = t.match(/^<?(\d+)\s*ms$/);
    if (tm) { times.push(parseInt(tm[1], 10)); continue; }
    // Host / IP portion
    const ipM = t.match(/\[?(\d{1,3}(?:\.\d{1,3}){3})\]?/);
    if (ipM) ip = ipM[1];
    const hostM = t.match(/^([^\[]+?)\s*\[/);
    if (hostM) host = hostM[1].trim();
    else if (!ipM) host = t;
  }
  if (!ip && host && /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) { ip = host; host = ''; }
  return finalizeHop(hop, host, ip, times);
}

function parseUnixHop(line) {
  // " 1  192.168.1.1 (192.168.1.1)  1.234 ms  1.111 ms  1.000 ms"
  // " 2  * * *"
  const m = line.match(/^\s*(\d+)\s+(.*)$/);
  if (!m) return null;
  const hop = parseInt(m[1], 10);
  const rest = m[2];
  const times = [];
  const timeRe = /([\d.]+)\s*ms/g;
  let tm;
  while ((tm = timeRe.exec(rest)) !== null) times.push(parseFloat(tm[1]));
  const stars = (rest.match(/\*/g) || []).length;
  for (let i = 0; i < stars; i += 1) times.push(null);
  let host = '';
  let ip = '';
  const ipM = rest.match(/\((\d{1,3}(?:\.\d{1,3}){3})\)/) || rest.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
  if (ipM) ip = ipM[1];
  const hostM = rest.match(/^([^\s(]+)\s+\(/);
  if (hostM) host = hostM[1];
  return finalizeHop(hop, host, ip, times);
}

function finalizeHop(hop, host, ip, times) {
  const good = times.filter((t) => t != null);
  const avg = good.length ? Math.round((good.reduce((a, b) => a + b, 0) / good.length) * 100) / 100 : null;
  const loss = times.length ? Math.round(((times.length - good.length) / times.length) * 100) : 0;
  return {
    hop, host: host || '', ip: ip || (host && /^\d/.test(host) ? host : ''), times, avg, loss,
  };
}

class Traceroute extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.running = false;
  }

  run(target, options = {}) {
    if (this.running) this.stop();
    const maxHops = options.maxHops || 30;
    this.running = true;

    let cmd;
    let args;
    if (isWin) { cmd = 'tracert'; args = ['-d', '-h', String(maxHops), target]; } else { cmd = 'traceroute'; args = ['-n', '-q', '3', '-m', String(maxHops), target]; }
    // Prefer numeric on Windows too but also resolve names when possible:
    if (isWin) args = ['-h', String(maxHops), target];

    let buffer = '';
    const child = spawn(cmd, args, { windowsHide: true });
    this.child = child;

    const handleLine = (line) => {
      const hop = isWin ? parseWindowsHop(line) : parseUnixHop(line);
      if (hop && hop.hop) this.emit('hop', hop);
    };

    child.stdout.on('data', (d) => {
      buffer += d.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) handleLine(line);
    });
    child.stderr.on('data', () => {});
    child.on('error', (err) => {
      this.running = false;
      this.emit('error', err);
    });
    child.on('close', () => {
      if (buffer.trim()) handleLine(buffer);
      this.running = false;
      this.emit('done');
    });
  }

  stop() {
    this.running = false;
    if (this.child) { try { this.child.kill(); } catch (_) { /* */ } this.child = null; }
  }
}

module.exports = { Traceroute, parseWindowsHop, parseUnixHop };
