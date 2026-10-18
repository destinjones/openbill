// The rules the page applies, as data (RULES, rendered verbatim on methodology.html) and as
// functions over linked rows of data/drugs.json (schema openbill.drugs/3, passed through
// linkRows() in pack.js so row.part_d and row.part_b carry their table entries). Every
// calculated number is a record, so it carries its state, reason and sources.
//
// Functions that may have nothing to show return { missing: true, reason } instead of a
// record; the page shows the reason ("We don't know yet") rather than a zero.

import { makeRecord, deriveRecord, validateRecord, weakestState } from './provenance.js';
import { multiplyMoney, roundMoney, divideMoney, multiplyDecimal, subtractDecimal, roundHalfUp, decimalString, quantityProblem, formatMoney, formatUnitPrice, formatMultiple, formatMultipleWithin, formatCount, formatPercent } from './money.js';
import { daysBetween, isIsoDate, parsePeriod } from './dates.js';
import { SOURCE_INFO } from './sources.js';
import { formatNdc, isNdc11 } from './ndc.js';

/** Starting quantity for products NADAC prices per EA (see defaultQuantity). */
export const DEFAULT_EA_QUANTITY = 30;

/** An estimated spread at or above this multiple carries the extreme-gap caveat. */
export const EXTREME_HIGH = 20;

/** An estimated spread at or below this multiple carries the extreme-gap caveat. */
export const EXTREME_LOW = 0.2;

/**
 * A product whose middle NADAC is this many times the middle NADAC of the other products CMS
 * averages under the same Part D name carries the name-outlier caveat.
 */
export const NAME_OUTLIER_FACTOR = 20;

/**
 * The card's headline for an extreme estimated spread, instead of a sentence such as
 * "Medicare paid 99% less than pharmacies pay." (docs/ARCHITECTURE.md, "Spread").
 */
export const EXTREME_HEADLINE = 'These two figures may not measure the same thing';

/**
 * A spread multiple as the page shows it: formatMultiple(), except that a ratio strictly between
 * EXTREME_LOW and EXTREME_HIGH gets as many more decimals as it takes not to be shown as a
 * threshold or beyond (0.2046 is "0.205×", not "0.20×"; 19.97 is "19.97×", not "20.0×"). The
 * thresholds are tested on the unrounded ratio, so this keeps the shown multiple and the
 * extreme-gap headline from disagreeing.
 * @param {number} ratio
 * @returns {string}
 */
export function formatSpreadMultiple(ratio) {
  return formatMultipleWithin(ratio, EXTREME_LOW, EXTREME_HIGH);
}

const days = (n) => `${formatCount(n)} day${n === 1 ? '' : 's'}`;

/**
 * @typedef {object} Rule
 * @property {string} id           anchor on methodology.html (source_url of calculated records)
 * @property {string} title
 * @property {string} summary      one sentence; the first sentence of a calculated record's reason
 * @property {string} formula      the arithmetic in one line
 * @property {string} description  plain English for a lay reader, rendered on methodology.html
 */

/** @type {readonly Rule[]} */
export const RULES = Object.freeze([
  Object.freeze({
    id: 'unit-total',
    title: 'Pack total',
    summary: 'Pack total: the price per unit times the quantity entered, rounded half-up to the cent.',
    formula: 'pack total = quantity × price per unit, rounded half-up to the cent',
    description:
      'The price for the quantity you enter is the price per unit times that quantity, worked out exactly and then rounded to the nearest cent, with a half cent rounding up. That is your own arithmetic on a published price, not a new estimate, so the total keeps the label (filed, derived or estimated), the source and the dates of the price per unit it multiplies, and its explanation shows the multiplication. A total above zero but under half a cent is shown as “<$0.01”, never as $0.00.',
  }),
  Object.freeze({
    id: 'default-quantity',
    title: 'Starting quantity',
    summary: 'Starting quantity: 30 for a product priced per EA; one package for a product priced per ML or GM when every FDA package description of it agrees; otherwise 1.',
    formula: 'per EA: 30; per ML or GM: the amount in one package, when every package description of the product agrees; otherwise 1',
    description: `Before you type a quantity, each card fills one in for you. NADAC (National Average Drug Acquisition Cost, a weekly survey by CMS, the Centers for Medicare & Medicaid Services, of what retail pharmacies pay for drugs) prices each drug per EA (each: one tablet, capsule, patch or other single unit), per ML (milliliter) or per GM (gram). For EA the card starts at ${DEFAULT_EA_QUANTITY}, a common one-month supply of a once-a-day medicine. For ML and GM it starts at the amount in one package, read from the package description in the FDA NDC Directory (the U.S. Food and Drug Administration’s list of drug packages, each identified by its NDC, the National Drug Code printed on the package): “5 SYRINGE in 1 CARTON / 3 mL in 1 SYRINGE” is 15 mL. That is used only when every NDC of the product listed there gives the same amount; otherwise the card starts at 1. It is a starting point, not your prescription: change it to match what you were given.`,
  }),
  Object.freeze({
    id: 'reference-price',
    title: 'Which Medicare price is compared',
    summary: 'The Medicare price compared with NADAC: Part D when its average is per the NADAC unit and not flagged as an outlier, otherwise Part B converted to the NADAC unit, otherwise none.',
    formula: 'Medicare price = Part D average per unit if usable, else Part B payment limit per unit if usable, else none',
    description:
      'NADAC (National Average Drug Acquisition Cost) measures what retail pharmacies pay for a drug, and Medicare Part D is the part of Medicare that pays for drugs filled at pharmacies, so Part D comes first: the average Part D spent per unit in its latest data year, for the brand and generic name this drug matched. It is used only when it is per the same unit as NADAC and CMS (the Centers for Medicare & Medicaid Services, which publishes both files) has not flagged it as an outlier, meaning a figure distorted by a few unusual records. When the outlier flag is blank in the CMS file, OpenBill counts it as not flagged and says so. Otherwise OpenBill uses Medicare Part B, the part of Medicare that pays for drugs given in a clinic or doctor’s office: the current quarter’s payment limit, matched by the exact NDC (National Drug Code, the number on the package) through the CMS crosswalk and converted to the NADAC unit (the next rule). Otherwise there is no Medicare price, and the card says why. When both exist, the card shows Part D and its details also show Part B, with a note that Part B pays for a pharmacy drug only in specific settings, such as a drug given in a clinic.',
  }),
  Object.freeze({
    id: 'part-b-per-nadac-unit',
    title: 'Part B payment limit per NADAC unit',
    summary: 'The Medicare Part B payment limit per HCPCS billing unit, converted to dollars per NADAC unit for the same NDC using the billing units and package size from the CMS NDC-HCPCS crosswalk.',
    formula: 'price per unit = payment limit × billing units in the package ÷ (amount in one item × number of items)',
    description:
      'Medicare Part B sets a payment limit per HCPCS billing unit. HCPCS is the coding system Medicare uses for billing, and a billing unit is an amount such as “10 MG”. NADAC is per tablet (EA), milliliter (ML) or gram (GM) instead. To compare the two, OpenBill uses the CMS NDC-HCPCS crosswalk, a CMS table that gives, for each NDC (National Drug Code, the number on the package), the billing code it is billed under and how many billing units the whole package holds. The price per NADAC unit is the limit times the billing units in the whole package, divided by the amount in the package (the amount in one item times the number of items). This is done only when OpenBill could confirm, from the package description in the FDA NDC Directory (the U.S. Food and Drug Administration’s list of drug packages), that the package amount is in the same unit NADAC uses.',
  }),
  Object.freeze({
    id: 'part-b-coinsurance',
    title: 'Part B coinsurance',
    summary: 'The coinsurance share of the Medicare Part B payment limit per HCPCS billing unit, using the coinsurance percentage printed in the CMS payment limit file; deductibles and other coverage change what a person actually owes.',
    formula: 'coinsurance = payment limit × coinsurance percentage ÷ 100',
    description:
      'Coinsurance is the share of the Part B payment limit a patient owes after meeting the deductible: the payment limit per billing unit times the coinsurance percentage printed for that billing code in the CMS payment limit file (usually 20%). Deductibles, supplemental insurance and other coverage change what a person actually owes.',
  }),
  Object.freeze({
    id: 'spread',
    title: 'The spread',
    summary: 'The spread: the Medicare price per unit divided by what pharmacies pay per unit (NADAC).',
    formula: 'spread = Medicare price per unit ÷ NADAC price per unit',
    description:
      'The spread compares the two prices: the Medicare price per unit divided by what pharmacies pay per unit (NADAC). 4.9× means Medicare paid 4.9 times what pharmacies pay; 0.8× means Medicare paid 20% less. Every number on a card is labelled filed (read from a government file), derived (calculated by a fixed rule from published figures) or estimated (inferred, with the reason written down). A spread computed from Part D is always labelled estimated, because Part D puts every strength and form sold under one name into a single average, covers a past calendar year rather than this week, and counts spending the way CMS defines it (including pharmacy dispensing fees, and before the discounts drug makers pay back). A spread computed from Part B is labelled derived only when a single company sells under that billing code (the next rule); otherwise it is estimated too.',
  }),
  Object.freeze({
    id: 'part-b-single-labeler',
    title: 'When a Part B spread counts as derived',
    summary: 'A Part B spread is derived only when one labeler bills under the HCPCS code; otherwise the payment limit is an average across labelers and the spread is estimated.',
    formula: 'derived when exactly one labeler (one company, however its name is spelled) is listed for the billing code on the crosswalk; otherwise estimated',
    description:
      'Part B sets one payment limit per billing code, worked out from the average sales price of every product billed under that code. A labeler is the company named on a drug’s label. When the CMS crosswalk lists only one labeler for the code, the limit describes that company’s own product, so the spread is derived. CMS sometimes writes one company’s name more than one way on the same code (“UCB, INC.” and “UCB, Inc.”); names that differ only in capitals, punctuation, spacing or a closing Inc, LLC, Ltd, Corp or Co count as one labeler, and the explanation quotes each spelling. When several labelers share the code, the limit is an average across all their products and can sit well above or below the price of this one package, so the spread is estimated, and its explanation says how many labelers share the code.',
  }),
  Object.freeze({
    id: 'extreme-gap',
    title: 'Very large or very small spreads',
    summary: 'An estimated spread at or above 20× or at or below 0.2× carries a warning that the two figures may not describe the same unit or product.',
    formula: `estimated spread ≥ ${EXTREME_HIGH}× or ≤ ${EXTREME_LOW}× → add a warning; the card’s headline becomes “${EXTREME_HEADLINE}”`,
    description: `An estimated spread of ${EXTREME_HIGH}× or more, or ${EXTREME_LOW}× or less, also carries a warning that the two figures may not describe the same unit or product: for example, Part D may count a unit differently from NADAC, or average in strengths that cost far more or far less than this one. The number is still shown, with the warning; it is never hidden. But the card does not lead with a sentence such as “Medicare paid 99% less than pharmacies pay” for it: its headline becomes “${EXTREME_HEADLINE}”, the multiple is shown beside it, and the warning says why.`,
  }),
  Object.freeze({
    id: 'part-d-name-outlier',
    title: 'A product far from the others under its Part D name',
    summary: `A Part D spread says so when this product’s NADAC is ${NAME_OUTLIER_FACTOR} or more times the NADAC of the other products CMS averages under the same name.`,
    formula: `middle NADAC of this product ÷ middle of the other products’ middle NADACs under the same Part D name ≥ ${NAME_OUTLIER_FACTOR} → add a warning`,
    description: `Part D gives one average for every product sold under a brand and generic name, weighted by claims. When one product costs far more than the others under that name (a specialty formulation or an uncommon strength of a cheap generic, for example), the average can mostly reflect what the others cost, and a spread against it then says little about this product. So OpenBill compares the middle NADAC price of this product’s NDCs with the middle of the other products’ own middle prices under the same name, per the same unit (the lower of the two middle prices when there is an even number, so the comparison is between real filed prices). When this product is ${NAME_OUTLIER_FACTOR} or more times the others, the spread says so with both prices. The spread is still shown; the join is not refused, because many such names really do average strengths that sit close together.`,
  }),
  Object.freeze({
    id: 'freshness',
    title: 'Freshness',
    summary: 'A figure is stale when its age, counted from the NADAC file date, the start of the Part B quarter or the end of the Part D data year, passes its source’s limit.',
    formula: 'age = today − the source’s date, in whole days; stale when age > the source’s limit',
    description: `Each figure’s age is counted in whole days up to today: for NADAC from the date of its weekly file (the “as of” date), for Medicare Part B from the first day of the quarter its payment limits apply to, and for Medicare Part D from the last day of its data year. A figure older than its source’s limit (${days(SOURCE_INFO.nadac.stale_after_days)} for NADAC, ${days(SOURCE_INFO.asp_limits.stale_after_days)} for Part B, ${days(SOURCE_INFO.partd.stale_after_days)} for Part D) is labelled stale on the card; it is never hidden or replaced by a zero. If a date comes out later than today, which a device’s clock or time zone can cause, the age is shown as 0 days and the figure is not stale.`,
  }),
]);

// deriveRecord() opens a reason with rule.description; calculated records open with the
// one-sentence summary, and methodology.html carries the full description.
function ruleFor(id) {
  const r = RULES.find((x) => x.id === id);
  if (!r) throw new Error(`no rule ${id}`);
  return { id: r.id, description: r.summary };
}

function honestyLine(id, markdown) {
  const parts = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(markdown))) {
    if (m.index > last) parts.push(Object.freeze({ text: markdown.slice(last, m.index), strong: false }));
    parts.push(Object.freeze({ text: m[1], strong: true }));
    last = re.lastIndex;
  }
  if (last < markdown.length) parts.push(Object.freeze({ text: markdown.slice(last), strong: false }));
  return Object.freeze({
    id,
    markdown,
    text: parts.map((p) => p.text).join(''),
    parts: Object.freeze(parts),
  });
}

/**
 * The five honesty lines, verbatim from the owner's brief. `text` is the plain sentence,
 * `markdown` keeps the bold as **…**, and `parts` lists the runs with `strong: true` on the
 * bold phrases, so a renderer can wrap those in <strong> (after esc()).
 * @type {readonly { id: string, text: string, markdown: string, parts: readonly { text: string, strong: boolean }[] }[]}
 */
export const HONESTY = Object.freeze([
  honestyLine('range', 'A price is a **range to expect**, never a quote.'),
  honestyLine('not-your-price', "**Medicare's price is not your price.** Say so on every screen that shows it."),
  honestyLine('provenance', 'State which dataset and which effective date produced every figure.'),
  honestyLine('stale', 'If a source is stale or a file is empty, show that rather than a zero.'),
  honestyLine('disclaimer', "Disclaimer footer: not medical advice, no warranty, other people's data can be wrong."),
]);

/**
 * @typedef {{ missing: true, reason: string }} Missing
 */

function missing(reason, extra) {
  return Object.freeze({ missing: true, reason, ...(extra || {}) });
}

function usable(rec, kind) {
  return Boolean(rec) && validateRecord(rec).length === 0 && rec.kind === kind;
}

function assertRecord(rec, kind, what) {
  const p = validateRecord(rec);
  if (p.length) throw new Error(`${what} is not a valid record: ${p.join('; ')}`);
  if (rec.kind !== kind) throw new Error(`${what} must be kind ${kind}, got ${rec.kind}`);
}

// An unlinked v3 row has part_d = { key, basis } and part_b without its table fields. Reading
// it as if linked would report "no Part D figure", which is false; refuse instead.
function assertLinked(row) {
  if (!row) return;
  const pd = row.part_d;
  if (pd && 'key' in pd && !('avg_per_unit' in pd) && !('brand_name' in pd)) {
    throw new Error(`row ${row.ndc}: part_d is not linked; pass the doc through linkRows() in pack.js first`);
  }
  const pb = row.part_b;
  if (pb && !('payment_limit' in pb) && !('hcpcs_dosage' in pb) && !('labelers' in pb)) {
    throw new Error(`row ${row.ndc}: part_b is not linked; pass the doc through linkRows() in pack.js first`);
  }
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function distinctSorted(values) {
  return [...new Set(values.filter((v) => v !== null && v !== undefined && v !== ''))].sort(cmp);
}

function showNdc(ndc) {
  return isNdc11(ndc) ? formatNdc(ndc) : String(ndc);
}

/**
 * Pack total: unit price × quantity. Multiplying a price by the quantity the reader picked is
 * the reader's own arithmetic, not a rule, so the total keeps the state and every source
 * field of `record` (source_name, source_url, source_file, the dates, period); only value,
 * reason and per change. The value is the exact product rounded half-up to cents. A product
 * above zero that rounds to $0.00 keeps its exact value instead, so formatMoney() shows it as
 * "<$0.01", never "$0.00". The reason shows the multiplication ("60 × $0.01451 per EA,
 * rounded to cents: $0.87 …") followed by the unit price's own reason; `per` is
 * "<qty> <unit>", e.g. "60 EA". Missing for an unusable quantity. Throws if `record` is not a
 * valid usd record.
 * @param {object} record usd record, e.g. row.nadac
 * @param {number|string} qty
 * @returns {object|Missing}
 */
export function unitTotal(record, qty) {
  assertRecord(record, 'usd', 'unitTotal record');
  const problem = quantityProblem(qty);
  if (problem) return missing(problem);
  const exact = multiplyMoney(record.value, qty);
  const rounded = roundMoney(exact);
  const q = formatCount(Number(decimalString(qty)));
  const price = `${formatUnitPrice(record.value)}${record.per ? ` per ${record.per}` : ''}`;
  const exactText = `$${formatCount(exact)}`; // exact, with thousands separators like the rounded total
  let value;
  let arithmetic;
  if (rounded > 0) {
    value = rounded;
    arithmetic =
      `${q} × ${price}, rounded to cents: ${formatMoney(rounded)}` +
      (rounded === exact ? '.' : ` (exactly ${exactText}, rounded half-up).`);
  } else {
    value = exact;
    arithmetic = `${q} × ${price} = ${exactText}, which is under half a cent, so it is shown as <$0.01 rather than rounded to $0.00.`;
  }
  return makeRecord({
    ...record,
    value,
    reason: `${arithmetic} The price per unit: ${record.reason}`,
    per: record.per ? `${decimalString(qty)} ${record.per}` : undefined,
  });
}

/**
 * The Part B payment limit converted to dollars per NADAC unit:
 * payment_limit × bill_units_per_package ÷ (package_size × package_qty).
 * Only when row.part_b.package_unit === row.unit (the crosswalk package unit was reconciled
 * to the NADAC unit), package_size is a quantity in that unit, and every input is present
 * and positive; otherwise Missing with the reason. Derived: same NDC, same quarter, an exact
 * unit conversion. `row` is a linked row (linkRows in pack.js).
 * @param {object} row
 * @returns {object|Missing}
 */
export function partBPerNadacUnit(row) {
  assertLinked(row);
  const pb = row && row.part_b;
  if (!pb) {
    return missing('This NDC is not in the current quarter’s Medicare Part B NDC-HCPCS crosswalk, so it has no Part B payment limit.');
  }
  const code = pb.hcpcs || 'its HCPCS code';
  if (pb.package_unit === null || pb.package_unit === undefined) {
    return missing(
      `The Part B crosswalk’s package unit for ${code} could not be matched to the NADAC unit (${row.unit}), so the payment limit cannot be converted to a price per ${row.unit}.`,
    );
  }
  if (pb.package_unit !== row.unit) {
    return missing(
      `The Part B crosswalk counts packages of ${code} in ${pb.package_unit}, but NADAC prices this NDC per ${row.unit}, so the payment limit cannot be converted.`,
    );
  }
  const need = [
    ['payment_limit', 'usd', 'payment limit'],
    ['bill_units_per_package', 'count', 'billing units per package'],
    ['package_size', 'quantity', 'package size'],
    ['package_qty', 'count', 'package quantity'],
  ];
  for (const [key, kind, label] of need) {
    const rec = pb[key];
    if (!usable(rec, kind) || !(rec.value > 0)) {
      return missing(`The Part B files have no usable ${label} for this NDC (${code}), so the payment limit cannot be converted to a price per ${row.unit}.`);
    }
  }
  if (pb.package_size.per === undefined) {
    return missing(
      `The Part B crosswalk does not state the unit of this NDC’s package size (${code}), so the payment limit cannot be converted to a price per ${row.unit}.`,
    );
  }
  if (pb.package_size.per !== row.unit) {
    return missing(
      `The Part B crosswalk gives this NDC’s package size in ${pb.package_size.per}, not in NADAC’s unit ${row.unit}, so the payment limit cannot be converted.`,
    );
  }
  const limit = pb.payment_limit;
  const units = pb.bill_units_per_package;
  const size = pb.package_size;
  const pkgs = pb.package_qty;
  const value = divideMoney(multiplyDecimal(limit.value, units.value), multiplyDecimal(size.value, pkgs.value), 10);
  if (!(value > 0)) {
    return missing(`The Part B payment limit for ${code} converts to less than $0.0000000001 per ${row.unit}; OpenBill does not show a zero price.`);
  }
  const dosage = pb.hcpcs_dosage || limit.per || 'billing unit';
  return deriveRecord({
    value,
    kind: 'usd',
    per: row.unit,
    rule: ruleFor('part-b-per-nadac-unit'),
    inputs: [limit, units, size, pkgs],
    labels: ['payment limit', 'billing units per package', 'package size', 'package quantity'],
    comparable: true,
    detail: `${formatUnitPrice(limit.value)} per ${dosage} (${code}) × ${formatCount(units.value)} billing units per package ÷ (${formatCount(size.value)} ${row.unit} × ${formatCount(pkgs.value)}) = ${formatUnitPrice(value)} per ${row.unit}`,
  });
}

/**
 * Pack total for the Part B figure: the quantity × the Part B price per NADAC unit, worked
 * out exactly from the filed inputs, payment_limit × bill_units_per_package × qty ÷
 * (package_size × package_qty), and only then rounded half-up to cents. partBPerNadacUnit()
 * keeps 10 decimals, so multiplying that rounded figure could land just under a half cent
 * (75 × 0.0139333333 = 1.0449999975 → $1.04, where the exact 1.045 is $1.05). Like
 * unitTotal(), the total keeps the state and every source field of the per-unit record it
 * scales; only value, reason and per change. A total above zero that rounds to $0.00 keeps a
 * 10-decimal value, so formatMoney() shows "<$0.01". Missing when there is no usable Part B
 * price per unit (with partBPerNadacUnit's reason) or the quantity is unusable.
 * @param {object} row a linked row
 * @param {number|string} qty
 * @returns {object|Missing}
 */
export function partBPackTotal(row, qty) {
  const unit = partBPerNadacUnit(row);
  if (unit.missing) return unit;
  const problem = quantityProblem(qty);
  if (problem) return missing(problem);
  const pb = row.part_b;
  const q = decimalString(qty);
  const numerator = multiplyDecimal(multiplyDecimal(pb.payment_limit.value, pb.bill_units_per_package.value), q);
  const denominator = multiplyDecimal(pb.package_size.value, pb.package_qty.value);
  const rounded = divideMoney(numerator, denominator, 2);
  const dosage = pb.hcpcs_dosage || pb.payment_limit.per || 'billing unit';
  const arithmetic =
    `${formatCount(Number(q))} ${row.unit} × ${formatUnitPrice(pb.payment_limit.value)} per ${dosage} (${pb.hcpcs}) × ${formatCount(pb.bill_units_per_package.value)} billing units per package ÷ ` +
    `(${formatCount(pb.package_size.value)} ${row.unit} × ${formatCount(pb.package_qty.value)}) = $${formatCount(Number(numerator))} ÷ ${formatCount(Number(denominator))}`;
  let value;
  let text;
  if (rounded > 0) {
    value = rounded;
    text = `${arithmetic}, worked out exactly and rounded half-up to cents: ${formatMoney(rounded)}.`;
  } else {
    value = divideMoney(numerator, denominator, 10);
    if (!(value > 0)) return missing(`The Part B total for ${q} ${row.unit} is less than $0.0000000001; OpenBill does not show a zero price.`);
    text = `${arithmetic}, which is under half a cent, so it is shown as <$0.01 rather than rounded to $0.00.`;
  }
  return makeRecord({
    ...unit,
    value,
    reason: `${text} The price per unit: ${unit.reason}`,
    per: `${q} ${row.unit}`,
  });
}

/**
 * Part B coinsurance per HCPCS billing unit: payment_limit × coinsurance_pct ÷ 100, derived.
 * Missing when the row has no Part B data, an input is unusable, or the percentage is 0.
 * @param {object} row a linked row
 * @returns {object|Missing}
 */
export function partBCoinsurance(row) {
  assertLinked(row);
  const pb = row && row.part_b;
  if (!pb) return missing('This NDC has no Medicare Part B payment limit, so there is no Part B coinsurance to show.');
  const code = pb.hcpcs || 'its HCPCS code';
  if (!usable(pb.payment_limit, 'usd')) return missing(`The Part B file has no usable payment limit for ${code}.`);
  if (!usable(pb.coinsurance_pct, 'percent')) return missing(`The Part B file has no usable coinsurance percentage for ${code}.`);
  const limit = pb.payment_limit;
  const pct = pb.coinsurance_pct;
  if (pct.value === 0) return missing(`The Part B file lists 0% coinsurance for ${code}, so there is no coinsurance amount to show.`);
  const value = divideMoney(multiplyDecimal(limit.value, pct.value), 100, 10);
  const per = limit.per || pb.hcpcs_dosage;
  return deriveRecord({
    value,
    kind: 'usd',
    per,
    rule: ruleFor('part-b-coinsurance'),
    inputs: [limit, pct],
    labels: ['payment limit', 'coinsurance'],
    comparable: true,
    detail: `${formatUnitPrice(limit.value)}${per ? ' per ' + per : ''} × ${formatPercent(pct.value)} = ${formatUnitPrice(value)}`,
  });
}

/**
 * Why Part B is not the main reference for a pharmacy drug: the note for an injected or
 * infused drug, and the general form. partBSettingNote(row) picks the note for a row's code.
 */
export const PART_B_SETTING_NOTE =
  'Medicare Part B pays for a drug like this only in specific settings, such as a drug given in a clinic or doctor’s office or used with certain medical equipment; most prescriptions filled at a pharmacy are paid by Part D.';

/**
 * The setting notes by kind of drug: `oral` for a drug taken by mouth (Part B pays for some at
 * a pharmacy, in circumstances CMS sets for the code), `inhalation` for a drug breathed in, and
 * `other` (PART_B_SETTING_NOTE) for everything else. None names a clinical condition.
 */
export const PART_B_SETTING_NOTES = Object.freeze({
  oral: 'Medicare Part B pays for this oral drug at a pharmacy only in specific circumstances CMS sets for this code; most prescriptions are paid by Part D.',
  inhalation:
    'Medicare Part B pays for an inhaled drug like this only in specific circumstances, such as when it is used with medical equipment like a nebulizer; most prescriptions filled at a pharmacy are paid by Part D.',
  other: PART_B_SETTING_NOTE,
});

/**
 * Which setting note applies to a linked row with Part B data: `oral` when FDA lists the NDC's
 * route as ORAL or the payment limit file's short description of the code says "oral";
 * `inhalation` when the FDA route is an inhalation route; otherwise `other`.
 * @param {object} row
 * @returns {'oral'|'inhalation'|'other'}
 */
export function partBSettingKind(row) {
  const route = String((row && row.identity && row.identity.route) || '').toUpperCase();
  const desc = String((row && row.part_b && row.part_b.short_description) || '');
  if (/(^|;\s*)ORAL($|;)/.test(route) || /\boral\b/i.test(desc)) return 'oral';
  if (/INHALATION/.test(route)) return 'inhalation';
  return 'other';
}

/**
 * The setting note for a linked row's Part B figure (PART_B_SETTING_NOTES[partBSettingKind(row)]).
 * @param {object} row
 * @returns {string}
 */
export function partBSettingNote(row) {
  return PART_B_SETTING_NOTES[partBSettingKind(row)];
}

/** Said wherever a Part D figure whose CMS outlier flag is blank is used. */
export const PART_D_BLANK_FLAG_NOTE =
  'The Part D file leaves the outlier flag for this drug blank. OpenBill counts a blank flag as not flagged, so the figure is used, but CMS has not said whether unusual records distort it.';

/**
 * @typedef {object} Reference
 * @property {'part_d'|'part_b'} kind
 * @property {string} label   "Medicare Part D average spending" or "Medicare Part B payment limit"
 * @property {'present'|'past'} tense  for describeSpread: Part B is the current quarter, Part D a past year
 * @property {object} record  usd record per NADAC unit: the filed Part D record, or the derived
 *                            Part B conversion (partBPerNadacUnit)
 * @property {string} reason  what the figure is, in a sentence or two, for the provenance panel
 *                            (Part B always includes PART_B_SETTING_NOTE; Part D with a blank
 *                            outlier flag includes PART_D_BLANK_FLAG_NOTE)
 * @property {Reference|null} alternate  on referencePrice() results only: the Part B figure
 *                            when Part D is the reference and Part B is usable too; else null
 * @property {string} [part_b_reason] why Part B is not available, when it is not
 * @property {string} [part_d_reason] why Part D is not used, when it is not
 */

function partDProblem(row) {
  const pd = row && row.part_d;
  if (!pd) return 'No Medicare Part D spending row matched this drug by brand or generic name.';
  if (pd.outlier === true) {
    return 'The Part D file flags this drug’s average spending per dosage unit as an outlier, so OpenBill does not use it as a reference price.';
  }
  if (!usable(pd.avg_per_unit, 'usd')) return 'The matched Part D row has no usable average spending per dosage unit.';
  const per = pd.avg_per_unit.per;
  if (per === undefined) {
    return `The Part D average does not say which unit it is per, so it cannot be compared with NADAC’s price per ${row.unit}.`;
  }
  if (per !== row.unit) {
    return `The Part D average is per ${per}, but NADAC prices this NDC per ${row.unit}, so the two cannot be compared.`;
  }
  return null;
}

function partDNames(pd) {
  return [pd.brand_name, pd.generic_name]
    .filter((n) => typeof n === 'string' && n.trim())
    .filter((n, i, all) => all.findIndex((x) => x.toUpperCase() === n.toUpperCase()) === i)
    .map((n) => `“${n}”`)
    .join(' / ');
}

function periodText(rec) {
  const p = parsePeriod(rec.period);
  return p ? `${p.start} to ${p.end}` : `the period starting ${rec.effective_date}`;
}

function partDReference(row) {
  const pd = row.part_d;
  const rec = pd.avg_per_unit;
  const basis = pd.basis === 'brand' ? 'its brand name' : pd.basis === 'generic' ? 'its generic name' : 'name';
  let reason = `Medicare Part D’s average spending per ${rec.per} for ${partDNames(pd) || 'the matched name'}, ${periodText(rec)}, matched to this NDC by ${basis}.`;
  if (pd.outlier === null) reason += ` ${PART_D_BLANK_FLAG_NOTE}`;
  return { kind: 'part_d', label: 'Medicare Part D average spending', tense: 'past', record: rec, reason };
}

function partBReference(row, rec) {
  const pb = row.part_b;
  const dosage = pb.hcpcs_dosage || pb.payment_limit.per || 'billing unit';
  // The code's own description says which setting it pays in (J1817: "Insulin for insulin pump
  // use"). It is null for CPT codes, whose descriptors are AMA copyright, and then left out.
  const described =
    typeof pb.short_description === 'string' && pb.short_description.trim()
      ? ` The CMS payment limit file describes HCPCS ${pb.hcpcs} as “${pb.short_description.trim()}”.`
      : '';
  const note = partBSettingNote(row);
  return {
    kind: 'part_b',
    label: 'Medicare Part B payment limit',
    tense: 'present',
    record: rec,
    reason: `Medicare Part B’s payment limit for HCPCS ${pb.hcpcs} (per ${dosage}) for ${periodText(pb.payment_limit)}, converted to dollars per ${row.unit} for this NDC.${described} ${note}`,
    setting_note: note,
    inputs: partBInputs(row),
  };
}

/** The filed inputs of a row's Part B price per NADAC unit, labelled for inputDates(). */
function partBInputs(row) {
  const pb = row.part_b;
  return Object.freeze([
    Object.freeze({ label: 'Part B limit', record: pb.payment_limit }),
    Object.freeze({ label: 'Part B crosswalk', record: pb.bill_units_per_package }),
    Object.freeze({ label: 'Part B crosswalk', record: pb.package_size }),
    Object.freeze({ label: 'Part B crosswalk', record: pb.package_qty }),
  ]);
}

/**
 * The inputs of a calculated figure, with each input's own date or period, for showing next to
 * the figure (docs/ARCHITECTURE.md: "Next to any calculated figure the card shows each input's
 * own date or period, never the oldest date alone"). A calculated record is flat and keeps only
 * the oldest of its inputs' dates, so the inputs are passed in: [{ label, record }], e.g.
 * { label: 'NADAC', record: row.nadac }. Inputs with the same label are merged; each distinct
 * date is listed. Returns, in first-seen label order, frozen
 * { label, source_name, source_files, effective_dates, periods, as_of_dates, retrieved_dates, text }
 * where text is e.g. "NADAC eff. 2026-09-23 (file of 2026-10-14, retrieved 2026-10-17)" or
 * "Part D 2024-01-01 to 2024-12-31 (file of 2026-06-25, retrieved 2026-10-18)". Up to three
 * distinct effective dates are listed; more are given as "between <first> and <last>, N dates".
 * @param {{ label: string, record: object }[]} inputs
 * @returns {readonly object[]}
 */
export function inputDates(inputs) {
  if (!Array.isArray(inputs)) throw new TypeError('inputDates needs an array of { label, record }');
  const groups = new Map();
  for (const x of inputs) {
    if (!x || typeof x.label !== 'string' || !x.label.trim()) throw new TypeError('inputDates: every input needs a label');
    const p = validateRecord(x.record);
    if (p.length) throw new Error(`inputDates: the ${x.label} input is not a valid record: ${p.join('; ')}`);
    if (!groups.has(x.label)) groups.set(x.label, []);
    groups.get(x.label).push(x.record);
  }
  const list = (values) => distinctSorted(values);
  const out = [];
  for (const [label, recs] of groups) {
    const periods = list(recs.map((r) => r.period));
    const effective = list(recs.map((r) => r.effective_date));
    const asOf = list(recs.map((r) => r.as_of_date));
    const retrieved = list(recs.map((r) => r.retrieved_date));
    const bits = [];
    if (periods.length) {
      bits.push(
        periods
          .map((p) => {
            const pp = parsePeriod(p);
            return `${pp.start} to ${pp.end}`;
          })
          .join(', '),
      );
      // Period data is effective from its period's start; say so only when that differs.
      const startsOwnPeriod = (r) => Boolean(r.period) && parsePeriod(r.period).start === r.effective_date;
      if (!recs.every(startsOwnPeriod)) bits.unshift(`eff. ${datesText(effective)}`);
    } else {
      bits.push(`eff. ${datesText(effective)}`);
    }
    const meta = [];
    if (asOf.length) meta.push(`file of ${datesText(asOf)}`);
    meta.push(`retrieved ${datesText(retrieved)}`);
    out.push(
      Object.freeze({
        label,
        source_name: list(recs.map((r) => r.source_name)).join(' / '),
        source_files: Object.freeze(list(recs.flatMap((r) => String(r.source_file).split(' + ')))),
        effective_dates: Object.freeze(effective),
        periods: Object.freeze(periods),
        as_of_dates: Object.freeze(asOf),
        retrieved_dates: Object.freeze(retrieved),
        text: `${label} ${bits.join(', ')} (${meta.join(', ')})`,
      }),
    );
  }
  return Object.freeze(out);
}

function datesText(dates) {
  if (dates.length <= 3) return dates.join(', ');
  return `between ${dates[0]} and ${dates[dates.length - 1]}, ${formatCount(dates.length)} dates`;
}

/**
 * The Medicare reference price for one linked row. Part D first: the data-year average for the
 * matched name, when its unit equals row.unit and CMS does not flag it as an outlier (a blank
 * flag, outlier null, counts as not flagged and the reason says so). Otherwise Part B: the
 * payment limit converted to the NADAC unit (partBPerNadacUnit), when the package unit is
 * reconciled. Otherwise Missing with `reason`, `part_d_reason` and `part_b_reason`.
 * When Part D is the reference and Part B is usable too, `alternate` is the Part B Reference
 * (for the provenance panel); otherwise `alternate` is null and the reason the other figure
 * is unavailable is in `part_b_reason` or `part_d_reason`.
 * @param {object} row
 * @returns {Reference|Missing}
 */
export function referencePrice(row) {
  assertLinked(row);
  const d = partDProblem(row);
  const b = partBPerNadacUnit(row);
  if (d === null) {
    const ref = partDReference(row);
    return Object.freeze({
      ...ref,
      alternate: b.missing ? null : Object.freeze(partBReference(row, b)),
      ...(b.missing ? { part_b_reason: b.reason } : {}),
    });
  }
  if (!b.missing) return Object.freeze({ ...partBReference(row, b), alternate: null, part_d_reason: d });
  return missing(`No Medicare reference price. Part D: ${d} Part B: ${b.reason}`, { part_d_reason: d, part_b_reason: b.reason });
}

// Direction-specific: "at or beyond 20× or 0.2×" left the reader to work out which end applied.
function extremeCaveat(value) {
  const size =
    value >= EXTREME_HIGH
      ? `the Medicare figure is ${EXTREME_HIGH} or more times what pharmacies pay`
      : `the Medicare figure is ${EXTREME_LOW} times what pharmacies pay or less`;
  return `At ${formatMultiple(value)}, ${size}. A gap that large means the two figures may not describe the same unit or product, or the price may have changed between their dates; check what each one covers before relying on the multiple.`;
}

/**
 * The spread: reference per unit ÷ NADAC per unit, as a ratio record. `comparable` and
 * `caveats` decide derived vs estimated (see deriveRecord). If the two records are per
 * different units the spread is estimated and says so. An estimated spread at or above
 * EXTREME_HIGH (20×) or at or below EXTREME_LOW (0.2×) also carries the caveat that the two
 * figures may not describe the same unit or product. Missing if the ratio rounds to 0.
 * @param {object} nadacRec usd record
 * @param {object} refRec   usd record
 * `basis`, when given, is a sentence saying why the two figures are comparable; it follows the
 * arithmetic in the reason, so a derived spread says why it is derived.
 * @param {{ comparable: boolean, caveats?: string[], basis?: string }} opts
 * @returns {object|Missing}
 */
export function spread(nadacRec, refRec, opts) {
  assertRecord(nadacRec, 'usd', 'spread NADAC record');
  assertRecord(refRec, 'usd', 'spread reference record');
  let comparable = opts && opts.comparable;
  const caveats = [...((opts && opts.caveats) || [])];
  if (nadacRec.per && refRec.per && nadacRec.per !== refRec.per) {
    comparable = false;
    caveats.push(`The reference price is per ${refRec.per} but NADAC is per ${nadacRec.per}.`);
  }
  const value = divideMoney(refRec.value, nadacRec.value, 10);
  if (!(value > 0)) return missing('The reference price is too small next to NADAC to state as a multiple.');
  const weakInput = [refRec, nadacRec].some((r) => !['filed', 'published', 'derived'].includes(r.state));
  if ((comparable === false || weakInput) && (value >= EXTREME_HIGH || value <= EXTREME_LOW)) caveats.push(extremeCaveat(value));
  return deriveRecord({
    value,
    kind: 'ratio',
    rule: ruleFor('spread'),
    inputs: [refRec, nadacRec],
    labels: ['reference price', 'pharmacy price'],
    comparable,
    caveats,
    detail: [`${formatUnitPrice(refRec.value)} ÷ ${formatUnitPrice(nadacRec.value)} = ${formatSpreadMultiple(value)}`, opts && opts.basis]
      .filter((s) => typeof s === 'string' && s.trim())
      .join('. '),
  });
}

function lowerMedian(values) {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor((v.length - 1) / 2)];
}

/**
 * What nameOutlier() compares a product with: for every Part D name that linked rows point at,
 * each product's (row.name's) NADAC prices per unit. Build it once from all linked rows and pass
 * it to summarizeProduct(rows, qty, { partDContext }).
 * @param {object[]} rows linked rows (linkRows)
 * @returns {Map<string, Map<string, Map<string, number[]>>>} key → product name → unit → NADAC values
 */
export function partDNameContext(rows) {
  const out = new Map();
  for (const row of rows) {
    if (!row || !row.part_d || !row.part_d.key || !usable(row.nadac, 'usd')) continue;
    if (!out.has(row.part_d.key)) out.set(row.part_d.key, new Map());
    const byName = out.get(row.part_d.key);
    if (!byName.has(row.name)) byName.set(row.name, new Map());
    const byUnit = byName.get(row.name);
    if (!byUnit.has(row.unit)) byUnit.set(row.unit, []);
    byUnit.get(row.unit).push(row.nadac.value);
  }
  return out;
}

/**
 * The name-outlier caveat for a row joined to a Part D name, or null: when the lower median of
 * this product's NADAC prices (per row.unit) is at least NAME_OUTLIER_FACTOR times the lower
 * median of the other products' own lower medians under the same name and unit. Only that
 * direction: a product far cheaper than the others is often the common one that dominates the
 * claims, so nothing says the average describes the others. Null without a context, or with no
 * other product to compare.
 * @param {object} row linked row with part_d
 * @param {Map} [context] partDNameContext(allRows)
 * @returns {{ ratio: number, mine: number, others: number, products: number, text: string }|null}
 */
export function nameOutlier(row, context) {
  if (!context || !row.part_d || !context.has(row.part_d.key)) return null;
  const byName = context.get(row.part_d.key);
  const mineValues = byName.has(row.name) ? byName.get(row.name).get(row.unit) : null;
  if (!mineValues || !mineValues.length) return null;
  const medians = [];
  for (const [name, byUnit] of byName) {
    if (name === row.name || !byUnit.has(row.unit)) continue;
    medians.push(lowerMedian(byUnit.get(row.unit)));
  }
  if (!medians.length) return null;
  const mine = lowerMedian(mineValues);
  const others = lowerMedian(medians);
  const ratio = divideMoney(mine, others, 10);
  if (!(ratio >= NAME_OUTLIER_FACTOR)) return null;
  const n = medians.length;
  const unit = row.unit ? ` per ${row.unit}` : '';
  const text = `This product’s middle NADAC price, ${formatUnitPrice(mine)}${unit}, is ${formatMultiple(ratio)} the middle NADAC price of the ${formatCount(n)} other product${n === 1 ? '' : 's'} CMS averages under ${partDNames(row.part_d) || 'the same Part D name'} (${formatUnitPrice(others)}${unit}), so the Part D average may mostly describe ${n === 1 ? 'that product' : 'those products'}, not this one.`;
  return Object.freeze({ ratio, mine, others, products: n, text });
}

function partDCaveats(row, context) {
  const pd = row.part_d;
  const rec = pd.avg_per_unit;
  const nadacDate = row.nadac.as_of_date || row.nadac.effective_date;
  const outlier = nameOutlier(row, context);
  const caveats = [
    ...(outlier ? [outlier.text] : []),
    `Part D averages every strength and form sold under ${partDNames(pd) || 'one brand and generic name'} into one figure, so it is not specific to this NDC.`,
    `The Part D figure covers ${periodText(rec)}; the NADAC price is from the file of ${nadacDate}.`,
    `Part D spending basis, as the Part D record states it: ${rec.reason}`,
  ];
  if (pd.outlier === null) caveats.push(PART_D_BLANK_FLAG_NOTE);
  return caveats;
}

// The payment limit file's Notes column, as tools/build_drugs.py quotes it in the limit's reason
// ("Notes column for this code: '…'."). Null when the reason quotes none.
function partBNotes(pb) {
  const m = /Notes column for this code: '(.+?)'\.(?:\s|$)/.exec(String((pb.payment_limit && pb.payment_limit.reason) || ''));
  return m ? m[1] : null;
}

/**
 * True when the Part B file's Notes for a code say its limit is not simply worked out from the
 * labeler's own average sales price: the "lesser of" methodology, or the add-on of a share of the
 * reference product's price that a biosimilar's limit includes.
 * @param {object} pb a linked row's part_b
 * @returns {boolean}
 */
function limitNotOwnPrice(pb) {
  const notes = partBNotes(pb);
  return Boolean(notes) && /lesser of|reference add-on/i.test(notes);
}

// Corporate suffixes dropped from the end of a labeler name when telling companies apart.
const LABELER_SUFFIXES = /(?:\s(?:inc|incorporated|llc|l l c|llp|lp|l p|ltd|limited|corp|corporation|co|company|plc))+$/;

/**
 * The key two spellings of one company's name share: case folded, every run of punctuation
 * and white space made one space, and trailing corporate suffixes (Inc, LLC, Ltd, Corp, Co,
 * Company, LP, PLC …) dropped. "UCB, INC." and "UCB, Inc." share a key; so do "Apollo
 * Pharmaceuticals" and "Apollo Pharmaceuticals Inc.". Nothing else is merged: "Fresenius Kabi
 * USA" and "Fresenius Kabi" stay apart.
 * @param {string} name
 * @returns {string}
 */
export function labelerKey(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(LABELER_SUFFIXES, '')
    .trim();
}

/**
 * The distinct companies among a Part B code's crosswalk labeler names (labelerKey), in the
 * order first seen: [{ name, spellings }], where `name` is the first spelling and `spellings`
 * every raw name that shares its key, exactly as the crosswalk writes them. CMS writes some
 * companies several ways on one code (J0717: "UCB, INC." and "UCB, Inc."); that is still one
 * labeler. Returns null when the list is missing.
 * @param {string[]|undefined} labelers
 * @returns {{ name: string, spellings: string[] }[]|null}
 */
export function distinctLabelers(labelers) {
  if (!Array.isArray(labelers)) return null;
  const byKey = new Map();
  for (const raw of labelers) {
    const k = labelerKey(raw);
    if (!byKey.has(k)) byKey.set(k, { name: raw, spellings: [] });
    const e = byKey.get(k);
    if (!e.spellings.includes(raw)) e.spellings.push(raw);
  }
  return [...byKey.values()].map((e) => Object.freeze({ name: e.name, spellings: Object.freeze(e.spellings) }));
}

function labelerWords(l) {
  return l.spellings.length > 1 ? `${l.name} (written ${l.spellings.map((x) => `“${x}”`).join(' and ')} on the crosswalk)` : l.name;
}

function partBComparability(row) {
  const pb = row.part_b;
  const labelers = distinctLabelers(pb.labelers);
  if (labelers && labelers.length === 1 && limitNotOwnPrice(pb)) {
    return {
      comparable: false,
      caveats: [
        `Only one labeler, ${labelerWords(labelers[0])}, is listed for HCPCS ${pb.hcpcs} on the CMS crosswalk, but the payment limit file’s Notes for the code say “${partBNotes(pb)}”, so the limit is not worked out from that company’s own sales price alone.`,
      ],
    };
  }
  if (labelers && labelers.length === 1) {
    return {
      comparable: true,
      caveats: [],
      basis: `Derived because only one labeler, ${labelerWords(labelers[0])}, is listed for HCPCS ${pb.hcpcs} on the CMS crosswalk, so the payment limit comes from that company’s own products under the code, not an average across companies`,
    };
  }
  if (labelers && labelers.length > 1) {
    const merged = labelers.filter((l) => l.spellings.length > 1);
    return {
      comparable: false,
      caveats: [
        `${formatCount(labelers.length)} labelers share HCPCS ${pb.hcpcs} on the CMS crosswalk, so its payment limit is an average across all their products billed under that code, not this NDC’s own price.${
          merged.length ? ` (Counted once each though written more than one way: ${merged.map((l) => l.spellings.map((x) => `“${x}”`).join(' and ')).join('; ')}.)` : ''
        }`,
      ],
    };
  }
  return {
    comparable: false,
    caveats: [`The crosswalk’s list of labelers for HCPCS ${pb.hcpcs} is missing, so OpenBill cannot tell whether the payment limit is this product’s own.`],
  };
}

/**
 * True for a spread record that carries the extreme-gap caveat: an estimated ratio at or above
 * EXTREME_HIGH or at or below EXTREME_LOW. Its card headline is EXTREME_HEADLINE.
 * @param {object} rec
 * @returns {boolean}
 */
export function isExtremeSpread(rec) {
  return Boolean(rec) && rec.kind === 'ratio' && rec.state === 'estimated' && (rec.value >= EXTREME_HIGH || rec.value <= EXTREME_LOW);
}

function spreadFromReference(row, ref, context) {
  if (ref.missing) return ref;
  if (!usable(row.nadac, 'usd')) return missing('This NDC has no usable NADAC price to compare with.');
  const outlier = ref.kind === 'part_d' ? nameOutlier(row, context) : null;
  const opts = ref.kind === 'part_d' ? { comparable: false, caveats: partDCaveats(row, context) } : partBComparability(row);
  const s = spread(row.nadac, ref.record, opts);
  if (s.missing) return s;
  const extreme = isExtremeSpread(s);
  const refInputs = ref.kind === 'part_b' ? ref.inputs || partBInputs(row) : [{ label: 'Part D', record: ref.record }];
  return Object.freeze({
    kind: ref.kind,
    label: ref.label,
    tense: ref.tense,
    reference: ref.record,
    record: s,
    extreme,
    sentence: extreme ? EXTREME_HEADLINE : describeSpread(s, { tense: ref.tense }),
    name_outlier: outlier ? outlier.text : null,
    inputs: Object.freeze([Object.freeze({ label: 'NADAC', record: row.nadac }), ...refInputs]),
  });
}

/**
 * The spread for one linked row against its reference price (referencePrice), with the plain
 * sentence: { kind, label, tense, reference (usd record), record (ratio record), extreme,
 * sentence, inputs }, or Missing. `extreme` is isExtremeSpread(record); `sentence` is then
 * EXTREME_HEADLINE, otherwise describeSpread()'s sentence. `inputs` lists [{ label, record }]:
 * the NADAC record, then the Part D average, or the Part B limit and crosswalk records (pass
 * them to inputDates() to show each input's own date). A Part B spread whose single labeler's
 * limit the payment limit file's Notes mark "lesser of" or "reference add-on" is estimated. Part D spreads are always estimated, with caveats: all strengths and forms
 * averaged under one name; the Part D data year against the NADAC week; the Part D spending
 * basis, quoted from the Part D record's own reason; and a blank outlier flag when it is
 * blank. Part B spreads are derived only when part_b.labelers has exactly one name; otherwise
 * estimated, saying how many labelers share the code. Any estimated spread ≥ 20× or ≤ 0.2×
 * adds the extreme-gap caveat. With `context` (partDNameContext of all rows), a Part D spread of a
 * product far from the others under its name leads its caveats with nameOutlier()'s sentence,
 * also given as `name_outlier` (null otherwise).
 * @param {object} row
 * @param {Map} [context]
 * @returns {object|Missing}
 */
export function spreadForRow(row, context) {
  return spreadFromReference(row, referencePrice(row), context);
}

/**
 * One plain sentence for a spread (a number or a ratio record):
 * ≥ 1.05 "Medicare paid 4.9× what pharmacies pay."; 0.95 to under 1.05 "Medicare paid about
 * what pharmacies pay."; under 0.95 "Medicare paid 8% less than pharmacies pay."
 * tense 'present' says "pays" (Part B, current quarter); 'past' (default) says "paid".
 * @param {number|{ value: number }} ratio
 * @param {{ tense?: 'past'|'present' }} [opts]
 * @returns {string}
 */
export function describeSpread(ratio, opts = {}) {
  const r = typeof ratio === 'number' ? ratio : ratio && ratio.value;
  if (typeof r !== 'number' || !Number.isFinite(r) || r <= 0) throw new TypeError(`describeSpread needs a positive ratio, got ${r}`);
  const verb = opts.tense === 'present' ? 'pays' : 'paid';
  if (r >= 1.05) return `Medicare ${verb} ${formatSpreadMultiple(r)} what pharmacies pay.`;
  if (r >= 0.95) return `Medicare ${verb} about what pharmacies pay.`;
  const pct = roundHalfUp(multiplyDecimal(subtractDecimal(1, r), 100), 0);
  if (pct >= 100) return `Medicare ${verb} less than 1% of what pharmacies pay.`;
  return `Medicare ${verb} ${pct}% less than pharmacies pay.`;
}

/**
 * The sentence for a range of spreads across a product's NDCs. Equal ends give
 * describeSpread(min); otherwise "Medicare paid between 2.1× and 4.9× what pharmacies pay,
 * depending on the NDC."
 * @param {number|{ value: number }} min
 * @param {number|{ value: number }} max
 * @param {{ tense?: 'past'|'present' }} [opts]
 * @returns {string}
 */
export function describeSpreadRange(min, max, opts = {}) {
  const a = typeof min === 'number' ? min : min.value;
  const b = typeof max === 'number' ? max : max.value;
  const sa = describeSpread(a, opts);
  if (sa === describeSpread(b, opts)) return sa;
  const verb = opts.tense === 'present' ? 'pays' : 'paid';
  return `Medicare ${verb} between ${formatSpreadMultiple(a)} and ${formatSpreadMultiple(b)} what pharmacies pay, depending on the NDC.`;
}

const CADENCE_PHRASE = Object.freeze({ daily: 'every day', weekly: 'every week', quarterly: 'every quarter', annual: 'once a year' });

/**
 * How old a record (or a `sources` entry of data/drugs.json) is, against its source's
 * threshold. The date measured from is set by sourceInfo.age_from (SOURCE_INFO in sources.js):
 * 'as_of_date' (NADAC, FDA: the file's own date; a record without one falls back to its
 * effective_date, and the message says so), 'period_start' (Part B: the first day of the
 * quarter) or 'period_end' (Part D: the last day of the data year). Period data needs its
 * `period`: effective_date is the period start, so it is never used as the end. With no
 * usable date the figure is reported as stale with age_days null. A date after today (a
 * viewer's clock or time zone) gives age_days 0 and is never stale.
 * @param {object} record
 * @param {object} sourceInfo an entry of SOURCE_INFO (sources.js)
 * @param {string} todayIso today's date, YYYY-MM-DD (injected; nothing reads the clock)
 * @returns {{ stale: boolean, age_days: number|null, date: string|null, basis: string, message: string }}
 */
export function freshness(record, sourceInfo, todayIso) {
  if (!isIsoDate(todayIso)) throw new RangeError(`freshness needs today as YYYY-MM-DD, got ${JSON.stringify(todayIso)}`);
  if (!sourceInfo || !Number.isFinite(sourceInfo.stale_after_days)) throw new Error('freshness needs a SOURCE_INFO entry');
  const basis = sourceInfo.age_from || 'as_of_date';
  const p = parsePeriod(record && record.period);
  const span = sourceInfo.cadence === 'quarterly' ? 'quarter' : sourceInfo.cadence === 'annual' ? 'data year' : 'period';
  let date = null;
  let what;
  if (basis === 'period_start') {
    date = p ? p.start : null;
    what = `${sourceInfo.label} ${span} starting ${date}`;
  } else if (basis === 'period_end') {
    date = p ? p.end : null;
    what = `${sourceInfo.label} ${span} ending ${date}`;
  } else if (record && isIsoDate(record.as_of_date)) {
    date = record.as_of_date;
    what = `${sourceInfo.label} file dated ${date}`;
  } else {
    date = (record && record.effective_date) || null;
    what = `${sourceInfo.label} figure effective ${date} (no file date given)`;
  }
  if (!isIsoDate(date)) {
    return {
      stale: true,
      age_days: null,
      date: null,
      basis,
      message: `We can’t tell how old this ${sourceInfo.label} figure is: it has no usable date.`,
    };
  }
  const age = daysBetween(date, todayIso);
  if (age < 0) {
    return {
      stale: false,
      age_days: 0,
      date,
      basis,
      message: `${what}: 0 days old. The date is after today (${todayIso}), which a device’s clock or time zone can cause, so it is counted as 0 days.`,
    };
  }
  const stale = age > sourceInfo.stale_after_days;
  const message = stale
    ? `Stale: ${what} is ${days(age)} old, past the ${days(sourceInfo.stale_after_days)} after which a newer ${sourceInfo.cadence} file is expected. It may have changed since.`
    : `${what}: ${days(age)} old. New ${sourceInfo.label} files come out ${CADENCE_PHRASE[sourceInfo.cadence] || sourceInfo.cadence}.`;
  return { stale, age_days: age, date, basis, message };
}

const PACKAGE_LEVEL_RE = /^(\d*\.?\d+) (.+?) in (\d*\.?\d+) (.+?)(?: \([0-9A-Za-z-]+\))?$/;

/**
 * The total amount in one NDC, read from an FDA NDC Directory package description, or null
 * when the description does not give one amount in mL, L or g. Levels are separated by " / ",
 * outermost first, each "<n> <thing> in 1 <container>", and each level's container must be
 * the previous level's thing; the amounts multiply exactly. A kit (parts joined by " * "), a
 * level "in" more than one container, or an innermost amount in anything other than mL, L
 * (as 1000 mL) or g gives null.
 * packageAmount('5 SYRINGE in 1 CARTON (0000-0000-00) / 3 mL in 1 SYRINGE') → { amount: 15, unit: 'ML' }.
 * @param {*} description
 * @returns {{ amount: number, unit: 'ML'|'GM' } | null}
 */
export function packageAmount(description) {
  if (typeof description !== 'string') return null;
  const text = description.trim();
  if (!text || text.includes('*')) return null;
  let total = '1';
  let thing = null;
  for (const [i, level] of text.split(' / ').entries()) {
    const m = PACKAGE_LEVEL_RE.exec(level.trim());
    if (!m) return null;
    const [, n, what, outerN, outer] = m;
    if (Number(outerN) !== 1) return null;
    if (i > 0 && outer !== thing) return null;
    total = multiplyDecimal(total, n);
    thing = what;
  }
  let unit;
  if (/^ml$/i.test(thing)) unit = 'ML';
  else if (thing === 'L') {
    unit = 'ML';
    total = multiplyDecimal(total, 1000);
  } else if (/^g$/i.test(thing)) unit = 'GM';
  else return null;
  const amount = Number(total);
  return amount > 0 ? Object.freeze({ amount, unit }) : null;
}

/**
 * The quantity a product card starts at, before the reader types one:
 * { qty, unit, reason } (frozen). Pure.
 * - Priced per EA: DEFAULT_EA_QUANTITY (30).
 * - Priced per ML or GM: the amount in one NDC, from packageAmount() of the FDA package
 *   description, when every NDC of the product with an identity gives the same amount in that
 *   unit and it is a usable quantity (at most 9999, at most 3 decimals); otherwise 1.
 * - NDCs priced per different units (unit null) or any other unit: 1.
 * The reason says which case applied and why, for the page to show next to the quantity.
 * @param {{ rows: object[] }|object[]} product a product from groupProducts() (search.js), or its rows
 * @returns {{ qty: number, unit: string|null, reason: string }}
 */
export function defaultQuantity(product) {
  const rows = Array.isArray(product) ? product : product && Array.isArray(product.rows) ? product.rows : null;
  if (!rows || rows.length === 0) throw new Error('defaultQuantity needs a product with at least one row');
  const result = (qty, unit, reason) => Object.freeze({ qty, unit, reason });
  const units = distinctSorted(rows.map((r) => r.unit));
  if (units.length !== 1) {
    return result(1, null, `This product’s NDCs are priced per different units (${units.join(', ')}), so there is no one quantity to start from; the card starts at 1.`);
  }
  const unit = units[0];
  if (unit === 'EA') {
    return result(
      DEFAULT_EA_QUANTITY,
      'EA',
      `NADAC prices this product per EA (each tablet, capsule or other single unit). The card starts at ${DEFAULT_EA_QUANTITY}, a common one-month supply of a once-a-day medicine; change it to match your prescription.`,
    );
  }
  if (unit !== 'ML' && unit !== 'GM') {
    return result(1, unit, `NADAC prices this product per ${unit}, a unit OpenBill has no starting quantity for, so the card starts at 1 ${unit}.`);
  }
  const word = unit === 'ML' ? 'mL' : 'g';
  const fallback = (why) => result(1, unit, `${why} So the card starts at 1 ${unit}; change it to match your prescription.`);
  const listed = rows.filter((r) => r.identity).sort((a, b) => cmp(a.ndc, b.ndc));
  if (listed.length === 0) {
    return fallback('None of this product’s NDCs is in the FDA NDC Directory, so OpenBill cannot read how much one package holds.');
  }
  const read = listed.map((r) => ({ row: r, a: packageAmount(r.identity.package_description) }));
  const unread = read.find((x) => !x.a || x.a.unit !== unit);
  if (unread) {
    return fallback(
      `The FDA package description of NDC ${showNdc(unread.row.ndc)} (“${unread.row.identity.package_description}”) does not give one amount in ${word}, NADAC’s unit for this product.`,
    );
  }
  const amounts = [...new Set(read.map((x) => x.a.amount))].sort((a, b) => a - b);
  if (amounts.length > 1) {
    return fallback(`The FDA package descriptions of this product’s NDCs give different amounts (${amounts.map((n) => `${formatCount(n)} ${word}`).join(', ')}).`);
  }
  const qty = amounts[0];
  const problem = quantityProblem(qty);
  if (problem) return fallback(`The FDA package description gives ${formatCount(qty)} ${word} per package, which is not a usable quantity (${problem.replace(/\.$/, '')}).`);
  const coverage =
    listed.length === rows.length
      ? rows.length === 1
        ? 'for this product’s NDC'
        : `for all ${formatCount(rows.length)} NDCs of this product`
      : `for the ${formatCount(listed.length)} of this product’s ${formatCount(rows.length)} NDCs it lists`;
  return result(
    qty,
    unit,
    `NADAC prices this product per ${unit}. The FDA NDC Directory’s package description gives ${formatCount(qty)} ${word} in one package ${coverage} (“${listed[0].identity.package_description}”), so the card starts at one package: ${formatCount(qty)} ${unit}. Change it to match your prescription.`,
  );
}

/**
 * @typedef {object} Range
 * @property {object} min       record with the lowest value
 * @property {object} max       record with the highest value
 * @property {object[]} records distinct records, sorted by value then effective_date
 * @property {string} state     the weakest state among them
 * @property {string[]} units   distinct `per` of the records, sorted. More than one means
 *                              min and max are in different units: do not show them as one
 *                              "from–to" range; list the records (each has its own `per`).
 * @property {boolean} same     one unit, and min and max have the same value
 * @property {number} count     how many rows contributed (before de-duplication)
 */

function rangeOf(records) {
  const seen = new Map();
  for (const r of records) {
    const k = JSON.stringify(r);
    if (!seen.has(k)) seen.set(k, r);
  }
  const distinct = [...seen.values()].sort(
    (a, b) => a.value - b.value || cmp(a.effective_date, b.effective_date) || cmp(a.source_file, b.source_file),
  );
  const units = distinctSorted(distinct.map((r) => r.per));
  return Object.freeze({
    min: distinct[0],
    max: distinct[distinct.length - 1],
    records: Object.freeze(distinct),
    state: weakestState(distinct.map((r) => r.state)),
    units: Object.freeze(units),
    same: units.length <= 1 && distinct[0].value === distinct[distinct.length - 1].value,
    count: records.length,
  });
}

const byValue = (a, b) => a.value - b.value || cmp(a.effective_date, b.effective_date) || cmp(a.source_file, b.source_file);

/**
 * Records grouped by their unit (`per`): [{ unit, range, ndcs }] with range = the Range of that
 * unit's records and ndcs = how many records (rows) are in that unit; the unit with the most
 * NDCs first, then by unit. A Range over several units must not be shown as one "from–to"
 * range; show one range per entry instead ("$0.01817 to $0.02859 per GM; $1.22444 per EA").
 * @param {object[]} records
 * @returns {readonly { unit: string|null, range: object, ndcs: number }[]}
 */
export function rangesByUnit(records) {
  const groups = new Map();
  for (const r of records) {
    const k = r.per === undefined ? null : r.per;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return Object.freeze(
    [...groups.entries()]
      .map(([unit, recs]) => Object.freeze({ unit, range: rangeOf(recs), ndcs: recs.length }))
      .sort((a, b) => b.ndcs - a.ndcs || cmp(String(a.unit), String(b.unit))),
  );
}

// The Medicare figure for the quantity, per NDC: unitTotal() of a Part D average (a filed
// figure), and partBPackTotal() for Part B, which works from the filed inputs exactly.
function referencePack(using, pack) {
  if (pack.missing) return pack;
  const totals = using.map((x) => (x.reference.kind === 'part_b' ? partBPackTotal(x.row, pack.qty) : unitTotal(x.reference.record, pack.qty)));
  const bad = totals.find((t) => t.missing);
  if (bad) return bad;
  const sorted = [...totals].sort(byValue);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  return Object.freeze({ qty: pack.qty, min, max, same: min.value === max.value });
}

/**
 * Everything one product card needs, computed from the linked rows of one product (all rows
 * with the same `name`, e.g. product.rows from groupProducts() in search.js over
 * linkRows(doc)) and the quantity typed. DOM-free and pure; every number in it is a record or
 * a Range of records, so the card can show the state chip and provenance line for each.
 *
 * Returned object (frozen):
 * - name: string; unit: 'EA'|'ML'|'GM' or null when the NDCs disagree; units: string[];
 *   ndcs: string[] (sorted)
 * - otc: true/false, or null when the NDCs disagree; rate_classes: string[];
 *   explanation_codes: string[]
 * - names: { proprietary: string[], nonproprietary: string[] } from the FDA identity join
 * - default_quantity: { qty, unit, reason } = defaultQuantity(rows): the quantity to start the
 *   quantity box at, and why
 * - nadac: Range of the NADAC per-unit records (what pharmacies pay). When nadac.units has
 *   more than one unit (unit is null), min and max are not comparable: show per_ndc instead.
 * - nadac_by_unit: rangesByUnit() of the NADAC records: one Range per pricing unit, the unit
 *   with the most NDCs first. Show these, not nadac.min–max, when nadac.units has several units.
 * - generic_nadac: Range | null (brand rows whose NADAC row lists the generic's NADAC; the
 *   generic equivalent's price, a different product)
 * - pack: { qty, min, max, same }, min/max = unitTotal() of nadac.min/max (each a usd record
 *   with the NADAC record's state and source fields, or Missing); or Missing when the
 *   quantity is absent ("No quantity entered."), unusable, or the NDCs are priced per
 *   different units
 * - reference: Missing, or { kind: 'part_d'|'part_b', label, tense: 'past'|'present',
 *   range: Range of usd records per NADAC unit, ndcs: string[] (the NDCs it covers),
 *   without: [{ ndc, reason }] (NDCs in this product without that kind of reference, and why),
 *   alternate: null | { kind: 'part_b', label, tense, range, inputs, setting_notes, ndcs } (the
 *   Part B figures of NDCs whose card figure is Part D, for the provenance panel),
 *   inputs: for Part B (a calculated figure) inputDates() of the limit and crosswalk records
 *   it was calculated from, else null; setting_notes: the Part B setting note(s)
 *   (partBSettingNote), [] for Part D; pack: Missing or { qty, min, max, same }, the Medicare
 *   figure for the quantity (unitTotal of a Part D average; partBPackTotal for Part B, exact
 *   from the filed inputs) }.
 *   Part D is used if any NDC has a usable Part D reference, else Part B.
 * - spread: Missing, or { kind, tense, range: Range of ratio records, state (the weakest),
 *   extreme (any record isExtremeSpread), sentence ("Medicare paid 4.9× what pharmacies pay.",
 *   or EXTREME_HEADLINE when extreme), inputs (inputDates() of every NADAC, Part D or Part B
 *   input, each with its own date or period, to show next to the spread), name_outliers (the
 *   distinct nameOutlier() sentences of those spreads; empty without opts.partDContext) } over
 *   the NDCs in reference.ndcs
 * - coinsurance: Range of Part B coinsurance records (usd per HCPCS billing unit) or null
 * - freshness_inputs: [{ source: 'nadac'|'partd'|'asp_limits'|'asp_crosswalk', record }],
 *   one per distinct date that freshness() measures from (per source, file and retrieval),
 *   the first such record in NDC order; pass each to freshness(record, SOURCE_INFO[source], today)
 * - per_ndc: [{ ndc, row, nadac, generic_nadac, reference, spread, alternate_spread,
 *   coinsurance }] sorted by ndc: nadac a record; generic_nadac a record or null;
 *   reference = referencePrice(row) (Reference or Missing; its `alternate` and
 *   part_b_reason / part_d_reason feed the provenance panel; a Part B Reference has
 *   setting_note and inputs); spread = spreadForRow(row) (with extreme, sentence and inputs);
 *   alternate_spread = the spread against reference.alternate, or null; coinsurance =
 *   partBCoinsurance(row) (Missing when there is none)
 * - counts: { rows, with_identity, with_part_b, with_part_d, with_reference, with_spread,
 *   carried_forward, part_d_outliers, part_d_outlier_flag_blank }
 *
 * Rendering a card from it:
 * - Any figure may be Missing ({ missing: true, reason }): show "We don't know yet" and the
 *   reason, never a zero. Test with `x.missing === true` before reading other fields.
 * - Every record (and Range min/max/records entry) has value, kind, state, reason,
 *   source_name, source_url, source_file, effective_date, retrieved_date, and maybe
 *   as_of_date, per, period: put state on the chip and source/file/dates on the provenance
 *   line; for period data show `period` next to effective_date (the period start).
 *   formatValue(record) in provenance.js formats any record by its kind.
 * - Per-unit prices (nadac, generic_nadac, reference, coinsurance) are formatted with
 *   formatUnitPrice (source precision, e.g. "$0.01451"); pack totals with formatMoney (cents,
 *   or "<$0.01"); spreads with formatSpreadMultiple or the ready-made `sentence`.
 * - A Range whose `same` is true is one figure (show min); otherwise "min – max" (if `units`
 *   has one entry) with `state` (the weakest) on the chip.
 * - `reference.label` names the Medicare figure; show HONESTY "not-your-price" next to it.
 *   `tense` is 'present' for Part B (current quarter) and 'past' for Part D (a past year).
 * - freshness(record, SOURCE_INFO[source], today) on each freshness_inputs entry says
 *   whether to show a stale label.
 *
 * Throws if rows is empty, mixes product names, or holds unlinked v3 rows.
 * @param {object[]} rows linked rows sharing one name
 * @param {number|string} [qty]
 * @param {{ partDContext?: Map }} [opts] partDContext: partDNameContext(all linked rows), so a
 *   Part D spread can say when this product is far from the others under its name (nameOutlier)
 * @returns {object}
 */
export function summarizeProduct(rows, qty, opts = {}) {
  const context = opts && opts.partDContext;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('summarizeProduct needs at least one row');
  const names = distinctSorted(rows.map((r) => r.name));
  if (names.length !== 1) throw new Error(`summarizeProduct needs rows of one product, got ${names.length} names`);
  rows.forEach(assertLinked);
  const sorted = [...rows].sort((a, b) => cmp(a.ndc, b.ndc));
  const units = distinctSorted(sorted.map((r) => r.unit));

  const perNdc = sorted.map((row) => {
    const reference = referencePrice(row);
    return Object.freeze({
      ndc: row.ndc,
      row,
      nadac: row.nadac,
      generic_nadac: row.generic_nadac || null,
      reference,
      spread: spreadFromReference(row, reference, context),
      alternate_spread: !reference.missing && reference.alternate ? spreadFromReference(row, reference.alternate, context) : null,
      coinsurance: partBCoinsurance(row),
    });
  });

  const nadac = rangeOf(perNdc.map((x) => x.nadac));
  const generics = perNdc.map((x) => x.generic_nadac).filter(Boolean);

  let pack;
  if (qty === undefined || qty === null || qty === '') {
    pack = missing('No quantity entered.');
  } else {
    const problem = quantityProblem(qty);
    pack = problem
      ? missing(problem)
      : nadac.units.length > 1
      ? missing(
          `These NDCs are priced per different units (${nadac.units.join(', ')}), so there is no single pack total for a quantity of ${decimalString(qty)}; see the price for each NDC.`,
        )
      : Object.freeze({ qty: Number(decimalString(qty)), min: unitTotal(nadac.min, qty), max: unitTotal(nadac.max, qty), same: nadac.same });
  }

  const kind = perNdc.some((x) => x.reference.kind === 'part_d') ? 'part_d' : perNdc.some((x) => x.reference.kind === 'part_b') ? 'part_b' : null;
  let reference;
  let spreadSummary;
  if (kind === null) {
    const reasons = distinctSorted(perNdc.map((x) => x.reference.reason));
    reference = missing(reasons.join(' '));
    spreadSummary = missing(reasons.join(' '));
  } else {
    const using = perNdc.filter((x) => x.reference.kind === kind);
    const other = perNdc.filter((x) => x.reference.kind !== kind);
    const first = using[0].reference;
    const withAlt = using.filter((x) => x.reference.alternate);
    const refRange = rangeOf(using.map((x) => x.reference.record));
    reference = Object.freeze({
      kind,
      label: first.label,
      tense: first.tense,
      range: refRange,
      // A Part B figure is calculated from the limit and the crosswalk: list each input's dates.
      inputs: kind === 'part_b' ? inputDates(using.flatMap((x) => x.reference.inputs)) : null,
      setting_notes: kind === 'part_b' ? Object.freeze(distinctSorted(using.map((x) => x.reference.setting_note))) : Object.freeze([]),
      pack: referencePack(using, pack),
      ndcs: Object.freeze(using.map((x) => x.ndc)),
      without: Object.freeze(
        other.map((x) =>
          Object.freeze({
            ndc: x.ndc,
            reason: x.reference.missing
              ? x.reference.reason
              : `This NDC has only a ${x.reference.kind === 'part_b' ? 'Part B' : 'Part D'} reference, which is not mixed with the ${kind === 'part_b' ? 'Part B' : 'Part D'} figures of the other NDCs; see this NDC’s own details.`,
          }),
        ),
      ),
      alternate: withAlt.length
        ? Object.freeze({
            kind: withAlt[0].reference.alternate.kind,
            label: withAlt[0].reference.alternate.label,
            tense: withAlt[0].reference.alternate.tense,
            range: rangeOf(withAlt.map((x) => x.reference.alternate.record)),
            inputs: inputDates(withAlt.flatMap((x) => x.reference.alternate.inputs)),
            setting_notes: Object.freeze(distinctSorted(withAlt.map((x) => x.reference.alternate.setting_note))),
            ndcs: Object.freeze(withAlt.map((x) => x.ndc)),
          })
        : null,
    });
    const spreads = using.map((x) => x.spread).filter((s) => !s.missing);
    if (spreads.length === 0) {
      spreadSummary = missing(distinctSorted(using.map((x) => x.spread.reason)).join(' '));
    } else {
      const range = rangeOf(spreads.map((s) => s.record));
      const extreme = range.records.some(isExtremeSpread);
      spreadSummary = Object.freeze({
        kind,
        tense: first.tense,
        range,
        state: range.state,
        extreme,
        sentence: extreme ? EXTREME_HEADLINE : describeSpreadRange(range.min, range.max, { tense: first.tense }),
        name_outliers: Object.freeze(distinctSorted(spreads.map((s) => s.name_outlier).filter(Boolean))),
        inputs: inputDates(spreads.flatMap((s) => s.inputs)),
      });
    }
  }

  const coins = perNdc.map((x) => x.coinsurance).filter((c) => !c.missing);

  // One entry per date freshness() would measure from. NADAC rows of one week share the file's
  // as-of date but often differ in effective_date; keying on effective_date listed the same
  // "3 days old" NADAC line once per effective date (3 times for ATORVASTATIN 20 MG TABLET).
  const fresh = new Map();
  const addFresh = (source, record) => {
    if (!record) return;
    const info = SOURCE_INFO[source];
    const basis = info && info.age_from === 'as_of_date' ? (isIsoDate(record.as_of_date) ? record.as_of_date : `effective ${record.effective_date}`) : record.period;
    const k = [source, basis, record.retrieved_date, record.source_file].join('|');
    if (!fresh.has(k)) fresh.set(k, Object.freeze({ source, record }));
  };
  for (const row of sorted) {
    addFresh('nadac', row.nadac);
    if (row.part_d) addFresh('partd', row.part_d.avg_per_unit);
    if (row.part_b) {
      addFresh('asp_limits', row.part_b.payment_limit);
      addFresh('asp_crosswalk', row.part_b.bill_units_per_package);
    }
  }

  return Object.freeze({
    name: names[0],
    unit: units.length === 1 ? units[0] : null,
    units: Object.freeze(units),
    ndcs: Object.freeze(sorted.map((r) => r.ndc)),
    otc: sorted.every((r) => r.otc === true) ? true : sorted.every((r) => r.otc === false) ? false : null,
    rate_classes: Object.freeze(distinctSorted(sorted.map((r) => r.rate_class))),
    explanation_codes: Object.freeze(distinctSorted(sorted.flatMap((r) => r.explanation_codes || []))),
    names: Object.freeze({
      proprietary: Object.freeze(distinctSorted(sorted.map((r) => r.identity && r.identity.proprietary_name))),
      nonproprietary: Object.freeze(distinctSorted(sorted.map((r) => r.identity && r.identity.nonproprietary_name))),
    }),
    default_quantity: defaultQuantity(sorted),
    nadac,
    nadac_by_unit: rangesByUnit(perNdc.map((x) => x.nadac)),
    generic_nadac: generics.length ? rangeOf(generics) : null,
    pack,
    reference,
    spread: spreadSummary,
    coinsurance: coins.length ? rangeOf(coins) : null,
    freshness_inputs: Object.freeze([...fresh.values()]),
    per_ndc: Object.freeze(perNdc),
    counts: Object.freeze({
      rows: sorted.length,
      with_identity: sorted.filter((r) => r.identity).length,
      with_part_b: sorted.filter((r) => r.part_b).length,
      with_part_d: sorted.filter((r) => r.part_d).length,
      with_reference: perNdc.filter((x) => !x.reference.missing).length,
      with_spread: perNdc.filter((x) => !x.spread.missing).length,
      carried_forward: sorted.filter((r) => r.carried_forward).length,
      part_d_outliers: sorted.filter((r) => r.part_d && r.part_d.outlier === true).length,
      part_d_outlier_flag_blank: sorted.filter((r) => r.part_d && r.part_d.outlier === null).length,
    }),
  });
}
