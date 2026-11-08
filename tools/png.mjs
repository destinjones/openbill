// A palette PNG from a screenshot, with no dependency: the preview cards at 256 colours or fewer.
// Their colours are flat apart from text antialiasing, so a palette takes them to about 42% of the
// size with no visible change (docs/DECISIONS.md, decision 55). The palette is the median cut
// tools/gif.mjs already has for the reveal clip; there is no dithering and no randomness, so the
// same screenshot always gives the same bytes. PNG stays the format (decision 48).

import zlib from 'node:zlib';

import { decodePng, buildPalette, indexFrames } from './gif.mjs';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buffers) {
  let c = -1;
  for (const b of buffers) for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'latin1');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32([name, data]));
  return Buffer.concat([head, name, data, tail]);
}

/**
 * An 8-bit palette PNG (colour type 3), not interlaced, every row filter 0: the None filter suits
 * indices, whose values have no order for a difference to help.
 * @param {number} width
 * @param {number} height
 * @param {number[][]} palette up to 256 [r, g, b]
 * @param {Uint8Array} indices width × height palette indices
 * @returns {Buffer}
 */
export function encodeIndexedPng(width, height, palette, indices) {
  if (palette.length < 1 || palette.length > 256) throw new Error(`encodeIndexedPng: ${palette.length} palette entries`);
  if (indices.length !== width * height) throw new Error(`encodeIndexedPng: ${indices.length} indices for ${width}×${height}`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // colour type: palette
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) raw.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('PLTE', Buffer.from(palette.flat())),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A screenshot PNG as a palette PNG.
 * @param {Buffer} png 8-bit RGB or RGBA, not interlaced
 * @returns {Buffer}
 */
export function quantizePng(png) {
  const { width, height, rgb } = decodePng(png);
  const palette = buildPalette([rgb]);
  const [indices] = indexFrames([rgb], palette);
  return encodeIndexedPng(width, height, palette, indices);
}
