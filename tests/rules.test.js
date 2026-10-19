import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import {
  RULES,
  HONESTY,
  DEFAULT_EA_QUANTITY,
  DEFAULT_EA_OTHER_QUANTITY,
  QUANTITY_CHIPS,
  eaForm,
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
  packageStart,
  WHOLESALE_MIN_UNITS,
  defaultQuantity,
  summarizeProduct,
  COST_PLUS,
  COST_PLUS_CAVEATS,
  PAID_MAX_USD,
  PAID_MAX_CHARS,
  PART_D_UNMATCHED_REASON,
  PAID_PRIVACY,
  costPlusEstimate,
  parsePaid,
  paidComparison,
} from '../src/core/rules.js';
import { validateRecord } from '../src/core/provenance.js';
import { SOURCE_INFO } from '../src/core/sources.js';
import { normalizeNdc } from '../src/core/ndc.js';
import { formatMoney, quantityProblem, divideMoney } from '../src/core/money.js';
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
    [
      'unit-total',
      'default-quantity',
      'reference-price',
      'part-b-per-nadac-unit',
      'part-b-coinsurance',
      'spread',
      'part-b-single-labeler',
      'extreme-gap',
      'part-d-name-outlier',
      'cost-plus',
      'what-you-paid',
      'freshness',
    ],
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
  // Decision 48: the rule says which EA products start at 30 and which at 1, and the buttons each gets.
  assert.ok(byId['default-quantity'].description.includes(`starts at ${DEFAULT_EA_OTHER_QUANTITY}, with buttons for 1, 2, 3`));
  assert.ok(byId['default-quantity'].description.includes('with buttons for 30, 60, 90'));
  assert.match(byId['default-quantity'].summary, /30 for an oral tablet or capsule priced per EA; 1 for anything else priced per EA/);
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
  assert.equal(b.part_d_reason, PART_D_UNMATCHED_REASON);
  assert.ok(b.reason.includes(PART_B_SETTING_NOTE));
  assert.equal(referencePrice(ONDANSETRON).kind, 'part_b');
  // Part B present but not convertible, no Part D: missing with both reasons, Part D first.
  const t = referencePrice(TESTOSTERONE);
  assert.equal(t.missing, true);
  assert.match(t.part_b_reason, /could not be matched/);
  assert.equal(t.part_d_reason, PART_D_UNMATCHED_REASON);
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

test('defaultQuantity: 30 per EA for an oral tablet or capsule; one package per ML or GM when every listed NDC agrees', () => {
  const ea = defaultQuantity(product(rowsNamed('METFORMIN')));
  assert.deepEqual({ ...ea }, { qty: 30, unit: 'EA', reason: ea.reason, chips: [30, 60, 90], form: ea.form });
  assert.equal(ea.chips, QUANTITY_CHIPS.oral);
  assert.equal(ea.reason, 'NADAC prices this product per EA, and the FDA NDC Directory lists 1 of its 2 NDCs (it does not list the other one) as an oral tablet (dosage form “TABLET”, route “ORAL”), so one EA is one tablet. The card starts at 30 tablets, a common one-month supply of a once-a-day medicine; change it to match your prescription.');
  assert.deepEqual(JSON.parse(JSON.stringify(ea.form)), {
    oral_solid: true,
    plain: true,
    some_oral: true,
    mouth: false,
    one: 'tablet',
    many: 'tablets',
    basis: 'fda',
    forms: ['TABLET'],
    routes: ['ORAL'],
    listed: 1,
    daily: { count: 1, forms: ['TABLET'], routes: ['ORAL'] },
    outliers: [],
    word: null,
  });
  assert.ok(Object.isFrozen(ea));
  assert.ok(Object.isFrozen(ea.form) && Object.isFrozen(ea.chips));
  const eliquis = defaultQuantity(product([ELIQUIS]));
  assert.match(eliquis.reason, /lists its NDC as an oral tablet \(dosage form “TABLET, FILM COATED”, route “ORAL”\)/);
  assert.equal(eliquis.qty, 30);
  const ond = defaultQuantity(product(rowsNamed('ONDANSETRON')));
  assert.deepEqual([ond.qty, ond.unit], [2, 'ML']);
  assert.match(ond.reason, /gives 2 mL in one package for this product’s NDC \(“2 mL in 1 VIAL \(90006-004-10\)”\), so the card starts at one package: 2 ML\./);
  assert.deepEqual([defaultQuantity(product([FIXTULIN])).qty, defaultQuantity(product([AMOX])).qty, defaultQuantity(product([FIXTUMAB])).qty], [10, 50, 4]);
  // ML and GM have no buttons and no EA form.
  assert.deepEqual([defaultQuantity(product([FIXTULIN])).chips, defaultQuantity(product([FIXTULIN])).form], [[], null]);
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

// ---- Phase 2: the cost-plus estimate and "what you were charged" ----

// The showcase's NADAC unit price (docs/ARCHITECTURE.md, "Showcase": ARIPIPRAZOLE 10 MG TABLET,
// 30 × $0.11173, NADAC eff. 2026-09-23), in a hand-made record: only the value is from the
// contract; the reason says so and the file name is the fixture's.
const SHOWCASE_NADAC = Object.freeze({
  value: 0.11173,
  kind: 'usd',
  state: 'filed',
  reason: 'The showcase NADAC price per EA quoted in docs/ARCHITECTURE.md; a test record, not read from a file here.',
  source_name: 'CMS NADAC',
  source_url: 'https://data.medicaid.gov/dataset/fbb83258-11c7-47f5-8b18-5f8e79f7e704',
  source_file: 'fixture-nadac-20261014.csv',
  effective_date: '2026-09-23',
  retrieved_date: '2026-10-17',
  as_of_date: '2026-10-14',
  per: 'EA',
});

test('COST_PLUS: the two parameters of the published method, where they come from, and no Cost Plus price', () => {
  assert.ok(Object.isFrozen(COST_PLUS));
  assert.deepEqual(Object.keys(COST_PLUS), ['markup_pct', 'fee_usd', 'basis', 'description', 'sources']);
  assert.equal(COST_PLUS.markup_pct, 15);
  assert.equal(COST_PLUS.fee_usd, 5);
  assert.equal(COST_PLUS.basis, 'per fill');
  assert.match(COST_PLUS.description, /15% markup/);
  assert.match(COST_PLUS.description, /The \$5\.00 fee is the one the company’s own website showed on 2026-10-18/);
  // The 2023 KFF article reports a lower fee than $5.00, so it is cited for the method only (H7).
  assert.match(COST_PLUS.description, /\(February 2023\) describes the same method, with a lower labor fee than today’s/);
  assert.match(COST_PLUS.description, /KFF Health News/);
  assert.match(COST_PLUS.description, /copies no price from Cost Plus Drugs/);
  assert.ok(Object.isFrozen(COST_PLUS.sources));
  assert.deepEqual(
    COST_PLUS.sources.map((s) => s.url),
    ['https://kffhealthnews.org/news/article/mark-cuban-cost-plus-drugs-pharma-industry', 'https://www.costplusdrugs.com/'],
  );
  for (const s of COST_PLUS.sources) {
    assert.ok(Object.isFrozen(s));
    assert.deepEqual(Object.keys(s), ['label', 'url']);
    assert.ok(s.label.trim());
    assert.match(s.url, /^https:\/\//);
  }
  // The only dollar figures anywhere in COST_PLUS are the $5.00 fee: no Cost Plus drug price,
  // and no "retail price at other pharmacies" figure.
  const text = JSON.stringify(COST_PLUS);
  assert.deepEqual([...new Set(text.match(/\$[\d,.]*\d/g))], ['$5.00']);
  assert.doesNotMatch(text, /retail price|typical cash price/i);
});

test('RULES cost-plus and what-you-paid: lay wording built from the constants, honest about what they are', () => {
  const byId = Object.fromEntries(RULES.map((r) => [r.id, r]));
  const cp = byId['cost-plus'];
  assert.equal(cp.title, 'Cost-plus estimate');
  for (const f of ['summary', 'formula', 'description']) {
    assert.match(cp[f], /15%/, f);
    assert.match(cp[f], /\$5\.00/, f);
    assert.match(cp[f], /shipping not included|shipping is not included/i, f);
  }
  assert.match(cp.description, /not a price any pharmacy quoted/);
  assert.match(cp.description, /Cost Plus Drugs’ own costs differ from NADAC/);
  assert.match(cp.description, /There is no spread against this estimate/);
  assert.match(cp.description, /always labelled estimated/);
  // The worked example is hypothetical and computed from COST_PLUS: $10.00 + $1.50 + $5.00.
  assert.match(cp.description, /if pharmacies pay \$10\.00 for a pack, the estimate is \$10\.00 \+ \$1\.50 \+ \$5\.00 = \$16\.50\./);
  const wp = byId['what-you-paid'];
  assert.ok(wp.description.includes(PAID_PRIVACY), 'the privacy sentence, as on the card');
  assert.match(PAID_PRIVACY, /browser’s history keeps it/, 'says the browser history keeps the amount (history.replaceState)');
  assert.doesNotMatch(wp.description, /never stores, logs or sends|kept only in/);
  assert.ok(wp.description.includes(formatMoney(PAID_MAX_USD)), 'the upper limit comes from PAID_MAX_USD');
  assert.match(wp.description, /your number/);
  for (const r of [cp, wp]) assert.doesNotMatch(`${r.summary} ${r.formula} ${r.description}`, /typical cash price|cash price is/i);
});

test('costPlusEstimate: the showcase, 30 × $0.11173 → $3.35 + $0.50 + $5.00 = $8.85, estimated, with NADAC’s file and dates', () => {
  const r = costPlusEstimate(SHOWCASE_NADAC, 30);
  assert.deepEqual(validateRecord(r), []);
  assert.ok(Object.isFrozen(r));
  assert.equal(r.value, 8.85);
  assert.equal(r.kind, 'usd');
  assert.equal(r.state, 'estimated');
  assert.equal(r.source_name, 'OpenBill calculation');
  assert.equal(r.source_url, 'methodology.html#cost-plus');
  assert.equal(r.source_file, SHOWCASE_NADAC.source_file);
  assert.equal(r.effective_date, '2026-09-23');
  assert.equal(r.retrieved_date, '2026-10-17');
  assert.equal(r.as_of_date, '2026-10-14');
  assert.equal(r.per, '30 EA');
  assert.equal(r.period, undefined);
  assert.ok(r.reason.startsWith(RULES.find((x) => x.id === 'cost-plus').summary), 'opens with the rule summary');
  assert.ok(
    r.reason.includes('30 × $0.11173 per EA = $3.35 (exactly $3.3519, rounded half-up to the cent), what pharmacies pay for the pack by NADAC; plus a 15% markup, $0.50; plus a $5.00 pharmacy fee per fill: $3.35 + $0.50 + $5.00 = $8.85.'),
    r.reason,
  );
  for (const c of COST_PLUS_CAVEATS) assert.ok(r.reason.includes(c), c);
  assert.match(r.reason, /a model, not a price any pharmacy quoted/);
  assert.match(r.reason, /Cost Plus Drugs’ own costs differ from NADAC/);
  assert.match(r.reason, /Shipping is not included/);
  assert.doesNotMatch(r.reason, /typical cash price/i);
  // Quantity as a string is the same.
  assert.equal(costPlusEstimate(SHOWCASE_NADAC, '30').value, 8.85);
});

test('costPlusEstimate: integer cents, each step rounded half-up', () => {
  const rec = (value, per = 'EA') => ({ ...SHOWCASE_NADAC, value, per });
  // A pack that is already whole cents: 60 × $0.01451 = $0.8706 → $0.87; 15% of 87¢ = 13.05¢ → 13¢.
  assert.equal(costPlusEstimate(rec(0.01451), 60).value, 6);
  // Markup exactly half a cent rounds up: 10¢ × 15% = 1.5¢ → 2¢; $0.10 + $0.02 + $5.00.
  assert.equal(costPlusEstimate(rec(0.01), 10).value, 5.12);
  // Pack exactly half a cent rounds up: 1 × $0.005 → 1¢; markup 0.15¢ → 0¢.
  assert.equal(costPlusEstimate(rec(0.005), 1).value, 5.01);
  // A pack under half a cent counts as $0.00: the estimate is the fee alone, and says why.
  const tiny = costPlusEstimate(rec(0.00001), 30);
  assert.equal(tiny.value, 5);
  assert.match(tiny.reason, /30 × \$0\.00001 per EA = \$0\.0003, what pharmacies pay for the pack by NADAC, which is under half a cent and counts as \$0\.00 here/);
  // Floating point would get these wrong: 1.15 × 100 is not 114.99999999999999 here.
  assert.equal(costPlusEstimate(rec(1), 100).value, 120); // $100 + $15 + $5
  assert.equal(costPlusEstimate(rec(0.1), 3).value, 5.35); // 0.1 × 3 = 0.30 → 30¢ + 4.5¢ → 5¢
  // Large packs keep every digit: 9999 × $12,345.67891 = $123,444,443.42109 → $123,444,443.42;
  // 15% = $18,516,666.513 → $18,516,666.51; + $5.00 (checked with Python's decimal module).
  const big = costPlusEstimate(rec(12345.67891), 9999);
  assert.equal(big.value, 141961114.93);
  assert.ok(big.reason.includes('(exactly $123,444,443.42109, rounded half-up to the cent)'), big.reason);
  assert.ok(big.reason.includes('$123,444,443.42 + $18,516,666.51 + $5.00 = $141,961,114.93.'), big.reason);
  // Decimal quantities, and per ML.
  const ml = costPlusEstimate(rec(0.5, 'ML'), 2.5);
  assert.equal(ml.value, 6.44); // $1.25 + 18.75¢ → 19¢ + $5.00
  assert.equal(ml.per, '2.5 ML');
  // No `per` on the input: none on the estimate.
  const { per: _per, ...noPer } = SHOWCASE_NADAC;
  assert.equal(costPlusEstimate(noPer, 30).per, undefined);
});

test('costPlusEstimate: unusable quantities are Missing; bad records throw', () => {
  for (const q of [0, -1, 'x', '', 10000, 1.2345, null, undefined, NaN, Infinity]) {
    const r = costPlusEstimate(SHOWCASE_NADAC, q);
    assert.equal(r.missing, true, String(q));
    assert.equal(r.reason, quantityProblem(q), String(q));
  }
  assert.throws(() => costPlusEstimate(null, 30), /not a valid record/);
  assert.throws(() => costPlusEstimate({ ...SHOWCASE_NADAC, kind: 'ratio' }, 30), /must be kind usd/);
  assert.throws(() => costPlusEstimate({ ...SHOWCASE_NADAC, value: 0 }, 30), /not a valid record/);
});

test('summarizeProduct: cost_plus over the NADAC range, Missing exactly when the pack total is', () => {
  const s = summarizeProduct(rowsNamed('METFORMIN'), 60);
  assert.equal(s.cost_plus.qty, 60);
  assert.ok(Object.isFrozen(s.cost_plus));
  // $0.87 + 13¢ + $5.00; $0.96 + 14.4¢ → 14¢ + $5.00.
  assert.equal(s.cost_plus.min.value, 6);
  assert.equal(s.cost_plus.max.value, 6.1);
  assert.equal(s.cost_plus.same, false);
  assert.deepEqual(s.cost_plus.min, costPlusEstimate(s.nadac.min, 60));
  assert.deepEqual(s.cost_plus.max, costPlusEstimate(s.nadac.max, 60));
  for (const r of [s.cost_plus.min, s.cost_plus.max]) {
    assert.deepEqual(validateRecord(r), []);
    assert.equal(r.state, 'estimated');
    assert.equal(r.source_url, 'methodology.html#cost-plus');
    assert.equal(r.source_file, 'fixture-nadac-20261014.csv');
  }
  // One NDC: same.
  const one = summarizeProduct(rowsNamed('ELIQUIS'), 60);
  assert.equal(one.cost_plus.same, true);
  assert.equal(one.cost_plus.min.value, 686.48); // 60 × $9.87654 = $592.5924 → $592.59; + $88.89 (88.8885) + $5.00
  // Different NADAC values that round to the same estimate are `same`.
  const a = clone(METFORMIN);
  const b = clone(METFORMIN);
  b.ndc = '90001000199';
  b.nadac.value = 0.01452;
  const near = summarizeProduct([a, b], 1);
  assert.equal(near.nadac.same, false);
  assert.equal(near.cost_plus.same, true);
  // Missing when the pack total is, with the same reason.
  for (const [rows, q] of [
    [rowsNamed('METFORMIN'), undefined],
    [rowsNamed('METFORMIN'), 0],
    [rowsNamed('METFORMIN'), 'x'],
  ]) {
    const x = summarizeProduct(rows, q);
    assert.equal(x.cost_plus.missing, true);
    assert.equal(x.cost_plus.reason, x.pack.reason);
  }
  const g = clone(METFORMIN);
  g.ndc = '90001000102';
  g.unit = 'GM';
  g.nadac.per = 'GM';
  g.part_d = null;
  const mixed = summarizeProduct([clone(METFORMIN), g], 30);
  assert.equal(mixed.cost_plus.missing, true);
  assert.match(mixed.cost_plus.reason, /different units/);
  // Every product in the fixture gets an estimate (it needs only NADAC), and none is a spread.
  for (const p of groupProducts(LINKED)) {
    const x = summarizeProduct(p.rows, 1);
    assert.equal(x.cost_plus.min.state, 'estimated', p.name);
    assert.equal(x.cost_plus.min.kind, 'usd', p.name);
  }
});

test('parsePaid: a positive amount in dollars and cents, up to $100,000.00, else a plain reason', () => {
  const ok = (x, v) => assert.deepEqual(parsePaid(x), { valid: true, value: v }, JSON.stringify(x));
  ok('12', 12);
  ok('12.50', 12.5);
  ok('12.5', 12.5);
  ok('12.', 12);
  ok('.5', 0.5);
  ok('$12.00', 12);
  ok('$ 12.00', 12);
  ok('  7.99  ', 7.99);
  ok('1,234.56', 1234.56);
  ok('100,000', 100000);
  ok('100000.00', 100000);
  ok('0.01', 0.01);
  ok(12.5, 12.5);
  ok(100000, 100000);
  assert.equal(PAID_MAX_USD, 100000);
  const bad = (x, re) => {
    const r = parsePaid(x);
    assert.equal(r.valid, false, JSON.stringify(x));
    assert.match(r.problem, re, JSON.stringify(x));
    assert.ok(Object.isFrozen(r));
  };
  bad('', /No amount entered/);
  bad('   ', /No amount entered/);
  bad(undefined, /No amount entered/);
  bad(null, /No amount entered/);
  bad('0', /more than \$0/);
  bad('0.00', /more than \$0/);
  bad(0, /more than \$0/);
  bad('-5', /more than \$0/);
  bad('-$5', /more than \$0/);
  bad('$-5', /more than \$0/);
  bad(-5, /more than \$0/);
  bad('100000.01', /up to \$100,000\.00/);
  bad('1,000,000', /up to \$100,000\.00/);
  bad(1e21, /up to \$100,000\.00/);
  bad('12.345', /at most two digits after the point/);
  bad(12.345, /at most two digits after the point/);
  bad('0.004', /at most two digits after the point/);
  for (const x of ['abc', '12abc', '1e3', '0x10', 'Infinity', 'NaN', '12,34', '1,2345', '$', '.', '12 50', '€12', '$$12', '12$', true, {}, [], NaN, Infinity]) {
    bad(x, /not an amount in dollars|No amount entered/);
  }
  // A problem never repeats what was typed (the page shows it next to the input).
  assert.doesNotMatch(parsePaid('<script>').problem, /script/);
});

test('parsePaid: a crafted, very long amount (e.g. a link’s &paid=) is refused at once, before any arithmetic', () => {
  // Regression: '9'.repeat(1e6) used to reach the decimal maths, which took ~1 s in V8 and threw a
  // BigInt RangeError in WebKit and Firefox, taking the whole card and search box down.
  for (const x of ['9'.repeat(1e6), '0'.repeat(1e6) + '1', `${'1'.repeat(400000)}.00`, `$${' '.repeat(5e5)}1`, '0'.repeat(PAID_MAX_CHARS) + '1']) {
    const t = performance.now();
    const r = parsePaid(x);
    const took = performance.now() - t;
    assert.equal(r.valid, false, `${x.length} characters`);
    assert.match(r.problem, /too long to be an amount|up to \$100,000\.00/);
    assert.ok(took < 50, `${x.length} characters took ${took.toFixed(1)} ms`);
  }
  // Zero-padding cannot slip a value past the limit or be read as an amount it is not.
  assert.equal(parsePaid('0000001').value, 1);
  assert.equal(parsePaid('0012.50').value, 12.5);
  assert.match(parsePaid('0001000000').problem, /up to \$100,000\.00/);
  assert.match(parsePaid('9999999999').problem, /up to \$100,000\.00/);
  assert.equal(parsePaid('0.50').value, 0.5);
  // The longest plain amount a person types still works.
  assert.equal(parsePaid('$100,000.00').value, 100000);
  assert.equal(parsePaid(`  $100,000.00  `).value, 100000);
  // paidComparison goes through the same check.
  const pack = { qty: 30, min: unitTotal(SHOWCASE_NADAC, 30), max: unitTotal(SHOWCASE_NADAC, 30), same: true };
  assert.equal(paidComparison('9'.repeat(1e6), pack, pack).valid, false);
});

test('paidComparison: the showcase — what you paid as multiples of NADAC and the cost-plus estimate', () => {
  const pack = { qty: 30, min: unitTotal(SHOWCASE_NADAC, 30), max: unitTotal(SHOWCASE_NADAC, 30), same: true };
  const est = costPlusEstimate(SHOWCASE_NADAC, 30);
  const cp = { qty: 30, min: est, max: est, same: true };
  const c = paidComparison('12.00', pack, cp);
  assert.ok(Object.isFrozen(c));
  assert.equal(c.valid, true);
  assert.equal(c.paid, 12);
  assert.equal(c.vs_pharmacy.min, 3.5820895522); // 12 ÷ 3.35
  assert.equal(c.vs_pharmacy.max, 3.5820895522);
  assert.equal(c.vs_pharmacy.same, true);
  assert.deepEqual(c.vs_pharmacy.inputs, [pack.min, pack.max]);
  assert.equal(c.vs_cost_plus.min, 1.3559322034); // 12 ÷ 8.85
  assert.equal(c.sentence, 'You paid 3.6× what pharmacies pay for this pack, and 1.4× the cost-plus estimate.');
  assert.equal(c.problem, undefined);
  assert.doesNotMatch(c.sentence, /typical cash price/i);
  // $16.80 is 1.9× the estimate.
  assert.equal(paidComparison(16.8, pack, cp).sentence, 'You paid 5.0× what pharmacies pay for this pack, and 1.9× the cost-plus estimate.');
});

test('paidComparison: ranges, near 1, below 1, and nothing to compare with', () => {
  const s = summarizeProduct(rowsNamed('METFORMIN'), 60); // pack $0.87 to $0.96; cost-plus $6.00 to $6.10
  const r = paidComparison('3.48', s.pack, s.cost_plus);
  assert.equal(r.vs_pharmacy.min, 3.625); // 3.48 ÷ 0.96: the dearest pack gives the smallest multiple
  assert.equal(r.vs_pharmacy.max, 4); // 3.48 ÷ 0.87
  assert.equal(r.vs_pharmacy.same, false);
  assert.equal(r.vs_cost_plus.min, divideMoney(3.48, 6.1, 10));
  assert.equal(r.vs_cost_plus.max, 0.58);
  assert.equal(
    r.sentence,
    'You paid between 3.6× and 4.0× what pharmacies pay for this pack, depending on the NDC, and between 42% and 43% less than the cost-plus estimate, depending on the NDC.',
  );
  // One end "about", the other a multiple: the multiples.
  assert.match(paidComparison('6.35', s.pack, s.cost_plus).sentence, /, and between 1\.0× and 1\.1× the cost-plus estimate, depending on the NDC\.$/);
  // Both ends "about": said once.
  assert.match(paidComparison('6.00', s.pack, s.cost_plus).sentence, /, and about the cost-plus estimate\.$/);
  assert.match(paidComparison('6.10', s.pack, s.cost_plus).sentence, /, and about the cost-plus estimate\.$/);
  // 3 ÷ 6.10 is 51% less and 3 ÷ 6.00 is 50% less: a range.
  assert.match(paidComparison('3.00', s.pack, s.cost_plus).sentence, /, and between 50% and 51% less than the cost-plus estimate, depending on the NDC\.$/);
  const one = summarizeProduct(rowsNamed('ELIQUIS'), 60); // pack $592.59; cost-plus $686.48
  assert.equal(paidComparison('592.59', one.pack, one.cost_plus).sentence, 'You paid about what pharmacies pay for this pack, and 14% less than the cost-plus estimate.');
  assert.equal(paidComparison('0.01', one.pack, one.cost_plus).sentence, 'You paid less than 1% of what pharmacies pay for this pack, and less than 1% of the cost-plus estimate.');
  // Equal multiples after formatting are said once, not as "between 4.0× and 4.0×".
  // Two NDCs whose packs round to the same cent ($0.8706 and $0.8712 → $0.87) give one multiple.
  const twin = clone(METFORMIN);
  twin.ndc = '90001000199';
  twin.nadac.value = 0.01452;
  const near = summarizeProduct([clone(METFORMIN), twin], 60);
  assert.equal(near.pack.same, false);
  const nc = paidComparison('3.48', near.pack, near.cost_plus);
  assert.equal(nc.vs_pharmacy.same, true);
  assert.equal(nc.sentence, 'You paid 4.0× what pharmacies pay for this pack, and 42% less than the cost-plus estimate.');
  // No quantity: valid input, nothing to compare with, and the reason.
  const none = summarizeProduct(rowsNamed('METFORMIN'));
  const n = paidComparison('12', none.pack, none.cost_plus);
  assert.equal(n.valid, true);
  assert.equal(n.vs_pharmacy.missing, true);
  assert.equal(n.vs_cost_plus.missing, true);
  assert.equal(n.sentence, 'We can’t compare what you paid yet: No quantity entered.');
  // Only one of the two available.
  const onlyPack = paidComparison('12', s.pack, { missing: true, reason: 'x' });
  assert.equal(onlyPack.sentence, 'You paid between 12.5× and 13.8× what pharmacies pay for this pack, depending on the NDC.');
  assert.equal(onlyPack.vs_cost_plus.reason, 'x');
  // 12 ÷ 6.10 = 1.97 and 12 ÷ 6.00 = 2: both "2.0×", said once.
  const onlyCp = paidComparison('12', { missing: true, reason: 'x' }, s.cost_plus);
  assert.equal(onlyCp.sentence, 'You paid 2.0× the cost-plus estimate.');
  assert.equal(paidComparison('12', null, undefined).vs_pharmacy.missing, true);
  // Invalid input: no multiples at all.
  const bad = paidComparison('0', s.pack, s.cost_plus);
  assert.deepEqual(bad, { valid: false, problem: 'What you paid must be more than $0.' });
  assert.equal(paidComparison('200000', s.pack, s.cost_plus).valid, false);
  // Records that are not usd records are refused.
  assert.throws(() => paidComparison('12', { min: { value: 1 }, max: { value: 1 } }, s.cost_plus), /not a valid record/);
});


test('PART_D_UNMATCHED_REASON: true whatever the builder’s reason was, so it never says no Part D row exists', () => {
  // Regression: rows without a Part D join used to say "No Medicare Part D spending row matched this
  // drug by brand or generic name", which is false when Part D has a row with the name that the
  // builder refused (mixed_units for AMOXICILLIN 500 MG CAPSULE, whose Part D row 700 exists).
  assert.doesNotMatch(PART_D_UNMATCHED_REASON, /No Medicare Part D spending row matched/);
  assert.match(PART_D_UNMATCHED_REASON, /^OpenBill did not match this NDC to a usable Medicare Part D spending row\. Either Part D has none for it, or/);
  for (const why of ['mix units', 'routes', 'release forms', 'over the counter']) assert.ok(PART_D_UNMATCHED_REASON.includes(why), why);
});

// Decision 48: kits, pens, syringes, patches and anything not plainly an oral tablet or capsule
// start at 1, with 1 / 2 / 3 buttons and a reason that names the form.
const eaRow = (fields) => {
  const r = clone(METFORMIN);
  r.name = fields.name || r.name;
  if (fields.identity === null) r.identity = null;
  else Object.assign(r.identity, fields.identity || {});
  if (fields.ndc) r.ndc = fields.ndc;
  return r;
};

test('defaultQuantity: oral solids by FDA start at 30, whatever kind of tablet or capsule', () => {
  for (const form of ['TABLET', 'TABLET, FILM COATED', 'TABLET, ORALLY DISINTEGRATING', 'TABLET, CHEWABLE', 'TABLET, FILM COATED, EXTENDED RELEASE', 'CAPSULE', 'CAPSULE, DELAYED RELEASE', 'CAPSULE, LIQUID FILLED', 'LOZENGE', 'TROCHE']) {
    const d = defaultQuantity([eaRow({ identity: { dosage_form: form, route: 'ORAL' } })]);
    assert.equal(d.qty, DEFAULT_EA_QUANTITY, form);
    assert.equal(d.form.oral_solid, true, form);
    assert.deepEqual([...d.chips], [30, 60, 90], form);
  }
  // FDA sometimes repeats the route ("ORAL; ORAL"); still only by mouth.
  assert.equal(defaultQuantity([eaRow({ identity: { dosage_form: 'TABLET', route: 'ORAL; ORAL' } })]).qty, 30);
  assert.equal(defaultQuantity([eaRow({ identity: { dosage_form: 'LOZENGE', route: 'ORAL' } })]).form.one, 'lozenge');
});

test('defaultQuantity: anything else priced per EA starts at 1, and the reason names the form', () => {
  const kit = defaultQuantity([eaRow({ name: 'AVONEX 30 MCG/0.5 ML SYRINGE KIT (4 PACK)', identity: { dosage_form: 'KIT', route: 'INTRAMUSCULAR' } })]);
  assert.deepEqual([kit.qty, kit.unit, [...kit.chips]], [DEFAULT_EA_OTHER_QUANTITY, 'EA', [1, 2, 3]]);
  assert.equal(kit.chips, QUANTITY_CHIPS.other);
  assert.deepEqual([kit.form.oral_solid, kit.form.one, kit.form.many], [false, 'unit (EA)', 'units (EA)']);
  assert.equal(
    kit.reason,
    'NADAC prices this product per EA, and the FDA NDC Directory lists its NDC as dosage form “KIT” with route “INTRAMUSCULAR”. Only a tablet, capsule, lozenge or troche with route “ORAL”, or a tablet or film with route “SUBLINGUAL” or “BUCCAL”, starts at 30, and this is not one. NADAC’s EA for it may be the whole kit or one item in it, and the files do not say which. So the card starts at 1 unit (EA) rather than guess how many make up a fill; change it to match your prescription.',
  );
  // A kit with no route at all (FDA leaves it blank for many kits).
  assert.match(defaultQuantity([eaRow({ identity: { dosage_form: 'KIT', route: null } })]).reason, /dosage form “KIT” with no route\./);
  // Injections, inhaled powders, sprays: NADAC's EA may be a package or one dose, so no noun is claimed.
  for (const [form, route] of [
    ['INJECTION, POWDER, FOR SOLUTION', 'INTRAMUSCULAR; INTRAVENOUS'],
    ['POWDER', 'RESPIRATORY (INHALATION)'],
    ['SPRAY', 'NASAL'],
    ['INJECTION, SOLUTION', 'SUBCUTANEOUS'],
  ]) {
    const d = defaultQuantity([eaRow({ identity: { dosage_form: form, route } })]);
    assert.deepEqual([d.qty, d.form.one], [1, 'unit (EA)'], form);
    assert.ok(d.reason.includes(`dosage form “${form}” with route “${route}”`), d.reason);
    assert.match(d.reason, /may be a whole package \(such as a kit, pen, syringe, vial or inhaler\) or one dose inside it, and the files do not say which\. So the card starts at 1 unit \(EA\)/);
  }
  // A unit that is the thing itself is named: one patch, priced per patch.
  for (const [form, route, one] of [
    ['PATCH, EXTENDED RELEASE', 'TRANSDERMAL', 'patch'],
    ['SUPPOSITORY', 'RECTAL', 'suppository'],
    ['RING', 'VAGINAL', 'ring'],
    // A film taken by mouth, gum (even buccal), a capsule under the tongue, a vaginal tablet: under
    // the tongue or against the cheek, only tablets and films count (decision 49).
    ['FILM', 'ORAL', 'film'],
    ['GUM, CHEWING', 'ORAL', 'piece of gum'],
    ['GUM, CHEWING', 'BUCCAL', 'piece of gum'],
    ['TABLET', 'VAGINAL', 'tablet'],
    ['TABLET', 'SUBLINGUAL; VAGINAL', 'tablet'],
    ['CAPSULE', 'SUBLINGUAL', 'capsule'],
    ['CAPSULE', 'ORAL; RESPIRATORY (INHALATION)', 'capsule'],
    ['LOZENGE', 'ORAL; TOPICAL', 'lozenge'],
  ]) {
    const d = defaultQuantity([eaRow({ identity: { dosage_form: form, route } })]);
    assert.deepEqual([d.qty, d.form.oral_solid, d.form.one], [1, false, one], `${form} ${route}`);
    assert.ok(d.reason.endsWith(`So the card starts at 1 ${one}, priced per ${one}, rather than guess how many make up a fill; change it to match your prescription.`), d.reason);
  }
});

test('defaultQuantity: every listed NDC must be an oral solid; mixed forms start at 1 and say so', () => {
  const a = eaRow({ identity: { dosage_form: 'TABLET', route: 'ORAL' } });
  const b = eaRow({ ndc: '90001000109', identity: { dosage_form: 'FILM', route: 'ORAL' } });
  const d = defaultQuantity([a, b]);
  assert.deepEqual([d.qty, d.form.oral_solid, d.form.some_oral, d.form.one], [1, false, true, 'unit (EA)']);
  assert.match(d.reason, /lists its 2 NDCs as dosage forms “FILM”, “TABLET” with route “ORAL”\. Only a tablet, capsule, lozenge or troche with route “ORAL”, or a tablet or film with route “SUBLINGUAL” or “BUCCAL”, starts at 30, and not all of its NDCs are one\. Its NDCs are listed as different dosage forms, so the card does not name what one EA is and starts at 1 unit \(EA\)/);
  // Not the kit, pen or vial wording for a product whose NDCs are partly tablets (decision 49).
  assert.doesNotMatch(d.reason, /kit, pen, syringe/);
  // Two kinds of tablet are still tablets.
  const c = eaRow({ ndc: '90001000109', identity: { dosage_form: 'TABLET, FILM COATED', route: 'ORAL' } });
  const t = defaultQuantity([a, c]);
  assert.deepEqual([t.qty, t.form.one], [30, 'tablet']);
  assert.match(t.reason, /all 2 of its NDCs as an oral tablet \(dosage forms “TABLET”, “TABLET, FILM COATED”, route “ORAL”\)/);
  // A tablet and a capsule under one name: oral solids, but no one noun.
  const cap = eaRow({ ndc: '90001000109', identity: { dosage_form: 'CAPSULE', route: 'ORAL' } });
  const tc = defaultQuantity([a, cap]);
  assert.deepEqual([tc.qty, tc.form.one, tc.form.many], [30, 'unit (EA)', 'units (EA)']);
  assert.match(tc.reason, /as oral tablets or capsules .+ so one EA is one tablet or capsule\. The card starts at 30 units \(EA\)/);
  // An NDC FDA does not list does not count against the ones it does.
  assert.equal(defaultQuantity([a, eaRow({ ndc: '90001000109', identity: null })]).qty, 30);
});

test('defaultQuantity: with no FDA listing, the NADAC name decides; when it cannot, 1 and the reason says so', () => {
  const by = (name) => defaultQuantity([eaRow({ name, identity: null })]);
  for (const [name, one] of [
    ['LEVO-T 100 MCG TABLET', 'tablet'],
    ['FT AD ALLERGY (LORAT) 10 MG TB', 'tablet'],
    ['ED-SPAZ 0.125 MG ODT', 'tablet'],
    ['DOXEPIN 150 MG CAPSULE', 'capsule'],
    ['IBUPROFEN COLD-SINUS CPLT', 'caplet'],
    ['GAS RELIEF 180 MG SOFTGEL', 'softgel'],
    ['CALCIUM ACETATE 667 MG GELCAP', 'gelcap'],
    ['GNP NASAL DECONG PE 10 MG TAB', 'tablet'],
  ]) {
    const d = by(name);
    assert.deepEqual([d.qty, d.form.basis, d.form.oral_solid, d.form.one], [30, 'name', true, one], name);
    assert.ok(d.reason.includes(`its NADAC name (“${name}”) says`), d.reason);
  }
  assert.equal(
    by('LEVO-T 100 MCG TABLET').reason,
    'NADAC prices this product per EA. The FDA NDC Directory does not list its NDC, but its NADAC name (“LEVO-T 100 MCG TABLET”) says “TABLET”, an oral tablet, so one EA is one tablet. The card starts at 30 tablets, a common one-month supply of a once-a-day medicine; change it to match your prescription.',
  );
  for (const [name, word, one] of [
    ['PERSERIS ER 120 MG SYRINGE KIT', 'SYRINGE', 'unit (EA)'],
    ['SANDOSTATIN LAR DEPOT 30 MG VL', 'VL', 'unit (EA)'],
    ['BASAGLAR 100 UNIT/ML KWIKPEN', 'KWIKPEN', 'unit (EA)'],
    ['ZOMIG 5 MG NASAL SPRAY', 'SPRAY', 'unit (EA)'],
    ['ANLIDO 4% PATCH', 'PATCH', 'patch'],
    ['FLEET GLYCERIN 2 GM ADULT SUPP', 'SUPP', 'suppository'],
    ['ESTRADIOL 10 MCG VAGINAL TABLET', 'VAGINAL', 'tablet'],
    ['FOO 2 MG SL TABLET KIT', 'SL', 'tablet'],
    ['NICOTINE 2 MG BUCCAL GUM', 'BUCCAL', 'unit (EA)'],
  ]) {
    const d = by(name);
    assert.deepEqual([d.qty, d.form.basis, d.form.oral_solid, d.form.one, d.form.word], [1, 'name', false, one, word], name);
    assert.ok(d.reason.includes(`its NADAC name (“${name}”) says “${word}”, and only an oral tablet or capsule (or a tablet or film taken under the tongue or against the cheek) starts at 30.`), d.reason);
  }
  for (const name of ['COMPLETE NATAL DHA', 'VITAFOL GUMMIES', 'IMVEXXY 10 MCG STARTER PACK', '8 HOUR ACETAMINOPHEN ER 650 MG']) {
    const d = by(name);
    assert.deepEqual([d.qty, d.form.basis, d.form.oral_solid, [...d.chips]], [1, 'none', false, [1, 2, 3]], name);
    assert.equal(d.reason, `NADAC prices this product per EA. The FDA NDC Directory does not list its NDC, and its NADAC name (“${name}”) does not say whether it is an oral tablet or capsule, so the card starts at 1 rather than guess a month’s supply; change it to match your prescription.`);
  }
  // eaForm reads only; it never changes the rows.
  const rows = [eaRow({ identity: { dosage_form: 'KIT', route: null } })];
  const before = JSON.stringify(rows);
  assert.deepEqual(eaForm(rows), eaForm(rows));
  assert.equal(JSON.stringify(rows), before);
});

test('defaultQuantity on the real data: kits, pens and syringes priced per EA no longer start at 30', (t) => {
  // A regression for the kit that opened at "Pharmacies pay $263,287.57 for 30 kits".
  const file = new URL('../data/drugs.json', import.meta.url);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!text || text.startsWith('version https://git-lfs')) {
    t.skip('data/drugs.json is not here (or is a Git LFS pointer)');
    return;
  }
  const products = groupProducts(linkRows(JSON.parse(text)));
  const byName = new Map(products.map((p) => [p.name, p]));
  const avonex = defaultQuantity(byName.get('AVONEX 30 MCG/0.5 ML SYRINGE KIT (4 PACK)'));
  assert.deepEqual([avonex.qty, avonex.form.oral_solid], [1, false]);
  assert.match(avonex.reason, /dosage form “KIT”/);
  assert.equal(defaultQuantity(byName.get('ARIPIPRAZOLE 10 MG TABLET')).qty, 30);
  for (const p of products) {
    const d = defaultQuantity(p);
    if (d.unit !== 'EA') continue;
    const forms = p.rows.filter((r) => r.identity).map((r) => String(r.identity.dosage_form));
    if (forms.some((f) => /^(KIT|INJECTION|PATCH|SUPPOSITORY|RING|POWDER|SPRAY|INHALANT|AEROSOL|SOLUTION)\b/.test(f))) assert.equal(d.qty, 1, p.name);
    if (d.qty === 30) assert.ok(d.form.oral_solid, p.name);
  }
});

test('decision 49 states the starting-quantity counts of the 2026-10-14 build correctly', (t) => {
  // A regression for the counts decision 49 records (decision 48's were once "The 1,715 products
  // priced per ML or GM", which counted the 12 mixed-unit products twice). Runs only on the build
  // the decision describes.
  const file = new URL('../data/drugs.json', import.meta.url);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!text || text.startsWith('version https://git-lfs')) {
    t.skip('data/drugs.json is not here (or is a Git LFS pointer)');
    return;
  }
  const doc = JSON.parse(text);
  if (doc.sources.nadac.as_of_date !== '2026-10-14') {
    t.skip('decision 49 records the 2026-10-14 build; this data is newer');
    return;
  }
  const count = { ea30: 0, eaFda30: 0, eaName30: 0, ea1: 0, mlgm: 0, mixed: 0, ML: { pkg: 0, inner: 0, one: 0 }, GM: { pkg: 0, inner: 0, one: 0 } };
  for (const p of groupProducts(linkRows(doc))) {
    const d = defaultQuantity(p);
    if (d.unit === 'EA') {
      if (d.qty === 30) {
        count.ea30 += 1;
        count[d.form.basis === 'fda' ? 'eaFda30' : 'eaName30'] += 1;
      } else count.ea1 += 1;
    } else if (d.unit === 'ML' || d.unit === 'GM') {
      count.mlgm += 1;
      const kind = /wholesale pack/.test(d.reason) ? 'inner' : /So the card starts at 1 (ML|GM); change it/.test(d.reason) ? 'one' : 'pkg';
      count[d.unit][kind] += 1;
    } else if (d.unit === null) count.mixed += 1;
  }
  const decisions = readFileSync(new URL('../docs/DECISIONS.md', import.meta.url), 'utf8');
  const d49 = decisions.slice(decisions.indexOf('## 49. ')).replace(/\s+/g, ' ');
  const fmt = (n) => n.toLocaleString('en-US');
  const has = (s, what) => assert.ok(d49.includes(s), `${what}: ${s}`);
  has(`Of the ${fmt(count.ea30 + count.ea1)} products priced per EA, ${fmt(count.ea30)} start at 30 (${fmt(count.eaFda30)} by FDA's listing, ${fmt(count.eaName30)} by their NADAC name) and ${fmt(count.ea1)} start at 1.`, 'EA');
  const { ML, GM } = count;
  has(
    `Of the ${fmt(count.mlgm)} products priced per ML or GM, ${fmt(ML.pkg + GM.pkg)} start at one package (${fmt(ML.pkg)} per ML, ${fmt(GM.pkg)} per GM), ${fmt(ML.inner + GM.inner)} at one inner unit of a wholesale pack (${fmt(ML.inner)} per ML, ${fmt(GM.inner)} per GM) and ${fmt(ML.one + GM.one)} at 1 (${fmt(ML.one)} per ML, ${fmt(GM.one)} per GM); the ${fmt(count.mixed)} priced in mixed units are unchanged.`,
    'ML/GM',
  );
});

// Decision 49: every product of the 2026-10-14 build whose starting quantity changed, as
// [name, unit, before, after]. 45 priced per EA (sublingual and buccal tablets and films; three
// products whose FDA listing has an outlier) and 87 priced per ML or GM (wholesale cases and
// multi-packs, which now start at one inner unit).
const DECISION_49_CHANGES = [
  ['ADRENALIN 1 MG/ML VIAL', 'ML', 25, 1],
  ['AMIKACIN SULF 500 MG/2 ML VIAL', 'ML', 20, 2],
  ['AMIODARONE 150 MG/3 ML VIAL', 'ML', 75, 3],
  ['ASENAPINE 10 MG TABLET SL', 'EA', 1, 30],
  ['ASENAPINE 2.5 MG TABLET SL', 'EA', 1, 30],
  ['ASENAPINE 5 MG TABLET SL', 'EA', 1, 30],
  ['ATOVAQUONE 750 MG/5 ML SUSPENSION CUP', 'ML', 210, 30],
  ['BACTERIOSTATIC SALINE VIAL', 'ML', 500, 20],
  ['BACTERIOSTATIC WATER VIAL', 'ML', 750, 30],
  ['BELBUCA 150 MCG FILM', 'EA', 1, 30],
  ['BELBUCA 300 MCG FILM', 'EA', 1, 30],
  ['BELBUCA 450 MCG FILM', 'EA', 1, 30],
  ['BELBUCA 600 MCG FILM', 'EA', 1, 30],
  ['BELBUCA 75 MCG FILM', 'EA', 1, 30],
  ['BELBUCA 750 MCG FILM', 'EA', 1, 30],
  ['BELBUCA 900 MCG FILM', 'EA', 1, 30],
  ['BUPRENORPHINE 2 MG TABLET SL', 'EA', 1, 30],
  ['BUPRENORPHINE 8 MG TABLET SL', 'EA', 1, 30],
  ['BUPRENORPHINE-NALOXONE 12-3 MG SL FILM', 'EA', 1, 30],
  ['BUPRENORPHINE-NALOXONE 2-0.5 MG SL FILM', 'EA', 1, 30],
  ['BUPRENORPHINE-NALOXONE 2-0.5 MG SL TABLET', 'EA', 1, 30],
  ['BUPRENORPHINE-NALOXONE 4-1 MG SL FILM', 'EA', 1, 30],
  ['BUPRENORPHINE-NALOXONE 8-2 MG SL FILM', 'EA', 1, 30],
  ['BUPRENORPHINE-NALOXONE 8-2 MG SL TABLET', 'EA', 1, 30],
  ['CALCIUM CARB 1,250 MG/5 ML SUS', 'ML', 5676, 473],
  ['CYANOCOBALAMIN 10,000 MCG/10 ML', 'ML', 1, 10],
  ['DESMOPRESSIN AC 4 MCG/ML VIAL', 'ML', 10, 1],
  ['DESOXIMETASONE 0.05% CREAM', 'GM', 1, 60],
  ['DEXAMETHASONE 10 MG/ML VIAL', 'ML', 25, 1],
  ['DEXAMETHASONE 100 MG/10 ML VL', 'ML', 100, 10],
  ['DEXAMETHASONE 20 MG/5 ML VIAL', 'ML', 1, 5],
  ['DEXAMETHASONE 4 MG/ML VIAL', 'ML', 25, 1],
  ['DIAPER RASH 40% OINTMENT', 'GM', 8136, 113],
  ['EPOGEN 10,000 UNIT/ML VIAL', 'ML', 10, 1],
  ['EPOGEN 2,000 UNITS/ML VIAL', 'ML', 10, 1],
  ['EPOGEN 4,000 UNIT/ML VIAL', 'ML', 10, 1],
  ['ESTRACE 0.01% CREAM', 'GM', 1530, 42.5],
  ['FAMOTIDINE 20 MG/2 ML VIAL', 'ML', 50, 2],
  ['FEBUXOSTAT 40 MG TABLET', 'EA', 1, 30],
  ['FEBUXOSTAT 80 MG TABLET', 'EA', 1, 30],
  ['FENTANYL 100 MCG/2 ML VIAL', 'ML', 50, 2],
  ['FENTANYL 250 MCG/5 ML VIAL', 'ML', 50, 5],
  ['FLUMAZENIL 0.5 MG/5 ML VIAL', 'ML', 50, 5],
  ['FUROSEMIDE 100 MG/10 ML VIAL', 'ML', 100, 10],
  ['FUROSEMIDE 20 MG/2 ML VIAL', 'ML', 50, 2],
  ['FUROSEMIDE 40 MG/4 ML ORAL SOLUTION CUP', 'ML', 120, 40],
  ['FUROSEMIDE 40 MG/4 ML VIAL', 'ML', 100, 4],
  ['GENTAMICIN 80 MG/2 ML VIAL', 'ML', 50, 2],
  ['GRASTEK 2,800 BAU SL TABLET', 'EA', 1, 30],
  ['HALOPERIDOL LAC 5 MG/ML VIAL', 'ML', 25, 1],
  ['HEPARIN SOD 10,000 UNIT/ML VL', 'ML', 25, 1],
  ['HEPARIN SOD 5,000 UNIT/ML VIAL', 'ML', 25, 1],
  ['HEPARIN SODIUM 10,000 UNIT/ML VIAL', 'ML', 25, 1],
  ['HEPARIN SODIUM 5,000 UNIT/ML VIAL', 'ML', 25, 1],
  ['HYDROMORPHONE 2 MG/ML VIAL', 'ML', 25, 1],
  ['HYDROMORPHONE 50 MG/5 ML VIAL', 'ML', 50, 5],
  ['HYOSCYAMINE 0.125 MG TAB SL', 'EA', 1, 30],
  ['INFED 100 MG/2 ML VIAL', 'ML', 20, 2],
  ['KETALAR 500 MG/10 ML VIAL', 'ML', 100, 10],
  ['KETAMINE 500 MG/10 ML VIAL', 'ML', 100, 10],
  ['KETAMINE 500 MG/5 ML VIAL', 'ML', 50, 5],
  ['KETOROLAC 30 MG/ML VIAL', 'ML', 25, 1],
  ['KETOROLAC 60 MG/2 ML VIAL', 'ML', 50, 2],
  ['KIONEX 15 GM/60 ML SUSPENSION', 'ML', 600, 60],
  ['LACTULOSE 20 GM/30 ML SOLUTION CUP', 'ML', 1200, 300],
  ['LIDOCAINE 1%-EPI 1:100,000', 'ML', 200, 20],
  ['LIDOCAINE 2% VISCOUS SOLN', 'ML', 1, 100],
  ['LIDOCAINE HCL 1% 100 MG/10 ML', 'ML', 250, 10],
  ['LIDOCAINE HCL 1% 20 MG/2 ML VL', 'ML', 1, 2],
  ['LIDOCAINE HCL 1% 200 MG/20 ML', 'ML', 500, 20],
  ['LIDOCAINE HCL 1% 50 MG/5 ML VIAL', 'ML', 50, 5],
  ['LIDOCAINE HCL 1% 50 MG/5 ML VL', 'ML', 50, 5],
  ['LIDOCAINE HCL 1% 500 MG/50 ML', 'ML', 1250, 50],
  ['LIDOCAINE HCL 2% 1,000 MG/50 ML', 'ML', 500, 50],
  ['LIDOCAINE HCL 2% 100 MG/5 ML', 'ML', 50, 5],
  ['LIDOCAINE HCL 2% 40 MG/2 ML VL', 'ML', 50, 2],
  ['LIDOCAINE HCL 2% 400 MG/20 ML', 'ML', 500, 20],
  ['LIDOCAINE HCL 2% JEL UROJET AC', 'ML', 125, 5],
  ['LORAZEPAM 2 MG/ML VIAL', 'ML', 25, 1],
  ['METOCLOPRAMIDE 10 MG/2 ML VIAL', 'ML', 50, 2],
  ['MIDAZOLAM HCL 10 MG/2 ML VIAL', 'ML', 1, 2],
  ['MIDAZOLAM HCL 2 MG/2 ML VIAL', 'ML', 50, 2],
  ['MIDAZOLAM HCL 5 MG/ML VIAL', 'ML', 10, 1],
  ['MIDAZOLAM HCL 50 MG/10 ML VIAL', 'ML', 100, 10],
  ['MORPHINE SULFATE 10 MG/ML VIAL', 'ML', 25, 1],
  ['MORPHINE SULFATE 4 MG/ML VIAL', 'ML', 25, 1],
  ['NALBUPHINE 10 MG/ML AMPUL', 'ML', 10, 1],
  ['NALOXONE 0.4 MG/ML VIAL', 'ML', 10, 1],
  ['NEUPOGEN 300 MCG/ML VIAL', 'ML', 10, 1],
  ['NITROGLYCERIN 0.3 MG TABLET SL', 'EA', 1, 30],
  ['NITROGLYCERIN 0.4 MG TABLET SL', 'EA', 1, 30],
  ['NITROGLYCERIN 0.6 MG TABLET SL', 'EA', 1, 30],
  ['OCTREOTIDE ACET 100 MCG/ML VL', 'ML', 10, 1],
  ['OCTREOTIDE ACET 50 MCG/ML VIAL', 'ML', 10, 1],
  ['ODACTRA 12 SQ-HDM SL TABLET', 'EA', 1, 30],
  ['ONDANSETRON HCL 4 MG/2 ML VIAL', 'ML', 50, 2],
  ['OSCIMIN SL 0.125 MG TABLET', 'EA', 1, 30],
  ['PROMETHAZINE 25 MG/ML AMPUL', 'ML', 25, 1],
  ['PROMETHAZINE 25 MG/ML VIAL', 'ML', 25, 1],
  ['PROMETHAZINE 50 MG/ML AMPUL', 'ML', 25, 1],
  ['PROPOFOL 200 MG/20 ML VIAL', 'ML', 500, 20],
  ['PROPOFOL 500 MG/50 ML VIAL', 'ML', 500, 50],
  ['RAGWITEK SUBLINGUAL TABLET', 'EA', 1, 30],
  ['RETACRIT 10,000 UNIT/ML VIAL', 'ML', 10, 1],
  ['RETACRIT 2,000 UNIT/ML VIAL', 'ML', 10, 1],
  ['RETACRIT 20,000 UNIT/ML VIAL', 'ML', 10, 1],
  ['SAPHRIS 10 MG TAB SUBLINGUAL', 'EA', 1, 30],
  ['SAPHRIS 2.5 MG TAB SUBLINGUAL', 'EA', 1, 30],
  ['SAPHRIS 5 MG TAB SUBLINGUAL', 'EA', 1, 30],
  ['SEVELAMER HCL 800 MG TABLET', 'EA', 1, 30],
  ['SODIUM BICARBONATE 8.4% VIAL', 'ML', 1, 50],
  ['SODIUM CHLORIDE 0.9% VIAL', 'ML', 250, 10],
  ['SUBOXONE 12 MG-3 MG SL FILM', 'EA', 1, 30],
  ['SUBOXONE 2 MG-0.5 MG SL FILM', 'EA', 1, 30],
  ['SUBOXONE 4 MG-1 MG SL FILM', 'EA', 1, 30],
  ['SUBOXONE 8 MG-2 MG SL FILM', 'EA', 1, 30],
  ['TACLONEX 0.005%-0.064% SUSPENSION', 'GM', 2400, 60],
  ['TESTIM 1% (50 MG) GEL', 'GM', 150, 5],
  ['TESTOSTERONE 50 MG/5 GRAM GEL', 'GM', 150, 5],
  ['TESTOSTERONE CYP 2,000 MG/10 ML', 'ML', 1, 10],
  ['THIAMINE 200 MG/2 ML VIAL', 'ML', 50, 2],
  ['TONMYA 2.8 MG TABLET SL', 'EA', 1, 30],
  ['VALPROIC ACID 250 MG/5 ML SOLN', 'ML', 1, 473],
  ['WATER FOR INJECTION VIAL', 'ML', 250, 10],
  ['ZOLPIDEM TART 1.75 MG TAB SL', 'EA', 1, 30],
  ['ZOLPIDEM TART 3.5 MG TABLET SL', 'EA', 1, 30],
  ['ZUBSOLV 0.7-0.18 MG TABLET SL', 'EA', 1, 30],
  ['ZUBSOLV 1.4-0.36 MG TABLET SL', 'EA', 1, 30],
  ['ZUBSOLV 11.4-2.9 MG TABLET SL', 'EA', 1, 30],
  ['ZUBSOLV 2.9-0.71 MG TABLET SL', 'EA', 1, 30],
  ['ZUBSOLV 5.7-1.4 MG TABLET SL', 'EA', 1, 30],
  ['ZUBSOLV 8.6-2.1 MG TABLET SL', 'EA', 1, 30],
];

test('defaultQuantity on the real data: the products decision 49 changes, before and after', (t) => {
  const file = new URL('../data/drugs.json', import.meta.url);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!text || text.startsWith('version https://git-lfs')) {
    t.skip('data/drugs.json is not here (or is a Git LFS pointer)');
    return;
  }
  const doc = JSON.parse(text);
  if (doc.sources.nadac.as_of_date !== '2026-10-14') {
    t.skip('decision 49 lists the changes in the 2026-10-14 build; this data is newer');
    return;
  }
  assert.equal(DECISION_49_CHANGES.length, 132);
  assert.equal(DECISION_49_CHANGES.filter((x) => x[1] === 'EA').length, 45);
  const byName = new Map(groupProducts(linkRows(doc)).map((p) => [p.name, p]));
  for (const [name, unit, before, after] of DECISION_49_CHANGES) {
    assert.ok(byName.has(name), name);
    const d = defaultQuantity(byName.get(name));
    assert.deepEqual([d.unit, d.qty], [unit, after], `${name}: was ${before} ${unit}`);
    if (unit === 'EA') {
      assert.equal(before, 1, name);
      assert.deepEqual([d.form.oral_solid, d.form.plain, [...d.chips]], [true, false, [30, 60, 90]], name);
      assert.ok(d.form.mouth || d.form.outliers.length > 0, name);
    } else {
      assert.match(d.reason, /a wholesale pack of identical units|are wholesale packs of identical units/, name);
    }
  }
  // The cases the owner named.
  const tac = defaultQuantity(byName.get('TACLONEX 0.005%-0.064% SUSPENSION'));
  assert.equal(
    tac.reason,
    'NADAC prices this product per GM. In the FDA NDC Directory, NDC 50222-0501-06 (“40 CARTON in 1 CASE (50222-501-06) / 1 BOTTLE in 1 CARTON / 60 g in 1 BOTTLE”) is a shipping case of 40 cartons, 2,400 g in all: a wholesale pack of identical units, so OpenBill counts one carton of it. So the card starts at one carton: 60 GM. Change it to match your prescription.',
  );
  for (const name of ['BUPRENORPHINE 8 MG TABLET SL', 'BUPRENORPHINE-NALOXONE 8-2 MG SL FILM', 'ZUBSOLV 5.7-1.4 MG TABLET SL', 'ASENAPINE 5 MG TABLET SL', 'ZOLPIDEM TART 3.5 MG TABLET SL']) {
    const d = defaultQuantity(byName.get(name));
    assert.deepEqual([d.qty, d.form.basis, d.form.mouth], [30, 'fda', true], name);
    assert.match(d.reason, /taken under the tongue/, name);
  }
  const feb = defaultQuantity(byName.get('FEBUXOSTAT 40 MG TABLET'));
  assert.deepEqual([feb.qty, feb.form.one, feb.form.outliers.map((o) => o.ndc)], [30, 'tablet', ['33342027407']]);
  assert.match(feb.reason, /It lists the other one, NDC 33342-0274-07, as dosage form “FILM” with route “ORAL”\. That matches neither the NADAC name nor the product’s other NDCs and looks like an error in the listing/);
  assert.doesNotMatch(feb.reason, /kit, pen, syringe|NDCs it has/);
  const sev = defaultQuantity(byName.get('SEVELAMER HCL 800 MG TABLET'));
  assert.deepEqual([sev.qty, sev.form.outliers.map((o) => o.route)], [30, ['PARENTERAL', 'PARENTERAL']]);
  // Vaginal tablets still start at 1; the patient packs stay whole.
  for (const p of byName.values()) {
    const d = defaultQuantity(p);
    if (d.unit !== 'EA') continue;
    const routes = p.rows.filter((r) => r.identity).map((r) => String(r.identity.route || ''));
    if (routes.length && routes.every((r) => /VAGINAL/.test(r))) assert.equal(d.qty, 1, p.name);
  }
  assert.equal(defaultQuantity(byName.get('SUPREP BOWEL PREP KIT')).qty, 354.8, 'two bottles in a carton: one prep, not a wholesale pack');
  assert.equal(defaultQuantity(byName.get('LANTUS SOLOSTAR 100 UNIT/ML')).qty, 15, 'a carton of five pens stays whole');
});

test('packageStart: a shipping case or a big carton of identical units counts one of them', () => {
  const start = (d) => {
    const s = packageStart(d);
    return s && { amount: s.amount, unit: s.unit, pack: s.pack && { ...s.pack } };
  };
  assert.deepEqual(start('40 CARTON in 1 CASE (50222-501-06) / 1 BOTTLE in 1 CARTON / 60 g in 1 BOTTLE'), { amount: 60, unit: 'GM', pack: { count: 40, inner: 'CARTON', outer: 'CASE', whole: 2400 } });
  assert.deepEqual(start('12 BOTTLE in 1 CASE (0121-0766-16) / 473 mL in 1 BOTTLE'), { amount: 473, unit: 'ML', pack: { count: 12, inner: 'BOTTLE', outer: 'CASE', whole: 5676 } });
  // A case of trays of cups: one tray.
  assert.deepEqual(start('7 TRAY in 1 CASE (0121-1016-42) / 6 CUP, UNIT-DOSE in 1 TRAY / 5 mL in 1 CUP, UNIT-DOSE (0121-1016-05)'), { amount: 30, unit: 'ML', pack: { count: 7, inner: 'TRAY', outer: 'CASE', whole: 210 } });
  // A case of any size, even 2.
  assert.equal(start('2 JAR in 1 CASE (90000-001-01) / 454 g in 1 JAR').amount, 454);
  // Cartons, boxes, packages and trays of at least WHOLESALE_MIN_UNITS bottles, tubes, vials, jars or ampules.
  assert.equal(WHOLESALE_MIN_UNITS, 10);
  for (const [desc, amount] of [
    ['25 VIAL in 1 CARTON (42023-159-25) / 1 mL in 1 VIAL (42023-159-01)', 1],
    ['25 VIAL, SINGLE-DOSE in 1 TRAY (0409-2721-01) / 1 mL in 1 VIAL, SINGLE-DOSE (0409-2721-30)', 1],
    ['10 VIAL in 1 PACKAGE (55513-144-10) / 1 mL in 1 VIAL (55513-144-01)', 1],
    ['25 VIAL in 1 BOX (0143-9501-25) / 1 mL in 1 VIAL', 1],
    ['60 TUBE in 1 CARTON (71656-086-60) / 60 g in 1 TUBE', 60],
    ['10 AMPULE in 1 TRAY (0409-1463-01) / 1 mL in 1 AMPULE (0409-1463-71)', 1],
    ['10 BOTTLE, UNIT-DOSE in 1 CARTON (46287-006-60) / 60 mL in 1 BOTTLE, UNIT-DOSE', 60],
    ['12 JAR in 1 CARTON (90000-001-12) / 100 g in 1 JAR', 100],
  ]) {
    const s = start(desc);
    assert.ok(s.pack, desc);
    assert.equal(s.amount, amount, desc);
  }
  // Everything else is the whole package, as packageAmount() reads it.
  for (const [desc, amount] of [
    ['5 SYRINGE in 1 CARTON (0024-5925-05) / 3 mL in 1 SYRINGE (0024-5925-01)', 15], // pens
    ['30 PACKET in 1 CARTON (68025-067-30) / 1 g in 1 PACKET', 30], // a month of packets
    ['2 BOTTLE, PLASTIC in 1 CARTON (10572-012-01) / 177.4 mL in 1 BOTTLE, PLASTIC', 354.8], // one bowel prep
    ['4 BOTTLE in 1 CARTON (70954-264-10) / 75 mL in 1 BOTTLE', 300], // four weekly doses
    ['9 VIAL in 1 CARTON (90000-001-09) / 2 mL in 1 VIAL', 18], // fewer than WHOLESALE_MIN_UNITS
    ['25 BOX in 1 BOX (0641-6182-25) / 10 VIAL in 1 BOX (0641-6182-10) / 2 mL in 1 VIAL (0641-6182-01)', 500], // boxes of boxes
    ['30 POUCH in 1 CARTON (0487-0301-01) / 1 VIAL, SINGLE-DOSE in 1 POUCH / 3 mL in 1 VIAL, SINGLE-DOSE', 90], // pouches
    ['10 CARTON in 1 BOX (43066-008-10) / 1 VIAL, SINGLE-DOSE in 1 CARTON / 10 mL in 1 VIAL, SINGLE-DOSE (43066-008-01)', 100], // the vials are not on the next level
    ['1 BOTTLE in 1 CARTON (90000-001-01) / 60 g in 1 BOTTLE', 60],
    ['60 g in 1 BOTTLE (90000-001-01)', 60],
  ]) {
    const s = start(desc);
    assert.deepEqual([s.amount, s.pack], [amount, null], desc);
    assert.deepEqual({ amount: s.amount, unit: s.unit }, { ...packageAmount(desc) }, desc);
  }
  // No amount at all: null, as packageAmount().
  assert.equal(packageStart('40 CARTON in 1 CASE (90000-001-01) / 1 KIT in 1 CARTON * 5 mL in 1 VIAL'), null);
  assert.equal(packageStart(null), null);
  assert.ok(Object.isFrozen(packageStart('12 BOTTLE in 1 CASE (0121-0766-16) / 473 mL in 1 BOTTLE')));
});

test('defaultQuantity: a wholesale case or multi-pack starts at one inner unit, and the reason says so', () => {
  const gm = (ndc, desc) => {
    const r = clone(AMOX);
    r.ndc = ndc;
    r.name = 'FIXTONEX 0.005% SUSPENSION';
    r.unit = 'GM';
    r.identity.package_description = desc;
    return r;
  };
  const caseRow = gm('90050000106', '40 CARTON in 1 CASE (90050-001-06) / 1 BOTTLE in 1 CARTON / 60 g in 1 BOTTLE');
  const one = defaultQuantity([caseRow]);
  assert.deepEqual([one.qty, one.unit, [...one.chips], one.form], [60, 'GM', [], null]);
  assert.equal(
    one.reason,
    'NADAC prices this product per GM. In the FDA NDC Directory, NDC 90050-0001-06 (“40 CARTON in 1 CASE (90050-001-06) / 1 BOTTLE in 1 CARTON / 60 g in 1 BOTTLE”) is a shipping case of 40 cartons, 2,400 g in all: a wholesale pack of identical units, so OpenBill counts one carton of it. So the card starts at one carton: 60 GM. Change it to match your prescription.',
  );
  // With a single bottle of the same amount, the two now agree (2,400 g and 60 g did not).
  const bottle = gm('90050000107', '1 BOTTLE in 1 CARTON (90050-001-07) / 60 g in 1 BOTTLE');
  const both = defaultQuantity([caseRow, bottle]);
  assert.equal(both.qty, 60);
  assert.match(
    both.reason,
    /is a shipping case of 40 cartons, 2,400 g in all: a wholesale pack of identical units, so OpenBill counts one carton of it\. Its package description of the other NDC gives 60 g in one package \(“1 BOTTLE in 1 CARTON \(90050-001-07\) \/ 60 g in 1 BOTTLE”\)\. So the card starts at one carton: 60 GM\./,
  );
  // Several packs, and an NDC FDA does not list.
  const caseB = gm('90050000108', '40 CARTON in 1 CASE (90050-001-08) / 1 BOTTLE in 1 CARTON / 60 g in 1 BOTTLE');
  const unlisted = gm('90050000109', '');
  unlisted.identity = null;
  const many = defaultQuantity([caseRow, caseB, unlisted]);
  assert.equal(many.qty, 60);
  assert.match(many.reason, /2 of this product’s NDCs are wholesale packs of identical units, so OpenBill counts one unit of each; for example, NDC 90050-0001-06 .+ It does not list one of this product’s NDCs\. So the card starts at one unit: 60 GM\./);
  // Counting inner units must give one amount; otherwise the whole packages decide, as before.
  const cups = gm('90050000110', '42 CUP, UNIT-DOSE in 1 CARTON (90050-001-10) / 5 g in 1 CUP, UNIT-DOSE');
  const trays = gm('90050000111', '7 TRAY in 1 CASE (90050-001-11) / 6 CUP, UNIT-DOSE in 1 TRAY / 5 g in 1 CUP, UNIT-DOSE');
  const whole = defaultQuantity([cups, trays]);
  assert.equal(whole.qty, 210, 'one tray (30 g) and a carton of 42 cups disagree; both packages are 210 g');
  assert.match(whole.reason, /gives 210 g in one package for all 2 NDCs of this product/);
  assert.doesNotMatch(whole.reason, /wholesale/);
  const differ = defaultQuantity([caseRow, gm('90050000112', '1 BOTTLE in 1 CARTON (90050-001-12) / 30 g in 1 BOTTLE')]);
  assert.equal(differ.qty, 1);
  assert.match(differ.reason, /give different amounts \(30 g, 2,400 g\)/);
});

test('defaultQuantity: tablets and films under the tongue or against the cheek start at 30', () => {
  for (const [form, route, one, place] of [
    ['TABLET', 'SUBLINGUAL', 'tablet', 'under the tongue'],
    ['TABLET, ORALLY DISINTEGRATING', 'SUBLINGUAL', 'tablet', 'under the tongue'],
    ['TABLET', 'ORAL; SUBLINGUAL', 'tablet', 'under the tongue'],
    ['TABLET', 'BUCCAL', 'tablet', 'against the cheek'],
    ['FILM', 'BUCCAL; SUBLINGUAL', 'film', 'under the tongue or against the cheek'],
    ['FILM, SOLUBLE', 'BUCCAL', 'film', 'against the cheek'],
  ]) {
    const d = defaultQuantity([eaRow({ name: 'FIXTORPHINE 8 MG SL TABLET', identity: { dosage_form: form, route } })]);
    assert.deepEqual([d.qty, [...d.chips], d.form.oral_solid, d.form.mouth, d.form.plain, d.form.one], [30, [30, 60, 90], true, true, false, one], `${form} ${route}`);
    assert.equal(
      d.reason,
      `NADAC prices this product per EA, and the FDA NDC Directory lists its NDC as a ${one} taken ${place} (dosage form “${form}”, route “${route}”), so one EA is one ${one}. OpenBill counts a tablet or film taken under the tongue or against the cheek as an oral solid, like one that is swallowed. The card starts at 30 ${one}s, a common one-month supply of a once-a-day medicine; change it to match your prescription.`,
    );
  }
  // Swallowed and sublingual tablets under one name: still tablets, still 30.
  const a = eaRow({ identity: { dosage_form: 'TABLET', route: 'ORAL' } });
  const b = eaRow({ ndc: '90001000109', identity: { dosage_form: 'TABLET', route: 'SUBLINGUAL' } });
  assert.deepEqual([defaultQuantity([a, b]).qty, defaultQuantity([a, b]).form.mouth], [30, true]);
  // A swallowed tablet stays plain: no note under the quantity.
  assert.equal(defaultQuantity([a]).form.plain, true);
  // With no FDA listing, the NADAC name's SL, SUBLINGUAL or BUCCAL next to a tablet or film.
  const by = (name) => defaultQuantity([eaRow({ name, identity: null })]);
  for (const [name, word, one, place] of [
    ['GRASTEK 2,800 BAU SL TABLET', 'SL', 'tablet', 'under the tongue'],
    ['RAGWITEK SUBLINGUAL TABLET', 'SUBLINGUAL', 'tablet', 'under the tongue'],
    ['FIXTORPHINE 75 MCG BUCCAL FILM', 'BUCCAL', 'film', 'against the cheek'],
    ['FIXTORPHINE 8 MG SL FILM', 'SL', 'film', 'under the tongue'],
  ]) {
    const d = by(name);
    assert.deepEqual([d.qty, d.form.basis, d.form.mouth, d.form.one, d.form.word], [30, 'name', true, one, word], name);
    assert.ok(d.reason.includes(`its NADAC name (“${name}”) says “${word}”, a ${one} taken ${place}, so one EA is one ${one}.`), d.reason);
  }
  for (const name of ['FIXTORPHINE SL', 'FIXTORPHINE 8 MG SL TABLET KIT', 'FIXTRADIOL 10 MCG VAGINAL TABLET', 'FIXTINE 2 MG BUCCAL GUM', 'FIXTORPHINE 8 MG SL CAPSULE']) {
    assert.equal(by(name).qty, 1, name);
  }
});

test('defaultQuantity: an outlier FDA listing does not decide when most NDCs and the NADAC name agree', () => {
  const name = 'FIXTOSTAT 40 MG TABLET';
  const tab = (ndc, form = 'TABLET', route = 'ORAL') => eaRow({ name, ndc, identity: { dosage_form: form, route } });
  const rows = [tab('90001000101'), tab('90001000102', 'TABLET, FILM COATED'), tab('90001000103', 'FILM'), eaRow({ name, ndc: '90001000104', identity: null })];
  const d = defaultQuantity(rows);
  assert.deepEqual([d.qty, [...d.chips], d.form.oral_solid, d.form.plain, d.form.one, d.form.word], [30, [30, 60, 90], true, false, 'tablet', 'TABLET']);
  assert.deepEqual(JSON.parse(JSON.stringify(d.form.outliers)), [{ ndc: '90001000103', dosage_form: 'FILM', route: 'ORAL' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(d.form.daily)), { count: 2, forms: ['TABLET', 'TABLET, FILM COATED'], routes: ['ORAL'] });
  assert.equal(
    d.reason,
    'NADAC prices this product per EA, and its NADAC name (“FIXTOSTAT 40 MG TABLET”) says “TABLET”. The FDA NDC Directory lists 3 of its 4 NDCs (it does not list the other one), 2 of them as oral tablets (dosage forms “TABLET”, “TABLET, FILM COATED”, route “ORAL”), so one EA is one tablet. It lists the other one, NDC 90001-0001-03, as dosage form “FILM” with route “ORAL”. That matches neither the NADAC name nor the product’s other NDCs and looks like an error in the listing, so OpenBill goes by the majority. The card starts at 30 tablets, a common one-month supply of a once-a-day medicine; change it to match your prescription.',
  );
  // Two outliers, each named.
  const two = defaultQuantity([tab('90001000101'), tab('90001000102'), tab('90001000105'), tab('90001000103', 'TABLET', 'PARENTERAL'), tab('90001000104', 'TABLET', 'PARENTERAL')]);
  assert.equal(two.qty, 30);
  assert.match(two.reason, /It lists the other 2 differently: NDC 90001-0001-03 as dosage form “TABLET” with route “PARENTERAL”; NDC 90001-0001-04 as dosage form “TABLET” with route “PARENTERAL”\. Those match neither/);
  // Exactly half is not a majority.
  const half = defaultQuantity([tab('90001000101'), tab('90001000103', 'FILM')]);
  assert.deepEqual([half.qty, half.form.oral_solid, [...half.form.outliers]], [1, false, []]);
  assert.match(half.reason, /and not all of its NDCs are one\. Its NDCs are listed as different dosage forms/);
  // A majority, but a name that does not say tablet or capsule.
  const unnamed = [tab('90001000101'), tab('90001000102'), tab('90001000103', 'FILM')].map((r) => Object.assign(r, { name: 'FIXTOSTAT 40 MG' }));
  const u = defaultQuantity(unnamed);
  assert.equal(u.qty, 1);
  assert.match(u.reason, /not all of its NDCs are one; most are, but its NADAC name does not say tablet or capsule, so OpenBill does not set the others aside\./);
  // A lozenge name is not a tablet or capsule word.
  const loz = [tab('90001000101', 'LOZENGE'), tab('90001000102', 'LOZENGE'), tab('90001000103', 'PASTILLE')].map((r) => Object.assign(r, { name: 'FIXTOL 7.6 MG LOZENGE' }));
  assert.equal(defaultQuantity(loz).qty, 1);
  // Pure: the rows are not changed.
  const before = JSON.stringify(rows);
  defaultQuantity(rows);
  assert.equal(JSON.stringify(rows), before);
});
