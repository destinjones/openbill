// The static pages of the website (docs/ARCHITECTURE.md, "Drug pages"): one page per product,
// one per FDA pharmacologic class, an A–Z index, the preview-card markup and the sitemap.
// tools/site.mjs reads the files, calls these renderers and writes what they return.
//
// DOM-free and pure: no fs, no clock, no network. Every number comes from src/core (the same
// summarizeProduct() the interactive card uses), every value written into HTML goes through esc()
// (the html`` tag below escapes every interpolation that is not itself an html`` fragment), and
// the pages have no JavaScript: only a JSON-LD data block, which browsers do not run.

import { esc } from '../core/esc.js';
import { linkRows } from '../core/pack.js';
import { groupProducts } from '../core/search.js';
import { summarizeProduct, partDNameContext, defaultQuantity, freshness, inputDates, distinctLabelers, labelerKey, rangesByUnit, formatSpreadMultiple, HONESTY, RULES, COST_PLUS, COST_PLUS_CAVEATS, EXTREME_HEADLINE } from '../core/rules.js';
import { formatMoney, formatUnitPrice, formatCount, formatPercent } from '../core/money.js';
import { STATE_INFO, weakestState } from '../core/provenance.js';
import { formatNdc, isNdc11 } from '../core/ndc.js';
import { SOURCE_INFO, NADAC_EXPLANATION_CODES } from '../core/sources.js';
import { uniqueSlugs, siteSlugs } from '../core/slug.js';
import { epcClasses, classIndex, siblings, related, epcName, classStanding, SIBLING_LIMIT } from '../core/related.js';
import { SITE_URL, APP_NAME, REPO_URL } from '../core/config.js';
import { parsePeriod } from '../core/dates.js';
import { issueUrl } from '../core/report.js';
import { SECTIONS } from './methodology.js';

/** The CSP of every static page (docs/ARCHITECTURE.md): no script at all, styles and fonts from the site. */
export const SITE_CSP = "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'";

/** The showcase product (docs/ARCHITECTURE.md, "Showcase"): the site's own preview card. */
export const SHOWCASE = Object.freeze({ drug: 'ARIPIPRAZOLE 10 MG TABLET', qty: 30 });

/** Most related products linked from a drug page (the contract: up to 5). */
export const RELATED_LIMIT = 5;


/** NDCs listed openly on a drug page; more go inside a closed <details>. */
export const NDC_OPEN_LIMIT = 6;

/** The preview card's size in CSS pixels (rendered at device scale 1). */
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/**
 * Preview cards are PNG files: og/<slug>.png and og/site.png. JPEG was tried and measured larger
 * for these flat-colour text cards, so it was reverted (decision 48).
 */
export const OG_IMAGE_EXT = 'png';
export const OG_IMAGE_TYPE = 'image/png';

/** A preview card's path under the site root: ogImagePath('aripiprazole-10-mg-tablet') → 'og/aripiprazole-10-mg-tablet.png'. */
export function ogImagePath(slug) {
  return `og/${slug}.${OG_IMAGE_EXT}`;
}

/** Every path below the site root is two folders deep (drug/<slug>/, class/<slug>/, drugs/<letter>/). */
const UP = '../../';

const CALCULATION = 'OpenBill calculation';

// ---------------------------------------------------------------- tiny HTML builder

class Html {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}

function part(v) {
  if (v instanceof Html) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}

/** Template tag: every interpolation is escaped with esc(), except fragments made by html`` itself. */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += part(v) + strings[i + 1];
  });
  return new Html(out);
}

export function joinHtml(list, sep) {
  return new Html(list.map(part).join(sep));
}

// Links: relative paths inside the site, https:// pages, or a fragment. Anything else stops the build.
const HREF_RE = /^(?:https:\/\/[A-Za-z0-9.-]+(?:[/?#][^\s"<>`\\]*)?|#[A-Za-z0-9-]+|(?:\.\.\/)*(?:[a-z0-9][a-z0-9._-]*\/)*(?:[a-z0-9][a-z0-9._-]*)?(?:#[A-Za-z0-9=&%._~+!*'()-]*)?)$/;

function checkHref(href) {
  const h = String(href);
  if (!HREF_RE.test(h) || /^javascript:/i.test(h)) throw new Error(`drugpage: refusing link ${JSON.stringify(h)}`);
  return h;
}

export function link(href, text, attrs = '') {
  return html`<a href="${checkHref(href)}"${new Html(attrs)}>${text}</a>`;
}

/** Every methodology.html anchor a drug page links to (linkedAnchors(), checked by tools/site.mjs). */
const LINKED_ANCHORS = Object.freeze([
  'cost-plus',
  'honesty',
  'drug-pages',
  'source-nadac',
  'default-quantity',
  'explanation-codes',
  'limit-carried-forward',
  'reference-price',
  'join-part-d',
  'join-part-b',
  'source-partd',
  'source-asp_limits',
  'part-b-per-nadac-unit',
  'spread',
]);

/**
 * Links into methodology.html, where the explanations every drug page shares live, so a page
 * links to them instead of repeating them (decision 52): [[anchor, text]], nulls skipped.
 */
function methodLinks(list) {
  const items = list.filter(Boolean).map(([anchor, text]) => {
    if (!LINKED_ANCHORS.includes(anchor)) throw new Error(`drugpage: methodology.html#${anchor} is not in LINKED_ANCHORS`);
    return link(`${UP}methodology.html#${anchor}`, text);
  });
  return items.length ? html`<p class="more-link">${joinHtml(items, ' · ')}</p>` : '';
}

// ---------------------------------------------------------------- small text helpers

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Names in reading order, numbers by value: "… 2 MG TABLET" before "… 10 MG TABLET". */
function cmpNatural(a, b) {
  const pa = String(a).split(/(\d+(?:\.\d+)?)/);
  const pb = String(b).split(/(\d+(?:\.\d+)?)/);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const d = i % 2 ? Number(pa[i]) - Number(pb[i]) : cmp(pa[i], pb[i]);
    if (d) return d;
  }
  return pa.length - pb.length || cmp(a, b);
}

function uniqueCaseless(list) {
  const out = [];
  const seen = new Set();
  for (const s of list) {
    if (typeof s !== 'string' || !s.trim()) continue;
    const k = s.trim().toUpperCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s.trim());
    }
  }
  return out;
}

/** Each item in curly quotes, for FDA terms that contain commas ("tablet, film coated"). */
function quoted(xs) {
  return xs.map((x) => `“${x}”`);
}

/** End a sentence with one full stop, also after a name that ends in one ("Inc."). */
function sentenceEnd(text) {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** "a", "a and b", "a, b and c" */
function andList(xs) {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

function plural(n, one, many = `${one}s`) {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

function showNdc(ndc) {
  return isNdc11(ndc) ? formatNdc(ndc) : String(ndc);
}

function periodWords(period) {
  const p = parsePeriod(period);
  return p ? `${p.start} to ${p.end}` : '';
}

function yearOf(period) {
  const p = parsePeriod(period);
  if (!p) return null;
  return p.start.slice(0, 4) === p.end.slice(0, 4) && p.start.endsWith('-01-01') && p.end.endsWith('-12-31') ? p.start.slice(0, 4) : null;
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

/** "$0.11173 per EA", or "$0.10 to $0.12 per EA" across NDCs. */
function unitRange(range) {
  const a = formatUnitPrice(range.min.value);
  const b = formatUnitPrice(range.max.value);
  const per = range.units.length === 1 ? ` per ${range.units[0]}` : '';
  return a === b ? `${a}${per}` : `${a} to ${b}${per}`;
}

function unitGroups(groups) {
  return groups.map((g) => unitRange(g.range)).join('; ');
}

function multipleRange(range) {
  const a = formatSpreadMultiple(range.min.value);
  const b = formatSpreadMultiple(range.max.value);
  return a === b ? a : `${a} – ${b}`;
}

/** A displayed amount as a JSON-LD number ("$3.35" → 3.35); "<$0.01" stays text. */
function shownNumber(text) {
  const t = String(text).replace(/^\$/, '').replace(/,/g, '');
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : String(text);
}

export function chip(state) {
  const info = STATE_INFO[state];
  return html`<span class="chip chip-${state}">${info ? info.label : state}</span>`;
}

function staleChip() {
  return new Html('<span class="chip chip-stale">stale</span>');
}

export function honestyLine(id, { firstSentenceOnly = false } = {}) {
  const line = HONESTY.find((h) => h.id === id);
  if (!line) throw new Error(`HONESTY has no line ${id}`);
  const parts = firstSentenceOnly ? line.parts.filter((p) => p.strong).slice(0, 1) : line.parts;
  return joinHtml(
    parts.map((p) => (p.strong ? html`<strong>${p.text}</strong>` : html`${p.text}`)),
    '',
  );
}

export function honestyText(id, opts) {
  const line = HONESTY.find((h) => h.id === id);
  if (!line) throw new Error(`HONESTY has no line ${id}`);
  return opts && opts.firstSentenceOnly ? line.parts.filter((p) => p.strong)[0].text : line.text;
}

/**
 * The five honesty lines, verbatim from the owner's brief, introduced as what they are: the rules
 * OpenBill holds its pages to (as methodology.html introduces them), not instructions to the reader.
 */
export function honestyList() {
  return html`<p>${APP_NAME} holds every page to these five rules, written by the project’s owner and quoted word for word:</p>
<ul class="honesty">${joinHtml(
    HONESTY.map((h) => html`<li>${honestyLine(h.id)}</li>`),
    '\n',
  )}</ul>`;
}

/** The disclaimer, from HONESTY "disclaimer" without its "Disclaimer footer:" label (as build.js does). */
function disclaimerText() {
  const t = honestyText('disclaimer');
  const m = /^Disclaimer footer:\s*(.+)$/.exec(t);
  return m ? `Disclaimer: ${m[1]}` : t;
}

// ---------------------------------------------------------------- provenance lines (as on the card)

function isCalculated(rec) {
  return rec.source_name === CALCULATION;
}

/** "CMS NADAC · file.csv · eff. 2026-09-23 · as of 2026-10-14 · retrieved 2026-10-17" */
function provText(rec) {
  const bits = [rec.source_name, rec.source_file];
  const p = parsePeriod(rec.period);
  bits.push(p && p.start === rec.effective_date ? `eff. ${p.start} to ${p.end}` : `eff. ${rec.effective_date}${p ? ` (period ${p.start} to ${p.end})` : ''}`);
  if (rec.as_of_date) bits.push(`as of ${rec.as_of_date}`);
  bits.push(`retrieved ${rec.retrieved_date}`);
  return bits.join(' · ');
}

/** The source lines of a figure: one per distinct source file and dates; calculated records list each input's own date. */
export function provTexts(records, inputs) {
  const out = [];
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
      out.push(provText(recs[0]));
      continue;
    }
    const r = recs[0];
    const when = dates.length <= 3 ? dates.join(', ') : `between ${dates[0]} and ${dates[dates.length - 1]} (${formatCount(dates.length)} dates)`;
    const bits = [r.source_name, r.source_file, `eff. ${when}${r.period ? ` (period ${periodWords(r.period)})` : ''}`];
    if (r.as_of_date) bits.push(`as of ${r.as_of_date}`);
    bits.push(`retrieved ${r.retrieved_date}`);
    out.push(bits.join(' · '));
  }
  if (calc.length) {
    const files = [];
    for (const r of calc) for (const f of String(r.source_file).split(' + ')) if (!files.includes(f)) files.push(f);
    out.push([CALCULATION, files.join(' + '), ...(inputs || []).map((i) => i.text)].join(' · '));
  }
  return out;
}

function provLines(key, records, inputs) {
  return joinHtml(
    provTexts(records, inputs).map((t) => html`<p class="prov mono" data-prov="${key}">${t}</p>`),
    '\n',
  );
}

/** The caveats a calculated record's reason lists after "Estimated because:" (or "Caveats:"), verbatim. */
function caveatsOf(rec) {
  const reason = String((rec && rec.reason) || '');
  for (const m of ['Estimated because: ', 'Caveats: ']) {
    const at = reason.indexOf(m);
    if (at >= 0) {
      const rest = reason.slice(at + m.length).trim();
      const firstMatch = /^(.+?[.!?][”"’)]*)(?=\s+[A-Z0-9“"]|$)/.exec(rest);
      return { all: rest, first: firstMatch ? firstMatch[1] : rest };
    }
  }
  return { all: null, first: null };
}

const EXTREME_PHRASE = 'may not describe the same unit or product';

/** The extreme-gap caveat sentence ("At 0.05×, the Medicare figure is …"), or null. */
function extremeCaveat(rec) {
  const reason = String((rec && rec.reason) || '');
  const p = reason.indexOf(EXTREME_PHRASE);
  if (p < 0) return null;
  const start = reason.lastIndexOf('At ', p);
  const end = reason.indexOf('.', p + EXTREME_PHRASE.length);
  return start >= 0 ? reason.slice(start, end >= 0 ? end + 1 : undefined) : null;
}

/** "Derived because only one labeler …" from a derived spread's reason, or null. */
function derivedBasis(rec) {
  const m = /(Derived because .+?)\. Inputs:/.exec(String((rec && rec.reason) || ''));
  return m ? `${m[1]}.` : null;
}

// ---------------------------------------------------------------- the model

/**
 * The first character group of a name, for the A–Z pages: "a" … "z", or "0-9" for a name that
 * starts with a digit, "other" for anything else.
 * @param {string} name
 * @returns {string}
 */
export function letterOf(name) {
  const c = String(name).trim().charAt(0).toLowerCase();
  if (c >= 'a' && c <= 'z') return c;
  if (c >= '0' && c <= '9') return '0-9';
  return 'other';
}

function letterLabel(letter) {
  return letter === '0-9' ? '0–9' : letter === 'other' ? 'Other' : letter.toUpperCase();
}

/**
 * Everything the pages are rendered from, computed once from data/drugs.json:
 * linked rows, products (groupProducts), their slugs (siteSlugs: names that share a slug each
 * get a suffix from their own name; class slugs use uniqueSlugs, where a collision throws), the
 * Part D name context, the EPC class index and slugs, and
 * the A–Z letters. `dataDate` (ISO) is the date the page's data was last changed (git, or the NADAC
 * file date when history is unavailable); stale labels are judged on it, never on a clock.
 * @param {object} doc data/drugs.json, parsed
 * @param {{ dataDate?: string }} [opts]
 * @returns {object}
 */
export function buildModel(doc, opts = {}) {
  if (!doc || !Array.isArray(doc.rows) || !doc.sources || !doc.sources.nadac) throw new Error('buildModel needs data/drugs.json with rows and a nadac source');
  const rows = linkRows(doc);
  const products = groupProducts(rows);
  const slugs = siteSlugs(products.map((p) => p.name));
  const byName = new Map(products.map((p) => [p.name, p]));
  const classes = classIndex(products);
  const classSlugByName = uniqueSlugs([...classes.keys()].map(epcName));
  const classSlugs = new Map([...classes.keys()].map((k) => [k, classSlugByName.get(epcName(k))]));
  const letters = new Map();
  for (const p of products) {
    const l = letterOf(p.name);
    if (!letters.has(l)) letters.set(l, []);
    letters.get(l).push(p);
  }
  const letterOrder = [...letters.keys()].sort((a, b) => rankLetter(a) - rankLetter(b) || cmp(a, b));
  const dataDate = opts.dataDate || doc.sources.nadac.as_of_date;
  return {
    doc,
    rows,
    products,
    byName,
    slugs,
    partDContext: partDNameContext(rows),
    classes,
    classSlugs,
    letters,
    letterOrder,
    dataDate,
    facts: new Map(),
  };
}

function rankLetter(l) {
  return l === '0-9' ? 0 : l === 'other' ? 2 : 1;
}

function drugPath(model, name) {
  const slug = model.slugs.get(name);
  if (!slug) throw new Error(`no slug for ${JSON.stringify(name)}`);
  return `drug/${slug}/`;
}

function classPath(model, key) {
  const slug = model.classSlugs.get(key);
  if (!slug) throw new Error(`no class slug for ${JSON.stringify(key)}`);
  return `class/${slug}/`;
}

function letterPath(letter) {
  return `drugs/${letter}/`;
}

/** The app card for a product: "#drug=<name>&qty=<n>" on the site root. */
export function appHash(name, qty) {
  return `#drug=${encodeURIComponent(name)}${qty === undefined || qty === null ? '' : `&qty=${encodeURIComponent(String(qty))}`}`;
}

// ---------------------------------------------------------------- one product's facts

/** FDA's nonproprietary name when the NADAC name does not contain it ("naproxen sodium"), else null. */
function missingGenericName(f) {
  const generic = uniqueCaseless(f.s.names.nonproprietary).map((x) => x.toLowerCase());
  if (!generic.length) return null;
  const first = generic[0].split(/[\s,/-]+/)[0];
  if (!first || f.name.toLowerCase().includes(first)) return null;
  return generic[0];
}

/** "30 tablets", "1 patch", "1 unit (EA)", "15 mL", "1 g": dq is defaultQuantity(), whose form names the EA. */
function qtyWords(dq, qty, unit) {
  const n = formatCount(qty);
  if (unit === 'EA') {
    const one = dq.form ? dq.form.one : 'unit (EA)';
    const many = dq.form ? dq.form.many : 'units (EA)';
    return `${n} ${qty === 1 ? one : many}`;
  }
  if (unit === 'ML') return `${n} mL`;
  if (unit === 'GM') return `${n} g`;
  return `a quantity of ${n}`;
}

function staleList(model, s, sources) {
  return s.freshness_inputs
    .filter((f) => sources.includes(f.source) && SOURCE_INFO[f.source])
    .map((f) => ({ source: f.source, ...freshness(f.record, SOURCE_INFO[f.source], model.dataDate) }))
    .filter((f) => f.stale);
}

/**
 * The figures and words for one product, computed once: the summary from summarizeProduct() at the
 * product's starting quantity (defaultQuantity()), and the text every renderer shares, so the page,
 * its JSON-LD, its title and its preview card can never disagree.
 * @param {object} model buildModel()
 * @param {{ name: string, rows: object[] }} product
 * @returns {object}
 */
export function drugFacts(model, product) {
  if (model.facts.has(product.name)) return model.facts.get(product.name);
  const dq = defaultQuantity(product);
  const s = summarizeProduct(product.rows, dq.qty, { partDContext: model.partDContext });
  const qty = dq.qty;
  const qtyText = qtyWords(dq, qty, s.unit);
  const nadacAsOf = uniqueCaseless(s.nadac.records.map((r) => r.as_of_date || '')).sort().join(', ') || null;
  const nadacEff = [...new Set(s.nadac.records.map((r) => r.effective_date))].sort();

  const pharmacy = isMissing(s.pack)
    ? { kind: 'unit', text: unitGroups(s.nadac_by_unit), state: s.nadac.state, reason: s.pack.reason, records: s.nadac.records }
    : {
        kind: 'pack',
        text: moneyRange(s.pack.min, s.pack.max, s.pack.same),
        state: s.pack.min.state === s.pack.max.state ? s.pack.min.state : s.nadac.state,
        arith: `${formatCount(s.pack.qty)} × ${unitRange(s.nadac)}`,
        records: s.nadac.records,
      };

  let medicare;
  const ref = s.reference;
  if (isMissing(ref)) {
    medicare = { missing: true, reason: ref.reason };
  } else {
    const isB = ref.kind === 'part_b';
    const refPack = !isMissing(ref.pack) ? ref.pack : null;
    const period = periodWords(ref.range.min.period);
    medicare = {
      missing: false,
      kind: ref.kind,
      label: isB ? 'Medicare Part B pays' : 'Medicare Part D paid',
      text: refPack ? moneyRange(refPack.min, refPack.max, refPack.same) : unitRange(ref.range),
      unitText: unitRange(ref.range),
      perUnitOnly: !refPack,
      state: ref.range.state,
      period,
      year: yearOf(ref.range.min.period),
      arith: refPack ? `${formatCount(refPack.qty)} × ${unitRange(ref.range)}, ${isB ? 'Part B limit' : 'Part D average'}` : isB ? `Part B payment limit${period ? `, ${period}` : ''}` : `Part D average${period ? ` for ${period}` : ''}`,
      records: ref.range.records,
      inputs: ref.inputs,
      pack: refPack,
    };
  }

  let spread;
  if (isMissing(s.spread)) {
    spread = { missing: true, reason: isMissing(ref) ? 'There is no Medicare figure to compare with, so there is no spread.' : s.spread.reason };
  } else {
    const min = s.spread.range.min;
    const max = s.spread.range.max;
    const extreme = s.spread.extreme ? extremeCaveat(min) || extremeCaveat(max) : null;
    spread = {
      missing: false,
      text: multipleRange(s.spread.range),
      state: s.spread.state,
      extreme: s.spread.extreme,
      sentence: s.spread.sentence,
      extremeCaveat: extreme,
      caveats: caveatsOf(min),
      basis: s.spread.state === 'derived' ? derivedBasis(min) : null,
      nameOutliers: s.spread.name_outliers,
      records: s.spread.range.records,
      inputs: s.spread.inputs,
    };
  }

  let costPlus;
  if (isMissing(s.cost_plus)) {
    costPlus = { missing: true, reason: s.cost_plus.reason };
  } else {
    const cp = s.cost_plus;
    // The arithmetic exactly as costPlusEstimate() states it in the record's reason.
    const m = /: (\$[\d,]+\.\d\d) \+ (\$[\d,]+\.\d\d) \+ (\$[\d,]+\.\d\d) = (\$[\d,]+\.\d\d)/.exec(cp.min.reason);
    costPlus = {
      missing: false,
      text: moneyRange(cp.min, cp.max, cp.same),
      state: cp.min.state === cp.max.state ? cp.min.state : 'estimated',
      arith: cp.same && m ? `${m[1]} + ${m[2]} (${formatPercent(COST_PLUS.markup_pct)}) + ${m[3]} fee ${COST_PLUS.basis} = ${m[4]}` : `NADAC for the pack + ${formatPercent(COST_PLUS.markup_pct)} + ${formatMoney(COST_PLUS.fee_usd)} fee ${COST_PLUS.basis}`,
      records: cp.same ? [cp.min] : [cp.min, cp.max],
      inputs: inputDates([
        { label: 'NADAC', record: s.nadac.min },
        { label: 'NADAC', record: s.nadac.max },
      ]),
      feeMostly: cp.max.value < 2 * COST_PLUS.fee_usd,
    };
  }

  const f = {
    product,
    name: product.name,
    slug: model.slugs.get(product.name),
    path: drugPath(model, product.name),
    s,
    qty,
    qtyText,
    nadacAsOf,
    nadacEff,
    pharmacy,
    medicare,
    spread,
    costPlus,
    stale: {
      nadac: staleList(model, s, ['nadac']),
      medicare: isMissing(ref) ? [] : staleList(model, s, ref.kind === 'part_b' ? ['asp_limits', 'asp_crosswalk'] : ['partd']),
    },
    classes: epcClasses(product),
    // An oral tablet or capsule by FDA (or its NADAC name): the products that start at 30, a plain
    // one-month supply of a once-a-day medicine. Everything else priced per EA starts at 1
    // (defaultQuantity(), decision 48), so every title can quote the card's own pack total.
    oralSolid: Boolean(dq.form && dq.form.oral_solid),
    // A tablet or capsule that is swallowed, with no outlier FDA listing (eaForm().plain): the
    // page then needs no more than the one-month sentence; otherwise it gives the full reason
    // (sublingual and buccal tablets and films, an outlier NDC; decision 49).
    plainStart: Boolean(dq.form && dq.form.plain),
  };
  f.genericName = missingGenericName(f);
  model.facts.set(product.name, f);
  return f;
}

// ---------------------------------------------------------------- title, description

/**
 * The page title and meta description, from the page's own numbers.
 * @param {object} f drugFacts()
 * @returns {{ title: string, description: string }}
 */
export function drugMeta(f) {
  const ph = headlinePharmacy(f);
  // A long multi-ingredient name (a prenatal vitamin lists twenty) stays on the page, not in the title.
  const named = f.genericName && f.genericName.length <= TITLE_GENERIC_MAX && !f.genericName.includes(',') ? `${f.name} (${f.genericName})` : f.name;
  const base = `${named}: ${ph}`;
  const withSite = `${base} | ${APP_NAME}`;
  // Search results show about 60–70 characters: the name and the price come first, the site name
  // only when it fits.
  const title = withSite.length <= TITLE_TARGET ? withSite : base;
  const bits = [`${named}: ${ph.charAt(0).toUpperCase()}${ph.slice(1)} (CMS NADAC file of ${f.nadacAsOf}).`];
  if (f.medicare.missing) bits.push('Medicare figure: we don’t know yet.');
  else {
    bits.push(`${medicareHeadline(f)}${f.spread.missing ? '' : f.spread.extreme ? '; the two may not measure the same thing' : `; ${f.spread.text}, ${f.spread.state}`}.`);
    bits.push(honestyText('not-your-price', { firstSentenceOnly: true }));
  }
  if (!f.costPlus.missing) bits.push(`Cost-plus estimate ${f.costPlus.text}.`);
  return { title, description: bits.join(' ') };
}

/** Longest title that keeps " | OpenBill" (search results cut titles at about 60–70 characters). */
export const TITLE_TARGET = 70;

/** Longest FDA generic name added to a title or description (SEO-7). */
export const TITLE_GENERIC_MAX = 32;

/**
 * The line above the figures on the page's card and on its preview card, so the two never differ:
 * "For 30 tablets", or the per-unit line when the NDCs are priced in different units.
 */
export function quantityKicker(f) {
  return f.pharmacy.kind === 'unit' ? 'Per unit: no single pack total' : `For ${f.qtyText}`;
}

/** "pharmacies pay $3.35 for 30 tablets", "pharmacies pay $8,776.25 for 1 unit (EA)": the card's own pack total. */
export function headlinePharmacy(f) {
  if (f.pharmacy.kind !== 'pack') return `pharmacies pay ${f.pharmacy.text}`;
  return `pharmacies pay ${f.pharmacy.text} for ${f.qtyText}`;
}

/**
 * The Medicare figure as summaries word it. Part D is an average over every strength and form
 * sold under the name, so it says so ("Medicare Part D 2024 average, all strengths and forms:
 * $46.50 for 30 tablets").
 */
export function medicareHeadline(f) {
  const m = f.medicare;
  const amount = !m.pack ? m.unitText : `${m.text} for ${f.qtyText}`;
  if (m.kind === 'part_d') return `Medicare Part D ${m.year ? `${m.year} ` : ''}average, all strengths and forms: ${amount}`;
  return `Medicare Part B payment limit this quarter: ${amount}`;
}

// ---------------------------------------------------------------- the card (figures)

function figPharmacy(f) {
  const p = f.pharmacy;
  const stale = f.stale.nadac.length > 0;
  if (p.kind === 'unit') {
    return html`<section class="fig fig-pharmacy" aria-labelledby="fig-ph">
<h2 id="fig-ph" class="fig-label">Pharmacies pay</h2>
<p class="fig-value"><span class="amount amount-unit" data-figure="pharmacy">${p.text}</span> ${chip(p.state)}${stale ? html` ${staleChip()}` : ''}</p>
<p class="why">${p.reason}</p>
${provLines('pharmacy', p.records)}
</section>`;
  }
  return html`<section class="fig fig-pharmacy" aria-labelledby="fig-ph">
<h2 id="fig-ph" class="fig-label">Pharmacies pay</h2>
<p class="fig-value"><span class="amount" data-figure="pharmacy">${p.text}</span> ${chip(p.state)}${stale ? html` ${staleChip()}` : ''}</p>
<p class="arith mono">${p.arith}${f.s.pack.same ? '' : html`<span class="arith-note"> (the ${formatCount(f.s.counts.rows)} NDCs differ)</span>`}</p>
${provLines('pharmacy', p.records)}
</section>`;
}

function figMedicare(f) {
  const m = f.medicare;
  if (m.missing) {
    return html`<section class="fig fig-medicare fig-missing" aria-labelledby="fig-md">
<h2 id="fig-md" class="fig-label">Medicare</h2>
<p class="fig-value"><span class="unknown" data-figure="medicare">We don’t know yet</span></p>
<p class="why">${m.reason}</p>
</section>`;
  }
  const stale = f.stale.medicare.length > 0;
  return html`<section class="fig fig-medicare" aria-labelledby="fig-md">
<h2 id="fig-md" class="fig-label">${m.label}</h2>
<p class="fig-value"><span class="amount${m.perUnitOnly ? ' amount-unit' : ''}" data-figure="medicare">${m.text}</span> ${chip(m.state)}${stale ? html` ${staleChip()}` : ''}</p>
<p class="arith mono">${m.arith}</p>
<p class="not-yours">${honestyLine('not-your-price', { firstSentenceOnly: true })}</p>
${provLines('medicare', m.records, m.inputs)}
</section>`;
}

function figSpread(f) {
  const sp = f.spread;
  if (sp.missing) {
    return html`<section class="spread spread-missing" aria-labelledby="fig-sp">
<h2 id="fig-sp" class="fig-label">The spread</h2>
<p class="fig-value"><span class="unknown" data-figure="spread">We don’t know yet</span></p>
<p class="why">${sp.reason}</p>
</section>`;
  }
  const caveats = sp.extreme
    ? html`${sp.extremeCaveat ? html`<p class="caveat caveat-extreme">${sp.extremeCaveat}</p>` : ''}${sp.caveats.first && sp.caveats.first !== sp.extremeCaveat ? html`<p class="caveat">${sp.caveats.first}</p>` : ''}`
    : sp.caveats.first
    ? html`<p class="caveat">${sp.caveats.first}</p>`
    : sp.basis
    ? html`<p class="caveat">${sp.basis}</p>`
    : '';
  return html`<section class="spread${sp.extreme ? ' spread-extreme' : ''}" aria-labelledby="fig-sp">
<h2 id="fig-sp" class="fig-label">The spread</h2>
<p class="fig-value"><span class="multiple" data-figure="spread">${sp.text}</span> ${chip(sp.state)}</p>
<p class="spread-sentence${sp.extreme ? ' spread-headline' : ''}">${sp.sentence}</p>
${caveats}
${provLines('spread', sp.records, sp.inputs)}
</section>`;
}

function figCostPlus(f) {
  const c = f.costPlus;
  if (c.missing) {
    return html`<section class="fig fig-costplus fig-missing" aria-labelledby="fig-cp">
<h2 id="fig-cp" class="fig-label">Cost-plus estimate</h2>
<p class="fig-value"><span class="unknown" data-figure="cost-plus">We don’t know yet</span></p>
<p class="why">${c.reason}</p>
</section>`;
  }
  return html`<section class="fig fig-costplus" aria-labelledby="fig-cp">
<h2 id="fig-cp" class="fig-label">Cost-plus estimate</h2>
<p class="fig-value"><span class="amount" data-figure="cost-plus">${c.text}</span> ${chip(c.state)}</p>
<p class="arith mono">${c.arith}</p>
<p class="why">${COST_PLUS_CAVEATS[0]} Shipping is not included.${c.feeMostly ? ` For a pack this cheap, the ${formatMoney(COST_PLUS.fee_usd)} fee is most of the estimate.` : ''} ${link(`${UP}methodology.html#cost-plus`, 'How it is worked out')}</p>
${provLines('cost-plus', c.records, c.inputs)}
</section>`;
}

function cardHtml(f) {
  return html`<section class="card" aria-label="The figures">
<p class="card-kicker">${quantityKicker(f)}</p>
${figPharmacy(f)}
${figMedicare(f)}
<hr class="rule">
${figSpread(f)}
${figCostPlus(f)}
<p class="card-cta">${link(`${UP}${appHash(f.name, f.qty)}`, 'Open the interactive card', ' class="button"')} <span class="why">Change the quantity, type what you were charged, and see every record in full.</span></p>
</section>`;
}

// ---------------------------------------------------------------- the prose

function labelerNames(product) {
  const dl = distinctLabelers(product.rows.map((r) => r.identity && r.identity.labeler).filter((x) => typeof x === 'string' && x.trim()));
  return dl ? dl.map((l) => l.name) : [];
}

function rateClassWords(s) {
  const rc = s.rate_classes;
  if (rc.length === 1 && rc[0] === 'G') return 'as a generic drug (rate-setting class G)';
  if (rc.length === 1 && rc[0] === 'B') return 'as a brand-name drug (rate-setting class B)';
  if (rc.length === 1) return `in its brand rate-setting class ${rc[0]}`;
  return `under the rate-setting classes ${andList(rc)}, depending on the NDC`;
}

function whatItIs(f) {
  const { product, s } = f;
  const out = [];
  const listed = product.rows.filter((r) => r.identity);
  const n = s.counts.rows;
  if (!listed.length) {
    out.push(
      `${s.name} is how the CMS NADAC file names this product. The FDA NDC Directory does not list ${n === 1 ? 'its NDC' : 'any of its NDCs'} as a package of its own, so OpenBill has no FDA names, dosage form or pharmacologic class for it.`,
    );
  } else {
    const generic = uniqueCaseless(s.names.nonproprietary).map((x) => x.toLowerCase());
    const brands = uniqueCaseless(s.names.proprietary).filter((p) => !generic.includes(p.toLowerCase()));
    const genericText = generic.length === 1 ? generic[0] : generic.length ? `${andList(quoted(generic))}, as its NDCs’ listings variously write the nonproprietary name` : 'a product with no nonproprietary name';
    out.push(
      `${s.name} is how the CMS NADAC file names this product. The FDA NDC Directory lists it as ${genericText}${brands.length ? `, under the trade name${brands.length > 1 ? 's' : ''} ${andList(quoted(brands))}` : ''}.`,
    );
    const forms = uniqueCaseless(listed.map((r) => r.identity.dosage_form)).map((x) => x.toLowerCase());
    const routes = uniqueCaseless(listed.map((r) => r.identity.route)).map((x) => x.toLowerCase());
    const formText = forms.length ? `its dosage form as ${forms.length === 1 ? forms[0] : andList(quoted(forms))}` : null;
    const routeText = routes.length ? `its route as ${routes.length === 1 ? routes[0] : andList(quoted(routes))}` : null;
    if (formText || routeText) out.push(`FDA gives ${[formText, routeText].filter(Boolean).join(' and ')}.`);
    const labelers = labelerNames(product);
    if (labelers.length === 1) out.push(sentenceEnd(`The labeler, the company named on the label, is ${labelers[0]}`));
    else if (labelers.length > 1 && labelers.length <= 3) out.push(sentenceEnd(`Its labelers, the companies named on the label, are ${andList(labelers)}`));
    else if (labelers.length > 3) out.push(sentenceEnd(`FDA lists ${formatCount(labelers.length)} labelers (the companies named on the label) for its NDCs, among them ${andList(labelers.slice(0, 3))}`));
    const classes = f.classes;
    if (classes.length === 1) out.push(`FDA’s Established Pharmacologic Class for it is ${classes[0].name}.`);
    else if (classes.length > 1) out.push(`FDA lists it under ${formatCount(classes.length)} Established Pharmacologic Classes: ${andList(classes.map((c) => c.name))}.`);
    else out.push('FDA lists no Established Pharmacologic Class for it.');
  }
  const listedText = listed.length && listed.length < n ? `; the FDA directory lists ${formatCount(listed.length)} of them` : '';
  out.push(
    n === 1
      ? `The NADAC file of ${f.nadacAsOf} prices it under one NDC (National Drug Code), ${showNdc(s.ndcs[0])}.`
      : `The NADAC file of ${f.nadacAsOf} prices it under ${formatCount(n)} NDCs (National Drug Codes)${listedText}.`,
  );
  const otc = s.otc === true ? ', and marks it as sold over the counter' : s.otc === false ? ', and does not mark it as sold over the counter' : ', and marks some of its NDCs as sold over the counter and some not';
  out.push(`NADAC classes it ${rateClassWords(s)}${otc}.`);
  return out;
}

function carriedSentence(s) {
  const n = s.counts.carried_forward;
  if (!n) return null;
  const cf = s.per_ndc.filter((x) => x.row.carried_forward);
  const dates = [...new Set(cf.map((x) => x.nadac.effective_date))].sort();
  const all = n === s.counts.rows;
  const who = all ? (n === 1 ? 'This NDC’s NADAC' : `The NADAC of all ${formatCount(n)} NDCs`) : `The NADAC of ${formatCount(n)} of these ${formatCount(s.counts.rows)} NDCs`;
  const when = dates.length <= 3 ? dates.join(', ') : `between ${dates[0]} and ${dates[dates.length - 1]}`;
  return `${who} was carried forward from an earlier file (NADAC explanation code 2 or 4), not newly surveyed: ${n === 1 ? 'it took' : 'those prices took'} effect on ${when}. The file is new; the price is not.`;
}

function pharmacySentence(f) {
  const s = f.s;
  const eff = f.nadacEff.length === 1 ? `that price took effect on ${f.nadacEff[0]}` : `those prices took effect between ${f.nadacEff[0]} and ${f.nadacEff[f.nadacEff.length - 1]}`;
  if (f.pharmacy.kind === 'unit') {
    return `Pharmacies pay ${f.pharmacy.text} for it, depending on the NDC, by the CMS NADAC file of ${f.nadacAsOf}; ${eff}.`;
  }
  const exact = s.pack.same ? ` (${formatCount(s.pack.qty)} × ${unitPrice(s.nadac.min)}, rounded to the cent)` : `, depending on the NDC (${unitRange(s.nadac)})`;
  return `Pharmacies pay ${f.pharmacy.text} for ${f.qtyText}${exact}, by the CMS NADAC file of ${f.nadacAsOf}; ${eff}.`;
}

// What NADAC measures, why the page starts where it does (for a plain tablet or capsule), the
// explanation codes and carried-forward prices are the same for every page, so the section links
// to them on methodology.html (decision 52); what is particular to this product stays.
function whatPharmaciesPay(f) {
  const s = f.s;
  const out = [`${pharmacySentence(f)} That is what pharmacies pay their suppliers, not what they charge you.`];
  if (f.pharmacy.kind === 'unit') out.push(`There is no single total for a pack: ${f.pharmacy.reason}`);
  const codes = s.explanation_codes.filter((c) => NADAC_EXPLANATION_CODES[c]);
  if (codes.length) out.push(`NADAC’s explanation code${codes.length > 1 ? 's' : ''} for it: ${codes.map((c) => `${c}, ${NADAC_EXPLANATION_CODES[c]}`).join('; ')}.`);
  const carried = carriedSentence(s);
  if (carried) out.push(carried);
  return out;
}

function pharmacyLinks(f) {
  return methodLinks([
    ['source-nadac', 'What NADAC measures'],
    f.pharmacy.kind === 'pack' && f.plainStart ? ['default-quantity', `Why ${f.qtyText}`] : null,
    f.s.explanation_codes.length ? ['explanation-codes', 'NADAC explanation codes'] : null,
    f.s.counts.carried_forward ? ['limit-carried-forward', 'Carried-forward prices'] : null,
  ]);
}

/**
 * When the product's NADAC prices took effect, for a product priced under several dates: one
 * item per date, with its NDCs, how many were carried forward from an earlier file, and their
 * prices (filed records, with the state). [] for one date.
 */
function priceDates(f) {
  if (f.nadacEff.length < 2) return [];
  return f.nadacEff
    .slice()
    .reverse()
    .map((date) => {
      const at = f.s.per_ndc.filter((x) => x.nadac.effective_date === date);
      const cf = at.filter((x) => x.row.carried_forward).length;
      const groups = rangesByUnit(at.map((x) => x.nadac));
      return html`<li><span class="mono">${date}</span> · ${plural(at.length, 'NDC')}${cf ? `, ${cf === at.length ? (cf === 1 ? 'carried forward' : 'all carried forward') : `${formatCount(cf)} carried forward`} from an earlier file` : ''} · <span class="mono">${unitGroups(groups)}</span> ${chip(weakestState(groups.map((g) => g.range.state)))}</li>`;
    });
}

/**
 * The companies behind the product's NDCs, for a product with more NDCs than NDC_OPEN_LIMIT:
 * one row per labeler (spellings of one company's name counted once, labelerKey), its NDCs and
 * what pharmacies pay per unit for them.
 */
function labelerTable(f) {
  const groups = new Map();
  for (const x of f.s.per_ndc) {
    const raw = x.row.identity && typeof x.row.identity.labeler === 'string' ? x.row.identity.labeler.trim() : '';
    const k = raw ? labelerKey(raw) : '';
    if (!groups.has(k)) groups.set(k, { name: raw || 'Not listed as a package in the FDA directory', listed: Boolean(raw), recs: [] });
    groups.get(k).recs.push(x.nadac);
  }
  const rows = [...groups.values()].sort((a, b) => b.listed - a.listed || b.recs.length - a.recs.length || cmp(a.name, b.name));
  const body = rows.map((g) => {
    const r = rangesByUnit(g.recs);
    return html`<tr><th scope="row">${g.name}</th><td class="num">${formatCount(g.recs.length)}</td><td><span class="mono">${unitGroups(r)}</span> ${chip(weakestState(r.map((x) => x.range.state)))}</td></tr>`;
  });
  return html`<h3>${rows.length === 1 ? 'The labeler' : `The ${formatCount(rows.filter((g) => g.listed).length)} labelers`}</h3>
<table class="compare">
<thead><tr><th scope="col">Labeler</th><th scope="col" class="num">NDCs</th><th scope="col">Pharmacies pay per unit</th></tr></thead>
<tbody>
${joinHtml(body, '\n')}
</tbody>
</table>`;
}

function partDNamesOf(f) {
  const ndcs = new Set(f.s.reference.ndcs || []);
  const pd = f.product.rows.find((r) => ndcs.has(r.ndc) && r.part_d);
  if (!pd) return null;
  return uniqueCaseless([pd.part_d.brand_name, pd.part_d.generic_name]);
}

function claimsRecord(f) {
  let best = null;
  for (const r of f.product.rows) {
    const c = r.part_d && r.part_d.claims;
    if (c && c.kind === 'count' && (!best || c.value > best.value)) best = c;
  }
  return best;
}

function medicareSentence(f) {
  const m = f.medicare;
  if (m.missing) return `We don’t know yet. ${m.reason}`;
  if (m.kind === 'part_d') {
    const names = partDNamesOf(f);
    const what = names ? andList(names.map((x) => `“${x}”`)) : 'its Part D name';
    const pack = m.pack ? `${m.text} for ${f.qtyText}, at an average of ${m.unitText}` : `an average of ${m.unitText}`;
    const when = m.year ? `in ${m.year} (${m.period})` : `for ${m.period}`;
    return `Medicare Part D paid ${pack} ${when} for ${what}, every strength and form sold under that name together (Medicare Part D Spending by Drug, file of ${m.records[0].as_of_date || m.records[0].effective_date}).`;
  }
  const codes = uniqueCaseless(f.product.rows.filter((r) => r.part_b).map((r) => r.part_b.hcpcs));
  const pack = m.pack ? `${m.text} for ${f.qtyText}, or ${m.unitText}` : m.unitText;
  return `Medicare Part B’s payment limit for HCPCS ${andList(codes)}, for ${m.period}, comes to ${pack} once converted to NADAC’s unit for this product.`;
}

// The Medicare figure in words. Why its comparison with NADAC is estimated is the FAQ's question,
// not repeated here, and a missing figure's reason is on the card, not repeated either (decision 52).
function whatMedicarePaid(f) {
  const m = f.medicare;
  const s = f.s;
  const out = [];
  if (m.missing) {
    out.push('We don’t know yet; the card above says why.');
    return out;
  }
  out.push(medicareSentence(f));
  if (m.kind === 'part_d') {
    const claims = claimsRecord(f);
    if (claims) out.push(`That average covers ${formatCount(claims.value)} Part D claims (fills, including refills) for ${claims.period ? periodWords(claims.period) : 'the data year'}, across every maker, strength and form under the name.`);
  } else {
    for (const note of s.reference.setting_notes) out.push(note);
    if (s.coinsurance) {
      const pcts = uniqueCaseless(f.product.rows.filter((r) => r.part_b && r.part_b.coinsurance_pct).map((r) => formatPercent(r.part_b.coinsurance_pct.value)));
      out.push(`The patient’s share under Part B (coinsurance${pcts.length ? `, ${andList(pcts)} of the limit` : ''}, before deductibles and other coverage) is ${unitRange(s.coinsurance)}.`);
    }
  }
  if (s.reference.without.length) {
    out.push(`${formatCount(s.reference.ndcs.length)} of the product’s ${formatCount(s.counts.rows)} NDCs have this Medicare figure; the other ${formatCount(s.reference.without.length)} do not, and the interactive card says why for each.`);
  }
  return out;
}

function medicareLinks(f) {
  const m = f.medicare;
  if (m.missing) return methodLinks([['reference-price', 'Which Medicare figure OpenBill compares'], ['join-part-d', 'How Part D is matched'], ['join-part-b', 'How Part B is matched']]);
  return methodLinks([
    m.kind === 'part_d' ? ['source-partd', 'What Part D spending measures'] : ['source-asp_limits', 'What the Part B payment limit is'],
    m.kind === 'part_b' ? ['part-b-per-nadac-unit', 'Converting it to the NADAC unit'] : ['reference-price', 'Which Medicare figure OpenBill compares'],
    f.spread.missing ? null : ['spread', 'How the spread is worked out'],
  ]);
}

/** The caveats the card shows under the spread (figSpread), so the FAQ does not repeat them. */
function spreadCaveatsShown(sp) {
  if (sp.extreme) return [sp.extremeCaveat, sp.caveats.first].filter(Boolean);
  if (sp.caveats.first) return [sp.caveats.first];
  return sp.basis ? [sp.basis] : [];
}

/**
 * The reasons an estimated spread is estimated that the card does not show, verbatim from the
 * spread record's reason; null when there are none (decision 52).
 */
function spreadAnswer(f) {
  const sp = f.spread;
  if (sp.missing || sp.state !== 'estimated' || !sp.caveats.all) return null;
  let rest = sp.caveats.all;
  for (const shown of spreadCaveatsShown(sp)) rest = rest.replace(shown, ' ');
  rest = rest.replace(/\s+/g, ' ').trim();
  return rest ? `Beyond what the card shows, the records give these reasons: ${rest}` : null;
}

// Generic siblings that match the product exactly by FDA: the same set of dosage forms
// ("TABLET, EXTENDED RELEASE" is not "TABLET"; only a coating, "TABLET, FILM COATED", is set
// aside, since labelers of one generic list it both ways), routes and strengths (the strength
// carries the concentration: "100 [iU]/mL" is not "300 [iU]/mL"), read from the NDCs of each
// product that have an FDA identity. Only such a product is named as an example of a generic
// version; a near match (another strength, release form or concentration) is not, since naming it
// would suggest a switch.
const MATCH_KEYS = ['dosage_form', 'route', 'strength'];

function matchValue(key, v) {
  const t = v.replace(/\s+/g, ' ').trim().toUpperCase();
  return key === 'dosage_form' ? t.replace(/, (FILM |SUGAR )?COATED\b/g, '') : t;
}

function identitySet(p, key) {
  const listed = p.rows.filter((r) => r.identity);
  if (!listed.length) return null;
  const vals = listed.map((r) => r.identity[key]);
  if (vals.some((v) => typeof v !== 'string' || !v.trim())) return null;
  return [...new Set(vals.map((v) => matchValue(key, v)))].sort().join(' | ');
}

// FDA's fields alone miss some differences (FDA lists GRALISE ER as "TABLET, FILM COATED", like
// immediate-release gabapentin; insulin mixes share one strength string), so NADAC's own names
// must agree too: both or neither mark a modified release, and every number in the product's name
// appears in the generic's ("HUMALOG MIX 50-50" is not "INSULIN LISPRO MIX 75-25").
const RELEASE_RE = /\b(ER|XR|SR|CR|XL|DR|LA|CD|ODT|\d+ ?HRS?)\b/;

function nameNumbers(name) {
  return new Set(String(name).match(/\d+(?:\.\d+)?/g) || []);
}

// The device a NADAC name states, which FDA's dosage form does not (a pen and a vial are both
// "INJECTION, SOLUTION"): both names must state the same one, or neither.
function presentation(name) {
  const n = String(name).toUpperCase();
  if (/\b(KWIKPEN|KWKPN|PEN|PENS|FLEXPEN|FLEXTOUCH|SOLOSTAR|AUTOINJECTOR|AUTO-INJECTOR)\b/.test(n)) return 'pen';
  if (/\b(VIAL|VL)\b/.test(n)) return 'vial';
  if (/\b(CARTRIDGE|CART)\b/.test(n)) return 'cartridge';
  if (/\b(SYRINGE|SYRG|SYR)\b/.test(n)) return 'syringe';
  return null;
}

export function exactGenericSiblings(product, sibs) {
  const want = MATCH_KEYS.map((k) => identitySet(product, k));
  if (want.some((x) => x === null)) return [];
  const release = RELEASE_RE.test(product.name);
  const numbers = nameNumbers(product.name);
  const device = presentation(product.name);
  return sibs.filter(
    (p) =>
      p !== product &&
      p.rows.length > 0 &&
      p.rows.every((r) => r.rate_class === 'G') &&
      MATCH_KEYS.every((k, i) => identitySet(p, k) === want[i]) &&
      RELEASE_RE.test(p.name) === release &&
      presentation(p.name) === device &&
      [...numbers].every((n) => nameNumbers(p.name).has(n)),
  );
}

function askAtCounter(f, sibs) {
  const s = f.s;
  const out = [];
  out.push(
    f.pharmacy.kind === 'pack'
      ? `What is your cash price for ${f.qtyText}? Is it lower than what I would pay through my insurance?`
      : 'What is your cash price for the amount I was prescribed? Is it lower than what I would pay through my insurance?',
  );
  if (!s.nadac.same && s.nadac.units.length === 1) out.push(`Which NDC (the 11-digit number on the package) is this? Pharmacies pay ${unitRange(s.nadac)} for this product, depending on the NDC.`);
  const isBrand = s.rate_classes.some((rc) => rc !== 'G');
  const generics = isBrand ? exactGenericSiblings(f.product, sibs) : [];
  if (generics.length) out.push(`Is a generic version available, and would it suit me? NADAC lists a generic with the same ingredient, strength and dosage form by FDA: ${generics[0].name}. Ask your pharmacist or prescriber; do not switch on your own.`);
  if (s.otc === true) out.push('It is sold over the counter, so shelf prices vary from store to store: what does it cost per unit here?');
  if (s.unit === 'ML' || s.unit === 'GM') out.push(`How much is in the package I am getting? This page uses ${f.qtyText}; your package may hold a different amount.`);
  if (!f.medicare.missing) {
    out.push(
      f.medicare.kind === 'part_d'
        ? 'If you have Medicare Part D: what is my plan’s copay or coinsurance for it? The Part D average on this page is not what you pay.'
        : 'If you have Medicare Part B: is this drug covered for me in this setting, and what is my share?',
    );
  }
  out.push('These are questions about price, not medical advice. Do not change or stop a medicine without talking to your prescriber or pharmacist.');
  return out;
}

/**
 * The questions the rest of the page does not already answer (decision 52): why the comparison
 * with Medicare is estimated, beyond the reason the card shows (from the spread records' own
 * reasons), and why the page starts at its quantity when that is not a plain tablet or capsule
 * supply. Each answer is the page's own visible text, and its FAQPage JSON-LD; a page with
 * neither has no FAQ.
 */
function faqItems(f) {
  const items = [];
  const spread = spreadAnswer(f);
  if (spread) items.push({ q: `Why is the comparison with Medicare for ${f.name} labelled estimated?`, a: spread });
  if (f.pharmacy.kind === 'pack' && !f.plainStart) items.push({ q: `Why does this page start at ${f.qtyText}?`, a: f.s.default_quantity.reason });
  return items;
}

// ---------------------------------------------------------------- shared page parts

export function headHtml({ title, description, canonical, ogImage, ogAlt, type = 'website', up = UP }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${SITE_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${up}assets/site.css">
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="${APP_NAME}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${ogImage}">
<meta property="og:image:type" content="${OG_IMAGE_TYPE}">
<meta property="og:image:width" content="${String(OG_WIDTH)}">
<meta property="og:image:height" content="${String(OG_HEIGHT)}">
<meta property="og:image:alt" content="${ogAlt}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${ogImage}">
<meta name="twitter:image:alt" content="${ogAlt}">
`;
}

function jsonLd(graph) {
  const text = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 1).replace(/</g, '\\u003c');
  return new Html(`<script type="application/ld+json">\n${text}\n</script>\n`);
}

export function masthead(model, up = UP) {
  return html`<header class="masthead">
<a class="stamp" href="${up}" aria-label="${APP_NAME} drug price receipt, home"><span class="stamp-name">${APP_NAME}</span><span class="stamp-sub">drug price receipt</span></a>
<p class="mono masthead-line">NADAC week of ${model.doc.sources.nadac.as_of_date}</p>
</header>`;
}

export function crumbs(list) {
  const items = list.map((c, i) =>
    i === list.length - 1 ? html`<li aria-current="page">${c.name}</li>` : html`<li>${link(c.href, c.name)}</li>`,
  );
  return html`<nav class="crumbs" aria-label="Breadcrumb"><ol>${joinHtml(items, '')}</ol></nav>`;
}

function breadcrumbLd(list) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: list.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.url })),
  };
}

export function sourceList(model) {
  const order = ['nadac', 'fda_ndc', 'partd', 'asp_limits', 'asp_crosswalk'];
  const ids = [...order.filter((k) => model.doc.sources[k]), ...Object.keys(model.doc.sources).filter((k) => !order.includes(k)).sort()];
  return joinHtml(
    ids.map((id) => {
      const s = model.doc.sources[id];
      const bits = [s.source_file, s.period ? `period ${periodWords(s.period)}` : null, s.as_of_date ? `as of ${s.as_of_date}` : null, `retrieved ${s.retrieved_date}`].filter(Boolean);
      const label = s.name || (SOURCE_INFO[id] && SOURCE_INFO[id].label) || id;
      return /^https:\/\//.test(String(s.source_url))
        ? html`<li>${link(s.source_url, label, ' rel="noopener"')} <span class="mono">${bits.join(' · ')}</span></li>`
        : html`<li>${label} <span class="mono">${bits.join(' · ')}</span></li>`;
    }),
    '\n',
  );
}

export function footer(model, up = UP) {
  return html`<footer class="site-footer">
<p class="disclaimer">${disclaimerText()}</p>
<p>${honestyLine('range')}</p>
<h2 class="footer-head">Sources in this build</h2>
<ul class="footer-sources">
${sourceList(model)}
</ul>
<ul class="footer-links">
<li>${link(up, 'OpenBill: search any drug')}</li>
<li>${link(`${up}${letterPath(model.letterOrder.includes('a') ? 'a' : model.letterOrder[0])}`, 'Drugs A–Z')}</li>
<li>${link(`${up}methodology.html`, 'Methodology')}</li>
<li>${link(`${up}press/`, 'Press kit')}</li>
<li>${link(REPO_URL, 'Source code on GitHub', ' rel="noopener"')}</li>
<li>${link(`${up}data/drugs.json`, 'data/drugs.json', ' rel="nofollow"')}</li>
</ul>
<p class="mono build-line">Static page, no JavaScript. Data changed ${model.dataDate}.</p>
</footer>`;
}

export function page({ head, body, ld }) {
  return `${head}${ld}</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

function letterNav(model, current) {
  return html`<nav class="letters" aria-label="Drugs A–Z"><ul>${joinHtml(
    model.letterOrder.map((l) =>
      l === current ? html`<li><span aria-current="page">${letterLabel(l)}</span></li>` : html`<li>${link(`${UP}${letterPath(l)}`, letterLabel(l))}</li>`,
    ),
    '',
  )}</ul></nav>`;
}

/** One product in a list: its name, what pharmacies pay per unit, the date and the state. */
function productItem(model, product) {
  const f = drugFacts(model, product);
  const groups = f.s.nadac_by_unit;
  return html`<li>${link(`${UP}${f.path}`, product.name)} <span class="item-meta"><span class="mono">${unitGroups(groups)} · eff. ${f.nadacEff.length === 1 ? f.nadacEff[0] : `${f.nadacEff[0]} to ${f.nadacEff[f.nadacEff.length - 1]}`}</span> ${chip(f.s.nadac.state)}${f.medicare.missing ? '' : html` <span class="item-flag">Medicare figure</span>`}</span></li>`;
}

function listSource(model) {
  const n = model.doc.sources.nadac;
  return html`<p class="prov mono" data-prov="list">Prices per unit: CMS NADAC · ${n.source_file} · as of ${n.as_of_date} · retrieved ${n.retrieved_date}. Classes: FDA NDC Directory · ${model.doc.sources.fda_ndc ? `${model.doc.sources.fda_ndc.source_file} · as of ${model.doc.sources.fda_ndc.as_of_date}` : 'not in this build'}.</p>`;
}

// ---------------------------------------------------------------- drug page

function ndcList(f) {
  const items = f.s.per_ndc.map((x) => {
    const lab = x.row.identity ? x.row.identity.labeler : 'not listed as a package in the FDA directory';
    return html`<li><span class="mono">${showNdc(x.ndc)}</span> · ${lab} · <span class="mono">${unitPrice(x.nadac)} · eff. ${x.nadac.effective_date}</span> ${chip(x.nadac.state)}${x.row.carried_forward ? html` <span class="item-flag">carried forward</span>` : ''}</li>`;
  });
  const listHtml = html`<ul class="ndc-list">${joinHtml(items, '\n')}</ul>`;
  if (items.length <= NDC_OPEN_LIMIT) return html`<h3>${items.length === 1 ? 'The NDC' : `All ${formatCount(items.length)} NDCs`}</h3>\n${listHtml}`;
  const dates = priceDates(f);
  return html`${labelerTable(f)}
${dates.length ? html`<h3>When these prices took effect</h3>
<ul class="ndc-list">${joinHtml(dates, '\n')}</ul>` : ''}
<details class="ndcs"><summary>All ${formatCount(items.length)} NDCs, with labeler and price</summary>\n${listHtml}\n</details>`;
}

function formsOf(p) {
  return uniqueCaseless(p.rows.filter((r) => r.identity).map((r) => r.identity.dosage_form)).map((x) => x.toLowerCase());
}

function versionWords(s) {
  const rc = s.rate_classes;
  return rc.every((x) => x === 'G') ? 'generic' : rc.every((x) => x !== 'G') ? 'brand' : 'brand and generic';
}

/** "Part D 2024 average", "Part B limit 2026 Q4": what a Medicare figure in a table row is. */
function medicareShort(m) {
  if (m.kind === 'part_d') return `Part D ${m.year ? `${m.year} ` : ''}average`;
  return `Part B limit ${quarterOf(m.records[0].period) || m.period}`;
}

/**
 * The product and its brand and generic siblings (siblings(): products sharing an FDA
 * nonproprietary name) in one table: each one's FDA dosage form, whether NADAC classes it brand
 * or generic, what pharmacies pay per unit and the Medicare figure per unit, each with its state,
 * and source lines for them all (decision 52). Up to SIBLING_LIMIT rows, keeping the siblings that
 * share a strength or form with the product first, as siblings() ranks them; listed by name, with
 * numbers in order.
 */
function siblingTable(model, f, sibs) {
  if (!sibs.length) return '';
  const shown = sibs.slice(0, SIBLING_LIMIT - 1);
  const rows = [f.product, ...shown].map((p) => ({ p, forms: formsOf(p), f: drugFacts(model, p) })).sort((a, b) => cmpNatural(a.p.name, b.p.name));
  const names = uniqueCaseless(f.s.names.nonproprietary).map((x) => x.toLowerCase());
  const records = [];
  const inputs = [];
  const body = rows.map((r) => {
    const sf = r.f;
    const self = r.p === f.product;
    records.push(...sf.s.nadac.records);
    const m = sf.medicare;
    let med;
    if (m.missing) med = html`<span class="why">We don’t know yet</span>`;
    else {
      records.push(...m.records);
      for (const i of m.inputs || []) if (!inputs.some((x) => x.text === i.text)) inputs.push(i);
      med = html`<span class="mono">${m.unitText}</span> ${chip(m.state)}<br><span class="item-meta">${medicareShort(m)}</span>`;
    }
    const nameCell = self ? html`<strong>${r.p.name}</strong> <span class="item-flag">this page</span>` : link(`${UP}${drugPath(model, r.p.name)}`, r.p.name);
    const eff = sf.nadacEff.length === 1 ? sf.nadacEff[0] : `${sf.nadacEff[0]} to ${sf.nadacEff[sf.nadacEff.length - 1]}`;
    return html`<tr${self ? new Html(' class="self"') : ''}><th scope="row">${nameCell}<br><span class="item-meta">${versionWords(sf.s)}${r.forms.length ? ` · ${r.forms.join(' / ')}` : ''}</span></th><td><span class="mono">${unitGroups(sf.s.nadac_by_unit)}</span> ${chip(sf.s.nadac.state)}<br><span class="item-meta">eff. ${eff}</span></td><td>${med}</td></tr>`;
  });
  const partD = rows.some((r) => !r.f.medicare.missing && r.f.medicare.kind === 'part_d');
  return html`<section class="prose" aria-labelledby="h-siblings">
<h2 id="h-siblings">Other strengths, forms and brands</h2>
<p>${plural(sibs.length, 'other product')} in the NADAC file ${sibs.length === 1 ? 'shares' : 'share'} ${names.length === 1 ? `the FDA nonproprietary name ${names[0]}` : 'an FDA nonproprietary name'} with ${f.name}.${
    sibs.length > shown.length ? html` The ${formatCount(shown.length)} below share a strength or dosage form with it first; search ${link(UP, 'OpenBill')} for the rest.` : ''
  }</p>
<table class="compare">
<thead><tr><th scope="col">Product</th><th scope="col">Pharmacies pay per unit</th><th scope="col">Medicare per unit</th></tr></thead>
<tbody>
${joinHtml(body, '\n')}
</tbody>
</table>
${partD ? html`<p class="why">Part D is one average per brand and generic name, over every strength and form.</p>` : ''}
${provLines('siblings', records, inputs)}
</section>`;
}

/**
 * Where the product's NADAC price sits in each of its FDA classes (classStanding(), decision 52):
 * how many of the class's other products priced per the same unit pay more or less, and the
 * product in the middle, with its filed price, state and source line. '' when no class compares.
 */
function classSection(model, f) {
  const items = f.classes.map((c) => ({ c, st: classStanding(f.product, model.classes.get(c.key)) })).filter((x) => x.st);
  if (!items.length) return '';
  const first = items[0].st;
  const mine = html`${first.mineNdcs === 1 ? 'Its NADAC price is' : `The middle of its ${formatCount(first.mineNdcs)} NDCs’ NADAC prices is`} <span class="mono">${unitPrice(first.mine)}</span> ${chip(first.mine.state)}.`;
  const paras = items.map(({ c, st }) => {
    const per = st.unit ? ` priced per ${st.unit}` : '';
    const middle = link(`${UP}${drugPath(model, st.middleName)}`, st.middleName);
    return html`<p>Of the ${formatCount(st.others)} other products in FDA’s ${link(`${UP}${classPath(model, c.key)}`, c.name)} class${per}, ${formatCount(st.higher)} ${st.higher === 1 ? 'has' : 'have'} a higher middle NADAC price and ${formatCount(st.lower)} a lower one${st.same ? `; ${formatCount(st.same)} ${st.same === 1 ? 'has' : 'have'} the same` : ''}. The one in the middle is ${middle}, at <span class="mono">${unitPrice(st.middle)}</span> ${chip(st.middle.state)} (eff. ${st.middle.effective_date}).</p>`;
  });
  const records = [first.mine, ...items.map((x) => x.st.middle)];
  return html`<section class="prose" aria-labelledby="h-class">
<h2 id="h-class">Compared with its class</h2>
<p>${mine}</p>
${joinHtml(paras, '\n')}
<p class="why">Prices are compared per unit, whatever the strength or dose, and a class is not a list of substitutes.</p>
${provLines('class', records)}
${methodLinks([['drug-pages', 'How the class comparison works']])}
</section>`;
}

function paragraphs(list) {
  return joinHtml(
    list.map((t) => html`<p>${t}</p>`),
    '\n',
  );
}

// The brand and generic siblings are linked from their table (siblingTable), not listed again.
function linksSection(model, f, rel) {
  const blocks = [];
  if (f.classes.length) {
    blocks.push(html`<h3>${f.classes.length === 1 ? 'Its pharmacologic class' : 'Its pharmacologic classes'}</h3>
<ul class="link-list">${joinHtml(
      f.classes.map((c) => html`<li>${link(`${UP}${classPath(model, c.key)}`, c.name)} <span class="item-meta">${plural(model.classes.get(c.key).length, 'product')}</span></li>`),
      '',
    )}</ul>`);
  }
  if (rel.length) {
    blocks.push(html`<h3>Related in the same class</h3>
<ul class="link-list">${joinHtml(
      rel.map((r) => html`<li>${link(`${UP}${drugPath(model, r.product.name)}`, r.product.name)}</li>`),
      '',
    )}</ul>`);
  }
  blocks.push(html`<h3>More</h3>
<ul class="link-list">
<li>${link(`${UP}${appHash(f.name, f.qty)}`, 'This drug on the interactive card')}</li>
<li>${link(`${UP}${letterPath(letterOf(f.name))}`, `Drugs A–Z: ${letterLabel(letterOf(f.name))}`)}</li>
<li>${link(`${UP}methodology.html`, 'How OpenBill works out every number')}</li>
<li>${link(`${UP}methodology.html#honesty`, 'The rules every price on this page follows')}</li>
<li>${link(reportUrl(f), 'Wrong? Tell us', ' rel="nofollow noopener"')}</li>
</ul>`);
  return html`<section class="prose links" aria-labelledby="h-links">
<h2 id="h-links">Related pages</h2>
${joinHtml(blocks, '\n')}
</section>`;
}

function reportUrl(f) {
  const shown = [`Pharmacies pay ${f.pharmacy.text}${f.pharmacy.kind === 'pack' ? ` for ${f.qtyText}` : ''}`];
  shown.push(f.medicare.missing ? 'Medicare: we don’t know yet' : `${f.medicare.label} ${f.medicare.text}`);
  if (!f.spread.missing) shown.push(`spread ${f.spread.text} (${f.spread.state})`);
  if (!f.costPlus.missing) shown.push(`cost-plus estimate ${f.costPlus.text}`);
  const files = [];
  for (const r of f.s.nadac.records) if (!files.includes(r.source_file)) files.push(r.source_file);
  if (!f.medicare.missing) for (const r of f.medicare.records) for (const x of String(r.source_file).split(' + ')) if (!files.includes(x)) files.push(x);
  return issueUrl({
    template: 'wrong-price.yml',
    title: `Wrong price: ${f.name}`,
    fields: {
      product: f.name,
      ndc: f.s.ndcs.map(showNdc).join(', '),
      figure: `The drug page ${f.path} at quantity ${formatCount(f.qty)}`,
      shown_value: shown.join('; '),
      source_file: files.join(', '),
      build_id: `site page ${f.path}`,
    },
  });
}

function drugCosts(f) {
  const costs = [];
  const add = (perUnit, unit, origin, category) => {
    const c = { '@type': 'DrugCost', costCurrency: 'USD', costPerUnit: perUnit, drugUnit: unit, costOrigin: origin };
    if (category) c.costCategory = category;
    costs.push(c);
  };
  const s = f.s;
  for (const g of s.nadac_by_unit) {
    const r = g.range;
    const ends = r.same ? [['', r.min]] : [['lowest of the NDCs, ', r.min], ['highest of the NDCs, ', r.max]];
    for (const [which, rec] of ends) {
      add(shownNumber(formatUnitPrice(rec.value)), rec.per || 'unit', `${which}CMS NADAC (what retail pharmacies pay to buy the drug), file ${rec.source_file}, effective ${rec.effective_date}, ${rec.state}`);
    }
  }
  if (f.pharmacy.kind === 'pack') {
    const ends = s.pack.same ? [['', s.pack.min]] : [['lowest of the NDCs, ', s.pack.min], ['highest of the NDCs, ', s.pack.max]];
    for (const [which, rec] of ends) add(shownNumber(formatMoney(rec.value)), rec.per, `${which}CMS NADAC for ${f.qtyText}, file ${rec.source_file}, effective ${rec.effective_date}, ${rec.state}`);
  }
  if (!f.medicare.missing) {
    const ref = s.reference;
    const isB = ref.kind === 'part_b';
    const names = isB ? null : partDNamesOf(f);
    const label = isB
      ? 'Medicare Part B payment limit converted to the NADAC unit'
      : `Medicare Part D average spending across every strength and form sold under ${names ? andList(names.map((x) => `“${x}”`)) : 'its Part D name'}, not specific to these NDCs; Medicare’s price is not your price`;
    const r = ref.range;
    const ends = r.same ? [['', r.min]] : [['lowest of the NDCs, ', r.min], ['highest of the NDCs, ', r.max]];
    for (const [which, rec] of ends) {
      add(shownNumber(formatUnitPrice(rec.value)), rec.per || 'unit', `${which}${label}, ${rec.source_file}, period ${periodWords(rec.period) || rec.effective_date}, ${rec.state}`, isB ? 'ReimbursementCap' : undefined);
    }
    if (ref.pack && !isMissing(ref.pack)) {
      const pends = ref.pack.same ? [['', ref.pack.min]] : [['lowest of the NDCs, ', ref.pack.min], ['highest of the NDCs, ', ref.pack.max]];
      for (const [which, rec] of pends) add(shownNumber(formatMoney(rec.value)), rec.per, `${which}${label} for ${f.qtyText}, period ${periodWords(rec.period) || rec.effective_date}, ${rec.state}`, isB ? 'ReimbursementCap' : undefined);
    }
  }
  return costs;
}

function drugLd(model, f, crumbList, faq) {
  const s = f.s;
  const canonical = `${SITE_URL}${f.path}`;
  const listed = f.product.rows.filter((r) => r.identity);
  const drug = {
    '@type': 'Drug',
    '@id': `${canonical}#drug`,
    name: f.name,
    url: canonical,
  };
  const generic = uniqueCaseless(s.names.nonproprietary).map((x) => x.toLowerCase());
  if (generic.length) drug.nonProprietaryName = generic.length === 1 ? generic[0] : generic;
  const brands = uniqueCaseless(s.names.proprietary).filter((p) => !generic.includes(p.toLowerCase()));
  if (brands.length) drug.proprietaryName = brands.length === 1 ? brands[0] : brands;
  const forms = uniqueCaseless(listed.map((r) => r.identity.dosage_form)).map((x) => x.toLowerCase());
  if (forms.length) drug.dosageForm = forms.length === 1 ? forms[0] : forms;
  const routes = uniqueCaseless(listed.map((r) => r.identity.route)).map((x) => x.toLowerCase());
  if (routes.length) drug.administrationRoute = routes.length === 1 ? routes[0] : routes;
  if (f.classes.length) drug.drugClass = f.classes.map((c) => ({ '@type': 'DrugClass', name: c.name, url: `${SITE_URL}${classPath(model, c.key)}` }));
  if (s.otc === true) drug.prescriptionStatus = 'https://schema.org/OTC';
  drug.code = s.ndcs.map((n) => ({ '@type': 'MedicalCode', codeValue: showNdc(n), codingSystem: 'NDC' }));
  drug.cost = drugCosts(f);
  const graph = [breadcrumbLd(crumbList), drug];
  if (faq.length) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${canonical}#faq`,
      mainEntity: faq.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })),
    });
  }
  return graph;
}

/**
 * One drug page: drug/<slug>/index.html.
 * @param {object} model buildModel()
 * @param {{ name: string, rows: object[] }} product
 * @returns {{ path: string, file: string, html: string, title: string, description: string, facts: object, links: object }}
 */
export function renderDrugPage(model, product) {
  const f = drugFacts(model, product);
  const { title, description } = drugMeta(f);
  const canonical = `${SITE_URL}${f.path}`;
  const letter = letterOf(f.name);
  const crumbList = [
    { name: APP_NAME, href: UP, url: SITE_URL },
    { name: `Drugs A–Z: ${letterLabel(letter)}`, href: `${UP}${letterPath(letter)}`, url: `${SITE_URL}${letterPath(letter)}` },
    { name: f.name, href: '', url: canonical },
  ];
  const sibs = siblings(product, model.products);
  const rel = related(product, model.products, model.classes, RELATED_LIMIT);
  const faq = faqItems(f);
  const genericNadac = f.s.generic_nadac
    ? html`<p>NADAC also lists, on the row of ${f.s.generic_nadac.count === 1 ? 'one brand NDC' : 'its brand NDCs'}, what pharmacies pay for the generic equivalent, a different product: ${unitRange(f.s.generic_nadac)} ${chip(f.s.generic_nadac.state)}.</p>
${provLines('generic-nadac', f.s.generic_nadac.records)}`
    : '';
  const staleNotes = [...f.stale.nadac, ...f.stale.medicare].map((x) => html`<p class="fresh fresh-stale">${staleChip()} As of ${model.dataDate}, the date this page’s data last changed: ${x.message}</p>`);
  const body = html`<a class="skip" href="#main">Skip to the figures</a>
${masthead(model)}
${crumbs(crumbList)}
<main id="main">
<h1 class="page-title">${f.name}</h1>
${f.genericName ? html`<p class="page-generic">FDA nonproprietary name: ${f.genericName}</p>` : ''}
${cardHtml(f)}
${joinHtml(staleNotes, '\n')}
<section class="prose" aria-labelledby="h-what">
<h2 id="h-what">What it is</h2>
${paragraphs(whatItIs(f))}
</section>
<section class="prose" aria-labelledby="h-pharmacy">
<h2 id="h-pharmacy">What pharmacies pay</h2>
${paragraphs(whatPharmaciesPay(f))}
${genericNadac}
${pharmacyLinks(f)}
${ndcList(f)}
</section>
${siblingTable(model, f, sibs)}
${classSection(model, f)}
<section class="prose" aria-labelledby="h-medicare">
<h2 id="h-medicare">What Medicare paid</h2>
${paragraphs(whatMedicarePaid(f))}
${f.medicare.missing ? '' : html`<p class="not-yours">${honestyLine('not-your-price', { firstSentenceOnly: true })}</p>`}
${medicareLinks(f)}
</section>
<section class="prose" aria-labelledby="h-ask">
<h2 id="h-ask">What to ask at the counter</h2>
<p>None of these figures is your price: what you pay depends on your pharmacy, your insurance, coupons and discounts.</p>
<ul class="ask">${joinHtml(
    askAtCounter(f, sibs).map((t) => html`<li>${t}</li>`),
    '\n',
  )}</ul>
</section>
${faq.length
    ? html`<section class="prose faq" aria-labelledby="h-faq">
<h2 id="h-faq">Questions</h2>
<dl>${joinHtml(
        faq.map((x) => html`<dt>${x.q}</dt><dd>${x.a}</dd>`),
        '\n',
      )}</dl>
</section>`
    : ''}
${linksSection(model, f, rel)}
</main>
${footer(model)}`;
  const head = headHtml({
    title,
    description,
    canonical,
    ogImage: `${SITE_URL}${ogImagePath(f.slug)}`,
    ogAlt: `${f.name}: ${headlinePharmacy(f)}${f.medicare.missing ? '.' : `; ${medicareHeadline(f)}. ${honestyText('not-your-price', { firstSentenceOnly: true })}`}`,
    type: 'article',
  });
  return {
    path: f.path,
    file: `${f.path}index.html`,
    html: page({ head: head.s, body: body.s, ld: jsonLd(drugLd(model, f, crumbList, faq)).s }),
    title,
    description,
    facts: f,
    links: { siblings: sibs, related: rel },
  };
}

// ---------------------------------------------------------------- class page

/**
 * One FDA pharmacologic class page: class/<slug>/index.html.
 * @param {object} model
 * @param {string} key an EPC class key ("Atypical Antipsychotic [EPC]")
 * @returns {{ path: string, file: string, html: string, title: string, description: string }}
 */
export function renderClassPage(model, key) {
  const products = model.classes.get(key);
  if (!products) throw new Error(`no class ${JSON.stringify(key)}`);
  const name = epcName(key);
  const path = classPath(model, key);
  const canonical = `${SITE_URL}${path}`;
  const withMedicare = products.filter((p) => !drugFacts(model, p).medicare.missing).length;
  const ingredients = new Set(products.flatMap((p) => p.rows.map((r) => r.identity && r.identity.nonproprietary_name && r.identity.nonproprietary_name.toLowerCase()).filter(Boolean)));
  const n = products.length;
  const title = `${name} drugs: ${plural(n, 'product')} with pharmacy prices | ${APP_NAME}`;
  const description = `${plural(n, 'product')} in FDA’s ${name} class, with what pharmacies pay (CMS NADAC, file of ${model.doc.sources.nadac.as_of_date}) and, for ${formatCount(withMedicare)}, what Medicare paid. Every number with its source and date.`;
  const crumbList = [
    { name: APP_NAME, href: UP, url: SITE_URL },
    { name: `Class: ${name}`, href: '', url: canonical },
  ];
  const body = html`<a class="skip" href="#main">Skip to the list</a>
${masthead(model)}
${crumbs(crumbList)}
<main id="main">
<h1 class="page-title">${name}</h1>
<p class="lede">An Established Pharmacologic Class (EPC) in the FDA NDC Directory: the class FDA records for a product in its PHARM_CLASSES field.</p>
<section class="prose" aria-labelledby="h-count">
<h2 id="h-count">In the NADAC file of ${model.doc.sources.nadac.as_of_date}</h2>
<p>${plural(n, 'product')} in the NADAC file of ${model.doc.sources.nadac.as_of_date} ${n === 1 ? 'has' : 'have'} an NDC that FDA lists in this class, covering ${plural(ingredients.size, 'nonproprietary name')} as FDA writes them. ${formatCount(withMedicare)} of them ${withMedicare === 1 ? 'has' : 'have'} a Medicare figure on OpenBill.</p>
<p>Being in one class means FDA describes the drugs’ pharmacology the same way. It does not mean one can replace another; that is a question for your prescriber.</p>
${listSource(model)}
</section>
<section class="prose" aria-labelledby="h-list">
<h2 id="h-list">The products, with what pharmacies pay per unit</h2>
<ul class="product-list">${joinHtml(
    products.map((p) => productItem(model, p)),
    '\n',
  )}</ul>
</section>
<section class="prose" aria-labelledby="h-honesty">
<h2 id="h-honesty">How to read these prices</h2>
${honestyList()}
</section>
</main>
${footer(model)}`;
  const head = headHtml({
    title,
    description,
    canonical,
    ogImage: `${SITE_URL}${ogImagePath('site')}`,
    ogAlt: `${APP_NAME}: what pharmacies pay and what Medicare paid, with a source and date on every number.`,
  });
  const ld = [
    breadcrumbLd(crumbList),
    { '@type': 'DrugClass', '@id': `${canonical}#class`, name, url: canonical, drug: products.map((p) => ({ '@type': 'Drug', name: p.name, url: `${SITE_URL}${drugPath(model, p.name)}` })) },
  ];
  return { path, file: `${path}index.html`, html: page({ head: head.s, body: body.s, ld: jsonLd(ld).s }), title, description };
}

// ---------------------------------------------------------------- A–Z page

/**
 * One A–Z page: drugs/<letter>/index.html.
 * @param {object} model
 * @param {string} letter "a" … "z", "0-9" or "other"
 * @returns {{ path: string, file: string, html: string, title: string, description: string }}
 */
export function renderLetterPage(model, letter) {
  const products = model.letters.get(letter);
  if (!products) throw new Error(`no products under ${JSON.stringify(letter)}`);
  const path = letterPath(letter);
  const canonical = `${SITE_URL}${path}`;
  const label = letterLabel(letter);
  const n = products.length;
  const withMedicare = products.filter((p) => !drugFacts(model, p).medicare.missing).length;
  const what = letter === '0-9' ? 'starting with a digit' : letter === 'other' ? 'starting with another character' : `starting with ${label}`;
  const title = `Drugs ${what}: ${plural(n, 'product')} | ${APP_NAME}`;
  const description = `${plural(n, 'drug product')} ${what} in the CMS NADAC file of ${model.doc.sources.nadac.as_of_date}, with what pharmacies pay per unit; ${formatCount(withMedicare)} also have a Medicare figure. Every number with its source and date.`;
  const crumbList = [
    { name: APP_NAME, href: UP, url: SITE_URL },
    { name: `Drugs A–Z: ${label}`, href: '', url: canonical },
  ];
  const body = html`<a class="skip" href="#main">Skip to the list</a>
${masthead(model)}
${crumbs(crumbList)}
<main id="main">
<h1 class="page-title">Drugs A–Z: ${label}</h1>
${letterNav(model, letter)}
<p class="lede">${plural(n, 'product')} ${what} in the NADAC file of ${model.doc.sources.nadac.as_of_date}, named as NADAC names them. ${formatCount(withMedicare)} of them ${withMedicare === 1 ? 'has' : 'have'} a Medicare figure on OpenBill.</p>
${listSource(model)}
<ul class="product-list">${joinHtml(
    products.map((p) => productItem(model, p)),
    '\n',
  )}</ul>
<p class="honesty-one">${honestyLine('range')}</p>
</main>
${footer(model)}`;
  const head = headHtml({
    title,
    description,
    canonical,
    ogImage: `${SITE_URL}${ogImagePath('site')}`,
    ogAlt: `${APP_NAME}: what pharmacies pay and what Medicare paid, with a source and date on every number.`,
  });
  return { path, file: `${path}index.html`, html: page({ head: head.s, body: body.s, ld: jsonLd([breadcrumbLd(crumbList)]).s }), title, description };
}

// ---------------------------------------------------------------- 404.html

/** Classes with fewer products than this are published but left out of sitemap.xml (thin pages). */
export const SITEMAP_CLASS_MIN = 3;

/**
 * The site's 404.html. GitHub Pages serves it for any missing path under the site, at that path,
 * so every link and the stylesheet are absolute (SITE_URL); it is not in the sitemap.
 * @param {object} model
 * @returns {{ file: string, html: string }}
 */
export function renderNotFoundPage(model) {
  const first = model.letterOrder.includes('a') ? 'a' : model.letterOrder[0];
  const title = `Page not found | ${APP_NAME}`;
  const body = html`<header class="masthead">
<a class="stamp" href="${checkHref(SITE_URL)}" aria-label="${APP_NAME} drug price receipt, home"><span class="stamp-name">${APP_NAME}</span><span class="stamp-sub">drug price receipt</span></a>
</header>
<main id="main">
<h1 class="page-title">No page here</h1>
<p class="lede">The address may be mistyped, or the drug may have left the NADAC file since the link was made: CMS changes product names and drops NDCs from week to week.</p>
<ul class="link-list">
<li>${link(SITE_URL, 'OpenBill: search any drug')}</li>
<li>${link(`${SITE_URL}${letterPath(first)}`, 'Browse every drug A–Z')}</li>
<li>${link(`${SITE_URL}methodology.html`, 'How OpenBill works out every number')}</li>
</ul>
<p>${honestyLine('range')}</p>
</main>`;
  const text = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(SITE_CSP)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${esc(checkHref(`${SITE_URL}assets/site.css`))}">
</head>
<body>
${body.s}
</body>
</html>
`;
  return { file: '404.html', html: text };
}

// ---------------------------------------------------------------- preview card (og/<slug>.png)

// Dates in the card's source lines never break at their hyphens.
function nowrapDates(text) {
  return joinHtml(
    String(text)
      .split(/(\d{4}-\d{2}-\d{2})/)
      .map((bit, i) => (i % 2 ? html`<span class="nw">${bit}</span>` : html`${bit}`)),
    '',
  );
}

/** "2026 Q4" for a period that is exactly one calendar quarter, else null. */
function quarterOf(period) {
  const p = parsePeriod(period);
  if (!p) return null;
  const q = { '01-01': ['03-31', 1], '04-01': ['06-30', 2], '07-01': ['09-30', 3], '10-01': ['12-31', 4] }[p.start.slice(5)];
  return q && p.start.slice(0, 4) === p.end.slice(0, 4) && p.end.slice(5) === q[0] ? `${p.start.slice(0, 4)} Q${q[1]}` : null;
}

function ogLengthClass(name) {
  const n = name.length;
  return n <= 22 ? 'len-s' : n <= 34 ? 'len-m' : n <= 46 ? 'len-l' : 'len-xl';
}

/**
 * The HTML of a product's 1200×630 preview card, for tools/site.mjs to render with Playwright
 * (page.setContent, then a screenshot). Self-contained: `css` is the card's stylesheet with its
 * @font-face rules as data: URIs, so nothing is fetched. Every figure carries its state and the
 * date it comes from, as on the card.
 * @param {object} model
 * @param {{ name: string, rows: object[] }} product
 * @param {{ css: string, site?: boolean }} opts site: the site's own card (og/site.png)
 * @returns {string}
 */
export function renderOgHtml(model, product, { css, site = false }) {
  if (typeof css !== 'string' || /<\/style/i.test(css)) throw new Error('renderOgHtml needs the card CSS as a string');
  const f = drugFacts(model, product);
  const ph = f.pharmacy;
  const m = f.medicare;
  const sp = f.spread;
  const cp = f.costPlus;
  const effText = f.nadacEff.length === 1 ? `eff. ${f.nadacEff[0]}` : `eff. ${f.nadacEff[0]} to ${f.nadacEff[f.nadacEff.length - 1]}`;
  const val = (text, cls = '') => html`<span class="value${cls}${String(text).length > 16 ? ' value-long' : ''}">${text}</span>`;
  const row = (label, value, state, src, extra = '') =>
    html`<div class="row${extra}"><span class="label">${label}</span><span class="fig">${value}${state ? html` ${chip(state)}` : ''}</span><span class="src">${nowrapDates(src)}</span></div>`;
  const unknown = html`<span class="value unknown">We don’t know yet</span>`;
  const rows = [
    row('Pharmacies pay', val(ph.text), ph.state, `NADAC ${effText}`),
    m.missing
      ? row('Medicare', unknown, null, 'no usable figure')
      : row(m.label, val(m.text), m.state, m.kind === 'part_d' ? `${m.year ? `${m.year} avg.` : `avg. ${m.period}`}, all strengths` : `Part B ${quarterOf(m.records[0].period) || m.period}`),
    sp.missing ? row('The spread', unknown, null, '') : row('The spread', val(sp.text, ' multiple'), sp.state, sp.extreme ? 'may not measure the same thing' : 'Medicare ÷ NADAC', ' row-spread'),
    cp.missing ? row('Cost-plus estimate', unknown, null, '') : row('Cost-plus estimate', val(cp.text), cp.state, `+${formatPercent(COST_PLUS.markup_pct)} +${formatMoney(COST_PLUS.fee_usd)}, no shipping`),
  ];
  const body = html`<div class="og">
<div class="top"><span class="stamp"><span class="stamp-name">${APP_NAME}</span><span class="stamp-sub">drug price receipt</span></span><span class="week">${site ? 'Every number with its source and date' : `NADAC week of ${model.doc.sources.nadac.as_of_date}`}</span></div>
<h1 class="name ${ogLengthClass(f.name)}">${f.name}</h1>
<p class="qty">${quantityKicker(f)}</p>
<div class="rows">${joinHtml(rows, '\n')}</div>
<p class="foot"><span>${m.missing ? '' : `${honestyText('not-your-price', { firstSentenceOnly: true })} `}${honestyText('range')}</span><span>${SITE_URL.replace(/^https:\/\//, '').replace(/\/$/, '')}</span></p>
</div>`;
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<style>${css}</style>\n</head>\n<body>\n${body.s}\n</body>\n</html>\n`;
}

// ---------------------------------------------------------------- sitemap

function xmlEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

/**
 * sitemap.xml for the given pages: [{ path, lastmod }] with path relative to the site root ('' for
 * the home page, 'drug/<slug>/' …) and lastmod an ISO date. Sorted by path so the output is stable.
 * @param {{ path: string, lastmod: string }[]} entries
 * @returns {string}
 */
export function sitemapXml(entries) {
  const sorted = [...entries].sort((a, b) => cmp(a.path, b.path));
  const seen = new Set();
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  for (const e of sorted) {
    if (seen.has(e.path)) throw new Error(`sitemap: ${e.path} listed twice`);
    seen.add(e.path);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.lastmod))) throw new Error(`sitemap: ${e.path} has no lastmod date`);
    lines.push(`<url><loc>${xmlEsc(SITE_URL + e.path)}</loc><lastmod>${xmlEsc(e.lastmod)}</lastmod></url>`);
  }
  lines.push('</urlset>', '');
  return lines.join('\n');
}

/**
 * The methodology.html anchors the static pages link to, so tools/site.mjs can check that the
 * methodology.html it publishes has each one.
 * @returns {string[]}
 */
export function linkedAnchors() {
  return [...LINKED_ANCHORS];
}

/** Anchors methodology.html is generated with (its sections and one per rule), for link checks. */
export const METHODOLOGY_ANCHORS = Object.freeze([...SECTIONS.map((s) => s[0]), ...RULES.map((r) => r.id)]);
