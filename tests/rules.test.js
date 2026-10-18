import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import {
  RULES,
  HONESTY,
  DEFAULT_EA_QUANTITY,
  EXTREME_HIGH,
  EXTREME_LOW,
  EXTREME_HEADLINE,
  PART_B_SETTING_NOTE,
  PART_B_SETTING_NOTES,
  partBSettingKind,
  partBPackTotal,
  inputDates,
  isExtremeSpread,
  partDNameContext,
  nameOutlier,
  NAME_OUTLIER_FACTOR,
  labelerKey,
  distinctLabelers,
  formatSpreadMultiple,
  rangesByUnit,
  PART_D_BLANK_FLAG_NOTE,
  unitTotal,
  partBPerNadacUnit,
  partBCoinsurance,
  referencePrice,
  spread,
  spreadForRow,
  describeSpread,
  describeSpreadRange,
  freshness,
  packageAmount,
  defaultQuantity,
  summarizeProduct,
} from '../src/core/rules.js';
import { validateRecord } from '../src/core/provenance.js';
import { SOURCE_INFO } from '../src/core/sources.js';
import { normalizeNdc } from '../src/core/ndc.js';
import { formatMoney, quantityProblem } from '../src/core/money.js';
import { linkRows } from '../src/core/pack.js';
import { groupProducts } from '../src/core/search.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/drugs.v3.sample.json', import.meta.url), 'utf8'));
const LINKED = linkRows(FIXTURE);
const rowsNamed = (prefix) => LINKED.filter((r) => r.name.startsWith(prefix));
const rowNamed = (prefix) => rowsNamed(prefix)[0];
const clone = (x) => JSON.parse(JSON.stringify(x));
const METFORMIN = LINKED.find((r) => r.ndc === '90001000101');
const ONDANSETRON = rowNamed('ONDANSETRON');
const TESTOSTERONE = rowNamed('TESTOSTERONE');
const HEPARIN = rowNamed('HEPARIN');
const LEVO = rowNamed('LEVOTHYROXINE');
const APAP = rowNamed('ACETAMINOPHEN');
const ELIQUIS = rowNamed('ELIQUIS');
const SERTRALINE = rowNamed('SERTRALINE');
const AMOX = rowNamed('AMOXICILLIN');
const FIXTUMAB = rowNamed('FIXTUMAB');
const FIXTULIN = rowNamed('FIXTULIN');

function records(v, out = []) {
  if (v && typeof v === 'object') {
    if ('value' in v && 'state' in v) out.push(v);
    else Object.values(v).forEach((x) => records(x, out));
  }
  return out;
}

test('the fixture is schema v3, every record in it is valid, and it is marked as fixture data', () => {
  assert.equal(FIXTURE.schema, 'openbill.drugs/3');
  assert.match(FIXTURE.fixture, /not real data/);
  const all = records({ rows: FIXTURE.rows, d: FIXTURE.part_d_names, b: FIXTURE.part_b_codes });
  assert.ok(all.length >= 45, `${all.length} records`);
  for (const r of all) {
    assert.deepEqual(validateRecord(r), [], JSON.stringify(r));
    assert.match(r.reason, /Fixture data, not a real figure\./, 'every value is marked as fixture data');
    assert.match(r.source_file, /^fixture-/);
  }
  for (const row of FIXTURE.rows) {
    if (row.identity) assert.equal(normalizeNdc(row.identity.package_ndc), row.ndc, row.name);
    assert.match(row.ndc, /^900(0[1-9]|1[0-2])/, 'made-up labeler codes');
    if (row.part_d) assert.ok(FIXTURE.part_d_names[row.part_d.key], row.part_d.key);
    if (row.part_b) assert.ok(FIXTURE.part_b_codes[row.part_b.hcpcs], row.part_b.hcpcs);
  }
  // Period data is effective from the start of its period.
  for (const r of all) if (r.period) assert.equal(r.effective_date, r.period.split('/')[0], r.reason);
  // The cases the v3 rules need are all present.
  const labelers = Object.values(FIXTURE.part_b_codes).map((c) => c.labelers.length);
  assert.ok(labelers.includes(1) && labelers.some((n) => n > 1), 'single- and multi-labeler codes');
  assert.ok(Object.values(FIXTURE.part_d_names).some((e) => e.outlier === null), 'an outlier flag left blank');
  assert.ok(Object.values(FIXTURE.part_d_names).some((e) => e.outlier === true), 'an outlier');
  assert.ok(FIXTURE.rows.some((r) => r.part_d && r.part_b), 'a row with both Part D and Part B');
});

test('RULES: one entry per rule the page applies, all fields in plain words', () => {
  assert.deepEqual(
    RULES.map((r) => r.id),
    ['unit-total', 'default-quantity', 'reference-price', 'part-b-per-nadac-unit', 'part-b-coinsurance', 'spread', 'part-b-single-labeler', 'extreme-gap', 'part-d-name-outlier', 'freshness'],
  );
  for (const r of RULES) {
    for (const f of ['id', 'title', 'summary', 'formula', 'description']) assert.ok(typeof r[f] === 'string' && r[f].trim(), `${r.id}.${f}`);
    assert.match(r.id, /^[a-z0-9-]+$/);
    assert.ok(Object.isFrozen(r));
    assert.match(r.summary, /\.$/);
    assert.match(r.description, /\.$/);
  }
  assert.ok(Object.isFrozen(RULES));
});

// RULES render verbatim on methodology.html for a lay reader: every abbreviation is spelled
// out in the first rule that uses it, and the numbers in the wording come from the code.
test('RULES: abbreviations are explained where they first appear; thresholds match the code', () => {
  const terms = [
    ['NADAC', 'National Average Drug Acquisition Cost'],
    ['CMS', 'Centers for Medicare & Medicaid Services'],
    ['NDC', 'National Drug Code'],
    ['HCPCS', 'HCPCS is the coding system Medicare uses for billing'],
    ['FDA', 'Food and Drug Administration'],
    ['EA', 'each'],
    ['ML', 'milliliter'],
    ['GM', 'gram'],
  ];
  for (const [term, explanation] of terms) {
    const first = RULES.find((r) => new RegExp(`\\b${term}\\b`).test(r.description));
    assert.ok(first, term);
    assert.ok(first.description.includes(explanation), `${term} first appears in ${first.id} without "${explanation}"`);
  }
  const text = RULES.map((r) => r.description).join(' ');
  for (const word of ['labeler', 'outlier', 'crosswalk', 'derived', 'estimated', 'Part D', 'Part B']) assert.ok(text.includes(word), word);
  const byId = Object.fromEntries(RULES.map((r) => [r.id, r]));
  assert.ok(byId.freshness.description.includes(`${SOURCE_INFO.nadac.stale_after_days} days for NADAC`));
  assert.ok(byId.freshness.description.includes(`${SOURCE_INFO.asp_limits.stale_after_days} days for Part B`));
  assert.ok(byId.freshness.description.includes(`${SOURCE_INFO.partd.stale_after_days} days for Part D`));
  assert.ok(byId['extreme-gap'].description.includes(`${EXTREME_HIGH}× or more, or ${EXTREME_LOW}× or less`));
  assert.ok(byId['default-quantity'].description.includes(`it starts at ${DEFAULT_EA_QUANTITY}`) || byId['default-quantity'].description.includes(`starts at ${DEFAULT_EA_QUANTITY},`));
  assert.ok(byId['unit-total'].description.includes('<$0.01'));
});

test('HONESTY: the five lines verbatim from the brief, bold phrases identifiable', () => {
  assert.deepEqual(
    HONESTY.map((h) => h.markdown),
    [
      'A price is a **range to expect**, never a quote.',
      "**Medicare's price is not your price.** Say so on every screen that shows it.",
      'State which dataset and which effective date produced every figure.',
      'If a source is stale or a file is empty, show that rather than a zero.',
      "Disclaimer footer: not medical advice, no warranty, other people's data can be wrong.",
    ],
  );
  assert.equal(HONESTY[0].text, 'A price is a range to expect, never a quote.');
  assert.deepEqual(
    HONESTY[0].parts.map((p) => [p.text, p.strong]),
    [
      ['A price is a ', false],
      ['range to expect', true],
      [', never a quote.', false],
    ],
  );
  assert.deepEqual(
    HONESTY[1].parts.filter((p) => p.strong).map((p) => p.text),
    ["Medicare's price is not your price."],
  );
  for (const h of HONESTY.slice(2)) assert.ok(h.parts.every((p) => !p.strong));
  for (const h of HONESTY) assert.equal(h.parts.map((p) => p.text).join(''), h.text);
});

// Contract: "A pack total keeps the state and source fields of the unit price it scales, and its
// reason shows the multiplication ("60 × $0.01451 per EA, rounded to cents")."
test('unitTotal: keeps the unit price state and source fields; the reason shows the multiplication', () => {
  const unit = METFORMIN.nadac;
  const r = unitTotal(unit, 60);
  assert.equal(r.value, 0.87);
  assert.equal(r.kind, 'usd');
  assert.equal(r.state, 'filed');
  for (const f of ['source_name', 'source_url', 'source_file', 'effective_date', 'retrieved_date', 'as_of_date']) assert.equal(r[f], unit[f], f);
  assert.deepEqual(Object.keys(r), Object.keys(unit), 'no fields added or dropped');
  assert.equal(r.per, '60 EA');
  assert.ok(r.reason.startsWith('60 × $0.01451 per EA, rounded to cents: $0.87 (exactly $0.8706, rounded half-up). The price per unit: '), r.reason);
  assert.ok(r.reason.endsWith(unit.reason), 'the unit price reason follows');
  assert.deepEqual(validateRecord(r), []);
  assert.ok(Object.isFrozen(r));
  // An exact total says so without "exactly".
  assert.ok(unitTotal({ ...unit, value: 0.5 }, 2).reason.startsWith('2 × $0.50 per EA, rounded to cents: $1.00. The price per unit:'));
  // State and period carry over unchanged.
  assert.equal(unitTotal({ ...unit, state: 'estimated' }, 2).state, 'estimated');
  const derived = partBPerNadacUnit(FIXTUMAB);
  const d = unitTotal(derived, 4);
  assert.equal(d.state, 'derived');
  assert.equal(d.source_url, 'methodology.html#part-b-per-nadac-unit');
  assert.equal(d.period, derived.period);
  assert.equal(d.value, 605);
  assert.equal(d.per, '4 ML');
});

test('unitTotal: exact, half-up to cents', () => {
  const unit = METFORMIN.nadac;
  // Half-up at the half-cent: 4 × 0.00125 = 0.005 exactly → $0.01.
  assert.equal(unitTotal({ ...unit, value: 0.00125 }, 4).value, 0.01);
  assert.equal(unitTotal({ ...unit, value: 1.005 }, 1).value, 1.01);
  assert.equal(unitTotal({ ...unit, value: 29874.448 }, 9999).value, 298714605.55);
  assert.equal(unitTotal(unit, '2.5').per, '2.5 EA');
  assert.equal(unitTotal(unit, '2.5').value, 0.04); // 0.036275
  const { per, ...noPer } = unit;
  assert.equal(unitTotal(noPer, 3).per, undefined);
  assert.ok(!('per' in unitTotal(noPer, 3)), 'optional fields stay absent');
});

// Contract: "A non-zero total under half a cent shows as `<$0.01`."
test('unitTotal: a total under half a cent keeps its exact value and shows as <$0.01, never $0.00', () => {
  const unit = METFORMIN.nadac;
  const t = unitTotal({ ...unit, value: 0.00125 }, 3); // 0.00375
  assert.equal(t.missing, undefined);
  assert.equal(t.value, 0.00375);
  assert.equal(formatMoney(t.value), '<$0.01');
  assert.equal(t.state, 'filed');
  assert.match(t.reason, /^3 × \$0\.00125 per EA = \$0\.00375, which is under half a cent, so it is shown as <\$0\.01 rather than rounded to \$0\.00\./);
  assert.deepEqual(validateRecord(t), []);
  assert.equal(formatMoney(unitTotal({ ...unit, value: 0.00499 }, 1).value), '<$0.01');
  assert.equal(formatMoney(unitTotal({ ...unit, value: 0.00001 }, 0.001).value), '<$0.01');
});

test('unitTotal: Missing for unusable quantities; invalid records throw', () => {
  for (const q of [0, -1, 10000, 1.2345, NaN, 'abc', '', null]) {
    const r = unitTotal(METFORMIN.nadac, q);
    assert.equal(r.missing, true, String(q));
    assert.match(r.reason, /not usable/);
  }
  assert.throws(() => unitTotal({ ...METFORMIN.nadac, value: 0 }, 2), /not a valid record/);
  assert.throws(() => unitTotal({ ...METFORMIN.nadac, kind: 'count' }, 2), /kind usd/);
  assert.throws(() => unitTotal(null, 2), /not a valid record/);
});

test('partBPerNadacUnit: reconciled unit converts exactly', () => {
  const r = partBPerNadacUnit(ONDANSETRON);
  // $0.06 per 1 MG × 4 billing units per package ÷ (2 ML × 1) = $0.12 per ML
  assert.equal(r.value, 0.12);
  assert.equal(r.state, 'derived');
  assert.equal(r.per, 'ML');
  assert.equal(r.period, '2026-10-01/2026-12-31');
  assert.equal(r.effective_date, '2026-10-01');
  assert.equal(r.source_url, 'methodology.html#part-b-per-nadac-unit');
  assert.equal(r.source_file, 'fixture-asp-payment-limits-2026q4.csv + fixture-asp-ndc-hcpcs-crosswalk-2026q4.csv');
  assert.ok(r.reason.startsWith(RULES.find((x) => x.id === 'part-b-per-nadac-unit').summary), 'opens with the rule summary');
  assert.match(r.reason, /\$0\.06 per 1 MG \(J2405\) × 4 billing units per package ÷ \(2 ML × 1\) = \$0\.12 per ML/);
  assert.match(r.reason, /payment limit, Medicare Part B \$0\.06 per 1 MG/);
  assert.match(r.reason, /package size, Medicare Part B crosswalk 2 ML/);
  // A conversion that does not divide evenly: 0.1 × 3 ÷ 7.
  const odd = clone(ONDANSETRON);
  odd.part_b.payment_limit.value = 0.1;
  odd.part_b.bill_units_per_package.value = 3;
  odd.part_b.package_size.value = 7;
  assert.equal(partBPerNadacUnit(odd).value, 0.0428571429);
  // 60.5 × 10 ÷ (4 × 1)
  assert.equal(partBPerNadacUnit(FIXTUMAB).value, 151.25);
});

test('partBPerNadacUnit: Missing with the reason when it cannot convert', () => {
  const none = partBPerNadacUnit(APAP);
  assert.equal(none.missing, true);
  assert.match(none.reason, /not in the current quarter’s Medicare Part B NDC-HCPCS crosswalk/);
  const nullUnit = partBPerNadacUnit(TESTOSTERONE);
  assert.equal(nullUnit.missing, true);
  assert.match(nullUnit.reason, /package unit for J1071 could not be matched to the NADAC unit \(ML\)/);
  assert.match(partBPerNadacUnit(HEPARIN).reason, /package unit for J1644 could not be matched/);
  const mismatch = clone(HEPARIN);
  mismatch.part_b.package_unit = 'EA';
  assert.match(partBPerNadacUnit(mismatch).reason, /in EA, but NADAC prices this NDC per ML/);
  const sizeUnit = clone(ONDANSETRON);
  sizeUnit.part_b.package_size.per = 'GM';
  assert.match(partBPerNadacUnit(sizeUnit).reason, /package size in GM, not in NADAC’s unit ML/);
  const asCount = clone(ONDANSETRON);
  asCount.part_b.package_size.kind = 'count';
  assert.match(partBPerNadacUnit(asCount).reason, /no usable package size/);
  for (const key of ['payment_limit', 'bill_units_per_package', 'package_size', 'package_qty']) {
    const gone = clone(ONDANSETRON);
    delete gone.part_b[key];
    assert.equal(partBPerNadacUnit(gone).missing, true, key);
    if (key !== 'payment_limit' && key !== 'package_size') {
      const zero = clone(ONDANSETRON);
      zero.part_b[key].value = 0;
      const z = partBPerNadacUnit(zero);
      assert.equal(z.missing, true, `${key} = 0`);
      assert.match(z.reason, /no usable/);
    }
  }
  assert.equal(partBPerNadacUnit(null).missing, true);
});

test('rules refuse unlinked v3 rows instead of reporting "no Part D"', () => {
  const raw = FIXTURE.rows.find((r) => r.ndc === METFORMIN.ndc);
  assert.throws(() => referencePrice(raw), /part_d is not linked; pass the doc through linkRows\(\)/);
  const rawB = FIXTURE.rows.find((r) => r.ndc === ONDANSETRON.ndc);
  assert.throws(() => partBPerNadacUnit(rawB), /part_b is not linked/);
  assert.throws(() => summarizeProduct([raw]), /not linked/);
});

test('partBCoinsurance', () => {
  const r = partBCoinsurance(ONDANSETRON);
  assert.equal(r.value, 0.012);
  assert.equal(r.per, '1 MG');
  assert.equal(r.state, 'derived');
  assert.equal(r.source_file, 'fixture-asp-payment-limits-2026q4.csv');
  assert.equal(r.source_url, 'methodology.html#part-b-coinsurance');
  // package_unit does not matter: coinsurance is per HCPCS billing unit.
  assert.equal(partBCoinsurance(TESTOSTERONE).value, 0.02);
  const pct = clone(ONDANSETRON);
  pct.part_b.coinsurance_pct.value = 18.4;
  assert.equal(partBCoinsurance(pct).value, 0.01104);
  const zero = clone(ONDANSETRON);
  zero.part_b.coinsurance_pct.value = 0;
  assert.match(partBCoinsurance(zero).reason, /0% coinsurance/);
  const noPct = clone(ONDANSETRON);
  delete noPct.part_b.coinsurance_pct;
  assert.match(partBCoinsurance(noPct).reason, /no usable coinsurance/);
  assert.equal(partBCoinsurance(APAP).missing, true);
});

// Contract (Rules the page applies, Reference price): Part D first, else Part B, else none.
test('referencePrice: Part D first, Part B as the alternate, both reasons when neither', () => {
  const d = referencePrice(METFORMIN);
  assert.equal(d.kind, 'part_d');
  assert.equal(d.tense, 'past');
  assert.equal(d.label, 'Medicare Part D average spending');
  assert.equal(d.record, METFORMIN.part_d.avg_per_unit);
  assert.equal(d.alternate, null);
  assert.match(d.part_b_reason, /not in the current quarter’s Medicare Part B/);
  assert.match(d.reason, /average spending per EA for “Metformin Hcl”, 2024-01-01 to 2024-12-31, matched to this NDC by its generic name\./);
  // Both usable: Part D on the card, Part B in the provenance panel with the coverage setting.
  const both = referencePrice(FIXTULIN);
  assert.equal(both.kind, 'part_d');
  assert.equal(both.record.value, 5);
  assert.equal(both.alternate.kind, 'part_b');
  assert.equal(both.alternate.tense, 'present');
  assert.equal(both.alternate.record.value, 6); // 3 × 20 ÷ (10 × 1)
  assert.equal(both.alternate.record.state, 'derived');
  assert.ok(both.alternate.reason.includes(PART_B_SETTING_NOTE));
  assert.match(both.alternate.reason, /payment limit for HCPCS J1817 \(per 50 UNITS\) for 2026-10-01 to 2026-12-31, converted to dollars per ML/);
  assert.equal(both.part_b_reason, undefined);
  assert.equal(both.part_d_reason, undefined);
  // Part B when there is no Part D.
  const b = referencePrice(FIXTUMAB);
  assert.equal(b.kind, 'part_b');
  assert.equal(b.tense, 'present');
  assert.equal(b.record.value, 151.25);
  assert.equal(b.alternate, null);
  assert.match(b.part_d_reason, /No Medicare Part D spending row/);
  assert.ok(b.reason.includes(PART_B_SETTING_NOTE));
  assert.equal(referencePrice(ONDANSETRON).kind, 'part_b');
  // Part B present but not convertible, no Part D: missing with both reasons, Part D first.
  const t = referencePrice(TESTOSTERONE);
  assert.equal(t.missing, true);
  assert.match(t.part_b_reason, /could not be matched/);
  assert.match(t.part_d_reason, /No Medicare Part D spending row/);
  assert.match(t.reason, /^No Medicare reference price\. Part D: .+ Part B: /);
  assert.equal(referencePrice(APAP).missing, true);
});

test('referencePrice: the Part D tests (outlier, blank flag, unit) and falling back to Part B', () => {
  // Outlier, no Part B: missing.
  const o = referencePrice(LEVO);
  assert.equal(o.missing, true);
  assert.match(o.reason, /flags this drug’s average spending per dosage unit as an outlier/);
  // Outlier with a usable Part B: Part B, saying why not Part D.
  const out = clone(FIXTULIN);
  out.part_d.outlier = true;
  const ob = referencePrice(out);
  assert.equal(ob.kind, 'part_b');
  assert.match(ob.part_d_reason, /outlier/);
  // A blank flag (null) counts as not flagged, and the reason says the flag is blank.
  assert.equal(SERTRALINE.part_d.outlier, null);
  const blank = referencePrice(SERTRALINE);
  assert.equal(blank.kind, 'part_d');
  assert.ok(blank.reason.includes(PART_D_BLANK_FLAG_NOTE), blank.reason);
  assert.ok(!referencePrice(METFORMIN).reason.includes(PART_D_BLANK_FLAG_NOTE));
  // Unit must equal the row's unit; a missing unit is not assumed.
  const unit = clone(METFORMIN);
  unit.part_d.avg_per_unit.per = 'ML';
  assert.match(referencePrice(unit).reason, /per ML, but NADAC prices this NDC per EA/);
  const noPer = clone(METFORMIN);
  delete noPer.part_d.avg_per_unit.per;
  assert.match(referencePrice(noPer).reason, /does not say which unit it is per/);
  const unitB = clone(FIXTULIN);
  unitB.part_d.avg_per_unit.per = 'EA';
  assert.equal(referencePrice(unitB).kind, 'part_b');
  const noAvg = clone(METFORMIN);
  delete noAvg.part_d.avg_per_unit;
  assert.match(referencePrice(noAvg).reason, /no usable average/);
});

test('spread: Part B with a single labeler is derived; shared codes are estimated, saying how many', () => {
  const s = spreadForRow(FIXTUMAB);
  assert.equal(s.kind, 'part_b');
  assert.equal(s.record.kind, 'ratio');
  assert.equal(s.record.value, 3.025);
  assert.equal(s.record.state, 'derived');
  assert.equal(s.record.source_url, 'methodology.html#spread');
  assert.equal(s.record.effective_date, '2026-09-23', 'oldest input');
  assert.equal(s.sentence, 'Medicare pays 3.0× what pharmacies pay.');
  assert.deepEqual(validateRecord(s.record), []);
  const shared = spreadForRow(ONDANSETRON);
  assert.equal(shared.record.state, 'estimated');
  assert.equal(shared.record.value, 0.24);
  assert.match(shared.record.reason, /Estimated because: 2 labelers share HCPCS J2405 on the CMS crosswalk, so its payment limit is an average across all their products billed under that code, not this NDC’s own price\./);
  assert.equal(shared.sentence, 'Medicare pays 76% less than pharmacies pay.');
  const unknown = clone(FIXTUMAB);
  delete unknown.part_b.labelers;
  assert.match(spreadForRow(unknown).record.reason, /list of labelers for HCPCS J9990 is missing/);
  assert.equal(spreadForRow(unknown).record.state, 'estimated');
  const empty = clone(FIXTUMAB);
  empty.part_b.labelers = [];
  assert.equal(spreadForRow(empty).record.state, 'estimated');
});

// Review PARTB-8: CMS writes one company several ways on one code (J0717 "UCB, INC." and
// "UCB, Inc."; Q5099 "Celltrion USA, Inc." and "Celltrion USA, INC."). That is one labeler; the
// raw spellings stay in the explanation.
test('distinctLabelers: spellings of one company count once, and are quoted', () => {
  assert.equal(labelerKey('UCB, INC.'), labelerKey('UCB, Inc.'));
  assert.equal(labelerKey('Celltrion USA, Inc.  '), labelerKey('Celltrion USA, INC.'));
  assert.equal(labelerKey('Apollo Pharmaceuticals'), labelerKey('Apollo Pharmaceuticals Inc.'));
  assert.equal(labelerKey('Preferred Pharmaceuticals Inc'), labelerKey('PREFERRED PHARMACEUTICALS, INC.'));
  assert.equal(labelerKey('Hikma Pharmaceuticals USA Inc.'), 'hikma pharmaceuticals usa');
  assert.notEqual(labelerKey('Fresenius Kabi USA, LLC'), labelerKey('Fresenius Kabi'));
  assert.notEqual(labelerKey('Pfizer Inc'), labelerKey('Pfizer Laboratories Div Pfizer Inc'));
  assert.equal(distinctLabelers(undefined), null);
  assert.deepEqual(distinctLabelers([]), []);
  const d = distinctLabelers(['UCB, INC.', 'UCB, Inc.']);
  assert.equal(d.length, 1);
  assert.deepEqual([...d[0].spellings], ['UCB, INC.', 'UCB, Inc.']);
  // Single company, two spellings: derived (no "lesser of" note on the fixture's code), and the
  // reason quotes both spellings.
  const two = clone(FIXTUMAB);
  two.part_b.labelers = [two.part_b.labelers[0].toUpperCase(), two.part_b.labelers[0]];
  const sp = spreadForRow(two);
  assert.equal(sp.record.state, 'derived');
  assert.ok(sp.record.reason.includes(`“${two.part_b.labelers[0]}” and “${two.part_b.labelers[1]}”`), sp.record.reason);
  // Several companies, one written twice: counted once, and said.
  const shared = clone(ONDANSETRON);
  shared.part_b.labelers = [...shared.part_b.labelers, shared.part_b.labelers[0].toUpperCase()];
  const r = spreadForRow(shared).record;
  assert.equal(r.state, 'estimated');
  assert.match(r.reason, /2 labelers share HCPCS J2405/);
  assert.match(r.reason, /Counted once each though written more than one way/);
});

// Review BOUT-5: a product far dearer than the other products CMS averages under its Part D
// name says so, with both prices, ahead of the other Part D caveats. Only that direction.
test('nameOutlier: a product 20× the others under its Part D name says so', () => {
  const cheap = (name, ndc, v) => {
    const r = clone(METFORMIN);
    r.name = name;
    r.ndc = ndc;
    r.nadac = { ...r.nadac, value: v };
    return r;
  };
  const rows = [cheap('CHEAP A', '90001000101', 0.02), cheap('CHEAP A', '90001000102', 0.03), cheap('CHEAP B', '90001000201', 0.04), cheap('DEAR', '90001000301', 0.9), cheap('DEAR', '90001000302', 1.1)];
  const ctx = partDNameContext(rows);
  assert.equal(NAME_OUTLIER_FACTOR, 20);
  const o = nameOutlier(rows[3], ctx);
  // DEAR: lower median of 0.9 and 1.1 is 0.9; the others' lower medians are 0.02 and 0.04, whose lower median is 0.02.
  assert.equal(o.mine, 0.9);
  assert.equal(o.others, 0.02);
  assert.equal(o.ratio, 45);
  assert.equal(o.products, 2);
  assert.match(o.text, /^This product’s middle NADAC price, \$0\.90 per EA, is 45\.0× the middle NADAC price of the 2 other products CMS averages under .+ \(\$0\.02 per EA\), so the Part D average may mostly describe those products, not this one\.$/);
  assert.equal(nameOutlier(rows[0], ctx), null, 'the cheap product is not flagged (one direction only)');
  assert.equal(nameOutlier(rows[3]), null, 'no context, no caveat');
  assert.equal(nameOutlier(rows[3], partDNameContext([rows[3], rows[4]])), null, 'no other product to compare');
  const sp = spreadForRow(rows[3], ctx);
  assert.equal(sp.name_outlier, o.text);
  assert.ok(sp.record.reason.includes(`Estimated because: ${o.text}`), 'the first caveat');
  assert.equal(spreadForRow(rows[3]).name_outlier, null);
  const s = summarizeProduct([rows[3], rows[4]], 30, { partDContext: ctx });
  assert.deepEqual([...s.spread.name_outliers], [o.text]);
  assert.deepEqual([...summarizeProduct([rows[3], rows[4]], 30).spread.name_outliers], []);
  // Just under the factor: no caveat.
  assert.equal(nameOutlier(cheap('DEAR', '90001000301', 0.399), partDNameContext([...rows.slice(0, 3), cheap('DEAR', '90001000301', 0.399)])), null);
});

test('spreadForRow: Part D is always estimated with the caveats, quoting the Part D reason', () => {
  const s = spreadForRow(METFORMIN);
  assert.equal(s.kind, 'part_d');
  assert.equal(s.record.state, 'estimated');
  assert.equal(s.record.value, 4.900068918);
  assert.equal(s.sentence, 'Medicare paid 4.9× what pharmacies pay.');
  const reason = s.record.reason;
  assert.match(reason, /every strength and form sold under “Metformin Hcl” into one figure/);
  assert.match(reason, /covers 2024-01-01 to 2024-12-31; the NADAC price is from the file of 2026-10-14/);
  assert.ok(reason.includes(`Part D spending basis, as the Part D record states it: ${METFORMIN.part_d.avg_per_unit.reason}`));
  assert.ok(!reason.includes(PART_D_BLANK_FLAG_NOTE));
  assert.ok(spreadForRow(SERTRALINE).record.reason.includes(PART_D_BLANK_FLAG_NOTE), 'blank flag repeated on the spread');
  // Even a Part D figure per the same unit with a single maker is estimated.
  assert.equal(spreadForRow(FIXTULIN).record.state, 'estimated');
  assert.equal(spreadForRow(FIXTULIN).sentence, 'Medicare paid 1.3× what pharmacies pay.');
  assert.equal(spreadForRow(LEVO).missing, true);
  assert.equal(spreadForRow(APAP).missing, true);
});

// Contract: "Any estimated spread at or above 20× or at or below 0.2× also carries the caveat that
// the two figures may not describe the same unit or product. The number is shown, never hidden."
test('spread: an estimated spread ≥ 20× or ≤ 0.2× carries the extreme-gap caveat; derived ones do not', () => {
  const withAvg = (v) => {
    const r = clone(METFORMIN);
    r.part_d.avg_per_unit.value = v;
    return spreadForRow(r).record;
  };
  const caveat = /the two figures may not describe the same unit or product/;
  // NADAC is $0.01451: 0.2902 / 0.01451 = 20 exactly; 0.002902 / 0.01451 = 0.2 exactly.
  assert.equal(withAvg(0.2902).value, 20);
  assert.match(withAvg(0.2902).reason, caveat);
  assert.match(withAvg(0.2902).reason, /At 20\.0×, the Medicare figure is 20 or more times what pharmacies pay\. A gap that large means the two figures may not describe the same unit or product, or the price may have changed between their dates;/);
  assert.match(withAvg(0.002902).reason, /At 0\.20×, the Medicare figure is 0\.2 times what pharmacies pay or less\. A gap that large/);
  assert.doesNotMatch(withAvg(0.29).reason, caveat); // 19.99×
  assert.equal(withAvg(0.002902).value, 0.2);
  assert.match(withAvg(0.002902).reason, caveat);
  assert.doesNotMatch(withAvg(0.00291).reason, caveat); // 0.2005×
  assert.match(withAvg(2.6118).reason, caveat); // 180×
  assert.equal(withAvg(2.6118).value, 180, 'the number is still given');
  assert.doesNotMatch(spreadForRow(METFORMIN).record.reason, caveat);
  // Derived (single-labeler Part B) spreads are not given the caveat.
  const big = clone(FIXTUMAB);
  big.nadac.value = 7; // 151.25 / 7 = 21.6×
  const d = spreadForRow(big).record;
  assert.equal(d.state, 'derived');
  assert.doesNotMatch(d.reason, caveat);
  // A shared Part B code is estimated, so it is.
  const small = clone(ONDANSETRON);
  small.nadac.value = 0.6; // 0.12 / 0.6 = 0.2×
  assert.match(spreadForRow(small).record.reason, caveat);
  // Directly: an estimated input makes the spread estimated, and the caveat follows.
  const s = spread(METFORMIN.nadac, { ...METFORMIN.part_d.avg_per_unit, value: 1, state: 'estimated' }, { comparable: true });
  assert.equal(s.state, 'estimated');
  assert.match(s.reason, caveat);
});

test('spread: different units force estimated; bad calls throw', () => {
  const s = spread(METFORMIN.nadac, { ...METFORMIN.part_d.avg_per_unit, per: 'ML' }, { comparable: true });
  assert.equal(s.state, 'estimated');
  assert.match(s.reason, /per ML but NADAC is per EA/);
  assert.throws(() => spread(METFORMIN.nadac, METFORMIN.part_d.avg_per_unit, {}), /comparable/);
  assert.throws(() => spread(METFORMIN.nadac, METFORMIN.part_d.avg_per_unit, { comparable: false }), /caveat/);
  assert.throws(() => spread(METFORMIN.nadac, { ...METFORMIN.part_d.claims }, { comparable: true }), /kind usd/);
});

test('describeSpread thresholds and wording', () => {
  assert.equal(describeSpread(4.9), 'Medicare paid 4.9× what pharmacies pay.');
  assert.equal(describeSpread(4.9, { tense: 'present' }), 'Medicare pays 4.9× what pharmacies pay.');
  assert.equal(describeSpread(167.2), 'Medicare paid 167× what pharmacies pay.');
  assert.equal(describeSpread(1.05), 'Medicare paid 1.1× what pharmacies pay.');
  assert.equal(describeSpread(1.0499), 'Medicare paid about what pharmacies pay.');
  assert.equal(describeSpread(1), 'Medicare paid about what pharmacies pay.');
  assert.equal(describeSpread(0.95), 'Medicare paid about what pharmacies pay.');
  assert.equal(describeSpread(0.9499), 'Medicare paid 5% less than pharmacies pay.');
  assert.equal(describeSpread(0.92), 'Medicare paid 8% less than pharmacies pay.');
  assert.equal(describeSpread(0.925), 'Medicare paid 8% less than pharmacies pay.'); // 7.5% half-up, exact
  assert.equal(describeSpread(0.24, { tense: 'present' }), 'Medicare pays 76% less than pharmacies pay.');
  assert.equal(describeSpread(0.004), 'Medicare paid less than 1% of what pharmacies pay.');
  assert.equal(describeSpread({ value: 4.9 }), 'Medicare paid 4.9× what pharmacies pay.');
  for (const bad of [0, -1, NaN, null, undefined, '4.9', {}]) assert.throws(() => describeSpread(bad), TypeError, String(bad));
});

test('describeSpreadRange', () => {
  assert.equal(describeSpreadRange(4.9, 4.94), 'Medicare paid 4.9× what pharmacies pay.');
  assert.equal(describeSpreadRange(2.1, 4.9), 'Medicare paid between 2.1× and 4.9× what pharmacies pay, depending on the NDC.');
  assert.equal(describeSpreadRange(0.97, 1.02, { tense: 'present' }), 'Medicare pays about what pharmacies pay.');
  assert.equal(describeSpreadRange({ value: 0.92 }, { value: 4.9 }), 'Medicare paid between 0.92× and 4.9× what pharmacies pay, depending on the NDC.');
});

test('freshness: NADAC by file date, 14-day threshold', () => {
  const rec = METFORMIN.nadac;
  const f = freshness(rec, SOURCE_INFO.nadac, '2026-10-17');
  assert.deepEqual({ stale: f.stale, age_days: f.age_days, date: f.date, basis: f.basis }, { stale: false, age_days: 3, date: '2026-10-14', basis: 'as_of_date' });
  assert.equal(f.message, 'CMS NADAC file dated 2026-10-14: 3 days old. New CMS NADAC files come out every week.');
  assert.equal(freshness(rec, SOURCE_INFO.nadac, '2026-10-28').stale, false); // exactly 14 days
  const s = freshness(rec, SOURCE_INFO.nadac, '2026-10-29');
  assert.equal(s.stale, true);
  assert.equal(s.age_days, 15);
  assert.match(s.message, /^Stale: CMS NADAC file dated 2026-10-14 is 15 days old, past the 14 days/);
  assert.equal(freshness(rec, SOURCE_INFO.nadac, '2026-10-15').message, 'CMS NADAC file dated 2026-10-14: 1 day old. New CMS NADAC files come out every week.');
  // Falls back to effective_date without as_of_date, and says so.
  const { as_of_date, ...noAsOf } = rec;
  const fb = freshness(noAsOf, SOURCE_INFO.nadac, '2026-10-17');
  assert.equal(fb.date, '2026-09-23');
  assert.equal(fb.age_days, 24);
  assert.match(fb.message, /effective 2026-09-23 \(no file date given\)/);
});

// effective_date is the START of period data; age counts from the Part B quarter start and the
// Part D data-year end, never from effective_date.
test('freshness: Part D from the end of the data year, Part B from the start of the quarter', () => {
  const pd = METFORMIN.part_d.avg_per_unit;
  assert.equal(pd.effective_date, '2024-01-01');
  const d = freshness(pd, SOURCE_INFO.partd, '2026-10-17');
  assert.equal(d.date, '2024-12-31');
  assert.equal(d.age_days, 655);
  assert.equal(d.stale, false);
  assert.equal(d.message, 'Medicare Part D data year ending 2024-12-31: 655 days old. New Medicare Part D files come out once a year.');
  assert.equal(freshness(pd, SOURCE_INFO.partd, '2027-07-03').stale, true); // 914 days
  assert.equal(freshness(pd, SOURCE_INFO.partd, '2027-07-02').stale, false); // exactly 913
  const pl = ONDANSETRON.part_b.payment_limit;
  const b = freshness(pl, SOURCE_INFO.asp_limits, '2026-10-17');
  assert.equal(b.date, '2026-10-01');
  assert.equal(b.age_days, 16);
  assert.equal(b.stale, false);
  assert.match(b.message, /^Medicare Part B quarter starting 2026-10-01: 16 days old/);
  assert.equal(freshness(pl, SOURCE_INFO.asp_limits, '2027-01-09').stale, false); // exactly 100
  assert.equal(freshness(pl, SOURCE_INFO.asp_limits, '2027-01-10').stale, true);
  assert.equal(freshness(ONDANSETRON.part_b.bill_units_per_package, SOURCE_INFO.asp_crosswalk, '2026-10-17').age_days, 16);
  // `sources` entries work too.
  assert.equal(freshness(FIXTURE.sources.nadac, SOURCE_INFO.nadac, '2026-10-17').age_days, 3);
  assert.equal(freshness(FIXTURE.sources.partd, SOURCE_INFO.partd, '2026-10-17').date, '2024-12-31');
  assert.equal(freshness(FIXTURE.sources.asp_limits, SOURCE_INFO.asp_limits, '2026-10-17').date, '2026-10-01');
});

test('freshness: a date after today counts as 0 days and is never stale', () => {
  const future = freshness({ ...METFORMIN.nadac, as_of_date: '2026-10-20' }, SOURCE_INFO.nadac, '2026-10-17');
  assert.equal(future.age_days, 0);
  assert.equal(future.stale, false);
  assert.equal(future.date, '2026-10-20');
  assert.match(future.message, /0 days old\. The date is after today \(2026-10-17\)/);
  // A viewer a day behind UTC, on the first day of the quarter.
  const early = freshness(ONDANSETRON.part_b.payment_limit, SOURCE_INFO.asp_limits, '2026-09-30');
  assert.deepEqual([early.age_days, early.stale], [0, false]);
});

test('freshness: no usable date is reported, not hidden; bad today throws', () => {
  const { period, ...noPeriod } = ONDANSETRON.part_b.payment_limit;
  const f = freshness(noPeriod, SOURCE_INFO.asp_limits, '2026-10-17');
  assert.equal(f.stale, true);
  assert.equal(f.age_days, null);
  assert.match(f.message, /can’t tell how old/);
  // Part D without its period is not aged from effective_date, which is the period start.
  const { period: p2, ...pdNoPeriod } = METFORMIN.part_d.avg_per_unit;
  assert.equal(freshness(pdNoPeriod, SOURCE_INFO.partd, '2026-10-17').age_days, null);
  assert.throws(() => freshness(METFORMIN.nadac, SOURCE_INFO.nadac, '2026-02-30'), RangeError);
  assert.throws(() => freshness(METFORMIN.nadac, undefined, '2026-10-17'), /SOURCE_INFO/);
});

// Real FDA NDC Directory package descriptions, copied from data/drugs.json (identity,
// package_description) on 2026-10-17. The expected amounts were worked out by hand from the text:
// the counts multiply down the levels to the innermost mL or g.
const REAL_PACKAGES = [
  // [unit, description, expected amount per NDC or null]
  ['ML', '1 SYRINGE in 1 CARTON (59148-102-80) / 2.4 mL in 1 SYRINGE', 2.4],
  ['ML', '1 VIAL, GLASS in 1 CARTON (0024-5927-00) / 10 mL in 1 VIAL, GLASS', 10],
  ['ML', '5 SYRINGE in 1 CARTON (72572-422-05) / 3 mL in 1 SYRINGE', 15],
  ['ML', '10 SYRINGE in 1 CARTON (70710-1762-6) / .8 mL in 1 SYRINGE (70710-1762-2)', 8],
  ['ML', '2 CARTON in 1 CARTON (78206-184-01) / 1 SYRINGE in 1 CARTON (78206-184-99) / .8 mL in 1 SYRINGE', 1.6],
  ['ML', '75 mL in 1 BOTTLE (65862-535-75)', 75],
  ['ML', '100 mL in 1 BOTTLE (57237-035-01)', 100],
  ['ML', '237 mL in 1 BOTTLE (16571-111-24)', 237],
  ['ML', '1 BOTTLE in 1 CARTON (16714-030-01) / 118 mL in 1 BOTTLE', 118],
  ['ML', '1 BOTTLE, PLASTIC in 1 BOX (83324-155-04) / 118 mL in 1 BOTTLE, PLASTIC', 118],
  ['ML', '1 BOTTLE, GLASS in 1 CARTON (31722-136-31) / 112 mL in 1 BOTTLE, GLASS', 112],
  ['ML', '1 BOTTLE, DROPPER in 1 CARTON (11980-228-10) / 10 mL in 1 BOTTLE, DROPPER', 10],
  ['ML', '1 BOTTLE in 1 CARTON (70710-1165-6) / 60 mL in 1 BOTTLE', 60],
  ['ML', '25 VIAL, MULTI-DOSE in 1 TRAY (68001-542-60) / 1 mL in 1 VIAL, MULTI-DOSE (68001-542-59)', 25],
  ['ML', '1 POUCH in 1 CARTON (0378-8270-52) / 25 AMPULE in 1 POUCH (0378-8270-62) / 3 mL in 1 AMPULE', 75],
  ['ML', '5 POUCH in 1 CARTON (0378-7057-52) / 5 VIAL in 1 POUCH (0378-7057-98) / 3 mL in 1 VIAL', 75],
  ['ML', '30 POUCH in 1 CARTON (0487-0301-01) / 1 VIAL, SINGLE-DOSE in 1 POUCH / 3 mL in 1 VIAL, SINGLE-DOSE', 90],
  ['ML', '6 POUCH in 1 CARTON (0093-6816-73) / 5 VIAL, SINGLE-DOSE in 1 POUCH (0093-6816-45) / 2 mL in 1 VIAL, SINGLE-DOSE (0093-6816-19)', 60],
  ['ML', '96 CARTON in 1 CARTON (42571-132-52) / 1 TRAY in 1 CARTON / 8 AMPULE in 1 TRAY / 5 mL in 1 AMPULE (42571-132-21)', 3840],
  ['ML', '2 PACKAGE in 1 CARTON (0169-1912-02) / 1 CONTAINER in 1 PACKAGE (0169-1912-12) / 1 SYRINGE, GLASS in 1 CONTAINER / .6 mL in 1 SYRINGE, GLASS', 1.2],
  ['ML', '4 L in 1 BOTTLE, PLASTIC (24338-236-01)', 4000],
  ['ML', '4 L in 1 JUG (64380-769-21)', 4000],
  ['GM', '1 TUBE in 1 CARTON (70000-0555-3) / 150 g in 1 TUBE', 150],
  ['GM', '226.8 g in 1 JAR (0536-1061-39)', 226.8],
  ['GM', '453.6 g in 1 JAR (0168-0015-16)', 453.6],
  ['GM', '60 TUBE in 1 CARTON (71656-086-60) / 60 g in 1 TUBE', 3600],
  ['GM', '1 TUBE, WITH APPLICATOR in 1 CARTON (0093-3541-43) / 42.5 g in 1 TUBE, WITH APPLICATOR', 42.5],
  ['GM', '1 TUBE in 1 CARTON (70677-1217-1) / 28.4 g in 1 TUBE', 28.4],
  ['GM', '1 TUBE in 1 CARTON (62559-299-15) / 15 g in 1 TUBE', 15],
  ['GM', '1 CAN in 1 CARTON (43538-530-10) / 100 g in 1 CAN', 100],
  ['GM', '1 TUBE in 1 CARTON (0168-0357-55) / 5 g in 1 TUBE (0168-0357-05)', 5],
  // No single amount in mL or g: metered sprays and inhalers, kits.
  ['ML', '1 BOTTLE, SPRAY in 1 CARTON (46122-385-76) / 120 SPRAY, METERED in 1 BOTTLE, SPRAY', null],
  ['ML', '1 BOTTLE, SPRAY in 1 PACKAGE (0113-1720-11) / 60 SPRAY, METERED in 1 BOTTLE, SPRAY', null],
  ['GM', '1 INHALER in 1 CARTON (0173-0716-20) / 120 AEROSOL, METERED in 1 INHALER', null],
  ['GM', '1 CARTRIDGE in 1 CARTON (0597-0100-61) / 60 SPRAY, METERED in 1 CARTRIDGE', null],
  ['ML', '1 KIT in 1 KIT (50419-773-01) * 100 mL in 1 BOTTLE, GLASS * 100 mL in 1 BOTTLE, GLASS', null],
  ['GM', '1 KIT in 1 CARTON (0378-8688-35) * 5 g in 1 BOTTLE, PLASTIC * 20 g in 1 JAR', null],
];

test('packageAmount: real FDA package descriptions', () => {
  assert.ok(new Set(REAL_PACKAGES.map((x) => x[1])).size >= 36, 'distinct descriptions');
  for (const [unit, desc, want] of REAL_PACKAGES) {
    const got = packageAmount(desc);
    if (want === null) assert.equal(got, null, desc);
    else assert.deepEqual(got, { amount: want, unit }, desc);
  }
  // Units that disagree with NADAC's are still read as what they say.
  assert.deepEqual(packageAmount('148 mL in 1 BOTTLE (35573-454-91)'), { amount: 148, unit: 'ML' });
  assert.deepEqual(packageAmount('212 g in 1 BOTTLE, PUMP (0536-1268-12)'), { amount: 212, unit: 'GM' });
});

test('packageAmount: anything that is not one plain chain gives null', () => {
  for (const bad of [
    null,
    undefined,
    '',
    '   ',
    42,
    '60 TABLET, FILM COATED in 1 BOTTLE, PLASTIC (0003-0894-21)', // a count, not mL or g
    '5 SYRINGE in 2 CARTON (0000-0000-00) / 3 mL in 1 SYRINGE', // in more than one container
    '5 SYRINGE in 1 CARTON (0000-0000-00) / 3 mL in 1 VIAL', // the chain does not connect
    '1,000 mL in 1 BAG (0000-0000-00)', // a separator OpenBill does not guess at
    '3 mg in 1 VIAL',
    '0 mL in 1 VIAL',
    'mL in 1 VIAL',
  ]) {
    assert.equal(packageAmount(bad), null, String(bad));
  }
  assert.deepEqual(packageAmount('1 VIAL in 1 CARTON (90012-001-10) / 10 mL in 1 VIAL'), { amount: 10, unit: 'ML' });
  assert.deepEqual(packageAmount('0.4 mL in 1 SYRINGE'), { amount: 0.4, unit: 'ML' });
});

function product(rows) {
  return groupProducts(rows)[0];
}

test('defaultQuantity: 30 per EA; one package per ML or GM when every listed NDC agrees', () => {
  const ea = defaultQuantity(product(rowsNamed('METFORMIN')));
  assert.deepEqual({ ...ea }, { qty: 30, unit: 'EA', reason: ea.reason });
  assert.match(ea.reason, /per EA \(each tablet, capsule or other single unit\)\. The card starts at 30, a common one-month supply/);
  assert.ok(Object.isFrozen(ea));
  const ond = defaultQuantity(product(rowsNamed('ONDANSETRON')));
  assert.deepEqual([ond.qty, ond.unit], [2, 'ML']);
  assert.match(ond.reason, /gives 2 mL in one package for this product’s NDC \(“2 mL in 1 VIAL \(90006-004-10\)”\), so the card starts at one package: 2 ML\./);
  assert.deepEqual([defaultQuantity(product([FIXTULIN])).qty, defaultQuantity(product([AMOX])).qty, defaultQuantity(product([FIXTUMAB])).qty], [10, 50, 4]);
  // Grams; and the rows array works as well as a product.
  const gm = clone(AMOX);
  gm.unit = 'GM';
  gm.identity.package_description = '1 TUBE in 1 CARTON (90009-001-50) / 45 g in 1 TUBE';
  assert.deepEqual([defaultQuantity([gm]).qty, defaultQuantity([gm]).unit], [45, 'GM']);
  // Several NDCs that agree; NDCs without an identity do not count against it.
  const a = clone(FIXTULIN);
  const b = clone(FIXTULIN);
  b.ndc = '90012000111';
  b.identity.package_description = '1 CARTON in 1 CARTON (90012-001-11) / 1 VIAL in 1 CARTON / 10 mL in 1 VIAL';
  const c = clone(FIXTULIN);
  c.ndc = '90012000112';
  c.identity = null;
  const agree = defaultQuantity([a, b, c]);
  assert.equal(agree.qty, 10);
  assert.match(agree.reason, /for the 2 of this product’s 3 NDCs it lists/);
  assert.match(defaultQuantity([a, b]).reason, /for all 2 NDCs of this product/);
});

test('defaultQuantity: otherwise 1, with the reason', () => {
  const none = defaultQuantity(product([HEPARIN]));
  assert.deepEqual([none.qty, none.unit], [1, 'ML']);
  assert.match(none.reason, /None of this product’s NDCs is in the FDA NDC Directory.+ So the card starts at 1 ML; change it to match your prescription\./);
  const a = clone(FIXTULIN);
  const b = clone(FIXTULIN);
  b.ndc = '90012000111';
  b.identity.package_description = '1 VIAL in 1 CARTON (90012-001-11) / 3 mL in 1 VIAL';
  const disagree = defaultQuantity([a, b]);
  assert.equal(disagree.qty, 1);
  assert.match(disagree.reason, /give different amounts \(3 mL, 10 mL\)/);
  const spray = clone(FIXTULIN);
  spray.identity.package_description = '1 BOTTLE, SPRAY in 1 CARTON (90012-001-10) / 120 SPRAY, METERED in 1 BOTTLE, SPRAY';
  const unread = defaultQuantity([spray]);
  assert.equal(unread.qty, 1);
  assert.match(unread.reason, /package description of NDC 90012-0001-10 \(“1 BOTTLE, SPRAY in 1 CARTON/);
  const grams = clone(FIXTULIN);
  grams.identity.package_description = '212 g in 1 BOTTLE, PUMP (90012-001-10)';
  assert.match(defaultQuantity([grams]).reason, /does not give one amount in mL/);
  const huge = clone(FIXTULIN);
  huge.identity.package_description = '10 L in 1 BOTTLE (90012-001-10)';
  const h = defaultQuantity([huge]);
  assert.equal(h.qty, 1);
  assert.match(h.reason, /gives 10,000 mL per package, which is not a usable quantity/);
  const mixed = clone(METFORMIN);
  mixed.ndc = '90001000102';
  mixed.unit = 'GM';
  const m = defaultQuantity([METFORMIN, mixed]);
  assert.deepEqual([m.qty, m.unit], [1, null]);
  assert.match(m.reason, /priced per different units \(EA, GM\)/);
  assert.throws(() => defaultQuantity([]), /at least one row/);
  assert.throws(() => defaultQuantity(null), /at least one row/);
});

test('defaultQuantity is pure', () => {
  const rows = rowsNamed('ONDANSETRON');
  const before = JSON.stringify(rows);
  assert.deepEqual(defaultQuantity(rows), defaultQuantity(rows));
  assert.equal(JSON.stringify(rows), before);
});

test('summarizeProduct: two NDCs with different NADAC values, one with Part D', () => {
  const s = summarizeProduct(rowsNamed('METFORMIN'), 60);
  assert.equal(s.name, 'METFORMIN HCL 500 MG TABLET');
  assert.equal(s.unit, 'EA');
  assert.deepEqual(s.ndcs, ['90001000101', '90002000201']);
  assert.equal(s.nadac.min.value, 0.01451);
  assert.equal(s.nadac.max.value, 0.016);
  assert.equal(s.nadac.records.length, 2);
  assert.equal(s.nadac.same, false);
  assert.equal(s.nadac.state, 'filed');
  assert.equal(s.pack.qty, 60);
  assert.equal(s.pack.min.value, 0.87);
  assert.equal(s.pack.max.value, 0.96);
  assert.equal(s.pack.min.state, 'filed', 'a pack total keeps the unit price state');
  assert.equal(s.pack.min.source_name, 'CMS NADAC');
  assert.equal(s.reference.kind, 'part_d');
  assert.deepEqual(s.reference.ndcs, ['90001000101']);
  assert.equal(s.reference.without.length, 1);
  assert.equal(s.reference.without[0].ndc, '90002000201');
  assert.match(s.reference.without[0].reason, /No Medicare reference price/);
  assert.equal(s.reference.alternate, null);
  assert.equal(s.spread.state, 'estimated');
  assert.equal(s.spread.range.min.value, 4.900068918);
  assert.equal(s.spread.sentence, 'Medicare paid 4.9× what pharmacies pay.');
  assert.equal(s.coinsurance, null);
  assert.equal(s.generic_nadac, null);
  assert.deepEqual(s.names, { proprietary: ['Metformin Hydrochloride'], nonproprietary: ['metformin hydrochloride'] });
  assert.deepEqual(s.explanation_codes, ['1', '5']);
  assert.equal(s.otc, false);
  assert.deepEqual(s.default_quantity, defaultQuantity(rowsNamed('METFORMIN')));
  assert.deepEqual(s.counts, {
    rows: 2,
    with_identity: 1,
    with_part_b: 0,
    with_part_d: 1,
    with_reference: 1,
    with_spread: 1,
    carried_forward: 0,
    part_d_outliers: 0,
    part_d_outlier_flag_blank: 0,
  });
  assert.deepEqual(
    s.freshness_inputs.map((f) => f.source),
    ['nadac', 'partd'],
  );
  for (const f of s.freshness_inputs) assert.equal(typeof freshness(f.record, SOURCE_INFO[f.source], '2026-10-17').stale, 'boolean');
  assert.equal(s.per_ndc.length, 2);
  assert.equal(s.per_ndc[1].reference.missing, true);
  assert.equal(s.per_ndc[0].alternate_spread, null);
});

test('summarizeProduct: Part B products, both references, a brand, and products with nothing', () => {
  const b = summarizeProduct(rowsNamed('ONDANSETRON'), 2);
  assert.equal(b.reference.kind, 'part_b');
  assert.equal(b.reference.tense, 'present');
  assert.equal(b.reference.range.min.value, 0.12);
  assert.equal(b.spread.state, 'estimated', 'two labelers share J2405');
  assert.equal(b.spread.sentence, 'Medicare pays 76% less than pharmacies pay.');
  assert.equal(b.coinsurance.min.value, 0.012);
  assert.equal(b.pack.min.value, 1);
  assert.equal(b.pack.same, true);
  assert.deepEqual(b.freshness_inputs.map((f) => f.source), ['nadac', 'asp_limits', 'asp_crosswalk']);
  assert.deepEqual([b.default_quantity.qty, b.default_quantity.unit], [2, 'ML']);

  const x = summarizeProduct(rowsNamed('FIXTUMAB'), 4);
  assert.equal(x.spread.state, 'derived');
  assert.equal(x.spread.sentence, 'Medicare pays 3.0× what pharmacies pay.');
  assert.equal(x.pack.min.value, 200);

  const both = summarizeProduct(rowsNamed('FIXTULIN'), 10);
  assert.equal(both.reference.kind, 'part_d');
  assert.equal(both.reference.range.min.value, 5);
  assert.equal(both.reference.alternate.kind, 'part_b');
  assert.equal(both.reference.alternate.range.min.value, 6);
  assert.deepEqual(both.reference.alternate.ndcs, ['90012000110']);
  assert.equal(both.per_ndc[0].alternate_spread.record.value, 1.5);
  assert.equal(both.per_ndc[0].alternate_spread.record.state, 'derived', 'one labeler');
  assert.equal(both.spread.sentence, 'Medicare paid 1.3× what pharmacies pay.');
  assert.deepEqual(both.freshness_inputs.map((f) => f.source), ['nadac', 'partd', 'asp_limits', 'asp_crosswalk']);

  const e = summarizeProduct(rowsNamed('ELIQUIS'), 60);
  assert.equal(e.generic_nadac.min.value, 0.81234);
  assert.equal(e.spread.sentence, 'Medicare paid 1.1× what pharmacies pay.');
  assert.equal(e.pack.min.value, 592.59);

  const a = summarizeProduct(rowsNamed('ACETAMINOPHEN'), 100);
  assert.equal(a.otc, true);
  assert.equal(a.reference.missing, true);
  assert.equal(a.spread.missing, true);
  assert.match(a.reference.reason, /Part D: .+ Part B: /);
  assert.equal(a.pack.min.value, 2.21);

  const t = summarizeProduct(rowsNamed('TESTOSTERONE'), 1);
  assert.equal(t.reference.missing, true);
  assert.match(t.reference.reason, /could not be matched/);
  assert.equal(t.coinsurance.min.value, 0.02);

  const l = summarizeProduct(rowsNamed('LEVOTHYROXINE'), 30);
  assert.equal(l.counts.part_d_outliers, 1);
  assert.match(l.reference.reason, /outlier/);

  const z = summarizeProduct(rowsNamed('SERTRALINE'), 30);
  assert.equal(z.counts.part_d_outlier_flag_blank, 1);
  assert.equal(z.reference.kind, 'part_d');
});

test('summarizeProduct: mixed Part D and Part B NDCs use Part D and list the other', () => {
  const pd = clone(METFORMIN);
  pd.unit = 'ML';
  pd.name = ONDANSETRON.name;
  pd.ndc = '90006000499';
  pd.nadac.per = 'ML';
  pd.part_d.avg_per_unit.per = 'ML';
  const s = summarizeProduct([pd, ONDANSETRON], 1);
  assert.equal(s.reference.kind, 'part_d');
  assert.deepEqual(s.reference.ndcs, ['90006000499']);
  assert.equal(s.reference.without[0].ndc, ONDANSETRON.ndc);
  assert.match(s.reference.without[0].reason, /only a Part B reference, which is not mixed with the Part D figures/);
  assert.equal(s.counts.with_reference, 2);
});

test('summarizeProduct: quantity problems and bad input', () => {
  const rows = rowsNamed('METFORMIN');
  assert.equal(summarizeProduct(rows).pack.missing, true);
  assert.equal(summarizeProduct(rows).pack.reason, 'No quantity entered.');
  assert.match(summarizeProduct(rows, 0).pack.reason, /greater than 0/);
  assert.match(summarizeProduct(rows, 'x').pack.reason, /not usable/);
  assert.equal(summarizeProduct(rows, '30').pack.qty, 30);
  assert.throws(() => summarizeProduct([]), /at least one row/);
  assert.throws(() => summarizeProduct([METFORMIN, APAP]), /one product/);
  // Duplicate identical records collapse; count keeps every row.
  const twin = clone(METFORMIN);
  twin.ndc = '90001000102';
  const s = summarizeProduct([METFORMIN, twin], 1);
  assert.equal(s.nadac.records.length, 1);
  assert.equal(s.nadac.count, 2);
  assert.equal(s.nadac.same, true);
  assert.equal(s.spread.sentence, 'Medicare paid 4.9× what pharmacies pay.');
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.counts) && Object.isFrozen(s.per_ndc));
});

// Review regression: 12 real products (e.g. MICONAZOLE 3 COMBO PACK: $0.41315 per GM and
// $7.427 per EA) mix NADAC units. Their NADAC "range" and pack totals compared EA with GM.
test('summarizeProduct: NDCs priced per different units give no cross-unit range or pack total', () => {
  const a = clone(METFORMIN);
  const b = clone(METFORMIN);
  b.ndc = '90001000102';
  b.unit = 'GM';
  b.nadac.per = 'GM';
  b.nadac.value = 0.5;
  b.part_d = null;
  const s = summarizeProduct([a, b], 30);
  assert.equal(s.unit, null);
  assert.deepEqual([...s.units], ['EA', 'GM']);
  assert.deepEqual([...s.nadac.units], ['EA', 'GM']);
  assert.equal(s.nadac.same, false);
  assert.equal(s.pack.missing, true);
  assert.match(s.pack.reason, /different units \(EA, GM\)/);
  assert.deepEqual([s.default_quantity.qty, s.default_quantity.unit], [1, null]);
  // one unit: units has one entry and pack totals are given
  const one = summarizeProduct([a], 30);
  assert.deepEqual([...one.nadac.units], ['EA']);
  assert.equal(one.nadac.same, true);
  assert.equal(one.pack.min.value, 0.44);
  // same value but different units is not "same"
  b.nadac.value = a.nadac.value;
  assert.equal(summarizeProduct([a, b], 30).nadac.same, false);
});

// Review regression: when the Part D brand and generic names are the same ("Metformin Hcl"),
// the caveat said 'sold under “Metformin Hcl” / “Metformin Hcl”'.
test('spreadForRow: the Part D caveat names a brand equal to its generic once', () => {
  const s = spreadForRow(METFORMIN);
  assert.match(s.record.reason, /sold under “Metformin Hcl” into one figure/);
  const r = clone(METFORMIN);
  r.part_d.brand_name = 'Glucophage';
  assert.match(spreadForRow(r).record.reason, /sold under “Glucophage” \/ “Metformin Hcl” into/);
});

// Every product of the real data, when it is schema v3: the rules never throw, every number is a
// valid record, no pack total is zero, and the derived/estimated split follows the contract.
test('summarizeProduct over every product in data/drugs.json (schema openbill.drugs/3)', (t) => {
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
  if (doc.schema !== 'openbill.drugs/3') {
    t.skip(`data/drugs.json is schema ${JSON.stringify(doc.schema)}, not openbill.drugs/3 yet`);
    return;
  }
  const products = groupProducts(linkRows(doc));
  let partB = 0;
  for (const p of products) {
    const s = summarizeProduct(p.rows, 1);
    const q = s.default_quantity;
    assert.equal(quantityProblem(q.qty), null, `${p.name}: default quantity ${q.qty}`);
    assert.ok(q.reason.length > 20, p.name);
    assert.equal(q.unit, s.unit, p.name);
    if (!s.pack.missing) for (const r of [s.pack.min, s.pack.max]) assert.ok(r.value > 0 && validateRecord(r).length === 0, p.name);
    for (const x of s.per_ndc) {
      if (x.spread.missing) continue;
      assert.deepEqual(validateRecord(x.spread.record), [], x.ndc);
      if (x.spread.kind === 'part_d') assert.equal(x.spread.record.state, 'estimated', x.ndc);
      if (x.spread.kind === 'part_b') {
        partB++;
        const ls = distinctLabelers(x.row.part_b.labelers);
        const single = Array.isArray(ls) && ls.length === 1;
        // The payment limit file's Notes say a "lesser of" or reference add-on limit is not the
        // single labeler's own price, so those stay estimated (review PARTB-8).
        const noted = /Notes column for this code: '[^']*(lesser of|reference add-on)/i.test(x.row.part_b.payment_limit.reason);
        assert.equal(x.spread.record.state, single && !noted ? 'derived' : 'estimated', x.ndc);
      }
      const v = x.spread.record.value;
      if (x.spread.record.state === 'estimated' && (v >= 20 || v <= 0.2)) {
        assert.match(x.spread.record.reason, /may not describe the same unit or product/, x.ndc);
        // Contract: the card does not lead with "Medicare paid 99% less" for it.
        assert.equal(x.spread.sentence, EXTREME_HEADLINE, x.ndc);
      } else {
        assert.notEqual(x.spread.sentence, EXTREME_HEADLINE, x.ndc);
      }
      if (s.spread.range && s.spread.range.records.includes(x.spread.record) && x.spread.extreme) assert.equal(s.spread.sentence, EXTREME_HEADLINE, p.name);
    }
  }
  assert.ok(products.length > 1000 && partB > 0, `${products.length} products, ${partB} Part B spreads`);
});

// Static checks over src/core: DOM-free, and the module conventions build.js relies on.
const CORE = new URL('../src/core/', import.meta.url);
const coreFiles = readdirSync(CORE).filter((f) => f.endsWith('.js'));

test('src/core is DOM-free and reads no clock or randomness', () => {
  assert.ok(coreFiles.length >= 11, coreFiles.join(', '));
  for (const f of coreFiles) {
    const src = readFileSync(new URL(f, CORE), 'utf8');
    assert.doesNotMatch(src, /\bwindow\b|\bdocument\b|localStorage|\bfetch\(|Date\.now|Math\.random/, f);
  }
});

test('src/core follows the bundler conventions', () => {
  for (const f of coreFiles) {
    const lines = readFileSync(new URL(f, CORE), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const where = `${f}:${i + 1}: ${line}`;
      if (/^\s*import\b/.test(line)) assert.match(line, /^import \{ [\w, ]+ \} from '\.\/[\w-]+\.js';$/, where);
      if (/^\s*export\b/.test(line)) assert.match(line, /^export (function|async function|const|class) \w/, where);
      assert.doesNotMatch(line, /\bexport default\b|^export \{|^export \*/, where);
    });
  }
});

// Review regression: HONESTY and STATE_INFO used typographic apostrophes (’) where the
// owner's brief and docs/ARCHITECTURE.md, which say "copy these rules verbatim", use '.
test('HONESTY lines and state summaries appear verbatim in docs/ARCHITECTURE.md', async () => {
  const { STATE_INFO } = await import('../src/core/provenance.js');
  const contract = readFileSync(new URL('../docs/ARCHITECTURE.md', import.meta.url), 'utf8');
  for (const h of HONESTY) assert.ok(contract.includes(`- ${h.markdown}\n`), h.markdown);
  for (const [state, info] of Object.entries(STATE_INFO)) {
    const line = info.summary[0].toLowerCase() + info.summary.slice(1);
    assert.ok(contract.includes(`- \`${state}\` — ${line}`) || contract.includes(`- \`${state}\` — ${info.summary}`), state);
  }
});

// Review regressions from running the rules over every real product (core-check, 2026-10-17).

// A derived Part B spread (ABILIFY ASIMTUFII, J0402) gave only the arithmetic and the inputs,
// so its reason never said why it was derived. The contract requires the reason "in substance
// for derived and estimated".
test('spread: a derived Part B spread says it is derived because one labeler bills under the code', () => {
  const s = spreadForRow(FIXTUMAB).record;
  assert.equal(s.state, 'derived');
  assert.match(
    s.reason,
    /= 3\.0×\. Derived because only one labeler, Fixture Biologics, Inc\., is listed for HCPCS J9990 on the CMS crosswalk, so the payment limit comes from that company’s own products under the code, not an average across companies\. Inputs:/,
  );
  // Estimated (shared) codes do not get that sentence.
  assert.doesNotMatch(spreadForRow(ONDANSETRON).record.reason, /Derived because/);
  // Nor do Part D spreads.
  assert.doesNotMatch(spreadForRow(METFORMIN).record.reason, /Derived because/);
});

// The Part B reference reason gave only the generic setting note; the code's own short
// description is what tells a reader the setting (J1817: "Insulin for insulin pump use").
test('referencePrice: a Part B reference quotes the code’s short description from the limit file, unless it is null (CPT)', () => {
  const b = referencePrice(FIXTUMAB);
  assert.equal(b.kind, 'part_b');
  assert.ok(b.reason.includes('The CMS payment limit file describes HCPCS J9990 as “Inj fixtumab, 10 mg (fixture)”.'), b.reason);
  assert.ok(b.reason.endsWith(PART_B_SETTING_NOTE));
  const alt = referencePrice(FIXTULIN).alternate;
  assert.ok(alt.reason.includes('describes HCPCS J1817 as “Insulin for insulin pump use (fixture)”'), alt.reason);
  const cpt = clone(FIXTUMAB);
  cpt.part_b.short_description = null;
  const c = referencePrice(cpt);
  assert.doesNotMatch(c.reason, /describes HCPCS/);
  assert.match(c.reason, /converted to dollars per ML for this NDC\. Medicare Part B pays/);
});

// ATORVASTATIN 20 MG TABLET listed the same "NADAC file dated 2026-10-14: 3 days old" input
// three times, once per NADAC effective date among its 69 NDCs.
test('summarizeProduct: one freshness input per date freshness() measures from', () => {
  const a = clone(METFORMIN);
  const b = clone(METFORMIN);
  b.ndc = '90001000102';
  b.nadac.effective_date = '2026-08-19';
  const s = summarizeProduct([a, b], 1);
  assert.deepEqual(s.freshness_inputs.map((f) => f.source), ['nadac', 'partd']);
  assert.equal(s.freshness_inputs[0].record.effective_date, '2026-09-23', 'the first NDC’s record');
  // A different file date is a different input.
  b.nadac.as_of_date = '2026-10-07';
  assert.deepEqual(summarizeProduct([a, b], 1).freshness_inputs.map((f) => [f.source, f.record.as_of_date || null]), [
    ['nadac', '2026-10-14'],
    ['partd', METFORMIN.part_d.avg_per_unit.as_of_date || null],
    ['nadac', '2026-10-07'],
  ]);
  // Without a file date, freshness() falls back to effective_date, so those stay distinct.
  delete a.nadac.as_of_date;
  delete b.nadac.as_of_date;
  assert.equal(summarizeProduct([a, b], 1).freshness_inputs.filter((f) => f.source === 'nadac').length, 2);
});

// "$4,284.54 (exactly $4284.544536 …)" mixed grouped and ungrouped figures in one sentence.
test('unitTotal: the exact total is written with thousands separators too', () => {
  const r = unitTotal({ ...METFORMIN.nadac, value: 1785.22689, per: 'ML' }, 2.4);
  assert.ok(r.reason.startsWith('2.4 × $1,785.22689 per ML, rounded to cents: $4,284.54 (exactly $4,284.544536, rounded half-up).'), r.reason);
});

// The other half of the quantity/per resolution: a package size with no unit never converts.
test('partBPerNadacUnit: a package size with no per (unit not stated) gives no Part B price', () => {
  const r = clone(FIXTUMAB);
  delete r.part_b.package_size.per;
  const b = partBPerNadacUnit(r);
  assert.equal(b.missing, true);
  assert.equal(b.reason, 'The Part B crosswalk does not state the unit of this NDC’s package size (J9990), so the payment limit cannot be converted to a price per ML.');
  assert.doesNotMatch(b.reason, /undefined/);
});

// ---------------------------------------------------------------------------------------------
// Review regressions, 2026-10-18 (NUM-2/UI-6/CORE-1/DOC-2, NUM-3/CORE-2/DOC-3, NUM-5, NUM-6,
// PARTB-8, PARTB-9).

// Contract: an extreme estimated spread's headline is EXTREME_HEADLINE, never "Medicare paid 99%
// less than pharmacies pay." (describeSpread's sentence); the multiple is still given.
test('spread: an extreme estimated spread leads with "These two figures may not measure the same thing"', () => {
  assert.equal(EXTREME_HEADLINE, 'These two figures may not measure the same thing');
  const withAvg = (v) => {
    const r = clone(METFORMIN);
    r.part_d.avg_per_unit.value = v;
    return r;
  };
  for (const v of [0.002902, 0.0001, 0.2902, 2.6118]) {
    const sp = spreadForRow(withAvg(v));
    assert.equal(sp.extreme, true, String(v));
    assert.equal(sp.sentence, EXTREME_HEADLINE, String(v));
    assert.equal(isExtremeSpread(sp.record), true);
    assert.doesNotMatch(sp.sentence, /less than|% less|what pharmacies pay/);
    const s = summarizeProduct([withAvg(v)], 30);
    assert.equal(s.spread.extreme, true);
    assert.equal(s.spread.sentence, EXTREME_HEADLINE);
    assert.ok(s.spread.range.min.value > 0, 'the multiple is still given');
  }
  // Just inside the limits: the plain sentence.
  assert.equal(spreadForRow(withAvg(0.00291)).sentence, 'Medicare paid 80% less than pharmacies pay.');
  assert.equal(spreadForRow(withAvg(0.29)).extreme, false);
  // A derived spread is not extreme, however large.
  const big = clone(FIXTUMAB);
  big.nadac.value = 7;
  const d = spreadForRow(big);
  assert.equal(d.record.state, 'derived');
  assert.equal(d.extreme, false);
  assert.equal(d.sentence, 'Medicare pays 21.6× what pharmacies pay.');
  // A range with one extreme end takes the headline.
  const ok = clone(METFORMIN);
  const bad = withAvg(0.002902);
  bad.ndc = '90001000199';
  const s = summarizeProduct([ok, bad], 30);
  assert.equal(s.spread.range.records.length, 2);
  assert.equal(s.spread.sentence, EXTREME_HEADLINE);
  // The rule's own text says so, so methodology.html states it.
  const rule = RULES.find((r) => r.id === 'extreme-gap');
  assert.ok(rule.description.includes(`“${EXTREME_HEADLINE}”`));
  assert.ok(rule.formula.includes(EXTREME_HEADLINE));
});

// Review follow-up (g): the thresholds are tested on the unrounded ratio, and the multiple the
// page shows must agree with them: a spread that does not take the extreme headline is never
// shown as 0.20×, 20.0× or beyond (KENALOG-40 200 MG/5 ML VIAL, ratio 0.2046, was "0.20×").
test('formatSpreadMultiple: no spread without the extreme headline is shown at a threshold', (t) => {
  assert.equal(formatSpreadMultiple(0.204590319), '0.205×');
  assert.equal(formatSpreadMultiple(19.97), '19.97×');
  assert.equal(formatSpreadMultiple(0.2), '0.20×');
  assert.equal(formatSpreadMultiple(20), '20.0×');
  assert.equal(formatSpreadMultiple(4.9), '4.9×');
  assert.equal(describeSpreadRange(0.5, 19.97), 'Medicare paid between 0.50× and 19.97× what pharmacies pay, depending on the NDC.');
  const path = new URL('../data/drugs.json', import.meta.url);
  const doc = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  if (!doc || doc.schema !== 'openbill.drugs/3') {
    t.skip('data/drugs.json (openbill.drugs/3) is not there');
    return;
  }
  const products = groupProducts(linkRows(doc));
  const looksExtreme = (shown) => shown.startsWith('<') || Number(shown.replace(/[×,]/g, '')) <= EXTREME_LOW || Number(shown.replace(/[×,]/g, '')) >= EXTREME_HIGH;
  let n = 0;
  for (const p of products) {
    for (const x of summarizeProduct(p.rows, 30).per_ndc) {
      for (const sp of [x.spread, x.alternate_spread]) {
        if (!sp || sp.missing) continue;
        n++;
        const shown = formatSpreadMultiple(sp.record.value);
        if (sp.record.state === 'estimated') assert.equal(looksExtreme(shown), isExtremeSpread(sp.record), `${p.name} ${x.ndc}: ${sp.record.value} shown ${shown}`);
      }
    }
  }
  assert.ok(n > 10000, `${n} spreads`);
});

// Contract: next to any calculated figure the card shows each input's own date or period,
// never the oldest date alone. deriveRecord keeps only the oldest, so the inputs are exposed.
test('inputDates: a spread lists each input with its own date or period', () => {
  const sp = spreadForRow(METFORMIN);
  assert.deepEqual(sp.inputs.map((x) => x.label), ['NADAC', 'Part D']);
  const dates = inputDates(sp.inputs);
  const n = METFORMIN.nadac;
  const d = METFORMIN.part_d.avg_per_unit;
  const [ps, pe] = d.period.split('/');
  assert.equal(dates[0].text, `NADAC eff. ${n.effective_date} (file of ${n.as_of_date}, retrieved ${n.retrieved_date})`);
  assert.equal(dates[1].text, `Part D ${ps} to ${pe} (${d.as_of_date ? `file of ${d.as_of_date}, ` : ''}retrieved ${d.retrieved_date})`);
  // The calculated record alone carries only one date per field.
  assert.equal(sp.record.effective_date, [n.effective_date, d.effective_date].sort()[0]);
  // The product summary carries the same, merged across NDCs.
  const s = summarizeProduct([METFORMIN], 30);
  assert.deepEqual(s.spread.inputs.map((x) => x.text), dates.map((x) => x.text));
  // Part B: the limit's quarter and the crosswalk's, and the reference itself is calculated too.
  const b = spreadForRow(FIXTUMAB);
  assert.deepEqual(inputDates(b.inputs).map((x) => x.label), ['NADAC', 'Part B limit', 'Part B crosswalk']);
  const sb = summarizeProduct([FIXTUMAB], 4);
  assert.deepEqual(sb.reference.inputs.map((x) => x.label), ['Part B limit', 'Part B crosswalk']);
  const lim = FIXTUMAB.part_b.payment_limit;
  assert.ok(sb.reference.inputs[0].text.startsWith(`Part B limit ${lim.period.replace('/', ' to ')}`), sb.reference.inputs[0].text);
  // Several effective dates are each listed; more than three are given as a span.
  const recs = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'].map((e) => ({ label: 'NADAC', record: { ...n, effective_date: e } }));
  assert.equal(inputDates(recs.slice(0, 2))[0].text, `NADAC eff. 2026-01-01, 2026-02-01 (file of ${n.as_of_date}, retrieved ${n.retrieved_date})`);
  assert.match(inputDates(recs)[0].text, /^NADAC eff\. between 2026-01-01 and 2026-04-01, 4 dates \(/);
  assert.throws(() => inputDates([{ label: 'NADAC', record: { ...n, source_url: 'javascript:alert(1)' } }]), /not a valid record/);
  assert.throws(() => inputDates([{ record: n }]), /label/);
});

// Review NUM-6: the Part B price per unit is kept to 10 decimals, so a pack total computed from
// it could fall just under a half cent. Raw NDC 00487-0301-01 (Nephron, J7613): limit $0.066
// per 1 MG, BILLUNITSPKG 19, PKG SIZE 3 mL, PKG QTY 30: 0.066 × 19 × 75 ÷ 90 = $1.045 exactly,
// which rounds half-up to $1.05 (the rounded per-unit figure gave 1.0449999975, so $1.04).
test('partBPackTotal: works from the filed inputs exactly before rounding to cents', () => {
  const r = clone(ONDANSETRON);
  r.part_b.payment_limit.value = 0.066;
  r.part_b.payment_limit.per = '1 MG';
  r.part_b.hcpcs_dosage = '1 MG';
  r.part_b.bill_units_per_package.value = 19;
  r.part_b.package_size.value = 3;
  r.part_b.package_qty.value = 30;
  const per = partBPerNadacUnit(r);
  assert.equal(per.value, 0.0139333333);
  assert.equal(unitTotal(per, 75).value, 1.04, 'the old path, from the rounded unit price');
  const t = partBPackTotal(r, 75);
  assert.equal(t.value, 1.05);
  assert.equal(formatMoney(t.value), '$1.05');
  assert.equal(t.state, per.state);
  assert.equal(t.source_url, per.source_url);
  assert.equal(t.per, '75 ML');
  assert.match(
    t.reason,
    /^75 ML × \$0\.066 per 1 MG \(J2405\) × 19 billing units per package ÷ \(3 ML × 30\) = \$94\.05 ÷ 90, worked out exactly and rounded half-up to cents: \$1\.05\. The price per unit: /,
  );
  assert.deepEqual(validateRecord(t), []);
  // The product summary's Medicare total uses it.
  const s = summarizeProduct([r], 75);
  assert.equal(s.reference.kind, 'part_b');
  assert.equal(s.reference.pack.min.value, 1.05);
  // Part D totals are unitTotal() of the filed average.
  const sd = summarizeProduct([METFORMIN], 60);
  assert.deepEqual(sd.reference.pack.min, unitTotal(METFORMIN.part_d.avg_per_unit, 60));
  assert.equal(summarizeProduct([METFORMIN]).reference.pack.missing, true);
  assert.equal(partBPackTotal(r, 'abc').missing, true);
  assert.equal(partBPackTotal(METFORMIN, 3).missing, true);
});

// Review NUM-5: a product priced per several units listed only four prices, and merged units.
test('rangesByUnit: one range per pricing unit, the most common unit first', () => {
  const a = clone(METFORMIN);
  const b = clone(METFORMIN);
  b.ndc = '90001000102';
  b.nadac.value = 0.02;
  const c = clone(METFORMIN);
  c.ndc = '90001000103';
  c.unit = 'GM';
  c.nadac.per = 'GM';
  c.nadac.value = 1.5;
  const g = rangesByUnit([a.nadac, b.nadac, c.nadac]);
  assert.deepEqual(
    g.map((x) => [x.unit, x.ndcs, x.range.min.value, x.range.max.value]),
    [
      ['EA', 2, 0.01451, 0.02],
      ['GM', 1, 1.5, 1.5],
    ],
  );
  const s = summarizeProduct([a, b, c], 30);
  assert.equal(s.pack.missing, true);
  assert.deepEqual(s.nadac_by_unit.map((x) => x.unit), ['EA', 'GM']);
});

// Review PARTB-8: a single-labeler code whose limit the payment limit file marks "lesser of" or
// as including a reference product add-on is not that company's own price, so not derived.
test('spread: a single-labeler Part B code noted "lesser of" or "reference add-on" is estimated', () => {
  for (const note of ['"lesser of" methodology applied', '8% of reference add-on applied', '"lesser of" methodology applied; 8% of reference add-on applied']) {
    const r = clone(FIXTUMAB);
    r.part_b.payment_limit.reason += ` Notes column for this code: '${note}'.`;
    const s = spreadForRow(r);
    assert.equal(s.record.state, 'estimated', note);
    assert.ok(s.record.reason.includes(`Notes for the code say “${note}”`), note);
    assert.doesNotMatch(s.record.reason, /Derived because/);
  }
  const other = clone(FIXTUMAB);
  other.part_b.payment_limit.reason += " Notes column for this code: 'Payment limit updated'.";
  assert.equal(spreadForRow(other).record.state, 'derived');
  // Extreme and noted: the caveat and the headline follow.
  const low = clone(FIXTUMAB);
  low.part_b.payment_limit.reason += " Notes column for this code: '8% of reference add-on applied'.";
  low.nadac.value = 1000;
  const sl = spreadForRow(low);
  assert.equal(sl.extreme, true);
  assert.match(sl.record.reason, /may not describe the same unit or product/);
});

// Review PARTB-9: oral and inhaled Part B drugs were told they are "given in a clinic".
test('partBSettingNote: oral, inhalation and other Part B codes get their own setting note', () => {
  assert.equal(partBSettingKind(FIXTUMAB), 'other');
  const oral = clone(FIXTUMAB);
  oral.identity.route = 'ORAL';
  assert.equal(partBSettingKind(oral), 'oral');
  assert.ok(referencePrice(oral).reason.endsWith(PART_B_SETTING_NOTES.oral));
  assert.equal(referencePrice(oral).setting_note, PART_B_SETTING_NOTES.oral);
  const desc = clone(FIXTUMAB);
  desc.identity = null;
  desc.part_b.short_description = 'Ondansetron hcl 8 mg oral';
  assert.equal(partBSettingKind(desc), 'oral');
  const inh = clone(FIXTUMAB);
  inh.identity.route = 'RESPIRATORY (INHALATION)';
  assert.equal(partBSettingKind(inh), 'inhalation');
  assert.ok(referencePrice(inh).reason.endsWith(PART_B_SETTING_NOTES.inhalation));
  assert.equal(PART_B_SETTING_NOTES.other, PART_B_SETTING_NOTE);
  assert.ok(referencePrice(FIXTUMAB).reason.endsWith(PART_B_SETTING_NOTE));
  for (const n of Object.values(PART_B_SETTING_NOTES)) assert.match(n, /Part D\.$/);
  assert.deepEqual(summarizeProduct([oral], 4).reference.setting_notes, [PART_B_SETTING_NOTES.oral]);
});
