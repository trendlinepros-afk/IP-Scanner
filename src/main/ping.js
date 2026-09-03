'use strict';

/**
 * Host liveness detection.
 *
 * Primary method is the platform `ping` binary (works without elevated
 * privileges on Windows/macOS/Linux).  A TCP-connect probe against a handful of
 * common ports is used as a fallback so that hosts which drop ICMP echo
 * (a very common firewall default) are still discovered.
 */

const { spawn } = require('child_process');
const net = require('net');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/**
 * Ping a single host once. Resolves to { alive, timeMs } — never rejects.
 * @param {string} ip
 * @param {number} timeoutMs
 */
function icmpPing(ip, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let args;
    if (isWin) {
      // -n 1 : one echo, -w ms : timeout
      args = ['-n', '1', '-w', String(timeoutMs), ip];
    } else if (isMac) {
      // macOS ping wants timeout in ms via -W? Actually -t is TTL; -W is ms wait for reply.
      args = ['-c', '1', '-W', String(timeoutMs), ip];
    } else {
      // Linux: -W is seconds (float ok), -w overall deadline seconds
      const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
      args = ['-c', '1', '-W', String(secs), ip];
    }

    const start = Date.now();
    let done = false;
    let stdout = '';

    const child = spawn('ping', args, { windowsHide: true });

    const finish = (alive) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      try {
        child.kill();
      } catch (_) {
        /* ignore */
      }
      resolve({ alive, timeMs: parseRtt(stdout) ?? Date.now() - start });
    };

    const killTimer = setTimeout(() => finish(false), timeoutMs + 800);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0 && looksAlive(stdout)));
  });
}

/** Some systems return code 0 even for unreachable hosts; verify from output. */
function looksAlive(out) {
  if (!out) return true; // trust the exit code when there is no output to check
  const lower = out.toLowerCase();
  if (lower.includes('unreachable') || lower.includes('100% packet loss') ||
      lower.includes('100% loss') || lower.includes('timed out')) {
    return false;
  }
  return lower.includes('ttl=') || lower.includes('ttl:') ||
    lower.includes('bytes from') || lower.includes('bytes=');
}

/** Extract round-trip time (ms) from ping output when available. */
function parseRtt(out) {
  if (!out) return null;
  const m = out.match(/time[=<]\s*([\d.]+)\s*ms/i);
  if (m) return Math.round(parseFloat(m[1]));
  return null;
}

/** TCP connect probe: alive if any of the given ports accepts/refuses fast. */
function tcpProbe(ip, ports = [445, 139, 80, 443, 22, 135, 3389], timeoutMs = 800) {
  return new Promise((resolve) => {
    let pending = ports.length;
    let resolved = false;
    const start = Date.now();

    const settle = (alive) => {
      if (resolved) return;
      resolved = true;
      resolve({ alive, timeMs: Date.now() - start });
    };

    for (const port of ports) {
      const socket = new net.Socket();
      let handled = false;
      const cleanup = () => {
        if (handled) return;
        handled = true;
        socket.destroy();
        pending -= 1;
        if (pending === 0) settle(false);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => {
        // Open port => host is definitely up.
        socket.destroy();
        settle(true);
      });
      // A RST (ECONNREFUSED) also proves the host is alive.
      socket.once('error', (err) => {
        if (err && err.code === 'ECONNREFUSED') {
          settle(true);
        }
        cleanup();
      });
      socket.once('timeout', cleanup);
      try {
        socket.connect(port, ip);
      } catch (_) {
        cleanup();
      }
    }

    if (ports.length === 0) settle(false);
  });
}

/**
 * Determine whether a host is alive, using ICMP first and TCP as a fallback.
 * @param {string} ip
 * @param {object} opts { timeoutMs, tcpFallback }
 */
async function isAlive(ip, opts = {}) {
  const timeoutMs = opts.timeoutMs || 1000;
  const icmp = await icmpPing(ip, timeoutMs);
  if (icmp.alive) return { alive: true, timeMs: icmp.timeMs, method: 'icmp' };
  if (opts.tcpFallback === false) return { alive: false, timeMs: null, method: 'icmp' };
  const tcp = await tcpProbe(ip, opts.tcpPorts, Math.min(timeoutMs, 900));
  return { alive: tcp.alive, timeMs: tcp.alive ? tcp.timeMs : null, method: tcp.alive ? 'tcp' : 'none' };
}

module.exports = { icmpPing, tcpProbe, isAlive, parseRtt };
