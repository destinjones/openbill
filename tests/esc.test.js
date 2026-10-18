import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc } from '../src/core/esc.js';
import { REPO_URL, APP_NAME } from '../src/core/config.js';

test('esc escapes & < > " \' and backtick', () => {
  assert.equal(esc('a & b'), 'a &amp; b');
  assert.equal(esc('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(esc("it's"), 'it&#39;s');
  assert.equal(esc('`${x}`'), '&#96;${x}&#96;');
  assert.equal(esc('&amp;'), '&amp;amp;'); // escapes once more; never "un-escapes"
  assert.equal(esc('" onmouseover="x'), '&quot; onmouseover=&quot;x');
  assert.equal(esc('plain text 4.9× $0.87'), 'plain text 4.9× $0.87');
});

test('esc: null and undefined render as nothing, everything else via String()', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
  assert.equal(esc(false), 'false');
  assert.equal(esc(''), '');
  assert.equal(esc(['<a>', 1]), '&lt;a&gt;,1');
  assert.equal(esc({ toString: () => '<b>' }), '&lt;b&gt;');
});

test('config constants match the contract', () => {
  assert.equal(REPO_URL, 'https://github.com/destinjones/openbill');
  assert.equal(APP_NAME, 'OpenBill');
});

// Review APP-1 (security): the provenance panel linked any source_url, including javascript:,
// data: and protocol-relative //host URLs.
test('safeHref allows only https:// URLs and methodology.html#<rule-id>', async () => {
  const { safeHref } = await import('../src/core/esc.js');
  for (const ok of [
    'https://data.medicaid.gov/dataset/fbb83258-11c7-47f5-8b18-5f8e79f7e704',
    'https://www.cms.gov/medicare/payment/part-b-drugs/asp-pricing-files',
    'https://data.cms.gov/x?y=1#z',
    'https://example.org',
    'methodology.html#spread',
  ]) {
    assert.equal(safeHref(ok), ok, ok);
  }
  for (const bad of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '//evil.example/x',
    'http://data.cms.gov/',
    'https://',
    'https:///x',
    'https://evil.example/"onmouseover="x',
    'https://a b.example/',
    'https://evil.example/<x>',
    'methodology.html#Spread',
    'methodology.html',
    'file:///C:/x',
    'vbscript:x',
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(safeHref(bad), null, String(bad));
  }
});
