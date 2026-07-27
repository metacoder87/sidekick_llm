// Generates build/icon.png (512x512) — the source image electron-builder converts
// into platform icons. Kept in the repo so the icon is reproducible rather than a
// mystery binary: run `node build/make-icon.cjs` to regenerate it.
//
// Design: the app's dark panel colour with the accent-cyan bolt used throughout the
// UI for Experts (⚡), so the installer, taskbar and title bar match the product.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 512;
const BG = [16, 13, 12, 255]; // #100d0c — app background
const PANEL = [24, 32, 36, 255]; // subtle rounded panel
const ACCENT = [0, 243, 255, 255]; // #00f3ff — app accent

// Lightning bolt as a polygon in a 0..1 coordinate space.
const BOLT = [
  [0.56, 0.08],
  [0.28, 0.54],
  [0.46, 0.54],
  [0.40, 0.92],
  [0.72, 0.44],
  [0.53, 0.44],
];

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// Signed distance to a rounded rectangle, used for the panel and its antialiasing.
function roundedRectDistance(x, y, half, radius) {
  const dx = Math.abs(x) - (half - radius);
  const dy = Math.abs(y) - (half - radius);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - radius;
}

function blend(dst, src, alpha) {
  return [
    Math.round(dst[0] * (1 - alpha) + src[0] * alpha),
    Math.round(dst[1] * (1 - alpha) + src[1] * alpha),
    Math.round(dst[2] * (1 - alpha) + src[2] * alpha),
    255,
  ];
}

function renderPixels() {
  const rows = [];
  const half = SIZE / 2;
  // Supersample so edges are smooth without needing an image library.
  const SS = 3;

  for (let y = 0; y < SIZE; y++) {
    const row = Buffer.alloc(SIZE * 4 + 1);
    row[0] = 0; // PNG filter type: none
    for (let x = 0; x < SIZE; x++) {
      let acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;

          let colour = BG;
          // Rounded panel inset from the edges.
          if (roundedRectDistance(px - half, py - half, half - 26, 96) < 0) {
            colour = PANEL;
          }
          if (pointInPolygon(px / SIZE, py / SIZE, BOLT)) {
            colour = ACCENT;
          }
          acc[0] += colour[0];
          acc[1] += colour[1];
          acc[2] += colour[2];
        }
      }
      const n = SS * SS;
      const offset = 1 + x * 4;
      row[offset] = Math.round(acc[0] / n);
      row[offset + 1] = Math.round(acc[1] / n);
      row[offset + 2] = Math.round(acc[2] / n);
      row[offset + 3] = 255;
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

// --- Minimal PNG encoder -----------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const target = path.join(__dirname, 'icon.png');
fs.writeFileSync(target, encodePng(renderPixels()));
console.log(`wrote ${target} (${SIZE}x${SIZE}, ${(fs.statSync(target).size / 1024).toFixed(1)} KB)`);
