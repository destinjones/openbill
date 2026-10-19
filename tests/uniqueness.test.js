// The unique-prose measure (src/build/uniqueness.js, decision 52), on made-up pages. The floor the
// real drug pages must clear is in tests/site.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { proseBlocks, words, pageShingles, measure, summarize, quantile, templateMin, SHINGLE, TEMPLATE_SHARE } from '../src/build/uniqueness.js';

const page = (main, extra = '') => `<!doctype html><html><head><title>x</title></head><body><header>Site name, every page</header><main id="main">${main}</main><footer>Disclaimer, every page</footer>${extra}</body></html>`;

test('proseBlocks: the visible text of <main>, one block per paragraph, item, heading or table row', () => {
  const html = page('<h1>NAME &amp; CO</h1><p>One <a href="#">linked</a> sentence.</p><ul><li>First</li><li>Second</li></ul><table><tr><th>A</th><td>$1.00</td></tr></table><script type="application/ld+json">{"x":1}</script>');
  assert.deepEqual(proseBlocks(html), ['NAME & CO', 'One linked sentence.', 'First', 'Second', 'A $1.00']);
  assert.throws(() => proseBlocks('<p>no main</p>'), /no <main>/);
});

test('words: lower case, punctuation trimmed, prices, dates, NDCs and multiples kept whole', () => {
  assert.deepEqual(words('Pharmacies pay $3.35 (30 × $0.11173), eff. 2026-09-23; 13.9× 00904-7368-06 “Aripiprazole”.'), ['pharmacies', 'pay', '$3.35', '30', '$0.11173', 'eff', '2026-09-23', '13.9×', '00904-7368-06', 'aripiprazole']);
});

test('measure: template shingles are shared by many pages; a page’s own words are not; repeats count once', () => {
  const template = 'This sentence is the same on every page of the site';
  const pages = [];
  for (let i = 0; i < 100; i++) pages.push({ name: `P${i}`, shingles: pageShingles(page(`<p>${template}.</p><p>Product ${i} costs ${i}.11 per unit at every pharmacy on this list.</p>`)) });
  // One page repeats its own sentence: the copy adds words but no page-specific ones.
  const rare = '<p>Rare item costs $9.99 per unit at every pharmacy on this list.</p>';
  pages.push({ name: 'R', shingles: pageShingles(page(`<p>${template}.</p>${rare}${rare}`)) });
  const r = measure(pages);
  assert.equal(templateMin(101), 2);
  assert.equal(r[0].words, 11 + 12);
  // "Product 0 costs $0.11" is the page's own; "per unit at every pharmacy on this list" is template,
  // and so is the sentence every page has.
  assert.equal(r[0].specific, 4);
  assert.equal(r[100].words, 11 + 24);
  assert.equal(r[100].specific, 4, 'the repeated sentence counts once');
  for (const x of r) assert.ok(x.share >= 0 && x.share <= 1);
  // Text on every page is template; text on one page is not.
  const solo = measure([{ name: 'a', shingles: pageShingles(page('<p>alpha beta gamma delta epsilon zeta</p>')) }, { name: 'b', shingles: pageShingles(page('<p>one two three four five six</p>')) }, { name: 'c', shingles: pageShingles(page('<p>one two three four five six</p>')) }]);
  assert.deepEqual(solo.map((x) => x.specific), [6, 0, 0]);
});

test('summarize and quantile: nearest rank on the sorted values', () => {
  assert.equal(quantile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(quantile([5, 1, 3, 2, 4], 0.1), 1);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.1), 1);
  assert.ok(Number.isNaN(quantile([], 0.5)));
  const s = summarize([{ words: 10, specific: 1, share: 0.1 }, { words: 20, specific: 10, share: 0.5 }, { words: 30, specific: 6, share: 0.2 }]);
  assert.deepEqual(s, { pages: 3, share: { median: 0.2, p10: 0.1 }, specific: { median: 6, p10: 1 }, words: { median: 20 } });
  assert.equal(SHINGLE, 5);
  assert.equal(TEMPLATE_SHARE, 0.01);
});

test('uniqueness.js is DOM-free and pure', () => {
  const src = readFileSync(new URL('../src/build/uniqueness.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\b(window|document|fetch|Date\.now|localStorage|process)\b|from 'node:/);
});
