// Product search over the linked rows of data/drugs.json (linkRows() in pack.js). A product
// is every row (NDC) with the same NADAC description (`name`). Index once with
// buildIndex(groupProducts(rows)); each search is a linear scan of precomputed strings, well
// under 10 ms for ~6,000 products. suggest() offers spelling corrections for a query that
// finds nothing. The order of the results is decision 54; it uses no displayed figure.

import { looksLikeNdc, readNdc } from './ndc.js';

/**
 * Abbreviations folded together, so "metformin hydrochloride" finds "METFORMIN HCL".
 * Both the query and the names are mapped to the right-hand form. A mapped word only ever matches
 * a whole word: SYRINGE is SYR, but it does not start SYRUP.
 */
export const SYNONYMS = Object.freeze({
  HYDROCHLORIDE: 'HCL',
  HYDROBROMIDE: 'HBR',
  TAB: 'TABLET',
  TABS: 'TABLET',
  TABLETS: 'TABLET',
  CAP: 'CAPSULE',
  CAPS: 'CAPSULE',
  CAPSULES: 'CAPSULE',
  SOLUTION: 'SOLN',
  SUSPENSION: 'SUSP',
  SODIUM: 'SOD',
  POTASSIUM: 'POT',
  CREAM: 'CRM',
  OINTMENT: 'OINT',
  LOTION: 'LOT',
  SYRINGE: 'SYR',
  SYRINGES: 'SYR',
  DROPS: 'DROP',
  INJECTION: 'INJ',
  APAP: 'ACETAMINOPHEN',
  MICROGRAM: 'MCG',
  MICROGRAMS: 'MCG',
  MILLIGRAM: 'MG',
  MILLIGRAMS: 'MG',
  MILLILITER: 'ML',
  MILLILITERS: 'ML',
});

/** Words of a product's own name that say it is not the immediate-release form. */
const RELEASE_WORDS = new Set(['ER', 'XR', 'XL', 'SR', 'CR', 'DR', 'LA', 'LAR', 'XT', 'CD', 'EC', 'OSM', 'OSMOTIC']);
/** The units of a strength, which stay out of a family's key: 25 MG and 50 MG are one family. */
const STRENGTH_UNITS = new Set(['MG', 'MCG', 'GM', 'G', 'KG', 'ML', 'L', 'UNIT', 'UNITS', 'MEQ', 'MMOL', 'IU']);
/** NADAC's 30-character names shorten one word many ways; in a family's key they are one word. */
const FAMILY_WORDS = Object.freeze({ TB: 'TABLET', CP: 'CAPSULE', OSMOTIC: 'OSM', GASTRC: 'GASTR', VL: 'VIAL', SYRG: 'SYR', SYRN: 'SYR', SOL: 'SOLN', CHW: 'CHEW', DRP: 'DROP', SPRY: 'SPRAY' });
/** Name words for the rows FDA's directory gives no route or form for. */
const INJECTED_WORDS = new Set(['VIAL', 'VL', 'SYR', 'SYRG', 'SYRN', 'INJ', 'AMPUL', 'AMP', 'CARTRIDGE']);
const ORAL_SOLID_WORDS = new Set(['TABLET', 'CAPSULE', 'TB', 'CP', 'CPLT', 'CHEW', 'CHW', 'ODT']);
const INJECTED_ROUTE = /INTRA|SUBCUTANEOUS|PARENTERAL|EPIDURAL|PERINEURAL|INFILTRATION/;
/** A name that starts with two ingredients: HYDROCODONE-ACETAMINOPHEN, not OXYCODONE HCL. */
const COMBINATION_NAME = /^[A-Z]{4,}-[A-Z]{3,}/;
/**
 * Listed by under a quarter as many NDCs as the most-listed one beside it is rare: few makers, and
 * usually a higher price. A rare strength waits behind its family's common ones, and a query's
 * immediate-release products only come first when they are not rare next to the others.
 */
const COMMON_SHARE = 4;

function basic(s) {
  if (typeof s !== 'string') return [];
  return s
    .toUpperCase()
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1') // thousands separators: "5,000 UNIT" → "5000 UNIT"
    .replace(/(\d)\.(?=\d)/g, '$1\u0001') // keep decimal points: "0.5 MG"
    .replace(/[^\p{L}\p{N}\u0001]+/gu, ' ')
    .replace(/\u0001/g, '.')
    .replace(/(\d)(\p{L})/gu, '$1 $2') // "500MG" → "500 MG", "12HR" → "12 HR"
    .replace(/(\p{L})(\d)/gu, '$1 $2')
    .split(' ')
    .filter(Boolean);
}

/**
 * Normalize a query or a name for matching: uppercase, thousands separators dropped
 * ("1,000" → "1000"), punctuation to spaces (decimal points between digits kept), digits
 * split from letters, whitespace collapsed, and SYNONYMS
 * applied unless { synonyms: false }.
 * normalizeQuery(' Metformin  hydrochloride, 500mg ') → "METFORMIN HCL 500 MG".
 * @param {*} q
 * @param {{ synonyms?: boolean }} [opts]
 * @returns {string}
 */
export function normalizeQuery(q, opts = {}) {
  const tokens = basic(q);
  const out = opts.synonyms === false ? tokens : tokens.map((t) => SYNONYMS[t] || t);
  return out.join(' ');
}

/**
 * @typedef {object} Product
 * @property {string} name     the NADAC description shared by its rows
 * @property {object[]} rows   sorted by ndc
 * @property {string[]} ndcs
 * @property {string|null} unit  NADAC pricing unit, or null if the rows disagree
 * @property {string[]} names  searchable names: the NADAC name, then FDA proprietary and
 *                             nonproprietary names, then the Medicare Part D brand and
 *                             generic names of linked rows (distinct, case-insensitive)
 */

/**
 * Group rows into products keyed by row.name, sorted by name. Rows are linked rows
 * (linkRows in pack.js); an unlinked row simply contributes no Part D names.
 * @param {object[]} rows
 * @returns {Product[]}
 */
export function groupProducts(rows) {
  const byName = new Map();
  for (const row of rows) {
    if (!byName.has(row.name)) byName.set(row.name, []);
    byName.get(row.name).push(row);
  }
  const names = [...byName.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names.map((name) => {
    const group = byName.get(name).slice().sort((a, b) => (a.ndc < b.ndc ? -1 : a.ndc > b.ndc ? 1 : 0));
    const units = [...new Set(group.map((r) => r.unit))];
    const searchable = [name];
    const seen = new Set([name.toUpperCase()]);
    const sources = [
      ['identity', 'proprietary_name'],
      ['identity', 'nonproprietary_name'],
      ['part_d', 'brand_name'],
      ['part_d', 'generic_name'],
    ];
    for (const [obj, key] of sources) {
      for (const r of group) {
        const v = r[obj] && r[obj][key];
        if (typeof v === 'string' && v.trim() && !seen.has(v.trim().toUpperCase())) {
          seen.add(v.trim().toUpperCase());
          searchable.push(v.trim());
        }
      }
    }
    return { name, rows: group, ndcs: group.map((r) => r.ndc), unit: units.length === 1 ? units[0] : null, names: searchable };
  });
}

/** Shortest word that suggest() corrects or offers as a correction. */
export const SUGGEST_MIN_LENGTH = 3;

const WORD_RE = /^\p{L}+$/u;
const NUMBER_RE = /^\d/;

/** What search needs to know about a product, whatever is typed. */
function factsOf(product) {
  const tokens = basic(product.name).map((t) => SYNONYMS[t] || t);
  const family = [];
  const strength = [];
  let release = false;
  let injected = false;
  let oralSolid = false;
  for (const t of tokens) {
    if (NUMBER_RE.test(t)) {
      strength.push(parseFloat(t));
      continue;
    }
    if (RELEASE_WORDS.has(t)) release = true;
    if (INJECTED_WORDS.has(t)) injected = true;
    if (ORAL_SOLID_WORDS.has(t)) oralSolid = true;
    if (!STRENGTH_UNITS.has(t)) family.push(FAMILY_WORDS[t] || t);
  }
  let claims = 0;
  for (const r of product.rows) {
    const c = r.part_d && r.part_d.claims && r.part_d.claims.value;
    if (typeof c === 'number' && c > claims) claims = c;
    const id = r.identity;
    if (id) {
      if (typeof id.route === 'string' && INJECTED_ROUTE.test(id.route)) injected = true;
      if (typeof id.dosage_form === 'string') {
        if (id.dosage_form.startsWith('INJECTION')) injected = true;
        // FDA calls a vaginal insert a tablet too.
        if (/^(TABLET|CAPSULE)/.test(id.dosage_form) && (typeof id.route !== 'string' || id.route.includes('ORAL'))) oralSolid = true;
      }
    }
  }
  const first = tokens.find((t) => !NUMBER_RE.test(t)) || '';
  return { key: family.join(' '), strength, claims, release, injected, oralSolid: oralSolid && !injected, combination: COMBINATION_NAME.test(product.name), first, ndcs: product.rows.length, familyNdcs: 0, familyClaims: 0, rank: 0 };
}

function compareStrength(a, b) {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Every product's place in the order nothing typed can change: families by the NDC count of their
 * most-listed strength, then Part D claims; inside a family common strengths first, each group in
 * numeric order, so sertraline lists 25, 50, 100 and metformin lists 500, 850, 1,000.
 */
function rankProducts(products, facts) {
  const families = new Map();
  for (const f of facts) {
    const fam = families.get(f.key) || { ndcs: 0, claims: 0 };
    fam.ndcs = Math.max(fam.ndcs, f.ndcs);
    fam.claims = Math.max(fam.claims, f.claims);
    families.set(f.key, fam);
  }
  for (const f of facts) {
    const fam = families.get(f.key);
    f.familyNdcs = fam.ndcs;
    f.familyClaims = fam.claims;
    f.rare = f.ndcs * COMMON_SHARE < fam.ndcs;
  }
  const order = facts.map((_, i) => i);
  order.sort((x, y) => {
    const a = facts[x];
    const b = facts[y];
    if (a.familyNdcs !== b.familyNdcs) return b.familyNdcs - a.familyNdcs;
    if (a.familyClaims !== b.familyClaims) return b.familyClaims - a.familyClaims;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    if (a.rare !== b.rare) return a.rare ? 1 : -1;
    const s = compareStrength(a.strength, b.strength);
    if (s !== 0) return s;
    const na = products[x].name;
    const nb = products[y].name;
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
  order.forEach((i, place) => {
    facts[i].rank = place;
  });
}

/**
 * Build the search index for a list of products (from groupProducts). `vocab` maps every
 * word of the searchable names (letters only, at least SUGGEST_MIN_LENGTH long, raw and
 * synonym forms) to the number of products whose names use it; suggest() reads it.
 *
 * `aliases` is where a table of names NADAC does not use can plug in (rows of { name, generic,
 * source }, where source names the file the row came from): search() falls back on it, and marks
 * what it returns, since a generic's price is not the brand's. Nothing passes one yet.
 *
 * @param {Product[]} products
 * @param {{ aliases?: Iterable<{ name: string, generic: string, source: string }> }} [opts]
 * @returns {{ products: Product[], entries: object[], byNdc: Map<string, number>, byCode: Map<string, number[]>, vocab: Map<string, number>, facts: object[], aliases: Map<string, object> }}
 */
export function buildIndex(products, { aliases = [] } = {}) {
  const entries = [];
  const byNdc = new Map();
  const byCode = new Map();
  const vocab = new Map();
  products.forEach((p, i) => {
    for (const ndc of p.ndcs) {
      byNdc.set(ndc, i);
      const code = ndc.slice(0, 9);
      const list = byCode.get(code);
      if (!list) byCode.set(code, [i]);
      else if (list[list.length - 1] !== i) list.push(i);
    }
    const words = new Set();
    for (const n of p.names) {
      const rawTokens = basic(n);
      const canonTokens = rawTokens.map((t) => SYNONYMS[t] || t);
      const raw = rawTokens.join(' ');
      const canon = canonTokens.join(' ');
      if (!canon) continue;
      const tokens = [...new Set([...rawTokens, ...canonTokens])];
      entries.push({ i, name: n, own: n === p.name, raw, canon, tokens, first: rawTokens[0] });
      for (const t of tokens) if (t.length >= SUGGEST_MIN_LENGTH && WORD_RE.test(t)) words.add(t);
    }
    for (const w of words) vocab.set(w, (vocab.get(w) || 0) + 1);
  });
  const facts = products.map(factsOf);
  rankProducts(products, facts);
  const aliasMap = new Map();
  for (const a of aliases) aliasMap.set(normalizeQuery(a.name), a);
  return { products, entries, byNdc, byCode, vocab, facts, aliases: aliasMap };
}

function readQuery(text) {
  const raw = basic(text);
  if (!raw.length) return null;
  const canon = raw.map((t) => SYNONYMS[t] || t);
  const last = raw.length - 1;
  const letters = [...new Set([...raw, ...canon])].filter((t) => !NUMBER_RE.test(t));
  return {
    raw,
    canon,
    last,
    rawText: raw.join(' '),
    canonText: canon.join(' '),
    // A synonym only matches a whole word. So as a prefix of a name, the word still being typed
    // counts as typed (typing), and its synonym only with the word's end after it (canonWord).
    typing: [...canon.slice(0, last), raw[last]].join(' '),
    canonWord: `${canon.join(' ')} `,
    letters,
    release: canon.some((t) => RELEASE_WORDS.has(t)),
  };
}

/**
 * Whether every query word is a whole word of the name or starts one. Only the last word is still
 * being typed, so a number or a single letter before it has to be whole: "b12" does not find a
 * name with a B-word and the strength 120. Nothing here looks inside a word.
 */
function wordsStart(q, tokens) {
  for (let k = 0; k <= q.last; k++) {
    const a = q.raw[k];
    const b = q.canon[k];
    const exactOnly = k < q.last && (a.length === 1 || NUMBER_RE.test(a));
    let found = false;
    for (const t of tokens) {
      if (t === a || t === b || (!exactOnly && t.startsWith(a))) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function everyWordWhole(q, tokens) {
  for (let k = 0; k <= q.last; k++) {
    if (!tokens.includes(q.raw[k]) && !tokens.includes(q.canon[k])) return false;
  }
  return true;
}

/**
 * A partial match: the letters found are only the start of a word other than the name's first,
 * as "ultram" is the start of griseofulvin ULTRAMicrosize. The last word may be incomplete beside
 * a word that is whole: that is someone still typing "sertraline 5".
 */
function isPartial(q, e) {
  let anchored = false;
  let looseLast = false;
  for (let k = 0; k <= q.last; k++) {
    const a = q.raw[k];
    if (e.tokens.includes(a) || e.tokens.includes(q.canon[k]) || e.first.startsWith(a)) anchored = true;
    else if (k < q.last) return true;
    else looseLast = true;
  }
  return looseLast && !anchored;
}

// How a product meets the query, best first. Its own NADAC name beats the names FDA and Part D use
// for it, so "amlodipine" lists AMLODIPINE BESYLATE before KATERZIA, whose FDA name is amlodipine.
const TIER_EXACT = 0; // the query is the product's own name
const TIER_OWN = 1; // the own name starts with a query word and has them all
const TIER_FIRST_WORD = 2; // the own name starts with a query word; another name has them all
const TIER_OWN_WORDS = 3; // the own name has them all, none at its start
const TIER_OTHER = 4; // only another name has them
const TIER_PARTIAL = 5;
const TIERS = 6;
const MATCHES = ['exact', 'prefix', 'tokens'];

function nameHits(index, q) {
  const { facts } = index;
  const best = new Map();
  for (const e of index.entries) {
    let level;
    if (e.canon === q.canonText || e.raw === q.rawText) level = 0;
    else if (e.raw.startsWith(q.rawText) || e.canon.startsWith(q.typing) || e.canon.startsWith(q.canonWord)) level = 1;
    else if (wordsStart(q, e.tokens)) level = 2;
    else continue;
    const whole = level === 0 || everyWordWhole(q, e.tokens);
    const anchored = q.letters.some((w) => facts[e.i].first.startsWith(w));
    let tier;
    if (level === 2 && !whole && isPartial(q, e)) tier = TIER_PARTIAL;
    else if (level === 0 && e.own) tier = TIER_EXACT;
    else if (e.own) tier = anchored ? TIER_OWN : TIER_OWN_WORDS;
    else if (anchored) tier = TIER_FIRST_WORD;
    // Part of a word of another name, with nothing of the product's own: griseofulvin for "ultram".
    else tier = whole ? TIER_OTHER : TIER_PARTIAL;
    const prev = best.get(e.i);
    if (!prev || tier < prev.tier || (tier === prev.tier && ((whole && !prev.whole) || (whole === prev.whole && e.raw.length < prev.entry.raw.length)))) {
      best.set(e.i, { i: e.i, tier, whole, level, entry: e, held: 0 });
    }
  }
  const hits = [...best.values()];
  const seen = {};
  for (const key of ['all', 'oral', 'single', 'combination', 'plain', 'plainOral', 'released']) seen[key] = new Array(TIERS).fill(0);
  const raise = (key, tier, n) => {
    if (n > seen[key][tier]) seen[key][tier] = n;
  };
  for (const h of hits) {
    const f = facts[h.i];
    const n = f.familyNdcs;
    raise('all', h.tier, n);
    if (f.oralSolid) raise('oral', h.tier, n);
    if (f.release) raise('released', h.tier, n);
    else if (!f.injected) {
      raise('plain', h.tier, n);
      if (f.oralSolid) raise('plainOral', h.tier, n);
      raise(f.combination ? 'combination' : 'single', h.tier, n);
    }
  }
  for (const h of hits) h.held = holdFor(facts[h.i], h.tier, q, seen);
  hits.sort((a, b) => a.tier - b.tier || (a.whole === b.whole ? 0 : a.whole ? -1 : 1) || (a.tier === TIER_OTHER ? a.level - b.level : 0) || a.held - b.held || facts[a.i].rank - facts[b.i].rank);
  return hits;
}

/**
 * How far back a product sits inside its tier, once the query has been looked at as a whole (0 is
 * not at all). A vial when the same words also find a tablet; a combination when the ingredient is
 * also listed alone; a release form when the query names none and an immediate-release form is
 * there to prefer, not a rare one, or "omeprazole" would hide OMEPRAZOLE DR; anything else when
 * tablets and capsules are at least half as widely listed.
 */
function holdFor(f, tier, q, seen) {
  if (f.injected && seen.oral[tier]) return 4;
  if (f.combination && seen.single[tier] * COMMON_SHARE >= seen.combination[tier]) return 3;
  if (f.release && !q.release && (f.oralSolid ? seen.plainOral[tier] : seen.plain[tier]) * COMMON_SHARE >= seen.released[tier]) return 2;
  if (!f.oralSolid && seen.oral[tier] * 2 >= seen.all[tier]) return 1;
  return 0;
}

function hitResult(index, h) {
  const e = h.entry;
  return { product: index.products[h.i], match: h.tier === TIER_PARTIAL ? 'partial' : MATCHES[h.level], matched: e.name, own: e.own };
}

/** The first row of a product whose NDC starts with a labeler and product code. */
function rowWithCode(product, code) {
  return product.rows.find((r) => r.ndc.startsWith(code));
}

function ndcResults(index, read) {
  const out = [];
  const add = (i, fields) => {
    if (!out.some((r) => r.product === index.products[i])) out.push({ product: index.products[i], own: false, ...fields });
  };
  if (read.kind === 'product') {
    for (const code of read.codes) {
      for (const i of index.byCode.get(code) || []) add(i, { match: 'ndc-product', matched: rowWithCode(index.products[i], code).ndc, entered: null, code });
    }
  } else {
    for (const ndc of read.ndcs) {
      const i = index.byNdc.get(ndc);
      if (i !== undefined) add(i, { match: 'ndc', matched: ndc, entered: ndc, guess: read.guess });
    }
    if (!out.length) {
      // Not in NADAC, but its labeler and product code is: the same product in another package.
      for (const ndc of read.ndcs) {
        const code = ndc.slice(0, 9);
        for (const i of index.byCode.get(code) || []) add(i, { match: 'ndc-package', matched: rowWithCode(index.products[i], code).ndc, entered: ndc, guess: read.guess });
      }
    }
  }
  const ambiguous = out.length > 1;
  for (const r of out) {
    r.ambiguous = ambiguous;
    const row = r.product.rows.find((x) => x.ndc === r.matched);
    r.printed = row && row.identity && typeof row.identity.package_ndc === 'string' ? row.identity.package_ndc : null;
  }
  // The number as typed is FDA's own form of one reading: that one first. Every reading is listed.
  if (read.digits) {
    const isPrinted = (r) => Boolean(r.printed) && r.printed.replace(/-/g, '') === read.digits;
    out.sort((a, b) => Number(isPrinted(b)) - Number(isPrinted(a)));
  }
  return out;
}

/**
 * Search products. Text that reads as an NDC (readNdc in ndc.js) resolves to its product(s):
 * match 'ndc' for the exact package, 'ndc-package' for the same labeler and product in another
 * package when the exact one is not in the file, 'ndc-product' for a labeler and product code with
 * no package. Those results also say { entered, ambiguous, guess, printed }: the NDC to keep with
 * the card (entered), that the digits fit other products too (ambiguous), that a 12-digit number
 * was read as an NDC (guess), and FDA's own form of the result's NDC (printed).
 *
 * Otherwise a name matches when every query word is a whole word of it or starts one, never
 * inside a word. match is 'exact', 'prefix' or 'tokens', or 'partial' when the letters only start
 * a word other than the name's first (see isPartial). The order is, in turn: how the product
 * meets the query (the TIER_ constants), whether every word was whole, a form to hold back
 * (nameHits), then rankProducts(). Each product appears once. `own` says the matched name is the
 * product's own. A table passed to buildIndex answers a query nothing else fits, and each of those
 * results says which row of it led there (alias).
 *
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} query
 * @param {{ limit?: number }} [opts]
 * @returns {{ product: Product, match: string, matched: string, own: boolean, [key: string]: * }[]}
 */
export function search(index, query, { limit = 20 } = {}) {
  if (typeof query !== 'string' || !query.trim()) return [];
  const read = readNdc(query);
  if (read) {
    const found = ndcResults(index, read);
    if (found.length || read.kind === 'package') return found.slice(0, limit);
  }
  const q = readQuery(query);
  if (!q) return [];
  const hits = nameHits(index, q);
  const alias = index.aliases && (!hits.length || hits[0].tier === TIER_PARTIAL) ? index.aliases.get(q.canonText) : null;
  if (alias) {
    const generic = readQuery(alias.generic);
    if (generic) {
      const via = nameHits(index, generic);
      if (via.length) return via.slice(0, limit).map((h) => ({ ...hitResult(index, h), alias }));
    }
  }
  return hits.slice(0, limit).map((h) => hitResult(index, h));
}

/**
 * What Enter may open from a search's full results, or null to stay on the list: only the query's
 * one result or a product's own exact name. The top of a longer list may not be what was meant,
 * and an ambiguous NDC, a partial match, another package and a guess are for the reader to choose.
 * @param {ReturnType<typeof search>} results
 * @returns {ReturnType<typeof search>[number]|null}
 */
export function enterChoice(results) {
  if (!Array.isArray(results) || !results.length) return null;
  const top = results[0];
  // Two names can read the same once punctuation is gone; then the name typed does not settle it.
  const exact = (r) => r && r.match === 'exact' && r.own;
  if (exact(top)) return exact(results[1]) ? null : top;
  if (results.length !== 1 || top.alias || top.guess) return null;
  // Found only in another name's list of ingredients: ferrous sulfate, in one multivitamin.
  if (top.match === 'tokens' && !top.own) return null;
  return top.match === 'partial' || top.match === 'ndc-package' ? null : top;
}

/**
 * Edit distance between two strings, counting an insertion, a deletion, a substitution or a
 * swap of two neighbouring characters as one edit (optimal string alignment). Stops early and
 * returns max + 1 once the distance must exceed `max`.
 * editDistance('METFROMIN', 'METFORMIN') → 1.
 * @param {string} a
 * @param {string} b
 * @param {number} [max]
 * @returns {number}
 */
export function editDistance(a, b, max = Infinity) {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1);
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[m];
}

/**
 * Spelling suggestions for a query that finds nothing: [{ query, distance }], best first, at
 * most `limit` (default 3). Each query word that is not a word of any product name (and does
 * not start one) is compared with the index vocabulary (buildIndex): words within 2 edits
 * for query words of 5 or more letters, within 1 edit for 3 or 4 letters (see editDistance);
 * shorter words, numbers and NDCs are never corrected. A longer word that merely holds the query
 * is not offered (STATIN is not a misspelling of NYSTATIN), and two edits must keep the first
 * letter (LOPID is not RAPID); one edit may do either.
 * Candidates are ranked by total edits, then by how many products use the word. Only corrected
 * queries for which search() finds something are returned, in normalized upper case:
 * suggest(index, 'metfromin') → [{ query: 'METFORMIN', distance: 1 }]. A query that already finds
 * something gives [].
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} query
 * @param {{ limit?: number }} [opts]
 * @returns {{ query: string, distance: number }[]}
 */
export function suggest(index, query, { limit = 3 } = {}) {
  if (typeof query !== 'string' || !query.trim() || looksLikeNdc(query)) return [];
  if (search(index, query, { limit: 1 }).length) return [];
  const tokens = basic(query);
  if (!tokens.length) return [];
  const vocab = index.vocab instanceof Map ? index.vocab : new Map();
  const words = [...vocab.keys()];
  const options = tokens.map((t) => {
    const canon = SYNONYMS[t] || t;
    const known = vocab.has(t) || vocab.has(canon) || words.some((w) => w.startsWith(t));
    if (known || t.length < SUGGEST_MIN_LENGTH || !WORD_RE.test(t)) return [{ word: t, d: 0 }];
    const max = t.length >= 5 ? 2 : 1;
    const found = [];
    for (const w of words) {
      if (Math.abs(w.length - t.length) > max) continue;
      const d = editDistance(t, w, max);
      if (d > max || (d > 1 && (w.includes(t) || w[0] !== t[0]))) continue;
      found.push({ word: w, d, n: vocab.get(w) });
    }
    found.sort((a, b) => a.d - b.d || b.n - a.n || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
    return found.length ? found.slice(0, 3) : [{ word: t, d: 0 }];
  });
  const candidates = [options.map((o) => o[0])];
  options.forEach((o, i) => {
    for (let k = 1; k < o.length; k++) candidates.push(options.map((x, j) => (j === i ? o[k] : x[0])));
  });
  const scored = candidates
    .map((c) => ({ query: c.map((x) => x.word).join(' '), distance: c.reduce((s, x) => s + x.d, 0) }))
    .filter((c) => c.distance > 0)
    .sort((a, b) => a.distance - b.distance);
  const out = [];
  for (const c of scored) {
    if (out.length >= limit) break;
    if (out.some((o) => o.query === c.query)) continue;
    if (search(index, c.query, { limit: 1 }).length) out.push(Object.freeze(c));
  }
  return out;
}
