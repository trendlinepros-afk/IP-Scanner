'use strict';

/**
 * Network interface discovery and IPv4 subnet math.
 * Pure Node — no native dependencies.
 */

const os = require('os');

/** Convert a dotted-quad IPv4 string to a 32-bit unsigned integer. */
function ipToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** Convert a 32-bit unsigned integer back to a dotted-quad string. */
function intToIp(int) {
  return [
    (int >>> 24) & 0xff,
    (int >>> 16) & 0xff,
    (int >>> 8) & 0xff,
    int & 0xff,
  ].join('.');
}

/** Turn a CIDR prefix length (0-32) into a 32-bit netmask integer. */
function prefixToMaskInt(prefix) {
  if (prefix < 0 || prefix > 32) throw new Error(`Invalid prefix: ${prefix}`);
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/** Count the leading 1-bits of a dotted-quad netmask string. */
function maskToPrefix(mask) {
  const int = ipToInt(mask);
  let count = 0;
  let bit = 0x80000000;
  while (bit && int & bit) {
    count += 1;
    bit >>>= 1;
  }
  return count;
}

/**
 * Expand a range description into a concrete list of host IP strings.
 * Accepts:
 *   - CIDR                "192.168.1.0/24"
 *   - dashed last octet   "192.168.1.1-254"
 *   - full dashed range   "192.168.1.1-192.168.1.254"
 *   - single address      "192.168.1.10"
 *   - comma separated combination of any of the above
 */
function expandRange(input) {
  const result = [];
  const seen = new Set();

  const push = (ip) => {
    if (!seen.has(ip)) {
      seen.add(ip);
      result.push(ip);
    }
  };

  const segments = String(input)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const seg of segments) {
    if (seg.includes('/')) {
      // CIDR
      const [base, prefixStr] = seg.split('/');
      const prefix = Number(prefixStr);
      const baseInt = ipToInt(base);
      const mask = prefixToMaskInt(prefix);
      const network = (baseInt & mask) >>> 0;
      const broadcast = (network | (~mask >>> 0)) >>> 0;
      // For /31 and /32 include every address, otherwise skip net/broadcast.
      const start = prefix >= 31 ? network : network + 1;
      const end = prefix >= 31 ? broadcast : broadcast - 1;
      for (let i = start; i <= end; i += 1) push(intToIp(i >>> 0));
    } else if (seg.includes('-')) {
      const [startPart, endPart] = seg.split('-').map((s) => s.trim());
      const startInt = ipToInt(startPart);
      let endInt;
      if (endPart.includes('.')) {
        endInt = ipToInt(endPart);
      } else {
        // Shorthand: replace the final octet only.
        const prefixOctets = startPart.split('.').slice(0, 3).join('.');
        endInt = ipToInt(`${prefixOctets}.${endPart}`);
      }
      if (endInt < startInt) throw new Error(`Range end before start: ${seg}`);
      for (let i = startInt; i <= endInt; i += 1) push(intToIp(i >>> 0));
    } else {
      push(intToIp(ipToInt(seg)));
    }
  }
  return result;
}

/**
 * Return the usable IPv4 interfaces on this machine together with a
 * suggested scan range (the local /24 — or the true subnet when smaller).
 */
function listInterfaces() {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const prefix = addr.cidr ? Number(addr.cidr.split('/')[1]) : maskToPrefix(addr.netmask);
      const ipInt = ipToInt(addr.address);
      const maskInt = prefixToMaskInt(prefix);
      const network = (ipInt & maskInt) >>> 0;
      const broadcast = (network | (~maskInt >>> 0)) >>> 0;
      // Cap the auto-suggested range at a /24 so huge subnets don't lock the UI.
      const effectivePrefix = Math.max(prefix, 24);
      const effMask = prefixToMaskInt(effectivePrefix);
      const effNet = (ipInt & effMask) >>> 0;
      const effBroadcast = (effNet | (~effMask >>> 0)) >>> 0;
      out.push({
        name,
        address: addr.address,
        mac: addr.mac,
        netmask: addr.netmask,
        prefix,
        cidr: `${intToIp(network)}/${prefix}`,
        suggestedRange: `${intToIp((effNet + 1) >>> 0)}-${intToIp((effBroadcast - 1) >>> 0)}`,
        hostCount: Math.max(0, broadcast - network - 1),
      });
    }
  }
  return out;
}

/** Best-effort "primary" interface: the first non-internal IPv4. */
function primaryInterface() {
  const list = listInterfaces();
  // Prefer common private ranges / lower metric names.
  const preferredOrder = ['eth', 'en', 'wl', 'Ethernet', 'Wi-Fi'];
  list.sort((a, b) => {
    const rank = (n) => {
      const idx = preferredOrder.findIndex((p) => n.toLowerCase().startsWith(p.toLowerCase()));
      return idx === -1 ? 99 : idx;
    };
    return rank(a.name) - rank(b.name);
  });
  return list[0] || null;
}

module.exports = {
  ipToInt,
  intToIp,
  prefixToMaskInt,
  maskToPrefix,
  expandRange,
  listInterfaces,
  primaryInterface,
};
