// Known real-world values, checked against data/drugs.json (docs/DECISIONS.md, decision 12).
//
// Each entry in tests/spotchecks.json was verified outside OpenBill's pipeline, by a person or by
// tools/reverify_spotchecks.py, against the government source named in its verified_via, and is
// pinned to the source file it describes. An entry applies only while that file is the one
// data/drugs.json was built from; then its value must match exactly. At least ten must apply, and
// a floor per source must apply (decisions 12 and 53): a data refresh that changes a source's file
// has to re-verify that source's facts against the new file. tools/reverify_spotchecks.py does
// NADAC and Part D through their APIs; Part B has no API, so a person does those at the new quarter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isIsoDate } from '../src/core/dates.js';
import { isNdc11 } from '../src/core/ndc.js';

const doc = JSON.parse(readFileSync(new URL('../data/drugs.json', import.meta.url), 'utf8'));
const checks = JSON.parse(readFileSync(new URL('./spotchecks.json', import.meta.url), 'utf8'));

const MIN_APPLYING = 10;
// A total alone passed with no NADAC check at all, on the source that moves every week (INFRA-06).
const MIN_PER_SOURCE = Object.freeze({ nadac: 5, partd: 5, asp_limits: 3, asp_crosswalk: 2 });
const WHERE = ['row', 'part_d_names', 'part_b_codes'];
const FIELDS = ['id', 'where', 'ndc', 'key', 'path', 'value', 'source_file', 'verified_via', 'verified_on', 'note'];

const hasOwn = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/** source_file -> source id, for the files data/drugs.json was built from. */
const currentFiles = new Map(Object.entries(doc.sources || {}).map(([id, s]) => [s.source_file, id]));
const rowsByNdc = new Map((doc.rows || []).map((r) => [r.ndc, r]));
const here = (e) => (e.where === 'row' ? rowsByNdc.has(e.ndc) : Object.hasOwn(doc[e.where] || {}, e.key));
const left = (e) => currentFiles.get(e.source_file) !== 'nadac' && !here(e);
/**
 * An entry is checked while its file is current. An entry pinned to a Part B or Part D file also needs
 * its row or table entry in this build: the Part D and Part B tables hold only what this week's NADAC
 * rows join to, so when the last NDC of a name leaves, the fact in that file has not changed. That is
 * a normal week. It does not count towards a floor.
 */
const applies = (e) => currentFiles.has(e.source_file) && !left(e);

test('tests/spotchecks.json: every entry is well formed and ids are unique', () => {
  assert.ok(Array.isArray(checks) && checks.length > 0, 'spotchecks.json is a non-empty array');
  const problems = [];
  const ids = new Set();
  for (const [i, e] of checks.entries()) {
    const at = `entry ${i} (${e && e.id})`;
    if (e === null || typeof e !== 'object' || Array.isArray(e)) {
      problems.push(`${at}: not an object`);
      continue;
    }
    for (const k of Object.keys(e)) if (!FIELDS.includes(k)) problems.push(`${at}: unexpected field "${k}"`);
    for (const k of ['id', 'path', 'source_file', 'verified_via', 'note']) if (!nonEmpty(e[k])) problems.push(`${at}: ${k} must be a non-empty string`);
    if (ids.has(e.id)) problems.push(`${at}: duplicate id`);
    ids.add(e.id);
    if (!WHERE.includes(e.where)) problems.push(`${at}: where must be one of ${WHERE.join(', ')}`);
    if (e.where === 'row') {
      if (!isNdc11(e.ndc)) problems.push(`${at}: a row entry needs an 11-digit ndc`);
      if (hasOwn(e, 'key')) problems.push(`${at}: a row entry has ndc, not key`);
    } else if (WHERE.includes(e.where)) {
      if (!nonEmpty(e.key)) problems.push(`${at}: a ${e.where} entry needs a key`);
      if (hasOwn(e, 'ndc')) problems.push(`${at}: a ${e.where} entry has key, not ndc`);
    }
    if (!hasOwn(e, 'value') || e.value === null) problems.push(`${at}: value must be present and not null (a known fact, never a blank)`);
    if (typeof e.value === 'number' && !(Number.isFinite(e.value) && e.value > 0)) {
      problems.push(`${at}: a numeric spot check must be a positive finite number`);
    }
    if (!isIsoDate(e.verified_on)) problems.push(`${at}: verified_on must be YYYY-MM-DD`);
  }
  assert.deepEqual(problems, []);
});

/** The object the entry's path starts from, or undefined. */
function target(e) {
  if (e.where === 'row') return rowsByNdc.get(e.ndc);
  const table = doc[e.where];
  return hasOwn(table, e.key) ? table[e.key] : undefined;
}

for (const e of checks) {
  const name = `${e.id} [${e.source_file}]`;
  test(name, (t) => {
    t.diagnostic(`verified ${e.verified_on} via: ${e.verified_via}`);
    if (left(e)) {
      t.skip(`${e.where === 'row' ? `NDC ${e.ndc}` : e.key} has left this week's NADAC, so this build does not hold the fact from ${e.source_file}`);
      return;
    }
    if (!applies(e)) {
      const files = [...currentFiles].map(([f, id]) => `${id}: ${f}`).join('; ');
      t.skip(`pinned to ${e.source_file}, which data/drugs.json no longer uses (current files: ${files})`);
      return;
    }
    const where = e.where === 'row' ? `rows[ndc=${e.ndc}]` : `${e.where}[${JSON.stringify(e.key)}]`;
    let node = target(e);
    assert.ok(node !== undefined, `${where} is not in data/drugs.json, but ${e.source_file} is current and has this fact`);
    const parts = e.path.split('.');
    let parent;
    for (const [i, p] of parts.entries()) {
      assert.ok(hasOwn(node, p), `${where}.${parts.slice(0, i + 1).join('.')} is missing`);
      parent = node;
      node = node[p];
    }
    assert.deepStrictEqual(
      node,
      e.value,
      `${where}.${e.path} is ${JSON.stringify(node)}; the source says ${JSON.stringify(e.value)} (${e.verified_via})`,
    );
    // The record holding the value must say it came from the file the fact was verified in.
    if (hasOwn(parent, 'source_file')) {
      assert.equal(parent.source_file, e.source_file, `${where}.${parts.slice(0, -1).join('.')} names a different source file`);
    }
  });
}

test(`at least ${MIN_APPLYING} spot checks apply to the source files data/drugs.json was built from`, () => {
  const applying = checks.filter(applies);
  const stale = checks.filter((e) => !applies(e));
  if (applying.length < MIN_APPLYING) {
    const files = [...currentFiles].map(([f, id]) => `  ${id}: ${f}`).join('\n');
    assert.fail(
      `Only ${applying.length} of ${checks.length} spot checks are pinned to the current source files; at least ` +
        `${MIN_APPLYING} must be. data/drugs.json has been rebuilt from new files:\n${files}\n` +
        `A data refresh must re-verify at least ${MIN_APPLYING} spot checks against the new files, from a source ` +
        `other than OpenBill's pipeline, and add them to tests/spotchecks.json with that source_file, verified_via ` +
        `and verified_on (docs/DECISIONS.md, decision 12). Do not repoint old entries at new files without ` +
        `re-verifying them. ${stale.length} entries are pinned to files no longer used.`,
    );
  }
});

for (const [source, floor] of Object.entries(MIN_PER_SOURCE)) {
  test(`at least ${floor} spot checks apply to the ${source} file data/drugs.json was built from`, () => {
    const file = doc.sources[source].source_file;
    const applying = checks.filter((e) => e.source_file === file && applies(e));
    const how = source === 'nadac' || source === 'partd' ? 'Run python tools/reverify_spotchecks.py, which reads each fact from the government API and rewrites it' : 'This source has no API: a person re-verifies them against the new file (docs/HAND-CHECK.md)';
    assert.ok(applying.length >= floor, `Only ${applying.length} spot checks are pinned to ${file}; at least ${floor} must be. ${how} (docs/DECISIONS.md, decisions 12 and 53).`);
  });
}
