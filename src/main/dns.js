'use strict';

/**
 * DNS resolver benchmark (namebench / DNS Benchmark style). Measures how fast a
 * set of public resolvers — and your system resolver — answer A-record queries
 * for a spread of popular domains, reporting min/avg/max and reliability.
 *
 * Emits: 'resolverDone' <perResolverResult>, 'result' [<all>], 'error'.
 */

const dns = require('dns');
const { EventEmitter } = require('events');

const PUBLIC_RESOLVERS = [
  { name: 'Cloudflare', ip: '1.1.1.1' },
  { name: 'Google', ip: '8.8.8.8' },
  { name: 'Quad9', ip: '9.9.9.9' },
  { name: 'OpenDNS', ip: '208.67.222.222' },
  { name: 'AdGuard', ip: '94.140.14.14' },
  { name: 'Level3', ip: '4.2.2.2' },
];

const DOMAINS = [
  'google.com', 'github.com', 'wikipedia.org', 'cloudflare.com',
  'amazon.com', 'youtube.com', 'reddit.com', 'microsoft.com',
];

function measureOne(serverIp, domain, timeoutMs) {
  return new Promise((resolve) => {
    const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
    try {
      resolver.setServers([serverIp]);
    } catch (_) {
      return resolve(null);
    }
    const start = process.hrtime.bigint();
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { resolver.cancel(); } catch (_) { /* */ }
      resolve(val);
    };
    const timer = setTimeout(() => done(null), timeoutMs + 200);
    resolver.resolve4(domain, (err) => {
      if (err) return done(null);
      done(Number(process.hrtime.bigint() - start) / 1e6);
    });
  });
}

class DnsBenchmark extends EventEmitter {
  constructor() {
    super();
    this.cancelled = false;
  }

  cancel() { this.cancelled = true; }

  async run(options = {}) {
    this.cancelled = false;
    const timeoutMs = options.timeoutMs || 2000;
    const rounds = options.rounds || 1;
    const domains = options.domains || DOMAINS;

    const resolvers = [...PUBLIC_RESOLVERS];
    try {
      const sys = dns.getServers().filter((s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s));
      if (sys[0]) resolvers.unshift({ name: 'System', ip: sys[0], system: true });
    } catch (_) { /* ignore */ }

    const results = [];
    for (const r of resolvers) {
      if (this.cancelled) break;
      const times = [];
      let fails = 0;
      for (let round = 0; round < rounds; round += 1) {
        for (const domain of domains) {
          if (this.cancelled) break;
          // eslint-disable-next-line no-await-in-loop
          const t = await measureOne(r.ip, domain, timeoutMs);
          if (t == null) fails += 1;
          else times.push(t);
        }
      }
      const total = rounds * domains.length;
      const round2 = (n) => Math.round(n * 100) / 100;
      const summary = {
        name: r.name,
        ip: r.ip,
        system: !!r.system,
        queries: total,
        answered: times.length,
        lossPct: total ? Math.round((fails / total) * 100) : 0,
        min: times.length ? round2(Math.min(...times)) : null,
        max: times.length ? round2(Math.max(...times)) : null,
        avg: times.length ? round2(times.reduce((a, b) => a + b, 0) / times.length) : null,
      };
      results.push(summary);
      this.emit('resolverDone', summary);
    }

    // Rank by average (nulls last).
    results.sort((a, b) => {
      if (a.avg == null) return 1;
      if (b.avg == null) return -1;
      return a.avg - b.avg;
    });
    results.forEach((r, i) => { r.rank = i + 1; });
    this.emit('result', results);
    return results;
  }
}

module.exports = { DnsBenchmark, PUBLIC_RESOLVERS, DOMAINS };
