// src/core/hash.js: the one reader of the part of the address after # (decision 53). Anyone can
// write a hash, and most of what arrives there is not addressed to OpenBill.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHash, hashFor, nameKey, caselessNames, clipText, HASH_KEYS, QUERY_MAX_CHARS, REFLECT_MAX_CHARS } from '../src/core/hash.js';

const NAMES = ['ELIQUIS 5 MG TABLET', 'LANSOPRAZOL-AMOXICIL-CLARITHRO', 'ACETAMINOPHEN-COD #2 TABLET', 'ACETIC ACID 2% EAR SOLUTION'];
const caseless = caselessNames(NAMES);
const isName = (text) => caseless.has(nameKey(text));

test('nothing after the # is the default card', () => {
  for (const h of ['', '#', undefined, null]) assert.deepEqual(parseHash(h), { kind: 'default' }, String(h));
});

test('a card link: each key as written, absent keys null, and the # is optional', () => {
  assert.deepEqual(parseHash('#drug=ELIQUIS%205%20MG%20TABLET&qty=90&paid=12.50'), { kind: 'card', bare: false, drug: 'ELIQUIS 5 MG TABLET', qty: '90', paid: '12.50', ndc: null });
  assert.deepEqual(parseHash('drug=X'), { kind: 'card', bare: false, drug: 'X', qty: null, paid: null, ndc: null });
  // + is a space, as URLSearchParams reads it, and the order of the keys does not matter.
  assert.equal(parseHash('#qty=1&drug=A+B').drug, 'A B');
  assert.equal(parseHash('#drug=%20X%20').drug, 'X');
  // An empty qty stays '' (the card says "No quantity entered."), which is not the same as absent.
  assert.equal(parseHash('#drug=X&qty=').qty, '');
});

test('a repeated key: the first one counts', () => {
  assert.equal(parseHash('#drug=A&drug=B').drug, 'A');
  assert.equal(parseHash('#drug=A&qty=1&qty=2').qty, '1');
});

test('hashFor and parseHash round-trip every awkward name', () => {
  for (const name of [...NAMES, 'A&B=C', 'X+Y', 'PERCENT 100%', 'QUOTE\'S "Q"', 'é 💊']) {
    const h = parseHash(hashFor(name, '2.5', '12.50', '00378718505'));
    assert.deepEqual(h, { kind: 'card', bare: false, drug: name, qty: '2.5', paid: '12.50', ndc: '00378718505' }, name);
  }
  assert.equal(hashFor('A B'), '#drug=A%20B');
  assert.equal(hashFor('A B', 30), '#drug=A%20B&qty=30');
  assert.equal(hashFor('A B', '', ''), '#drug=A%20B');
  assert.equal(hashFor('A B', null, '12.50'), '#drug=A%20B&paid=12.50');
  assert.equal(hashFor('A B', 30, '', '00378718505'), '#drug=A%20B&qty=30&ndc=00378718505');
});

test('a plain fragment is an anchor, never an error', () => {
  for (const a of ['card', 'main', 'top', 'foo', 'how-to', 'ndc-00093104801', 'ELIQUIS']) {
    assert.deepEqual(parseHash(`#${a}`, { isName }), { kind: 'anchor', anchor: a });
  }
  // Two words with an & between them are no HTML id; they are simply not addressed to OpenBill.
  assert.deepEqual(parseHash('#foo&bar', { isName }), { kind: 'anchor', anchor: null });
});

test('only someone else’s parameters leave the card alone too', () => {
  for (const h of ['#utm_source=reddit', '#utm_source=reddit&utm_medium=social', '#fbclid=abc', '#=', '#=x', '#&', '#a=b=c', '#DRUG=X', '#__proto__=1', '#constructor=1&toString=2']) {
    assert.deepEqual(parseHash(h, { isName }), { kind: 'anchor', anchor: null }, h);
  }
});

test('someone else’s parameters beside a drug are ignored', () => {
  assert.deepEqual(parseHash('#utm_source=reddit&drug=X&fbclid=1'), { kind: 'card', bare: false, drug: 'X', qty: null, paid: null, ndc: null });
});

test('an OpenBill link with no drug in it says so', () => {
  for (const h of ['#drug=', '#drug=%20%20', '#drug=+', '#drug', '#qty=30', '#paid=12', '#qty=30&paid=12', '#drug=&qty=30', '#utm_source=x&qty=30']) {
    const r = parseHash(h);
    // "#drug" alone has no =, so it is a fragment like any other.
    if (h === '#drug') {
      assert.deepEqual(r, { kind: 'anchor', anchor: 'drug' });
      continue;
    }
    assert.equal(r.kind, 'bad', h);
    assert.match(r.problem, /names no drug/, h);
  }
});

test('a bare name: a drug when it holds whitespace or is a product, in any case', () => {
  assert.deepEqual(parseHash('#ELIQUIS%205%20MG%20TABLET', { isName }), { kind: 'card', drug: 'ELIQUIS 5 MG TABLET', qty: null, paid: null, ndc: null, bare: true });
  assert.equal(parseHash('#eliquis%205%20mg%20tablet', { isName }).drug, 'eliquis 5 mg tablet');
  assert.equal(parseHash('#ELIQUIS+5+MG+TABLET', { isName }).drug, 'ELIQUIS 5 MG TABLET');
  // One word needs the product list: this is a product, and #card is not.
  assert.equal(parseHash('#LANSOPRAZOL-AMOXICIL-CLARITHRO', { isName }).kind, 'card');
  assert.equal(parseHash('#lansoprazol-amoxicil-clarithro', { isName }).kind, 'card');
  assert.equal(parseHash('#LANSOPRAZOL-AMOXICIL-CLARITHRO').kind, 'anchor', 'with no product list, a word is an anchor');
  // No HTML id holds a space, so this cannot be an anchor: it is a name the file does not have.
  assert.equal(parseHash('#metformin%20er', { isName }).kind, 'card');
  assert.equal(parseHash('#%20%20', { isName }).kind, 'anchor', 'only whitespace names nothing');
});

// BEH-12: #NAME alone opened its card, and #NAME&qty=45 said "That link does not name a drug".
test('a bare name followed by OpenBill’s keys is the same card at that quantity', () => {
  assert.deepEqual(parseHash('#ELIQUIS%205%20MG%20TABLET&qty=45', { isName }), { kind: 'card', bare: true, drug: 'ELIQUIS 5 MG TABLET', qty: '45', paid: null, ndc: null });
  assert.deepEqual(parseHash('#eliquis+5+mg+tablet&qty=45&paid=12.50', { isName }), { kind: 'card', bare: true, drug: 'eliquis 5 mg tablet', qty: '45', paid: '12.50', ndc: null });
  assert.equal(parseHash('#LANSOPRAZOL-AMOXICIL-CLARITHRO&qty=2', { isName }).drug, 'LANSOPRAZOL-AMOXICIL-CLARITHRO');
  // A name the file does not have still goes on to the search box, as #metformin%20er does.
  assert.equal(parseHash('#metformin%20er&qty=30', { isName }).drug, 'metformin er');
  // A word that is no product, a part with a value of its own, or a name after a key: still no drug.
  for (const h of ['#card&qty=30', '#utm_source=x&qty=30', '#qty=30&ELIQUIS%205%20MG%20TABLET', '#%20&qty=30']) {
    assert.equal(parseHash(h, { isName }).kind, 'bad', h);
  }
  // drug= still wins, and a name after it is someone else's.
  assert.deepEqual(parseHash('#drug=X&ELIQUIS%205%20MG%20TABLET&qty=1', { isName }), { kind: 'card', bare: false, drug: 'X', qty: '1', paid: null, ndc: null });
});

test('control characters are no part of a name, and a name of nothing else is no name', () => {
  for (const h of ['#drug=%00%00', '#drug=%00%7F%C2%9F', '#drug=%01%20%1F']) {
    const r = parseHash(h, { isName });
    assert.equal(r.kind, 'bad', h);
    assert.match(r.problem, /names no drug/, h);
  }
  assert.equal(parseHash('#drug=%00ELIQUIS%205%20MG%20TABLET%7F').drug, 'ELIQUIS 5 MG TABLET');
  assert.equal(parseHash('#%00ELIQUIS%205%20MG%20TABLET', { isName }).drug, 'ELIQUIS 5 MG TABLET');
  assert.equal(parseHash('#%00%00', { isName }).kind, 'anchor');
  // Whitespace is folded by nameKey(), not dropped: a tab still separates two words.
  assert.equal(parseHash('#drug=ELIQUIS%095%20MG%20TABLET').drug, 'ELIQUIS\t5 MG TABLET');
});

test('a name’s # and % survive when they are escaped, and a bad escape does not throw', () => {
  assert.equal(parseHash(hashFor('ACETAMINOPHEN-COD #2 TABLET')).drug, 'ACETAMINOPHEN-COD #2 TABLET');
  assert.equal(parseHash(hashFor('ACETIC ACID 2% EAR SOLUTION')).drug, 'ACETIC ACID 2% EAR SOLUTION');
  for (const h of ['#drug=%E0%A4%A', '#%', '#%%%', '#drug=%', '#a%20b%', '#%ZZ%20b', '#\ud800', '#drug=\ud800']) {
    assert.doesNotThrow(() => parseHash(h, { isName }), h);
  }
});

test('a key not in HASH_KEYS never reaches the result, and the result has no inherited surprises', () => {
  const r = parseHash('#drug=X&admin=1&__proto__=polluted&constructor=y');
  assert.deepEqual(Object.keys(r).sort(), ['bare', 'drug', 'kind', 'ndc', 'paid', 'qty']);
  assert.equal(Object.getPrototypeOf(r), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.deepEqual([...HASH_KEYS], ['drug', 'qty', 'paid', 'ndc']);
  assert.ok(Object.isFrozen(HASH_KEYS));
});

test('a very long hash is read quickly, and the name it gives is bounded', () => {
  const long = 'A'.repeat(3_000_000);
  for (const h of [`#drug=${long}`, `#${long}`, `#${long}%20${long}`, `#utm=${long}`]) {
    const t = performance.now();
    const r = parseHash(h, { isName });
    assert.ok(performance.now() - t < 1000, h.slice(0, 12));
    if (r.kind === 'card') assert.ok(r.drug.length <= QUERY_MAX_CHARS, h.slice(0, 12));
  }
  // No product name comes near the bound, so cutting a name there cannot make it match another.
  const names = new Set(JSON.parse(readFileSync(new URL('../data/drugs.json', import.meta.url), 'utf8')).rows.map((r) => r.name));
  for (const n of names) assert.ok(n.length < QUERY_MAX_CHARS, n);
});

test('every parameter in a hash is text the caller still has to check', () => {
  // The parser does not decide what a usable quantity is; quantityProblem() does (tests/money.test.js).
  assert.equal(parseHash('#drug=X&qty=1e300000000').qty, '1e300000000');
});

test('#q’s maxlength is the same bound', () => {
  const html = readFileSync(new URL('../src/app/index.html', import.meta.url), 'utf8');
  assert.equal(/<input id="q"[^>]*\bmaxlength="(\d+)"/.exec(html)[1], String(QUERY_MAX_CHARS));
});

test('caselessNames finds a name by any spelling of its case and spacing, and never guesses', () => {
  assert.equal(caseless.get(nameKey('eliquis 5 mg tablet')), 'ELIQUIS 5 MG TABLET');
  assert.equal(caseless.get(nameKey('  Eliquis   5 mg\ttablet ')), 'ELIQUIS 5 MG TABLET');
  assert.equal(caseless.get(nameKey('ELIQUIS 5MG TABLET')), undefined);
  const twins = caselessNames(['Foo 5 mg', 'FOO 5 MG', 'BAR']);
  assert.equal(twins.get(nameKey('foo 5 mg')), null);
  assert.equal(twins.get(nameKey('bar')), 'BAR');
});

test('clipText cuts reflected text with an ellipsis, never through a surrogate pair', () => {
  assert.equal(clipText('short'), 'short');
  assert.equal(clipText('x'.repeat(REFLECT_MAX_CHARS)), 'x'.repeat(REFLECT_MAX_CHARS));
  assert.equal(clipText('x'.repeat(REFLECT_MAX_CHARS + 1)), `${'x'.repeat(REFLECT_MAX_CHARS)}…`);
  assert.equal(clipText('abcdef', 3), 'abc…');
  const cut = clipText(`${'x'.repeat(REFLECT_MAX_CHARS - 1)}💊yy`);
  assert.equal(cut, `${'x'.repeat(REFLECT_MAX_CHARS - 1)}…`);
  assert.doesNotThrow(() => encodeURIComponent(cut));
  assert.equal(clipText(12345, 2), '12…');
});

test('an &ndc= comes back as written, and an address with only an NDC names no drug', () => {
  assert.equal(parseHash('#drug=X&ndc=00378-7185-05').ndc, '00378-7185-05');
  assert.equal(parseHash('#drug=X&ndc=<script>').ndc, '<script>');
  assert.equal(parseHash('#drug=X').ndc, null);
  assert.equal(parseHash('#ndc=00378718505').kind, 'bad');
  // The same text as an in-page anchor is still not addressed to OpenBill.
  assert.deepEqual(parseHash('#ndc-00378718505'), { kind: 'anchor', anchor: 'ndc-00378718505' });
});
