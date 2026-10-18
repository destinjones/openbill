// National Drug Codes. OpenBill keys everything on the 11-digit NDC (5-4-2, no hyphens),
// the form NADAC uses. FDA prints 10-digit NDCs with hyphens in one of three layouts
// (4-4-2, 5-3-2, 5-4-1); the hyphens say which segment to pad with a leading zero.
// Without hyphens a 10-digit NDC is ambiguous, so it never normalizes to one NDC.

const NDC11_RE = /^\d{11}$/;

function clean(input) {
  if (typeof input !== 'string') return null;
  // Allow a leading "NDC" label, whitespace as a segment separator, and the Unicode dashes
  // that copy-paste from PDFs and web pages brings (U+2010-U+2015, U+2212 minus) as hyphens.
  return input
    .trim()
    .replace(/^NDC[\s:#]*/i, '')
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s*[-\s]\s*/g, '-');
}

/**
 * True for exactly 11 digits.
 * @param {*} s
 * @returns {boolean}
 */
export function isNdc11(s) {
  return typeof s === 'string' && NDC11_RE.test(s);
}

/**
 * Normalize an NDC to 11 digits, or null. Accepts 11 digits ("00378718505"), 5-4-2
 * ("00378-7185-05") and the hyphenated 10-digit layouts 4-4-2, 5-3-2 and 5-4-1 (the short
 * segment is padded). Surrounding spaces and a leading "NDC" are ignored; Unicode dashes
 * (‐ ‑ ‒ – — ― −) count as hyphens. An unhyphenated
 * 10-digit string is ambiguous and gives null (see ndcCandidates). Junk gives null.
 * @param {*} input
 * @returns {string|null}
 */
export function normalizeNdc(input) {
  const s = clean(input);
  if (s === null) return null;
  if (NDC11_RE.test(s)) return s;
  let m = /^(\d{5})-(\d{4})-(\d{2})$/.exec(s);
  if (m) return m[1] + m[2] + m[3];
  m = /^(\d{4})-(\d{4})-(\d{2})$/.exec(s);
  if (m) return '0' + m[1] + m[2] + m[3];
  m = /^(\d{5})-(\d{3})-(\d{2})$/.exec(s);
  if (m) return m[1] + '0' + m[2] + m[3];
  m = /^(\d{5})-(\d{4})-(\d{1})$/.exec(s);
  if (m) return m[1] + m[2] + '0' + m[3];
  return null;
}

/**
 * Every 11-digit NDC the input could mean: one for an unambiguous NDC, the three paddings
 * (4-4-2, 5-3-2, 5-4-1) for an unhyphenated 10-digit string, none for junk.
 * @param {*} input
 * @returns {string[]}
 */
export function ndcCandidates(input) {
  const one = normalizeNdc(input);
  if (one) return [one];
  const s = clean(input);
  if (s === null || !/^\d{10}$/.test(s)) return [];
  const out = ['0' + s, s.slice(0, 5) + '0' + s.slice(5), s.slice(0, 9) + '0' + s.slice(9)];
  return out.filter((x, i) => out.indexOf(x) === i);
}

/**
 * Format an 11-digit NDC as 5-4-2 with hyphens: "00378718505" → "00378-7185-05".
 * Throws on anything that is not 11 digits.
 * @param {string} ndc11
 * @returns {string}
 */
export function formatNdc(ndc11) {
  if (!isNdc11(ndc11)) throw new TypeError(`not an 11-digit NDC: ${JSON.stringify(ndc11)}`);
  return `${ndc11.slice(0, 5)}-${ndc11.slice(5, 9)}-${ndc11.slice(9)}`;
}

/**
 * True when a search query should be treated as an NDC: only digits, hyphens and spaces
 * (after an optional leading "NDC"), with 10 or 11 digits in total.
 * @param {*} query
 * @returns {boolean}
 */
export function looksLikeNdc(query) {
  const s = clean(query);
  if (s === null || !/^[\d-]+$/.test(s)) return false;
  const digits = s.replace(/-/g, '').length;
  return digits === 10 || digits === 11;
}
