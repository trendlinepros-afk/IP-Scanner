'use strict';

/**
 * Wake-on-LAN — send a "magic packet" to wake a sleeping host by MAC address.
 * The packet is 6 x 0xFF followed by the target MAC repeated 16 times, sent as
 * a UDP broadcast (default port 9).
 */

const dgram = require('dgram');

function macToBytes(mac) {
  const hex = String(mac).replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) throw new Error(`Invalid MAC address: ${mac}`);
  const bytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i += 1) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function buildMagicPacket(mac) {
  const macBytes = macToBytes(mac);
  const packet = Buffer.alloc(6 + 16 * 6, 0xff); // first 6 bytes already 0xFF
  for (let i = 0; i < 16; i += 1) macBytes.copy(packet, 6 + i * 6);
  return packet;
}

/**
 * Send a Wake-on-LAN magic packet.
 * @param {string} mac target MAC
 * @param {object} opts { address, port, count }
 */
function wake(mac, opts = {}) {
  const address = opts.address || '255.255.255.255';
  const port = opts.port || 9;
  const count = opts.count || 3;
  const packet = buildMagicPacket(mac);

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      let sent = 0;
      const sendOne = () => {
        socket.send(packet, 0, packet.length, port, address, (err) => {
          sent += 1;
          if (err) {
            socket.close();
            return reject(err);
          }
          if (sent >= count) {
            socket.close();
            return resolve({ ok: true, mac, address, port, count });
          }
          setTimeout(sendOne, 120);
        });
      };
      sendOne();
    });
  });
}

module.exports = { wake, buildMagicPacket };
