import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNdc11, normalizeNdc, ndcCandidates, formatNdc, looksLikeNdc } from '../src/core/ndc.js';

test('isNdc11', () => {
  assert.equal(isNdc11('00378718505'), true);
  assert.equal(isNdc11('0037871850'), false);
  assert.equal(isNdc11('00378-7185-05'), false);
  assert.equal(isNdc11(378718505), false);
  assert.equal(isNdc11(null), false);
  assert.equal(isNdc11('0037871850a'), false);
});

test('normalizeNdc accepts every unambiguous layout', () => {
  assert.equal(normalizeNdc('00378718505'), '00378718505');
  assert.equal(normalizeNdc('00378-7185-05'), '00378718505');
  assert.equal(normalizeNdc('  00378-7185-05  '), '00378718505');
  // 10-digit, hyphenated: the short segment gets the leading zero.
  assert.equal(normalizeNdc('0003-0893-21'), '00003089321'); // 4-4-2
  assert.equal(normalizeNdc('50090-123-45'), '50090012345'); // 5-3-2
  assert.equal(normalizeNdc('50090-1234-5'), '50090123405'); // 5-4-1
  assert.equal(normalizeNdc('NDC 00378-7185-05'), '00378718505');
  assert.equal(normalizeNdc('ndc: 0003-0893-21'), '00003089321');
  assert.equal(normalizeNdc('00378 7185 05'), '00378718505');
  assert.equal(normalizeNdc('00378 - 7185 - 05'), '00378718505');
});

test('normalizeNdc returns null for ambiguous or junk input', () => {
  assert.equal(normalizeNdc('0378718505'), null); // 10 digits, no hyphens: ambiguous
  for (const junk of ['', '   ', 'abc', '123', '003787185055', '00378-71850-5', '0037-87185-05', '00378--7185-05', '00378-7185-0x', '1234-567-89', null, undefined, 378718505, {}]) {
    assert.equal(normalizeNdc(junk), null, JSON.stringify(junk));
  }
});

test('ndcCandidates', () => {
  assert.deepEqual(ndcCandidates('00378-7185-05'), ['00378718505']);
  assert.deepEqual(ndcCandidates('0003-0893-21'), ['00003089321']);
  assert.deepEqual(ndcCandidates('0378718505'), ['00378718505', '03787018505', '03787185005']);
  assert.deepEqual(ndcCandidates(' 0378718505 '), ['00378718505', '03787018505', '03787185005']);
  // Paddings that coincide are listed once.
  assert.deepEqual(ndcCandidates('0000000000'), ['00000000000']);
  assert.deepEqual(ndcCandidates('junk'), []);
  assert.deepEqual(ndcCandidates('123456789'), []);
  assert.deepEqual(ndcCandidates(null), []);
});

test('formatNdc', () => {
  assert.equal(formatNdc('00378718505'), '00378-7185-05');
  assert.equal(formatNdc(normalizeNdc('0003-0893-21')), '00003-0893-21');
  assert.throws(() => formatNdc('0378718505'), TypeError);
  assert.throws(() => formatNdc('00378-7185-05'), TypeError);
  assert.throws(() => formatNdc(null), TypeError);
});

test('looksLikeNdc routes NDC-shaped queries', () => {
  for (const q of ['00378718505', '0378718505', '00378-7185-05', '0003-0893-21', ' 00378 7185 05 ', 'NDC 00378-7185-05']) {
    assert.equal(looksLikeNdc(q), true, q);
  }
  for (const q of ['metformin', '500', '12345', '003787185', '003787185051', 'metformin 500', '00378-7185-05x', '', null]) {
    assert.equal(looksLikeNdc(q), false, String(q));
  }
});

// Review regression: an NDC pasted from a PDF or web page with a non-breaking hyphen or an
// en dash ("00378–7185–05") was not recognised, so the search fell through to names.
test('Unicode dashes count as hyphens', async () => {
  const { normalizeNdc, looksLikeNdc, ndcCandidates } = await import('../src/core/ndc.js');
  for (const d of ['‐', '‑', '‒', '–', '—', '―', '−']) {
    assert.equal(normalizeNdc(`00378${d}7185${d}05`), '00378718505', JSON.stringify(d));
    assert.equal(normalizeNdc(`0378${d}7185${d}05`), '00378718505', JSON.stringify(d));
    assert.equal(looksLikeNdc(`00378${d}7185${d}05`), true);
  }
  assert.deepEqual(ndcCandidates('00378–7185–05'), ['00378718505']);
  assert.equal(normalizeNdc('00378.7185.05'), null);
  assert.equal(normalizeNdc('０３７８-７１８５-０５'), null); // fullwidth digits stay unrecognised
});
