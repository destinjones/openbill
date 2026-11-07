import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNdc11, normalizeNdc, ndcCandidates, ndcProductCodes, readNdc, formatNdc, formatNdcCode, looksLikeNdc } from '../src/core/ndc.js';

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
  // Dots and slashes separate segments as well (OB-12; this test used to pin the dots as junk).
  assert.equal(normalizeNdc('00378.7185.05'), '00378718505');
  assert.equal(normalizeNdc('０３７８-７１８５-０５'), null); // fullwidth digits stay unrecognised
});

test('forms people type: dots, slashes, a lost labeler zero, hyphens in no layout (OB-12)', () => {
  for (const q of ['00378.7185.05', '00378/7185/05', '378-7185-05', '00378-718-505', 'NDC 00378 7185 05']) {
    assert.deepEqual(ndcCandidates(q), ['00378718505'], q);
    assert.equal(looksLikeNdc(q), true, q);
  }
  assert.deepEqual(ndcCandidates('0378718505'), ['00378718505', '03787018505', '03787185005']);
  assert.deepEqual(ndcCandidates('not an ndc'), []);
});

test('ndcProductCodes reads labeler and product, without a package', () => {
  assert.deepEqual(ndcProductCodes('00378-7185'), ['003787185']);
  assert.deepEqual(ndcProductCodes('0378-7185'), ['003787185']);
  assert.deepEqual(ndcProductCodes('378-7185'), ['003787185']);
  assert.deepEqual(ndcProductCodes('00378-718'), ['003780718']);
  assert.deepEqual(ndcProductCodes('00378.7185'), ['003787185']);
  assert.deepEqual(ndcProductCodes('003787185'), ['003787185']);
  assert.deepEqual(ndcProductCodes('03787185'), ['003787185', '037870185']);
  for (const q of ['7185', '00378-7185-05', 'metformin', '', null]) assert.deepEqual(ndcProductCodes(q), [], String(q));
  assert.equal(formatNdcCode('003787185'), '00378-7185');
});

test('readNdc says what kind of number it is, and how sure', () => {
  assert.deepEqual(readNdc('00378-7185-05'), { kind: 'package', ndcs: ['00378718505'], digits: null, guess: false });
  assert.deepEqual(readNdc('00378718505'), { kind: 'package', ndcs: ['00378718505'], digits: null, guess: false });
  const bare = readNdc('0378718505');
  assert.equal(bare.ndcs.length, 3);
  assert.equal(bare.digits, '0378718505');
  assert.equal(bare.guess, false);
  assert.deepEqual(readNdc('00378-7185'), { kind: 'product', codes: ['003787185'] });
  for (const q of ['metformin', 'metformin 500', '500', '', null, '12345']) assert.equal(readNdc(q), null, String(q));
});

test('a 12-digit number is only ever a guess, and is not called an NDC by looksLikeNdc', () => {
  // 3 + an 11-digit NDC has no check digit to test: this is the form people type from a claim.
  const eleven = readNdc('300378718505');
  assert.equal(eleven.guess, true);
  assert.deepEqual(eleven.ndcs, ['00378718505']);
  // 3 + a 10-digit NDC + its check digit: every padding of the ten, after the plain reading.
  const checked = readNdc('303787185053');
  assert.equal(checked.guess, true);
  assert.deepEqual(checked.ndcs, ['03787185053', '00378718505', '03787018505', '03787185005']);
  // The same digits with a wrong last digit do not get the check-digit reading.
  assert.deepEqual(readNdc('303787185054').ndcs, ['03787185054']);
  assert.equal(readNdc('412345678901'), null);
  assert.equal(looksLikeNdc('300378718505'), false);
});
