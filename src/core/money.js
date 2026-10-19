// Money and number formatting with exact decimal arithmetic.
//
// Prices arrive as JavaScript numbers parsed from source files that print at most five
// decimals (NADAC). A number's shortest round-trip string (String(x)) is exactly the decimal
// the source printed, so every function here works on that decimal string with BigInt
// integers, never on binary floating point: 1.15 × 100 is 115 here, not
// 114.99999999999999. Rounding is half-up (half away from zero). No Intl and no
// toLocaleString, so the output is identical in every environment.

const MULTIPLY = '×';
const ELLIPSIS_PRICE = '<$0.00001';
const ELLIPSIS_CENT = '<$0.01';
const ELLIPSIS_MULTIPLE = '<0.01' + MULTIPLY;

/**
 * Parse a number or a plain decimal string into an exact decimal { int, scale },
 * meaning int / 10^scale. Throws on anything that is not a finite decimal: a blank or
 * unparseable value is never read as 0.
 * @param {number|string|bigint} x
 * @returns {{ int: bigint, scale: number }}
 */
export function toDecimal(x) {
  if (typeof x === 'bigint') return { int: x, scale: 0 };
  let s;
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) throw new RangeError(`not a finite number: ${x}`);
    s = String(x);
  } else if (typeof x === 'string') {
    s = x.trim();
  } else {
    throw new TypeError(`not a number: ${x === null ? 'null' : typeof x}`);
  }
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m || ((m[2] || '') === '' && (m[3] || '') === '')) {
    throw new TypeError(`not a decimal number: ${JSON.stringify(x)}`);
  }
  const frac = m[3] || '';
  const exp = m[4] ? parseInt(m[4], 10) : 0;
  let int = BigInt((m[2] || '0') + frac);
  let scale = frac.length - exp;
  if (scale < 0) {
    int *= 10n ** BigInt(-scale);
    scale = 0;
  }
  if (m[1] === '-') int = -int;
  return trimDecimal({ int, scale });
}

function trimDecimal(d) {
  let { int, scale } = d;
  while (scale > 0 && int % 10n === 0n) {
    int /= 10n;
    scale -= 1;
  }
  return { int, scale };
}

function roundDecimal(d, dp) {
  if (d.scale <= dp) return { int: d.int * 10n ** BigInt(dp - d.scale), scale: dp };
  const f = 10n ** BigInt(d.scale - dp);
  const neg = d.int < 0n;
  const a = neg ? -d.int : d.int;
  let q = a / f;
  if ((a % f) * 2n >= f) q += 1n;
  return { int: neg ? -q : q, scale: dp };
}

function mulDecimal(a, b) {
  return { int: a.int * b.int, scale: a.scale + b.scale };
}

function divDecimal(a, b, dp) {
  if (b.int === 0n) throw new RangeError('division by zero');
  // a/b = (a.int / 10^a.scale) / (b.int / 10^b.scale); keep one extra digit to round half-up.
  let num = a.int * 10n ** BigInt(b.scale + dp + 1);
  let den = b.int * 10n ** BigInt(a.scale);
  const neg = (num < 0n) !== (den < 0n);
  if (num < 0n) num = -num;
  if (den < 0n) den = -den;
  const q = num / den; // truncated, dp + 1 digits
  let r = q / 10n;
  if (q % 10n >= 5n) r += 1n;
  return { int: neg ? -r : r, scale: dp };
}

function plainDigits(d) {
  const neg = d.int < 0n;
  let digits = (neg ? -d.int : d.int).toString();
  if (d.scale > 0) digits = digits.padStart(d.scale + 1, '0');
  const whole = d.scale > 0 ? digits.slice(0, digits.length - d.scale) : digits;
  const frac = d.scale > 0 ? digits.slice(digits.length - d.scale) : '';
  return { neg, whole, frac };
}

function groupThousands(whole) {
  let out = '';
  for (let i = 0; i < whole.length; i++) {
    if (i > 0 && (whole.length - i) % 3 === 0) out += ',';
    out += whole[i];
  }
  return out;
}

function render(d, { grouped = true, minDp = 0 } = {}) {
  const { neg, whole, frac } = plainDigits(d);
  let f = frac.replace(/0+$/, '');
  if (f.length < minDp) f = f.padEnd(minDp, '0');
  const isZero = /^0*$/.test(whole + f);
  const body = (grouped ? groupThousands(whole) : whole) + (f ? '.' + f : '');
  return { neg: neg && !isZero, body };
}

function requireFinite(x, what) {
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    throw new TypeError(`${what} needs a finite number, got ${x === null ? 'null' : typeof x === 'number' ? x : typeof x}`);
  }
}

/**
 * The exact decimal string of a number or decimal string, without exponent notation.
 * decimalString(0.1) → "0.1"; decimalString(1e-7) → "0.0000001".
 * @param {number|string} x
 * @returns {string}
 */
export function decimalString(x) {
  const r = render(toDecimal(x), { grouped: false });
  return (r.neg ? '-' : '') + r.body;
}

/**
 * Round half-up (half away from zero) to `dp` decimals, exactly, and return a number.
 * roundHalfUp(1.005, 2) → 1.01 (binary floating point would give 1).
 * @param {number|string} x
 * @param {number} dp
 * @returns {number}
 */
export function roundHalfUp(x, dp) {
  if (!Number.isInteger(dp) || dp < 0) throw new RangeError(`dp must be a non-negative integer, got ${dp}`);
  return decimalToNumber(roundDecimal(toDecimal(x), dp));
}

function decimalToNumber(d) {
  const r = render(d, { grouped: false });
  return Number((r.neg ? '-' : '') + r.body);
}

/**
 * Dollars as an integer number of cents, rounded half-up. toCents(0.875) → 88.
 * @param {number} dollars
 * @returns {number}
 */
export function toCents(dollars) {
  requireFinite(dollars, 'toCents');
  return Number(roundDecimal(toDecimal(dollars), 2).int);
}

/**
 * Dollars as an integer number of hundred-thousandths of a dollar (NADAC's precision),
 * rounded half-up. toHundredThousandths(0.01451) → 1451.
 * @param {number} dollars
 * @returns {number}
 */
export function toHundredThousandths(dollars) {
  requireFinite(dollars, 'toHundredThousandths');
  return Number(roundDecimal(toDecimal(dollars), 5).int);
}

/**
 * Dollars rounded half-up to cents, as a number. roundMoney(0.8706) → 0.87.
 * @param {number} dollars
 * @returns {number}
 */
export function roundMoney(dollars) {
  requireFinite(dollars, 'roundMoney');
  return decimalToNumber(roundDecimal(toDecimal(dollars), 2));
}

/**
 * Format dollars to cents, half-up, with thousands separators: "$0.87", "$1,234.57",
 * "-$1.00". Throws on a missing or non-finite value instead of printing "$0.00". A non-zero
 * amount under half a cent is "<$0.01" (or "-<$0.01"), never "$0.00"; only 0 itself is
 * "$0.00". Per-unit prices (NADAC, Part B per unit, coinsurance per billing unit) belong
 * in formatUnitPrice, which keeps their precision.
 * @param {number} dollars
 * @returns {string}
 */
export function formatMoney(dollars) {
  requireFinite(dollars, 'formatMoney');
  const d = roundDecimal(toDecimal(dollars), 2);
  if (d.int === 0n && dollars !== 0) return dollars > 0 ? ELLIPSIS_CENT : '-' + ELLIPSIS_CENT;
  const r = render(d, { minDp: 2 });
  return (r.neg ? '-$' : '$') + r.body;
}

/**
 * Format a per-unit price exactly to the source's precision, up to 5 decimals (rounded
 * half-up beyond that), trailing zeros trimmed, at least 2 decimals, thousands separators:
 * "$0.01451", "$0.0788", "$5.52114", "$29,874.448", "$1.00". A positive price too small
 * to show at 5 decimals is "<$0.00001", never "$0.00".
 * @param {number} dollars
 * @returns {string}
 */
export function formatUnitPrice(dollars) {
  requireFinite(dollars, 'formatUnitPrice');
  const d = roundDecimal(toDecimal(dollars), 5);
  if (d.int === 0n && dollars !== 0) return dollars > 0 ? ELLIPSIS_PRICE : '-' + ELLIPSIS_PRICE;
  const r = render(d, { minDp: 2 });
  return (r.neg ? '-$' : '$') + r.body;
}

function parseQuantity(qty) {
  if (typeof qty === 'number' && !Number.isFinite(qty)) throw new RangeError(`quantity must be finite, got ${qty}`);
  if (typeof qty !== 'number' && typeof qty !== 'string') throw new TypeError(`quantity must be a number, got ${qty === null ? 'null' : typeof qty}`);
  const d = toDecimal(qty);
  if (d.scale > 3) throw new RangeError(`quantity has more than 3 decimals: ${qty}`);
  if (d.int <= 0n) throw new RangeError(`quantity must be greater than 0, got ${qty}`);
  if (d.int > 9999n * 10n ** BigInt(d.scale)) throw new RangeError(`quantity must be at most 9999, got ${qty}`);
  return d;
}

/**
 * Check a quantity the way multiplyMoney does. Returns null when it is usable, else a
 * plain sentence saying why not (for the page to show).
 * @param {number|string} qty
 * @returns {string|null}
 */
export function quantityProblem(qty) {
  try {
    parseQuantity(qty);
    return null;
  } catch (e) {
    return `Quantity ${String(qty)} is not usable: ${e.message}.`;
  }
}

/**
 * Exact unit price × quantity, as a number equal to the exact decimal product (round it
 * for display with formatMoney or roundMoney). multiplyMoney(0.01451, 60) → 0.8706.
 * The quantity may have up to 3 decimals and must be > 0 and ≤ 9999; anything else throws.
 * @param {number} unit dollars per unit
 * @param {number|string} qty
 * @returns {number}
 */
export function multiplyMoney(unit, qty) {
  requireFinite(unit, 'multiplyMoney');
  const q = parseQuantity(qty);
  return decimalToNumber(trimDecimal(mulDecimal(toDecimal(unit), q)));
}

/**
 * Exact product of two decimals as a plain decimal string. multiplyDecimal(0.1, 0.2) → "0.02".
 * @param {number|string} a
 * @param {number|string} b
 * @returns {string}
 */
export function multiplyDecimal(a, b) {
  const r = render(trimDecimal(mulDecimal(toDecimal(a), toDecimal(b))), { grouped: false });
  return (r.neg ? '-' : '') + r.body;
}

/**
 * Exact difference a − b as a plain decimal string. subtractDecimal(1, 0.92) → "0.08".
 * @param {number|string} a
 * @param {number|string} b
 * @returns {string}
 */
export function subtractDecimal(a, b) {
  const x = toDecimal(a);
  const y = toDecimal(b);
  const scale = Math.max(x.scale, y.scale);
  const int = x.int * 10n ** BigInt(scale - x.scale) - y.int * 10n ** BigInt(scale - y.scale);
  const r = render(trimDecimal({ int, scale }), { grouped: false });
  return (r.neg ? '-' : '') + r.body;
}

/**
 * a ÷ b computed exactly and rounded half-up to `dp` decimals (default 10), as a number.
 * Throws when b is 0.
 * @param {number|string} a
 * @param {number|string} b
 * @param {number} [dp]
 * @returns {number}
 */
export function divideMoney(a, b, dp = 10) {
  if (!Number.isInteger(dp) || dp < 0) throw new RangeError(`dp must be a non-negative integer, got ${dp}`);
  return decimalToNumber(trimDecimal(divDecimal(toDecimal(a), toDecimal(b), dp)));
}

/**
 * Format a spread multiple with the multiplication sign U+00D7:
 * below 1 → 2 decimals ("0.92×"); 1 to under 100 → 1 decimal ("4.9×", "11.5×");
 * 100 and up → a whole number with separators ("167×", "1,024×"). The precision is
 * chosen from the rounded value, so 0.996 is "1.0×" and 99.96 is "100×". A positive ratio
 * under 0.005 is "<0.01×", never "0.00×"; only 0 itself is "0.00×".
 * @param {number} ratio
 * @returns {string}
 */
export function formatMultiple(ratio) {
  requireFinite(ratio, 'formatMultiple');
  if (ratio < 0) throw new RangeError(`a multiple cannot be negative: ${ratio}`);
  const d = toDecimal(ratio);
  const two = roundDecimal(d, 2);
  if (two.int === 0n && ratio > 0) return ELLIPSIS_MULTIPLE;
  if (two.int < 100n) return render(two, { minDp: 2 }).body + MULTIPLY;
  const one = roundDecimal(d, 1);
  if (one.int < 1000n) return render(one, { minDp: 1 }).body + MULTIPLY;
  return render(roundDecimal(d, 0)).body + MULTIPLY;
}

function cmpDecimal(a, b) {
  const s = Math.max(a.scale, b.scale);
  const x = a.int * 10n ** BigInt(s - a.scale);
  const y = b.int * 10n ** BigInt(s - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * formatMultiple(ratio), with as many more decimals as it takes for a ratio strictly between
 * `low` and `high` never to be shown as `low`, `high` or beyond them. A rule tested on the
 * unrounded ratio then never disagrees with what the reader sees:
 * formatMultipleWithin(0.2046, 0.2, 20) → "0.205×" (formatMultiple gives "0.20×");
 * formatMultipleWithin(19.97, 0.2, 20) → "19.97×" (not "20.0×"). A ratio outside the open
 * interval, or one whose usual form already lies inside it, is formatted as formatMultiple.
 * @param {number} ratio
 * @param {number} low
 * @param {number} high
 * @returns {string}
 */
export function formatMultipleWithin(ratio, low, high) {
  const shown = formatMultiple(ratio);
  requireFinite(low, 'formatMultipleWithin');
  requireFinite(high, 'formatMultipleWithin');
  if (!(ratio > low && ratio < high)) return shown;
  const lo = toDecimal(low);
  const hi = toDecimal(high);
  const inside = (d) => cmpDecimal(d, lo) > 0 && cmpDecimal(d, hi) < 0;
  if (!shown.startsWith('<') && inside(toDecimal(shown.slice(0, -MULTIPLY.length).replace(/,/g, '')))) return shown;
  const d = toDecimal(ratio);
  const start = ratio < 1 ? 3 : ratio < 100 ? 2 : 1;
  for (let dp = start; dp <= Math.max(start, d.scale); dp++) {
    const r = roundDecimal(d, dp);
    if (inside(r)) return render(r, { minDp: dp }).body + MULTIPLY;
  }
  return render(d).body + MULTIPLY;
}

/**
 * Format a percentage given as a number of percent (20 means 20%), rounded half-up to
 * at most 2 decimals, trailing zeros trimmed: formatPercent(20) → "20%", 18.4 → "18.4%".
 * @param {number} pct
 * @returns {string}
 */
export function formatPercent(pct) {
  requireFinite(pct, 'formatPercent');
  const r = render(roundDecimal(toDecimal(pct), 2));
  return (r.neg ? '-' : '') + r.body + '%';
}

/**
 * Format an exact decimal (a number or a plain decimal string, such as multiplyDecimal()'s
 * result) with thousands separators and every digit kept: formatDecimal('1234.567891') →
 * "1,234.567891", formatDecimal(0.5) → "0.5". Unlike formatCount, a string is read exactly,
 * so a product with more digits than a JavaScript number holds is not rounded.
 * @param {number|string} x
 * @returns {string}
 */
export function formatDecimal(x) {
  const r = render(toDecimal(x));
  return (r.neg ? '-' : '') + r.body;
}

/**
 * Format a count with thousands separators, keeping any decimals exactly:
 * formatCount(14847081) → "14,847,081", formatCount(2.5) → "2.5".
 * @param {number} n
 * @returns {string}
 */
export function formatCount(n) {
  requireFinite(n, 'formatCount');
  const r = render(toDecimal(n));
  return (r.neg ? '-' : '') + r.body;
}
