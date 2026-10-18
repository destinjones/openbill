// data/drugs.json against the contract: docs/ARCHITECTURE.md, "Price records" and
// "`data/drugs.json` — schema `openbill.drugs/3`". Every record (on rows and in the shared
// tables) must pass validateRecord(), carry the provenance of the source it came from, and
// never be a zero standing in for a blank. Each check collects every problem and reports the
// first few, so one run shows the size of a regression.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { validateRecord, RECORD_FIELDS, OPTIONAL_RECORD_FIELDS, KINDS } from '../src/core/provenance.js';
import { isNdc11, normalizeNdc } from '../src/core/ndc.js';
import { isIsoDate, parsePeriod } from '../src/core/dates.js';
import { NADAC_EXPLANATION_CODES, NADAC_CARRIED_FORWARD_CODES } from '../src/core/sources.js';

const DATA_URL = new URL('../data/drugs.json', import.meta.url);
const MANIFEST_URL = new URL('../tools/cache/manifest.json', import.meta.url);
const doc = JSON.parse(readFileSync(DATA_URL, 'utf8'));

const SCHEMA = 'openbill.drugs/3';
const TOP_KEYS = ['schema', 'sources', 'counts', 'part_d_names', 'part_b_codes', 'rows'];
const REQUIRED_SOURCES = ['nadac', 'fda_ndc', 'partd', 'asp_limits', 'asp_crosswalk'];
const OPTIONAL_SOURCES = ['openfda_ndc'];
const PERIOD_SOURCES = ['partd', 'asp_limits', 'asp_crosswalk'];
const SOURCE_FIELDS = [
  'name', 'title', 'publisher', 'license', 'source_url', 'download_url', 'source_file',
  'sha256', 'bytes', 'period', 'as_of_date', 'retrieved_date',
];
const UNITS = ['EA', 'ML', 'GM'];
const RATE_CLASSES = ['G', 'B', 'B-ANDA', 'B-BIO'];
const ROW_FIELDS = ['ndc', 'name', 'unit', 'otc', 'rate_class', 'explanation_codes', 'carried_forward', 'identity', 'nadac', 'part_d', 'part_b'];
const ROW_OPTIONAL = ['generic_nadac'];
const IDENTITY_FIELDS = ['source', 'package_ndc', 'proprietary_name', 'nonproprietary_name', 'dosage_form', 'route', 'strength', 'labeler', 'package_description'];
const IDENTITY_OPTIONAL = ['rxcui'];
const PART_D_REF_FIELDS = ['key', 'basis'];
const PART_B_ROW_FIELDS = ['hcpcs', 'bill_units_per_package', 'package_size', 'package_qty', 'package_unit'];
const PART_D_NAME_FIELDS = ['brand_name', 'generic_name', 'avg_per_unit', 'claims', 'outlier'];
const PART_B_CODE_FIELDS = ['hcpcs', 'hcpcs_dosage', 'short_description', 'payment_limit', 'coinsurance_pct', 'labelers'];
// Records the contract lists that may be left out (a blank source cell is omitted, never 0).
const PART_D_NAME_RECORDS = ['avg_per_unit', 'claims'];
const PART_B_CODE_RECORDS = ['payment_limit', 'coinsurance_pct'];
const PART_B_ROW_RECORDS = ['bill_units_per_package', 'package_size', 'package_qty'];

const SHOW = 15;

/** Fail with the first few problems and the total. */
function noProblems(problems, what) {
  if (problems.length === 0) return;
  const head = problems.slice(0, SHOW).map((p) => `  - ${p}`).join('\n');
  const more = problems.length > SHOW ? `\n  ... and ${problems.length - SHOW} more` : '';
  assert.fail(`${what}: ${problems.length} problem(s)\n${head}${more}`);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const isHttps = (v) => typeof v === 'string' && /^https:\/\/[^\s/]+\.[^\s]+$/.test(v);

/** Problems with the key set of obj: missing required keys and keys the contract doesn't name. */
function keyProblems(obj, required, optional, where) {
  const out = [];
  for (const k of required) if (!hasOwn(obj, k)) out.push(`${where}: missing field "${k}"`);
  for (const k of Object.keys(obj)) {
    if (!required.includes(k) && !optional.includes(k)) out.push(`${where}: unexpected field "${k}"`);
  }
  return out;
}

const rows = Array.isArray(doc.rows) ? doc.rows : [];
const sources = isObj(doc.sources) ? doc.sources : {};
const partDNames = isObj(doc.part_d_names) ? doc.part_d_names : {};
const partBCodes = isObj(doc.part_b_codes) ? doc.part_b_codes : {};

/**
 * Every record in the doc, once, with where it is, which source it must come from and the
 * constraints the contract puts on it.
 * @returns {{ where: string, rec: object, source: string, kind: string, per?: string|null }[]}
 *   per: undefined = not checked, null = must be absent, string = must equal
 */
function allRecords() {
  const out = [];
  for (const r of rows) {
    if (!isObj(r)) continue;
    const at = `row ${r.ndc}`;
    out.push({ where: `${at} nadac`, rec: r.nadac, source: 'nadac', kind: 'usd', per: r.unit });
    if (hasOwn(r, 'generic_nadac')) {
      out.push({ where: `${at} generic_nadac`, rec: r.generic_nadac, source: 'nadac', kind: 'usd', per: r.unit });
    }
    if (isObj(r.part_b)) {
      const b = r.part_b;
      const unit = b.package_unit;
      for (const [k, kind, per] of [
        ['bill_units_per_package', 'count', null],
        ['package_size', 'quantity', unit === null ? null : unit],
        ['package_qty', 'count', null],
      ]) {
        if (hasOwn(b, k)) out.push({ where: `${at} part_b.${k}`, rec: b[k], source: 'asp_crosswalk', kind, per });
      }
    }
  }
  for (const [key, e] of Object.entries(partDNames)) {
    if (!isObj(e)) continue;
    if (hasOwn(e, 'avg_per_unit')) out.push({ where: `part_d_names[${key}].avg_per_unit`, rec: e.avg_per_unit, source: 'partd', kind: 'usd' });
    if (hasOwn(e, 'claims')) out.push({ where: `part_d_names[${key}].claims`, rec: e.claims, source: 'partd', kind: 'count', per: 'claim' });
  }
  for (const [code, e] of Object.entries(partBCodes)) {
    if (!isObj(e)) continue;
    if (hasOwn(e, 'payment_limit')) {
      out.push({ where: `part_b_codes[${code}].payment_limit`, rec: e.payment_limit, source: 'asp_limits', kind: 'usd', per: e.hcpcs_dosage });
    }
    if (hasOwn(e, 'coinsurance_pct')) {
      out.push({ where: `part_b_codes[${code}].coinsurance_pct`, rec: e.coinsurance_pct, source: 'asp_limits', kind: 'percent', per: null });
    }
  }
  return out;
}

const RECORDS = allRecords();

// ---------------------------------------------------------------------------------------
// Top level and sources

test('data/drugs.json has schema openbill.drugs/3 and exactly the contract top-level keys, in order', () => {
  assert.equal(doc.schema, SCHEMA);
  assert.deepEqual(Object.keys(doc), TOP_KEYS);
  assert.ok(isObj(doc.sources), 'sources is an object');
  assert.ok(isObj(doc.counts), 'counts is an object');
  assert.ok(isObj(doc.part_d_names), 'part_d_names is an object');
  assert.ok(isObj(doc.part_b_codes), 'part_b_codes is an object');
  assert.ok(Array.isArray(doc.rows) && doc.rows.length > 0, 'rows is a non-empty array');
});

test('sources: the five contract ids, every listed field, https URLs, a sha256 and a byte count', () => {
  const problems = [];
  for (const id of REQUIRED_SOURCES) if (!hasOwn(sources, id)) problems.push(`missing source "${id}"`);
  for (const id of Object.keys(sources)) {
    if (!REQUIRED_SOURCES.includes(id) && !OPTIONAL_SOURCES.includes(id)) problems.push(`unknown source id "${id}"`);
  }
  for (const [id, s] of Object.entries(sources)) {
    const at = `sources.${id}`;
    if (!isObj(s)) {
      problems.push(`${at} is not an object`);
      continue;
    }
    for (const f of SOURCE_FIELDS) if (!hasOwn(s, f)) problems.push(`${at}: missing field "${f}"`);
    for (const f of ['name', 'title', 'publisher', 'source_file']) {
      if (!nonEmpty(s[f])) problems.push(`${at}.${f} must be a non-empty string, got ${JSON.stringify(s[f])}`);
    }
    for (const f of ['license', 'source_url', 'download_url']) {
      if (!isHttps(s[f])) problems.push(`${at}.${f} must be an https:// URL, got ${JSON.stringify(s[f])}`);
    }
    if (typeof s.source_file === 'string' && /[\\/]/.test(s.source_file)) {
      problems.push(`${at}.source_file must be a bare file name, got ${JSON.stringify(s.source_file)}`);
    }
    if (!(typeof s.sha256 === 'string' && /^[0-9a-f]{64}$/.test(s.sha256))) {
      problems.push(`${at}.sha256 must be 64 lowercase hex digits, got ${JSON.stringify(s.sha256)}`);
    }
    if (!(Number.isInteger(s.bytes) && s.bytes > 0)) problems.push(`${at}.bytes must be a positive integer, got ${JSON.stringify(s.bytes)}`);
    for (const f of ['as_of_date', 'retrieved_date']) {
      if (!isIsoDate(s[f])) problems.push(`${at}.${f} must be YYYY-MM-DD, got ${JSON.stringify(s[f])}`);
    }
    if (PERIOD_SOURCES.includes(id)) {
      if (parsePeriod(s.period) === null) problems.push(`${at}.period must be YYYY-MM-DD/YYYY-MM-DD (period data), got ${JSON.stringify(s.period)}`);
    } else if (s.period !== null) {
      problems.push(`${at}.period must be null (not period data), got ${JSON.stringify(s.period)}`);
    }
  }
  noProblems(problems, 'sources');
});

test('sources match tools/cache/manifest.json (file, sha256, bytes) when the cache is present', (t) => {
  if (!existsSync(MANIFEST_URL)) {
    t.skip('tools/cache/manifest.json not present (the raw cache is never committed)');
    return;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_URL, 'utf8'));
  const problems = [];
  for (const [id, s] of Object.entries(sources)) {
    const m = manifest[id];
    if (!isObj(m)) {
      problems.push(`manifest has no entry "${id}"`);
      continue;
    }
    if (m.file !== s.source_file) problems.push(`${id}: data says ${s.source_file}, manifest says ${m.file}; rebuild data/drugs.json`);
    if (m.sha256 !== s.sha256) problems.push(`${id}: sha256 differs from the manifest; rebuild data/drugs.json`);
    if (m.bytes !== s.bytes) problems.push(`${id}: bytes ${s.bytes} differ from the manifest's ${m.bytes}`);
  }
  noProblems(problems, 'sources vs manifest');
});

test('counts is present and counts.rows is the number of rows', () => {
  assert.ok(isObj(doc.counts), 'counts is an object');
  assert.ok(Object.keys(doc.counts).length > 0, 'counts is not empty');
  assert.equal(doc.counts.rows, rows.length);
});

// ---------------------------------------------------------------------------------------
// Records

test('every record (rows and tables) passes validateRecord()', () => {
  assert.ok(RECORDS.length > rows.length, `found ${RECORDS.length} records for ${rows.length} rows`);
  const problems = [];
  for (const { where, rec } of RECORDS) {
    for (const p of validateRecord(rec)) problems.push(`${where}: ${p}`);
  }
  noProblems(problems, 'validateRecord');
});

test('no record has a null field: optional fields are left out, never written as null', () => {
  const problems = [];
  for (const { where, rec } of RECORDS) {
    if (!isObj(rec)) continue;
    for (const f of [...RECORD_FIELDS, ...OPTIONAL_RECORD_FIELDS]) {
      if (hasOwn(rec, f) && (rec[f] === null || rec[f] === undefined)) problems.push(`${where}: "${f}" is ${rec[f]}`);
    }
  }
  noProblems(problems, 'null record fields');
});

test('every record is filed, has the expected kind and per, and carries the provenance of its source', () => {
  const problems = [];
  for (const { where, rec, source, kind, per } of RECORDS) {
    if (!isObj(rec)) {
      problems.push(`${where}: not a record object`);
      continue;
    }
    const s = sources[source];
    if (rec.state !== 'filed') problems.push(`${where}: state ${JSON.stringify(rec.state)}; the Python builders write filed facts only`);
    if (rec.kind !== kind) problems.push(`${where}: kind ${JSON.stringify(rec.kind)}, expected ${kind}`);
    if (kind === 'count' && !Number.isInteger(rec.value)) problems.push(`${where}: count ${rec.value} is not a whole number`);
    if (per === null && hasOwn(rec, 'per')) problems.push(`${where}: has per ${JSON.stringify(rec.per)}, expected none`);
    if (typeof per === 'string' && rec.per !== per) problems.push(`${where}: per ${JSON.stringify(rec.per)}, expected ${JSON.stringify(per)}`);
    if (!isObj(s)) continue;
    for (const [rf, sf] of [['source_name', 'name'], ['source_url', 'source_url'], ['source_file', 'source_file'], ['as_of_date', 'as_of_date'], ['retrieved_date', 'retrieved_date']]) {
      if (rec[rf] !== s[sf]) problems.push(`${where}: ${rf} ${JSON.stringify(rec[rf])} differs from sources.${source}.${sf} ${JSON.stringify(s[sf])}`);
    }
    if (s.period === null) {
      if (hasOwn(rec, 'period')) problems.push(`${where}: has a period but sources.${source} is not period data`);
      if (typeof rec.effective_date === 'string' && typeof rec.as_of_date === 'string' && rec.effective_date > rec.as_of_date) {
        problems.push(`${where}: effective_date ${rec.effective_date} is after the file's as_of_date ${rec.as_of_date}`);
      }
    } else {
      const p = parsePeriod(s.period);
      if (rec.period !== s.period) problems.push(`${where}: period ${JSON.stringify(rec.period)}, expected sources.${source}.period ${s.period}`);
      if (p && rec.effective_date !== p.start) {
        problems.push(`${where}: effective_date ${rec.effective_date} is not the start of the period ${s.period}`);
      }
    }
  }
  noProblems(problems, 'record provenance');
});

test('no usd value is 0 or less anywhere in the file, and every record-shaped object is a valid record', () => {
  const problems = [];
  let seen = 0;
  const walk = (v, path) => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (!isObj(v)) return;
    if (hasOwn(v, 'kind') && hasOwn(v, 'value') && KINDS.includes(v.kind)) {
      seen++;
      if (v.kind === 'usd' && !(typeof v.value === 'number' && v.value > 0)) problems.push(`${path}: usd value ${JSON.stringify(v.value)}`);
      for (const p of validateRecord(v)) problems.push(`${path}: ${p}`);
    }
    for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(doc, 'doc');
  assert.equal(seen, RECORDS.length, 'records found by walking the file equal the records the contract places');
  noProblems(problems, 'usd values');
});

// ---------------------------------------------------------------------------------------
// Rows

test('rows: every field and type per the contract', () => {
  const codes = Object.keys(NADAC_EXPLANATION_CODES);
  const problems = [];
  rows.forEach((r, i) => {
    const at = `row ${i} (${isObj(r) ? r.ndc : '?'})`;
    if (!isObj(r)) {
      problems.push(`${at}: not an object`);
      return;
    }
    problems.push(...keyProblems(r, ROW_FIELDS, ROW_OPTIONAL, at));
    if (!isNdc11(r.ndc)) problems.push(`${at}: ndc ${JSON.stringify(r.ndc)} is not 11 digits`);
    if (!nonEmpty(r.name)) problems.push(`${at}: name must be a non-empty string`);
    if (!UNITS.includes(r.unit)) problems.push(`${at}: unit ${JSON.stringify(r.unit)} not in ${UNITS.join('|')}`);
    if (typeof r.otc !== 'boolean') problems.push(`${at}: otc must be a boolean`);
    if (!RATE_CLASSES.includes(r.rate_class)) problems.push(`${at}: rate_class ${JSON.stringify(r.rate_class)} not in ${RATE_CLASSES.join('|')}`);
    const ec = r.explanation_codes;
    if (!Array.isArray(ec) || ec.length === 0 || ec.some((c) => !codes.includes(c)) || new Set(ec).size !== ec.length) {
      problems.push(`${at}: explanation_codes ${JSON.stringify(ec)} must be a non-empty list of distinct NADAC codes (${codes.join(', ')})`);
    }
    if (typeof r.carried_forward !== 'boolean') problems.push(`${at}: carried_forward must be a boolean`);
    else if (Array.isArray(ec) && r.carried_forward !== ec.some((c) => NADAC_CARRIED_FORWARD_CODES.includes(c))) {
      problems.push(`${at}: carried_forward ${r.carried_forward} disagrees with explanation codes ${JSON.stringify(ec)} (2 or 4 mean carried forward)`);
    }
    if (!isObj(r.nadac)) problems.push(`${at}: nadac must be a record`);
    if (hasOwn(r, 'generic_nadac') && r.rate_class === 'G') problems.push(`${at}: generic_nadac on a generic (G) row; the contract puts it on brand rows`);

    if (r.identity !== null) {
      const id = r.identity;
      if (!isObj(id)) problems.push(`${at}: identity must be null or an object`);
      else {
        problems.push(...keyProblems(id, IDENTITY_FIELDS, IDENTITY_OPTIONAL, `${at} identity`));
        if (id.source !== 'fda_ndc') problems.push(`${at}: identity.source ${JSON.stringify(id.source)}, expected "fda_ndc"`);
        for (const f of ['package_ndc', 'package_description']) {
          if (!nonEmpty(id[f])) problems.push(`${at}: identity.${f} must be a non-empty string`);
        }
        for (const f of ['proprietary_name', 'nonproprietary_name', 'dosage_form', 'route', 'strength', 'labeler']) {
          if (id[f] !== null && !nonEmpty(id[f])) problems.push(`${at}: identity.${f} must be a non-empty string or null, got ${JSON.stringify(id[f])}`);
        }
        if (nonEmpty(id.package_ndc) && nonEmpty(id.package_description) && !id.package_description.includes(`(${id.package_ndc})`)) {
          problems.push(`${at}: identity.package_description does not name its package NDC ${id.package_ndc}`);
        }
      }
    }

    if (r.part_d !== null) {
      const d = r.part_d;
      if (!isObj(d)) problems.push(`${at}: part_d must be null or { key, basis }`);
      else {
        problems.push(...keyProblems(d, PART_D_REF_FIELDS, [], `${at} part_d`));
        if (!nonEmpty(d.key)) problems.push(`${at}: part_d.key must be a non-empty string`);
        if (d.basis !== 'brand' && d.basis !== 'generic') problems.push(`${at}: part_d.basis ${JSON.stringify(d.basis)} not brand|generic`);
      }
    }

    if (r.part_b !== null) {
      const b = r.part_b;
      if (!isObj(b)) problems.push(`${at}: part_b must be null or an object`);
      else {
        problems.push(...keyProblems(b, ['hcpcs', 'package_unit'], PART_B_ROW_RECORDS, `${at} part_b`));
        if (!nonEmpty(b.hcpcs)) problems.push(`${at}: part_b.hcpcs must be a non-empty string`);
        if (b.package_unit !== null && !UNITS.includes(b.package_unit)) {
          problems.push(`${at}: part_b.package_unit ${JSON.stringify(b.package_unit)} not in ${UNITS.join('|')} or null`);
        }
        if (b.package_unit !== null && b.package_unit !== r.unit) {
          problems.push(`${at}: part_b.package_unit ${b.package_unit} is set but is not the row's NADAC unit ${r.unit}`);
        }
        for (const k of PART_B_ROW_RECORDS) if (hasOwn(b, k) && !isObj(b[k])) problems.push(`${at}: part_b.${k} must be a record`);
      }
    }
  });
  noProblems(problems, 'row fields');
});

test('NDC-11 is unique across rows and rows are sorted by name, then ndc', () => {
  const problems = [];
  const seen = new Map();
  rows.forEach((r, i) => {
    if (seen.has(r.ndc)) problems.push(`ndc ${r.ndc} appears at rows ${seen.get(r.ndc)} and ${i}`);
    else seen.set(r.ndc, i);
    if (i > 0) {
      const p = rows[i - 1];
      if (p.name > r.name || (p.name === r.name && p.ndc >= r.ndc)) {
        problems.push(`rows ${i - 1} and ${i} out of order: ${JSON.stringify([p.name, p.ndc])} then ${JSON.stringify([r.name, r.ndc])}`);
      }
    }
  });
  noProblems(problems, 'NDC uniqueness and order');
});

test('NDC join: normalizeNdc(identity.package_ndc) === row.ndc for every row with an identity', () => {
  const problems = [];
  let joined = 0;
  for (const r of rows) {
    if (!isObj(r.identity)) continue;
    joined++;
    const n = normalizeNdc(r.identity.package_ndc);
    if (n !== r.ndc) problems.push(`row ${r.ndc}: identity.package_ndc ${JSON.stringify(r.identity.package_ndc)} normalizes to ${n}`);
  }
  assert.ok(joined > 0, 'at least one row has an FDA identity');
  noProblems(problems, 'NDC join');
});

// ---------------------------------------------------------------------------------------
// Tables

test('part_d_names: keyed "<Brnd_Name>|<Gnrc_Name>", contract fields, per = the NADAC unit its rows share', () => {
  const problems = [];
  for (const [key, e] of Object.entries(partDNames)) {
    const at = `part_d_names[${key}]`;
    if (!isObj(e)) {
      problems.push(`${at}: not an object`);
      continue;
    }
    problems.push(...keyProblems(e, ['brand_name', 'generic_name', 'outlier'], PART_D_NAME_RECORDS, at));
    if (!nonEmpty(e.brand_name) || !nonEmpty(e.generic_name)) problems.push(`${at}: brand_name and generic_name must be non-empty strings`);
    else if (key !== `${e.brand_name}|${e.generic_name}`) problems.push(`${at}: key is not "${e.brand_name}|${e.generic_name}"`);
    if (!(e.outlier === true || e.outlier === false || e.outlier === null)) problems.push(`${at}: outlier must be true, false or null, got ${JSON.stringify(e.outlier)}`);
    if (hasOwn(e, 'avg_per_unit') && isObj(e.avg_per_unit) && !UNITS.includes(e.avg_per_unit.per)) {
      problems.push(`${at}: avg_per_unit.per ${JSON.stringify(e.avg_per_unit.per)} is not a NADAC unit`);
    }
  }
  // Every row pointing at a name is priced by NADAC in that name's unit, and has the same basis.
  const basis = new Map();
  for (const r of rows) {
    if (!isObj(r.part_d) || !hasOwn(partDNames, r.part_d.key)) continue;
    const e = partDNames[r.part_d.key];
    if (isObj(e.avg_per_unit) && e.avg_per_unit.per !== r.unit) {
      problems.push(`row ${r.ndc} (${r.unit}) points at ${r.part_d.key}, whose avg_per_unit is per ${e.avg_per_unit.per}`);
    }
    const b = basis.get(r.part_d.key);
    if (b === undefined) basis.set(r.part_d.key, r.part_d.basis);
    else if (b !== r.part_d.basis) problems.push(`rows pointing at ${r.part_d.key} disagree on basis (${b} and ${r.part_d.basis})`);
  }
  noProblems(problems, 'part_d_names');
});

test('part_b_codes: keyed by HCPCS, contract fields, per = hcpcs_dosage, sorted distinct labelers', () => {
  const problems = [];
  for (const [code, e] of Object.entries(partBCodes)) {
    const at = `part_b_codes[${code}]`;
    if (!isObj(e)) {
      problems.push(`${at}: not an object`);
      continue;
    }
    problems.push(...keyProblems(e, ['hcpcs', 'hcpcs_dosage', 'short_description', 'labelers'], PART_B_CODE_RECORDS, at));
    if (e.hcpcs !== code) problems.push(`${at}: hcpcs ${JSON.stringify(e.hcpcs)} is not its key`);
    if (!/^[A-Z0-9]{5}$/.test(code)) problems.push(`${at}: key is not a five-character HCPCS code`);
    if (!nonEmpty(e.hcpcs_dosage)) problems.push(`${at}: hcpcs_dosage must be a non-empty string`);
    if (/^\d{5}$/.test(code)) {
      if (e.short_description !== null) problems.push(`${at}: CPT code with a short_description; it must be null (AMA licence)`);
    } else if (!nonEmpty(e.short_description)) {
      problems.push(`${at}: short_description must be a non-empty string for a non-CPT code, got ${JSON.stringify(e.short_description)}`);
    }
    const l = e.labelers;
    if (!Array.isArray(l) || l.length === 0 || l.some((x) => !nonEmpty(x))) problems.push(`${at}: labelers must be a non-empty list of names`);
    else {
      for (let i = 1; i < l.length; i++) {
        if (!(l[i - 1] < l[i])) problems.push(`${at}: labelers not sorted and distinct at ${JSON.stringify(l[i - 1])}, ${JSON.stringify(l[i])}`);
      }
    }
  }
  noProblems(problems, 'part_b_codes');
});

test('every part_d.key and part_b.hcpcs resolves, and no table entry is an orphan', () => {
  const problems = [];
  const usedD = new Set();
  const usedB = new Set();
  for (const r of rows) {
    if (isObj(r.part_d)) {
      if (!hasOwn(partDNames, r.part_d.key)) problems.push(`row ${r.ndc}: part_d.key ${JSON.stringify(r.part_d.key)} is not in part_d_names`);
      else usedD.add(r.part_d.key);
    }
    if (isObj(r.part_b)) {
      if (!hasOwn(partBCodes, r.part_b.hcpcs)) problems.push(`row ${r.ndc}: part_b.hcpcs ${JSON.stringify(r.part_b.hcpcs)} is not in part_b_codes`);
      else usedB.add(r.part_b.hcpcs);
    }
  }
  for (const k of Object.keys(partDNames)) if (!usedD.has(k)) problems.push(`part_d_names[${k}] is not pointed at by any row`);
  for (const k of Object.keys(partBCodes)) if (!usedB.has(k)) problems.push(`part_b_codes[${k}] is not pointed at by any row`);
  noProblems(problems, 'table references');
});

// ---------------------------------------------------------------------------------------
// Join rules the contract and docs/DATA_SOURCES.md state

const routeParts = (route) => new Set(String(route || '').split(';').map((x) => x.trim().toUpperCase()).filter(Boolean));

test('a Part D name CMS marks with * is pointed at only by rows with an FDA identity whose route they all share', () => {
  // docs/ARCHITECTURE.md: a row joins such a name only when it has an FDA identity whose route is
  // shared by every row joined to that name; unknown or minority routes do not join it.
  const byKey = new Map();
  for (const r of rows) {
    if (!isObj(r.part_d) || !hasOwn(partDNames, r.part_d.key)) continue;
    if (!String(partDNames[r.part_d.key].brand_name).includes('*')) continue;
    if (!byKey.has(r.part_d.key)) byKey.set(r.part_d.key, []);
    byKey.get(r.part_d.key).push(r);
  }
  assert.ok(byKey.size > 0, 'some rows point at a * name');
  const problems = [];
  for (const [key, rs] of byKey) {
    const noRoute = rs.filter((r) => !isObj(r.identity) || routeParts(r.identity.route).size === 0);
    for (const r of noRoute) problems.push(`row ${r.ndc} (${r.name}) points at ${key} with no FDA identity route`);
    const sets = rs.filter((r) => !noRoute.includes(r)).map((r) => routeParts(r.identity.route));
    if (!sets.length) continue;
    const shared = [...sets[0]].filter((c) => sets.every((s) => s.has(c)));
    if (!shared.length) {
      const routes = [...new Set(rs.map((r) => r.identity && r.identity.route))].join(' / ');
      problems.push(`rows pointing at ${key} share no FDA route (${routes})`);
    }
  }
  noProblems(problems, '* names and routes');
  const reasons = isObj(doc.counts.part_d_unmatched) ? doc.counts.part_d_unmatched : {};
  for (const k of Object.keys(reasons)) {
    if (k.startsWith('multi_route_')) assert.ok(['multi_route_no_identity', 'multi_route_minority', 'multi_route_tie'].includes(k), `unknown * reason ${k}`);
  }
});

test('packages of one FDA product get one Part D answer: an NDC FDA does not list never joins where its listed siblings were refused', () => {
  // Rows with no exact FDA package match are matched with their product code's FDA record, so an
  // unlisted inner package (a pouch of a carton) cannot take a Part D figure the FDA-listed
  // packages of the same product and NADAC description were refused.
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.name}|${r.ndc.slice(0, 9)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const problems = [];
  for (const rs of groups.values()) {
    const refused = rs.filter((r) => isObj(r.identity) && r.part_d === null);
    if (!refused.length) continue;
    for (const r of rs) {
      if (!isObj(r.identity) && isObj(r.part_d)) {
        problems.push(`${r.ndc} (${r.name}, no FDA identity) points at ${r.part_d.key}, but its listed sibling ${refused[0].ndc} has no Part D figure`);
      }
    }
  }
  noProblems(problems, 'product consistency');
});

/** Kits in an NDC from FDA's package description (outer chain, down to the first KIT level), or null. */
function fdaKits(desc) {
  if (typeof desc !== 'string') return null;
  const outer = desc.split(/[*+]/)[0].replace(/\(\s*[\d-]+\s*\)/g, ' ');
  let n = 1;
  for (const part of outer.split(' / ')) {
    const m = part.trim().replace(/\s+/g, ' ').match(/^([\d.]+)\s+(.+?)\s+in\s+1\s+(.+)$/i);
    if (!m) return null;
    n *= Number(m[1]);
    if (m[2].toUpperCase().split(/[ ,]/)[0] === 'KIT') return n;
  }
  return null;
}

test('Part B: a kit NADAC prices per EA is reconciled only when the crosswalk counts kits', () => {
  // NADAC prices a kit as one EA (CIMZIA 2X200 MG/ML SYRINGE KIT: $6,094.025 per EA). The
  // crosswalk's PKG SIZE x PKG QTY must then equal the kits in the NDC, not the syringes in it.
  const problems = [];
  let kits = 0;
  for (const r of rows) {
    if (!isObj(r.part_b) || r.unit !== 'EA' || !isObj(r.identity)) continue;
    const n = fdaKits(r.identity.package_description);
    const nadacKit = /\b(KIT|KT)\b/.test(r.name);
    if (n === null && !nadacKit) continue;
    kits++;
    const amount = r.part_b.package_size.value * r.part_b.package_qty.value;
    const want = n === null ? 1 : n;
    if (r.part_b.package_unit === 'EA' && amount !== want) {
      problems.push(`${r.ndc} (${r.name}): package_unit EA but PKG SIZE x PKG QTY is ${amount}, and the NDC holds ${want} kit(s)`);
    }
  }
  assert.ok(kits > 0, 'some Part B rows are kits');
  noProblems(problems, 'kit reconciliation');
});

test('Part B: where the crosswalk\'s billable-unit columns disagree, BILLUNITSPKG is used only when FDA\'s strength confirms it', () => {
  const toMg = { MG: 1, G: 1000, GM: 1000, MCG: 0.001 };
  const problems = [];
  let checked = 0;
  for (const r of rows) {
    const b = r.part_b;
    if (!isObj(b) || b.package_unit === null || !/BILLUNITSPKG is used/.test(b.bill_units_per_package.reason)) continue;
    checked++;
    const s = isObj(r.identity) && String(r.identity.strength || '').match(/^\s*(\d*\.?\d+)\s*(mg|g|mcg)\s*\/\s*(1|mL)\s*$/i);
    const code = partBCodes[b.hcpcs];
    const d = isObj(code) && String(code.hcpcs_dosage || '').match(/^\s*(\d*\.?\d+)\s*(MG|GM|G|MCG)\s*$/i);
    if (!s || !d) {
      problems.push(`${r.ndc}: BILLUNITSPKG used on FDA's strength, but strength ${JSON.stringify(r.identity && r.identity.strength)} or dosage ${JSON.stringify(code && code.hcpcs_dosage)} is not plain`);
      continue;
    }
    const amount = b.package_size.value * b.package_qty.value;
    const units = (Number(s[1]) * toMg[s[2].toUpperCase()] * amount) / (Number(d[1]) * toMg[d[2].toUpperCase()]);
    if (Math.abs(units - b.bill_units_per_package.value) > 1e-9 * Math.max(1, units)) {
      problems.push(`${r.ndc} (${r.name}): FDA strength x ${amount} / ${code.hcpcs_dosage} = ${units}, but BILLUNITSPKG is ${b.bill_units_per_package.value}`);
    }
  }
  assert.ok(checked > 0, 'some rows were reconciled on FDA\'s strength');
  noProblems(problems, 'strength-checked billable units');
});

// ---------------------------------------------------------------------------------------
// Counts

test('counts that are simple counts equal the counts recomputed from the rows and tables', () => {
  const c = doc.counts;
  const tally = (items) => {
    const out = {};
    for (const k of items) out[k] = (out[k] || 0) + 1;
    return out;
  };
  const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const pd = rows.filter((r) => isObj(r.part_d));
  const pb = rows.filter((r) => isObj(r.part_b));
  const nameOf = (r) => partDNames[r.part_d.key] || {};
  const classes = [...new Set(rows.map((r) => r.rate_class))].sort();
  const expected = {
    rows: rows.length,
    rows_by_state: sortKeys(tally(rows.map((r) => r.nadac.state))),
    records_by_state: sortKeys(tally(RECORDS.map((x) => x.rec.state))),
    distinct_names: new Set(rows.map((r) => r.name)).size,
    identity_matched: rows.filter((r) => isObj(r.identity)).length,
    part_d_matched: pd.length,
    part_d_by_basis: sortKeys(tally(pd.map((r) => r.part_d.basis))),
    part_d_by_rate_class: Object.fromEntries(
      classes.map((k) => [k, { rows: rows.filter((r) => r.rate_class === k).length, matched: pd.filter((r) => r.rate_class === k).length }]),
    ),
    part_d_otc: { rows: rows.filter((r) => r.otc).length, matched: pd.filter((r) => r.otc).length },
    part_d_outliers: pd.filter((r) => nameOf(r).outlier === true).length,
    part_d_outlier_flag_blank: pd.filter((r) => nameOf(r).outlier === null).length,
    part_d_multiple_routes: pd.filter((r) => String(nameOf(r).brand_name).includes('*')).length,
    part_b_matched: pb.length,
    part_b_unit_reconciled: pb.filter((r) => r.part_b.package_unit !== null).length,
    part_d_names: Object.keys(partDNames).length,
    part_b_codes: Object.keys(partBCodes).length,
    part_b_single_labeler_codes: Object.values(partBCodes).filter((e) => Array.isArray(e.labelers) && e.labelers.length === 1).length,
    carried_forward: rows.filter((r) => r.carried_forward === true).length,
    with_generic_nadac: rows.filter((r) => hasOwn(r, 'generic_nadac')).length,
  };
  const problems = [];
  let compared = 0;
  for (const [k, v] of Object.entries(expected)) {
    if (!hasOwn(c, k)) continue; // counts are builder-defined; compare the ones present
    compared++;
    try {
      assert.deepStrictEqual(c[k], v);
    } catch {
      problems.push(`counts.${k} is ${JSON.stringify(c[k])}, recomputed ${JSON.stringify(v)}`);
    }
  }
  // Breakdowns of the unmatched rows must add up with the matched ones to every row.
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const breakdowns = [
    ['part_d_unmatched', rows.length - pd.length],
    ['part_b_unmatched', rows.length - pb.length],
    ['part_d_by_join', pd.length],
    ['part_b_unit_reconciled_by', pb.filter((r) => r.part_b.package_unit !== null).length],
  ];
  for (const [k, total] of breakdowns) {
    if (!hasOwn(c, k)) continue;
    compared++;
    if (!isObj(c[k]) || Object.values(c[k]).some((n) => !(Number.isInteger(n) && n >= 0))) problems.push(`counts.${k} must map reasons to whole numbers`);
    else if (sum(c[k]) !== total) problems.push(`counts.${k} adds up to ${sum(c[k])}, expected ${total}`);
  }
  assert.ok(compared >= 10, `only ${compared} counts were comparable; counts lost its summary keys`);
  noProblems(problems, 'counts');
});
