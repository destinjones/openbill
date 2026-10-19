// tools/gif.mjs, the GIF encoder behind the reveal clip (decision 51): its frames, decoded by an
// independent reader (tests/gifdecode.js), are the frames it was given; its PNG reader undoes every
// PNG row filter; and the same frames always give the same bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { decodePng, encodeGif, buildPalette, lzw, TRANSPARENT } from '../tools/gif.mjs';
import { decodeGif } from './gifdecode.js';

/** A PNG writer for the test, using each of the five row filters in turn. */
function encodePng(width, height, rgba, channels) {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = y % 5;
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const v = rgba[y * stride + x];
      const a = x >= channels ? rgba[y * stride + x - channels] : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? rgba[(y - 1) * stride + x - channels] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[y * (stride + 1) + 1 + x] = (v - pred) & 255;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A deterministic pseudo-random sequence. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24;
  };
}

function frameOf(width, height, fill) {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgb.set(fill(x, y), (y * width + x) * 3);
  return rgb;
}

test('decodePng reads RGB and RGBA through all five row filters', () => {
  const r = rng(7);
  for (const channels of [3, 4]) {
    const width = 13;
    const height = 11;
    const px = new Uint8Array(width * height * channels).map(() => r());
    const img = decodePng(encodePng(width, height, px, channels));
    assert.equal(img.width, width);
    assert.equal(img.height, height);
    for (let i = 0; i < width * height; i++) {
      assert.deepEqual([...img.rgb.subarray(i * 3, i * 3 + 3)], [...px.subarray(i * channels, i * channels + 3)], `pixel ${i}, ${channels} channels`);
    }
  }
  assert.throws(() => decodePng(Buffer.from('not a png')), /not a PNG/);
});

test('a few colours: every frame decodes to exactly the pixels given; identical frames merge; later frames store only what changed', () => {
  const width = 64;
  const height = 40;
  const colors = [
    [251, 250, 246],
    [27, 27, 25],
    [179, 38, 30],
    [205, 200, 189],
  ];
  const base = (x, y) => colors[(x >> 3) % 2 === (y >> 3) % 2 ? 0 : 3];
  const f0 = frameOf(width, height, base);
  const f1 = frameOf(width, height, (x, y) => (x >= 10 && x < 20 && y >= 5 && y < 9 ? colors[2] : base(x, y)));
  const f2 = frameOf(width, height, (x, y) => (x >= 10 && x < 20 && y >= 5 && y < 9 ? colors[2] : x === 50 && y === 30 ? colors[1] : base(x, y)));
  const frames = [
    { rgb: f0, delay: 8 },
    { rgb: f0, delay: 8 },
    { rgb: f1, delay: 8 },
    { rgb: f2, delay: 200 },
  ];
  const { gif, stored } = encodeGif(frames, { width, height, comment: 'OpenBill test' });
  assert.equal(stored, 3, 'the repeated first frame is merged into it');
  const g = decodeGif(gif);
  assert.equal(g.width, width);
  assert.equal(g.height, height);
  assert.equal(g.loop, 0, 'loops forever');
  assert.deepEqual(g.comments, ['OpenBill test']);
  assert.deepEqual(
    g.frames.map((f) => f.delay),
    [16, 8, 200],
  );
  assert.deepEqual(g.frames[1].rect, [10, 5, 10, 4], 'the second stored frame is the changed rectangle');
  assert.deepEqual(g.frames[2].rect, [50, 30, 1, 1]);
  for (const f of g.frames.slice(1)) {
    assert.equal(f.disposal, 1, 'left in place');
    assert.equal(f.transparent, TRANSPARENT);
  }
  assert.deepEqual([...g.frames[0].rgb], [...f0]);
  assert.deepEqual([...g.frames[1].rgb], [...f1]);
  assert.deepEqual([...g.frames[2].rgb], [...f2]);
  assert.deepEqual(encodeGif(frames, { width, height, comment: 'OpenBill test' }).gif, gif, 'the same frames give the same bytes');
});

test('many colours: at most 255 in the palette, the dominant colours kept exactly, the rest close', () => {
  const width = 120;
  const height = 90;
  const paper = [251, 250, 246];
  const ink = [27, 27, 25];
  // Mostly paper and ink, with a smooth ramp of 10,800 shades (like antialiased text) in a band.
  const rgb = frameOf(width, height, (x, y) => (y < 30 ? paper : y < 60 ? [x * 2, (y - 30) * 8, 255 - x * 2] : ink));
  const palette = buildPalette([rgb]);
  assert.ok(palette.length <= 255, `${palette.length} colours`);
  assert.ok(palette.some((c) => c.join() === paper.join()), 'the paper colour is exact');
  assert.ok(palette.some((c) => c.join() === ink.join()), 'the ink colour is exact');
  const g = decodeGif(encodeGif([{ rgb, delay: 10 }], { width, height }).gif);
  let worst = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    const d = Math.hypot(rgb[i] - g.frames[0].rgb[i], rgb[i + 1] - g.frames[0].rgb[i + 1], rgb[i + 2] - g.frames[0].rgb[i + 2]);
    if (d > worst) worst = d;
  }
  assert.ok(worst < 40, `every pixel within 40 of its colour (worst ${worst.toFixed(1)})`);
  for (let i = 0; i < width * 30 * 3; i += 3) assert.deepEqual([...g.frames[0].rgb.subarray(i, i + 3)], paper);
});

test('LZW: long, varied input clears the code table and still decodes exactly', () => {
  const r = rng(42);
  const width = 300;
  const height = 200;
  const colors = Array.from({ length: 200 }, (_, i) => [i, (i * 7) & 255, (i * 13) & 255]);
  const rgb = frameOf(width, height, () => colors[r() % colors.length]);
  const g = decodeGif(encodeGif([{ rgb, delay: 10 }], { width, height }).gif);
  assert.deepEqual([...g.frames[0].rgb], [...rgb]);
  assert.ok(lzw(new Uint8Array(70000).map(() => r())).length > 0);
});

test('encodeGif refuses frames of the wrong size and delays a browser would not honour', () => {
  const rgb = new Uint8Array(4 * 4 * 3);
  assert.throws(() => encodeGif([{ rgb, delay: 10 }], { width: 5, height: 4 }), /width × height/);
  assert.throws(() => encodeGif([{ rgb, delay: 1 }], { width: 4, height: 4 }), /delay/);
  assert.throws(() => encodeGif([], { width: 4, height: 4 }), /no frames/);
});
