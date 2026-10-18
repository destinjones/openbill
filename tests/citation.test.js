// CITATION.cff (GitHub's "Cite this repository", Zenodo) and .zenodo.json (Zenodo's record for
// each GitHub release) must agree with each other and with package.json, or a release archives
// metadata that says something else. CITATION.cff is YAML; only the few fields checked here are read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
const cff = read('CITATION.cff');
const zenodo = JSON.parse(read('.zenodo.json'));
const field = (name) => {
  const m = cff.match(new RegExp('^' + name + ':\\s*"?([^"\\n]+)"?\\s*$', 'm'));
  return m ? m[1] : null;
};

test('CITATION.cff and .zenodo.json carry the package.json version', () => {
  assert.equal(field('version'), pkg.version);
  assert.equal(zenodo.version, pkg.version);
});

test('CITATION.cff and .zenodo.json name the same title, licence and authors', () => {
  assert.equal(field('title'), zenodo.title);
  assert.equal(field('license'), zenodo.license);
  assert.equal(field('license'), pkg.license);
  const given = [...cff.matchAll(/given-names:\s*"([^"]+)"/g)].map((m) => m[1]);
  const family = [...cff.matchAll(/family-names:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(given.length > 0 && given.length === family.length, 'every CITATION.cff author has given and family names');
  assert.deepEqual(zenodo.creators.map((c) => c.name), family.map((f, i) => `${f}, ${given[i]}`));
});

test('no placeholder is left in the citation files', () => {
  assert.doesNotMatch(cff + JSON.stringify(zenodo), /__[A-Z]+__/);
});

test('CITATION.cff points at the repository package.json names', () => {
  assert.equal(field('repository-code'), pkg.repository.url);
});
