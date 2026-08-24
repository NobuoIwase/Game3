// PWA アイコン生成スクリプト（依存ライブラリなし・Node標準のみ）
// 実行: node tools/gen_icons.mjs
// icons/icon-180.png (apple-touch-icon), icon-192.png, icon-512.png を生成する。

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- 最小限の PNG エンコーダ（RGBA, 8bit, フィルタなし） ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // フィルタ 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 描画: 紺地にオレンジの結晶（フラグメント）----

function drawIcon(size) {
  const img = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b) => {
    const i = (y * size + x) * 4;
    img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255;
  };
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 背景: 上下グラデーションの紺
      const t = y / size;
      let r = Math.round(0x23 - 8 * t), g = Math.round(0x25 - 8 * t), b = Math.round(0x3c - 12 * t);
      const u = (x - c) / (size * 0.36);
      const v = (y - c) / (size * 0.44);
      const d = Math.abs(u) + Math.abs(v); // ひし形（結晶）
      if (d <= 1) {
        const shade = 1 - 0.35 * (v + 1) / 2; // 上が明るい
        if (Math.abs(u) + Math.abs(v + 0.18) <= 0.45) {
          // 内側のハイライト
          r = Math.round(0xff * shade); g = Math.round(0xd9 * shade); b = Math.round(0x8a * shade);
        } else {
          r = Math.round(0xff * shade); g = Math.round(0xb5 * shade); b = Math.round(0x45 * shade);
        }
        // 中央の縦の稜線
        if (Math.abs(u) < 0.02) { r = Math.min(255, r + 40); g = Math.min(255, g + 30); b = Math.min(255, b + 20); }
      } else if (d <= 1.08) {
        // 縁取り（シアン）
        r = 0x5f; g = 0xd0; b = 0xe0;
      }
      set(x, y, r, g, b);
    }
  }
  return encodePNG(size, size, img);
}

mkdirSync(join(ROOT, 'icons'), { recursive: true });
for (const size of [180, 192, 512]) {
  const png = drawIcon(size);
  writeFileSync(join(ROOT, 'icons', `icon-${size}.png`), png);
  console.log(`icons/icon-${size}.png (${png.length} bytes)`);
}
