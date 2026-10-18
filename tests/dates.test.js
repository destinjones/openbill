import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIsoDate, daysBetween, isoDate, parsePeriod } from '../src/core/dates.js';

test('isIsoDate accepts only real calendar dates', () => {
  for (const d of ['2026-10-14', '2024-02-29', '2000-02-29', '1999-12-31', '2026-01-01', '2026-04-30']) {
    assert.equal(isIsoDate(d), true, d);
  }
  for (const d of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-10-00', '2026-10-32', '2026-1-14', '26-10-14', '2026/10/14', '10/14/2026', '2026-10-14T00:00:00Z', ' 2026-10-14', '', null, undefined, 20261014, new Date(0)]) {
    assert.equal(isIsoDate(d), false, String(d));
  }
});

test('daysBetween counts whole UTC days, signed', () => {
  assert.equal(daysBetween('2026-10-14', '2026-10-17'), 3);
  assert.equal(daysBetween('2026-10-17', '2026-10-14'), -3);
  assert.equal(daysBetween('2026-10-17', '2026-10-17'), 0);
  assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2); // leap day
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2); // across a US DST change: still whole days
  assert.equal(daysBetween('2024-12-31', '2026-10-17'), 655);
  assert.equal(daysBetween('2025-12-31', '2026-01-01'), 1);
  assert.throws(() => daysBetween('2026-02-30', '2026-03-01'), RangeError);
  assert.throws(() => daysBetween('2026-10-14', null), RangeError);
});

test('isoDate formats in UTC', () => {
  assert.equal(isoDate(new Date(Date.UTC(2026, 9, 17, 23, 59, 59))), '2026-10-17');
  assert.equal(isoDate(new Date('2026-10-17T00:00:00Z')), '2026-10-17');
  assert.equal(isoDate(new Date('2026-10-17T23:30:00-05:00')), '2026-10-18');
  assert.equal(isoDate(new Date(Date.UTC(5, 0, 1))), '1905-01-01'); // Date.UTC maps 0-99 to 1900s
  assert.throws(() => isoDate(new Date('nope')), TypeError);
  assert.throws(() => isoDate('2026-10-17'), TypeError);
  assert.throws(() => isoDate(null), TypeError);
});

test('parsePeriod', () => {
  assert.deepEqual(parsePeriod('2026-10-01/2026-12-31'), { start: '2026-10-01', end: '2026-12-31' });
  assert.deepEqual(parsePeriod('2026-10-01/2026-10-01'), { start: '2026-10-01', end: '2026-10-01' });
  assert.equal(parsePeriod('2026-12-31/2026-10-01'), null);
  assert.equal(parsePeriod('2026-10-01/2026-02-30'), null);
  assert.equal(parsePeriod('2026-10-01'), null);
  assert.equal(parsePeriod('2026-10-01/2026-12-31/2027-01-01'), null);
  assert.equal(parsePeriod(null), null);
});
