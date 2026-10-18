// data/drugs.json is stored in Git LFS (docs/DECISIONS.md). A clone or CI checkout without
// git-lfs gets a ~130-byte pointer file instead of the data, and every data test would then
// fail with a JSON parse error. This test fails first, with a message that says what to do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const POINTER = 'version https://git-lfs.github.com/spec/';

test('data/drugs.json is the data, not a Git LFS pointer', () => {
  const head = readFileSync(new URL('../data/drugs.json', import.meta.url)).subarray(0, 200).toString('utf8');
  assert.ok(
    !head.startsWith(POINTER),
    'data/drugs.json is a Git LFS pointer. Install Git LFS (https://git-lfs.com), then run: git lfs install && git lfs pull',
  );
  assert.match(head, /^\{\s*"schema": "openbill\.drugs\/\d+"/, 'data/drugs.json should start with its schema line');
});

test('.gitattributes keeps data/drugs.json in Git LFS', () => {
  const attrs = readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8');
  assert.match(attrs, /^data\/drugs\.json filter=lfs diff=lfs merge=lfs -text$/m);
});
