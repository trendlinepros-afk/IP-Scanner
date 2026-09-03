'use strict';

/**
 * Generate application icons with zero external dependencies.
 *
 * Produces:
 *   build/icon.png  (1024x1024, used by electron-builder for Linux/mac and as
 *                    the source it converts to platform formats)
 *   build/icon.ico  (256x256 PNG-compressed Windows icon)
 *   build/icon@256.png (handy standalone raster)
 *
 * The artwork is a simple radar sweep: concentric rings, a sweep wedge and a
 * few blips on a dark rounded-square background — drawn straight into an RGBA
 * buffer and encoded to PNG via Node's built-in zlib.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- Tiny PNG encoder ----------------------------------------------------
function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Add filter byte (0) at the start of every scanline.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- Drawing -------------------------------------------------------------
function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const R = size * 0.5;

  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const alpha = a / 255;
    const ia = 1 - alpha;
    buf[i] = Math.round(r * alpha + buf[i] * ia);
    buf[i + 1] = Math.round(g * alpha + buf[i + 1] * ia);
    buf[i + 2] = Math.round(b * alpha + buf[i + 2] * ia);
    buf[i + 3] = Math.min(255, buf[i + 3] + a);
  };

  const radius = size * 0.22; // rounded-rect corner radius
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Rounded square mask.
      const dx = Math.max(radius - x, x - (size - radius), 0);
      const dy = Math.max(radius - y, y - (size - radius), 0);
      const corner = Math.sqrt(dx * dx + dy * dy);
      let mask = 1;
      if (corner > radius) mask = Math.max(0, 1 - (corner - radius));
      if (mask <= 0) continue;
      // Vertical gradient background (deep blue -> indigo).
      const t = y / size;
      const r = Math.round(24 + t * 10);
      const g = Math.round(38 + t * 18);
      const b = Math.round(64 + t * 40);
      set(x, y, r, g, b, Math.round(255 * mask));
    }
  }

  // Radar rings.
  const rings = [0.20, 0.31, 0.42];
  for (const rr of rings) {
    const ringR = R * rr * 2;
    const thickness = size * 0.008;
    for (let a = 0; a < 360; a += 0.25) {
      const rad = (a * Math.PI) / 180;
      for (let o = -thickness; o <= thickness; o += 1) {
        const px = Math.round(cx + Math.cos(rad) * (ringR + o));
        const py = Math.round(cy + Math.sin(rad) * (ringR + o));
        set(px, py, 74, 148, 236, 120);
      }
    }
  }

  // Cross hairs.
  for (let d = -R * 0.86; d <= R * 0.86; d += 0.5) {
    set(Math.round(cx + d), Math.round(cy), 74, 148, 236, 70);
    set(Math.round(cx), Math.round(cy + d), 74, 148, 236, 70);
  }

  // Sweep wedge (a translucent fan) from -55deg to 0deg.
  const sweepStart = -0.9;
  const sweepEnd = 0.0;
  const maxR = R * 0.86;
  for (let rr = 0; rr < maxR; rr += 0.5) {
    for (let a = sweepStart; a <= sweepEnd; a += 0.004) {
      const px = Math.round(cx + Math.cos(a) * rr);
      const py = Math.round(cy + Math.sin(a) * rr);
      const fade = (a - sweepStart) / (sweepEnd - sweepStart);
      set(px, py, 96, 200, 255, Math.round(60 * fade * (1 - rr / maxR)));
    }
  }

  // Blips.
  const blips = [
    [0.30, -0.18, 1.0], [-0.22, 0.10, 0.8], [0.08, 0.32, 0.9], [-0.12, -0.30, 0.7],
  ];
  for (const [bx, by, br] of blips) {
    const px = cx + bx * R;
    const py = cy + by * R;
    const rad = size * 0.02 * (0.7 + br * 0.6);
    for (let y = -rad; y <= rad; y += 1) {
      for (let x = -rad; x <= rad; x += 1) {
        const dist = Math.sqrt(x * x + y * y);
        if (dist <= rad) {
          const a = Math.round(255 * (1 - dist / rad));
          set(Math.round(px + x), Math.round(py + y), 96, 230, 140, a);
        }
      }
    }
  }

  // Center dot.
  for (let y = -size * 0.02; y <= size * 0.02; y += 1) {
    for (let x = -size * 0.02; x <= size * 0.02; x += 1) {
      if (Math.sqrt(x * x + y * y) <= size * 0.02) {
        set(Math.round(cx + x), Math.round(cy + y), 220, 235, 255, 255);
      }
    }
  }

  return buf;
}

// ---- ICO container (single PNG-compressed 256px entry) -------------------
function buildIco(pngBuffer, dim) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count
  const entry = Buffer.alloc(16);
  entry[0] = dim >= 256 ? 0 : dim; // width (0 => 256)
  entry[1] = dim >= 256 ? 0 : dim; // height
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8); // size
  entry.writeUInt32LE(6 + 16, 12); // offset
  return Buffer.concat([header, entry, pngBuffer]);
}

// ---- Main ----------------------------------------------------------------
function main() {
  const outDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(outDir, { recursive: true });

  const big = 1024;
  const bigBuf = draw(big);
  const bigPng = encodePng(big, big, bigBuf);
  fs.writeFileSync(path.join(outDir, 'icon.png'), bigPng);

  const mid = 256;
  const midBuf = draw(mid);
  const midPng = encodePng(mid, mid, midBuf);
  fs.writeFileSync(path.join(outDir, 'icon@256.png'), midPng);
  fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(midPng, 256));

  // eslint-disable-next-line no-console
  console.log('Generated build/icon.png (1024), build/icon@256.png, build/icon.ico');
}

main();
