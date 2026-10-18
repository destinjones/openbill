// Lossless compact form of data/drugs.json (schema openbill.drugs/3) for inlining into
// openbill.html, and linkRows(), which joins each row to the Part D and Part B tables.
//
// The items packed are the rows and the entries of the tables in TABLE_KEYS (part_d_names,
// part_b_codes). Every item is flattened to (path, leaf) pairs. The set of paths and leaf
// types of an item is its "shape"; shapes are interned, so an item is stored as one shape id
// plus its leaf values, and the values are stored column by column (one column per path).
// Strings are interned in one table shared by rows and tables, ordered by frequency, except
// in columns that are mostly unique (NDCs), which store their strings inline. Everything else
// in the doc (schema, sources, counts) is stored as is.
// unpackDrugs(packDrugs(doc)) deep-equals doc, including key order, null, false and
// undefined values, empty objects and arrays.

/** Format version written into every packed doc. */
export const PACK_FORMAT = 'openbill.pack/2';

/** The data/drugs.json schema linkRows() reads. */
export const DRUGS_SCHEMA = 'openbill.drugs/3';

/**
 * Top-level keys of a drugs doc that are tables keyed by name. When one is an object whose
 * values are all objects it is packed column by column with the rows; otherwise it is kept
 * as is.
 */
export const TABLE_KEYS = Object.freeze(['part_d_names', 'part_b_codes']);

// Leaf types in a shape.
const T_STRING = 0;
const T_NUMBER = 1;
const T_TRUE = 2;
const T_FALSE = 3;
const T_NULL = 4;
const T_EMPTY_OBJECT = 5;
const T_JSON = 6; // arrays and anything else: JSON text, interned
const T_UNDEFINED = 7;

// Plain assignment would treat a "__proto__" key as the prototype; define it as data instead.
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isTable(v) {
  return isPlainObject(v) && Object.values(v).every(isPlainObject);
}

function flatten(value, path, out) {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      out.push([path, T_EMPTY_OBJECT, undefined]);
      return;
    }
    for (const k of keys) flatten(value[k], path.concat([k]), out);
    return;
  }
  if (typeof value === 'string') out.push([path, T_STRING, value]);
  else if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`packDrugs: non-finite number at ${path.join('.')}`);
    out.push([path, T_NUMBER, value]);
  } else if (value === true) out.push([path, T_TRUE, undefined]);
  else if (value === false) out.push([path, T_FALSE, undefined]);
  else if (value === null) out.push([path, T_NULL, undefined]);
  else if (value === undefined) out.push([path, T_UNDEFINED, undefined]);
  else if (Array.isArray(value)) out.push([path, T_JSON, JSON.stringify(value)]);
  else throw new Error(`packDrugs: cannot pack a ${typeof value} at ${path.join('.')}`);
}

/**
 * Pack a drugs doc (any object with a `rows` array of JSON values) into a compact,
 * JSON-serializable form. The rows and the entries of the TABLE_KEYS tables share one set of
 * columns and one string table.
 * @param {{ rows: any[] }} doc
 * @returns {object}
 */
export function packDrugs(doc) {
  if (!isPlainObject(doc) || !Array.isArray(doc.rows)) throw new Error('packDrugs needs a doc object with a rows array');
  for (const r of doc.rows) {
    if (Array.isArray(r)) {
      // Arrays inside rows are stored as JSON text; a whole row that is an array is not supported.
      throw new Error('packDrugs: rows must be objects or scalars, not arrays');
    }
  }
  const tables = TABLE_KEYS.filter((k) => hasOwn(doc, k) && isTable(doc[k]));
  const items = [...doc.rows];
  for (const k of tables) items.push(...Object.values(doc[k]));

  const pathIds = new Map();
  const paths = [];
  const shapeIds = new Map();
  const shapes = [];
  const itemShapes = [];
  const columns = []; // per path: [type, value] of its T_STRING, T_NUMBER and T_JSON leaves, in item order

  for (const item of items) {
    const leaves = [];
    flatten(item, [], leaves);
    const shape = [];
    for (const [path, type] of leaves) {
      const key = JSON.stringify(path);
      let id = pathIds.get(key);
      if (id === undefined) {
        id = paths.length;
        pathIds.set(key, id);
        paths.push(path);
        columns.push([]);
      }
      shape.push(id, type);
    }
    const sk = shape.join(',');
    let sid = shapeIds.get(sk);
    if (sid === undefined) {
      sid = shapes.length;
      shapeIds.set(sk, sid);
      shapes.push(shape);
    }
    itemShapes.push(sid);
    for (let k = 0; k < leaves.length; k++) {
      const [, type, v] = leaves[k];
      if (type === T_STRING || type === T_NUMBER || type === T_JSON) columns[shape[2 * k]].push([type, v]);
    }
  }

  // Decide per column whether strings are interned or inline; count interned strings.
  const counts = new Map();
  const firstSeen = new Map();
  const inline = columns.map((col) => {
    const strs = col.filter(([t]) => t !== T_NUMBER);
    if (strs.length === 0) return false;
    const distinct = new Set(strs.map(([, v]) => v)).size;
    return distinct > strs.length * 0.5 && strs.length > 16;
  });
  let order = 0;
  columns.forEach((col, ci) => {
    if (inline[ci]) return;
    for (const [t, v] of col) {
      if (t === T_NUMBER) continue;
      counts.set(v, (counts.get(v) || 0) + 1);
      if (!firstSeen.has(v)) firstSeen.set(v, order++);
    }
  });
  const strings = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || firstSeen.get(a) - firstSeen.get(b));
  const stringId = new Map(strings.map((s, i) => [s, i]));

  const cols = columns.map((col, ci) =>
    col.map(([t, v]) => {
      if (t === T_NUMBER) return v;
      return inline[ci] ? v : stringId.get(v);
    }),
  );

  const head = {};
  for (const k of Object.keys(doc)) if (k !== 'rows' && !tables.includes(k)) setOwn(head, k, doc[k]);

  return {
    format: PACK_FORMAT,
    head,
    keys: Object.keys(doc),
    tables: tables.map((k) => ({ key: k, keys: Object.keys(doc[k]) })),
    strings,
    paths,
    shapes,
    inline: inline.map((x) => (x ? 1 : 0)),
    rows: doc.rows.length,
    items: itemShapes,
    columns: cols,
  };
}

/**
 * Rebuild the original doc from packDrugs() output. Throws on an unknown format.
 * @param {object} packed
 * @returns {object}
 */
export function unpackDrugs(packed) {
  if (!packed || packed.format !== PACK_FORMAT) {
    throw new Error(`unpackDrugs: expected format ${PACK_FORMAT}, got ${packed && JSON.stringify(packed.format)}`);
  }
  const { strings, paths, shapes, inline, columns } = packed;
  const cursor = new Array(columns.length).fill(0);
  const items = new Array(packed.items.length);
  for (let r = 0; r < packed.items.length; r++) {
    const shape = shapes[packed.items[r]];
    let root;
    for (let k = 0; k < shape.length; k += 2) {
      const pid = shape[k];
      const type = shape[k + 1];
      let value;
      switch (type) {
        case T_STRING:
        case T_JSON:
        case T_NUMBER: {
          const raw = columns[pid][cursor[pid]++];
          if (type === T_NUMBER) value = raw;
          else {
            const s = inline[pid] ? raw : strings[raw];
            value = type === T_JSON ? JSON.parse(s) : s;
          }
          break;
        }
        case T_TRUE:
          value = true;
          break;
        case T_FALSE:
          value = false;
          break;
        case T_NULL:
          value = null;
          break;
        case T_EMPTY_OBJECT:
          value = {};
          break;
        case T_UNDEFINED:
          value = undefined;
          break;
        default:
          throw new Error(`unpackDrugs: unknown leaf type ${type}`);
      }
      const path = paths[pid];
      if (path.length === 0) {
        root = value;
        continue;
      }
      if (root === undefined) root = {};
      let obj = root;
      for (let d = 0; d < path.length - 1; d++) {
        const key = path[d];
        if (!hasOwn(obj, key)) setOwn(obj, key, {});
        obj = obj[key];
      }
      setOwn(obj, path[path.length - 1], value);
    }
    items[r] = root;
  }
  const rows = items.slice(0, packed.rows);
  const tables = new Map();
  let at = packed.rows;
  for (const t of packed.tables) {
    const table = {};
    for (const k of t.keys) setOwn(table, k, items[at++]);
    tables.set(t.key, table);
  }
  if (at !== items.length) throw new Error(`unpackDrugs: ${items.length - at} packed items belong to no table`);
  const doc = {};
  for (const k of packed.keys) {
    if (k === 'rows') setOwn(doc, k, rows);
    else if (tables.has(k)) setOwn(doc, k, tables.get(k));
    else setOwn(doc, k, packed.head[k]);
  }
  return doc;
}

const PART_B_CODE_FIELDS = Object.freeze(['hcpcs_dosage', 'short_description', 'payment_limit', 'coinsurance_pct', 'labelers']);
const PART_B_ROW_FIELDS = Object.freeze(['bill_units_per_package', 'package_size', 'package_qty', 'package_unit']);

/**
 * The rows of a schema openbill.drugs/3 doc with `part_d` and `part_b` expanded to the full
 * objects the rules in rules.js read:
 *
 * - part_d: null, or { key, basis, brand_name, generic_name, avg_per_unit, claims, outlier }:
 *   the row's key and basis, then the fields of the part_d_names entry for that key
 * - part_b: null, or { hcpcs, hcpcs_dosage, short_description, payment_limit,
 *   coinsurance_pct, labelers, bill_units_per_package, package_size, package_qty,
 *   package_unit }: the part_b_codes entry for row.part_b.hcpcs, then the row's own
 *   crosswalk fields
 *
 * A field missing from the table entry or the row stays missing; nothing is filled in.
 * Linked rows and their part_d and part_b objects are frozen; the records and arrays inside
 * them are the doc's own objects, shared by every row that points at the same entry, so treat
 * all of it as read-only. Rows with the same Part D key and basis share one part_d object.
 * The doc is not modified. Throws if the doc is not schema openbill.drugs/3, or if a row
 * points at a key its table does not have (a broken build, which must not show as "not found").
 * @param {{ schema: string, rows: object[], part_d_names?: object, part_b_codes?: object }} doc
 * @returns {readonly object[]}
 */
export function linkRows(doc) {
  if (!isPlainObject(doc) || !Array.isArray(doc.rows)) throw new Error('linkRows needs a doc object with a rows array');
  if (doc.schema !== DRUGS_SCHEMA) throw new Error(`linkRows reads schema ${DRUGS_SCHEMA}, got ${JSON.stringify(doc.schema)}`);
  const names = isPlainObject(doc.part_d_names) ? doc.part_d_names : {};
  const codes = isPlainObject(doc.part_b_codes) ? doc.part_b_codes : {};
  const partDCache = new Map();

  const linkPartD = (row) => {
    const { key, basis } = row.part_d;
    if (typeof key !== 'string' || !hasOwn(names, key) || !isPlainObject(names[key])) {
      throw new Error(`linkRows: row ${row.ndc} points at Part D name ${JSON.stringify(key)}, which is not in part_d_names`);
    }
    const ck = JSON.stringify([key, basis]);
    let out = partDCache.get(ck);
    if (!out) {
      out = { key, basis };
      for (const [k, v] of Object.entries(names[key])) if (k !== 'key' && k !== 'basis') setOwn(out, k, v);
      Object.freeze(out);
      partDCache.set(ck, out);
    }
    return out;
  };

  const linkPartB = (row) => {
    const code = row.part_b.hcpcs;
    if (typeof code !== 'string' || !hasOwn(codes, code) || !isPlainObject(codes[code])) {
      throw new Error(`linkRows: row ${row.ndc} points at HCPCS ${JSON.stringify(code)}, which is not in part_b_codes`);
    }
    const entry = codes[code];
    const out = { hcpcs: code };
    for (const k of PART_B_CODE_FIELDS) if (hasOwn(entry, k)) out[k] = entry[k];
    for (const k of PART_B_ROW_FIELDS) if (hasOwn(row.part_b, k)) out[k] = row.part_b[k];
    return Object.freeze(out);
  };

  return Object.freeze(
    doc.rows.map((row) => {
      if (!isPlainObject(row)) throw new Error('linkRows: every row must be an object');
      const linked = {};
      for (const k of Object.keys(row)) {
        let v = row[k];
        if (k === 'part_d' && v) v = linkPartD(row);
        else if (k === 'part_b' && v) v = linkPartB(row);
        setOwn(linked, k, v);
      }
      return Object.freeze(linked);
    }),
  );
}
