// Which products a drug page links to (docs/ARCHITECTURE.md, "Drug pages"): its brand and
// generic siblings, its FDA pharmacologic classes, up to five related products in the same
// class, and where its NADAC price sits in each class. Products are groupProducts() entries (search.js), { name, rows }, over linked rows
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
 * Most rows in a drug page's table of other strengths, forms and brands, the product itself one
 * of them; the siblings() ranking decides which are kept (decision 52).
 */
export const SIBLING_LIMIT = 24;

/** Fewest other products, priced per the same unit, a class needs for classStanding(). */
export const CLASS_STANDING_MIN = 3;

const middles = new WeakMap();

// The middle NADAC record of a product: the lower middle of its NDCs' NADAC records by value
// (ties by NDC), so it is always one real filed price, never an average of two. Null when the
// product has no usable NADAC record or its NDCs are priced per different units.
function middleNadac(product) {
  const memo = product !== null && typeof product === 'object';
  if (memo && middles.has(product)) return middles.get(product);
  const recs = rowsOf(product)
    .filter((r) => r && r.nadac && r.nadac.kind === 'usd' && typeof r.nadac.value === 'number' && Number.isFinite(r.nadac.value))
    .map((r) => ({ ndc: String(r.ndc), rec: r.nadac }));
  let out = null;
  if (recs.length && new Set(recs.map((x) => x.rec.per)).size === 1) {
    recs.sort((a, b) => a.rec.value - b.rec.value || cmp(a.ndc, b.ndc));
    out = Object.freeze({ record: recs[Math.floor((recs.length - 1) / 2)].rec, ndcs: recs.length, unit: recs[0].rec.per === undefined ? null : recs[0].rec.per });
  }
  if (memo) middles.set(product, out);
  return out;
}

const classMiddles = new WeakMap();

// A class's products priced per one unit, each with its middle NADAC, sorted by that price then
// name; built once per class array and unit.
function classMiddlesOf(list, unit) {
  if (!classMiddles.has(list)) classMiddles.set(list, new Map());
  const byUnit = classMiddles.get(list);
  if (!byUnit.has(unit)) {
    const out = [];
    for (const p of list) {
      const m = middleNadac(p);
      if (m && m.unit === unit) out.push({ product: p, name: nameOf(p), record: m.record });
    }
    out.sort((a, b) => a.record.value - b.record.value || cmp(a.name, b.name));
    byUnit.set(unit, out);
  }
  return byUnit.get(unit);
}

/**
 * Where a product's NADAC price sits among the other products in one of its EPC classes
 * (decision 52): compared per the same unit (EA, ML or GM), each product by its middle NADAC
 * price (the lower middle of its NDCs' prices, so a real filed record). `middle` is the lower
 * middle of the other products' middle prices, again one real filed record, with the product it
 * belongs to; `lower`, `higher` and `same` count the other products whose middle price is below,
 * above or equal to this product's. A unit is one tablet, capsule, mL or gram whatever its
 * strength, so this compares prices per unit, not per dose.
 *
 * Null when the product's NDCs are priced per different units, or fewer than
 * CLASS_STANDING_MIN other products in the class are priced per its unit.
 * @param {{ name: string, rows: object[] }} product
 * @param {readonly object[]} classProducts the class's products (classIndex(products).get(key))
 * @returns {{ unit: string|null, mine: object, mineNdcs: number, middle: object, middleName: string, others: number, lower: number, higher: number, same: number }|null}
 */
export function classStanding(product, classProducts) {
  if (!Array.isArray(classProducts)) throw new TypeError('classStanding needs the products of one class');
  const mine = middleNadac(product);
  if (!mine) return null;
  const name = nameOf(product);
  const others = classMiddlesOf(classProducts, mine.unit).filter((x) => x.product !== product && x.name !== name);
  if (others.length < CLASS_STANDING_MIN) return null;
  const mid = others[Math.floor((others.length - 1) / 2)];
  const v = mine.record.value;
  let lower = 0;
  let higher = 0;
  for (const x of others) {
    if (x.record.value < v) lower += 1;
    else if (x.record.value > v) higher += 1;
  }
  return Object.freeze({
    unit: mine.unit,
    mine: mine.record,
    mineNdcs: mine.ndcs,
    middle: mid.record,
    middleName: mid.name,
    others: others.length,
    lower,
    higher,
    same: others.length - lower - higher,
  });
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
