import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { slugify, uniqueSlugs } from '../src/core/slug.js';
import { SITE_URL, REPO_URL } from '../src/core/config.js';
import { groupProducts } from '../src/core/search.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/drugs.v3.sample.json', import.meta.url), 'utf8'));
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

test('slugify: lowercase ASCII, & → and, every other run of non-alphanumerics → one "-", trimmed', () => {
  assert.equal(slugify('ELIQUIS 5 MG TABLET'), 'eliquis-5-mg-tablet');
  assert.equal(slugify('AMOXICILLIN 400 MG/5 ML SUSP'), 'amoxicillin-400-mg-5-ml-susp');
  assert.equal(slugify('HEPARIN 5,000 UNIT/ML VIAL'), 'heparin-5-000-unit-ml-vial');
  assert.equal(slugify('METFORMIN HCL 500 MG TABLET'), 'metformin-hcl-500-mg-tablet');
  assert.equal(slugify('ARIPIPRAZOLE 10 MG TABLET'), 'aripiprazole-10-mg-tablet');
  assert.equal(slugify('A&D OINTMENT'), 'a-and-d-ointment');
  assert.equal(slugify('A & D OINTMENT'), 'a-and-d-ointment');
  assert.equal(slugify('SALT&PEPPER'), 'salt-and-pepper');
  assert.equal(slugify('&'), 'and');
  assert.equal(slugify('  --LIDOCAINE 0.5%--  '), 'lidocaine-0-5');
  assert.equal(slugify('ONE\tTWO\nTHREE'), 'one-two-three');
  assert.equal(slugify('Factor Xa Inhibitor'), 'factor-xa-inhibitor');
  assert.equal(slugify('HMG-CoA Reductase Inhibitor'), 'hmg-coa-reductase-inhibitor');
  assert.equal(slugify('l-Thyroxine'), 'l-thyroxine');
  assert.equal(slugify('Serotonin-3 Receptor Antagonist'), 'serotonin-3-receptor-antagonist');
  assert.equal(slugify('x'), 'x');
  assert.equal(slugify('007'), '007');
});

test('slugify: accents are dropped, other letters outside a-z become separators', () => {
  assert.equal(slugify('CAFÉ CRÈME'), 'cafe-creme');
  assert.equal(slugify('Ångström'), 'angstrom');
  assert.equal(slugify('ﬁne'), 'fine'); // a ligature decomposes
  assert.equal(slugify('İSTANBUL'), 'istanbul');
  assert.equal(slugify('β-BLOCKER'), 'blocker');
  assert.equal(slugify('10 µg'), '10-g');
  assert.equal(slugify('5 × 2'), '5-2');
});

test('slugify: every slug is URL-safe and slugify is idempotent', () => {
  const names = ['ELIQUIS 5 MG TABLET', 'A&D', 'CAFÉ', '  x  ', 'HEPARIN 5,000 UNIT/ML VIAL', 'Q-TIP®', 'a--b__c'];
  for (const n of names) {
    const s = slugify(n);
    assert.match(s, SLUG_RE, n);
    assert.equal(slugify(s), s, n);
    assert.equal(encodeURIComponent(s), s, n);
  }
});

test('slugify: refuses a non-string or a name with no letters or digits', () => {
  for (const x of [null, undefined, 5, {}, ['A']]) assert.throws(() => slugify(x), TypeError, String(x));
  for (const x of ['', '   ', '---', '%/%', 'β']) assert.throws(() => slugify(x), /no letters or digits/, JSON.stringify(x));
});

test('uniqueSlugs: a Map from name to slug, in first-seen order; repeats are listed once', () => {
  const m = uniqueSlugs(['ZOLPIDEM 5 MG TABLET', 'A&D OINTMENT', 'ZOLPIDEM 5 MG TABLET', 'ELIQUIS 5 MG TABLET']);
  assert.ok(m instanceof Map);
  assert.deepEqual([...m.entries()], [
    ['ZOLPIDEM 5 MG TABLET', 'zolpidem-5-mg-tablet'],
    ['A&D OINTMENT', 'a-and-d-ointment'],
    ['ELIQUIS 5 MG TABLET', 'eliquis-5-mg-tablet'],
  ]);
  assert.equal(uniqueSlugs([]).size, 0);
  assert.equal(uniqueSlugs(new Set(['A', 'B'])).size, 2, 'any iterable');
});

test('uniqueSlugs: throws on a collision, naming every name that would share each slug, rather than guessing', () => {
  // Shapes seen in the real NADAC names: a hyphen or a point where another name has a space.
  assert.throws(() => uniqueSlugs(['MICONAZOLE 7 CREAM', 'MICONAZOLE-7 CREAM']), /slug "miconazole-7-cream" would be shared by "MICONAZOLE 7 CREAM", "MICONAZOLE-7 CREAM"/);
  assert.throws(() => uniqueSlugs(['LIDOCAINE 0.5%', 'LIDOCAINE 0-5', 'lidocaine 0 5']), /"LIDOCAINE 0\.5%", "LIDOCAINE 0-5", "lidocaine 0 5"/);
  assert.throws(() => uniqueSlugs(['A&B', 'A AND B']), /slug "a-and-b"/);
  // Every problem in one message, so one build run shows them all.
  let message = '';
  try {
    uniqueSlugs(['X 1', 'X-1', 'Y.2', 'Y 2', '%%', 'Z']);
  } catch (e) {
    message = e.message;
  }
  assert.match(message, /slug "x-1" would be shared by "X 1", "X-1"/);
  assert.match(message, /slug "y-2" would be shared by "Y\.2", "Y 2"/);
  assert.match(message, /"%%" has no letters or digits/);
  assert.doesNotMatch(message, /"Z"/);
  assert.throws(() => uniqueSlugs(null), TypeError);
  assert.throws(() => uniqueSlugs(5), TypeError);
  assert.throws(() => uniqueSlugs([null]), /uniqueSlugs: slugify needs a string, got null/);
});

test('uniqueSlugs: the fixture products have one slug each', () => {
  const names = groupProducts(FIXTURE.rows).map((p) => p.name);
  const m = uniqueSlugs(names);
  assert.equal(m.size, names.length);
  assert.equal(m.get('ELIQUIS 5 MG TABLET'), 'eliquis-5-mg-tablet');
  assert.equal(m.get('HEPARIN 5,000 UNIT/ML VIAL'), 'heparin-5-000-unit-ml-vial');
  for (const s of m.values()) assert.match(s, SLUG_RE);
});

test('SITE_URL: the GitHub Pages site, https, ending in "/", for the same account as REPO_URL', () => {
  assert.equal(SITE_URL, 'https://destinjones.github.io/openbill/');
  assert.match(SITE_URL, /^https:\/\/[^/]+\/.*\/$/);
  const owner = new URL(REPO_URL).pathname.split('/')[1];
  const repo = new URL(REPO_URL).pathname.split('/')[2];
  assert.equal(new URL(SITE_URL).hostname, `${owner}.github.io`);
  assert.equal(new URL(SITE_URL).pathname, `/${repo}/`);
  assert.equal(new URL(`drug/${slugify('ELIQUIS 5 MG TABLET')}/`, SITE_URL).href, 'https://destinjones.github.io/openbill/drug/eliquis-5-mg-tablet/');
});
