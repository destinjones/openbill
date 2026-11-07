// The page: the only DOM code in OpenBill. It renders what src/core returns and computes
// nothing itself. Every value written into HTML goes through esc().

import { esc, safeHref } from '../core/esc.js';
import { unpackDrugs, linkRows } from '../core/pack.js';
import { groupProducts, buildIndex, search, suggest, enterChoice, normalizeQuery } from '../core/search.js';
import { summarizeProduct, partDNameContext, freshness, inputDates, rangesByUnit, isExtremeSpread, formatSpreadMultiple, paidComparison, parsePaid, COST_PLUS, HONESTY, RULES, PAID_PRIVACY } from '../core/rules.js';
import { formatMoney, formatUnitPrice, formatCount, formatMultiple, quantityProblem, QTY_MAX_CHARS } from '../core/money.js';
import { formatValue, validateRecord, STATE_INFO } from '../core/provenance.js';
import { formatNdc, formatNdcCode, isNdc11, normalizeNdc, readNdc } from '../core/ndc.js';
import { SOURCE_INFO, NADAC_EXPLANATION_CODES } from '../core/sources.js';
import { issueUrl } from '../core/report.js';
import { REPO_URL, SITE_URL } from '../core/config.js';
import { siteSlugs } from '../core/slug.js';
import { isoDate, parsePeriod } from '../core/dates.js';
import { sha256Hex } from '../core/sha256.js';
import { parseHash, hashFor, nameKey, caselessNames, clipText, QUERY_MAX_CHARS } from '../core/hash.js';

const SCRIPT_START = performance.now();
const RESULT_LIMIT = 20;
const COUNT_LIMIT = 1000;
const INLINE_FORMAT = 'openbill.inline/1';
const CALCULATION = 'OpenBill calculation';
const CANNOT_UNPACK = 'This browser cannot unpack the inline data (it has no DecompressionStream for deflate-raw). A current Firefox, Chrome, Edge or Safari can.';
const DATA_UNREADABLE = 'The price data built into this page could not be read, so it may be damaged.';
const SEARCH_WAIT = 'Search starts when the data has loaded; keep typing.';
const SEARCH_READY = 'Search is ready.';
/** The website's A to Z list of drugs: plain pages that need no script and no data in this page. */
const AZ_URL = `${SITE_URL}drugs/a/`;
/** People's words for NADAC's pricing units, next to the code itself. */
const UNIT_WORDS = Object.freeze({ EA: 'each (EA)', ML: 'mL', GM: 'g' });

const app = {
  build: null,
  doc: null,
  products: [],
  byName: new Map(),
  caseless: new Map(), // nameKey(name) → name, for a retyped or lower-cased name in a link
  partDContext: null, // partDNameContext(rows): each Part D name's products, for nameOutlier()
  index: null,
  today: null,
  // { product, qty: string, paid: string, paidNote: string|null, ndc, summary }. `paid` is what the
  // reader typed as what they were charged: kept in memory and in the address after # only
  // (so the browser's history has it), never saved or sent by OpenBill. `ndc` is linkNdc()'s answer
  // for the NDC the reader entered, or null.
  current: null,
  cache: new Map(), // product name → summarizeProduct(rows) without a quantity
  priceCache: new Map(), // product name → NADAC ranges per unit, for search results
  announce: null, // timer for the card's status message and, with it, the paid result
  paidTimer: null, // timer for the "What were you charged?" result while its box is typed in
  paidShown: '', // the paid result's current HTML, so an unchanged one is not written (and read out) again
  panelFor: null, // the summary the panel was last built from; a closed panel is not built
  shown: false, // something other than the static loading state is on the card
  missQuery: null, // the search text a link's unknown name put in #q
  enterWaiting: false, // Enter was pressed in #q before the search index was ready
  allResults: [], // everything the current search found, not only the rows shown
  pickedQuery: null, // the text in #q when a result was opened from it; typing clears it
  searchTimer: null, // the pause after a keystroke before searching
  printOpened: [], // closed details in the panel that printing opened
  slugs: null, // product name → its website slug (siteSlugs, as tools/site.mjs builds the pages)
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------------------------
// Small renderers

function chip(state) {
  const info = STATE_INFO[state];
  const label = info ? info.label : String(state);
  return `<span class="chip chip-${esc(state)}">${esc(label)}</span>`;
}

function staleChip() {
  return '<span class="chip chip-stale">stale</span>';
}

function honestyLine(id, { firstSentenceOnly = false } = {}) {
  const line = HONESTY.find((h) => h.id === id);
  if (!line) return '';
  const parts = firstSentenceOnly ? line.parts.filter((p) => p.strong).slice(0, 1) : line.parts;
  return parts.map((p) => (p.strong ? `<strong>${esc(p.text)}</strong>` : esc(p.text))).join('');
}

function periodWords(period) {
  const p = parsePeriod(period);
  return p ? `${p.start} to ${p.end}` : '';
}

function isCalculated(rec) {
  return rec.source_name === CALCULATION;
}

/** "CMS NADAC · file.csv · eff. 2026-09-23 · as of 2026-10-14 · retrieved 2026-10-17" */
function provText(rec) {
  const bits = [rec.source_name, rec.source_file];
  // Period data is effective from its period's start, and the period is always shown with it.
  const p = parsePeriod(rec.period);
  bits.push(p && p.start === rec.effective_date ? `eff. ${p.start} to ${p.end}` : `eff. ${rec.effective_date}${p ? ` (period ${p.start} to ${p.end})` : ''}`);
  if (rec.as_of_date) bits.push(`as of ${rec.as_of_date}`);
  bits.push(`retrieved ${rec.retrieved_date}`);
  return bits.join(' · ');
}

/**
 * The provenance line of a calculated figure: the calculation, its input files, and each
 * input's own date or period (inputDates() in rules.js), never the oldest date alone.
 * "OpenBill calculation · a.csv + b.zip · NADAC eff. 2026-09-23 (…) · Part D 2024-01-01 to 2024-12-31 (…)"
 */
function calcText(records, inputs) {
  const files = [];
  for (const r of records) for (const f of String(r.source_file).split(' + ')) if (!files.includes(f)) files.push(f);
  return [CALCULATION, files.join(' + '), ...inputs.map((i) => i.text)].join(' · ');
}

/**
 * One provenance line per distinct source, file, period and file dates; records that differ
 * only in their effective date share a line that lists each date. Calculated records list their
 * inputs (calcText).
 */
function provLines(records, inputs) {
  const seen = [];
  const calc = records.filter(isCalculated);
  const groups = new Map();
  for (const r of records) {
    if (isCalculated(r)) continue;
    const k = [r.source_name, r.source_file, r.period || '', r.as_of_date || '', r.retrieved_date].join('|');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const recs of groups.values()) {
    const dates = [...new Set(recs.map((r) => r.effective_date))].sort();
    if (dates.length === 1) {
      seen.push(provText(recs[0]));
      continue;
    }
    const r = recs[0];
    const when = dates.length <= 3 ? dates.join(', ') : `between ${dates[0]} and ${dates[dates.length - 1]} (${formatCount(dates.length)} dates)`;
    const bits = [r.source_name, r.source_file, `eff. ${when}${r.period ? ` (period ${periodWords(r.period)})` : ''}`];
    if (r.as_of_date) bits.push(`as of ${r.as_of_date}`);
    bits.push(`retrieved ${r.retrieved_date}`);
    seen.push(bits.join(' · '));
  }
  if (calc.length) seen.push(calcText(calc, inputs || []));
  return seen.map((t) => `<p class="prov mono">${esc(t)}</p>`).join('');
}

function isMissing(x) {
  return !x || x.missing === true;
}

function unitPrice(rec) {
  return `${formatUnitPrice(rec.value)}${rec.per ? ` per ${rec.per}` : ''}`;
}

function moneyRange(min, max, same) {
  const a = formatMoney(min.value);
  const b = formatMoney(max.value);
  return same || a === b ? a : `${a} – ${b}`;
}

function unitRange(range) {
  const a = formatUnitPrice(range.min.value);
  const b = formatUnitPrice(range.max.value);
  const per = range.units.length === 1 ? ` per ${range.units[0]}` : '';
  return a === b ? `${a}${per}` : `${a} to ${b}${per}`;
}

/** Per-unit prices with one range per unit: "$0.01817 to $0.02859 per GM; $1.22444 per EA". */
function unitGroups(groups) {
  return groups.map((g) => unitRange(g.range)).join('; ');
}

function multipleRange(range) {
  const a = formatSpreadMultiple(range.min.value);
  const b = formatSpreadMultiple(range.max.value);
  return a === b ? a : `${a} – ${b}`;
}

function uniqueCaseless(list, max) {
  const out = [];
  const seen = new Set();
  for (const s of list) {
    const k = String(s).toUpperCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return max === undefined ? out : { shown: out.slice(0, max), more: Math.max(0, out.length - max) };
}

function showNdc(ndc) {
  return isNdc11(ndc) ? formatNdc(ndc) : String(ndc);
}

function unitWords(unit) {
  return UNIT_WORDS[unit] || unit || 'units';
}

const EXTREME_PHRASE = 'may not describe the same unit or product';

/** The caveat sentences a calculated record's reason lists after "Estimated because:". */
function caveatsOf(rec) {
  const reason = String(rec.reason || '');
  const marks = ['Estimated because: ', 'Caveats: '];
  let rest = null;
  for (const m of marks) {
    const at = reason.indexOf(m);
    if (at >= 0) {
      rest = reason.slice(at + m.length);
      break;
    }
  }
  if (rest === null) return { first: null, extreme: null };
  const firstMatch = /^(.+?[.!?][”"’)]*)(?=\s+[A-Z0-9“"]|$)/.exec(rest);
  const first = firstMatch ? firstMatch[1] : rest;
  let extreme = null;
  if (isExtremeSpread(rec)) {
    const p = reason.indexOf(EXTREME_PHRASE);
    if (p >= 0) {
      const start = reason.lastIndexOf('At ', p);
      const end = reason.indexOf('.', p + EXTREME_PHRASE.length);
      if (start >= 0) extreme = reason.slice(start, end >= 0 ? end + 1 : undefined);
    }
  }
  return { first, extreme: extreme && extreme !== first ? extreme : null };
}

// ---------------------------------------------------------------------------------------------
// Hash state: #drug=<name>&qty=<n>&paid=<dollars>, read by parseHash() in src/core/hash.js. `paid`
// is the reader's own number; the part after # never leaves the browser, and it is the only place
// the page keeps that number.

function findProduct(text) {
  return app.byName.get(text) || app.byName.get(app.caseless.get(nameKey(text)));
}

function defaultRoute() {
  return { kind: 'card', drug: app.build.default.drug, qty: String(app.build.default.qty), paid: null, home: true };
}

function readHash() {
  const h = parseHash(location.hash, { isName: (text) => Boolean(findProduct(text)) });
  return h.kind === 'default' ? defaultRoute() : h;
}

/**
 * A saved copy has no methodology.html or data/drugs.json beside it, and a file: page cannot tell
 * whether it does, so from file: these links go to the website (decision 53).
 */
function siteHref(rel) {
  return location.protocol === 'file:' ? `${SITE_URL}${rel}` : rel;
}

function pointSavedCopyAtSite() {
  if (location.protocol !== 'file:') return;
  for (const a of document.querySelectorAll('a[href]')) {
    const rel = a.getAttribute('href');
    if (/^(methodology\.html|data\/)/.test(rel)) a.setAttribute('href', siteHref(rel));
  }
}

// The reader's amount (typed, or from a link's &paid=) is untrusted: if the core ever threw on
// one, that must cost only the comparison, never the card or the search box.
const PAID_UNREADABLE = 'That amount could not be read. Type what you paid for this pack in dollars and cents, like 12.50.';

function safeParsePaid(text) {
  try {
    return parsePaid(text);
  } catch {
    return { valid: false, problem: PAID_UNREADABLE };
  }
}

function safePaidComparison(paid, pack, costPlus) {
  try {
    return paidComparison(paid, pack, costPlus);
  } catch {
    return { valid: false, problem: PAID_UNREADABLE };
  }
}

/** What the reader typed, as it goes in the address: "12.50" when it is a usable amount, else ''. */
function paidForHash(text) {
  const p = safeParsePaid(text);
  return p.valid ? p.value.toFixed(2) : '';
}

function currentHash() {
  const c = app.current;
  return hashFor(c.product.name, c.qty, paidForHash(c.paid), c.ndc && c.ndc.ndc);
}

function replaceHash(hash) {
  try {
    history.replaceState(null, '', hash);
    return true;
  } catch {
    location.replace(hash);
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// The card: the three figures first, each with its state chip and provenance line; then the
// quantity, the notes about the figures, and the panel.

function freshnessFor(summary, sources) {
  return summary.freshness_inputs
    .filter((f) => sources.includes(f.source) && SOURCE_INFO[f.source])
    .map((f) => ({ source: f.source, ...freshness(f.record, SOURCE_INFO[f.source], app.today) }));
}

/** The FDA NDC Directory supplies the names and package amounts; its own age, when it is used. */
function fdaFreshness(s) {
  const src = app.doc && app.doc.sources && app.doc.sources.fda_ndc;
  if (!src || s.counts.with_identity === 0) return null;
  return { source: 'fda_ndc', ...freshness(src, SOURCE_INFO.fda_ndc, app.today) };
}

function fdaLine() {
  const src = app.doc.sources.fda_ndc;
  const bits = [src.name || SOURCE_INFO.fda_ndc.label, src.source_file];
  if (src.as_of_date) bits.push(`as of ${src.as_of_date}`);
  bits.push(`retrieved ${src.retrieved_date}`);
  return bits.join(' · ');
}

function freshHtml(list) {
  return list
    .map((f) => `<p class="fresh${f.stale ? ' fresh-stale' : ''}">${f.stale ? `${staleChip()} ` : ''}${esc(f.message)}</p>`)
    .join('');
}

function figurePharmacy(s) {
  const stale = freshnessFor(s, ['nadac']).some((f) => f.stale);
  if (isMissing(s.pack)) {
    // No single pack total (an unusable quantity, or NDCs priced per different units): show the
    // per-unit prices, one range per unit, and say why there is no total.
    return `<section class="fig fig-pharmacy" aria-labelledby="fig-ph">
<h2 id="fig-ph" class="fig-label">Pharmacy pays</h2>
<p class="fig-value"><span class="amount amount-unit" data-figure="pharmacy-unit">${esc(unitGroups(s.nadac_by_unit))}</span> ${chip(s.nadac.state)}${stale ? ` ${staleChip()}` : ''}</p>
<p id="qty-why" class="why">${esc(s.pack.reason)}</p>
${provLines(s.nadac.records)}</section>`;
  }
  const p = s.pack;
  const state = p.min.state === p.max.state ? p.min.state : s.nadac.state;
  return `<section class="fig fig-pharmacy" aria-labelledby="fig-ph">
<h2 id="fig-ph" class="fig-label">Pharmacy pays</h2>
<p class="fig-value"><span class="amount" data-figure="pharmacy">${esc(moneyRange(p.min, p.max, p.same))}</span> ${chip(state)}${stale ? ` ${staleChip()}` : ''}</p>
<p class="arith mono">${esc(`${formatCount(p.qty)} × ${unitRange(s.nadac)}`)}${p.same ? '' : `<span class="arith-note"> (the ${esc(formatCount(s.counts.rows))} NDCs differ)</span>`}</p>
${provLines(s.nadac.records)}</section>`;
}

/** The NADAC records the cost-plus estimate is built from (its range's ends), dated. */
function costPlusInputs(s) {
  const recs = s.nadac.same ? [s.nadac.min] : [s.nadac.min, s.nadac.max];
  return inputDates(recs.map((record) => ({ label: 'NADAC', record })));
}

/**
 * "$3.35 (NADAC) × 1.15 + $5.00 fee", from COST_PLUS and the pack total printed just above (itself
 * "30 × $0.11173"). It starts from the pack total in cents, as costPlusEstimate() does, so working
 * it out gives the card's own figure to the cent: "30 × $0.11173 × 1.15 + $5.00" rounded once
 * would be a cent away for about three products in ten. The exact steps are in the record's reason.
 */
function costPlusFormula(s) {
  const a = formatMoney(s.pack.min.value);
  const b = formatMoney(s.pack.max.value);
  const factor = String((100 + COST_PLUS.markup_pct) / 100);
  const base = s.pack.same || a === b ? `${a} (NADAC)` : `(${a} to ${b}, NADAC)`;
  return `${base} × ${factor} + ${formatMoney(COST_PLUS.fee_usd)} fee`;
}

/**
 * The cost-plus line's source line: "OpenBill calculation from NADAC eff. 2026-09-23 (file of
 * 2026-10-14)". Short on purpose, so the spread stays on a phone's first screen: its input is the
 * NADAC figure printed just above, whose own line names the file and the retrieved date, and the
 * record in "Sources and method" carries every field.
 */
function costPlusSourceText(s) {
  const parts = costPlusInputs(s).map((i) => `${i.label} eff. ${i.effective_dates.join(', ')}${i.as_of_dates.length ? ` (file of ${i.as_of_dates.join(', ')})` : ''}`);
  return `${CALCULATION} from ${parts.join('; ')}`;
}

const COST_PLUS_WHAT = `What a pharmacy that paid NADAC and charged cost + ${COST_PLUS.markup_pct}% + a ${formatMoney(COST_PLUS.fee_usd)} fee would charge; not a price anyone quoted.`;

/**
 * The cost-plus estimate (docs/ARCHITECTURE.md, "The cost-plus estimate"): a model, always
 * `estimated`, labelled as an estimate and never as anyone's cash price; no spread against it.
 */
function costPlusBlock(s) {
  const cp = s.cost_plus;
  if (isMissing(cp)) {
    return `<section class="costplus costplus-missing" aria-labelledby="fig-cp">
<div class="cp-row"><h2 id="fig-cp" class="cp-label">Cost-plus estimate</h2><p class="cp-value"><span class="unknown-sm">We don’t know yet</span></p></div>
<p class="why">${esc(cp.reason)}</p>
</section>`;
  }
  const state = cp.min.state === cp.max.state ? cp.min.state : 'estimated';
  return `<section class="costplus" aria-labelledby="fig-cp">
<div class="cp-row"><h2 id="fig-cp" class="cp-label">Cost-plus estimate</h2><p class="cp-value"><span class="cp-amount" data-figure="cost-plus">${esc(moneyRange(cp.min, cp.max, cp.same))}</span> ${chip(state)}</p></div>
<p class="arith mono cp-formula">${esc(costPlusFormula(s))}</p>
<p class="cp-what">${esc(COST_PLUS_WHAT)}</p>
<p class="prov mono">${esc(costPlusSourceText(s))}</p></section>`;
}

function referencePack(s) {
  const ref = s.reference;
  if (isMissing(ref) || isMissing(ref.pack)) return null;
  return ref.pack;
}

function figureMedicare(s, refPack) {
  const ref = s.reference;
  if (isMissing(ref)) {
    return `<section class="fig fig-medicare fig-missing" aria-labelledby="fig-md">
<h2 id="fig-md" class="fig-label">Medicare</h2>
<p class="fig-value"><span class="unknown">We don’t know yet</span></p>
<p class="why">${esc(ref.reason)}</p>
</section>`;
  }
  const isB = ref.kind === 'part_b';
  const label = isB ? 'Medicare Part B pays' : 'Medicare Part D paid';
  const stale = freshnessFor(s, isB ? ['asp_limits', 'asp_crosswalk'] : ['partd']).some((f) => f.stale);
  const r = ref.range;
  const period = periodWords(r.min.period);
  const basis = isB ? `Part B payment limit${period ? `, ${period}` : ''}` : `Part D average${period ? ` for ${period}` : ''}`;
  const value = refPack ? moneyRange(refPack.min, refPack.max, refPack.same) : unitRange(r);
  // The period is on the provenance line just below.
  const arith = refPack ? `${formatCount(refPack.qty)} × ${unitRange(r)}, ${isB ? 'Part B limit' : 'Part D average'}` : basis;
  return `<section class="fig fig-medicare" aria-labelledby="fig-md">
<h2 id="fig-md" class="fig-label">${esc(label)}</h2>
<p class="fig-value"><span class="amount${refPack ? '' : ' amount-unit'}" data-figure="medicare">${esc(value)}</span> ${chip(r.state)}${stale ? ` ${staleChip()}` : ''}</p>
<p class="arith mono">${esc(arith)}</p>
<p class="not-yours">${honestyLine('not-your-price', { firstSentenceOnly: true })}</p>
${provLines(r.records, ref.inputs)}</section>`;
}

function spreadBlock(s) {
  const sp = s.spread;
  if (isMissing(sp)) {
    return `<section class="spread spread-missing" aria-labelledby="fig-sp">
<h2 id="fig-sp" class="fig-label">The spread</h2>
<p class="fig-value"><span class="unknown">We don’t know yet</span></p>
<p class="why">${esc(isMissing(s.reference) ? 'There is no Medicare figure to compare with, so there is no spread.' : sp.reason)}</p>
</section>`;
  }
  const c = caveatsOf(sp.range.min);
  const cMax = sp.range.max === sp.range.min ? c : caveatsOf(sp.range.max);
  const extreme = c.extreme || cMax.extreme;
  // An extreme estimated spread leads with EXTREME_HEADLINE (sp.sentence) and the caveat that
  // says why, right beside the multiple; the plain "Medicare paid …" sentence is not shown.
  const caveats = sp.extreme
    ? `${extreme ? `<p class="caveat caveat-extreme">${esc(extreme)}</p>` : ''}${c.first && c.first !== extreme ? `<p class="caveat">${esc(c.first)}</p>` : ''}`
    : `${c.first ? `<p class="caveat">${esc(c.first)}</p>` : ''}`;
  return `<section class="spread${sp.extreme ? ' spread-extreme' : ''}" aria-labelledby="fig-sp">
<h2 id="fig-sp" class="fig-label">The spread</h2>
<p class="fig-value"><span class="multiple" data-figure="spread">${esc(multipleRange(sp.range))}</span> ${chip(sp.state)}</p>
<p class="spread-sentence${sp.extreme ? ' spread-headline' : ''}">${esc(sp.sentence)}</p>
${caveats}
${provLines(sp.range.records, sp.inputs)}</section>`;
}

/** Notes about the figures, after them: ages, carried-forward prices, coverage, the FDA source. */
function notesHtml(s) {
  const out = [];
  const fresh = [...freshnessFor(s, ['nadac'])];
  const ref = s.reference;
  if (!isMissing(ref)) fresh.push(...freshnessFor(s, ref.kind === 'part_b' ? ['asp_limits', 'asp_crosswalk'] : ['partd']));
  out.push(freshHtml(fresh));
  if (s.counts.carried_forward > 0) {
    const cf = s.per_ndc.filter((x) => x.row.carried_forward);
    const dates = [...new Set(cf.map((x) => x.nadac.effective_date))].sort();
    const n = s.counts.carried_forward;
    const all = n === s.counts.rows;
    out.push(
      `<p class="why carried">${esc(
        `${all ? (n === 1 ? 'This NDC’s NADAC' : `The NADAC of all ${formatCount(n)} NDCs`) : `The NADAC of ${formatCount(n)} of these ${formatCount(s.counts.rows)} NDCs`} was carried forward from an earlier file (NADAC explanation code 2 or 4), not newly surveyed: ${n === 1 ? 'it took' : 'those prices took'} effect on ${dates.join(', ')}. The file is new; the price is not.`,
      )}</p>`,
    );
  }
  if (!isMissing(ref)) {
    if (ref.without.length > 0) {
      out.push(
        `<p class="cover">For ${esc(formatCount(ref.ndcs.length))} of this product’s ${esc(formatCount(s.counts.rows))} NDCs; the other ${esc(formatCount(ref.without.length))} have no ${ref.kind === 'part_b' ? 'Part B' : 'Part D'} figure here (see Sources and method).</p>`,
      );
    }
    for (const note of ref.setting_notes) out.push(`<p class="why">${esc(note)}</p>`);
  }
  // The starting quantity's reason, wherever it is not a plain month of swallowed tablets or
  // capsules (decisions 48 and 49: sublingual and buccal ones and an outlier FDA listing get it too).
  if (s.unit !== 'EA' || !s.default_quantity.form.plain) out.push(`<p class="why qty-note">${esc(s.default_quantity.reason)}</p>`);
  const fda = fdaFreshness(s);
  if (fda) {
    const all = uniqueCaseless([...s.names.proprietary, ...s.names.nonproprietary], 2);
    out.push(
      `<p class="card-names"><span class="k">FDA names:</span> ${esc(all.shown.join(' · '))}${all.more ? esc(` and ${formatCount(all.more)} more`) : ''}</p>`,
      `<p class="prov mono">${esc(fdaLine())}</p>`,
      freshHtml([fda]),
    );
  }
  return `<section class="notes" aria-label="About these figures">${out.join('\n')}</section>`;
}

function reportHref(s, refPack) {
  const shown = [];
  const files = [];
  const addFiles = (recs) => {
    for (const r of recs) for (const f of String(r.source_file).split(' + ')) if (!files.includes(f)) files.push(f);
  };
  if (!isMissing(s.pack)) shown.push(`Pharmacy pays ${moneyRange(s.pack.min, s.pack.max, s.pack.same)} for ${formatCount(s.pack.qty)} ${s.unit || ''}`.trim());
  else shown.push(`Pharmacy pays ${unitGroups(s.nadac_by_unit)}`);
  addFiles(s.nadac.records);
  if (!isMissing(s.reference)) {
    const label = s.reference.kind === 'part_b' ? 'Medicare Part B pays' : 'Medicare Part D paid';
    shown.push(`${label} ${refPack ? moneyRange(refPack.min, refPack.max, refPack.same) : unitGroups(rangesByUnit(s.reference.range.records))}`);
    addFiles(s.reference.range.records);
  } else shown.push('Medicare: we don’t know yet');
  if (!isMissing(s.spread)) shown.push(`spread ${multipleRange(s.spread.range)} (${s.spread.state})`);
  if (!isMissing(s.cost_plus)) shown.push(`cost-plus estimate ${moneyRange(s.cost_plus.min, s.cost_plus.max, s.cost_plus.same)} (estimated)`);
  return issueUrl({
    template: 'wrong-price.yml',
    title: `Wrong price: ${s.name}`,
    fields: {
      product: s.name,
      ndc: s.ndcs.map(showNdc).join(', '),
      figure: isMissing(s.pack) ? 'The card (per-unit prices)' : `The card at quantity ${formatCount(s.pack.qty)}`,
      shown_value: shown.join('; '),
      source_file: files.join(', '),
      build_id: app.build.build_id,
    },
  });
}

/** True when the card or its panel shows any Medicare figure (a reference, Part B, coinsurance). */
function showsMedicare(s) {
  return !isMissing(s.reference) || Boolean(s.coinsurance);
}

function figuresHtml(s) {
  const refPack = referencePack(s);
  return {
    html: `${figurePharmacy(s)}
${figureMedicare(s, refPack)}
${costPlusBlock(s)}
<hr class="rule">
${spreadBlock(s)}`,
    after: `${notesHtml(s)}
<ul class="honesty">
<li>${honestyLine('range')}</li>
${isMissing(s.reference) && showsMedicare(s) ? `<li>${honestyLine('not-your-price', { firstSentenceOnly: true })}</li>` : ''}
</ul>`,
    report: reportHref(s, refPack),
    refPack,
  };
}

/**
 * Why the quantity gives no pack total, when that is the quantity's fault and not the units'.
 * The same sentence the card shows, so the field and the status can say it too.
 */
function quantityFault(s, qty) {
  if (!isMissing(s.pack)) return null;
  return qty === '' || quantityProblem(qty) ? s.pack.reason : null;
}

/**
 * A short summary of the figures for the card's status region, read out after a change. It names
 * the drug, so it can never be heard as the price of another one, and starts with what is wrong.
 */
function statusText(s, refPack, fault) {
  const bits = [];
  if (!isMissing(s.pack)) bits.push(`At ${formatCount(s.pack.qty)} ${unitWords(s.unit)}: pharmacy pays ${moneyRange(s.pack.min, s.pack.max, s.pack.same)}`);
  else bits.push(`Pharmacy pays ${unitGroups(s.nadac_by_unit)}`);
  if (!isMissing(s.reference)) {
    const label = s.reference.kind === 'part_b' ? 'Medicare Part B pays' : 'Medicare Part D paid';
    bits.push(`${label} ${refPack ? moneyRange(refPack.min, refPack.max, refPack.same) : unitRange(s.reference.range)}`);
  } else bits.push('Medicare: we don’t know yet');
  if (!isMissing(s.cost_plus)) bits.push(`cost-plus estimate ${moneyRange(s.cost_plus.min, s.cost_plus.max, s.cost_plus.same)}, estimated`);
  if (!isMissing(s.spread)) bits.push(`spread ${multipleRange(s.spread.range)}, ${s.spread.state}${s.spread.extreme ? `. ${s.spread.sentence}` : ''}`);
  return `${s.name}. ${fault ? `${fault} ` : ''}${bits.join('; ')}.`;
}

// ---------------------------------------------------------------------------------------------
// The provenance panel ("Sources and method"): every record in full, not softened.

function recordHtml(title, rec, inputs) {
  const problems = validateRecord(rec);
  if (problems.length) {
    // Never render a record that breaks the contract as if it were sound, and never as a link.
    return `<div class="rec rec-invalid"><h4 class="rec-title">${esc(title)}</h4><p>This record is not valid, so it is not shown as a figure: ${esc(problems.join('; '))}.</p></div>`;
  }
  const info = STATE_INFO[rec.state];
  const href = safeHref(rec.source_url);
  const link = !href
    ? `${esc(rec.source_name)} <span class="mono">${esc(rec.source_url)}</span>`
    : /^https:\/\//.test(href)
      ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(rec.source_name)}</a>`
      : `<a href="${esc(siteHref(href))}">${esc(rec.source_name)}</a>`;
  const rows = [
    ['Value', esc(rec.kind === 'ratio' ? formatSpreadMultiple(rec.value) : formatValue(rec))],
    ['Kind', esc(rec.kind)],
    ['State', `${chip(rec.state)} ${esc(info ? info.summary : '')}`],
    ['Reason', esc(rec.reason)],
    ['Source', link],
    ['File', `<span class="mono">${esc(rec.source_file)}</span>`],
  ];
  if (inputs && inputs.length) rows.push(['Inputs', inputs.map((i) => `<span class="mono input-date">${esc(i.text)}</span>`).join('<br>')]);
  rows.push(['Effective', `<span class="mono">${esc(rec.effective_date)}</span>${inputs && inputs.length ? ' <span class="note">(the oldest of the inputs’)</span>' : ''}`]);
  if (rec.period) rows.push(['Period', `<span class="mono">${esc(periodWords(rec.period))}</span>`]);
  if (rec.as_of_date) rows.push(['As of', `<span class="mono">${esc(rec.as_of_date)}</span>`]);
  rows.push(['Retrieved', `<span class="mono">${esc(rec.retrieved_date)}</span>`]);
  if (rec.per) rows.push(['Per', `<span class="mono">${esc(rec.per)}</span>`]);
  return `<div class="rec"><h4 class="rec-title">${esc(title)}</h4><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></div>`;
}

/** Records, de-duplicated; `inputsOf(record)` gives a calculated record's dated inputs. */
function recordGroup(title, recs, inputsOf) {
  if (!recs || !recs.length) return '';
  const seen = new Set();
  const list = recs.filter((r) => {
    const k = JSON.stringify(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const one = (r, i) => recordHtml(list.length > 1 ? `${title} (${i + 1} of ${list.length})` : title, r, inputsOf ? inputsOf(r) : null);
  if (list.length === 1) return one(list[0], 0);
  // The rest wait behind a summary: a group can hold four records of a thousand pixels each.
  return `${one(list[0], 0)}<details class="rec-more" data-key="${esc(title)}"><summary>${esc(title)}: ${list.length - 1} more</summary>${list
    .slice(1)
    .map((r, i) => one(r, i + 1))
    .join('')}</details>`;
}

/** Map each calculated record of the per-NDC results to inputDates() of its own inputs. */
function inputsIndex(s) {
  const map = new Map();
  const add = (rec, inputs) => {
    if (rec && inputs && !map.has(rec)) map.set(rec, inputDates(inputs));
  };
  for (const x of s.per_ndc) {
    if (!isMissing(x.spread)) add(x.spread.record, x.spread.inputs);
    if (x.alternate_spread && !isMissing(x.alternate_spread)) add(x.alternate_spread.record, x.alternate_spread.inputs);
    if (!isMissing(x.reference)) {
      if (x.reference.kind === 'part_b') add(x.reference.record, x.reference.inputs);
      if (x.reference.alternate) add(x.reference.alternate.record, x.reference.alternate.inputs);
    }
  }
  return (rec) => map.get(rec) || null;
}

function missingHtml(title, reason) {
  return `<div class="rec rec-missing"><h4 class="rec-title">${esc(title)}</h4><p>We don’t know yet. ${esc(reason)}</p></div>`;
}

function rulesApplied(s) {
  // Every card offers "What were you charged?", so its rule is always listed.
  const used = new Set(['default-quantity', 'reference-price', 'freshness', 'what-you-paid']);
  if (!isMissing(s.pack)) used.add('unit-total');
  if (!isMissing(s.cost_plus)) used.add('cost-plus');
  if (!isMissing(s.spread)) used.add('spread');
  for (const x of s.per_ndc) {
    if (!isMissing(x.reference) && (x.reference.kind === 'part_b' || x.reference.alternate)) used.add('part-b-per-nadac-unit');
    for (const sp of [x.spread, x.alternate_spread]) {
      if (sp && !isMissing(sp)) {
        if (sp.kind === 'part_b') used.add('part-b-single-labeler');
        if (sp.name_outlier) used.add('part-d-name-outlier');
        if (isExtremeSpread(sp.record)) used.add('extreme-gap');
      }
    }
    if (!isMissing(x.coinsurance)) used.add('part-b-coinsurance');
  }
  return RULES.filter((r) => used.has(r.id));
}

/** "A", "A and B", "A, B and C". */
function andList(xs) {
  return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/**
 * For a row whose Part D join depends on a route taken from FDA's product record
 * (part_d.route_from "fda_product", docs/ARCHITECTURE.md): say so plainly, name the route and
 * FDA's product NDC as FDA writes it, and the FDA packages that list this NDC inside them.
 */
function routeFromProduct(row) {
  const d = row.part_d;
  if (!d || d.route_from !== 'fda_product') return '';
  const inner = Array.isArray(d.inner_of) ? d.inner_of.filter((x) => typeof x === 'string') : [];
  const mono = (x) => `<span class="mono">${esc(x)}</span>`;
  const within = inner.length
    ? `; FDA lists it as a unit inside ${inner.length === 1 ? 'its package' : 'its packages'} ${andList(inner.map(mono))}`
    : '';
  const record = typeof d.product_ndc === 'string' && d.product_ndc ? `, product NDC ${mono(d.product_ndc)} (labeler and product code)` : ' (labeler and product code)';
  return `<p class="route-from"><span class="k">Route for the Part D match:</span> ${esc(d.route)}. The FDA NDC Directory does not list this NDC as a package of its own${within}. Its route was taken from FDA’s record for the same product${record}. ${esc(d.brand_name)} is a Part D name CMS marks with * (one average over several routes), which only NDCs on the route its NDCs share point at.</p>`;
}

/** One row's NADAC price, chip and date: the same line in the panel and in "Your NDC". */
function nadacLine(row) {
  return `<span class="k">NADAC:</span> ${esc(unitPrice(row.nadac))} ${chip(row.nadac.state)} <span class="mono">eff. ${esc(row.nadac.effective_date)}</span>`;
}

function ndcItem(x, yours) {
  const row = x.row;
  const id = row.identity;
  const codes = (row.explanation_codes || [])
    .map((c) => `<li><span class="mono">${esc(c)}</span> ${esc(NADAC_EXPLANATION_CODES[c] || 'a code the NADAC data dictionary does not list')}</li>`)
    .join('');
  const ref = isMissing(x.reference)
    ? `<p><span class="k">Medicare:</span> we don’t know yet. ${esc(x.reference.reason)}</p>`
    : `<p><span class="k">${esc(x.reference.label)}:</span> ${esc(unitPrice(x.reference.record))} ${chip(x.reference.record.state)} ${esc(x.reference.reason)}</p>${
        x.reference.part_b_reason ? `<p><span class="k">Part B:</span> ${esc(x.reference.part_b_reason)}</p>` : ''
      }${x.reference.part_d_reason ? `<p><span class="k">Part D:</span> ${esc(x.reference.part_d_reason)}</p>` : ''}${
        x.reference.alternate ? `<p><span class="k">Also ${esc(x.reference.alternate.label)}:</span> ${esc(unitPrice(x.reference.alternate.record))} ${chip(x.reference.alternate.record.state)}</p>` : ''
      }`;
  const sp = isMissing(x.spread)
    ? `<p><span class="k">Spread:</span> we don’t know yet. ${esc(x.spread.reason)}</p>`
    : `<p><span class="k">Spread:</span> ${esc(formatSpreadMultiple(x.spread.record.value))} ${chip(x.spread.record.state)} ${esc(x.spread.sentence)}</p><p class="mono input-date">${esc(
        inputDates(x.spread.inputs)
          .map((i) => i.text)
          .join(' · '),
      )}</p>`;
  const g = row.generic_nadac;
  // Closed unless it is the reader's own: a product can have 70 of these (decision 54).
  return `<li class="ndc" id="ndc-${esc(row.ndc)}"><details class="ndc-more" data-key="${esc(row.ndc)}"${yours ? ' open' : ''}>
<summary><h4 class="ndc-id mono">NDC ${esc(showNdc(row.ndc))}</h4>${id && id.labeler ? `<span class="ndc-labeler">${esc(id.labeler)}</span>` : ''}</summary>
<div class="ndc-body">
${id ? `<p>${esc([id.proprietary_name, id.nonproprietary_name, id.dosage_form, id.route, id.strength].filter(Boolean).join(' · '))}</p><p><span class="k">Labeler:</span> ${esc(id.labeler)}</p><p><span class="k">Package:</span> ${esc(id.package_description)}</p>` : '<p>The FDA NDC Directory file used for this build does not list this NDC as a package of its own with a product record, so OpenBill has no FDA name or package description for it.</p>'}
${routeFromProduct(row)}
<p>${nadacLine(row)}${row.carried_forward ? ' · carried forward from the previous file' : ''}</p>
${g ? `<p><span class="k">Generic equivalent’s NADAC (a different product):</span> ${esc(unitPrice(g))} ${chip(g.state)} <span class="mono">${esc(`${g.source_name} · eff. ${g.effective_date}`)}</span></p>` : ''}
<p><span class="k">Rate class:</span> ${esc(row.rate_class)} · <span class="k">OTC:</span> ${row.otc ? 'yes' : 'no'}</p>
${codes ? `<p class="k">NADAC explanation codes:</p><ul class="codes">${codes}</ul>` : ''}
${ref}
${sp}
</div></details></li>`;
}

function panelHtml(s, refPack) {
  const parts = [];
  const inputsOf = inputsIndex(s);
  if (showsMedicare(s)) parts.push(`<p class="not-yours">${honestyLine('not-your-price', { firstSentenceOnly: true })}</p>`);
  parts.push('<h3>Every figure on this card</h3>');
  if (!isMissing(s.pack)) {
    parts.push(recordGroup('Pharmacy pays: pack total', s.pack.same ? [s.pack.min] : [s.pack.min, s.pack.max]));
  } else {
    parts.push(missingHtml('Pharmacy pays: pack total', s.pack.reason));
  }
  parts.push(recordGroup('Pharmacy pays per unit (NADAC)', s.nadac.records));
  if (!isMissing(s.cost_plus)) {
    const cp = s.cost_plus;
    parts.push(recordGroup('Cost-plus estimate: pack total', cp.same ? [cp.min] : [cp.min, cp.max], () => costPlusInputs(s)));
  } else {
    parts.push(missingHtml('Cost-plus estimate', s.cost_plus.reason));
  }
  if (s.generic_nadac) parts.push(recordGroup('Generic equivalent’s NADAC per unit (a different product)', s.generic_nadac.records));
  if (isMissing(s.reference)) {
    parts.push(missingHtml('Medicare reference price', s.reference.reason));
  } else {
    if (refPack) parts.push(recordGroup(`${s.reference.label}: pack total`, refPack.same ? [refPack.min] : [refPack.min, refPack.max], () => s.reference.inputs));
    parts.push(recordGroup(`${s.reference.label} per unit`, s.reference.range.records, inputsOf));
    if (s.reference.without.length) {
      const list = `<ul>${s.reference.without.map((w) => `<li><span class="mono">${esc(showNdc(w.ndc))}</span> ${esc(w.reason)}</li>`).join('')}</ul>`;
      const count = s.reference.without.length;
      parts.push(
        `<div class="rec rec-missing"><h4 class="rec-title">NDCs without this Medicare figure</h4>${
          count > 3 ? `<details class="rec-more" data-key="NDCs without"><summary>${esc(formatCount(count))} NDCs, each with its reason</summary>${list}</details>` : list
        }</div>`,
      );
    }
  }
  if (isMissing(s.spread)) parts.push(missingHtml('The spread', s.spread.reason));
  else parts.push(recordGroup('The spread', s.spread.range.records, inputsOf));

  if (!isMissing(s.reference) && s.reference.alternate) {
    const alt = s.reference.alternate;
    parts.push(`<h3>Also: ${esc(alt.label)}</h3>${alt.setting_notes.map((n) => `<p>${esc(n)}</p>`).join('')}`);
    parts.push(recordGroup(`${alt.label} per unit`, alt.range.records, inputsOf));
    const altSpreads = s.per_ndc.map((x) => x.alternate_spread).filter((x) => x && !isMissing(x));
    parts.push(recordGroup('Spread against Part B', altSpreads.map((x) => x.record), inputsOf));
    for (const x of s.per_ndc) {
      if (!isMissing(x.reference) && x.reference.alternate) {
        parts.push(`<p class="why">${esc(x.reference.alternate.reason)}</p>`);
        break;
      }
    }
  }
  if (s.coinsurance) parts.push(recordGroup('Part B coinsurance per billing unit', s.coinsurance.records));

  parts.push('<h3>How old each source is</h3>');
  const fda = fdaFreshness(s);
  parts.push(
    `<ul class="fresh-list">${s.freshness_inputs
      .filter((f) => SOURCE_INFO[f.source])
      .map((f) => freshness(f.record, SOURCE_INFO[f.source], app.today))
      .concat(fda ? [fda] : [])
      .map((r) => `<li>${r.stale ? `${staleChip()} ` : ''}${esc(r.message)}</li>`)
      .join('')}</ul>`,
  );

  parts.push('<h3>Starting quantity</h3>');
  parts.push(`<p>${esc(s.default_quantity.reason)}</p>`);

  const prop = uniqueCaseless(s.names.proprietary);
  const nonprop = uniqueCaseless(s.names.nonproprietary);
  if (prop.length || nonprop.length) {
    parts.push('<h3>Names in the FDA NDC Directory</h3>');
    if (prop.length) parts.push(`<p><span class="k">Proprietary:</span> ${esc(prop.join(' · '))}</p>`);
    if (nonprop.length) parts.push(`<p><span class="k">Nonproprietary:</span> ${esc(nonprop.join(' · '))}</p>`);
    parts.push(`<p class="mono">${esc(fdaLine())}</p>`);
  }

  parts.push(`<h3>Each NDC (${esc(formatCount(s.per_ndc.length))})</h3>`);
  const yours = app.current && app.current.ndc && app.current.ndc.row ? app.current.ndc.ndc : null;
  parts.push(`<ol class="ndc-list">${s.per_ndc.map((x) => ndcItem(x, x.row.ndc === yours)).join('')}</ol>`);

  parts.push('<h3>Rules applied</h3>');
  parts.push(
    `<ul class="rules">${rulesApplied(s)
      .map((r) => `<li><a href="${esc(siteHref(`methodology.html#${r.id}`))}">${esc(r.title)}</a><p class="mono">${esc(r.formula)}</p></li>`)
      .join('')}</ul>`,
  );
  return parts.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Card rendering

/** The quantity buttons the core offers for this product (30/60/90 for oral tablets and capsules, 1/2/3 for anything else per EA). */
function qtyChips(s) {
  return s.default_quantity.chips.map(String);
}

/** A crafted quantity longer than any usable one does not go into the box. */
function qtyBoxValue(qty) {
  return qty.length > QTY_MAX_CHARS ? '' : qty;
}

/** Ties the reason to the field: invalid while the typed quantity is unusable, cleared when it is not. */
function syncQtyField(qty, fault) {
  const input = $('qty');
  if (!input) return;
  if (fault) input.setAttribute('aria-describedby', 'qty-why');
  else input.removeAttribute('aria-describedby');
  if (fault && qty !== '') input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

function qtyControls(s, qty) {
  const unit = s.unit || 'units';
  const offered = qtyChips(s);
  const isChip = offered.includes(qty);
  const chips = offered.length
    ? `<div class="qty-chips">${offered.map((c) => `<button type="button" class="qty-chip" data-qty="${esc(c)}" aria-pressed="${c === qty ? 'true' : 'false'}">${esc(c)}</button>`).join('')}</div>`
    : '';
  return `<div class="qty" role="group" aria-labelledby="qty-label">
<span id="qty-label" class="qty-label">Quantity</span>
${chips}<label class="qty-field${isChip ? ' qty-field-quiet' : ''}"><span class="visually-hidden">Other quantity</span><input id="qty" class="qty-input" type="number" inputmode="decimal" min="0.001" max="9999" step="any" value="${esc(qtyBoxValue(qty))}" aria-label="${esc(`Quantity in ${unitWords(unit)}`)}"><span id="qty-unit" class="qty-unit">${esc(unitWords(s.unit))}</span></label>
</div>`;
}

// "What were you charged?" (docs/ARCHITECTURE.md): the reader's own number, compared in this
// page by paidComparison(). It is kept in app.current and in the address after # only: never
// saved or sent by OpenBill, and never put in the "Wrong? Tell us" link or the page link.

const PAID_HINT = `Optional: what you paid for this pack, in dollars. ${PAID_PRIVACY}`;

function multiplesText(vs) {
  const a = formatMultiple(vs.min);
  const b = formatMultiple(vs.max);
  return vs.same || a === b ? a : `${a} – ${b}`;
}

/** What the reader's number is divided by: "$3.35 CMS NADAC pack total (filed)". */
function dividedBy(vs, what) {
  const [lo, hi] = vs.inputs;
  const state = lo.state === hi.state ? lo.state : 'estimated';
  return `${moneyRange(lo, hi, lo.value === hi.value)} ${what} (${state})`;
}

function paidResultHtml(s) {
  const c = app.current;
  const note = c.paidNote ? `<p class="paid-problem">${esc(c.paidNote)}</p>` : '';
  if (!c.paid || !c.paid.trim()) return note;
  const r = safePaidComparison(c.paid, s.pack, s.cost_plus);
  if (!r.valid) return `${note}<p class="paid-problem">${esc(r.problem)}</p>`;
  const rows = [];
  const by = [];
  if (!isMissing(r.vs_pharmacy)) {
    rows.push(`<li><span class="paid-multiple" data-figure="paid-pharmacy">${esc(multiplesText(r.vs_pharmacy))}</span> <span class="chip chip-yours">your number</span> <span class="paid-what">what pharmacies pay for this pack</span></li>`);
    by.push(dividedBy(r.vs_pharmacy, 'CMS NADAC pack total'));
  }
  if (!isMissing(r.vs_cost_plus)) {
    rows.push(`<li><span class="paid-multiple" data-figure="paid-cost-plus">${esc(multiplesText(r.vs_cost_plus))}</span> <span class="chip chip-yours">your number</span> <span class="paid-what">the cost-plus estimate</span></li>`);
    by.push(dividedBy(r.vs_cost_plus, 'cost-plus estimate'));
  }
  const how = by.length ? `<p class="prov mono">${esc(`Your number, ${formatMoney(r.paid)}, ÷ ${by.join('; ÷ ')}. Worked out in this page.`)}</p>` : '';
  return `${note}<p class="paid-sentence">${esc(r.sentence)}</p>${rows.length ? `<ul class="paid-list">${rows.join('')}</ul>` : ''}${how}`;
}

function paidInvalid(text) {
  return Boolean(text && text.trim() && !safeParsePaid(text).valid);
}

function paidControls(s) {
  const c = app.current;
  app.paidShown = paidResultHtml(s);
  return `<section class="paid" aria-labelledby="paid-label">
<label id="paid-label" class="paid-label" for="paid">What were you charged?</label>
<p id="paid-hint" class="paid-hint">${esc(PAID_HINT)}</p>
<div class="paid-field"><span class="paid-cur" aria-hidden="true">$</span><input id="paid" class="paid-input" type="text" inputmode="decimal" autocomplete="off" autocorrect="off" spellcheck="false" maxlength="24" aria-describedby="paid-hint paid-result" aria-invalid="${paidInvalid(c.paid) ? 'true' : 'false'}" value="${esc(c.paid || '')}"></div>
<div id="paid-result" class="paid-result" aria-live="polite" aria-atomic="true">${app.paidShown}</div>
</section>`;
}

function renderPaid() {
  const c = app.current;
  const box = $('paid-result');
  if (!c || !box || !c.summary) return;
  const html = paidResultHtml(c.summary);
  box.removeAttribute('aria-busy');
  // A live region: writing the same words again would read them out again.
  if (html !== app.paidShown) {
    box.innerHTML = html;
    app.paidShown = html;
  }
  const input = $('paid');
  if (input) input.setAttribute('aria-invalid', paidInvalid(c.paid) ? 'true' : 'false');
}

/** The reader typed in "What were you charged?": update the result and the address once typing pauses. */
function setPaid(text) {
  if (!app.current) return;
  app.current.paid = String(text);
  app.current.paidNote = null;
  clearTimeout(app.paidTimer);
  app.paidTimer = setTimeout(() => {
    if (!app.current) return;
    renderPaid();
    replaceHash(currentHash());
  }, 250);
}

/**
 * The address's &paid=, checked before it is used: a usable amount fills the box as "12.50"; any
 * other value is dropped (from the box and the address), and the card says why without
 * repeating it.
 */
function paidFromHash(raw) {
  if (raw === null || raw === undefined || raw === '') return { paid: '', note: null };
  const p = safeParsePaid(raw);
  if (p.valid) return { paid: p.value.toFixed(2), note: null };
  return { paid: '', note: `The amount in this link was not used. ${p.problem}` };
}

/**
 * The product's page on the website, by the same siteSlugs() rule tools/site.mjs builds the pages
 * with, or null if the names cannot be given slugs (then the site build would have failed too).
 */
function pageUrl(name) {
  if (app.slugs === null) {
    try {
      app.slugs = siteSlugs(app.products.map((p) => p.name));
    } catch {
      app.slugs = new Map();
    }
  }
  const slug = app.slugs.get(name);
  return slug ? `${SITE_URL}drug/${slug}/` : null;
}

function headHtml(s) {
  const unitText = s.unit ? `priced per ${unitWords(s.unit)}` : `priced per ${s.units.map(unitWords).join(' or ')}`;
  return `<header class="card-head">
<p class="card-kicker mono">${esc(`${formatCount(s.counts.rows)} NDC${s.counts.rows === 1 ? '' : 's'} · ${unitText}`)}</p>
<h1 id="card-title" class="card-title" tabindex="-1">${esc(s.name)}</h1>
</header>`;
}

/** Moves focus to the card's heading; the page scrolls to the card unless `scroll` is false. */
function focusTitle({ scroll = true } = {}) {
  const h = $('card-title');
  if (!h) return;
  h.focus({ preventScroll: true });
  if (scroll) $('card').scrollIntoView({ block: 'start' });
}

function writeStatus(text) {
  const st = $('card-status');
  if (st && st.textContent !== text) st.textContent = text;
}

/**
 * Before the card shows something else: nothing still queued for the last one may be read out
 * over the new heading, and what was said about it must not stay to be found by reading on.
 */
function dropAnnouncements() {
  clearTimeout(app.announce);
  clearTimeout(app.paidTimer);
  writeStatus('');
}

function markCardShown() {
  const card = $('card');
  card.classList.remove('card-pending');
  card.setAttribute('aria-busy', 'false');
  app.shown = true;
}

/** Builds the panel for the current figures, if it does not already show them. */
function fillPanel() {
  const c = app.current;
  const body = $('panel-body');
  if (!c || !c.summary || !body || app.panelFor === c.summary) return;
  const open = [...body.querySelectorAll('details[open]')].map((d) => d.dataset.key);
  body.innerHTML = panelHtml(c.summary, referencePack(c.summary));
  for (const d of body.querySelectorAll('details')) if (open.includes(d.dataset.key)) d.open = true;
  app.panelFor = c.summary;
}

/** Open the panel at one NDC, for the "Your NDC" line and a #ndc- anchor. */
function revealNdc(ndc) {
  const panel = $('panel');
  if (!panel) return;
  fillPanel();
  panel.open = true;
  const item = $(`ndc-${ndc}`);
  if (!item) return;
  item.querySelector('details').open = true;
  item.scrollIntoView();
  item.querySelector('summary').focus({ preventScroll: true });
}

/**
 * What the address's &ndc= says about this product, or null with none. It is untrusted text: only
 * a real NDC of this product, or of another package of the same labeler and product, stays. Anything
 * else is dropped with a sentence (note) that shows at most clipText() of it.
 */
function linkNdc(raw, product) {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const ndc = normalizeNdc(raw);
  const dropped = (note) => ({ ndc: null, row: null, others: [], note });
  if (!ndc) return dropped(`The NDC in this link, “${clipText(raw.trim())}”, could not be read, so it was left out.`);
  const row = product.rows.find((r) => r.ndc === ndc);
  if (row) return { ndc, row, others: [], note: null };
  const others = product.rows.filter((r) => r.ndc.slice(0, 9) === ndc.slice(0, 9));
  if (others.length) return { ndc, row: null, others, note: null };
  return dropped(`NDC ${showNdc(ndc)} in this link is not a package of this drug, so it was left out.`);
}

function packageLines(row) {
  const id = row.identity;
  const words = id ? [id.labeler, id.package_description].filter(Boolean).join(' · ') : '';
  return `${words ? `<p>${esc(words)}</p>` : ''}<p>${nadacLine(row)}</p>`;
}

/** The NDC the reader came with, above the figures for the product as a whole (decision 54). */
function yourNdcHtml(entered) {
  if (!entered) return '';
  if (entered.note) return `<p id="your-ndc" class="your-ndc">${esc(entered.note)}</p>`;
  const title = `<p class="your-ndc-title"><span class="k">Your NDC:</span> <span class="mono">${esc(showNdc(entered.ndc))}</span></p>`;
  if (entered.row) {
    return `<div id="your-ndc" class="your-ndc">${title}${packageLines(entered.row)}<button type="button" class="your-ndc-more" data-ndc="${esc(entered.ndc)}">Show this NDC in Sources and method</button></div>`;
  }
  const [nearest] = entered.others;
  const more = entered.others.length - 1;
  return `<div id="your-ndc" class="your-ndc">${title}<p>This NDC is not in the NADAC file. NADAC prices each NDC separately, and it lists this labeler’s same product in a different package. This price is for that package, not yours:</p><p class="mono">NDC ${esc(showNdc(nearest.ndc))}</p>${packageLines(nearest)}${
    more ? `<p>${esc(formatCount(more))} more of this labeler’s package${more === 1 ? ' is' : 's are'} in Sources and method.</p>` : ''
  }<button type="button" class="your-ndc-more" data-ndc="${esc(nearest.ndc)}">Show that NDC in Sources and method</button></div>`;
}

function renderCard({ focus = false, scroll = true } = {}) {
  const card = $('card');
  const { product, qty } = app.current;
  const s = summarizeProduct(product.rows, qty === '' ? undefined : qty, { partDContext: app.partDContext });
  app.current.summary = s;
  const f = figuresHtml(s);
  const share = pageUrl(product.name);
  dropAnnouncements();
  card.innerHTML = `${headHtml(s)}
${yourNdcHtml(app.current.ndc)}
<div id="figures" class="figures">${f.html}</div>
${qtyControls(s, qty)}
${paidControls(s)}
<div id="after" class="after">${f.after}</div>
<div class="card-foot">
${share ? `<a id="share" class="share" href="${esc(share)}" target="_blank" rel="noopener">Shareable page</a>\n` : ''}<a id="report" class="report" href="${esc(f.report)}" target="_blank" rel="noopener">Wrong? Tell us</a>
<details id="panel" class="panel"><summary>Sources and method</summary><div id="panel-body" class="panel-body"></div></details>
</div>`;
  app.panelFor = null;
  syncQtyField(qty, quantityFault(s, qty));
  markCardShown();
  document.title = `${s.name}: OpenBill`;
  if (focus) focusTitle({ scroll });
}

/** Re-render the figures for a new quantity, keeping the quantity box as it is. */
function renderFigures() {
  const { product, qty } = app.current;
  const s = summarizeProduct(product.rows, qty === '' ? undefined : qty, { partDContext: app.partDContext });
  app.current.summary = s;
  const f = figuresHtml(s);
  const fault = quantityFault(s, qty);
  $('figures').innerHTML = f.html;
  $('after').innerHTML = f.after;
  // A closed panel is built when it opens: writing it here cost more than the figures themselves
  // on a product with many NDCs.
  if ($('panel').open) fillPanel();
  $('report').setAttribute('href', f.report);
  for (const b of document.querySelectorAll('.qty-chip')) b.setAttribute('aria-pressed', b.dataset.qty === qty ? 'true' : 'false');
  const field = document.querySelector('.qty-field');
  if (field) field.classList.toggle('qty-field-quiet', qtyChips(s).includes(qty));
  syncQtyField(qty, fault);
  // Say what changed, once typing pauses (WCAG 4.1.3: status messages). The paid result is a live
  // region too, so it waits for the same pause; until then it is marked as out of date.
  const paidBox = $('paid-result');
  if (paidBox && paidResultHtml(s) !== app.paidShown) paidBox.setAttribute('aria-busy', 'true');
  clearTimeout(app.announce);
  const text = statusText(s, f.refPack, fault);
  app.announce = setTimeout(() => {
    renderPaid();
    writeStatus(text);
  }, 500);
}

function renderMessage(title, html) {
  const card = $('card');
  dropAnnouncements();
  card.innerHTML = `<header class="card-head"><h1 id="card-title" class="card-title" tabindex="-1">${esc(title)}</h1></header>
<div class="card-message">${html}</div>`;
  markCardShown();
  document.title = `${title}: OpenBill`;
}

function defaultCardLink(words) {
  return `<a href="${esc(hashFor(app.build.default.drug, app.build.default.qty))}">${esc(words)} ${esc(app.build.default.drug)}</a>`;
}

/**
 * A link's unknown name goes in the search box, unless the reader is typing there.
 * @returns {boolean} whether it did
 */
function prefillSearch(text) {
  const input = $('q');
  const typed = input.value.trim() !== '' && (!app.index || document.activeElement === input);
  if (typed && input.value !== app.missQuery) return false;
  input.value = String(text).slice(0, QUERY_MAX_CHARS);
  app.missQuery = input.value;
  runSearch(input.value);
  return true;
}

function routeHash(focus) {
  let h = readHash();
  if (h.kind === 'anchor') {
    const skipTarget = h.anchor === 'card';
    if (app.shown) {
      // Not addressed to this page's state: the card stays, and the address goes back to naming
      // it, so a reload or a shared link still opens the same card.
      if (app.current) replaceHash(currentHash());
      if (skipTarget) focusTitle();
      const entry = /^ndc-(\d{11})$/.exec(h.anchor || '');
      if (entry && app.current && app.current.product.ndcs.includes(entry[1])) revealNdc(entry[1]);
      return;
    }
    h = defaultRoute();
    // Opening at #card, as after a reload: land where the skip link would, unless the reader has
    // already gone somewhere.
    if (skipTarget && document.activeElement === document.body) focus = true;
  }
  if (h.kind === 'bad') {
    app.current = null;
    renderMessage('That link does not name a drug', `<p>${esc(h.problem)}</p><p>${defaultCardLink('Open')} or search above.</p>`);
    if (focus) focusTitle();
    return;
  }
  const product = findProduct(h.drug);
  if (!product) {
    app.current = null;
    const filled = prefillSearch(h.drug);
    renderMessage(
      'No drug by that name',
      `<p>This week’s NADAC file has no product named “${esc(clipText(h.drug))}”. NADAC names change when CMS updates a description, so an old link can stop working.</p><p>${filled ? 'That name is in the search box above' : 'Search for it above'}, or ${defaultCardLink('open')}.</p>`,
    );
    if (focus) focusTitle();
    return;
  }
  let qty = h.qty;
  if (qty === null || qty === undefined) {
    const dq = summaryWithoutQty(product).default_quantity;
    qty = String(dq.qty);
  }
  qty = qty.trim();
  const paid = paidFromHash(h.paid);
  const entered = linkNdc(h.ndc, product);
  const ndc = entered && entered.ndc;
  // A link's unusable &paid= or &ndc= is dropped from the address as well as the box, and a name or
  // an NDC spelled another way (or with no drug= before it) is written the way the page writes it.
  if (paid.note || h.drug !== product.name || h.bare || (typeof h.ndc === 'string' && h.ndc !== ndc)) replaceHash(hashFor(product.name, h.qty, paid.paid, ndc));
  const held = app.current && app.current.product === product ? app.current.ndc : null;
  if (app.current && app.current.product === product && $('qty') && ((held && held.ndc) || null) === (ndc || null) && !(entered && entered.note)) {
    app.current.qty = qty;
    const input = $('qty');
    if (document.activeElement !== input) input.value = qtyBoxValue(qty);
    const box = $('paid');
    if (box && document.activeElement !== box && paidForHash(app.current.paid) !== paid.paid) {
      app.current.paid = paid.paid;
      box.value = paid.paid;
    }
    app.current.paidNote = paid.note;
    renderFigures();
    // Back, Forward or a followed link to this drug at another quantity; never from under a reader
    // typing in the card's own boxes (an old browser can reach here from their typing).
    if (focus && document.activeElement !== input && document.activeElement !== box) focusTitle({ scroll: !h.home });
    return;
  }
  app.current = { product, qty, paid: paid.paid, paidNote: paid.note, ndc: entered, summary: null };
  renderCard({ focus, scroll: !h.home });
}

function renderFromHash({ focus = false } = {}) {
  // An address is untrusted text. If the core ever threw on one, that must cost only this card:
  // the search box and the other cards still work, and the reader gets a sentence, not an error.
  try {
    routeHash(focus);
  } catch {
    app.current = null;
    renderMessage('That link could not be opened', `<p>Something in the address after # could not be read.</p><p>${defaultCardLink('Open')} or search above.</p>`);
    if (focus) focusTitle();
  }
}

function summaryWithoutQty(product) {
  let s = app.cache.get(product.name);
  if (!s) {
    s = summarizeProduct(product.rows, undefined, { partDContext: app.partDContext });
    app.cache.set(product.name, s);
  }
  return s;
}

/** A search result's NADAC prices, one range per unit, and their weakest state. */
function resultPrices(product) {
  let p = app.priceCache.get(product.name);
  if (!p) {
    const groups = rangesByUnit(product.rows.map((r) => r.nadac));
    const states = groups.map((g) => g.range.state);
    p = { text: unitGroups(groups), state: states.find((x) => x === 'estimated') || states.find((x) => x === 'derived') || states.find((x) => x === 'published') || states[0] };
    app.priceCache.set(product.name, p);
  }
  return p;
}

function setQty(qty) {
  if (!app.current) return;
  app.current.qty = String(qty).trim();
  if (replaceHash(currentHash())) renderFigures();
}

function openProduct(name, { qty, ndc } = {}) {
  const product = app.byName.get(name);
  if (!product) return;
  const q = qty === undefined ? String(summaryWithoutQty(product).default_quantity.qty) : String(qty);
  const hash = hashFor(name, q, '', ndc);
  clearResults();
  if (location.hash === hash) {
    app.current = null;
    renderFromHash({ focus: true });
  } else {
    location.hash = hash;
  }
}

// ---------------------------------------------------------------------------------------------
// Search

function clearResults() {
  $('results').innerHTML = '';
  $('search-help').innerHTML = '';
  $('search-status').textContent = '';
  app.allResults = [];
  clearTimeout(app.searchTimer);
}

function listClosed() {
  return !$('results').firstChild && !$('search-help').firstChild;
}

/** The line under a result that says how an NDC found it, or which other name did. */
function resultNote(r, query) {
  if (r.match === 'ndc-product') return `<span class="result-ndc mono">Labeler and product code ${esc(formatNdcCode(r.code))}</span>`;
  if (r.match === 'ndc-package') return `<span class="result-ndc mono">A different package: NDC ${esc(showNdc(r.matched))}</span>`;
  if (r.match === 'ndc') {
    const printed = r.ambiguous && r.printed ? `, printed ${r.printed} by FDA` : '';
    return `<span class="result-ndc mono">${r.guess ? 'Read as NDC' : 'NDC'} ${esc(showNdc(r.matched))}${esc(printed)}${r.guess ? '; check your label' : ''}</span>`;
  }
  if (r.match === 'partial') return `<span class="result-via result-partial">Partial match${r.own ? '' : `: “${esc(r.matched)}”`}</span>`;
  // Say which name matched only when the product's own name does not already show the query.
  const q = normalizeQuery(query);
  const own = normalizeQuery(r.product.name);
  return r.matched && r.matched !== r.product.name && !(q && own.includes(q)) ? `<span class="result-via">matched “${esc(r.matched)}”</span>` : '';
}

function resultItem(r, query) {
  const p = resultPrices(r.product);
  return `<li><button type="button" class="result" data-name="${esc(r.product.name)}"${r.entered ? ` data-ndc="${esc(r.entered)}"` : ''}>
<span class="result-name">${esc(r.product.name)}</span>
<span class="result-meta"><span class="result-price mono">NADAC ${esc(p.text)}</span> ${chip(p.state)}</span>
${resultNote(r, query)}
</button></li>`;
}

/** While the data loads, the box already takes typing; this says when it will be used. */
function showSearchWait() {
  const status = $('search-status');
  if (status.textContent !== SEARCH_WAIT) status.textContent = SEARCH_WAIT;
}

/** What the list above the results says: how many, and what Enter will do. */
function listStatus(all, shown, said, choice) {
  const n = all.length;
  const top = all[0];
  if (top.guess) return `A 12-digit number is not an NDC. Read as one, it could be ${n === 1 ? 'this drug' : 'any of these'}; check the NDC printed on your label.`;
  if (top.match === 'ndc-package') {
    const tried = [...new Set(all.map((r) => r.entered))].map(showNdc).join(' or ');
    return `No package in the NADAC file has NDC ${tried}. ${n === 1 ? 'This is' : 'These are'} the same labeler’s product in a different package, and NADAC prices each NDC separately.`;
  }
  if (top.match === 'ndc' && top.ambiguous) return `Without hyphens, this number could be ${n === 2 ? 'either' : 'any'} of these ${n} drugs. Check the hyphens on your label, or choose one.`;
  if (all.every((r) => r.match === 'partial')) return `No drug is named “${said}”. ${n === 1 ? 'This is a partial match' : 'These are partial matches'}; check the spelling.`;
  const many = n >= COUNT_LIMIT ? `${formatCount(COUNT_LIMIT)} or more` : formatCount(n);
  const count = `${many} drug${n === 1 ? '' : 's'} match${n === 1 ? 'es' : ''} “${said}”.`;
  if (choice) return n === 1 ? `${count} Press Enter to open it.` : `${count} Press Enter to open ${choice.product.name}.`;
  if (n > shown) return `${count} Showing the first ${shown}; choose one, or type more to narrow it down.`;
  return `${count} ${n === 1 ? 'Open it from the list if it is the one you mean.' : 'Choose one from the list.'}`;
}

/** What Enter would open just now: nothing, once a result has been opened from this same text. */
function enterTarget(text) {
  return text === app.pickedQuery ? null : enterChoice(app.allResults);
}

function runSearch(query) {
  const q = String(query || '').slice(0, QUERY_MAX_CHARS);
  if (!app.index) {
    showSearchWait();
    return;
  }
  if (!q.trim()) {
    clearResults();
    return;
  }
  clearTimeout(app.searchTimer);
  const said = clipText(q.trim());
  // Results for a link's unknown name are shown before the card; they say why they are there.
  const miss = q === app.missQuery ? 'No drug by that name. ' : '';
  const all = search(app.index, q, { limit: COUNT_LIMIT });
  const shown = all.slice(0, RESULT_LIMIT);
  app.allResults = all;
  $('results').innerHTML = shown.map((r) => resultItem(r, q)).join('');
  if (all.length) {
    $('search-status').textContent = miss + listStatus(all, shown.length, said, enterTarget(q));
    $('search-help').innerHTML = '';
    return;
  }
  const ideas = suggest(app.index, q);
  const read = readNdc(q);
  const tried = read && read.kind === 'package' && !read.guess ? read.ndcs.map(showNdc) : [];
  const codes = read && read.kind === 'product' ? read.codes.map(formatNdcCode) : [];
  // The status region is read out: it carries the suggestion and the NDC explanation too.
  const parts = [`No drug matches “${said}”.`];
  if (ideas.length) parts.push(`Did you mean ${ideas.map((i) => i.query).join(' or ')}?`);
  if (tried.length) parts.push(`No product in the NADAC file has NDC ${tried.join(' or ')}.`);
  if (codes.length) parts.push(`No product in the NADAC file has labeler and product code ${codes.join(' or ')}.`);
  if (read && read.guess) parts.push('A 12-digit number is not an NDC.');
  $('search-status').textContent = parts.join(' ');
  $('search-help').innerHTML = `${
    ideas.length
      ? `<p>Did you mean ${ideas.map((i) => `<button type="button" class="suggest" data-query="${esc(i.query)}">${esc(i.query)}</button>`).join(' or ')}?</p>`
      : ''
  }${read ? '<p>NADAC covers what its pharmacy survey prices, and most packages on FDA’s list of prescription drugs are not in it.</p>' : ''}
<p class="hint">Try the generic name (for example “metformin” rather than a brand), fewer words, or the 10- or 11-digit NDC printed on the label.</p>`;
}

function openResult(name, ndc) {
  app.pickedQuery = $('q').value;
  openProduct(name, { ndc: ndc || undefined });
}

/**
 * Enter in #q, or Enter from before the index was ready (decision 54). It opens only what
 * enterChoice() allows. Otherwise it stays: a plain list takes the focus, so the next Enter is a
 * choice the reader can see; a list that needs reading first leaves the focus on the words typed.
 */
function enterInSearch() {
  const input = $('q');
  runSearch(input.value);
  const choice = enterTarget(input.value);
  if (choice) {
    openResult(choice.product.name, choice.entered);
    return;
  }
  const top = app.allResults[0];
  if (!top || top.match === 'partial' || top.match === 'ndc-package' || top.guess || (top.match === 'ndc' && top.ambiguous)) return;
  $('results').querySelector('button.result').focus();
}

// ---------------------------------------------------------------------------------------------
// Events and startup

/**
 * Bound before the data is unpacked: the box takes typing from the moment it is painted, and the
 * skip link and the card's events work whenever the card arrives.
 */
function bind() {
  const input = $('q');
  // Coming back to the box with text in it, the list comes back too.
  const reopen = () => {
    if (app.index && input.value.trim() && listClosed()) runSearch(input.value);
  };
  input.addEventListener('focus', () => {
    if (!app.index) showSearchWait();
    reopen();
  });
  input.addEventListener('click', reopen);
  // Typed before this script ran, while the page was still arriving.
  if (input.value.trim() || document.activeElement === input) showSearchWait();
  input.addEventListener('input', () => {
    clearTimeout(app.searchTimer);
    app.missQuery = null;
    app.pickedQuery = null;
    // One or two letters match most of the list; wait a little longer before searching them.
    const wait = input.value.trim().length <= 2 ? 200 : 60;
    app.searchTimer = setTimeout(() => runSearch(input.value), wait);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(app.searchTimer);
      if (!app.index) {
        app.enterWaiting = true;
        showSearchWait();
        return;
      }
      enterInSearch();
    } else if (e.key === 'Escape') {
      clearResults();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && app.index && input.value.trim()) {
      reopen();
      const buttons = $('results').querySelectorAll('button.result');
      if (!buttons.length) return;
      e.preventDefault();
      buttons[e.key === 'ArrowDown' ? 0 : buttons.length - 1].focus();
    }
  });
  $('results').addEventListener('click', (e) => {
    const b = e.target.closest('button.result');
    if (b) openResult(b.dataset.name, b.dataset.ndc);
  });
  $('results').addEventListener('keydown', (e) => {
    const b = e.target.closest('button.result');
    if (!b) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const li = b.parentElement;
      const next = e.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling;
      if (next) next.firstElementChild.focus();
      else if (e.key === 'ArrowUp') input.focus();
    } else if (e.key === 'Escape') {
      // In this order, or the box's focus would bring the list straight back.
      input.focus();
      clearResults();
    } else if ((e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) || e.key === 'Backspace') {
      // Typing goes on where it belongs; the box takes this key.
      input.focus();
    }
  });
  // Outside the search section the list closes. iOS only reports a tap on plain text to a listener
  // below <body>, so the listener sits on each of its children as well as on the document.
  const closeOutside = (e) => {
    if (app.index && !e.target.closest('.search')) clearResults();
  };
  document.addEventListener('click', closeOutside);
  for (const el of document.body.children) el.addEventListener('click', closeOutside);
  $('search-help').addEventListener('click', (e) => {
    const b = e.target.closest('button.suggest');
    if (!b) return;
    input.value = b.dataset.query;
    runSearch(b.dataset.query);
    input.focus();
  });
  // The skip link's target is the heading, and the address keeps naming the card (without this
  // script, the browser's own jump to #card still works).
  document.querySelector('.skip').addEventListener('click', (e) => {
    e.preventDefault();
    focusTitle();
  });
  const card = $('card');
  // Built before the panel opens on a click or a key press, so it never paints empty.
  card.addEventListener('click', (e) => {
    if (e.target.closest('#panel > summary')) fillPanel();
    const more = e.target.closest('button.your-ndc-more');
    if (more) revealNdc(more.dataset.ndc);
  });
  // "toggle" does not bubble. This catches the panel opening any other way, as find in page does.
  card.addEventListener(
    'toggle',
    (e) => {
      if (e.target.id === 'panel' && e.target.open) fillPanel();
    },
    true,
  );
  // The print stylesheet shows the panel's contents even when it is closed. Each NDC's own details
  // are opened as well, in the browsers that do not take that from a stylesheet, and put back.
  window.addEventListener('beforeprint', () => {
    fillPanel();
    app.printOpened = [...document.querySelectorAll('#panel-body details:not([open])')];
    for (const d of app.printOpened) d.open = true;
  });
  window.addEventListener('afterprint', () => {
    for (const d of app.printOpened) d.open = false;
    app.printOpened = [];
  });
  card.addEventListener('click', (e) => {
    const b = e.target.closest('button.qty-chip');
    if (!b) return;
    const box = $('qty');
    if (box) box.value = b.dataset.qty;
    setQty(b.dataset.qty);
  });
  card.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'qty') setQty(e.target.value);
    else if (e.target && e.target.id === 'paid') setPaid(e.target.value);
  });
  window.addEventListener('hashchange', () => {
    // Still loading, the first render reads the address itself. After a failed load there is no
    // card to change.
    if (app.byName.size === 0) return;
    if (app.index) clearResults();
    renderFromHash({ focus: true });
  });
}

/** An error whose message was written for readers. Any other error's words stay out of the card. */
class PlainError extends Error {}

function renderFatal(err) {
  const card = $('card');
  if (!card) return;
  const said = err instanceof PlainError ? err.message : DATA_UNREADABLE;
  const detail = err && err.message ? err.message : String(err);
  let report = REPO_URL + '/issues/new?template=bug.yml';
  try {
    report = issueUrl({ template: 'bug.yml', title: 'The page did not load', fields: { what_happened: detail, build_id: app.build ? app.build.build_id : '' } });
  } catch {
    // keep the plain link
  }
  dropAnnouncements();
  card.innerHTML = `<header class="card-head"><h1 id="card-title" class="card-title" tabindex="-1">The data did not load</h1></header>
<div class="card-message" role="alert"><p>${esc(said)}</p><p>No figures are shown rather than wrong ones.</p><p><a href="${esc(AZ_URL)}">Browse every drug A–Z</a> as plain pages on the website, or <a href="${esc(report)}" target="_blank" rel="noopener">report this</a>.</p></div>`;
  markCardShown();
  document.title = 'The data did not load: OpenBill';
  // The search box and the Try links go with the data (styles.css, data-ready="error").
  document.documentElement.dataset.ready = 'error';
  const active = document.activeElement;
  if (!active || active === document.body || active.id === 'q') focusTitle({ scroll: false });
}

async function sha256Of(buf) {
  // crypto.subtle exists only in a secure context (file:// and https:// are; plain http:// is
  // not); the core's own SHA-256 gives the same digest everywhere else.
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle && typeof subtle.digest === 'function') {
    try {
      const d = new Uint8Array(await subtle.digest('SHA-256', buf));
      return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // fall through to the core implementation
    }
  }
  return sha256Hex(buf);
}

async function inflate(descriptor) {
  if (!descriptor || descriptor.format !== INLINE_FORMAT || descriptor.encoding !== 'deflate-raw+base64' || typeof descriptor.data !== 'string') {
    throw new PlainError('The inline data block is not in the format this page reads.');
  }
  if (typeof descriptor.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(descriptor.sha256)) {
    throw new PlainError('The inline data block has no checksum to check it against, so it is not used.');
  }
  // Chrome and Edge 80 to 102 have DecompressionStream but not its 'deflate-raw' format, and
  // throw a TypeError for it: the reader gets the same plain sentence either way.
  let inflater = null;
  try {
    inflater = typeof DecompressionStream === 'function' ? new DecompressionStream('deflate-raw') : null;
  } catch {
    inflater = null;
  }
  if (!inflater) throw new PlainError(CANNOT_UNPACK);
  const bin = atob(descriptor.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(inflater);
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  if (buf.length !== descriptor.json_bytes) {
    throw new PlainError(`The inline data unpacked to ${buf.length} bytes, not the ${descriptor.json_bytes} the build recorded.`);
  }
  const digest = await sha256Of(buf);
  if (digest !== descriptor.sha256) {
    throw new PlainError(`The inline data does not match its recorded checksum (sha256 ${digest.slice(0, 12)}…, expected ${descriptor.sha256.slice(0, 12)}…), so it may have been changed or damaged.`);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(buf);
}

/** Hands the main thread back between stages of start-up, so the page can paint and take input. */
function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function start() {
  try {
    pointSavedCopyAtSite();
    bind();
    $('card').setAttribute('aria-busy', 'true');
    app.build = JSON.parse($('openbill-build').textContent);
    const t0 = performance.now();
    const text = await inflate(JSON.parse($('openbill-data').textContent));
    const t1 = performance.now();
    // Each stage in its own task. Each one is timed by itself, so the timings stay comparable.
    const timings = {};
    const stage = async (name, work) => {
      await nextTask();
      const t = performance.now();
      const out = work();
      timings[name] = Math.round(performance.now() - t);
      return out;
    };
    const packed = await stage('parse_ms', () => JSON.parse(text));
    app.doc = await stage('unpack_docs_ms', () => unpackDrugs(packed));
    const t2 = performance.now();
    const rows = await stage('link_ms', () => linkRows(app.doc));
    app.partDContext = await stage('context_ms', () => partDNameContext(rows));
    app.products = await stage('group_ms', () => groupProducts(rows));
    await nextTask();
    app.byName = new Map(app.products.map((p) => [p.name, p]));
    app.caseless = caselessNames(app.byName.keys());
    app.today = isoDate(new Date());
    // The card first; the search index, which the card does not need, in a later task.
    renderFromHash({ focus: false });
    const t3 = performance.now();
    await nextTask();
    const t4 = performance.now();
    app.index = buildIndex(app.products);
    const input = $('q');
    input.removeAttribute('placeholder');
    // A miss on the first render, or typing while the page loaded: its search runs now.
    if (input.value.trim()) {
      if (app.enterWaiting) enterInSearch();
      else runSearch(input.value);
    } else if ($('search-status').textContent === SEARCH_WAIT) {
      $('search-status').textContent = SEARCH_READY;
    }
    app.enterWaiting = false;
    // WCAG 4.1.3: the wait is over, and nothing else on the page says so.
    writeStatus(`${$('card-title').textContent}. ${SEARCH_READY}`);
    const t5 = performance.now();
    const root = document.documentElement;
    root.dataset.startupMs = String(Math.round(t3 - SCRIPT_START));
    root.dataset.timings = JSON.stringify({
      inflate_ms: Math.round(t1 - t0),
      unpack_ms: timings.parse_ms + timings.unpack_docs_ms,
      first_card_ms: Math.round(t3 - t2),
      first_card_since_navigation_ms: Math.round(t3),
      index_ms: Math.round(t5 - t4),
      since_navigation_ms: Math.round(t5),
      ...timings,
    });
    root.dataset.ready = 'true';
  } catch (err) {
    renderFatal(err);
    document.documentElement.dataset.ready = 'error';
  }
}

start();
