// Quality floors CI holds on data/drugs.json (brief, "Testing"; ARCHITECTURE.md, "Tests"):
// at least 70% of rows filed, every source with an https source_url, every record with a
// source_url, no usd record at or below 0, and every record valid. Each floor is checked
// directly on the data here, and again through src/build/quality.js, which writes the same
// floors into docs/DATA-QUALITY.md, so the published table cannot say PASS while this fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRecord } from '../src/core/provenance.js';
import { isoDate } from '../src/core/dates.js';
import { EXTREME_HEADLINE, HONESTY, COST_PLUS, COST_PLUS_CAVEATS, PAID_MAX_USD, PAID_PRIVACY, distinctLabelers, formatSpreadMultiple } from '../src/core/rules.js';
import { formatMoney, formatPercent } from '../src/core/money.js';
import { renderMethodology, BROWSER_FLOOR } from '../src/build/methodology.js';
import {
  analyzeDoc,
  checkFloors,
  collectRecords,
  renderDataQuality,
  pct,
  plural,
  FLOOR_FILED_PERCENT,
  PART_D_UNMATCHED_REASONS,
  PART_B_UNMATCHED_REASONS,
  PART_B_RECONCILED_BY,
} from '../src/build/quality.js';

const DOC = JSON.parse(readFileSync(new URL('../data/drugs.json', import.meta.url), 'utf8'));
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/drugs.v3.sample.json', import.meta.url), 'utf8'));

const HTTPS_RE = /^https:\/\/[^\s/]+\.[^\s]*$/;
const METHODOLOGY_RE = /^methodology\.html#[a-z0-9][a-z0-9-]*$/;

// Every record position the schema defines (ARCHITECTURE.md, schema openbill.drugs/3), listed
// by hand, so a record in an unexpected place shows up as a count mismatch with collectRecords.
function schemaRecords(doc) {
  const out = [];
  const put = (path, rec) => {
    if (rec !== undefined && rec !== null) out.push({ path, record: rec });
  };
  for (const r of doc.rows) {
    const at = `rows[ndc ${r.ndc}]`;
    put(`${at}.nadac`, r.nadac);
    put(`${at}.generic_nadac`, r.generic_nadac);
    if (r.part_b) {
      for (const k of ['bill_units_per_package', 'package_size', 'package_qty']) put(`${at}.part_b.${k}`, r.part_b[k]);
    }
  }
  for (const [k, e] of Object.entries(doc.part_d_names || {})) {
    put(`part_d_names[${JSON.stringify(k)}].avg_per_unit`, e.avg_per_unit);
    put(`part_d_names[${JSON.stringify(k)}].claims`, e.claims);
  }
  for (const [k, e] of Object.entries(doc.part_b_codes || {})) {
    put(`part_b_codes[${JSON.stringify(k)}].payment_limit`, e.payment_limit);
    put(`part_b_codes[${JSON.stringify(k)}].coinsurance_pct`, e.coinsurance_pct);
  }
  return out;
}

const RECORDS = schemaRecords(DOC);

function listSome(items, n = 10) {
  return items.slice(0, n).join('\n  ') + (items.length > n ? `\n  … and ${items.length - n} more` : '');
}

test('data/drugs.json is schema openbill.drugs/3 with rows', () => {
  assert.equal(DOC.schema, 'openbill.drugs/3');
  assert.ok(Array.isArray(DOC.rows) && DOC.rows.length > 0, 'data/drugs.json has no rows');
});

test(`floor: at least ${FLOOR_FILED_PERCENT}% of rows are filed`, () => {
  const n = DOC.rows.length;
  const filed = DOC.rows.filter((r) => r.nadac && r.nadac.state === 'filed').length;
  assert.ok(
    filed * 100 >= FLOOR_FILED_PERCENT * n,
    `only ${filed} of ${n} rows (${pct(filed, n)}) are filed (a row's state is its NADAC price's state); the floor is ${FLOOR_FILED_PERCENT}%`,
  );
});

test('floor: every source has an https source_url', () => {
  const ids = Object.keys(DOC.sources || {});
  assert.ok(ids.length > 0, 'data/drugs.json lists no sources');
  const bad = ids.filter((id) => !(typeof DOC.sources[id].source_url === 'string' && HTTPS_RE.test(DOC.sources[id].source_url)));
  assert.deepEqual(bad, [], `sources without an https:// source_url: ${bad.map((id) => `${id} (${JSON.stringify(DOC.sources[id].source_url)})`).join(', ')}`);
});

test('floor: every record has a source_url', () => {
  const bad = RECORDS.filter(({ record }) => {
    const u = record.source_url;
    return !(typeof u === 'string' && (HTTPS_RE.test(u) || METHODOLOGY_RE.test(u)));
  });
  assert.equal(
    bad.length,
    0,
    `${bad.length} of ${RECORDS.length} records have no https:// or methodology.html# source_url:\n  ${listSome(bad.map((x) => `${x.path}: ${JSON.stringify(x.record.source_url)}`))}`,
  );
});

test('floor: no usd record is 0 or less', () => {
  const usd = RECORDS.filter(({ record }) => record.kind === 'usd');
  assert.ok(usd.length > 0, 'no usd records found');
  const bad = usd.filter(({ record }) => !(typeof record.value === 'number' && Number.isFinite(record.value) && record.value > 0));
  assert.equal(bad.length, 0, `${bad.length} of ${usd.length} usd records are 0, negative or not a number:\n  ${listSome(bad.map((x) => `${x.path}: ${JSON.stringify(x.record.value)}`))}`);
});

test('every record validates', () => {
  const bad = [];
  for (const { path, record } of RECORDS) {
    const p = validateRecord(record);
    if (p.length) bad.push(`${path}: ${p.join('; ')}`);
  }
  assert.equal(bad.length, 0, `${bad.length} of ${RECORDS.length} records fail validateRecord():\n  ${listSome(bad)}`);
});

test('no record hides outside the places the schema puts records', () => {
  const found = collectRecords(DOC);
  const expected = new Set(RECORDS.map((x) => x.path));
  const extra = found.filter((x) => !expected.has(x.path)).map((x) => x.path);
  assert.deepEqual(extra, [], `records outside the schema's record fields:\n  ${listSome(extra)}`);
  assert.equal(found.length, RECORDS.length);
});

test('the builder counts records and rows by state as the data has them', () => {
  const byState = {};
  for (const { record } of RECORDS) byState[record.state] = (byState[record.state] || 0) + 1;
  assert.deepEqual(DOC.counts.records_by_state, byState, 'counts.records_by_state disagrees with the records');
  const rowState = {};
  for (const r of DOC.rows) rowState[r.nadac.state] = (rowState[r.nadac.state] || 0) + 1;
  assert.deepEqual(DOC.counts.rows_by_state, rowState, 'counts.rows_by_state disagrees with the rows');
  assert.equal(DOC.counts.rows, DOC.rows.length);
});

test('every count DATA-QUALITY.md recomputes matches counts in data/drugs.json', () => {
  const { mismatches } = analyzeDoc(DOC);
  assert.deepEqual(mismatches, [], `recomputed counts disagree with counts:\n  ${listSome(mismatches.map((m) => `${m.key}: builder ${JSON.stringify(m.builder)}, recomputed ${JSON.stringify(m.recomputed)}`))}`);
});

test('every null join is accounted for and described', () => {
  const c = DOC.counts;
  const sum = (m) => Object.values(m).reduce((a, n) => a + n, 0);
  assert.equal(sum(c.part_d_unmatched) + c.part_d_matched, DOC.rows.length, 'Part D: matched + unmatched reasons must add up to the rows');
  assert.equal(sum(c.part_b_unmatched) + c.part_b_matched, DOC.rows.length, 'Part B: matched + unmatched reasons must add up to the rows');
  const undescribedD = Object.keys(c.part_d_unmatched).filter((k) => !Object.hasOwn(PART_D_UNMATCHED_REASONS, k));
  const undescribedB = Object.keys(c.part_b_unmatched).filter((k) => !Object.hasOwn(PART_B_UNMATCHED_REASONS, k));
  assert.deepEqual(undescribedD, [], 'Part D reason codes with no description in src/build/quality.js');
  assert.deepEqual(undescribedB, [], 'Part B reason codes with no description in src/build/quality.js');
});

test('the floors in DATA-QUALITY.md pass, and say so', () => {
  const floors = checkFloors(DOC);
  assert.deepEqual(
    floors.map((f) => f.id),
    ['rows-filed', 'source-urls', 'record-urls', 'usd-positive'],
  );
  const failed = floors.filter((f) => !f.pass);
  assert.deepEqual(failed, [], `failing floors:\n  ${failed.map((f) => `${f.label}: ${f.detail}`).join('\n  ')}`);
  const md = renderDataQuality(DOC);
  const floorTable = md.slice(md.indexOf('## Floors'));
  assert.equal((floorTable.match(/\| PASS \|/g) || []).length, 4);
  assert.doesNotMatch(md, /FAIL/);
});

test('DATA-QUALITY.md starts with the do-not-edit note and is deterministic', () => {
  const md = renderDataQuality(DOC);
  assert.equal(md.split('\n')[0], '<!-- generated by build.js from data/drugs.json — do not edit -->');
  assert.ok(md.endsWith('\n') && !md.endsWith('\n\n'));
  assert.doesNotMatch(md, /\r/);
  assert.equal(renderDataQuality(structuredClone(DOC)), md, 'the same data must give the same bytes');
});

// The floor logic itself, on the small v3 fixture, so a floor cannot pass by never failing.
test('floors fail when the data breaks them', () => {
  assert.ok(checkFloors(FIXTURE).every((f) => f.pass), 'the fixture passes every floor');
  const bad = structuredClone(FIXTURE);
  const n = bad.rows.length;
  const estimated = Math.ceil(n * 0.31);
  for (const r of bad.rows.slice(0, estimated)) r.nadac.state = 'estimated';
  bad.rows[n - 1].nadac.value = 0;
  bad.sources.nadac.source_url = 'http://data.medicaid.gov/x';
  delete bad.rows[n - 2].nadac.source_url;
  const byId = Object.fromEntries(checkFloors(bad).map((f) => [f.id, f]));
  assert.equal(byId['rows-filed'].pass, false);
  assert.match(byId['rows-filed'].detail, new RegExp(`^${n - estimated} of ${n} rows`));
  assert.equal(byId['source-urls'].pass, false);
  assert.match(byId['source-urls'].detail, /nadac/);
  assert.equal(byId['record-urls'].pass, false);
  assert.equal(byId['usd-positive'].pass, false);
  const md = renderDataQuality(bad);
  assert.equal((md.match(/\*\*FAIL\*\*/g) || []).length, 4);
});

test('counts.part_b_unit_reconciled_by is described and must add up to the reconciled rows', () => {
  const by = DOC.counts.part_b_unit_reconciled_by;
  assert.ok(by && typeof by === 'object', 'data/drugs.json has no counts.part_b_unit_reconciled_by');
  const undescribed = Object.keys(by).filter((k) => !Object.hasOwn(PART_B_RECONCILED_BY, k));
  assert.deepEqual(undescribed, [], 'reconcile methods with no description in src/build/quality.js');
  // A breakdown that does not add up is reported as a mismatch, not published as a statistic.
  const bad = structuredClone(FIXTURE);
  const reconciled = bad.rows.filter((r) => r.part_b && r.part_b.package_unit !== null && r.part_b.package_unit !== undefined).length;
  bad.counts.part_b_unit_reconciled_by = { fda_amount: reconciled + 1 };
  assert.ok(analyzeDoc(bad).mismatches.some((m) => m.key === 'part_b_unit_reconciled_by (sum)'));
  const good = structuredClone(FIXTURE); // analyzeDoc caches per doc object, so a fresh one
  good.counts.part_b_unit_reconciled_by = { fda_amount: reconciled };
  assert.ok(!analyzeDoc(good).mismatches.some((m) => m.key === 'part_b_unit_reconciled_by (sum)'));
});

// methodology.html must describe what the page and the data do (reviews NUM-10, DOC-6, DOC-1).
test('methodology.html describes the multi-route rule, the extreme headline, the browser floor and UTC ages', () => {
  const { bodyHtml } = renderMethodology({ doc: DOC });
  const text = bodyHtml.replace(/<[^>]+>/g, '');
  // Every Part D reason the data records is described, the multi-route ones included.
  assert.doesNotMatch(text, /not yet described on this page/);
  for (const k of Object.keys(DOC.counts.part_d_unmatched)) assert.ok(text.includes(PART_D_UNMATCHED_REASONS[k]), `reason ${k} is not on the page`);
  assert.match(bodyHtml, /<li id="multi-route">/);
  // The card leads with the headline for an extreme spread; the test is made before rounding.
  assert.ok(text.includes(`“${EXTREME_HEADLINE}”`), 'the extreme-gap headline is not quoted');
  assert.match(text, /tested on the ratio at full precision, before it is rounded/);
  // A blank Part D outlier flag is explained in the provenance panel's reason, not on the card.
  assert.doesNotMatch(text, /the card says so/);
  assert.match(text, /a blank flag counts as not flagged, and the provenance panel says so/);
  // The browser floor, from the same constant the docs test checks.
  for (const [name, version] of BROWSER_FLOOR) assert.ok(text.includes(`${name} ${version}`), `${name} ${version} missing`);
  // Ages count from today's UTC date: no claim that the viewer's time zone matters.
  assert.match(text, /today’s UTC date/);
  assert.doesNotMatch(text, /time zone behind UTC/);
});

// The page counts a code's labelers as companies (distinctLabelers, review PARTB-8) and shows a
// spread just inside a threshold with enough digits (formatSpreadMultiple); methodology.html said
// the opposite of both (final pass).
test('methodology.html counts labelers as the page does and shows 0.2046 as the page does', () => {
  const { bodyHtml } = renderMethodology({ doc: DOC });
  const text = bodyHtml.replace(/<[^>]+>/g, '');
  const codes = Object.values(DOC.part_b_codes);
  const single = codes.filter((c) => distinctLabelers(c.labelers).length === 1).length;
  assert.equal(analyzeDoc(DOC).singleLabelerCodes, single);
  assert.ok(text.includes(`${single} of the ${codes.length} codes have a single labeler`), 'single-labeler count differs from the page');
  assert.doesNotMatch(text, /does not merge/);
  assert.doesNotMatch(text, /0\.2046 is shown as 0\.20×/);
  assert.ok(text.includes(`card shows it as ${formatSpreadMultiple(0.2046)}`));
  // The builder's own count stays a count of names, and still agrees with the data.
  assert.ok(!analyzeDoc(DOC).mismatches.some((m) => m.key === 'part_b_single_labeler_codes'));
});

// Phase 2 (decisions 39, 40, 41, 43): the cost-plus estimate, "what you paid" and the drug pages
// are described from the core's own constants, and the honesty lines appear word for word.
const plain = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

test('methodology.html describes the cost-plus estimate from COST_PLUS, with its sources and what it is not', () => {
  const { bodyHtml } = renderMethodology({ doc: DOC });
  const text = plain(bodyHtml);
  for (const id of ['cost-plus', 'what-you-paid', 'drug-pages', 'limit-cost-plus']) assert.match(bodyHtml, new RegExp(`id="${id}"`), `#${id}`);
  assert.ok(text.includes(`${formatPercent(COST_PLUS.markup_pct)} of that, rounded half-up to the cent`), 'markup parameter');
  assert.ok(text.includes(`${formatMoney(COST_PLUS.fee_usd)} ${COST_PLUS.basis}`), 'fee parameter');
  assert.ok(text.includes(COST_PLUS.description), 'where the parameters come from');
  for (const s of COST_PLUS.sources) assert.ok(bodyHtml.includes(`href="${s.url}"`), `source link ${s.url}`);
  for (const c of COST_PLUS_CAVEATS) assert.ok(text.includes(c), `caveat: ${c}`);
  // The owner's decision: never call it a typical cash price; no spread against it.
  assert.doesNotMatch(text, /typical cash price/i);
  assert.match(text, /It is not compared with NADAC as a spread/);
  // The showcase is the worked example, with the numbers decision 45 records.
  assert.match(text, /for 30 EA of ARIPIPRAZOLE 10 MG TABLET: pharmacies pay \$3\.35; 15% of that, rounded to the cent, is \$0\.50; with the \$5\.00 fee the estimate is \$8\.85\./);
});

test('methodology.html says what happens to what you paid, and gives the honesty lines verbatim', () => {
  const { bodyHtml } = renderMethodology({ doc: DOC });
  const text = plain(bodyHtml);
  assert.ok(text.includes(`at most ${formatMoney(PAID_MAX_USD)}`), 'the upper limit');
  assert.ok(text.includes(PAID_PRIVACY), 'the privacy sentence, as on the card');
  assert.match(text, /your browser’s history keeps it/);
  assert.doesNotMatch(text, /stored, logged or sent|stays only in/, 'no claim that the amount leaves no trace');
  assert.match(text, /A link you share carries your amount/);
  assert.ok(text.includes('“You paid 3.6× what pharmacies pay for this pack, and 1.4× the cost-plus estimate.”'), 'the worked example sentence');
  for (const h of HONESTY) assert.ok(text.includes(h.text), `honesty line: ${h.text}`);
});

test('pharmacologic class coverage is recomputed from the rows and checked against counts', () => {
  const a = analyzeDoc(DOC);
  assert.equal(a.pharmClasses.rows, DOC.counts.identity_with_pharm_classes);
  assert.equal(a.pharmClasses.epcClasses, DOC.counts.epc_classes);
  assert.ok(a.pharmClasses.epcRows <= a.pharmClasses.rows && a.pharmClasses.rows <= a.identity);
  assert.ok(a.pharmClasses.productsWithEpc > 0 && a.pharmClasses.productsWithEpc <= a.products);
  assert.ok(a.costPlus.products > 0 && a.costPlus.products <= a.products);
  const md = renderDataQuality(DOC);
  assert.ok(md.includes('| FDA pharmacologic classes (`identity.pharm_classes`) |'), 'coverage row in DATA-QUALITY.md');
  assert.match(md, /^Cost-plus estimates \(\[the rule\]\(\.\.\/methodology\.html#cost-plus\)\)/m);
  const bad = structuredClone(FIXTURE);
  bad.counts.epc_classes = analyzeDoc(FIXTURE).pharmClasses.epcClasses + 1;
  assert.ok(analyzeDoc(bad).mismatches.some((m) => m.key === 'epc_classes'), 'a wrong epc_classes count is reported');
  const none = structuredClone(FIXTURE);
  delete none.counts.epc_classes;
  delete none.counts.identity_with_pharm_classes;
  assert.ok(!analyzeDoc(none).mismatches.some((m) => m.key === 'epc_classes' || m.key === 'identity_with_pharm_classes'), 'a doc without the counts is not a mismatch');
});

// The page takes today from isoDate(new Date()): the UTC calendar date whatever the time zone
// (decision 29), which is what ARCHITECTURE.md and methodology.html say.
test('isoDate gives the UTC calendar date, so the time zone never changes an age', () => {
  assert.equal(isoDate(new Date('2026-10-18T02:00:00Z')), '2026-10-18'); // 19:00 on the 17th in Los Angeles
  assert.equal(isoDate(new Date('2026-10-17T23:30:00-10:00')), '2026-10-18');
  assert.equal(isoDate(new Date('2026-10-18T09:00:00+14:00')), '2026-10-17'); // Kiritimati
});

test('pct and plural never show a real count as nothing', () => {
  assert.equal(pct(27083, 30031), '90.2%');
  assert.equal(pct(30031, 30031), '100.0%');
  assert.equal(pct(0, 30031), '0.0%');
  assert.equal(pct(3, 30031), '<0.1%');
  assert.equal(pct(1, 0), 'n/a');
  assert.equal(pct(1, 8), '12.5%');
  assert.equal(plural(1, 'day'), '1 day');
  assert.equal(plural(14, 'day'), '14 days');
  assert.equal(plural(undefined, 'row'), 'an unrecorded number of rows');
});
