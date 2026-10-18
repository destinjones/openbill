// Product search over the linked rows of data/drugs.json (linkRows() in pack.js). A product
// is every row (NDC) with the same NADAC description (`name`). Index once with
// buildIndex(groupProducts(rows)); each search is a linear scan of precomputed strings, well
// under 10 ms for ~6,000 products. suggest() offers spelling corrections for a query that
// finds nothing.

import { looksLikeNdc, ndcCandidates } from './ndc.js';

/**
 * Abbreviations folded together, so "metformin hydrochloride" finds "METFORMIN HCL".
 * Both the query and the names are mapped to the right-hand form.
 */
export const SYNONYMS = Object.freeze({
  HYDROCHLORIDE: 'HCL',
  HYDROBROMIDE: 'HBR',
  TAB: 'TABLET',
  TABS: 'TABLET',
  TABLETS: 'TABLET',
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

/**
 * Build the search index for a list of products (from groupProducts). `vocab` maps every
 * word of the searchable names (letters only, at least SUGGEST_MIN_LENGTH long, raw and
 * synonym forms) to the number of products whose names use it; suggest() reads it.
 * @param {Product[]} products
 * @returns {{ products: Product[], entries: object[], byNdc: Map<string, number>, vocab: Map<string, number> }}
 */
export function buildIndex(products) {
  const entries = [];
  const byNdc = new Map();
  const vocab = new Map();
  products.forEach((p, i) => {
    for (const ndc of p.ndcs) byNdc.set(ndc, i);
    const words = new Set();
    for (const n of p.names) {
      const rawTokens = basic(n);
      const canonTokens = rawTokens.map((t) => SYNONYMS[t] || t);
      const raw = rawTokens.join(' ');
      const canon = canonTokens.join(' ');
      if (!canon) continue;
      const tokens = [...new Set([...rawTokens, ...canonTokens])];
      entries.push({ i, name: n, own: n === p.name, raw, canon, tokens });
      for (const t of tokens) if (t.length >= SUGGEST_MIN_LENGTH && WORD_RE.test(t)) words.add(t);
    }
    for (const w of words) vocab.set(w, (vocab.get(w) || 0) + 1);
  });
  return { products, entries, byNdc, vocab };
}

const RANKS = ['exact', 'prefix', 'tokens', 'substring'];

/**
 * Search products. A query that looks like an NDC (10 or 11 digits, with or without
 * hyphens) resolves through ndcCandidates() to the exact product(s) and nothing else.
 * Otherwise names are ranked exact > prefix > every query word starts a word of the name >
 * substring. Within a rank, a product whose own NADAC name matches better comes first, so
 * "rosuvastatin" lists ROSUVASTATIN CALCIUM 10 MG TAB before CRESTOR 10 MG TABLET (which
 * matches only through its FDA generic name); then the shorter matched name, then
 * alphabetical. Each product appears once.
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} query
 * @param {{ limit?: number }} [opts]
 * @returns {{ product: Product, match: 'ndc'|'exact'|'prefix'|'tokens'|'substring', matched: string }[]}
 */
export function search(index, query, { limit = 20 } = {}) {
  if (typeof query !== 'string' || !query.trim()) return [];
  if (looksLikeNdc(query)) {
    const out = [];
    for (const ndc of ndcCandidates(query)) {
      const i = index.byNdc.get(ndc);
      if (i !== undefined && !out.some((r) => r.product === index.products[i])) {
        out.push({ product: index.products[i], match: 'ndc', matched: ndc });
      }
    }
    return out.slice(0, limit);
  }
  const qRawTokens = basic(query);
  if (!qRawTokens.length) return [];
  const qCanonTokens = qRawTokens.map((t) => SYNONYMS[t] || t);
  const qRaw = qRawTokens.join(' ');
  const qCanon = qCanonTokens.join(' ');

  const best = new Map(); // product index → { rank, own, len, name }
  for (const e of index.entries) {
    let rank;
    if (e.canon === qCanon || e.raw === qRaw) rank = 0;
    else if (e.canon.startsWith(qCanon) || e.raw.startsWith(qRaw)) rank = 1;
    else if (allTokensPrefix(qRawTokens, qCanonTokens, e.tokens)) rank = 2;
    else if (e.canon.includes(qCanon) || e.raw.includes(qRaw)) rank = 3;
    else continue;
    const prev = best.get(e.i);
    const own = e.own ? rank : RANKS.length; // rank of the product's own NADAC name; none = after all
    if (!prev || rank < prev.rank || (rank === prev.rank && e.raw.length < prev.len)) {
      best.set(e.i, { rank, own: prev ? Math.min(prev.own, own) : own, len: e.raw.length, name: e.name });
    } else if (own < prev.own) {
      prev.own = own;
    }
  }
  const hits = [...best.entries()].map(([i, b]) => ({ i, ...b }));
  hits.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.own !== b.own) return a.own - b.own;
    if (a.len !== b.len) return a.len - b.len;
    const na = index.products[a.i].name;
    const nb = index.products[b.i].name;
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
  return hits.slice(0, limit).map((h) => ({ product: index.products[h.i], match: RANKS[h.rank], matched: h.name }));
}

function allTokensPrefix(rawTokens, canonTokens, nameTokens) {
  for (let k = 0; k < rawTokens.length; k++) {
    const a = rawTokens[k];
    const b = canonTokens[k];
    let found = false;
    for (const t of nameTokens) {
      if (t.startsWith(a) || t.startsWith(b)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
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
 * shorter words, numbers and NDCs are never corrected. Candidates are ranked by total edits,
 * then by how many products use the word. Only corrected queries for which search() finds
 * something are returned, in normalized upper case: suggest(index, 'metfromin') →
 * [{ query: 'METFORMIN', distance: 1 }]. A query that already finds something gives [].
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
      if (d <= max) found.push({ word: w, d, n: vocab.get(w) });
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
