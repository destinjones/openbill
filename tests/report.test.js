import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ISSUE_TEMPLATES, ISSUE_URL_MAX, issueUrl } from '../src/core/report.js';
import { REPO_URL } from '../src/core/config.js';

const query = (url) => new URL(url).searchParams;

test('issue templates carry the contract field ids', () => {
  assert.deepEqual([...ISSUE_TEMPLATES['wrong-price.yml']], ['product', 'ndc', 'figure', 'shown_value', 'source_file', 'what_is_wrong', 'evidence', 'build_id']);
  assert.deepEqual([...ISSUE_TEMPLATES['missing-drug.yml']], ['drug_name', 'ndc', 'where_seen', 'notes']);
  assert.deepEqual([...ISSUE_TEMPLATES['bug.yml']], ['what_happened', 'steps', 'device', 'build_id']);
  assert.equal(ISSUE_URL_MAX, 7500);
});

test('issueUrl builds a prefilled issue-form URL', () => {
  const url = issueUrl({
    template: 'wrong-price.yml',
    title: 'Wrong price: METFORMIN HCL 500 MG TABLET',
    fields: { product: 'METFORMIN HCL 500 MG TABLET', ndc: '00378-7185-05', shown_value: '$0.01451 per EA', build_id: 'abc123' },
  });
  assert.equal(
    url,
    `${REPO_URL}/issues/new?template=wrong-price.yml&title=Wrong%20price%3A%20METFORMIN%20HCL%20500%20MG%20TABLET&product=METFORMIN%20HCL%20500%20MG%20TABLET&ndc=00378-7185-05&shown_value=%240.01451%20per%20EA&build_id=abc123`,
  );
});

test('issueUrl encodes every value; fields in form order; empty values left out; labels', () => {
  const tricky = 'a&b=c#d?e/f +g\n"h" <i> 4.9× 💊';
  const url = issueUrl({
    template: 'bug.yml',
    title: tricky,
    labels: ['bug', 'needs triage'],
    fields: { device: 'Pixel 7, Chrome', what_happened: tricky, steps: '', build_id: null },
  });
  const q = query(url);
  assert.equal(q.get('title'), tricky);
  assert.equal(q.get('what_happened'), tricky);
  assert.equal(q.get('labels'), 'bug,needs triage');
  assert.equal(q.get('steps'), null);
  assert.equal(q.get('build_id'), null);
  assert.deepEqual([...q.keys()], ['template', 'title', 'labels', 'what_happened', 'device']);
  assert.doesNotMatch(url.split('?')[1], /[ #\n"<>]/);
  assert.equal(issueUrl({ template: 'missing-drug.yml' }), `${REPO_URL}/issues/new?template=missing-drug.yml`);
  assert.equal(query(issueUrl({ template: 'missing-drug.yml', fields: { notes: 0 } })).get('notes'), '0');
});

test('issueUrl rejects unknown templates and field ids', () => {
  assert.throws(() => issueUrl({ template: 'nope.yml' }), /unknown issue template/);
  assert.throws(() => issueUrl({ template: 'bug.yml', fields: { product: 'x' } }), /has no field "product"/);
  assert.throws(() => issueUrl(), /unknown issue template/);
});

test('issueUrl keeps URLs under 7,500 characters by cutting the longest fields with "…"', () => {
  const evidence = 'E'.repeat(20000);
  const what = 'W'.repeat(3000);
  const url = issueUrl({ template: 'wrong-price.yml', title: 'T', fields: { product: 'P', evidence, what_is_wrong: what } });
  assert.ok(url.length <= ISSUE_URL_MAX, `${url.length}`);
  assert.ok(url.length > ISSUE_URL_MAX - 20, 'uses the room it has');
  const q = query(url);
  assert.equal(q.get('product'), 'P');
  assert.equal(q.get('title'), 'T');
  assert.ok(q.get('evidence').endsWith('…'));
  assert.ok(/^E+…$/.test(q.get('evidence')));
  assert.equal(q.get('what_is_wrong'), what, 'the shorter field fits without cutting');
});

test('issueUrl truncation: several long fields, multi-byte text, lone surrogates', () => {
  const pills = '💊'.repeat(3000); // each encodes to 12 characters
  const url = issueUrl({ template: 'bug.yml', title: 'x'.repeat(5000), fields: { what_happened: pills, steps: 'é'.repeat(4000), device: 'phone' } });
  assert.ok(url.length <= ISSUE_URL_MAX, `${url.length}`);
  const q = query(url); // decodes: proves no surrogate pair was split
  assert.ok(q.get('what_happened').endsWith('…'));
  assert.ok([...q.get('what_happened').slice(0, -1)].every((c) => c === '💊'));
  assert.equal(q.get('device'), 'phone');
  const lone = issueUrl({ template: 'bug.yml', fields: { what_happened: 'a\ud800b' } });
  assert.equal(query(lone).get('what_happened'), 'a�b');
});

// Review regressions: the longest field was cut all the way down to "…" while shorter long
// fields were kept whole; and template names inherited from Object.prototype crashed with a
// TypeError instead of the "unknown issue template" error.
test('issueUrl cuts long values to one common length instead of wiping the longest', () => {
  const url = issueUrl({
    template: 'wrong-price.yml',
    title: 'T'.repeat(9000),
    fields: { evidence: '💊'.repeat(5000), what_is_wrong: 'w'.repeat(3000), product: 'p' },
  });
  assert.ok(url.length <= ISSUE_URL_MAX, `${url.length}`);
  assert.ok(url.length > ISSUE_URL_MAX - 30, 'uses the room it has');
  const q = query(url);
  assert.equal(q.get('product'), 'p');
  assert.ok(q.get('evidence').length > 100, 'the longest field keeps a fair share');
  assert.ok([...q.get('evidence').slice(0, -1)].every((c) => c === '💊'));
  assert.ok(q.get('title').endsWith('…'));
  assert.ok(q.get('what_is_wrong').endsWith('…'));
  const enc = (k) => encodeURIComponent(q.get(k)).length;
  assert.ok(Math.abs(enc('title') - enc('what_is_wrong')) <= 12, `${enc('title')} vs ${enc('what_is_wrong')}`);
  for (const t of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
    assert.throws(() => issueUrl({ template: t }), /unknown issue template/, t);
  }
});
