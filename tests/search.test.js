import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { SYNONYMS, SUGGEST_MIN_LENGTH, normalizeQuery, groupProducts, buildIndex, search, suggest, editDistance } from '../src/core/search.js';
import { linkRows } from '../src/core/pack.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/drugs.v3.sample.json', import.meta.url), 'utf8'));
const LINKED = linkRows(FIXTURE);
const products = groupProducts(LINKED);
const index = buildIndex(products);
const names = (results) => results.map((r) => r.product.name);

test('normalizeQuery', () => {
  assert.equal(normalizeQuery(' Metformin  hydrochloride, 500mg '), 'METFORMIN HCL 500 MG');
  assert.equal(normalizeQuery('metformin hcl'), 'METFORMIN HCL');
  assert.equal(normalizeQuery('Amoxicillin 400 mg/5 mL susp.'), 'AMOXICILLIN 400 MG 5 ML SUSP');
  assert.equal(normalizeQuery('amoxicillin suspension'), 'AMOXICILLIN SUSP');
  assert.equal(normalizeQuery('0.5 MG'), '0.5 MG');
  assert.equal(normalizeQuery('12HR nasal'), '12 HR NASAL');
  assert.equal(normalizeQuery('tabs'), 'TABLET');
  assert.equal(normalizeQuery('HYDROCHLORIDE', { synonyms: false }), 'HYDROCHLORIDE');
  assert.equal(normalizeQuery('  '), '');
  assert.equal(normalizeQuery('!!!'), '');
  assert.equal(normalizeQuery(null), '');
  assert.equal(normalizeQuery(42), '');
  assert.equal(SYNONYMS.HYDROCHLORIDE, 'HCL');
});

test('groupProducts groups by name, sorted, with searchable names', () => {
  assert.equal(products.length, 11);
  assert.deepEqual(names(products.map((p) => ({ product: p }))), [...names(products.map((p) => ({ product: p })))].sort());
  const m = products.find((p) => p.name === 'METFORMIN HCL 500 MG TABLET');
  assert.deepEqual(m.ndcs, ['90001000101', '90002000201']);
  assert.equal(m.rows.length, 2);
  assert.equal(m.unit, 'EA');
  // FDA's nonproprietary name repeats the proprietary one; then the linked Part D name.
  assert.deepEqual(m.names, ['METFORMIN HCL 500 MG TABLET', 'Metformin Hydrochloride', 'Metformin Hcl']);
  const e = products.find((p) => p.name === 'ELIQUIS 5 MG TABLET');
  assert.deepEqual(e.names, ['ELIQUIS 5 MG TABLET', 'Eliquis', 'apixaban']); // Part D "Eliquis" / "Apixaban" repeat them
  const f = products.find((p) => p.name.startsWith('FIXTULIN'));
  assert.deepEqual(f.names, ['FIXTULIN 100 UNIT/ML VIAL', 'Fixtulin', 'insulin fixtulin']);
  // Unlinked rows (part_d = { key, basis }) contribute no Part D names.
  assert.deepEqual(groupProducts(FIXTURE.rows).find((p) => p.name === m.name).names, ['METFORMIN HCL 500 MG TABLET', 'Metformin Hydrochloride']);
  const a = products.find((p) => p.name.startsWith('ACETAMINOPHEN'));
  assert.deepEqual(a.names, ['ACETAMINOPHEN 500 MG TABLET']); // identity null
  const mixed = groupProducts([
    { name: 'X', ndc: '2', unit: 'EA' },
    { name: 'X', ndc: '1', unit: 'ML' },
  ]);
  assert.equal(mixed[0].unit, null);
  assert.deepEqual(mixed[0].ndcs, ['1', '2']);
});

test('search by name: exact, prefix, synonyms, FDA names', () => {
  assert.deepEqual(names(search(index, 'metformin')), ['METFORMIN HCL 500 MG TABLET']);
  const exact = search(index, 'Metformin HCl 500 mg tablet');
  assert.equal(exact[0].match, 'exact');
  assert.equal(search(index, 'metformin hydrochloride')[0].product.name, 'METFORMIN HCL 500 MG TABLET');
  assert.equal(search(index, 'metformin hydrochloride 500 mg tab')[0].match, 'exact'); // TAB → TABLET, HYDROCHLORIDE → HCL
  assert.equal(search(index, 'metformin hydrochloride 500')[0].match, 'prefix');
  const apix = search(index, 'apixaban');
  assert.equal(apix[0].product.name, 'ELIQUIS 5 MG TABLET');
  assert.equal(apix[0].match, 'exact');
  assert.equal(apix[0].matched, 'apixaban');
  assert.equal(search(index, 'eliq')[0].product.name, 'ELIQUIS 5 MG TABLET');
  assert.equal(search(index, 'sertraline hydro')[0].product.name, 'SERTRALINE HCL 50 MG TABLET'); // raw prefix of "Sertraline Hydrochloride"
  assert.equal(search(index, 'amoxicillin suspension')[0].product.name, 'AMOXICILLIN 400 MG/5 ML SUSP');
  assert.deepEqual(search(index, 'zzz'), []);
  assert.deepEqual(search(index, ''), []);
  assert.deepEqual(search(index, '   '), []);
  assert.deepEqual(search(index, '!!'), []);
  assert.deepEqual(search(index, null), []);
});

test('search ranks exact > prefix > all-tokens-prefix > substring; ties shorter then alphabetical', () => {
  const rows = ['XABCX', 'XYZ ABC', 'ABC DEF', 'ABC', 'ABD ABC', 'ABC DE', 'ZABC'].map((name, i) => ({ name, ndc: String(i).padStart(11, '0'), unit: 'EA' }));
  const idx = buildIndex(groupProducts(rows));
  const r = search(idx, 'abc');
  assert.deepEqual(
    r.map((x) => [x.product.name, x.match]),
    [
      ['ABC', 'exact'],
      ['ABC DE', 'prefix'],
      ['ABC DEF', 'prefix'],
      ['ABD ABC', 'tokens'],
      ['XYZ ABC', 'tokens'],
      ['ZABC', 'substring'],
      ['XABCX', 'substring'],
    ],
  );
  assert.equal(search(idx, 'abc', { limit: 2 }).length, 2);
  // Every word must start a word of the name, in any order.
  assert.deepEqual(names(search(idx, 'def abc')), ['ABC DEF']);
});

test('search: tokens rank across products; each product appears once', () => {
  const r = search(index, '500 mg');
  assert.deepEqual(names(r), ['ACETAMINOPHEN 500 MG TABLET', 'METFORMIN HCL 500 MG TABLET']);
  assert.ok(r.every((x) => x.match === 'tokens'));
  const all = search(index, 'tablet', { limit: 100 });
  assert.equal(new Set(names(all)).size, all.length);
});

test('search by NDC resolves to the exact product', () => {
  for (const q of ['90001000101', '90001-0001-01', ' 90001-0001-01 ', 'NDC 90001-0001-01']) {
    const r = search(index, q);
    assert.deepEqual(names(r), ['METFORMIN HCL 500 MG TABLET'], q);
    assert.equal(r[0].match, 'ndc');
    assert.equal(r[0].matched, '90001000101');
  }
  // FDA 10-digit forms.
  assert.deepEqual(names(search(index, '90006-004-10')), ['ONDANSETRON 4 MG/2 ML VIAL']); // 5-3-2
  assert.deepEqual(names(search(index, '90007-0005-1')), ['SERTRALINE HCL 50 MG TABLET']); // 5-4-1
  // Unhyphenated 10 digits: every padding is tried.
  assert.deepEqual(names(search(index, '9000600410')), ['ONDANSETRON 4 MG/2 ML VIAL']);
  assert.deepEqual(search(index, '12345678901'), []);
});

function synthetic(nProducts, perProduct) {
  const words = ['ALPHA', 'BETA', 'GAMMA', 'DELTA', 'OMEGA', 'SIGMA', 'KAPPA', 'THETA', 'ZETA', 'IOTA', 'LAMBDA', 'RHO', 'TAU', 'PHI', 'CHI', 'PSI'];
  const forms = ['TABLET', 'CAPSULE', 'ER TABLET', 'VIAL', 'SOLN', 'CREAM', 'SUSP', 'DR CAPSULE'];
  const rows = [];
  for (let p = 0; p < nProducts; p++) {
    const name = `${words[p % 16]}${words[(p >> 4) % 16]}${p % 7 ? 'INE' : 'OL'} HCL ${(p % 50) * 5 + 5} MG ${forms[p % 8]}`;
    for (let k = 0; k < perProduct; k++) rows.push({ name: `${name} ${p}`, ndc: String(p * perProduct + k).padStart(11, '0'), unit: 'EA', identity: k === 0 ? { proprietary_name: `Brand${p}`, nonproprietary_name: `generic${p % 900}` } : null });
  }
  return rows;
}

function timeSearches(idx, queries) {
  // Run every query once untimed first. Otherwise the timings measure V8 compiling search() on
  // its first calls, slowed further by the other test files node --test runs in parallel (a
  // cold median of 13 ms under load, about 2.5 ms warm), rather than how fast search is.
  for (const q of queries) search(idx, q);
  const times = [];
  for (const q of queries) {
    const t0 = performance.now();
    search(idx, q);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)], max: times[times.length - 1] };
}

const QUERIES = ['a', 'al', 'alpha', 'alphabeta', 'betagamma hcl', 'hydrochloride 50', '25 mg tab', 'xyz', 'brand12', 'generic', 'omega 100 mg er', 'lambda', 'cream', 'zzzzzz', '00000012345', 'ine hcl', 'mg', 'tablet'];

test('search is fast on ~6,000 products / 30,000 rows', () => {
  const rows = synthetic(6000, 5);
  const t0 = performance.now();
  const idx = buildIndex(groupProducts(rows));
  const build = performance.now() - t0;
  assert.equal(idx.products.length, 6000);
  search(idx, 'warm up');
  const { median, max } = timeSearches(idx, QUERIES);
  assert.ok(median < 10, `median search ${median.toFixed(2)} ms`);
  assert.ok(max < 50, `slowest search ${max.toFixed(2)} ms`);
  assert.ok(build < 2000, `index build ${build.toFixed(0)} ms`);
  assert.equal(search(idx, '00000012345')[0].product.ndcs.includes('00000012345'), true);
});

test('search on data/drugs.json when present', (t) => {
  const path = new URL('../data/drugs.json', import.meta.url);
  if (!existsSync(path)) {
    t.skip('data/drugs.json not built yet');
    return;
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    t.skip(`data/drugs.json is not readable JSON right now (${e.message}); another step may be writing it`);
    return;
  }
  if (doc.schema !== 'openbill.drugs/3') {
    t.skip(`data/drugs.json is schema ${JSON.stringify(doc.schema)}, not openbill.drugs/3 yet`);
    return;
  }
  const idx = buildIndex(groupProducts(linkRows(doc)));
  search(idx, 'warm up');
  const { median } = timeSearches(idx, [...QUERIES, 'metformin', 'atorvastatin 20', 'insulin', 'eliquis']);
  assert.ok(median < 10, `median search ${median.toFixed(2)} ms over ${idx.products.length} products`);
  const any = doc.rows[0];
  const hit = search(idx, any.ndc);
  assert.equal(hit[0].product.name, any.name);
  assert.equal(search(idx, any.name)[0].product.name, any.name);
  // Misspellings people type, against the real vocabulary.
  suggest(idx, 'warm upp');
  const cases = [
    ['metfromin', 'METFORMIN'],
    ['atorvastatn', 'ATORVASTATIN'],
    ['lisinoprl', 'LISINOPRIL'],
    ['insullin glargine', 'INSULIN GLARGINE'],
  ];
  for (const [q, want] of cases) {
    const t0 = performance.now();
    const s = suggest(idx, q);
    const ms = performance.now() - t0;
    assert.equal(s[0] && s[0].query, want, `${q} → ${JSON.stringify(s)}`);
    assert.ok(search(idx, s[0].query).length > 0);
    assert.ok(ms < 150, `suggest(${q}) took ${ms.toFixed(1)} ms`);
  }
  assert.deepEqual(suggest(idx, 'qqqqzzzz'), []);
  assert.deepEqual(suggest(idx, 'metformin'), [], 'a query with results gets no suggestion');
});

test('editDistance counts insertions, deletions, substitutions and adjacent swaps', () => {
  assert.equal(editDistance('METFROMIN', 'METFORMIN'), 1); // swap
  assert.equal(editDistance('METFORMIN', 'METFORMIN'), 0);
  assert.equal(editDistance('METFORMN', 'METFORMIN'), 1); // insertion
  assert.equal(editDistance('METTFORMIN', 'METFORMIN'), 1); // deletion
  assert.equal(editDistance('MXTFORMIN', 'METFORMIN'), 1); // substitution
  assert.equal(editDistance('MXTFORMIX', 'METFORMIN'), 2);
  assert.equal(editDistance('', 'ABC'), 3);
  assert.equal(editDistance('ABCDEFG', 'A', 2), 3, 'stops early past max');
  assert.equal(editDistance('XXXXXXXX', 'METFORMI', 2), 3);
});

test('suggest: "metfromin" → METFORMIN, only for queries that find nothing', () => {
  assert.deepEqual(search(index, 'metfromin'), []);
  const s = suggest(index, 'metfromin');
  assert.deepEqual(s, [{ query: 'METFORMIN', distance: 1 }]);
  assert.deepEqual(names(search(index, s[0].query)), ['METFORMIN HCL 500 MG TABLET']);
  // Two edits are allowed for words of 5 letters or more; the other words are kept.
  assert.deepEqual(suggest(index, 'metfrmn 500 mg')[0], { query: 'METFORMIN 500 MG', distance: 2 });
  assert.deepEqual(suggest(index, 'eliqus'), [{ query: 'ELIQUIS', distance: 1 }]);
  assert.deepEqual(suggest(index, 'apixibin')[0], { query: 'APIXABAN', distance: 2 });
  // A Part D name of a linked row is in the vocabulary too.
  assert.ok(index.vocab.has('FIXTULIN'));
  assert.equal(suggest(index, 'fixtullin')[0].query, 'FIXTULIN');
  // Nothing to suggest: more than 2 edits, short words, numbers, NDCs, blank, or results already.
  assert.deepEqual(suggest(index, 'mtfrmnx'), []);
  assert.deepEqual(suggest(index, 'zzz'), []);
  assert.deepEqual(suggest(index, 'metformin'), []);
  assert.deepEqual(suggest(index, '12345678901'), []);
  assert.deepEqual(suggest(index, '   '), []);
  assert.deepEqual(suggest(index, null), []);
  assert.equal(SUGGEST_MIN_LENGTH, 3);
  assert.ok([...index.vocab.keys()].every((w) => /^\p{L}+$/u.test(w) && w.length >= SUGGEST_MIN_LENGTH));
  assert.ok(suggest(index, 'metfromin', { limit: 1 }).length <= 1);
});

// Review regression: NADAC writes strengths with thousands separators ("5,000 UNIT/ML",
// "1,000 MG"; 136 real product names), and people type "5000". "heparin 5000" and
// "metformin 1000" found nothing.
test('search folds thousands separators in names and queries', () => {
  assert.equal(normalizeQuery('Heparin 5,000 unit/mL'), 'HEPARIN 5000 UNIT ML');
  assert.equal(normalizeQuery('1,000,000 units'), '1000000 UNITS');
  assert.equal(normalizeQuery('10-12.5 mg'), '10 12.5 MG'); // not a separator: unchanged
  assert.equal(normalizeQuery('5,10 mg'), '5 10 MG'); // not three digits: still split
  assert.deepEqual(names(search(index, 'heparin 5000')), ['HEPARIN 5,000 UNIT/ML VIAL']);
  assert.deepEqual(names(search(index, 'heparin 5,000')), ['HEPARIN 5,000 UNIT/ML VIAL']);
  assert.equal(search(index, 'heparin 5,000 unit/ml vial')[0].match, 'exact');
});

// Review regression (core-check, real data): "rosuvastatin", "citalopram" and "tacrolimus" listed
// CRESTOR, CELEXA and ASTAGRAF XL first, because those brands match through FDA's generic name
// and the tie went to the shorter matched name. A product whose own NADAC name matches now
// comes first within the same rank.
test('search: within a rank, products whose own name matches come before alias-only matches', () => {
  const rows = [
    { name: 'CRESTOR 10 MG TABLET', ndc: '00000000001', unit: 'EA', identity: { proprietary_name: 'Crestor', nonproprietary_name: 'rosuvastatin calcium' } },
    { name: 'ROSUVASTATIN CALCIUM 10 MG TAB', ndc: '00000000002', unit: 'EA', identity: { proprietary_name: 'Rosuvastatin Calcium', nonproprietary_name: 'rosuvastatin calcium' } },
  ];
  const idx = buildIndex(groupProducts(rows));
  const r = search(idx, 'rosuvastatin');
  assert.deepEqual(names(r), ['ROSUVASTATIN CALCIUM 10 MG TAB', 'CRESTOR 10 MG TABLET']);
  assert.deepEqual(r.map((x) => x.match), ['prefix', 'prefix']);
  // The brand name still finds the brand first.
  assert.deepEqual(names(search(idx, 'crestor')), ['CRESTOR 10 MG TABLET']);
  // A better rank still wins over an own-name match: an exact alias beats a prefix of the name.
  const idx2 = buildIndex(groupProducts([
    { name: 'APIXABAN 5 MG TABLET', ndc: '00000000003', unit: 'EA' },
    { name: 'ELIQUIS 5 MG TABLET', ndc: '00000000004', unit: 'EA', identity: { proprietary_name: 'Eliquis', nonproprietary_name: 'apixaban' } },
  ]));
  assert.deepEqual(names(search(idx2, 'apixaban')), ['ELIQUIS 5 MG TABLET', 'APIXABAN 5 MG TABLET']);
});
