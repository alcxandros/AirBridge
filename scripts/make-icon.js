// Generates the app icon (build/icon.png, src/renderer/icon.png) with no
// dependencies: a rounded blue tile with a white screen and a down arrow.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256;
const px = Buffer.alloc(S * S * 4);

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// Signed test for a triangle (arrow head).
function inTri(x, y, a, b, c) {
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = s([x, y], a, b), d2 = s([x, y], b, c), d3 = s([x, y], c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// 4x supersampling for smooth edges.
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const X = x + (sx + 0.5) / 4, Y = y + (sy + 0.5) / 4;
      if (!inRoundRect(X, Y, 8, 8, 248, 248, 56)) continue;
      const t = (X + Y) / (2 * S);
      let c = [47 + t * 30, 111 - t * 40, 236 - t * 30]; // blue gradient
      const screenOuter = inRoundRect(X, Y, 52, 62, 204, 170, 14);
      const screenInner = inRoundRect(X, Y, 64, 74, 192, 158, 6);
      const stand = inRoundRect(X, Y, 100, 182, 156, 194, 6);
      const shaft = X >= 116 && X <= 140 && Y >= 86 && Y <= 122;
      const head = inTri(X, Y, [96, 118], [160, 118], [128, 148]);
      if ((screenOuter && !screenInner) || stand || shaft || head) c = [255, 255, 255];
      r += c[0]; g += c[1]; b += c[2]; a += 255;
    }
    const i = (y * S + x) * 4, n = a / 255 || 1;
    px[i] = r / n; px[i + 1] = g / n; px[i + 2] = b / n; px[i + 3] = a / 16;
  }
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);

const root = path.join(__dirname, '..');
for (const out of ['build/icon.png', 'src/renderer/icon.png']) fs.writeFileSync(path.join(root, out), png);
console.log('icon written');
