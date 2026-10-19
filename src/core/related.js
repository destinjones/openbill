// Which products a drug page links to (docs/ARCHITECTURE.md, "Drug pages"): its brand and
// generic siblings, its FDA pharmacologic classes, and up to five related products in the same
// class. Products are groupProducts() entries (search.js), { name, rows }, over linked rows
// (pack.js linkRows), so row.part_d carries its Part D claims. Pure, DOM-free and deterministic:
// the same products always give the same links in the same order.
//
// Classes come from the FDA NDC Directory: identity.pharm_classes is product.txt's PHARM_CLASSES
// split on ", " (["Factor Xa Inhibitor [EPC]", "Factor Xa Inhibitors [MoA]"]). Only the
// Established Pharmacologic Class entries, tagged "[EPC]", are classes here.
//
// What is read from a product is remembered per product object (and the sibling lookup per
// products array), so building every page stays fast; like linked rows, treat products as
// read-only once they are passed in.

const EPC_TAG = /\s*\[EPC\]$/;

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Class names are ordered ignoring case (FDA writes "l-Thyroxine" beside "Insulin"), then exactly.
const cmpName = (a, b) => cmp(a.toLowerCase(), b.toLowerCase()) || cmp(a, b);

function rowsOf(product) {
  const rows = Array.isArray(product) ? product : product && Array.isArray(product.rows) ? product.rows : null;
  if (!rows) throw new TypeError('expected a product ({ name, rows }) or its rows');
  return rows;
}

function nameOf(product) {
  if (product && typeof product.name === 'string') return product.name;
  const rows = rowsOf(product);
  return rows.length ? rows[0].name : '';
}

/**
 * The display name of an EPC class key: the "[EPC]" tag removed.
 * epcName('Factor Xa Inhibitor [EPC]') → 'Factor Xa Inhibitor'.
 * @param {string} key
 * @returns {string}
 */
export function epcName(key) {
  return String(key).replace(EPC_TAG, '').trim();
}

const norm = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();

function distinctNorm(rows, field) {
  const out = new Set();
  for (const r of rows) {
    const v = r && r.identity && r.identity[field];
    if (typeof v === 'string' && v.trim()) out.add(norm(v));
  }
  return Object.freeze([...out].sort(cmp));
}

function readClasses(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const list = row && row.identity && row.identity.pharm_classes;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== 'string') continue;
      const key = entry.trim();
      if (!EPC_TAG.test(key)) continue;
      const name = epcName(key);
      if (name && !byKey.has(key)) byKey.set(key, Object.freeze({ key, name }));
    }
  }
  return Object.freeze([...byKey.values()].sort((a, b) => cmpName(a.name, b.name) || cmp(a.key, b.key)));
}

function readClaims(rows) {
  let best = null;
  for (const r of rows) {
    const c = r && r.part_d && r.part_d.claims;
    if (c && c.kind === 'count' && typeof c.value === 'number' && Number.isFinite(c.value) && (best === null || c.value > best)) best = c.value;
  }
  return best;
}

const facts = new WeakMap();

// Everything this module reads from one product, read once.
function factsOf(product) {
  const memo = product !== null && typeof product === 'object';
  if (memo && facts.has(product)) return facts.get(product);
  const rows = rowsOf(product);
  const f = Object.freeze({
    name: nameOf(product),
    classes: readClasses(rows),
    names: distinctNorm(rows, 'nonproprietary_name'),
    strengths: distinctNorm(rows, 'strength'),
    forms: distinctNorm(rows, 'dosage_form'),
    claims: readClaims(rows),
  });
  if (memo) facts.set(product, f);
  return f;
}

/**
 * The FDA Established Pharmacologic Classes of a product: the "[EPC]" entries of its rows'
 * identity.pharm_classes, as frozen { key, name } sorted by name then key. `key` keeps the tag
 * exactly as FDA writes it ("Factor Xa Inhibitor [EPC]"), so a class is never confused with a
 * mechanism or chemical-structure entry of the same words; `name` is for display ("Factor Xa
 * Inhibitor"). Sorted by name ignoring case, then exactly. Rows without an FDA identity, or without pharm_classes, add nothing; [] when no
 * row has an EPC entry.
 * @param {{ rows: object[] }|object[]} product
 * @returns {readonly { key: string, name: string }[]}
 */
export function epcClasses(product) {
  return factsOf(product).classes;
}

/**
 * Every EPC class among the products, as a Map from class key to the products in it (frozen,
 * sorted by name). The Map's keys are in order of class name (ignoring case), then key.
 * @param {{ name: string, rows: object[] }[]} products
 * @returns {Map<string, readonly object[]>}
 */
export function classIndex(products) {
  if (!Array.isArray(products)) throw new TypeError('classIndex needs an array of products');
  const byKey = new Map();
  for (const p of products) {
    for (const c of epcClasses(p)) {
      if (!byKey.has(c.key)) byKey.set(c.key, []);
      byKey.get(c.key).push(p);
    }
  }
  const keys = [...byKey.keys()].sort((a, b) => cmpName(epcName(a), epcName(b)) || cmp(a, b));
  const out = new Map();
  for (const k of keys) out.set(k, Object.freeze(byKey.get(k).slice().sort((a, b) => cmp(nameOf(a), nameOf(b)))));
  return out;
}

/**
 * The distinct FDA nonproprietary (generic) names of a product's rows, folded to lower case with
 * spacing tidied, sorted (frozen). [] when no row has an FDA identity. One product's NDCs often
 * spell its ingredient more than one way: labelers write "metformin hcl", "metformin
 * hydrochloride" and even "metformin hydrochloride tablet" for the same tablet.
 * @param {{ rows: object[] }|object[]} product
 * @returns {readonly string[]}
 */
export function nonproprietaryNames(product) {
  return factsOf(product).names;
}

const byNameIndex = new WeakMap();

// products → Map(nonproprietary name → products listing it), built once per products array.
function namesIndex(products) {
  if (byNameIndex.has(products)) return byNameIndex.get(products);
  const m = new Map();
  for (const p of products) {
    for (const n of factsOf(p).names) {
      if (!m.has(n)) m.set(n, []);
      m.get(n).push(p);
    }
  }
  byNameIndex.set(products, m);
  return m;
}

const shares = (a, b) => a.some((x) => b.includes(x));

/**
 * The brand and generic siblings of a product: the other products that share at least one FDA
 * nonproprietary name with it (ELIQUIS 5 MG TABLET, ELIQUIS 2.5 MG TABLET and APIXABAN 5 MG
 * TABLET all list "apixaban"). Sharing one name, not the whole set, because labelers spell one
 * ingredient several ways (nonproprietaryNames); a combination product is one name of its own
 * ("sitagliptin and metformin hydrochloride"), so it is not a sibling of either ingredient.
 * Order: products listing one of this product's FDA strengths first, then those sharing one of
 * its dosage forms, then by name. [] for a product with no FDA identity. Frozen.
 * @param {{ name: string, rows: object[] }} product
 * @param {{ name: string, rows: object[] }[]} products
 * @returns {readonly object[]}
 */
export function siblings(product, products) {
  if (!Array.isArray(products)) throw new TypeError('siblings needs an array of products');
  const mine = factsOf(product);
  if (!mine.names.length) return Object.freeze([]);
  const index = namesIndex(products);
  const found = new Set();
  for (const n of mine.names) for (const p of index.get(n) || []) if (p !== product && nameOf(p) !== mine.name) found.add(p);
  const rank = (p) => {
    const f = factsOf(p);
    return (shares(f.strengths, mine.strengths) ? 0 : 2) + (shares(f.forms, mine.forms) ? 0 : 1);
  };
  return Object.freeze([...found].sort((a, b) => rank(a) - rank(b) || cmp(nameOf(a), nameOf(b))));
}

/**
 * The Medicare Part D claims behind a product: the largest claims count (part_d.claims, a count
 * record on linked rows) among its rows, or null when no row has one. Part D counts claims per
 * brand and generic name, all strengths together.
 * @param {{ rows: object[] }|object[]} product
 * @returns {number|null}
 */
export function partDClaims(product) {
  return factsOf(product).claims;
}

/**
 * Up to `n` products related to `product` through its EPC classes, for the "related" links on
 * its page. Candidates are the other products in any of its classes (from `index`, classIndex()
 * of all products), leaving out its brand and generic siblings (siblings(), linked separately).
 * Each other drug appears once: candidates that share a nonproprietary name (directly or through
 * another candidate) are one drug, represented by the one sharing the most classes, then one of
 * the same FDA dosage form as `product`, then the most Part D claims, then the first by name.
 * The ranking: more classes shared with `product` first, then more Part D claims (a product
 * with claims before one without), then name. Deterministic. Frozen
 * [{ product, classes, claims }]: classes = the shared class keys (sorted), claims =
 * partDClaims() or null. [] for a product with no EPC class.
 * @param {{ name: string, rows: object[] }} product
 * @param {{ name: string, rows: object[] }[]} products
 * @param {Map<string, readonly object[]>} index classIndex(products)
 * @param {number} [n]
 * @returns {readonly { product: object, classes: readonly string[], claims: number|null }[]}
 */
export function related(product, products, index, n = 5) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`related: n must be a whole number 0 or more, got ${n}`);
  if (!(index instanceof Map)) throw new TypeError('related needs classIndex(products) as its third argument');
  const mine = factsOf(product);
  const myClasses = mine.classes.map((c) => c.key);
  if (!myClasses.length || n === 0) return Object.freeze([]);
  const exclude = new Set(siblings(product, products));
  exclude.add(product);

  const shared = new Map(); // candidate product → Set of shared class keys
  for (const key of myClasses) {
    for (const p of index.get(key) || []) {
      if (exclude.has(p) || nameOf(p) === mine.name) continue;
      if (!shared.has(p)) shared.set(p, new Set());
      shared.get(p).add(key);
    }
  }

  // One drug per group of candidates linked by a shared nonproprietary name (union-find).
  const cands = [...shared.entries()].map(([p, keys]) => {
    const f = factsOf(p);
    return { product: p, name: f.name, names: f.names, classes: [...keys].sort(cmp), claims: f.claims, form: shares(f.forms, mine.forms) ? 0 : 1 };
  });
  const parent = cands.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const firstWithName = new Map();
  cands.forEach((c, i) => {
    for (const nm of c.names) {
      if (!firstWithName.has(nm)) firstWithName.set(nm, i);
      else parent[find(i)] = find(firstWithName.get(nm));
    }
  });
  const claimsOr = (c) => (c.claims === null ? -1 : c.claims);
  const better = (a, b) =>
    b.classes.length - a.classes.length || a.form - b.form || claimsOr(b) - claimsOr(a) || cmp(a.name, b.name);
  const best = new Map();
  cands.forEach((c, i) => {
    const root = find(i);
    const cur = best.get(root);
    if (!cur || better(c, cur) < 0) best.set(root, c);
  });

  const ranked = [...best.values()].sort(
    (a, b) =>
      b.classes.length - a.classes.length ||
      (a.claims === null) - (b.claims === null) ||
      (b.claims || 0) - (a.claims || 0) ||
      cmp(a.name, b.name),
  );
  return Object.freeze(ranked.slice(0, n).map((c) => Object.freeze({ product: c.product, classes: Object.freeze(c.classes), claims: c.claims })));
}
