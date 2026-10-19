// A small animated-GIF encoder for tools/record.mjs, with no dependency beyond Node itself.
//
// decodePng() reads the PNG screenshots Playwright takes (8-bit RGB or RGBA, not interlaced).
// encodeGif() turns a list of same-sized RGB frames into a looping GIF89a:
//   - one 256-entry global palette for every frame: median cut over the colours of all frames,
//     where a box's colour is its most common exact colour when that colour is most of the box
//     (so the paper, the ink and the red of the spread stay exact) and its weighted mean
//     otherwise; index 255 is kept for transparency;
//   - each frame after the first stores only the rectangle that changed, with unchanged pixels
//     transparent (disposal "leave in place"), and a frame identical to the one before adds its
//     delay to that one instead of being stored;
//   - LZW as the GIF89a specification gives it (the code-size timing follows omggif's encoder).
// The output depends only on the input pixels, so the same frames give the same bytes.

import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Decode a PNG into RGB pixels (alpha is dropped: the frames are opaque screenshots).
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, rgb: Uint8Array }}
 */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('decodePng: not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`decodePng: only 8-bit RGB or RGBA, not interlaced (bit depth ${depth}, colour type ${colorType}, interlace ${interlace})`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) throw new Error('decodePng: image data is short');
  const rgb = new Uint8Array(width * height * 3);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const filter = raw[at];
    for (let x = 0; x < stride; x++) {
      const v = raw[at + 1 + x];
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let out;
      if (filter === 0) out = v;
      else if (filter === 1) out = v + a;
      else if (filter === 2) out = v + b;
      else if (filter === 3) out = v + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`decodePng: unknown filter ${filter} on row ${y}`);
      cur[x] = out & 255;
    }
    for (let x = 0, o = y * width * 3; x < width; x++, o += 3) {
      rgb[o] = cur[x * bpp];
      rgb[o + 1] = cur[x * bpp + 1];
      rgb[o + 2] = cur[x * bpp + 2];
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, rgb };
}

// ---------------------------------------------------------------- palette

/** Index 255 is transparency; the palette has at most 255 colours. */
export const TRANSPARENT = 255;
const MAX_COLORS = 255;

/**
 * One palette for all frames: [[r, g, b], …], at most 255 colours.
 * @param {Uint8Array[]} frames RGB pixel arrays
 * @returns {number[][]}
 */
export function buildPalette(frames) {
  const counts = new Uint32Array(1 << 24);
  for (const rgb of frames) {
    for (let i = 0; i < rgb.length; i += 3) counts[(rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2]] += 1;
  }
  const colors = [];
  for (let k = 0; k < counts.length; k++) if (counts[k]) colors.push({ k, r: k >> 16, g: (k >> 8) & 255, b: k & 255, n: counts[k] });
  if (colors.length <= MAX_COLORS) return colors.sort((x, y) => y.n - x.n || x.k - y.k).map((c) => [c.r, c.g, c.b]);

  const boxOf = (list) => {
    let n = 0;
    const lo = [255, 255, 255];
    const hi = [0, 0, 0];
    for (const c of list) {
      n += c.n;
      const v = [c.r, c.g, c.b];
      for (let j = 0; j < 3; j++) {
        if (v[j] < lo[j]) lo[j] = v[j];
        if (v[j] > hi[j]) hi[j] = v[j];
      }
    }
    const span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const axis = span[0] >= span[1] && span[0] >= span[2] ? 0 : span[1] >= span[2] ? 1 : 2;
    return { list, n, axis, span: span[axis] };
  };
  const boxes = [boxOf(colors)];
  while (boxes.length < MAX_COLORS) {
    let best = -1;
    let score = 0;
    for (let i = 0; i < boxes.length; i++) {
      const s = boxes[i].list.length > 1 ? boxes[i].n * boxes[i].span : 0;
      if (s > score) {
        score = s;
        best = i;
      }
    }
    if (best < 0) break;
    const box = boxes[best];
    const key = ['r', 'g', 'b'][box.axis];
    box.list.sort((x, y) => x[key] - y[key] || x.k - y.k);
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.list.length - 1; i++) {
      acc += box.list[i].n;
      cut = i + 1;
      if (acc * 2 >= box.n) break;
    }
    boxes.splice(best, 1, boxOf(box.list.slice(0, cut)), boxOf(box.list.slice(cut)));
  }
  return boxes
    .map((box) => {
      let top = box.list[0];
      let r = 0;
      let g = 0;
      let b = 0;
      for (const c of box.list) {
        if (c.n > top.n || (c.n === top.n && c.k < top.k)) top = c;
        r += c.r * c.n;
        g += c.g * c.n;
        b += c.b * c.n;
      }
      return { n: box.n, rgb: top.n * 2 >= box.n ? [top.r, top.g, top.b] : [Math.round(r / box.n), Math.round(g / box.n), Math.round(b / box.n)] };
    })
    .sort((x, y) => y.n - x.n)
    .map((x) => x.rgb);
}

/** Map every pixel of every frame to its nearest palette index. */
function indexFrames(frames, palette) {
  const lut = new Int16Array(1 << 24).fill(-1);
  const near = (r, g, b) => {
    let best = 0;
    let dist = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const d = 2 * (p[0] - r) ** 2 + 4 * (p[1] - g) ** 2 + 3 * (p[2] - b) ** 2;
      if (d < dist) {
        dist = d;
        best = i;
      }
    }
    return best;
  };
  return frames.map((rgb) => {
    const out = new Uint8Array(rgb.length / 3);
    for (let i = 0, p = 0; i < rgb.length; i += 3, p++) {
      const k = (rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2];
      let v = lut[k];
      if (v < 0) v = lut[k] = near(rgb[i], rgb[i + 1], rgb[i + 2]);
      out[p] = v;
    }
    return out;
  });
}

// ---------------------------------------------------------------- LZW and the file

/** GIF LZW: minimum code size 8, codes up to 12 bits, a clear code when the table is full. */
export function lzw(indices, minCodeSize = 8) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out = [];
  let next = eoi + 1;
  let size = minCodeSize + 1;
  let bits = 0;
  let nbits = 0;
  const emit = (code) => {
    bits |= code << nbits;
    nbits += size;
    while (nbits >= 8) {
      out.push(bits & 255);
      bits >>>= 8;
      nbits -= 8;
    }
  };
  let table = new Map();
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const code = table.get(key);
    if (code !== undefined) {
      prefix = code;
      continue;
    }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      next = eoi + 1;
      size = minCodeSize + 1;
      table = new Map();
    } else {
      if (next >= 1 << size) size += 1;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (nbits > 0) out.push(bits & 255);
  return Uint8Array.from(out);
}

function subBlocks(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.subarray(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

const u16 = (n) => [n & 255, (n >> 8) & 255];

/**
 * Encode frames as a looping GIF89a.
 * @param {{ rgb: Uint8Array, delay: number }[]} frames delay in hundredths of a second
 * @param {{ width: number, height: number, comment?: string }} opts
 * @returns {{ gif: Buffer, stored: number, palette: number[][], indexed: Uint8Array[] }}
 */
export function encodeGif(frames, { width, height, comment }) {
  if (!frames.length) throw new Error('encodeGif: no frames');
  for (const f of frames) {
    if (f.rgb.length !== width * height * 3) throw new Error('encodeGif: every frame must be width × height RGB');
    if (!Number.isInteger(f.delay) || f.delay < 2 || f.delay > 65535) throw new Error(`encodeGif: delay ${f.delay} is not 2–65535 hundredths of a second`);
  }
  const palette = buildPalette(frames.map((f) => f.rgb));
  const indexed = indexFrames(
    frames.map((f) => f.rgb),
    palette,
  );
  const bytes = [...Buffer.from('GIF89a', 'latin1'), ...u16(width), ...u16(height), 0xf7, 0, 0];
  for (let i = 0; i < 256; i++) bytes.push(...(palette[i] || [0, 0, 0]));
  bytes.push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'latin1'), 0x03, 0x01, ...u16(0), 0x00);
  if (comment) bytes.push(0x21, 0xfe, ...subBlocks(Buffer.from(String(comment), 'utf8')));

  // Frames to store: a frame identical to the last stored one adds its delay to it.
  const stored = [];
  for (let i = 0; i < indexed.length; i++) {
    const last = stored[stored.length - 1];
    if (last && Buffer.from(indexed[i].buffer, indexed[i].byteOffset, indexed[i].length).equals(Buffer.from(indexed[last.i].buffer, indexed[last.i].byteOffset, indexed[last.i].length))) {
      last.delay += frames[i].delay;
      continue;
    }
    stored.push({ i, delay: frames[i].delay });
  }
  let canvas = null;
  for (const s of stored) {
    const idx = indexed[s.i];
    let x0 = 0;
    let y0 = 0;
    let x1 = width - 1;
    let y1 = height - 1;
    if (canvas) {
      x0 = width;
      y0 = height;
      x1 = -1;
      y1 = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0, p = y * width; x < width; x++, p++) {
          if (idx[p] !== canvas[p]) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const rect = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y + y0) * width + x + x0;
        rect[y * w + x] = canvas && idx[p] === canvas[p] ? TRANSPARENT : idx[p];
      }
    }
    // Graphic control: leave in place (disposal 1), transparency after the first frame.
    bytes.push(0x21, 0xf9, 0x04, (1 << 2) | (canvas ? 1 : 0), ...u16(s.delay), TRANSPARENT, 0x00);
    bytes.push(0x2c, ...u16(x0), ...u16(y0), ...u16(w), ...u16(h), 0x00, 8);
    for (const b of subBlocks(lzw(rect, 8))) bytes.push(b);
    canvas = idx;
  }
  bytes.push(0x3b);
  return { gif: Buffer.from(bytes), stored: stored.length, palette, indexed };
}
