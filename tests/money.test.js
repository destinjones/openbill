import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toDecimal,
  decimalString,
  roundHalfUp,
  toCents,
  toHundredThousandths,
  roundMoney,
  formatMoney,
  formatUnitPrice,
  quantityProblem,
  multiplyMoney,
  multiplyDecimal,
  subtractDecimal,
  divideMoney,
  formatMultiple,
  formatMultipleWithin,
  formatPercent,
  formatCount,
  formatDecimal,
} from '../src/core/money.js';

test('toDecimal parses numbers and decimal strings exactly', () => {
  assert.deepEqual(toDecimal(0.01451), { int: 1451n, scale: 5 });
  assert.deepEqual(toDecimal('29874.448'), { int: 29874448n, scale: 3 });
  assert.deepEqual(toDecimal(1e-7), { int: 1n, scale: 7 });
  assert.deepEqual(toDecimal(1e21), { int: 10n ** 21n, scale: 0 });
  assert.deepEqual(toDecimal('-1.50'), { int: -15n, scale: 1 });
  assert.deepEqual(toDecimal(' .5 '), { int: 5n, scale: 1 });
  assert.deepEqual(toDecimal(5n), { int: 5n, scale: 0 });
});

test('toDecimal never reads a blank or junk value as 0', () => {
  for (const bad of ['', ' ', '.', 'abc', '1,000', '1.2.3', '$1', '--1']) {
    assert.throws(() => toDecimal(bad), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => toDecimal(NaN), RangeError);
  assert.throws(() => toDecimal(Infinity), RangeError);
  assert.throws(() => toDecimal(null), TypeError);
  assert.throws(() => toDecimal(undefined), TypeError);
  assert.throws(() => toDecimal({}), TypeError);
});

test('decimalString is exact and never uses exponent notation', () => {
  assert.equal(decimalString(0.1), '0.1');
  assert.equal(decimalString(1e-7), '0.0000001');
  assert.equal(decimalString(1e21), '1000000000000000000000');
  assert.equal(decimalString('60.000'), '60');
  assert.equal(decimalString(-0), '0');
  assert.equal(decimalString(-2.5), '-2.5');
});

test('roundHalfUp rounds exact halves away from zero', () => {
  assert.equal(roundHalfUp(1.005, 2), 1.01); // binary float: Math.round(1.005*100)/100 === 1
  assert.equal(roundHalfUp(2.675, 2), 2.68);
  assert.equal(roundHalfUp(0.125, 2), 0.13);
  assert.equal(roundHalfUp(-0.125, 2), -0.13);
  assert.equal(roundHalfUp(0.124999, 2), 0.12);
  assert.equal(roundHalfUp(7.5, 0), 8);
  assert.equal(roundHalfUp(6.5, 0), 7);
  assert.equal(roundHalfUp(3, 2), 3);
  assert.throws(() => roundHalfUp(1, -1), RangeError);
  assert.throws(() => roundHalfUp(1, 1.5), RangeError);
});

test('toCents and toHundredThousandths give integers, half-up', () => {
  assert.equal(toCents(0.875), 88);
  assert.equal(toCents(1.005), 101);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(toCents(-1.005), -101);
  assert.equal(toHundredThousandths(0.01451), 1451);
  assert.equal(toHundredThousandths(29874.448), 2987444800);
  assert.equal(toHundredThousandths(0.000015), 2);
  assert.throws(() => toCents(null), TypeError);
  assert.throws(() => toHundredThousandths(NaN), TypeError);
});

test('roundMoney rounds to cents, half-up', () => {
  assert.equal(roundMoney(0.8706), 0.87);
  assert.equal(roundMoney(0.865), 0.87);
  assert.equal(roundMoney(0.1 + 0.2), 0.3);
  assert.equal(roundMoney(1234.565), 1234.57);
  assert.throws(() => roundMoney(undefined), TypeError);
});

test('formatMoney', () => {
  assert.equal(formatMoney(0.87), '$0.87');
  assert.equal(formatMoney(0.8706), '$0.87');
  assert.equal(formatMoney(1234.567), '$1,234.57');
  assert.equal(formatMoney(1234.565), '$1,234.57');
  assert.equal(formatMoney(1.005), '$1.01');
  assert.equal(formatMoney(0.005), '$0.01');
  // Review regression: a non-zero amount under half a cent is never printed as "$0.00"
  // (real Part B coinsurance per billing unit is as small as $0.002).
  assert.equal(formatMoney(0.004999), '<$0.01');
  assert.equal(formatMoney(0.002), '<$0.01');
  assert.equal(formatMoney(1e-7), '<$0.01');
  assert.equal(formatMoney(-1), '-$1.00');
  assert.equal(formatMoney(-0.004), '-<$0.01'); // no "-$0.00"
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(formatMoney(5), '$5.00');
  assert.equal(formatMoney(999.995), '$1,000.00');
  assert.equal(formatMoney(0.1 + 0.2), '$0.30');
  assert.equal(formatMoney(1234567890.12), '$1,234,567,890.12');
  assert.equal(formatMoney(1e15), '$1,000,000,000,000,000.00');
  assert.equal(formatMoney(1e21), '$1,000,000,000,000,000,000,000.00');
  for (const bad of [null, undefined, NaN, Infinity, '1.00', {}]) {
    assert.throws(() => formatMoney(bad), TypeError, String(bad));
  }
});

test('formatUnitPrice keeps the source precision up to 5 decimals', () => {
  assert.equal(formatUnitPrice(0.01451), '$0.01451');
  assert.equal(formatUnitPrice(0.0788), '$0.0788');
  assert.equal(formatUnitPrice(5.52114), '$5.52114');
  assert.equal(formatUnitPrice(29874.448), '$29,874.448');
  assert.equal(formatUnitPrice(1), '$1.00');
  assert.equal(formatUnitPrice(0.5), '$0.50');
  assert.equal(formatUnitPrice(0.1 + 0.2), '$0.30'); // 0.30000000000000004 rounds at 5 dp
  assert.equal(formatUnitPrice(0.123456), '$0.12346');
  assert.equal(formatUnitPrice(0.000015), '$0.00002');
  assert.equal(formatUnitPrice(0.00153), '$0.00153');
  assert.equal(formatUnitPrice(1234567.1), '$1,234,567.10');
  assert.equal(formatUnitPrice(-2.5), '-$2.50');
  assert.equal(formatUnitPrice(0.000004), '<$0.00001'); // never "$0.00" for a real price
  assert.equal(formatUnitPrice(0), '$0.00');
  assert.throws(() => formatUnitPrice(null), TypeError);
  assert.throws(() => formatUnitPrice(NaN), TypeError);
});

test('multiplyMoney is exact: no float drift', () => {
  assert.equal(1.15 * 100, 114.99999999999999); // the trap in binary floating point
  assert.equal(1.005 * 100, 100.49999999999999);
  assert.equal(multiplyMoney(0.01451, 60), 0.8706);
  assert.equal(0.1 * 3, 0.30000000000000004);
  assert.equal(multiplyMoney(0.1, 3), 0.3);
  assert.equal(multiplyMoney(0.07, 100), 7); // 0.07*100 === 7.000000000000001
  assert.equal(formatMoney(multiplyMoney(1.005, 1)), '$1.01');
  assert.equal(multiplyMoney(0.01451, 3), 0.04353);
  assert.equal(multiplyMoney(1.15, 100), 115); // 1.15*100 === 114.99999999999999
  assert.equal(multiplyMoney(0.01451, 0.5), 0.007255);
  assert.equal(multiplyMoney(29874.448, 9999), 298714605.552);
  assert.equal(multiplyMoney(5.52114, '2.125'), 11.7324225);
  assert.equal(multiplyMoney(0.333, 0.001), 0.000333);
  assert.equal(formatMoney(multiplyMoney(0.01451, 60)), '$0.87');
});

test('multiplyMoney rejects bad quantities and prices', () => {
  for (const q of [0, -1, 9999.001, 10000, NaN, Infinity, -Infinity, 0.0001, '1.2345', '', 'abc', null, undefined]) {
    assert.throws(() => multiplyMoney(1, q), Error, String(q));
  }
  assert.equal(multiplyMoney(1, 9999), 9999);
  assert.equal(multiplyMoney(1, 0.001), 0.001);
  assert.equal(multiplyMoney(1, '60.000'), 60); // trailing zeros are not extra precision
  assert.throws(() => multiplyMoney(null, 1), TypeError);
  assert.throws(() => multiplyMoney(NaN, 1), TypeError);
});

test('quantityProblem explains unusable quantities', () => {
  assert.equal(quantityProblem(60), null);
  assert.equal(quantityProblem('2.5'), null);
  assert.match(quantityProblem(0), /greater than 0/);
  assert.match(quantityProblem(10000), /at most 9999/);
  assert.match(quantityProblem(1.0001), /more than 3 decimals/);
  assert.match(quantityProblem('x'), /not usable/);
  assert.match(quantityProblem(Infinity), /finite/);
});

test('multiplyDecimal, subtractDecimal and divideMoney are exact', () => {
  assert.equal(multiplyDecimal(0.1, 0.2), '0.02');
  assert.equal(multiplyDecimal(-1.5, 2), '-3');
  assert.equal(subtractDecimal(1, 0.92), '0.08');
  assert.equal(subtractDecimal(0.3, 0.1), '0.2');
  assert.equal(subtractDecimal(0.1, 0.3), '-0.2');
  assert.equal(divideMoney(1, 3), 0.3333333333);
  assert.equal(divideMoney(2, 3, 2), 0.67);
  assert.equal(divideMoney(0.0711, 0.01451, 10), 4.900068918);
  assert.equal(divideMoney(0.24, 2), 0.12);
  assert.equal(divideMoney(-1, 8, 2), -0.13);
  assert.equal(divideMoney(1, -8, 2), -0.13);
  assert.equal(divideMoney(0.3, 0.1), 3); // 0.3/0.1 === 2.9999999999999996 in binary
  assert.throws(() => divideMoney(1, 0), RangeError);
  assert.throws(() => divideMoney(1, 2, -1), RangeError);
});

test('formatMultiple', () => {
  assert.equal(formatMultiple(0.92), '0.92×');
  assert.equal(formatMultiple(0.925), '0.93×');
  assert.equal(formatMultiple(0.5), '0.50×');
  assert.equal(formatMultiple(0.996), '1.0×');
  assert.equal(formatMultiple(1), '1.0×');
  assert.equal(formatMultiple(4.9), '4.9×');
  assert.equal(formatMultiple(4.900068918), '4.9×');
  assert.equal(formatMultiple(4.95), '5.0×');
  assert.equal(formatMultiple(11.5), '11.5×');
  assert.equal(formatMultiple(11.45), '11.5×');
  assert.equal(formatMultiple(99.94), '99.9×');
  assert.equal(formatMultiple(99.96), '100×');
  assert.equal(formatMultiple(167), '167×');
  assert.equal(formatMultiple(166.5), '167×');
  assert.equal(formatMultiple(1024), '1,024×');
  assert.equal(formatMultiple(1234567.8), '1,234,568×');
  assert.equal(formatMultiple(0), '0.00×');
  // Review regression: a positive spread under 0.005 (28 real Part D spreads, e.g. 0.0045)
  // printed as "0.00×".
  assert.equal(formatMultiple(0.0045078599), '<0.01×');
  assert.equal(formatMultiple(0.004999), '<0.01×');
  assert.equal(formatMultiple(3e-10), '<0.01×');
  assert.equal(formatMultiple(0.005), '0.01×');
  assert.throws(() => formatMultiple(-1), RangeError);
  assert.throws(() => formatMultiple(NaN), TypeError);
  assert.throws(() => formatMultiple(null), TypeError);
});

// Review follow-up: a rule tested on the unrounded ratio must not disagree with the shown
// multiple, so a ratio just inside a threshold never displays as the threshold itself.
test('formatMultipleWithin keeps a ratio inside its bounds when shown', () => {
  assert.equal(formatMultiple(0.204590319), '0.20×');
  assert.equal(formatMultipleWithin(0.204590319, 0.2, 20), '0.205×');
  assert.equal(formatMultipleWithin(0.20004, 0.2, 20), '0.20004×');
  assert.equal(formatMultipleWithin(0.2000000001, 0.2, 20), '0.2000000001×');
  assert.equal(formatMultipleWithin(19.97, 0.2, 20), '19.97×');
  assert.equal(formatMultipleWithin(19.9996, 0.2, 20), '19.9996×');
  assert.equal(formatMultipleWithin(19.94, 0.2, 20), '19.9×');
  // Inside and already shown inside, or outside the bounds: exactly formatMultiple.
  for (const v of [0.21, 0.92, 4.9, 11.45, 0.2, 0.1999, 20, 20.04, 0.0045, 167]) assert.equal(formatMultipleWithin(v, 0.2, 20), formatMultiple(v), String(v));
  assert.throws(() => formatMultipleWithin(1, null, 20), TypeError);
});

test('formatPercent and formatCount', () => {
  assert.equal(formatPercent(20), '20%');
  assert.equal(formatPercent(18.4), '18.4%');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(12.345), '12.35%');
  assert.equal(formatPercent(100), '100%');
  assert.throws(() => formatPercent(null), TypeError);
  assert.equal(formatCount(14847081), '14,847,081');
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1000), '1,000');
  assert.equal(formatCount(2.5), '2.5');
  assert.equal(formatCount(-1234), '-1,234');
  assert.equal(formatCount(1e21), '1,000,000,000,000,000,000,000');
  assert.throws(() => formatCount(undefined), TypeError);
  assert.throws(() => formatCount(Infinity), TypeError);
});

test('formatDecimal keeps every digit of an exact decimal, with thousands separators', () => {
  assert.equal(formatDecimal('1234.567891'), '1,234.567891');
  assert.equal(formatDecimal(0.5), '0.5');
  assert.equal(formatDecimal('3.3519'), '3.3519');
  assert.equal(formatDecimal('3.3500'), '3.35');
  assert.equal(formatDecimal('-1234.5'), '-1,234.5');
  assert.equal(formatDecimal(1e-7), '0.0000001');
  // More digits than a JavaScript number holds: formatCount(Number(x)) would round them.
  assert.equal(formatDecimal('123444443.42109123456'), '123,444,443.42109123456');
  assert.equal(formatDecimal(multiplyDecimal(12345.67891, 9999)), '123,444,443.42109');
  assert.throws(() => formatDecimal(''), TypeError);
  assert.throws(() => formatDecimal('abc'), TypeError);
  assert.throws(() => formatDecimal(null), TypeError);
  assert.throws(() => formatDecimal(NaN), RangeError);
});

test('money.js does not use Intl or toLocaleString', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/core/money.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bIntl\.|\.toLocaleString\b/);
});
