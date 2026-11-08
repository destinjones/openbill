// Everything after the # in the page's address, read in one place (decision 53). The part after
// # never leaves the browser, and anyone can write one, so everything here is untrusted text.
//
// To add a key: put it in HASH_KEYS, and parseHash() returns it beside the others, as written
// (null when absent). Check the value where it is used: a quantity goes through quantityProblem(),
// an amount through parsePaid(), an NDC through normalizeNdc(), and anything shown back goes
// through clipText() and esc().

/**
 * The keys OpenBill writes. A fragment made only of other keys (#utm_source=reddit) is someone
 * else's, and leaves the card alone.
 */
export const HASH_KEYS = Object.freeze(['drug', 'qty', 'paid', 'ndc']);

/** The longest search text: #q's maxlength, and the most of a drug name read from an address. */
export const QUERY_MAX_CHARS = 200;

/** The most of a reader's or a link's text the page repeats back in a sentence. */
export const REFLECT_MAX_CHARS = 80;

/**
 * Text cut to `max` UTF-16 units with an ellipsis, never through a surrogate pair, so a long
 * value in a link cannot fill the card with words of the sender's choosing.
 * @param {*} value
 * @param {number} [max]
 * @returns {string}
 */
export function clipText(value, max = REFLECT_MAX_CHARS) {
  const s = String(value);
  if (s.length <= max) return s;
  const code = s.charCodeAt(max - 1);
  const cut = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return `${s.slice(0, cut)}…`;
}

/** The address of a card: #drug=<name>[&qty=<n>][&paid=<dollars>][&ndc=<11 digits>]. */
export function hashFor(name, qty, paid, ndc) {
  const q = qty === undefined || qty === null || qty === '' ? '' : `&qty=${encodeURIComponent(String(qty))}`;
  const p = paid ? `&paid=${encodeURIComponent(paid)}` : '';
  const n = ndc ? `&ndc=${encodeURIComponent(ndc)}` : '';
  return `#drug=${encodeURIComponent(name)}${q}${p}${n}`;
}

/**
 * A name for comparing by hand-typed spelling: trimmed, runs of whitespace as one space, upper case.
 * @param {*} name
 * @returns {string}
 */
export function nameKey(name) {
  return String(name).trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * nameKey() → the one name with that key, for looking a retyped or lower-cased name up. Two names
 * with one key map to null: a link must never open a guess.
 * @param {Iterable<string>} names
 * @returns {Map<string, string|null>}
 */
export function caselessNames(names) {
  const map = new Map();
  for (const name of names) {
    const key = nameKey(name);
    map.set(key, map.has(key) ? null : name);
  }
  return map;
}

const NO_DRUG = 'The address names no drug (it needs #drug=<name>).';

// Control characters other than whitespace, which nameKey() folds: a name of only these is no name.
const CONTROL_CHARS = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;

const cleanName = (text) => text.replace(CONTROL_CHARS, '').trim();

/**
 * Read a location.hash (with or without its #) into one of:
 *
 * - { kind: 'default' }: nothing after the #
 * - { kind: 'card', drug, qty, paid, ndc, bare }: a card to open. Each HASH_KEYS value is as written,
 *   null when absent, the first when repeated; drug has no control characters, is trimmed and is at
 *   most QUERY_MAX_CHARS long. bare is true for a #NAME with no drug= before it, as #NAME&qty=45.
 * - { kind: 'anchor', anchor }: a plain in-page fragment (anchor is its text, as #card, #main or
 *   #ndc-00093104801), or only someone else's parameters (anchor is null). Never an error: it is
 *   not addressed to OpenBill.
 * - { kind: 'bad', problem }: an OpenBill address with no drug in it, as #drug= or #qty=30, with a
 *   plain sentence saying so.
 *
 * A fragment with no key is a drug when it holds whitespace, which no HTML id can, or when
 * isName(text) says it is a product; otherwise it is an anchor. So #ELIQUIS%205%20MG%20TABLET opens
 * a card and #card never does. The first part before an & is read the same way when the others are
 * OpenBill's keys. This module knows no products, so the caller passes isName.
 *
 * @param {string} hash
 * @param {{ isName?: (text: string) => boolean }} [options]
 * @returns {{ kind: string, [key: string]: * }}
 */
export function parseHash(hash, { isName = () => false } = {}) {
  const raw = String(hash === undefined || hash === null ? '' : hash).replace(/^#/, '');
  if (raw === '') return { kind: 'default' };
  // URLSearchParams never throws on a bad escape, and it decodes + as a space.
  const params = new URLSearchParams(raw);
  const bareName = (text) => {
    const name = cleanName(text).slice(0, QUERY_MAX_CHARS);
    return name && (/\s/.test(name) || isName(name)) ? name : '';
  };
  if (!raw.includes('=') && !raw.includes('&')) {
    const drug = bareName([...params.keys()].join(''));
    return drug ? { kind: 'card', drug, qty: null, paid: null, ndc: null, bare: true } : { kind: 'anchor', anchor: raw };
  }
  if (!HASH_KEYS.some((k) => params.has(k))) return { kind: 'anchor', anchor: null };
  let drug = cleanName(params.get('drug') || '');
  let bare = false;
  if (!params.has('drug')) {
    const [first, value] = params.entries().next().value;
    if (value === '' && !HASH_KEYS.includes(first)) drug = bareName(first);
    bare = drug !== '';
  }
  if (drug === '') return { kind: 'bad', problem: NO_DRUG };
  const out = { kind: 'card', bare };
  for (const k of HASH_KEYS) out[k] = params.get(k);
  out.drug = drug.slice(0, QUERY_MAX_CHARS);
  return out;
}
