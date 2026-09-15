'use strict';

/**
 * LAN throughput test (a lightweight iPerf). One machine runs the server; the
 * other runs the client. Great for comparing WiFi vs Ethernet on the local
 * network. A loopback test (client -> 127.0.0.1 server on the same machine)
 * works as a sanity check of the local stack.
 *
 * Wire protocol (dead simple):
 *   client connects, sends 1 byte:
 *     'D' -> server streams data to client (client measures DOWNLOAD)
 *     'U' -> client streams data to server (client measures UPLOAD)
 *   throughput runs until the socket is closed by the measuring side.
 *
 * LanSpeedServer: start(port)/stop(); emits 'client', 'clientDone'.
 * LanSpeedClient: run({host,port,mode,seconds,streams}); emits 'sample','result','error'.
 */

const net = require('net');
const os = require('os');
const { EventEmitter } = require('events');

const DEFAULT_PORT = 5201;
const BLOCK = Buffer.alloc(4 * 1024 * 1024, 0x58); // 4MB payload block

function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

class LanSpeedServer extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.port = null;
  }

  start(port = DEFAULT_PORT) {
    return new Promise((resolve, reject) => {
      if (this.server) return resolve(this.info());
      const server = net.createServer((socket) => {
        socket.once('data', (first) => {
          const mode = String.fromCharCode(first[0]);
          const remote = `${socket.remoteAddress}:${socket.remotePort}`;
          this.emit('client', { remote, mode });
          if (mode === 'D') {
            // Stream data to the client until it disconnects.
            const pump = () => {
              if (socket.destroyed) return;
              let ok = true;
              while (ok) ok = socket.write(BLOCK);
              if (!socket.destroyed) socket.once('drain', pump);
            };
            // Account for any extra bytes beyond the mode byte (ignored).
            pump();
            socket.on('close', () => this.emit('clientDone', { remote, mode }));
            socket.on('error', () => {});
          } else {
            // Receive data from the client and measure.
            let bytes = first.length - 1;
            const start = Date.now();
            socket.on('data', (chunk) => { bytes += chunk.length; });
            socket.on('close', () => {
              const secs = (Date.now() - start) / 1000;
              const mbps = secs > 0 ? Math.round((bytes * 8) / secs / 1e6 * 100) / 100 : 0;
              this.emit('clientDone', { remote, mode, mbps, bytes });
            });
            socket.on('error', () => {});
          }
        });
        socket.on('error', () => {});
      });
      server.on('error', (err) => reject(err));
      server.listen(port, '0.0.0.0', () => {
        this.server = server;
        this.port = server.address().port; // resolve ephemeral (0) to the real port
        resolve(this.info());
      });
    });
  }

  info() {
    return {
      listening: !!this.server,
      port: this.port,
      addresses: lanAddresses(),
    };
  }

  stop() {
    if (this.server) { try { this.server.close(); } catch (_) { /* */ } this.server = null; }
    return { listening: false };
  }
}

class LanSpeedClient extends EventEmitter {
  constructor() {
    super();
    this.sockets = [];
    this.running = false;
  }

  cancel() {
    this.running = false;
    for (const s of this.sockets) { try { s.destroy(); } catch (_) { /* */ } }
    this.sockets = [];
  }

  run(options = {}) {
    const host = options.host || '127.0.0.1';
    const port = options.port || DEFAULT_PORT;
    const mode = options.mode === 'upload' ? 'U' : 'D';
    const seconds = Math.max(2, options.seconds || 10);
    const streams = Math.max(1, Math.min(16, options.streams || 4));
    const warmupMs = 800;

    return new Promise((resolve, reject) => {
      this.running = true;
      let totalBytes = 0;
      let warmBytes = 0;
      const start = Date.now();
      let steadyStart = 0;
      let finished = false;
      let connectErrors = 0;
      let connected = 0;

      const count = (n) => { warmBytes += n; if (steadyStart) totalBytes += n; };

      const finish = () => {
        if (finished) return;
        finished = true;
        this.running = false;
        clearInterval(sampler);
        for (const s of this.sockets) { try { s.destroy(); } catch (_) { /* */ } }
        const secs = (Date.now() - (steadyStart || start)) / 1000;
        const mbps = secs > 0 ? Math.round((totalBytes * 8) / secs / 1e6 * 100) / 100 : 0;
        resolve({ mbps, bytes: warmBytes, seconds: Math.round(secs * 10) / 10, mode: mode === 'D' ? 'download' : 'upload', host, port });
      };

      const sampler = setInterval(() => {
        const now = Date.now();
        if (!steadyStart && now - start >= warmupMs) { steadyStart = now; totalBytes = 0; }
        const winStart = steadyStart || start;
        const secs = (now - winStart) / 1000;
        const bytesForRate = steadyStart ? totalBytes : warmBytes;
        const mbps = secs > 0 ? Math.round((bytesForRate * 8) / secs / 1e6 * 100) / 100 : 0;
        const pct = Math.min(1, (now - start) / (seconds * 1000));
        this.emit('sample', { mbps, bytes: warmBytes, pct });
        if (now - start >= seconds * 1000) finish();
      }, 200);

      for (let i = 0; i < streams; i += 1) {
        const socket = net.connect(port, host);
        this.sockets.push(socket);
        socket.on('connect', () => {
          connected += 1;
          socket.write(Buffer.from(mode));
          if (mode === 'U') {
            const pump = () => {
              if (finished || socket.destroyed) return;
              let ok = true;
              while (ok && !finished) { ok = socket.write(BLOCK); count(BLOCK.length); }
              if (!finished && !socket.destroyed) socket.once('drain', pump);
            };
            pump();
          } else {
            socket.on('data', (chunk) => count(chunk.length));
          }
        });
        socket.on('error', (err) => {
          connectErrors += 1;
          if (connected === 0 && connectErrors >= streams && !finished) {
            clearInterval(sampler);
            this.running = false;
            reject(new Error(`Could not connect to ${host}:${port} — ${err.code || err.message}`));
          }
        });
      }
    });
  }
}

module.exports = { LanSpeedServer, LanSpeedClient, DEFAULT_PORT, lanAddresses };
