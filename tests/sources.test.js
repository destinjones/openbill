import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SOURCE_INFO, NADAC_EXPLANATION_CODES, NADAC_CARRIED_FORWARD_CODES } from '../src/core/sources.js';

const IDS = ['nadac', 'fda_ndc', 'partd', 'asp_limits', 'asp_crosswalk'];

test('SOURCE_INFO covers every contract source with complete entries', () => {
  assert.deepEqual(Object.keys(SOURCE_INFO).sort(), [...IDS].sort());
  for (const id of IDS) {
    const s = SOURCE_INFO[id];
    assert.equal(s.id, id);
    for (const f of ['label', 'publisher', 'cadence', 'stale_note', 'measures']) {
      assert.equal(typeof s[f], 'string', `${id}.${f}`);
      assert.ok(s[f].trim().length > 0, `${id}.${f}`);
    }
    assert.ok(Number.isInteger(s.stale_after_days) && s.stale_after_days > 0, `${id}.stale_after_days`);
    assert.ok(['as_of_date', 'period_start', 'period_end'].includes(s.age_from), `${id}.age_from`);
    assert.match(s.measures, /\.$/, `${id}.measures is a sentence`);
    assert.ok(Object.isFrozen(s));
  }
  assert.ok(Object.isFrozen(SOURCE_INFO));
});

test('stale thresholds', () => {
  assert.equal(SOURCE_INFO.nadac.stale_after_days, 14);
  assert.equal(SOURCE_INFO.nadac.cadence, 'weekly');
  assert.equal(SOURCE_INFO.asp_limits.stale_after_days, 100);
  assert.equal(SOURCE_INFO.asp_crosswalk.stale_after_days, 100);
  assert.equal(SOURCE_INFO.asp_limits.age_from, 'period_start');
  // Part D: ~18 months after the data year ends to release, plus a year until the next one.
  assert.equal(SOURCE_INFO.partd.stale_after_days, 913);
  assert.equal(SOURCE_INFO.partd.age_from, 'period_end');
  assert.match(SOURCE_INFO.partd.stale_note, /18 months/);
  assert.equal(SOURCE_INFO.partd.cadence, 'annual');
});

// Contract (Rules the page applies, Freshness): age is counted from the NADAC as-of date, from
// the start of a Part B quarter, and from the end of the Part D data year.
test('age_from: NADAC file date, Part B quarter start, Part D data-year end', () => {
  assert.deepEqual(
    Object.fromEntries(Object.values(SOURCE_INFO).map((s) => [s.id, s.age_from])),
    { nadac: 'as_of_date', fda_ndc: 'as_of_date', partd: 'period_end', asp_limits: 'period_start', asp_crosswalk: 'period_start' },
  );
});

test('NADAC explanation codes 1-6 match the builder wording', async (t) => {
  assert.deepEqual(Object.keys(NADAC_EXPLANATION_CODES), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual([...NADAC_CARRIED_FORWARD_CODES], ['2', '4']);
  let py = '';
  try {
    py = await readFile(new URL('../tools/build_drugs.py', import.meta.url), 'utf8');
  } catch {
    // handled below
  }
  if (!/^EXPLANATION = \{/m.test(py)) {
    t.skip('tools/build_drugs.py has no EXPLANATION table to compare with');
    return;
  }
  for (const [code, text] of Object.entries(NADAC_EXPLANATION_CODES)) {
    assert.ok(py.includes(`"${code}": "${text}"`), `code ${code} wording differs from tools/build_drugs.py`);
  }
});
