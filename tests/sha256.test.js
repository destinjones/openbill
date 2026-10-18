import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha256Hex } from '../src/core/sha256.js';

const node = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

test('sha256Hex matches the FIPS 180-4 examples', () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.equal(sha256Hex(enc('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex(enc('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('sha256Hex matches node:crypto at every padding boundary and on a large buffer', () => {
  for (let n = 0; n <= 130; n++) {
    const b = new Uint8Array(n).map((_, i) => (i * 31 + n) & 0xff);
    assert.equal(sha256Hex(b), node(b), `length ${n}`);
  }
  const big = crypto.randomBytes(3 * 1024 * 1024 + 17);
  assert.equal(sha256Hex(new Uint8Array(big)), node(big));
  assert.throws(() => sha256Hex('abc'), /Uint8Array/);
});
