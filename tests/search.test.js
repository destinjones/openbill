import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { SYNONYMS, SUGGEST_MIN_LENGTH, normalizeQuery, groupProducts, buildIndex, search, enterChoice, suggest, editDistance } from '../src/core/search.js';
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

// This test used to pin ZABC and XABCX as 'substring' matches of "abc". That is how "statin" found
// NYSTATIN and "lopid" found CLOPIDOGREL (OB-06), so nothing matches inside a word any more.
test('search ranks exact > prefix > all-tokens-prefix, never inside a word; ties alphabetical', () => {
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
    ],
  );
  assert.equal(search(idx, 'abc', { limit: 2 }).length, 2);
  // Every word must start a word of the name, in any order.
  assert.deepEqual(names(search(idx, 'def abc')), ['ABC DEF']);
});

test('search: tokens rank across products; each product appears once', () => {
  const r = search(index, '500 mg');
  // This test used to pin the alphabetical order. The product with more NDCs comes first now (OB-13).
  assert.deepEqual(names(r), ['METFORMIN HCL 500 MG TABLET', 'ACETAMINOPHEN 500 MG TABLET']);
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
  // The product's own name wins, even over an exact alias. This test used to pin the reverse, which
  // is what put KATERZIA above amlodipine and VIVITROL above naltrexone tablets (OB-04).
  const idx2 = buildIndex(groupProducts([
    { name: 'APIXABAN 5 MG TABLET', ndc: '00000000003', unit: 'EA' },
    { name: 'ELIQUIS 5 MG TABLET', ndc: '00000000004', unit: 'EA', identity: { proprietary_name: 'Eliquis', nonproprietary_name: 'apixaban' } },
  ]));
  assert.deepEqual(names(search(idx2, 'apixaban')), ['APIXABAN 5 MG TABLET', 'ELIQUIS 5 MG TABLET']);
});

const row = (name, ndc, extra = {}) => ({ name, ndc: String(ndc).padStart(11, '0'), unit: 'EA', ...extra });
/** One NADAC name listed under `n` NDCs, each with its own number. */
const listed = (name, n, from) => Array.from({ length: n }, (_, i) => row(name, from + i));
const named = (rows, q, opts) => names(search(buildIndex(groupProducts(rows)), q, opts));

test('ranking: NDC count, then Part D claims, then numeric strength', () => {
  const rows = [...listed('ZED 5 MG TABLET', 9, 100), ...listed('ABC DRUG 5 MG TABLET', 3, 200), ...listed('ABC OTHER 5 MG TABLET', 3, 300)];
  rows[9].part_d = { claims: { value: 50 } };
  rows[12].part_d = { claims: { value: 900 } };
  assert.deepEqual(named(rows, '5 mg'), ['ZED 5 MG TABLET', 'ABC OTHER 5 MG TABLET', 'ABC DRUG 5 MG TABLET']);
});

test('strengths read as numbers, common ones first; a rare strength waits', () => {
  const rows = [...listed('SERT 100 MG TABLET', 40, 100), ...listed('SERT 25 MG TABLET', 30, 200), ...listed('SERT 50 MG TABLET', 40, 300), ...listed('SERT 1,000 MG TABLET', 20, 400), ...listed('SERT 12.5 MG TABLET', 2, 500)];
  assert.deepEqual(named(rows, 'sert'), ['SERT 25 MG TABLET', 'SERT 50 MG TABLET', 'SERT 100 MG TABLET', 'SERT 1,000 MG TABLET', 'SERT 12.5 MG TABLET']);
});

test('a name’s own start beats an FDA name; no release word prefers no release word; oral solid over vial', () => {
  const alias = { identity: { proprietary_name: 'Katerzia', nonproprietary_name: 'amlodipine' } };
  assert.deepEqual(named([...listed('KATERZIA 1 MG/ML SUSP', 30, 100).map((r) => ({ ...r, ...alias })), row('AMLODIPINE 5 MG TABLET', 200)], 'amlodipine'), ['AMLODIPINE 5 MG TABLET', 'KATERZIA 1 MG/ML SUSP']);

  const forms = [...listed('DRUG ER 500 MG TABLET', 20, 100), ...listed('DRUG 500 MG TABLET', 10, 200), ...listed('DRUG 500 MG VIAL', 40, 300), ...listed('DRUG 5% CREAM', 15, 400)];
  assert.deepEqual(named(forms, 'drug'), ['DRUG 500 MG TABLET', 'DRUG 5% CREAM', 'DRUG ER 500 MG TABLET', 'DRUG 500 MG VIAL']);
  assert.equal(named(forms, 'drug er')[0], 'DRUG ER 500 MG TABLET', 'a release word in the query finds that form');
  // Held back, not hidden; and with nothing plain to prefer, or only something rare, it stays.
  assert.deepEqual(named([...listed('OME DR 20 MG CAPSULE', 30, 100), row('OME 2 MG/ML SUSP', 200)], 'ome')[0], 'OME DR 20 MG CAPSULE');
  // A liquid does not outrank a release-form tablet by being the only immediate-release form.
  assert.deepEqual(named([...listed('POT ER 8 MEQ TABLET', 10, 100), ...listed('POT 10% LIQUID', 10, 200)], 'pot'), ['POT ER 8 MEQ TABLET', 'POT 10% LIQUID']);
});

test('a combination waits for the ingredient alone, unless there is none', () => {
  const single = [...listed('OXYC HCL 5 MG TABLET', 10, 100), ...listed('OXYC-ACETAMINOPHEN 5-325 MG TAB', 30, 200)];
  assert.deepEqual(named(single, 'oxyc'), ['OXYC HCL 5 MG TABLET', 'OXYC-ACETAMINOPHEN 5-325 MG TAB']);
  const none = [...listed('HYDRO BIT ER 10 MG CAPSULE', 10, 100), ...listed('HYDRO-ACETAMINOPHEN 5-325 MG TAB', 30, 200)];
  assert.equal(named(none, 'hydro')[0], 'HYDRO-ACETAMINOPHEN 5-325 MG TAB');
});

test('synonyms match whole words only, and nothing matches inside a word', () => {
  const rows = [row('SENNA 8.8 MG/5 ML SYRUP', 1), row('ENOX 40 MG/0.4 ML SYR', 2), row('NYSTATIN 100,000 UNIT/ML SUSP', 3), row('CLOPIDOGREL 75 MG TABLET', 4), row('BIKTARVY 50-200-25 MG TAB', 5, { identity: { nonproprietary_name: 'bictegravir sodium, emtricitabine, and tenofovir alafenamide' } })];
  assert.deepEqual(named(rows, 'syringe'), ['ENOX 40 MG/0.4 ML SYR']);
  assert.deepEqual(named(rows, 'syr'), ['SENNA 8.8 MG/5 ML SYRUP', 'ENOX 40 MG/0.4 ML SYR'].sort());
  assert.deepEqual(named(rows, 'suspension'), ['NYSTATIN 100,000 UNIT/ML SUSP']);
  assert.deepEqual(named(rows, 'statin'), []);
  assert.deepEqual(named(rows, 'lopid'), []);
  assert.deepEqual(named(rows, 'b12'), [], 'a B-word and a strength starting 12 are not "b12"');
});

test('a word started somewhere other than the name’s start is labelled partial; typing a strength is not', () => {
  const rows = [row('GRISEO ULTRA 125 MG TAB', 1, { identity: { nonproprietary_name: 'Ultramicrosize griseo' } }), row('AMLO BESYLATE 5 MG TAB', 2), row('SERT 50 MG TABLET', 3), row('ELIQ 5 MG TABLET', 4, { identity: { nonproprietary_name: 'apixaban' } })];
  const idx = buildIndex(groupProducts(rows));
  const match = (q) => search(idx, q)[0].match;
  assert.equal(match('besyl'), 'partial');
  assert.equal(match('ultram'), 'partial');
  assert.equal(match('apix'), 'partial');
  assert.equal(match('apixaban'), 'exact');
  assert.equal(match('sert 5'), 'prefix');
  assert.equal(match('sert'), 'prefix');
  assert.equal(match('besylate'), 'tokens');
});

test('enterChoice opens only one result or an exact name', () => {
  const rows = [row('ABC 5 MG TABLET', 1), row('ABC 10 MG TABLET', 2), row('XYZ 1 MG TABLET', 3), row('MULTI 1 MG TABLET', 4, { identity: { nonproprietary_name: 'Vitamin A, Iron Sulfate, Zinc' } }), row('ULT 1 MG TABLET', 5, { identity: { nonproprietary_name: 'Ultramicrosize ult' } })];
  const idx = buildIndex(groupProducts(rows));
  const enter = (q) => {
    const c = enterChoice(search(idx, q, { limit: 1000 }));
    return c && c.product.name;
  };
  assert.equal(enter('abc'), null, 'several results');
  assert.equal(enter('abc 5'), 'ABC 5 MG TABLET', 'one result');
  assert.equal(enter('abc 5 mg tablet'), 'ABC 5 MG TABLET', 'an exact name');
  assert.equal(enter('iron sulfate'), null, 'only from another name’s list of ingredients');
  assert.equal(enter('ultram'), null, 'a partial match');
  assert.equal(enter('nothing here'), null);
  assert.equal(enterChoice([]), null);
  assert.equal(enterChoice(null), null);
  assert.equal(enter('00000000001'), 'ABC 5 MG TABLET', 'one exact NDC');
  // Two names that read the same without their punctuation: the name typed does not settle it.
  const twins = buildIndex(groupProducts([row('ABC-5 MG TABLET', 1), row('ABC 5 MG TABLET', 2)]));
  assert.equal(enterChoice(search(twins, 'abc 5 mg tablet')), null);
});

test('NDC results say what they are, and Enter opens only a sure one', () => {
  const rows = [
    row('ONE 5 MG TABLET', '00378718505', { identity: { package_ndc: '0378-7185-05' } }),
    row('TWO 5 MG TABLET', '03787018505'),
    row('THREE 5 MG TABLET', '16714061101', { identity: { package_ndc: '16714-611-01' } }),
    row('THREE 5 MG TABLET', '16714061103'),
    row('ONLY 5 MG TABLET', '55555666601'),
  ];
  const idx = buildIndex(groupProducts(rows));
  const bare = search(idx, '0378718505');
  assert.deepEqual(names(bare), ['ONE 5 MG TABLET', 'TWO 5 MG TABLET'], 'FDA’s own form of a reading comes first; every reading is listed');
  assert.ok(bare.every((r) => r.match === 'ndc' && r.ambiguous && r.entered === r.matched));
  assert.equal(bare[0].printed, '0378-7185-05');
  assert.equal(enterChoice(bare), null);
  // Not in the file, but the same labeler and product is.
  const other = search(idx, '16714-611-02');
  assert.equal(other.length, 1);
  assert.equal(other[0].match, 'ndc-package');
  assert.equal(other[0].entered, '16714061102');
  assert.equal(other[0].matched, '16714061101');
  assert.equal(enterChoice(other), null);
  // Labeler and product only.
  const code = search(idx, '16714-611');
  assert.equal(code[0].match, 'ndc-product');
  assert.equal(code[0].entered, null);
  assert.equal(enterChoice(code).product.name, 'THREE 5 MG TABLET');
  // A 12-digit number is a guess, whatever it finds.
  const long = search(idx, '300378718505');
  assert.equal(long[0].product.name, 'ONE 5 MG TABLET');
  assert.equal(long[0].guess, true);
  assert.equal(enterChoice(long), null);
  assert.deepEqual(search(idx, '99999-9999-99'), []);
  assert.deepEqual(search(idx, '399999999999'), []);
});

test('an alias table plugs in where nothing else fits, and marks what it returns', () => {
  const rows = [row('METFORMIN HCL 500 MG TABLET', 1), row('METFORMIN HCL 850 MG TABLET', 2), row('LOPINAVIR 100 MG TABLET', 3)];
  const entry = { name: 'Glucophage', generic: 'metformin', source: 'a test table' };
  const idx = buildIndex(groupProducts(rows), { aliases: [entry] });
  const r = search(idx, 'glucophage');
  assert.deepEqual(names(r), ['METFORMIN HCL 500 MG TABLET', 'METFORMIN HCL 850 MG TABLET']);
  assert.equal(r[0].alias, entry);
  assert.equal(enterChoice(r.slice(0, 1)), null, 'a generic’s price is not the brand’s; the reader chooses');
  // A name that finds something itself never reaches the table.
  assert.equal(search(buildIndex(groupProducts(rows), { aliases: [{ name: 'metformin', generic: 'lopinavir', source: 'x' }] }), 'metformin')[0].alias, undefined);
  assert.equal(search(buildIndex(groupProducts(rows)), 'glucophage').length, 0, 'no table, no answer');
});

test('suggest does not offer a longer word that merely holds the query, or two edits off the first letter', () => {
  const rows = [row('NYSTATIN 100,000 UNIT/ML SUSP', 1), row('RAPID 5 MG TABLET', 2), row('METFORMIN 500 MG TABLET', 3), row('LOPIDOX 5 MG TABLET', 4)];
  const idx = buildIndex(groupProducts(rows));
  assert.deepEqual(suggest(idx, 'statin'), []);
  assert.deepEqual(suggest(idx, 'lapid'), [{ query: 'RAPID', distance: 1 }], 'one edit may change the first letter');
  assert.deepEqual(suggest(idx, 'tapis'), [], 'two edits may not');
  assert.deepEqual(suggest(idx, 'etformin'), [{ query: 'METFORMIN', distance: 1 }]);
  assert.deepEqual(suggest(idx, 'metfromn'), [{ query: 'METFORMIN', distance: 2 }]);
});

// ---------------------------------------------------------------------------------------------
// The real data: what the audit's table asked for (OB-04, OB-06, OB-13, OB-08, J15).

let real;
function realIndex(t) {
  if (real !== undefined) {
    if (!real) t.skip('data/drugs.json is not here');
    return real;
  }
  real = null;
  const path = new URL('../data/drugs.json', import.meta.url);
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    if (doc.schema === 'openbill.drugs/3') real = buildIndex(groupProducts(linkRows(doc)));
  } catch {
    real = null;
  }
  if (!real) t.skip('data/drugs.json is not here');
  return real;
}

test('real data: the first result of a plain name is the plain tablet', (t) => {
  const idx = realIndex(t);
  if (!idx) return;
  const first = (q) => search(idx, q)[0].product.name;
  for (const [q, want] of [
    ['amlodipine', /^AMLODIPINE BESYLATE [\d.]+ MG TAB$/],
    ['metformin', /^METFORMIN HCL [\d,]+ MG TABLET$/],
    ['meloxicam', /^MELOXICAM [\d.]+ MG TABLET$/],
    ['naltrexone', /^NALTREXONE [\d.]+ MG TABLET$/],
    ['diazepam', /^DIAZEPAM [\d.]+ MG TABLET$/],
    ['metformin 500', /^METFORMIN HCL 500 MG TABLET$/],
    ['metformin 1000', /^METFORMIN HCL 1,000 MG TABLET$/],
    ['metoprolol 25', /^METOPROLOL TARTRATE 25 MG TAB$/],
    ['metoprolol succinate', /^METOPROLOL SUCC ER 25 MG TAB$/],
    ['pantoprazole sodium 40 mg', /^PANTOPRAZOLE SOD DR 40 MG TAB$/],
    ['hydrocodone', /^HYDROCODONE-ACETAMINOPHEN 5-325 MG TABLET$/],
    ['xarelto', /^XARELTO 2\.5 MG TABLET$/],
    ['omeprazole', /^OMEPRAZOLE DR /],
    ['oxycodone', /^OXYCODONE HCL /],
    ['estradiol', /^ESTRADIOL [\d.]+ MG TABLET$/],
  ]) {
    assert.match(first(q), want, q);
  }
  // The rows those lists held at the top before, still found, further down.
  assert.ok(names(search(idx, 'naltrexone')).includes('VIVITROL 380 MG VIAL-DILUENT'));
  assert.ok(names(search(idx, 'metformin')).includes('METFORMIN ER 1,000 MG OSM-TAB'));
});

test('real data: strengths in natural order', (t) => {
  const idx = realIndex(t);
  if (!idx) return;
  const strengths = (q, re) => names(search(idx, q, { limit: 100 })).map((n) => re.exec(n)).filter(Boolean).map((m) => Number(m[1].replace(',', '')));
  const ascending = (list) => list.every((v, i) => i === 0 || list[i - 1] < v);
  assert.deepEqual(strengths('sertraline', /^SERTRALINE HCL ([\d,]+) MG TABLET$/), [25, 50, 100]);
  assert.deepEqual(strengths('metformin', /^METFORMIN HCL (500|850|1,000) MG TABLET$/), [500, 850, 1000]);
  assert.ok(ascending(strengths('atorvastatin', /^ATORVASTATIN ([\d,]+) MG TABLET$/)));
});

test('real data: a word inside a longer word finds nothing, and a synonym does not start a word', (t) => {
  const idx = realIndex(t);
  if (!idx) return;
  for (const [q, wrong] of [
    ['lopid', /^CLOPIDOGREL/],
    ['statin', /^NYSTATIN/],
    ['ranexa', /^TRANEXAMIC/],
    ['oxacillin', /^DICLOXACILLIN/],
    ['chlorothiazide', /^HYDROCHLOROTHIAZIDE/],
    ['cortisone', /^HYDROCORTISONE/],
    ['b12', /^BIKTARVY/],
  ]) {
    const r = search(idx, q, { limit: 1000 });
    assert.ok(!r.some((x) => wrong.test(x.product.name) && x.match !== 'partial'), `${q} → ${names(r).slice(0, 3)}`);
  }
  assert.ok(!names(search(idx, 'syringe', { limit: 1000 })).some((n) => /SYRUP/.test(n)), 'SYRINGE is SYR, which does not start SYRUP');
  assert.ok(search(idx, 'syringe').length > 0);
  assert.ok(search(idx, 'ultram').every((r) => r.match === 'partial'));
});

test('real data: a bare 10-digit number lists every reading, FDA’s own first, and Enter never guesses', (t) => {
  const idx = realIndex(t);
  if (!idx) return;
  let printedTen = 0;
  let several = 0;
  for (const p of idx.products) {
    for (const r of p.rows) {
      const printed = r.identity && r.identity.package_ndc;
      if (typeof printed !== 'string') continue;
      const digits = printed.replace(/-/g, '');
      if (digits.length !== 10) continue;
      printedTen++;
      const found = search(idx, digits);
      assert.equal(found[0].product.name, p.name, `${printed} (bare) lists ${found[0].product.name} first`);
      assert.equal(found[0].matched, r.ndc, printed);
      if (found.length > 1) {
        several++;
        assert.equal(enterChoice(found), null, `${printed} (bare) has ${found.length} readings`);
      }
      // With its hyphens, it is one package, and Enter may open it.
      const sure = search(idx, printed);
      assert.equal(sure.length, 1, printed);
      assert.equal(enterChoice(sure).product.name, p.name, printed);
    }
  }
  assert.ok(printedTen > 1000, `${printedTen} rows carry FDA’s 10-digit form`);
  assert.ok(several > 0, 'the data has numbers that read several ways, or this test tests nothing');
});

test('real data: the audit’s NDC forms', (t) => {
  const idx = realIndex(t);
  if (!idx) return;
  // J15: not in NADAC; its sibling is, and the result says it is a different package.
  const other = search(idx, '16714-611-02');
  assert.equal(other[0].match, 'ndc-package');
  assert.equal(other[0].product.name, 'SERTRALINE HCL 25 MG TABLET');
  assert.equal(other[0].entered, '16714061102');
  assert.notEqual(other[0].matched, other[0].entered);
  assert.equal(enterChoice(other), null);
  // OB-08's first example: FDA's digits, read FDA's way first, with no opening on Enter.
  const bare = search(idx, '8330100101');
  assert.ok(bare.length > 1);
  assert.match(bare[0].product.name, /^METFORMIN/);
  assert.equal(enterChoice(bare), null);
  // OB-12: other ways to write 00378-7185-05, whichever package data the file holds for them.
  const want = search(idx, '00378-7185-05');
  assert.equal(want[0].match, 'ndc');
  for (const q of ['00378.7185.05', '00378/7185/05', '378-7185-05', '00378-718-505', 'NDC 00378 7185 05']) {
    assert.equal(search(idx, q)[0].product.name, want[0].product.name, q);
    assert.equal(search(idx, q)[0].match, 'ndc', q);
  }
  const code = search(idx, '0378-7185');
  assert.equal(code[0].match, 'ndc-product');
  assert.equal(code[0].product.name, want[0].product.name);
  // Neither 12-digit form is opened on Enter, or claims to be sure.
  for (const q of ['300378718505', '303787185053']) {
    const r = search(idx, q);
    assert.ok(r.length > 0, q);
    assert.ok(r.every((x) => x.guess), q);
    assert.equal(enterChoice(r), null, q);
  }
});
