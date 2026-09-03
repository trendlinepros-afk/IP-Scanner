'use strict';

/**
 * The scan orchestrator.
 *
 * Emits events so the UI can render results live:
 *   'start'    { total }
 *   'progress' { done, total, alive }
 *   'host'     <hostRecord>            (a host was found alive / updated)
 *   'done'     { total, alive, elapsedMs, cancelled }
 *   'error'    Error
 *
 * A single Scanner instance runs one sweep at a time and can be cancelled.
 */

const { EventEmitter } = require('events');
const net = require('./network');
const ping = require('./ping');
const arp = require('./arp');
const oui = require('./oui');
const resolve = require('./resolve');
const ports = require('./ports');

const DEFAULT_OPTIONS = {
  concurrency: 64, // simultaneous hosts probed
  timeoutMs: 1000, // per-host ping timeout
  tcpFallback: true, // treat open/refused TCP as "alive" when ICMP is silent
  resolveNames: true,
  scanPorts: true,
  portList: ports.DEFAULT_PORTS,
};

class Scanner extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.cancelled = false;
    this._hosts = new Map();
  }

  isRunning() {
    return this.running;
  }

  cancel() {
    if (this.running) this.cancelled = true;
  }

  /** All hosts discovered in the most recent sweep. */
  results() {
    return Array.from(this._hosts.values());
  }

  /**
   * Run a scan over the given range string.
   * @param {string} range e.g. "192.168.1.1-254" or "10.0.0.0/24"
   * @param {object} options
   */
  async scan(range, options = {}) {
    if (this.running) throw new Error('A scan is already in progress');
    const opts = { ...DEFAULT_OPTIONS, ...options };
    this.running = true;
    this.cancelled = false;
    this._hosts = new Map();

    let ips;
    try {
      ips = net.expandRange(range);
    } catch (err) {
      this.running = false;
      this.emit('error', err);
      throw err;
    }

    const total = ips.length;
    const started = Date.now();
    this.emit('start', { total, range });

    let done = 0;
    let aliveCount = 0;
    let cursor = 0;

    // Pre-read the ARP cache once; refresh it after the ping sweep populates it.
    const worker = async () => {
      while (cursor < ips.length && !this.cancelled) {
        const ip = ips[cursor++];
        let record;
        try {
          const res = await ping.isAlive(ip, {
            timeoutMs: opts.timeoutMs,
            tcpFallback: opts.tcpFallback,
          });
          if (res.alive) {
            aliveCount += 1;
            record = {
              ip,
              status: 'alive',
              responseMs: res.timeMs,
              method: res.method,
              name: '',
              mac: '',
              vendor: '',
              ports: [],
              shares: [],
              services: [],
              lastSeen: Date.now(),
            };
            this._hosts.set(ip, record);
            this.emit('host', record);
          }
        } catch (_) {
          /* per-host failures are non-fatal */
        }
        done += 1;
        this.emit('progress', { done, total, alive: aliveCount });
      }
    };

    const workers = [];
    const n = Math.min(opts.concurrency, Math.max(1, total));
    for (let i = 0; i < n; i += 1) workers.push(worker());
    await Promise.all(workers);

    if (!this.cancelled) {
      // Enrich the alive hosts: MAC (from ARP), vendor, name, ports.
      await this._enrich(opts);
    }

    this.running = false;
    const payload = {
      total,
      alive: aliveCount,
      elapsedMs: Date.now() - started,
      cancelled: this.cancelled,
    };
    this.emit('done', payload);
    return { ...payload, hosts: this.results() };
  }

  /** Second pass over alive hosts: MAC/vendor/name/ports. */
  async _enrich(opts) {
    const alive = Array.from(this._hosts.values());
    if (alive.length === 0) return;

    this.emit('phase', { phase: 'enrich', count: alive.length });

    // MAC addresses come straight from the ARP cache the ping sweep warmed up.
    let arpTable = new Map();
    try {
      arpTable = await arp.readArpTable();
    } catch (_) {
      /* ignore */
    }

    let cursor = 0;
    const enrichOne = async () => {
      while (cursor < alive.length && !this.cancelled) {
        const host = alive[cursor++];
        const mac = arpTable.get(host.ip);
        if (mac) {
          host.mac = mac;
          host.vendor = oui.lookup(mac);
        }
        const tasks = [];
        if (opts.resolveNames) {
          tasks.push(
            resolve.resolveName(host.ip).then((name) => {
              if (name) host.name = name;
            }).catch(() => {}),
          );
        }
        if (opts.scanPorts) {
          tasks.push(
            ports.scanPorts(host.ip, opts.portList, { timeoutMs: 900 }).then((open) => {
              host.ports = open;
              const { shares, services } = ports.summarizeServices(open);
              host.shares = shares;
              host.services = services;
            }).catch(() => {}),
          );
        }
        // eslint-disable-next-line no-await-in-loop
        await Promise.all(tasks);
        host.lastSeen = Date.now();
        this.emit('host', host); // updated record
        this.emit('enrichProgress', { done: cursor, total: alive.length });
      }
    };

    const workers = [];
    const n = Math.min(opts.concurrency, alive.length);
    for (let i = 0; i < n; i += 1) workers.push(enrichOne());
    await Promise.all(workers);
  }

  /** Re-probe a single, already-known host and return the fresh record. */
  async rescanHost(ip, options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const res = await ping.isAlive(ip, { timeoutMs: opts.timeoutMs, tcpFallback: opts.tcpFallback });
    const record = this._hosts.get(ip) || {
      ip, status: 'dead', name: '', mac: '', vendor: '', ports: [], shares: [], services: [],
    };
    record.status = res.alive ? 'alive' : 'dead';
    record.responseMs = res.timeMs;
    if (res.alive) {
      const table = await arp.readArpTable().catch(() => new Map());
      const mac = table.get(ip);
      if (mac) {
        record.mac = mac;
        record.vendor = oui.lookup(mac);
      }
      if (opts.resolveNames) record.name = (await resolve.resolveName(ip)) || record.name;
      if (opts.scanPorts) {
        record.ports = await ports.scanPorts(ip, opts.portList, { timeoutMs: 900 }).catch(() => []);
        const s = ports.summarizeServices(record.ports);
        record.shares = s.shares;
        record.services = s.services;
      }
      record.lastSeen = Date.now();
      this._hosts.set(ip, record);
    }
    return record;
  }
}

module.exports = { Scanner, DEFAULT_OPTIONS };
