// Known real-world values, checked against data/drugs.json (docs/DECISIONS.md, decision 12).
//
// Each entry in tests/spotchecks.json was verified by a person, outside OpenBill's pipeline,
// against the government source named in its verified_via, and is pinned to the source file it
// describes. An entry applies only while that file is the one data/drugs.json was built from;
// then its value must match exactly. At least ten must apply: a data refresh that changes the
// source files has to re-verify at least ten facts against the new files and add them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isIsoDate } from '../src/core/dates.js';
import { isNdc11 } from '../src/core/ndc.js';

const doc = JSON.parse(readFileSync(new URL('../data/drugs.json', import.meta.url), 'utf8'));
const checks = JSON.parse(readFileSync(new URL('./spotchecks.json', import.meta.url), 'utf8'));

const MIN_APPLYING = 10;
const WHERE = ['row', 'part_d_names', 'part_b_codes'];
const FIELDS = ['id', 'where', 'ndc', 'key', 'path', 'value', 'source_file', 'verified_via', 'verified_on', 'note'];

const hasOwn = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/** source_file -> source id, for the files data/drugs.json was built from. */
const currentFiles = new Map(Object.entries(doc.sources || {}).map(([id, s]) => [s.source_file, id]));
const rowsByNdc = new Map((doc.rows || []).map((r) => [r.ndc, r]));
const applies = (e) => currentFiles.has(e.source_file);

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
