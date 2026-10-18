// Price records and price states. Every number OpenBill shows is a record:
// { value, kind, state, reason, source_name, source_url, source_file, effective_date,
//   retrieved_date, as_of_date?, per?, period? }  (docs/ARCHITECTURE.md, "Price records").

import { isIsoDate, parsePeriod } from './dates.js';
import { formatUnitPrice, formatPercent, formatCount, formatMultiple } from './money.js';

/** Price states, strongest first. */
export const PRICE_STATES = Object.freeze(['filed', 'published', 'derived', 'estimated']);

/**
 * What each state means. `rank` is the position in PRICE_STATES: 0 is the strongest,
 * a higher rank is weaker. `summary` is the owner's brief, verbatim apart from the capital.
 * @type {Readonly<Record<string, { label: string, summary: string, rank: number }>>}
 */
export const STATE_INFO = Object.freeze({
  filed: Object.freeze({
    label: 'filed',
    summary: 'Read from a published government file (NADAC, ASP, a fee schedule). Strongest.',
    rank: 0,
  }),
  published: Object.freeze({
    label: 'published',
    summary: "From a payer's or provider's own published rate.",
    rank: 1,
  }),
  derived: Object.freeze({
    label: 'derived',
    summary: 'Computed from a published rule (e.g. Medicare pays 80% of the fee schedule).',
    rank: 2,
  }),
  estimated: Object.freeze({
    label: 'estimated',
    summary: 'Inferred, with the reason recorded.',
    rank: 3,
  }),
});

/** Fields every record must have. */
export const RECORD_FIELDS = Object.freeze([
  'value',
  'kind',
  'state',
  'reason',
  'source_name',
  'source_url',
  'source_file',
  'effective_date',
  'retrieved_date',
]);

/** Fields a record may have. */
export const OPTIONAL_RECORD_FIELDS = Object.freeze(['as_of_date', 'per', 'period']);

/**
 * Record kinds: usd (dollars, > 0), percent (20 means 20%), count (a whole number of things,
 * 0 or more), quantity (a measured amount such as 0.4 mL, > 0; `per` names the unit when the
 * source states it), ratio (the spread, > 0). `per` is optional on every kind, as in the
 * contract's record table: a crosswalk package size whose unit could not be reconciled has no
 * `per` ("per = package_unit when reconciled"), because writing one would invent a unit.
 */
export const KINDS = Object.freeze(['usd', 'percent', 'count', 'quantity', 'ratio']);

const STRONG_INPUT_STATES = Object.freeze(['filed', 'published', 'derived']);
const METHODOLOGY_URL_RE = /^methodology\.html#[a-z0-9][a-z0-9-]*$/;
const RULE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * True when s is one of PRICE_STATES.
 * @param {*} s
 * @returns {boolean}
 */
export function isPriceState(s) {
  return typeof s === 'string' && PRICE_STATES.includes(s);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Check a record against the contract. Returns a list of human-readable problems; an
 * empty list means the record is valid.
 * @param {*} rec
 * @returns {string[]}
 */
export function validateRecord(rec) {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
    return ['record is not an object'];
  }
  const problems = [];
  for (const f of RECORD_FIELDS) {
    if (rec[f] === undefined || rec[f] === null) problems.push(`missing required field "${f}"`);
  }
  for (const f of Object.keys(rec)) {
    if (!RECORD_FIELDS.includes(f) && !OPTIONAL_RECORD_FIELDS.includes(f)) {
      problems.push(`unknown field "${f}"`);
    }
  }

  const { value, kind } = rec;
  if (value !== undefined && value !== null) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`value must be a finite number, got ${typeof value === 'number' ? String(value) : JSON.stringify(value)}`);
    } else if (kind === 'usd' && !(value > 0)) {
      problems.push(`usd value must be greater than 0, got ${value}`);
    } else if (kind === 'percent' && !(value >= 0 && value <= 100)) {
      problems.push(`percent value must be between 0 and 100, got ${value}`);
    } else if (kind === 'count' && !(value >= 0)) {
      problems.push(`count value must be 0 or more, got ${value}`);
    } else if (kind === 'quantity' && !(value > 0)) {
      problems.push(`quantity value must be greater than 0, got ${value}`);
    } else if (kind === 'ratio' && !(value > 0)) {
      problems.push(`ratio value must be greater than 0, got ${value}`);
    }
  }
  if (kind !== undefined && kind !== null && !KINDS.includes(kind)) {
    problems.push(`kind must be one of ${KINDS.join(', ')}, got ${JSON.stringify(kind)}`);
  }
  if (rec.state !== undefined && rec.state !== null && !isPriceState(rec.state)) {
    problems.push(`state must be one of ${PRICE_STATES.join(', ')}, got ${JSON.stringify(rec.state)}`);
  }
  if (rec.reason !== undefined && rec.reason !== null && !nonEmptyString(rec.reason)) {
    problems.push('reason must be a non-empty string');
  }
  if (rec.source_name !== undefined && rec.source_name !== null && !nonEmptyString(rec.source_name)) {
    problems.push('source_name must be a non-empty string');
  }
  if (rec.source_url !== undefined && rec.source_url !== null) {
    const u = rec.source_url;
    const ok =
      typeof u === 'string' && ((/^https:\/\/[^\s/]+\.[^\s]*$/.test(u) && !/\s/.test(u)) || METHODOLOGY_URL_RE.test(u));
    if (!ok) {
      problems.push(`source_url must be an https:// URL or methodology.html#<rule-id>, got ${JSON.stringify(u)}`);
    }
  }
  if (rec.source_file !== undefined && rec.source_file !== null && !nonEmptyString(rec.source_file)) {
    problems.push('source_file must be a non-empty string');
  }
  for (const f of ['effective_date', 'retrieved_date', 'as_of_date']) {
    const v = rec[f];
    if (v === undefined || (v === null && f !== 'as_of_date')) continue;
    if (!isIsoDate(v)) problems.push(`${f} must be a real calendar date YYYY-MM-DD, got ${JSON.stringify(v)}`);
  }
  if (rec.per !== undefined && !nonEmptyString(rec.per)) {
    problems.push(`per must be a non-empty string when present, got ${JSON.stringify(rec.per)}`);
  }
  if (rec.period !== undefined && parsePeriod(rec.period) === null) {
    problems.push(`period must be YYYY-MM-DD/YYYY-MM-DD with real dates, start not after end, got ${JSON.stringify(rec.period)}`);
  }
  return problems;
}

/**
 * Validate fields and return a frozen record with its fields in contract order.
 * Optional fields that are undefined are left out. Throws an Error listing every problem.
 * @param {object} fields
 * @returns {Readonly<object>}
 */
export function makeRecord(fields) {
  const problems = validateRecord(fields);
  if (problems.length) {
    throw new Error(`invalid price record: ${problems.join('; ')}`);
  }
  const out = {};
  for (const f of RECORD_FIELDS) out[f] = fields[f];
  for (const f of OPTIONAL_RECORD_FIELDS) if (fields[f] !== undefined) out[f] = fields[f];
  return Object.freeze(out);
}

/**
 * The weakest of a list of states, or null for an empty list. Throws on an unknown state.
 * @param {string[]} states
 * @returns {string|null}
 */
export function weakestState(states) {
  let worst = null;
  for (const s of states) {
    if (!isPriceState(s)) throw new Error(`unknown price state ${JSON.stringify(s)}`);
    if (worst === null || STATE_INFO[s].rank > STATE_INFO[worst].rank) worst = s;
  }
  return worst;
}

/**
 * A record's value formatted for its kind: "$0.01451 per EA", "20%", "60 claim", "2.4 ML",
 * "4.9×".
 * @param {object} rec
 * @returns {string}
 */
export function formatValue(rec) {
  const per = rec.per ? ` per ${rec.per}` : '';
  switch (rec.kind) {
    case 'usd':
      return formatUnitPrice(rec.value) + per;
    case 'percent':
      return formatPercent(rec.value);
    case 'count':
    case 'quantity':
      return formatCount(rec.value) + (rec.per ? ` ${rec.per}` : '');
    case 'ratio':
      return formatMultiple(rec.value);
    default:
      throw new Error(`unknown kind ${JSON.stringify(rec.kind)}`);
  }
}

function sentence(s) {
  const t = String(s).trim();
  return /[.!?]["”’)]*$/.test(t) ? t : t + '.';
}

function oldest(values) {
  const present = values.filter((v) => v !== undefined && v !== null);
  if (!present.length) return undefined;
  return present.reduce((a, b) => (b < a ? b : a));
}

/**
 * Build a calculated record from input records and the rule (an entry of RULES in rules.js).
 *
 * The state is `derived` only when `comparable` is true and every input is filed, published
 * or derived; otherwise `estimated`, and the reason lists each mismatch (so a non-comparable
 * calculation must pass at least one caveat). The reason is the rule's description, an
 * optional `detail` (the arithmetic), a short summary of each input, then the caveats.
 * source_name is "OpenBill calculation", source_url is methodology.html#<rule.id>,
 * source_file is the unique input files joined with " + ", effective_date, retrieved_date
 * and as_of_date are the oldest of the inputs', and period is kept only when every input
 * has the same one. The record is flat: the inputs are summarized, not nested.
 *
 * @param {object} args
 * @param {number} args.value
 * @param {'usd'|'percent'|'count'|'quantity'|'ratio'} args.kind
 * @param {string} [args.per]
 * @param {{ id: string, description: string }} args.rule
 * @param {object[]} args.inputs   valid records
 * @param {boolean} args.comparable same product, same period basis, same unit
 * @param {string[]} [args.caveats] each mismatch or limitation, one sentence each
 * @param {string} [args.detail]    the arithmetic in words, e.g. "60 × $0.01451 = $0.8706."
 * @param {string[]} [args.labels]  what each input is ("payment limit"), same order as inputs
 * @returns {Readonly<object>}
 */
export function deriveRecord({ value, kind, per, rule, inputs, comparable, caveats = [], detail, labels }) {
  if (!rule || !RULE_ID_RE.test(String(rule.id)) || !nonEmptyString(rule.description)) {
    throw new Error('deriveRecord needs a rule with an id and a description');
  }
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error(`deriveRecord(${rule.id}) needs at least one input record`);
  }
  inputs.forEach((rec, i) => {
    const p = validateRecord(rec);
    if (p.length) throw new Error(`deriveRecord(${rule.id}) input ${i + 1} is invalid: ${p.join('; ')}`);
  });
  if (typeof comparable !== 'boolean') {
    throw new Error(`deriveRecord(${rule.id}) needs comparable: true or false`);
  }
  if (!Array.isArray(caveats) || caveats.some((c) => !nonEmptyString(c))) {
    throw new Error(`deriveRecord(${rule.id}) caveats must be non-empty strings`);
  }
  if (labels !== undefined && (!Array.isArray(labels) || labels.length !== inputs.length || labels.some((l) => !nonEmptyString(l)))) {
    throw new Error(`deriveRecord(${rule.id}) labels must be one non-empty string per input`);
  }
  if (!comparable && caveats.length === 0) {
    throw new Error(`deriveRecord(${rule.id}): inputs that are not comparable need a caveat saying why`);
  }

  const weak = inputs.filter((r) => !STRONG_INPUT_STATES.includes(r.state));
  const state = comparable && weak.length === 0 ? 'derived' : 'estimated';

  const parts = [sentence(rule.description)];
  if (nonEmptyString(detail)) parts.push(sentence(detail));
  // Period data is shown with its period (contract: "period is always set and always shown next
  // to it"); "effective 2024-01-01" alone read as a price in force since 2024-01-01.
  const when = (r) => {
    const p = parsePeriod(r.period);
    if (!p) return `effective ${r.effective_date}`;
    const span = `${p.start} to ${p.end}`;
    return r.effective_date === p.start ? `for ${span}` : `effective ${r.effective_date}, period ${span}`;
  };
  parts.push(
    'Inputs: ' +
      inputs.map((r, i) => `${labels ? labels[i] + ', ' : ''}${r.source_name} ${formatValue(r)} (${r.state}, ${when(r)})`).join('; ') +
      '.',
  );
  const mismatches = [
    ...weak.map((r) => `The ${r.source_name} input is ${r.state}, not filed, published or derived.`),
    ...caveats.map(sentence),
  ];
  if (mismatches.length) {
    parts.push((state === 'estimated' ? 'Estimated because: ' : 'Caveats: ') + mismatches.join(' '));
  }

  const files = [];
  for (const r of inputs) {
    for (const f of String(r.source_file).split(' + ')) if (!files.includes(f)) files.push(f);
  }
  const periods = inputs.map((r) => r.period);
  const period = periods.every((p) => p !== undefined && p === periods[0]) ? periods[0] : undefined;

  return makeRecord({
    value,
    kind,
    state,
    reason: parts.join(' '),
    source_name: 'OpenBill calculation',
    source_url: `methodology.html#${rule.id}`,
    source_file: files.join(' + '),
    effective_date: oldest(inputs.map((r) => r.effective_date)),
    retrieved_date: oldest(inputs.map((r) => r.retrieved_date)),
    as_of_date: oldest(inputs.map((r) => r.as_of_date)),
    per,
    period,
  });
}
