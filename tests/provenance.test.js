import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICE_STATES,
  STATE_INFO,
  RECORD_FIELDS,
  OPTIONAL_RECORD_FIELDS,
  KINDS,
  isPriceState,
  validateRecord,
  makeRecord,
  weakestState,
  formatValue,
  deriveRecord,
} from '../src/core/provenance.js';

const NADAC = Object.freeze({
  value: 0.01451,
  kind: 'usd',
  state: 'filed',
  reason: 'Read from the NADAC file, dollars per EA. Explanation code 1: calculated from the most recent pharmacy survey.',
  source_name: 'CMS NADAC',
  source_url: 'https://data.medicaid.gov/dataset/fbb83258-11c7-47f5-8b18-5f8e79f7e704',
  source_file: 'nadac-national-average-drug-acquisition-cost-20261014.csv',
  effective_date: '2026-09-23',
  retrieved_date: '2026-10-17',
  as_of_date: '2026-10-14',
  per: 'EA',
});

const PARTD = Object.freeze({
  value: 0.0711,
  kind: 'usd',
  state: 'filed',
  reason: 'Read from the Part D file (fixture wording).',
  source_name: 'Medicare Part D',
  source_url: 'https://data.cms.gov/x',
  source_file: 'partd.csv',
  effective_date: '2024-12-31',
  retrieved_date: '2026-10-16',
  per: 'EA',
  period: '2024-01-01/2024-12-31',
});

const RULE = Object.freeze({ id: 'test-rule', title: 'Test', formula: 'a ÷ b', description: 'A test rule' });

test('PRICE_STATES strongest first; STATE_INFO rank, label and the brief wording', () => {
  assert.deepEqual([...PRICE_STATES], ['filed', 'published', 'derived', 'estimated']);
  assert.ok(Object.isFrozen(PRICE_STATES));
  PRICE_STATES.forEach((s, i) => {
    assert.equal(STATE_INFO[s].rank, i);
    assert.equal(STATE_INFO[s].label, s);
    assert.ok(STATE_INFO[s].summary.length > 10);
  });
  assert.equal(STATE_INFO.filed.summary, 'Read from a published government file (NADAC, ASP, a fee schedule). Strongest.');
  assert.equal(STATE_INFO.published.summary, "From a payer's or provider's own published rate.");
  assert.equal(STATE_INFO.derived.summary, 'Computed from a published rule (e.g. Medicare pays 80% of the fee schedule).');
  assert.equal(STATE_INFO.estimated.summary, 'Inferred, with the reason recorded.');
});

test('RECORD_FIELDS, OPTIONAL_RECORD_FIELDS and KINDS', () => {
  assert.deepEqual([...RECORD_FIELDS], ['value', 'kind', 'state', 'reason', 'source_name', 'source_url', 'source_file', 'effective_date', 'retrieved_date']);
  assert.deepEqual([...OPTIONAL_RECORD_FIELDS], ['as_of_date', 'per', 'period']);
  assert.deepEqual([...KINDS], ['usd', 'percent', 'count', 'quantity', 'ratio']);
});

test('isPriceState', () => {
  for (const s of PRICE_STATES) assert.equal(isPriceState(s), true);
  for (const s of ['FILED', 'quoted', '', null, undefined, 0]) assert.equal(isPriceState(s), false);
});

test('validateRecord accepts valid records', () => {
  assert.deepEqual(validateRecord(NADAC), []);
  assert.deepEqual(validateRecord(PARTD), []);
  assert.deepEqual(validateRecord({ ...NADAC, source_url: 'methodology.html#unit-total', state: 'derived' }), []);
  assert.deepEqual(validateRecord({ ...NADAC, kind: 'percent', value: 0 }), []);
  assert.deepEqual(validateRecord({ ...NADAC, kind: 'percent', value: 100 }), []);
  assert.deepEqual(validateRecord({ ...NADAC, kind: 'count', value: 0 }), []);
  assert.deepEqual(validateRecord({ ...NADAC, kind: 'ratio', value: 4.9 }), []);
  assert.deepEqual(validateRecord({ ...NADAC, kind: 'quantity', value: 0.4, per: 'ML' }), []);
  assert.deepEqual(validateRecord({ ...NADAC, kind: 'quantity', value: 2.4, per: 'ML' }), []);
  const { as_of_date, per, ...required } = NADAC;
  assert.deepEqual(validateRecord(required), []);
});

function problemsFor(patch) {
  const rec = { ...NADAC, ...patch };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete rec[k];
  return validateRecord(rec);
}

test('validateRecord reports each problem in plain words', () => {
  assert.deepEqual(validateRecord(null), ['record is not an object']);
  assert.deepEqual(validateRecord([1]), ['record is not an object']);
  assert.deepEqual(validateRecord('x'), ['record is not an object']);
  for (const f of RECORD_FIELDS) {
    assert.ok(problemsFor({ [f]: undefined }).includes(`missing required field "${f}"`), f);
    assert.ok(problemsFor({ [f]: null }).includes(`missing required field "${f}"`), f);
  }
  const cases = [
    [{ value: NaN }, /finite number/],
    [{ value: Infinity }, /finite number/],
    [{ value: '0.01451' }, /finite number/],
    [{ value: 0 }, /usd value must be greater than 0/],
    [{ value: -1 }, /usd value must be greater than 0/],
    [{ kind: 'percent', value: 101 }, /between 0 and 100/],
    [{ kind: 'percent', value: -1 }, /between 0 and 100/],
    [{ kind: 'count', value: -1 }, /0 or more/],
    [{ kind: 'ratio', value: 0 }, /ratio value must be greater than 0/],
    [{ kind: 'quantity', value: 0 }, /quantity value must be greater than 0/],
    [{ kind: 'quantity', value: -0.4 }, /quantity value must be greater than 0/],
    [{ kind: 'quantity', value: 2.4, per: '' }, /per must be a non-empty string/],
    [{ period: null }, /period/],
    [{ kind: 'dollars' }, /kind must be one of/],
    [{ state: 'quoted' }, /state must be one of/],
    [{ reason: '' }, /reason must be a non-empty string/],
    [{ reason: '   ' }, /reason must be a non-empty string/],
    [{ source_name: '' }, /source_name/],
    [{ source_url: 'http://data.medicaid.gov/x' }, /source_url/],
    [{ source_url: 'https://' }, /source_url/],
    [{ source_url: 'methodology.html' }, /source_url/],
    [{ source_url: 'methodology.html#Bad Id' }, /source_url/],
    [{ source_url: 'javascript:alert(1)' }, /source_url/],
    [{ source_url: 'https://example.com/a b' }, /source_url/],
    [{ source_file: '' }, /source_file/],
    [{ effective_date: '2026-02-30' }, /effective_date must be a real calendar date/],
    [{ effective_date: '09/23/2026' }, /effective_date/],
    [{ retrieved_date: '2026-10-17T12:00:00Z' }, /retrieved_date/],
    [{ as_of_date: '2026-13-01' }, /as_of_date/],
    [{ as_of_date: null }, /as_of_date/],
    [{ per: '' }, /per must be a non-empty string/],
    [{ per: null }, /per must be/],
    [{ period: '2024' }, /period/],
    [{ period: '2024-12-31/2024-01-01' }, /period/],
    [{ period: '2024-01-01/2024-02-30' }, /period/],
    [{ inputs: [NADAC] }, /unknown field "inputs"/],
    [{ note: 'x' }, /unknown field "note"/],
  ];
  for (const [patch, re] of cases) {
    const p = problemsFor(patch);
    assert.ok(p.some((x) => re.test(x)), `${JSON.stringify(patch)} → ${JSON.stringify(p)}`);
  }
});

test('validateRecord lists every problem at once', () => {
  const p = validateRecord({ value: 0, kind: 'usd', state: 'nope', reason: '', source_url: 'ftp://x' });
  assert.ok(p.length >= 7, JSON.stringify(p));
});

test('makeRecord returns a frozen record in contract order, or throws listing every problem', () => {
  const shuffled = { per: 'EA', ...NADAC, extra: undefined };
  delete shuffled.extra;
  const r = makeRecord({ ...shuffled, period: undefined });
  assert.ok(Object.isFrozen(r));
  assert.deepEqual(Object.keys(r), [...RECORD_FIELDS, 'as_of_date', 'per']);
  assert.deepEqual(r, NADAC);
  assert.throws(
    () => makeRecord({ ...NADAC, value: 0, state: 'quoted' }),
    (e) => /usd value must be greater than 0/.test(e.message) && /state must be one of/.test(e.message),
  );
});

test('weakestState', () => {
  assert.equal(weakestState(['filed', 'filed']), 'filed');
  assert.equal(weakestState(['filed', 'derived', 'published']), 'derived');
  assert.equal(weakestState(['estimated', 'filed']), 'estimated');
  assert.equal(weakestState([]), null);
  assert.throws(() => weakestState(['filed', 'guess']), /unknown price state/);
});

test('formatValue per kind', () => {
  assert.equal(formatValue(NADAC), '$0.01451 per EA');
  assert.equal(formatValue({ ...NADAC, kind: 'percent', value: 20 }), '20%');
  assert.equal(formatValue({ ...NADAC, kind: 'count', value: 14847081, per: 'claim' }), '14,847,081 claim');
  assert.equal(formatValue({ ...NADAC, kind: 'count', value: 4, per: undefined }), '4');
  assert.equal(formatValue({ ...NADAC, kind: 'ratio', value: 4.9 }), '4.9×');
  assert.equal(formatValue({ ...NADAC, kind: 'quantity', value: 2.4, per: 'ML' }), '2.4 ML');
  assert.throws(() => formatValue({ ...NADAC, kind: 'x' }), /unknown kind/);
});

test('deriveRecord: derived when comparable and every input is strong', () => {
  const r = deriveRecord({ value: 0.87, kind: 'usd', per: '60 EA', rule: RULE, inputs: [NADAC], comparable: true, detail: '60 × $0.01451 = $0.8706' });
  assert.equal(r.state, 'derived');
  assert.equal(r.source_name, 'OpenBill calculation');
  assert.equal(r.source_url, 'methodology.html#test-rule');
  assert.equal(r.source_file, NADAC.source_file);
  assert.equal(r.effective_date, '2026-09-23');
  assert.equal(r.retrieved_date, '2026-10-17');
  assert.equal(r.as_of_date, '2026-10-14');
  assert.equal(r.per, '60 EA');
  assert.equal(r.period, undefined);
  assert.ok(r.reason.startsWith('A test rule. 60 × $0.01451 = $0.8706. Inputs: CMS NADAC $0.01451 per EA (filed, effective 2026-09-23).'), r.reason);
  assert.ok(Object.isFrozen(r));
  assert.deepEqual(validateRecord(r), []);
  for (const v of Object.values(r)) assert.notEqual(typeof v, 'object', 'records stay flat');
  for (const s of ['published', 'derived']) {
    assert.equal(deriveRecord({ value: 1, kind: 'usd', rule: RULE, inputs: [{ ...NADAC, state: s }], comparable: true }).state, 'derived');
  }
});

test('deriveRecord: estimated when not comparable, with each caveat in the reason', () => {
  const r = deriveRecord({
    value: 4.9,
    kind: 'ratio',
    rule: RULE,
    inputs: [PARTD, NADAC],
    labels: ['reference', 'pharmacy'],
    comparable: false,
    caveats: ['Different year', 'All strengths averaged.'],
  });
  assert.equal(r.state, 'estimated');
  assert.match(r.reason, /Estimated because: Different year\. All strengths averaged\.$/);
  assert.match(r.reason, /Inputs: reference, Medicare Part D \$0\.0711 per EA \(filed, effective 2024-12-31, period 2024-01-01 to 2024-12-31\); pharmacy, CMS NADAC \$0\.01451 per EA \(filed, effective 2026-09-23\)/);
  assert.equal(r.source_file, 'partd.csv + nadac-national-average-drug-acquisition-cost-20261014.csv');
  assert.equal(r.effective_date, '2024-12-31', 'oldest input');
  assert.equal(r.retrieved_date, '2026-10-16', 'oldest input');
  assert.equal(r.as_of_date, '2026-10-14', 'oldest input that has one');
  assert.equal(r.period, undefined, 'inputs have different periods');
});

test('deriveRecord: estimated when an input is estimated, even if comparable', () => {
  const r = deriveRecord({ value: 2, kind: 'usd', rule: RULE, inputs: [NADAC, { ...NADAC, state: 'estimated' }], comparable: true });
  assert.equal(r.state, 'estimated');
  assert.match(r.reason, /Estimated because: The CMS NADAC input is estimated/);
  assert.equal(r.source_file, NADAC.source_file, 'unique files');
});

test('deriveRecord: caveats on a derived record are listed as caveats', () => {
  const r = deriveRecord({ value: 2, kind: 'usd', rule: RULE, inputs: [NADAC], comparable: true, caveats: ['Note this'] });
  assert.equal(r.state, 'derived');
  assert.match(r.reason, /Caveats: Note this\.$/);
});

test('deriveRecord: period kept only when every input shares it; source files de-duplicated across " + "', () => {
  const a = { ...PARTD, source_file: 'a.csv' };
  const b = { ...PARTD, source_file: 'a.csv + b.csv' };
  const r = deriveRecord({ value: 1, kind: 'count', rule: RULE, inputs: [a, b], comparable: true });
  assert.equal(r.period, '2024-01-01/2024-12-31');
  assert.equal(r.source_file, 'a.csv + b.csv');
  assert.equal(r.as_of_date, undefined);
  assert.ok(!('as_of_date' in r));
  const r2 = deriveRecord({ value: 1, kind: 'count', rule: RULE, inputs: [a, NADAC], comparable: true });
  assert.equal(r2.period, undefined);
});

test('deriveRecord refuses bad calls', () => {
  const ok = { value: 1, kind: 'usd', rule: RULE, inputs: [NADAC], comparable: true };
  assert.throws(() => deriveRecord({ ...ok, rule: undefined }), /rule/);
  assert.throws(() => deriveRecord({ ...ok, rule: { id: 'Bad Id', description: 'x' } }), /rule/);
  assert.throws(() => deriveRecord({ ...ok, rule: { id: 'x', description: '' } }), /rule/);
  assert.throws(() => deriveRecord({ ...ok, inputs: [] }), /at least one input/);
  assert.throws(() => deriveRecord({ ...ok, inputs: [{ ...NADAC, value: 0 }] }), /input 1 is invalid/);
  assert.throws(() => deriveRecord({ ...ok, comparable: undefined }), /comparable/);
  assert.throws(() => deriveRecord({ ...ok, comparable: false }), /need a caveat/);
  assert.throws(() => deriveRecord({ ...ok, caveats: [''] }), /caveats/);
  assert.throws(() => deriveRecord({ ...ok, labels: ['a', 'b'] }), /labels/);
  assert.throws(() => deriveRecord({ ...ok, value: 0 }), /usd value must be greater than 0/);
  assert.throws(() => deriveRecord({ ...ok, value: NaN }), /finite number/);
  assert.throws(() => deriveRecord({ ...ok, kind: 'ratio', value: -1 }), /ratio/);
});

// Review regression: NaN and Infinity were reported as "got null" (JSON.stringify of them).
test('validateRecord names NaN and Infinity in its message', async () => {
  const { validateRecord } = await import('../src/core/provenance.js');
  const rec = { value: 1, kind: 'usd', state: 'filed', reason: 'r', source_name: 'n', source_url: 'https://x.gov', source_file: 'f', effective_date: '2026-01-01', retrieved_date: '2026-01-02' };
  assert.deepEqual(validateRecord({ ...rec, value: NaN }), ['value must be a finite number, got NaN']);
  assert.deepEqual(validateRecord({ ...rec, value: Infinity }), ['value must be a finite number, got Infinity']);
  assert.deepEqual(validateRecord({ ...rec, value: '0.01' }), ['value must be a finite number, got "0.01"']);
});

// Contract (Price records): optional fields are left out rather than written as null, and no
// other fields are allowed. Each optional field set to null is a problem, not "absent".
test('validateRecord: optional fields must be absent, never null; no extra fields', () => {
  for (const f of OPTIONAL_RECORD_FIELDS) {
    const p = problemsFor({ [f]: null });
    assert.ok(p.length > 0 && p.every((x) => x.includes(f)), `${f}: null → ${JSON.stringify(p)}`);
    const { [f]: _gone, ...without } = { ...NADAC, period: '2026-09-23/2026-09-29' };
    assert.deepEqual(validateRecord(without), [], `${f} absent is fine`);
  }
  for (const extra of ['match', 'inputs', 'outlier', 'unit', '']) {
    assert.deepEqual(problemsFor({ [extra]: 1 }), [`unknown field "${extra}"`]);
  }
});

// Review regression (core-check, real data): every Part D input read "(filed, effective
// 2024-01-01)", as if the 2024 average had been in force since that day. Period data now shows
// its period, as the contract asks ("period is always set and always shown next to it").
test('deriveRecord: an input with a period is described by its period', () => {
  const v3 = { ...PARTD, effective_date: '2024-01-01' };
  const r = deriveRecord({ value: 1, kind: 'ratio', rule: RULE, inputs: [v3, NADAC], labels: ['reference', 'pharmacy'], comparable: false, caveats: ['x'] });
  assert.match(r.reason, /reference, Medicare Part D \$0\.0711 per EA \(filed, for 2024-01-01 to 2024-12-31\); pharmacy, CMS NADAC \$0\.01451 per EA \(filed, effective 2026-09-23\)\./);
  assert.doesNotMatch(r.reason, /effective 2024-01-01/);
  assert.equal(r.effective_date, '2024-01-01', 'the record still carries the oldest effective date');
});

// Contract conflict resolved by the contract (core-check, 2026-10-17): validateRecord required
// `per` on every quantity record, but docs/ARCHITECTURE.md makes `per` optional and gives
// package_size "per = package_unit when reconciled". The builder follows the contract, so the
// 137 unreconciled package sizes in data/drugs.json (no per: the crosswalk states no unit) were
// all rejected. A quantity without a unit is valid; the rules never convert with one.
test('validateRecord: a quantity record without per is valid (unit not stated by the source)', () => {
  const size = { ...NADAC, kind: 'quantity', value: 12.5 };
  delete size.per;
  assert.deepEqual(validateRecord(size), []);
  assert.equal(formatValue(size), '12.5', 'no unit is shown when none is known');
  assert.match(validateRecord({ ...size, per: '' }).join(' '), /per must be a non-empty string/);
  assert.match(validateRecord({ ...size, per: null }).join(' '), /per must be a non-empty string/);
});
