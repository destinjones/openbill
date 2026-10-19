import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { epcName, epcClasses, classIndex, nonproprietaryNames, siblings, partDClaims, related } from '../src/core/related.js';
import { linkRows } from '../src/core/pack.js';
import { groupProducts } from '../src/core/search.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/drugs.v3.sample.json', import.meta.url), 'utf8'));
const PRODUCTS = groupProducts(linkRows(FIXTURE));
const product = (name) => PRODUCTS.find((p) => p.name.startsWith(name));
const names = (list) => list.map((p) => p.name);

// Made-up products for ranking (fixture data, not real drugs, classes or claims): only the
// fields related.js reads. `claims` is a Part D claims count record on a linked row.
function make(name, { np, strength = '10 mg/1', form = 'TABLET', classes = [], claims } = {}) {
  const row = {
    ndc: '90099000000',
    name,
    identity:
      np === undefined
        ? null
        : { nonproprietary_name: np, strength, dosage_form: form, pharm_classes: classes },
    part_d:
      claims === undefined
        ? null
        : { key: `${name}|${np}`, claims: { value: claims, kind: 'count', state: 'filed', reason: 'Fixture data, not a real figure.', source_name: 'Medicare Part D', source_url: 'https://data.cms.gov/', source_file: 'fixture-partd.csv', effective_date: '2024-01-01', retrieved_date: '2026-10-17', per: 'claim', period: '2024-01-01/2024-12-31' } },
  };
  return { name, rows: [row] };
}

test('the fixture rows carry FDA-style pharm_classes, and the fixture says they are made up', () => {
  assert.match(FIXTURE.fixture, /pharmacologic classes \(identity\.pharm_classes/);
  const withClasses = FIXTURE.rows.filter((r) => r.identity && Array.isArray(r.identity.pharm_classes));
  assert.equal(withClasses.length, FIXTURE.rows.filter((r) => r.identity).length, 'every fixture identity has pharm_classes');
  for (const r of withClasses) for (const c of r.identity.pharm_classes) assert.match(c, /^\S.*\S \[(EPC|MoA|CS|PE)\]$/, c);
});

test('epcName strips the [EPC] tag', () => {
  assert.equal(epcName('Factor Xa Inhibitor [EPC]'), 'Factor Xa Inhibitor');
  assert.equal(epcName('Factor Xa Inhibitor'), 'Factor Xa Inhibitor');
  assert.equal(epcName(' Insulin  [EPC]'), 'Insulin');
});

test('epcClasses: the [EPC] entries only, key keeps the tag, name drops it, sorted and frozen', () => {
  const e = epcClasses(product('ELIQUIS'));
  assert.deepEqual(e, [{ key: 'Factor Xa Inhibitor [EPC]', name: 'Factor Xa Inhibitor' }]);
  assert.ok(Object.isFrozen(e) && Object.isFrozen(e[0]));
  // MoA and CS entries are not classes.
  assert.deepEqual(epcClasses(product('FIXTUMAB')), []);
  // No FDA identity: no class.
  assert.deepEqual(epcClasses(product('ACETAMINOPHEN')), []);
  assert.deepEqual(epcClasses(product('HEPARIN')), []);
  // Two NDCs of one product, one without identity: the classes of the one with it.
  assert.deepEqual(epcClasses(product('METFORMIN')), [{ key: 'Biguanide [EPC]', name: 'Biguanide' }]);
  // Rows as well as products; several EPC entries across rows, de-duplicated and sorted by name.
  const p = make('FIXTURE MULTI', { np: 'x', classes: ['Zeta Blocker [EPC]', 'Alpha Agonist [EPC]', 'Alpha Agonists [MoA]', ' Zeta Blocker [EPC] ', 7, null] });
  assert.deepEqual(epcClasses(p.rows), [
    { key: 'Alpha Agonist [EPC]', name: 'Alpha Agonist' },
    { key: 'Zeta Blocker [EPC]', name: 'Zeta Blocker' },
  ]);
  // A tag written differently is not an EPC entry; a missing or non-array field adds nothing.
  assert.deepEqual(epcClasses(make('FIXTURE LOWER', { np: 'x', classes: ['Thing [epc]', '[EPC]'] })), []);
  const odd = make('FIXTURE ODD', { np: 'x' });
  odd.rows[0].identity.pharm_classes = 'Thing [EPC]';
  assert.deepEqual(epcClasses(odd), []);
  delete odd.rows[0].identity.pharm_classes;
  assert.deepEqual(epcClasses(odd), []);
  assert.throws(() => epcClasses(null), TypeError);
  assert.throws(() => epcClasses({ name: 'x' }), TypeError);
});

test('classIndex: class key → products in it, classes ordered by name, products by name', () => {
  const idx = classIndex(PRODUCTS);
  assert.ok(idx instanceof Map);
  assert.deepEqual(
    [...idx.keys()],
    [
      'Biguanide [EPC]',
      'Factor Xa Inhibitor [EPC]',
      'Insulin [EPC]',
      'l-Thyroxine [EPC]',
      'Penicillin-class Antibacterial [EPC]',
      'Serotonin Reuptake Inhibitor [EPC]',
      'Serotonin-3 Receptor Antagonist [EPC]',
    ],
  );
  assert.deepEqual(names(idx.get('Factor Xa Inhibitor [EPC]')), ['ELIQUIS 5 MG TABLET']);
  assert.ok(Object.isFrozen(idx.get('Biguanide [EPC]')));
  const a = make('FIXTURE B', { np: 'b', classes: ['Shared [EPC]'] });
  const b = make('FIXTURE A', { np: 'a', classes: ['Shared [EPC]', 'Other [EPC]'] });
  const small = classIndex([a, b]);
  assert.deepEqual([...small.keys()], ['Other [EPC]', 'Shared [EPC]']);
  assert.deepEqual(names(small.get('Shared [EPC]')), ['FIXTURE A', 'FIXTURE B']);
  assert.throws(() => classIndex(null), TypeError);
});

test('nonproprietaryNames: distinct, folded to lower case, spacing tidied, sorted', () => {
  assert.deepEqual(nonproprietaryNames(product('ELIQUIS')), ['apixaban']);
  assert.deepEqual(nonproprietaryNames(product('ACETAMINOPHEN')), []);
  const p = { name: 'FIXTURE SPELLINGS', rows: [make('a', { np: 'Metformin  HCl' }).rows[0], make('a', { np: 'metformin hydrochloride' }).rows[0], make('a', { np: 'METFORMIN HCL' }).rows[0]] };
  assert.deepEqual(nonproprietaryNames(p), ['metformin hcl', 'metformin hydrochloride']);
});

test('siblings: products sharing a nonproprietary name; same strength first, then same form, then name', () => {
  // Fixture: no two products share a nonproprietary name.
  for (const p of PRODUCTS) assert.deepEqual(siblings(p, PRODUCTS), [], p.name);
  const brand = make('FIXTURE BRAND 5 MG TABLET', { np: 'fixtuprazole', strength: '5 mg/1' });
  const generic5 = make('FIXTUPRAZOLE 5 MG TABLET', { np: 'Fixtuprazole', strength: '5 mg/1' });
  const generic10 = make('FIXTUPRAZOLE 10 MG TABLET', { np: 'fixtuprazole', strength: '10 mg/1' });
  const solution = make('FIXTUPRAZOLE 1 MG/ML SOLN', { np: 'fixtuprazole', strength: '1 mg/mL', form: 'SOLUTION' });
  const odt5 = make('FIXTUPRAZOLE ODT 5 MG', { np: 'fixtuprazole', strength: '5 mg/1', form: 'TABLET, ORALLY DISINTEGRATING' });
  // A second spelling of the ingredient on one of its NDCs still links it.
  const salt = { name: 'FIXTUPRAZOLE SALT 20 MG TABLET', rows: [make('x', { np: 'fixtuprazole salt', strength: '20 mg/1' }).rows[0], make('x', { np: 'fixtuprazole', strength: '20 mg/1' }).rows[0]] };
  const combo = make('FIXTUPRAZOLE-OTHER 5-10 MG TABLET', { np: 'fixtuprazole and otherzole', strength: '5 mg/1' });
  const none = make('FIXTURE NO IDENTITY');
  const all = [solution, generic10, combo, brand, none, odt5, salt, generic5];
  assert.deepEqual(names(siblings(brand, all)), [
    'FIXTUPRAZOLE 5 MG TABLET', // same strength, same form
    'FIXTUPRAZOLE ODT 5 MG', // same strength
    'FIXTUPRAZOLE 10 MG TABLET', // same form
    'FIXTUPRAZOLE SALT 20 MG TABLET',
    'FIXTUPRAZOLE 1 MG/ML SOLN',
  ]);
  assert.ok(Object.isFrozen(siblings(brand, all)));
  assert.ok(!siblings(brand, all).includes(combo), 'a combination product is a name of its own');
  assert.deepEqual(names(siblings(salt, all)).sort(), names([brand, generic5, generic10, solution, odt5]).sort());
  assert.deepEqual(siblings(none, all), []);
  // The product itself, or another entry with its name, is never its own sibling.
  assert.ok(!siblings(brand, [...all, { ...brand }]).some((p) => p.name === brand.name));
  assert.throws(() => siblings(brand, null), TypeError);
});

test('partDClaims: the largest claims count among the rows, or null', () => {
  assert.equal(partDClaims(product('ELIQUIS')), 14847081);
  assert.equal(partDClaims(product('METFORMIN')), 2345678, 'one of its two NDCs joins Part D');
  assert.equal(partDClaims(product('ACETAMINOPHEN')), null);
  // An unlinked row (part_d without its table fields) has no claims to read.
  const unlinked = groupProducts(FIXTURE.rows).find((p) => p.name.startsWith('ELIQUIS'));
  assert.equal(partDClaims(unlinked), null);
});

test('related: same class, then more Part D claims, then name; siblings left out; one product per drug', () => {
  const C = ['Fixture Class [EPC]'];
  const me = make('FIXTUPRAZOLE 5 MG TABLET', { np: 'fixtuprazole', classes: C, claims: 10 });
  const myBrand = make('FIXTURE BRAND 5 MG TABLET', { np: 'fixtuprazole', classes: C, claims: 10 });
  const a5 = make('ALPHAZOLE 5 MG TABLET', { np: 'alphazole', classes: C, claims: 500 });
  const a10 = make('ALPHAZOLE 10 MG TABLET', { np: 'alphazole', classes: C, claims: 500 });
  const aSol = make('ALPHAZOLE 1 MG/ML SOLN', { np: 'alphazole', classes: C, claims: 500, form: 'SOLUTION' });
  const beta = make('BETAZOLE 5 MG TABLET', { np: 'betazole', classes: C, claims: 900 });
  const gamma = make('GAMMAZOLE 5 MG TABLET', { np: 'gammazole', classes: C });
  const delta = make('DELTAZOLE 5 MG TABLET', { np: 'deltazole', classes: C });
  const twoClasses = make('ZETAZOLE 5 MG TABLET', { np: 'zetazole', classes: [...C, 'Second Class [EPC]'] });
  const noId = make('FIXTURE UNLISTED 5 MG');
  noId.rows[0].identity = { pharm_classes: C }; // a class but no nonproprietary name: its own entry
  const elsewhere = make('OTHERCLASS 5 MG TABLET', { np: 'otherclass', classes: ['Unrelated [EPC]'], claims: 99999 });
  me.rows[0].identity.pharm_classes = [...C, 'Second Class [EPC]'];
  const all = [me, myBrand, a5, a10, aSol, beta, gamma, delta, twoClasses, noId, elsewhere];
  const idx = classIndex(all);
  const r = related(me, all, idx);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r[0]) && Object.isFrozen(r[0].classes));
  assert.deepEqual(
    r.map((x) => [x.product.name, x.classes.length, x.claims]),
    [
      ['ZETAZOLE 5 MG TABLET', 2, null], // shares both classes
      ['BETAZOLE 5 MG TABLET', 1, 900],
      ['ALPHAZOLE 10 MG TABLET', 1, 500], // one alphazole: same form as mine, then first by name
      ['DELTAZOLE 5 MG TABLET', 1, null],
      ['FIXTURE UNLISTED 5 MG', 1, null],
    ],
  );
  assert.deepEqual(r[0].classes, ['Fixture Class [EPC]', 'Second Class [EPC]']);
  assert.ok(!r.some((x) => x.product === myBrand), 'a sibling is linked separately, not as related');
  assert.ok(!r.some((x) => x.product === me));
  // n
  assert.deepEqual(related(me, all, idx, 2).map((x) => x.product.name), ['ZETAZOLE 5 MG TABLET', 'BETAZOLE 5 MG TABLET']);
  assert.equal(related(me, all, idx, 100).length, 6);
  assert.deepEqual(related(me, all, idx, 0), []);
  for (const bad of [-1, 1.5, '5', NaN]) assert.throws(() => related(me, all, idx, bad), RangeError, String(bad));
  assert.throws(() => related(me, all, {}), TypeError);
  // Deterministic: input order does not matter.
  const shuffled = [...all].reverse();
  assert.deepEqual(
    related(me, shuffled, classIndex(shuffled)).map((x) => x.product.name),
    r.map((x) => x.product.name),
  );
  // A product with no EPC class has no related products.
  assert.deepEqual(related(make('FIXTURE NOCLASS', { np: 'n' }), all, idx), []);
});

test('related: candidates that share a nonproprietary name through another are one drug', () => {
  const C = ['Fixture Class [EPC]'];
  const me = make('MINE 1 MG TABLET', { np: 'mine', classes: C });
  // "omega" and "omega sodium" are joined by a product that lists both.
  const o1 = make('OMEGA 1 MG TABLET', { np: 'omega', classes: C, claims: 5 });
  const o2 = { name: 'OMEGA SODIUM 2 MG TABLET', rows: [make('x', { np: 'omega', classes: C, claims: 5 }).rows[0], make('x', { np: 'omega sodium', classes: C, claims: 5 }).rows[0]] };
  const o3 = make('OMEGA SODIUM 3 MG CAPSULE', { np: 'omega sodium', classes: C, claims: 5, form: 'CAPSULE' });
  const all = [me, o3, o2, o1];
  assert.deepEqual(related(me, all, classIndex(all)).map((x) => x.product.name), ['OMEGA 1 MG TABLET']);
});

test('related: on the fixture, products in classes of their own have nothing related', () => {
  const idx = classIndex(PRODUCTS);
  for (const p of PRODUCTS) assert.deepEqual(related(p, PRODUCTS, idx), [], p.name);
});

test('related.js is DOM-free and follows the bundler conventions', () => {
  const src = readFileSync(new URL('../src/core/related.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\b(window|document|fetch|Date\.now|localStorage)\b/);
  assert.doesNotMatch(src, /export default|export \{/);
  for (const line of src.split('\n').filter((l) => l.startsWith('import'))) assert.match(line, /^import \{ [\w, ]+ \} from '\.\/[\w-]+\.js';$/);
  const slug = readFileSync(new URL('../src/core/slug.js', import.meta.url), 'utf8');
  assert.doesNotMatch(slug, /\b(window|document|fetch|Date\.now|localStorage)\b/);
  assert.doesNotMatch(slug, /export default|export \{/);
});
