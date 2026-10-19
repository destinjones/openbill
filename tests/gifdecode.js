// A GIF decoder for the tests (tests/gif.test.js, tests/browser/press.spec.js), written apart from
// tools/gif.mjs so the encoder is checked against an independent reading of the format. It returns
// every frame composited onto the canvas, as a browser shows it, plus the loop count, the delays
// and the comments. Not a helper for the site: nothing outside the tests imports it.

/**
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, loop: number|null, comments: string[], palette: number[][], frames: { rect: number[], delay: number, disposal: number, transparent: number, rgb: Uint8Array }[] }}
 */
export function decodeGif(buf) {
  let p = 0;
  const u8 = () => {
    if (p >= buf.length) throw new Error('decodeGif: the file ends early');
    return buf[p++];
  };
  const u16 = () => u8() | (u8() << 8);
  const subBlocks = () => {
    const out = [];
    for (;;) {
      const n = u8();
      if (!n) break;
      out.push(buf.subarray(p, p + n));
      p += n;
    }
    return Buffer.concat(out);
  };
  if (buf.toString('latin1', 0, 6) !== 'GIF89a') throw new Error('decodeGif: not a GIF89a file');
  p = 6;
  const width = u16();
  const height = u16();
  const packed = u8();
  u8();
  u8();
  let palette = null;
  if (packed & 0x80) {
    palette = [];
    for (let i = 0, n = 2 << (packed & 7); i < n; i++) palette.push([u8(), u8(), u8()]);
  }
  const canvas = new Uint8Array(width * height * 3);
  const frames = [];
  const comments = [];
  let loop = null;
  let gce = null;
  for (;;) {
    const b = u8();
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = u8();
      if (label === 0xf9) {
        u8();
        const pk = u8();
        const delay = u16();
        const ti = u8();
        u8();
        gce = { disposal: (pk >> 2) & 7, transparent: pk & 1 ? ti : -1, delay };
      } else if (label === 0xff) {
        const app = subBlocks();
        if (app.toString('latin1', 0, 11) === 'NETSCAPE2.0') loop = app[12] | (app[13] << 8);
      } else if (label === 0xfe) comments.push(subBlocks().toString('latin1'));
      else subBlocks();
      continue;
    }
    if (b !== 0x2c) throw new Error(`decodeGif: unexpected block 0x${b.toString(16)} at byte ${p - 1}`);
    const x = u16();
    const y = u16();
    const w = u16();
    const h = u16();
    const ipk = u8();
    if (ipk & 0x80) throw new Error('decodeGif: a local colour table was not expected');
    if (x + w > width || y + h > height) throw new Error('decodeGif: a frame lies outside the canvas');
    const min = u8();
    const idx = lzwDecode(subBlocks(), min, w * h);
    const t = gce ? gce.transparent : -1;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const v = idx[j * w + i];
        if (v === t) continue;
        const c = palette[v];
        const o = ((y + j) * width + x + i) * 3;
        canvas[o] = c[0];
        canvas[o + 1] = c[1];
        canvas[o + 2] = c[2];
      }
    }
    frames.push({ rect: [x, y, w, h], delay: gce ? gce.delay : 0, disposal: gce ? gce.disposal : 0, transparent: t, rgb: Uint8Array.from(canvas) });
    gce = null;
  }
  return { width, height, loop, comments, palette, frames };
}

function lzwDecode(data, min, count) {
  const clear = 1 << min;
  const eoi = clear + 1;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const len = new Int32Array(4096);
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    first[i] = i;
    len[i] = 1;
  }
  const out = new Uint8Array(count);
  let o = 0;
  let size = min + 1;
  let next = eoi + 1;
  let bits = 0;
  let nbits = 0;
  let bp = 0;
  let prev = -1;
  let ended = false;
  const write = (code) => {
    let k = code;
    for (let i = len[code] - 1; i >= 0; i--) {
      if (o + i < count) out[o + i] = suffix[k];
      k = prefix[k];
    }
    o += len[code];
  };
  while (!ended) {
    while (nbits < size) {
      if (bp >= data.length) throw new Error('decodeGif: the image data ends without an end code');
      bits |= data[bp++] << nbits;
      nbits += 8;
    }
    const code = bits & ((1 << size) - 1);
    bits >>>= size;
    nbits -= size;
    if (code === clear) {
      size = min + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) {
      ended = true;
      continue;
    }
    if (prev === -1) {
      if (code >= clear) throw new Error(`decodeGif: code ${code} right after a clear`);
      write(code);
      prev = code;
      continue;
    }
    if (code > next || next > 4096) throw new Error(`decodeGif: code ${code} is not in the table (next ${next})`);
    const f = code < next ? first[code] : first[prev];
    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = f;
      first[next] = first[prev];
      len[next] = len[prev] + 1;
      next += 1;
    }
    write(code);
    if (next === 1 << size && size < 12) size += 1;
    prev = code;
  }
  if (o !== count) throw new Error(`decodeGif: ${o} pixels decoded, ${count} expected`);
  return out;
}
