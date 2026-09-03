'use strict';

/**
 * External / OS integration tools reachable from a host's context menu, the
 * same set Advanced IP Scanner offers: RDP, Radmin, SSH, Telnet, ping,
 * tracert, open shares in Explorer, open web UI in the browser, shutdown.
 *
 * Where a GUI client exists (mstsc, Explorer, browser) we launch it directly.
 * For the text tools (ping/tracert/nslookup) we run the command and stream the
 * captured output back so the renderer can show it in a console panel.
 */

const { spawn, exec } = require('child_process');
const { shell } = require('electron');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/** Run a command and collect its combined output (bounded). */
function runCapture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let out = '';
    const timeout = opts.timeoutMs || 20000;
    const child = spawn(cmd, args, { windowsHide: true });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        /* ignore */
      }
    }, timeout);
    const onData = (d) => {
      out += d.toString();
      if (out.length > 200000) {
        try {
          child.kill();
        } catch (_) {
          /* ignore */
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${out}\n${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: out });
    });
  });
}

/** ICMP ping (a few echoes) with captured output. */
function ping(ip, count = 4) {
  const args = isWin ? ['-n', String(count), ip] : ['-c', String(count), ip];
  return runCapture('ping', args, { timeoutMs: 15000 });
}

/** Traceroute / tracert with captured output. */
function traceroute(ip) {
  if (isWin) return runCapture('tracert', ['-d', '-h', '20', ip], { timeoutMs: 40000 });
  const bin = isMac ? 'traceroute' : 'traceroute';
  return runCapture(bin, ['-n', '-m', '20', ip], { timeoutMs: 40000 });
}

/** DNS lookup. */
function nslookup(host) {
  return runCapture('nslookup', [host], { timeoutMs: 10000 });
}

/** Open an RDP session (Windows mstsc; cross-platform clients elsewhere). */
function rdp(ip) {
  return new Promise((resolve) => {
    if (isWin) {
      spawn('mstsc', [`/v:${ip}`], { detached: true, windowsHide: false, stdio: 'ignore' }).unref();
      return resolve({ ok: true, launched: 'mstsc' });
    }
    // rdp:// URL is handled by some clients; fall back to opening a helper.
    shell.openExternal(`rdp://${ip}`).then(
      () => resolve({ ok: true, launched: 'rdp-url' }),
      () => resolve({ ok: false, error: 'No RDP client available on this platform' }),
    );
  });
}

/** Open an SSH session in a terminal. */
function ssh(ip, user) {
  const target = user ? `${user}@${ip}` : ip;
  return new Promise((resolve) => {
    if (isWin) {
      // Use the built-in OpenSSH client in a new console window.
      spawn('cmd', ['/c', 'start', 'ssh', target], { detached: true, stdio: 'ignore' }).unref();
      resolve({ ok: true });
    } else if (isMac) {
      spawn('open', ['-a', 'Terminal', '--args']).on('error', () => {});
      exec(`osascript -e 'tell application "Terminal" to do script "ssh ${target}"'`);
      resolve({ ok: true });
    } else {
      // Try a few common terminals.
      const term = process.env.TERMINAL || 'x-terminal-emulator';
      spawn(term, ['-e', `ssh ${target}`], { detached: true, stdio: 'ignore' }).on('error', () => {});
      resolve({ ok: true });
    }
  });
}

/** Open a Telnet session. */
function telnet(ip) {
  return new Promise((resolve) => {
    if (isWin) {
      spawn('cmd', ['/c', 'start', 'telnet', ip], { detached: true, stdio: 'ignore' }).unref();
    } else {
      const term = process.env.TERMINAL || 'x-terminal-emulator';
      spawn(term, ['-e', `telnet ${ip}`], { detached: true, stdio: 'ignore' }).on('error', () => {});
    }
    resolve({ ok: true });
  });
}

/** Open the host's SMB shares in the OS file manager. */
function openShares(ip) {
  const url = isWin ? `\\\\${ip}` : `smb://${ip}`;
  return shell.openPath(isWin ? url : `smb://${ip}`).then((err) => {
    if (err && !isWin) return shell.openExternal(`smb://${ip}`);
    return { ok: true };
  }).then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e) }));
}

/** Open a URL (HTTP/HTTPS/FTP web UI) in the default browser. */
function openUrl(url) {
  return shell.openExternal(url).then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e) }));
}

/** Remotely shut down a Windows host (requires rights). */
function shutdown(ip) {
  if (!isWin) return Promise.resolve({ ok: false, error: 'Remote shutdown is Windows-only' });
  return runCapture('shutdown', ['/s', '/m', `\\\\${ip}`, '/t', '30'], { timeoutMs: 10000 });
}

module.exports = {
  ping,
  traceroute,
  nslookup,
  rdp,
  ssh,
  telnet,
  openShares,
  openUrl,
  shutdown,
};
