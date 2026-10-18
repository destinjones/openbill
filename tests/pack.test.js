import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { PACK_FORMAT, DRUGS_SCHEMA, TABLE_KEYS, packDrugs, unpackDrugs, linkRows } from '../src/core/pack.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/drugs.v3.sample.json', import.meta.url), 'utf8'));
const viaJson = (x) => JSON.parse(JSON.stringify(x));
const roundTrip = (doc) => unpackDrugs(viaJson(packDrugs(doc)));

test('pack round trip: the v3 fixture, tables included', () => {
  assert.equal(FIXTURE.schema, 'openbill.drugs/3');
  const back = roundTrip(FIXTURE);
  assert.deepStrictEqual(back, FIXTURE);
  assert.equal(JSON.stringify(back), JSON.stringify(FIXTURE), 'same key order, byte for byte');
  assert.deepStrictEqual(unpackDrugs(packDrugs(FIXTURE)), FIXTURE, 'also without a JSON trip');
  const p = packDrugs(FIXTURE);
  assert.deepEqual(
    p.tables.map((t) => t.key),
    ['part_d_names', 'part_b_codes'],
    'both tables are packed column by column, not stored as is',
  );
  assert.equal(p.head.part_d_names, undefined);
  assert.equal(p.head.part_b_codes, undefined);
  assert.deepEqual(p.tables[0].keys, Object.keys(FIXTURE.part_d_names));
  assert.deepEqual([...TABLE_KEYS], ['part_d_names', 'part_b_codes']);
});

test('pack: format version and determinism', () => {
  const p = packDrugs(FIXTURE);
  assert.equal(p.format, PACK_FORMAT);
  assert.equal(PACK_FORMAT, 'openbill.pack/2');
  assert.equal(JSON.stringify(packDrugs(FIXTURE)), JSON.stringify(p));
  assert.throws(() => unpackDrugs({ ...p, format: 'openbill.pack/1' }), /expected format openbill\.pack\/2/);
  assert.throws(() => unpackDrugs(null), /expected format/);
  assert.throws(() => unpackDrugs({ ...p, rows: p.rows - 1 }), /belong to no table/);
  assert.throws(() => packDrugs({ schema: 'x' }), /rows array/);
  assert.throws(() => packDrugs(null), /rows array/);
  assert.throws(() => packDrugs({ rows: [[1, 2]] }), /not arrays/);
  assert.throws(() => packDrugs({ rows: [{ a: NaN }] }), /non-finite/);
  assert.throws(() => packDrugs({ rows: [{ a: () => 1 }] }), /cannot pack/);
  assert.throws(() => packDrugs({ rows: [], part_d_names: { k: { a: Infinity } } }), /non-finite/);
});

test('pack round trip: awkward shapes', () => {
  const doc = {
    schema: 'test',
    nested: { deep: [1, { two: null }] },
    rows: [
      { a: null, b: false, c: true, d: 0, e: '', f: {}, g: [], h: ['1', '5'], i: { j: { k: 'x' } }, l: [{ m: 1 }], n: -1.5e-7, o: 1e21 },
      { a: 'now a string', b: 1, c: null, i: null, extra: 'only here' },
      { 'key with.dots': 1, 'weird"key': '\u0000 💊', __proto__x: 1 },
      {},
      'a bare string row',
      42,
      null,
      { a: null, b: false, c: true, d: 0, e: '', f: {}, g: [], h: ['1', '5'], i: { j: { k: 'x' } }, l: [{ m: 1 }], n: 2, o: 3 },
    ],
    counts: { rows: 8 },
  };
  assert.deepStrictEqual(roundTrip(doc), doc);
  assert.equal(JSON.stringify(roundTrip(doc)), JSON.stringify(doc));
  // undefined values survive an in-memory round trip.
  const withUndefined = { rows: [{ a: undefined, b: 1 }] };
  assert.deepStrictEqual(unpackDrugs(packDrugs(withUndefined)), withUndefined);
  // A "__proto__" key is kept as data, not turned into a prototype, in rows and table keys.
  const proto = JSON.parse('{"rows":[{"__proto__":{"polluted":true},"x":1}],"part_b_codes":{"__proto__":{"hcpcs":"x"}}}');
  const back = roundTrip(proto);
  assert.equal(Object.getPrototypeOf(back.rows[0]), Object.prototype);
  assert.deepEqual(Object.keys(back.rows[0]), ['__proto__', 'x']);
  assert.deepEqual(Object.keys(back.part_b_codes), ['__proto__']);
  assert.equal({}.polluted, undefined);
  assert.deepStrictEqual(roundTrip({ rows: [] }), { rows: [] });
});

test('pack: tables that are not objects of objects are kept as is, still lossless', () => {
  const docs = [
    { rows: [{ a: 1 }], part_d_names: null, part_b_codes: { J1: 'not an object' } },
    { rows: [{ a: 1 }], part_d_names: {}, part_b_codes: [] },
    { part_b_codes: { J1: { hcpcs: 'J1', labelers: ['A', 'B'] }, J2: { hcpcs: 'J2', labelers: [] } }, rows: [], schema: 'openbill.drugs/3' },
  ];
  for (const doc of docs) {
    assert.deepStrictEqual(roundTrip(doc), doc, JSON.stringify(doc));
    assert.equal(JSON.stringify(roundTrip(doc)), JSON.stringify(doc), 'key order');
  }
  assert.deepEqual(packDrugs(docs[0]).tables, []);
  assert.deepEqual(
    packDrugs(docs[1]).tables.map((t) => t.key),
    ['part_d_names'],
  );
});

function bigDoc(n) {
  // ~n rows shaped like the fixture rows, with distinct NDCs and varied values, and tables
  // grown in proportion (one Part D name per 8 rows, one HCPCS code per 30 rows, as in the
  // real data: 30,031 rows, ~3,600 names, ~1,000 codes).
  const rows = [];
  const names = {};
  const codes = {};
  const nameKeys = Object.keys(FIXTURE.part_d_names);
  const codeKeys = Object.keys(FIXTURE.part_b_codes);
  for (let i = 0; i < n / 8; i++) {
    const e = viaJson(FIXTURE.part_d_names[nameKeys[i % nameKeys.length]]);
    e.brand_name = `${e.brand_name} ${i}`;
    e.avg_per_unit.value = Number(((i % 991) * 0.0731 + 0.01).toFixed(4));
    names[`${e.brand_name}|${e.generic_name}`] = e;
  }
  for (let i = 0; i < n / 30; i++) {
    const e = viaJson(FIXTURE.part_b_codes[codeKeys[i % codeKeys.length]]);
    e.hcpcs = `J${String(1000 + i)}`;
    e.payment_limit.value = Number(((i % 97) * 1.37 + 0.05).toFixed(3));
    codes[e.hcpcs] = e;
  }
  const nk = Object.keys(names);
  const ck = Object.keys(codes);
  for (let i = 0; i < n; i++) {
    const row = viaJson(FIXTURE.rows[i % FIXTURE.rows.length]);
    row.ndc = String(10000000000 + i * 7919);
    row.name = `${row.name} #${Math.floor(i / 5)}`;
    row.nadac.value = Number(((i % 997) * 0.01379 + 0.00153).toFixed(5));
    row.nadac.effective_date = ['2026-09-23', '2026-09-16', '2026-08-19'][i % 3];
    if (row.identity) row.identity.package_ndc = row.ndc;
    if (row.part_d) row.part_d.key = nk[i % nk.length];
    if (row.part_b) row.part_b.hcpcs = ck[i % ck.length];
    rows.push(row);
  }
  return { ...viaJson(FIXTURE), part_d_names: names, part_b_codes: codes, rows };
}

test('pack is small: under 35% of the full JSON', () => {
  const doc = bigDoc(10000);
  const full = JSON.stringify(doc).length;
  const packed = JSON.stringify(packDrugs(doc)).length;
  assert.ok(packed < 0.35 * full, `packed ${packed} vs full ${full} (${((100 * packed) / full).toFixed(1)}%)`);
  assert.deepStrictEqual(roundTrip(doc), doc);
  assert.equal(linkRows(doc).length, 10000);
});

test('pack round trip on data/drugs.json (schema openbill.drugs/3)', (t) => {
  const path = new URL('../data/drugs.json', import.meta.url);
  if (!existsSync(path)) {
    t.skip('data/drugs.json does not exist yet');
    return;
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    t.skip(`data/drugs.json is not readable JSON right now (${e.message}); it may be mid-write`);
    return;
  }
  if (doc.schema !== DRUGS_SCHEMA) {
    t.skip(`data/drugs.json is schema ${JSON.stringify(doc.schema)}, not ${DRUGS_SCHEMA} yet; tools/build_drugs.py has to be re-run`);
    return;
  }
  const full = JSON.stringify(doc).length;
  const packedJson = JSON.stringify(packDrugs(doc));
  assert.ok(packedJson.length < 0.35 * full, `packed ${packedJson.length} vs full ${full}`);
  const back = unpackDrugs(JSON.parse(packedJson));
  assert.deepStrictEqual(back, doc);
  assert.equal(JSON.stringify(back), JSON.stringify(doc), 'same key order, byte for byte');
  // Every row links: no dangling Part D name or HCPCS code.
  const linked = linkRows(doc);
  assert.equal(linked.length, doc.rows.length);
  for (const r of linked) {
    if (r.part_d) assert.ok('avg_per_unit' in r.part_d && 'brand_name' in r.part_d, r.ndc);
    if (r.part_b) assert.ok('payment_limit' in r.part_b && Array.isArray(r.part_b.labelers), r.ndc);
  }
});

const SAMPLE = FIXTURE.rows.find((r) => r.part_d && r.part_d.key === 'Metformin Hcl|Metformin Hcl');
const ONDANSETRON = FIXTURE.rows.find((r) => r.name.startsWith('ONDANSETRON'));

test('linkRows expands part_d and part_b exactly as the contract lists them', () => {
  const before = JSON.stringify(FIXTURE);
  const rows = linkRows(FIXTURE);
  assert.equal(JSON.stringify(FIXTURE), before, 'the doc is not modified');
  assert.equal(rows.length, FIXTURE.rows.length);
  const m = rows.find((r) => r.ndc === SAMPLE.ndc);
  assert.deepEqual(Object.keys(m.part_d), ['key', 'basis', 'brand_name', 'generic_name', 'avg_per_unit', 'claims', 'outlier']);
  assert.equal(m.part_d.key, 'Metformin Hcl|Metformin Hcl');
  assert.equal(m.part_d.basis, 'generic');
  assert.equal(m.part_d.avg_per_unit, FIXTURE.part_d_names['Metformin Hcl|Metformin Hcl'].avg_per_unit, 'the table record itself, shared');
  const o = rows.find((r) => r.ndc === ONDANSETRON.ndc);
  assert.deepEqual(Object.keys(o.part_b), [
    'hcpcs',
    'hcpcs_dosage',
    'short_description',
    'payment_limit',
    'coinsurance_pct',
    'labelers',
    'bill_units_per_package',
    'package_size',
    'package_qty',
    'package_unit',
  ]);
  assert.equal(o.part_b.payment_limit, FIXTURE.part_b_codes.J2405.payment_limit);
  assert.equal(o.part_b.package_size, ONDANSETRON.part_b.package_size);
  assert.deepEqual(o.part_b.labelers, ['Fixture Labeler A, Inc.', 'Fixture Labeler B, LLC']);
  // Everything else is the row's own, in the row's key order.
  assert.deepEqual(Object.keys(o), Object.keys(ONDANSETRON));
  assert.equal(o.nadac, ONDANSETRON.nadac);
  // null stays null.
  const apap = rows.find((r) => r.name.startsWith('ACETAMINOPHEN'));
  assert.equal(apap.part_d, null);
  assert.equal(apap.part_b, null);
});

test('linkRows: read-only results, shared part_d objects, missing fields stay missing', () => {
  const rows = linkRows(FIXTURE);
  const o = rows.find((r) => r.ndc === ONDANSETRON.ndc);
  assert.ok(Object.isFrozen(rows));
  assert.ok(Object.isFrozen(o));
  assert.ok(Object.isFrozen(o.part_b));
  assert.throws(() => {
    'use strict';
    o.part_b.package_unit = 'EA';
  }, TypeError);
  const doc = viaJson(FIXTURE);
  const twin = viaJson(SAMPLE);
  twin.ndc = '90001000102';
  doc.rows.push(twin);
  delete doc.part_d_names['Metformin Hcl|Metformin Hcl'].claims;
  const linked = linkRows(doc);
  const a = linked.find((r) => r.ndc === SAMPLE.ndc);
  const b = linked.find((r) => r.ndc === '90001000102');
  assert.equal(a.part_d, b.part_d, 'one part_d object per key and basis');
  assert.equal('claims' in a.part_d, false, 'nothing filled in for a missing field');
  delete doc.part_b_codes.J2405.labelers;
  assert.equal('labelers' in linkRows(doc).find((r) => r.ndc === ONDANSETRON.ndc).part_b, false);
});

test('linkRows refuses a wrong schema and dangling keys', () => {
  assert.throws(() => linkRows({ ...FIXTURE, schema: 'openbill.drugs/2' }), /reads schema openbill\.drugs\/3/);
  assert.throws(() => linkRows(null), /rows array/);
  const d = viaJson(FIXTURE);
  d.rows.find((r) => r.ndc === SAMPLE.ndc).part_d.key = 'Nope|Nope';
  assert.throws(() => linkRows(d), /90001000101 points at Part D name "Nope\|Nope"/);
  const b = viaJson(FIXTURE);
  b.rows.find((r) => r.ndc === ONDANSETRON.ndc).part_b.hcpcs = 'J0000';
  assert.throws(() => linkRows(b), /points at HCPCS "J0000"/);
  const proto = viaJson(FIXTURE);
  proto.rows.find((r) => r.ndc === SAMPLE.ndc).part_d.key = '__proto__';
  assert.throws(() => linkRows(proto), /not in part_d_names/);
});
