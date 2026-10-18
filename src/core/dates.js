// ISO calendar dates (YYYY-MM-DD), always in UTC. "Today" is always passed in; nothing here
// reads the clock.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

/**
 * True for a string YYYY-MM-DD that is a real calendar date (2024-02-29 yes, 2026-02-29 no).
 * @param {*} s
 * @returns {boolean}
 */
export function isIsoDate(s) {
  if (typeof s !== 'string') return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

function daysInMonth(y, mo) {
  if (mo === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(mo) ? 30 : 31;
}

function utcMs(s) {
  if (!isIsoDate(s)) throw new RangeError(`not an ISO calendar date: ${JSON.stringify(s)}`);
  const [y, mo, d] = s.split('-').map(Number);
  return Date.UTC(y, mo - 1, d);
}

/**
 * Whole UTC days from date a to date b (positive when b is later). Throws on a non-date.
 * daysBetween('2026-10-14', '2026-10-17') → 3.
 * @param {string} a ISO date
 * @param {string} b ISO date
 * @returns {number}
 */
export function daysBetween(a, b) {
  return Math.round((utcMs(b) - utcMs(a)) / DAY_MS);
}

/**
 * The UTC calendar date of a Date object as YYYY-MM-DD. Throws on an invalid Date.
 * @param {Date} dateObj
 * @returns {string}
 */
export function isoDate(dateObj) {
  if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) {
    throw new TypeError('isoDate needs a valid Date');
  }
  const y = dateObj.getUTCFullYear();
  if (y < 0 || y > 9999) throw new RangeError(`year out of range: ${y}`);
  const mo = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getUTCDate()).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${mo}-${d}`;
}

/**
 * Split a period "YYYY-MM-DD/YYYY-MM-DD" into { start, end }, or null if it is not one
 * (both real dates, start not after end).
 * @param {*} period
 * @returns {{ start: string, end: string } | null}
 */
export function parsePeriod(period) {
  if (typeof period !== 'string') return null;
  const parts = period.split('/');
  if (parts.length !== 2 || !isIsoDate(parts[0]) || !isIsoDate(parts[1])) return null;
  if (parts[0] > parts[1]) return null;
  return { start: parts[0], end: parts[1] };
}
