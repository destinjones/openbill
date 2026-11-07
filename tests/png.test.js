// tools/png.mjs, the palette PNG encoder behind the preview cards (decision 53), checked against an
// independent reading of the format written here, not against the encoder's own helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { encodeIndexedPng, quantizePng } from '../tools/png.mjs';
import { buildPalette } from '../tools/gif.mjs';

/** The CRC-32 the PNG specification gives in its sample code, bit by bit. */
function crc(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Read a palette PNG: every chunk and its CRC, the palette, and each pixel's colour. */
function readPalettePng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'the signature');
  let pos = 8;
  const types = [];
  const data = {};
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    assert.equal(buf.readUInt32BE(pos + 8 + len), crc(buf.subarray(pos + 4, pos + 8 + len)), `the CRC of ${type}`);
    types.push(type);
    data[type] = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
  }
  assert.deepEqual(types, ['IHDR', 'PLTE', 'IDAT', 'IEND']);
  const width = data.IHDR.readUInt32BE(0);
  const height = data.IHDR.readUInt32BE(4);
  assert.deepEqual([...data.IHDR.subarray(8)], [8, 3, 0, 0, 0], '8 bits, palette, not interlaced');
  assert.equal(data.PLTE.length % 3, 0);
  const colors = data.PLTE.length / 3;
  assert.ok(colors >= 1 && colors <= 256, `${colors} palette entries`);
  const raw = zlib.inflateSync(data.IDAT);
  assert.equal(raw.length, (width + 1) * height);
  const pixels = [];
  for (let y = 0; y < height; y++) {
    const start = y * (width + 1);
    assert.equal(raw[start], 0, `row ${y} is filter 0`);
    for (let x = 0; x < width; x++) {
      const i = raw[start + 1 + x];
      assert.ok(i < colors, 'the index is in the palette');
      pixels.push([data.PLTE[i * 3], data.PLTE[i * 3 + 1], data.PLTE[i * 3 + 2]]);
    }
  }
  return { width, height, colors, pixels };
}

/** A truecolour PNG (filter 0), as a screenshot would be, from its pixels. */
function truecolorPng(width, height, pixelAt) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelAt(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
    }
  }
  const chunk = (type, body) => {
    const named = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(named));
    return Buffer.concat([len, named, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('encodeIndexedPng writes a palette PNG an independent reader agrees with', () => {
  const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [1, 2, 3]];
  const indices = Uint8Array.from([0, 1, 2, 3, 3, 2]);
  const r = readPalettePng(encodeIndexedPng(3, 2, palette, indices));
  assert.deepEqual([r.width, r.height, r.colors], [3, 2, 4]);
  assert.deepEqual(r.pixels, [...indices].map((i) => palette[i]));
  assert.throws(() => encodeIndexedPng(3, 2, [], indices), /palette entries/);
  assert.throws(() => encodeIndexedPng(3, 2, Array.from({ length: 257 }, () => [0, 0, 0]), indices), /palette entries/);
  assert.throws(() => encodeIndexedPng(4, 2, palette, indices), /indices/);
});

test('quantizePng keeps an image of few colours exactly, in up to 256 entries', () => {
  const colors = [[255, 255, 255], [20, 33, 61], [212, 76, 45], [240, 240, 235]];
  const at = (x, y) => colors[(x + 3 * y) % colors.length];
  const r = readPalettePng(quantizePng(truecolorPng(40, 20, at)));
  assert.equal(r.colors, 4);
  r.pixels.forEach((p, i) => assert.deepEqual(p, at(i % 40, Math.floor(i / 40))));
});

test('quantizePng on thousands of colours stays close, is deterministic, and is smaller than the input', () => {
  // Flat ground and antialiased "text": thousands of colours, the way a preview card has them.
  const width = 240;
  const height = 120;
  const at = (x, y) => {
    if (y % 12 < 6 && x % 5 < 3) {
      const t = (x * 7 + y * 13) % 256;
      return [t, (t * 3) % 64, 255 - t];
    }
    return [250, 248, 244];
  };
  const png = truecolorPng(width, height, at);
  const out = quantizePng(png);
  const r = readPalettePng(out);
  assert.ok(r.colors <= 256);
  let worst = 0;
  let total = 0;
  r.pixels.forEach((p, i) => {
    const [a, b, c] = at(i % width, Math.floor(i / width));
    const d = [p[0] - a, p[1] - b, p[2] - c];
    total += d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
    worst = Math.max(worst, ...d.map(Math.abs));
  });
  const psnr = 10 * Math.log10((255 ** 2 * 3 * r.pixels.length) / Math.max(total, 1));
  assert.ok(psnr > 35, `PSNR ${psnr.toFixed(1)} dB`);
  assert.ok(worst < 64, `worst channel off by ${worst}`);
  assert.ok(out.length < png.length, `${out.length} bytes from ${png.length}`);
  assert.ok(out.equals(quantizePng(png)), 'the same screenshot gives the same bytes');
  assert.ok(buildPalette([Buffer.from([1, 2, 3])]).length === 1);
});
