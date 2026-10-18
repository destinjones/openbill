// The page: the only DOM code in OpenBill. It renders what src/core returns and computes
// nothing itself. Every value written into HTML goes through esc().

import { esc, safeHref } from '../core/esc.js';
import { unpackDrugs, linkRows } from '../core/pack.js';
import { groupProducts, buildIndex, search, suggest, normalizeQuery } from '../core/search.js';
import { summarizeProduct, partDNameContext, freshness, inputDates, rangesByUnit, isExtremeSpread, formatSpreadMultiple, HONESTY, RULES } from '../core/rules.js';
import { formatMoney, formatUnitPrice, formatCount } from '../core/money.js';
import { formatValue, validateRecord, STATE_INFO } from '../core/provenance.js';
import { formatNdc, isNdc11, looksLikeNdc, ndcCandidates } from '../core/ndc.js';
import { SOURCE_INFO, NADAC_EXPLANATION_CODES } from '../core/sources.js';
import { issueUrl } from '../core/report.js';
import { REPO_URL } from '../core/config.js';
import { isoDate, parsePeriod } from '../core/dates.js';
import { sha256Hex } from '../core/sha256.js';

const SCRIPT_START = performance.now();
const RESULT_LIMIT = 20;
const COUNT_LIMIT = 1000;
const EA_CHIPS = ['30', '60', '90'];
const INLINE_FORMAT = 'openbill.inline/1';
const CALCULATION = 'OpenBill calculation';
const CANNOT_UNPACK = 'This browser cannot unpack the inline data (it has no DecompressionStream for deflate-raw). A current Firefox, Chrome, Edge or Safari can.';
/** People's words for NADAC's pricing units, next to the code itself. */
const UNIT_WORDS = Object.freeze({ EA: 'each (EA)', ML: 'mL', GM: 'g' });

const app = {
  build: null,
  doc: null,
  products: [],
  byName: new Map(),
  partDContext: null, // partDNameContext(rows): each Part D name's products, for nameOutlier()
  index: null,
  today: null,
  current: null, // { product, qty: string, ndc?: string }
  cache: new Map(), // product name → summarizeProduct(rows) without a quantity
  priceCache: new Map(), // product name → NADAC ranges per unit, for search results
  announce: null, // timer for the card's status message
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
// Hash state: #drug=<name>&qty=<n>

function hashFor(name, qty) {
  return `#drug=${encodeURIComponent(name)}${qty === undefined || qty === null || qty === '' ? '' : `&qty=${encodeURIComponent(String(qty))}`}`;
}

function readHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return { drug: app.build.default.drug, qty: String(app.build.default.qty), fromHash: false };
  let params;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return { error: 'The address after # could not be read.' };
  }
  const drug = params.get('drug');
  if (drug === null || drug.trim() === '') return { error: 'The address names no drug (it needs #drug=<name>).' };
  const qty = params.get('qty');
  return { drug, qty: qty === null ? null : qty, fromHash: true };
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
<p class="why">${esc(s.pack.reason)}</p>
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
  if (s.unit !== 'EA') out.push(`<p class="why qty-note">${esc(s.default_quantity.reason)}</p>`);
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

/** A short summary of the figures for the card's status region, read out after a change. */
function statusText(s, refPack) {
  const bits = [];
  if (!isMissing(s.pack)) bits.push(`At ${formatCount(s.pack.qty)} ${unitWords(s.unit)}: pharmacy pays ${moneyRange(s.pack.min, s.pack.max, s.pack.same)}`);
  else bits.push(`Pharmacy pays ${unitGroups(s.nadac_by_unit)}`);
  if (!isMissing(s.reference)) {
    const label = s.reference.kind === 'part_b' ? 'Medicare Part B pays' : 'Medicare Part D paid';
    bits.push(`${label} ${refPack ? moneyRange(refPack.min, refPack.max, refPack.same) : unitRange(s.reference.range)}`);
  } else bits.push('Medicare: we don’t know yet');
  if (!isMissing(s.spread)) bits.push(`spread ${multipleRange(s.spread.range)}, ${s.spread.state}${s.spread.extreme ? `. ${s.spread.sentence}` : ''}`);
  return `${bits.join('; ')}.`;
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
      : `<a href="${esc(href)}">${esc(rec.source_name)}</a>`;
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
  return list.map((r, i) => recordHtml(list.length > 1 ? `${title} (${i + 1} of ${list.length})` : title, r, inputsOf ? inputsOf(r) : null)).join('');
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
  const used = new Set(['default-quantity', 'reference-price', 'freshness']);
  if (!isMissing(s.pack)) used.add('unit-total');
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

function ndcItem(x) {
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
  return `<li class="ndc" id="ndc-${esc(row.ndc)}">
<h4 class="ndc-id mono">NDC ${esc(showNdc(row.ndc))}</h4>
${id ? `<p>${esc([id.proprietary_name, id.nonproprietary_name, id.dosage_form, id.route, id.strength].filter(Boolean).join(' · '))}</p><p><span class="k">Labeler:</span> ${esc(id.labeler)}</p><p><span class="k">Package:</span> ${esc(id.package_description)}</p>` : '<p>The FDA NDC Directory file used for this build does not list this NDC as a package of its own with a product record, so OpenBill has no FDA name or package description for it.</p>'}
${routeFromProduct(row)}
<p><span class="k">NADAC:</span> ${esc(unitPrice(row.nadac))} ${chip(row.nadac.state)} <span class="mono">eff. ${esc(row.nadac.effective_date)}</span>${row.carried_forward ? ' · carried forward from the previous file' : ''}</p>
${g ? `<p><span class="k">Generic equivalent’s NADAC (a different product):</span> ${esc(unitPrice(g))} ${chip(g.state)} <span class="mono">${esc(`${g.source_name} · eff. ${g.effective_date}`)}</span></p>` : ''}
<p><span class="k">Rate class:</span> ${esc(row.rate_class)} · <span class="k">OTC:</span> ${row.otc ? 'yes' : 'no'}</p>
${codes ? `<p class="k">NADAC explanation codes:</p><ul class="codes">${codes}</ul>` : ''}
${ref}
${sp}
</li>`;
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
  if (s.generic_nadac) parts.push(recordGroup('Generic equivalent’s NADAC per unit (a different product)', s.generic_nadac.records));
  if (isMissing(s.reference)) {
    parts.push(missingHtml('Medicare reference price', s.reference.reason));
  } else {
    if (refPack) parts.push(recordGroup(`${s.reference.label}: pack total`, refPack.same ? [refPack.min] : [refPack.min, refPack.max], () => s.reference.inputs));
    parts.push(recordGroup(`${s.reference.label} per unit`, s.reference.range.records, inputsOf));
    if (s.reference.without.length) {
      parts.push(
        `<div class="rec rec-missing"><h4 class="rec-title">NDCs without this Medicare figure</h4><ul>${s.reference.without
          .map((w) => `<li><span class="mono">${esc(showNdc(w.ndc))}</span> ${esc(w.reason)}</li>`)
          .join('')}</ul></div>`,
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
  parts.push(`<ol class="ndc-list">${s.per_ndc.map(ndcItem).join('')}</ol>`);

  parts.push('<h3>Rules applied</h3>');
  parts.push(
    `<ul class="rules">${rulesApplied(s)
      .map((r) => `<li><a href="methodology.html#${esc(r.id)}">${esc(r.title)}</a><p class="mono">${esc(r.formula)}</p></li>`)
      .join('')}</ul>`,
  );
  return parts.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Card rendering

function qtyControls(s, qty) {
  const unit = s.unit || 'units';
  const isChip = s.unit === 'EA' && EA_CHIPS.includes(qty);
  const chips =
    s.unit === 'EA'
      ? `<div class="qty-chips">${EA_CHIPS.map((c) => `<button type="button" class="qty-chip" data-qty="${esc(c)}" aria-pressed="${c === qty ? 'true' : 'false'}">${esc(c)}</button>`).join('')}</div>`
      : '';
  return `<div class="qty" role="group" aria-labelledby="qty-label">
<span id="qty-label" class="qty-label">Quantity</span>
${chips}<label class="qty-field${isChip ? ' qty-field-quiet' : ''}"><span class="visually-hidden">Other quantity</span><input id="qty" class="qty-input" type="number" inputmode="decimal" min="0.001" max="9999" step="any" value="${esc(qty)}" aria-label="${esc(`Quantity in ${unitWords(unit)}`)}"><span id="qty-unit" class="qty-unit">${esc(unitWords(s.unit))}</span></label>
</div>`;
}

function headHtml(s) {
  const unitText = s.unit ? `priced per ${unitWords(s.unit)}` : `priced per ${s.units.map(unitWords).join(' or ')}`;
  return `<header class="card-head">
<p class="card-kicker mono">${esc(`${formatCount(s.counts.rows)} NDC${s.counts.rows === 1 ? '' : 's'} · ${unitText}`)}</p>
<h1 id="card-title" class="card-title" tabindex="-1">${esc(s.name)}</h1>
</header>`;
}

function renderCard({ focus = false } = {}) {
  const card = $('card');
  const { product, qty } = app.current;
  const s = summarizeProduct(product.rows, qty === '' ? undefined : qty, { partDContext: app.partDContext });
  const f = figuresHtml(s);
  card.innerHTML = `${headHtml(s)}
<div id="figures" class="figures">${f.html}</div>
${qtyControls(s, qty)}
<div id="after" class="after">${f.after}</div>
<div class="card-foot">
<a id="report" class="report" href="${esc(f.report)}" target="_blank" rel="noopener">Wrong? Tell us</a>
<details id="panel" class="panel"><summary>Sources and method</summary><div id="panel-body" class="panel-body">${panelHtml(s, f.refPack)}</div></details>
</div>`;
  card.setAttribute('aria-busy', 'false');
  document.title = `${s.name}: OpenBill`;
  if (focus) {
    const h = $('card-title');
    h.focus({ preventScroll: true });
    card.scrollIntoView({ block: 'start' });
  }
}

/** Re-render the figures and the panel for a new quantity, keeping the quantity box as it is. */
function renderFigures() {
  const { product, qty } = app.current;
  const s = summarizeProduct(product.rows, qty === '' ? undefined : qty, { partDContext: app.partDContext });
  const f = figuresHtml(s);
  $('figures').innerHTML = f.html;
  $('after').innerHTML = f.after;
  $('panel-body').innerHTML = panelHtml(s, f.refPack);
  $('report').setAttribute('href', f.report);
  for (const b of document.querySelectorAll('.qty-chip')) b.setAttribute('aria-pressed', b.dataset.qty === qty ? 'true' : 'false');
  const field = document.querySelector('.qty-field');
  if (field) field.classList.toggle('qty-field-quiet', s.unit === 'EA' && EA_CHIPS.includes(qty));
  // Say what changed, once typing pauses (WCAG 4.1.3: status messages).
  clearTimeout(app.announce);
  const text = statusText(s, f.refPack);
  app.announce = setTimeout(() => {
    const st = $('card-status');
    if (st) st.textContent = text;
  }, 500);
}

function renderMessage(title, html) {
  const card = $('card');
  card.innerHTML = `<header class="card-head"><h1 id="card-title" class="card-title" tabindex="-1">${esc(title)}</h1></header>
<div class="card-message">${html}</div>`;
  card.setAttribute('aria-busy', 'false');
}

function renderFromHash({ focus = false } = {}) {
  const h = readHash();
  if (h.error) {
    app.current = null;
    renderMessage('That link does not name a drug', `<p>${esc(h.error)}</p><p><a href="${esc(hashFor(app.build.default.drug, app.build.default.qty))}">Open ${esc(app.build.default.drug)}</a> or search above.</p>`);
    return;
  }
  const product = app.byName.get(h.drug);
  if (!product) {
    app.current = null;
    renderMessage(
      'No drug by that name',
      `<p>This week’s NADAC file has no product named “${esc(h.drug)}”. NADAC names change when CMS updates a description, so an old link can stop working.</p><p>Search for it above, or <a href="${esc(hashFor(app.build.default.drug, app.build.default.qty))}">open ${esc(app.build.default.drug)}</a>.</p>`,
    );
    if (focus) $('card-title').focus();
    return;
  }
  let qty = h.qty;
  if (qty === null || qty === undefined) {
    const dq = summaryWithoutQty(product).default_quantity;
    qty = String(dq.qty);
  }
  qty = qty.trim();
  if (app.current && app.current.product === product && $('qty')) {
    app.current.qty = qty;
    const input = $('qty');
    if (document.activeElement !== input) input.value = qty;
    renderFigures();
    return;
  }
  app.current = { product, qty };
  renderCard({ focus });
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
  const hash = hashFor(app.current.product.name, app.current.qty);
  if (replaceHash(hash)) renderFigures();
}

function openProduct(name, { qty } = {}) {
  const product = app.byName.get(name);
  if (!product) return;
  const q = qty === undefined ? String(summaryWithoutQty(product).default_quantity.qty) : String(qty);
  const hash = hashFor(name, q);
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
  app.lastResults = [];
}

function resultItem(r, query) {
  const p = resultPrices(r.product);
  const ndcNote = r.match === 'ndc' ? `<span class="result-ndc mono">NDC ${esc(showNdc(r.matched))}</span>` : '';
  // Say which name matched only when the product's own name does not already show the query.
  const q = normalizeQuery(query);
  const own = normalizeQuery(r.product.name);
  const via = r.match !== 'ndc' && r.matched && r.matched !== r.product.name && !(q && own.includes(q)) ? `<span class="result-via">matched “${esc(r.matched)}”</span>` : '';
  return `<li><button type="button" class="result" data-name="${esc(r.product.name)}">
<span class="result-name">${esc(r.product.name)}</span>
<span class="result-meta"><span class="result-price mono">NADAC ${esc(p.text)}</span> ${chip(p.state)}</span>
${ndcNote}${via}
</button></li>`;
}

function runSearch(query) {
  const q = String(query || '');
  if (!q.trim()) {
    clearResults();
    return;
  }
  if (!app.index) return;
  const all = search(app.index, q, { limit: COUNT_LIMIT });
  const shown = all.slice(0, RESULT_LIMIT);
  app.lastResults = shown;
  $('results').innerHTML = shown.map((r) => resultItem(r, q)).join('');
  if (all.length) {
    const many = all.length >= COUNT_LIMIT ? `${formatCount(COUNT_LIMIT)} or more` : formatCount(all.length);
    $('search-status').textContent =
      all.length > shown.length
        ? `${many} drugs match “${q.trim()}”. Showing the first ${shown.length}; type more to narrow it down.`
        : `${many} drug${all.length === 1 ? '' : 's'} match${all.length === 1 ? 'es' : ''} “${q.trim()}”. Press Enter to open the first.`;
    $('search-help').innerHTML = '';
    return;
  }
  const ideas = suggest(app.index, q);
  const ndc = looksLikeNdc(q);
  const tried = ndc ? ndcCandidates(q).map(showNdc) : [];
  // The status region is read out: it carries the suggestion and the NDC explanation too.
  const said = [`No drug matches “${q.trim()}”.`];
  if (ideas.length) said.push(`Did you mean ${ideas.map((i) => i.query).join(' or ')}?`);
  if (ndc && tried.length) said.push(`No product in this week’s NADAC file has NDC ${tried.join(' or ')}.`);
  $('search-status').textContent = said.join(' ');
  $('search-help').innerHTML = `${
    ideas.length
      ? `<p>Did you mean ${ideas.map((i) => `<button type="button" class="suggest" data-query="${esc(i.query)}">${esc(i.query)}</button>`).join(' or ')}?</p>`
      : ''
  }${ndc && tried.length ? `<p>No product in this week’s NADAC file has NDC ${esc(tried.join(' or '))}. NADAC covers drugs its pharmacy survey prices; many NDCs are not in it.</p>` : ''}
<p class="hint">Try the generic name (for example “metformin” rather than a brand), fewer words, or the 10- or 11-digit NDC printed on the label.</p>`;
}

// ---------------------------------------------------------------------------------------------
// Events and startup

function bind() {
  const input = $('q');
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    // One or two letters match most of the list; wait a little longer before searching them.
    const wait = input.value.trim().length <= 2 ? 200 : 60;
    timer = setTimeout(() => runSearch(input.value), wait);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      runSearch(input.value);
      if (app.lastResults && app.lastResults.length) openProduct(app.lastResults[0].product.name);
    } else if (e.key === 'Escape') {
      clearResults();
    }
  });
  $('results').addEventListener('click', (e) => {
    const b = e.target.closest('button.result');
    if (b) openProduct(b.dataset.name);
  });
  $('search-help').addEventListener('click', (e) => {
    const b = e.target.closest('button.suggest');
    if (!b) return;
    input.value = b.dataset.query;
    runSearch(b.dataset.query);
    input.focus();
  });
  const card = $('card');
  card.addEventListener('click', (e) => {
    const b = e.target.closest('button.qty-chip');
    if (!b) return;
    const box = $('qty');
    if (box) box.value = b.dataset.qty;
    setQty(b.dataset.qty);
  });
  card.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'qty') setQty(e.target.value);
  });
  window.addEventListener('hashchange', () => {
    const h = readHash();
    if (!h.error && app.current && h.drug !== app.current.product.name) app.current = null;
    renderFromHash({ focus: true });
  });
}

function renderFatal(err) {
  const card = $('card');
  if (!card) return;
  const msg = err && err.message ? err.message : String(err);
  let report = REPO_URL + '/issues/new?template=bug.yml';
  try {
    report = issueUrl({ template: 'bug.yml', title: 'The page did not load', fields: { what_happened: msg, build_id: app.build ? app.build.build_id : '' } });
  } catch {
    // keep the plain link
  }
  card.innerHTML = `<header class="card-head"><h1 id="card-title" class="card-title">The data did not load</h1></header>
<div class="card-message"><p>${esc(msg)}</p><p>No figures are shown rather than wrong ones. <a href="${esc(report)}" target="_blank" rel="noopener">Report it</a>.</p></div>`;
  card.setAttribute('aria-busy', 'false');
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
    throw new Error('The inline data block is not in the format this page reads.');
  }
  if (typeof descriptor.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(descriptor.sha256)) {
    throw new Error('The inline data block has no checksum to check it against, so it is not used.');
  }
  // Chrome and Edge 80 to 102 have DecompressionStream but not its 'deflate-raw' format, and
  // throw a TypeError for it: the reader gets the same plain sentence either way.
  let inflater = null;
  try {
    inflater = typeof DecompressionStream === 'function' ? new DecompressionStream('deflate-raw') : null;
  } catch {
    inflater = null;
  }
  if (!inflater) throw new Error(CANNOT_UNPACK);
  const bin = atob(descriptor.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(inflater);
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  if (buf.length !== descriptor.json_bytes) {
    throw new Error(`The inline data unpacked to ${buf.length} bytes, not the ${descriptor.json_bytes} the build recorded.`);
  }
  const digest = await sha256Of(buf);
  if (digest !== descriptor.sha256) {
    throw new Error(`The inline data does not match its recorded checksum (sha256 ${digest.slice(0, 12)}…, expected ${descriptor.sha256.slice(0, 12)}…), so it may have been changed or damaged.`);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(buf);
}

async function start() {
  try {
    app.build = JSON.parse($('openbill-build').textContent);
    const t0 = performance.now();
    const text = await inflate(JSON.parse($('openbill-data').textContent));
    const t1 = performance.now();
    app.doc = unpackDrugs(JSON.parse(text));
    const t2 = performance.now();
    const rows = linkRows(app.doc);
    app.partDContext = partDNameContext(rows);
    app.products = groupProducts(rows);
    app.byName = new Map(app.products.map((p) => [p.name, p]));
    app.today = isoDate(new Date());
    bind();
    // The card first; the search index, which the card does not need, in a later task.
    renderFromHash({ focus: false });
    const t3 = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const t4 = performance.now();
    app.index = buildIndex(app.products);
    const input = $('q');
    input.disabled = false;
    if (input.value.trim()) runSearch(input.value);
    const t5 = performance.now();
    const root = document.documentElement;
    root.dataset.startupMs = String(Math.round(t3 - SCRIPT_START));
    root.dataset.timings = JSON.stringify({
      inflate_ms: Math.round(t1 - t0),
      unpack_ms: Math.round(t2 - t1),
      first_card_ms: Math.round(t3 - t2),
      first_card_since_navigation_ms: Math.round(t3),
      index_ms: Math.round(t5 - t4),
      since_navigation_ms: Math.round(t5),
    });
    root.dataset.ready = 'true';
  } catch (err) {
    renderFatal(err);
    document.documentElement.dataset.ready = 'error';
  }
}

start();
