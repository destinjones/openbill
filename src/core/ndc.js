// National Drug Codes. OpenBill keys everything on the 11-digit NDC (5-4-2, no hyphens),
// the form NADAC uses. FDA prints 10-digit NDCs with hyphens in one of three layouts
// (4-4-2, 5-3-2, 5-4-1); the hyphens say which segment to pad with a leading zero.
// Without hyphens a 10-digit NDC is ambiguous, so it never normalizes to one NDC. readNdc() is
// what a search box needs: everything a person's text could mean as an NDC, and how sure it is.

const NDC11_RE = /^\d{11}$/;

function clean(input) {
  if (typeof input !== 'string') return null;
  // Allow a leading "NDC" label, whitespace as a segment separator, and the Unicode dashes
  // that copy-paste from PDFs and web pages brings (U+2010-U+2015, U+2212 minus) as hyphens.
  // Dots and slashes separate segments too: 00378.7185.05, 00378/7185/05.
  return input
    .trim()
    .replace(/^NDC[\s:#]*/i, '')
    .trim()
    .replace(/[‐-―−./]/g, '-')
    .replace(/\s*[-\s]\s*/g, '-');
}

/** The digits of cleaned text, with the zeros of a three-digit labeler (378-7185-05) put back. */
function looseDigits(s) {
  const dropped = /^(\d{3})-(\d{4})-(\d{2})$/.exec(s);
  return dropped ? `00${dropped[1]}${dropped[2]}${dropped[3]}` : s.replace(/-/g, '');
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
 * (‐ ‑ ‒ – — ― −), dots and slashes count as hyphens. An unhyphenated
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
 * (4-4-2, 5-3-2, 5-4-1) for an unhyphenated 10-digit string, none for junk. Hyphens in no layout
 * say nothing, so 00378-718-505 is read by its digits alone, and a three-digit labeler
 * (378-7185-05) gets back the zeros a spreadsheet took.
 * @param {*} input
 * @returns {string[]}
 */
export function ndcCandidates(input) {
  const one = normalizeNdc(input);
  if (one) return [one];
  const s = clean(input);
  if (s === null || !/^[\d-]+$/.test(s)) return [];
  const digits = looseDigits(s);
  if (NDC11_RE.test(digits)) return [digits];
  if (!/^\d{10}$/.test(digits)) return [];
  const out = ['0' + digits, digits.slice(0, 5) + '0' + digits.slice(5), digits.slice(0, 9) + '0' + digits.slice(9)];
  return out.filter((x, i) => out.indexOf(x) === i);
}

/**
 * The labeler and product codes the input could mean, as the first 9 digits of an 11-digit NDC:
 * 00378-7185 and 0378-7185 → 003787185; 00378-718 → 003780718; 9 bare digits as they are; 8 bare
 * digits both ways. None for anything else.
 * @param {*} input
 * @returns {string[]}
 */
export function ndcProductCodes(input) {
  const s = clean(input);
  if (s === null) return [];
  if (/^\d{9}$/.test(s)) return [s];
  let m = /^(\d{5})-(\d{4})$/.exec(s);
  if (m) return [m[1] + m[2]];
  m = /^(\d{4})-(\d{4})$/.exec(s);
  if (m) return [`0${m[1]}${m[2]}`];
  m = /^(\d{5})-(\d{3})$/.exec(s);
  if (m) return [`${m[1]}0${m[2]}`];
  m = /^(\d{3})-(\d{4})$/.exec(s);
  if (m) return [`00${m[1]}${m[2]}`];
  if (/^\d{8}$/.test(s)) return [`0${s}`, `${s.slice(0, 5)}0${s.slice(5)}`];
  return [];
}

/** True when the last of 12 digits is the UPC-A check digit of the other 11. */
function upcCheckOk(d) {
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += Number(d[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(d[11]);
}

/**
 * 11-digit NDCs a 12-digit number starting with 3 might hold: 3 + an 11-digit NDC, and, where the
 * last digit checks, 3 + a 10-digit NDC + a check digit. Packages carry 12-digit numbers of
 * several kinds, so this is a guess to show beside a name, never a claim about what was typed.
 */
function ndcsInLongCode(digits) {
  if (!/^3\d{11}$/.test(digits)) return [];
  const out = [digits.slice(1)];
  if (upcCheckOk(digits)) out.push(...ndcCandidates(digits.slice(1, 11)));
  return out.filter((x, i) => out.indexOf(x) === i);
}

/**
 * How a search box's text reads as an NDC, or null when it does not:
 *
 * - { kind: 'package', ndcs, digits, guess: false }: ndcs are the 11-digit NDCs it could mean (one
 *   unless a 10-digit number has no hyphens). digits is what was typed when it could mean several,
 *   which is how FDA's own form reads without its hyphens, else null.
 * - { kind: 'package', ndcs, digits: null, guess: true }: a 12-digit number, read as above.
 * - { kind: 'product', codes }: a labeler and product code with no package.
 *
 * @param {*} query
 * @returns {{ kind: 'package'|'product', [key: string]: * }|null}
 */
export function readNdc(query) {
  const s = clean(query);
  if (s === null || !/^[\d-]+$/.test(s)) return null;
  if (looksLikeNdc(query)) {
    const ndcs = ndcCandidates(query);
    if (ndcs.length) return { kind: 'package', ndcs, digits: ndcs.length > 1 ? s.replace(/-/g, '') : null, guess: false };
  }
  const long = ndcsInLongCode(s.replace(/-/g, ''));
  if (long.length) return { kind: 'package', ndcs: long, digits: null, guess: true };
  const codes = ndcProductCodes(query);
  return codes.length ? { kind: 'product', codes } : null;
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
 * Format the first 9 digits of an NDC as labeler-product: "003787185" → "00378-7185".
 * @param {string} code
 * @returns {string}
 */
export function formatNdcCode(code) {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * True when a search query should be treated as an NDC: only digits and separators (hyphens,
 * spaces, dots, slashes), after an optional leading "NDC", with 10 or 11 digits in total, or a
 * three-digit labeler in 3-4-2.
 * @param {*} query
 * @returns {boolean}
 */
export function looksLikeNdc(query) {
  const s = clean(query);
  if (s === null || !/^[\d-]+$/.test(s)) return false;
  const digits = looseDigits(s).length;
  return digits === 10 || digits === 11;
}
