// build.js: the generated files are in sync with their inputs, every page carries a CSP whose
// hashes match its own inline script and style, nothing loads from outside, and the inline data
// unpacks to exactly data/drugs.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import vm from 'node:vm';
import {
  buildAll,
  bundle,
  computeBuildId,
  deflateRawFixed,
  parseModule,
  codeLineStarts,
  cspFor,
  DEFAULT_PRODUCT,
  TRY_PRODUCTS,
  SIZE_LIMIT,
  OG_IMAGE,
  socialMeta,
  showcaseDescription,
} from '../build.js';
import { unpackDrugs, linkRows } from '../src/core/pack.js';
import { RULES, summarizeProduct, partDNameContext } from '../src/core/rules.js';
import { formatMoney } from '../src/core/money.js';
import { SITE_URL } from '../src/core/config.js';

const root = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const built = buildAll();
const PAGES = ['openbill.html', 'methodology.html'];

function unescapeAttr(s) {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#96;/g, '`').replace(/&amp;/g, '&');
}

function inlineScripts(html) {
  // Executable inline scripts only: <script> with no type, or a JavaScript type.
  const out = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    const type = /\btype="([^"]*)"/.exec(attrs);
    if (!type || /^(text|application)\/javascript$|^module$/.test(type[1])) out.push({ attrs, body: m[2] });
  }
  return out;
}

function inlineStyles(html) {
  return [...html.matchAll(/<style(\s[^>]*)?>([\s\S]*?)<\/style>/g)].map((m) => m[2]);
}

function hash(text) {
  return `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

function cspOf(html) {
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  return m ? unescapeAttr(m[1]) : null;
}

function directives(csp) {
  const out = {};
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values;
  }
  return out;
}

function withoutScriptsAndStyles(html) {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
}

test('buildAll() output equals the committed generated files', () => {
  for (const rel of ['openbill.html', 'methodology.html', 'docs/DATA-QUALITY.md']) {
    assert.ok(built.files[rel], `buildAll() produces ${rel}`);
    const committed = read(rel);
    assert.ok(committed === built.files[rel], `${rel} is out of date: run node build.js`);
  }
  assert.deepEqual(Object.keys(built.files).sort(), ['docs/DATA-QUALITY.md', 'methodology.html', 'openbill.html']);
});

test('buildAll() is deterministic and has no timestamp', () => {
  const again = buildAll();
  for (const [rel, text] of Object.entries(built.files)) assert.ok(again.files[rel] === text, `${rel} differs between two builds`);
  assert.match(built.buildId, /^[0-9a-f]{12}$/);
  assert.equal(built.buildId, computeBuildId());
});

test('every page has a CSP meta whose hashes match its own inline script and style', () => {
  for (const rel of PAGES) {
    const html = built.files[rel];
    const csp = cspOf(html);
    assert.ok(csp, `${rel} has a CSP meta tag`);
    assert.ok(html.indexOf('http-equiv="Content-Security-Policy"') < html.indexOf('<style'), `${rel}: the CSP comes before the style`);
    const d = directives(csp);
    assert.deepEqual(Object.keys(d), ['default-src', 'script-src', 'style-src', 'font-src', 'img-src', 'base-uri', 'form-action']);
    assert.deepEqual(d['default-src'], ["'none'"]);
    assert.deepEqual(d['font-src'], ['data:']);
    assert.deepEqual(d['img-src'], ['data:']);
    assert.deepEqual(d['base-uri'], ["'none'"]);
    assert.deepEqual(d['form-action'], ["'none'"]);
    const scripts = inlineScripts(html).map((s) => s.body);
    const styles = inlineStyles(html);
    assert.equal(styles.length, 1, `${rel} has one inline style`);
    assert.deepEqual(d['style-src'], styles.map(hash), `${rel}: style-src hash matches the inline style`);
    assert.deepEqual(d['script-src'], scripts.length ? scripts.map(hash) : ["'none'"], `${rel}: script-src matches the inline scripts`);
    assert.equal(csp, cspFor(scripts, styles));
  }
  assert.equal(inlineScripts(built.files['openbill.html']).length, 1, 'openbill.html runs one inline script');
  assert.equal(inlineScripts(built.files['methodology.html']).length, 0, 'methodology.html runs no script');
});

test('no external scripts, styles or fonts; no style= attributes, inline handlers or eval', () => {
  for (const rel of PAGES) {
    const html = built.files[rel];
    assert.doesNotMatch(html, /<script[^>]*\ssrc=/i, `${rel}: no <script src>`);
    assert.doesNotMatch(html, /<link[^>]*rel="?stylesheet/i, `${rel}: no stylesheet link`);
    assert.doesNotMatch(html, /<link[^>]*rel="?(preload|prefetch|preconnect|dns-prefetch|modulepreload)/i, `${rel}: no preloads`);
    for (const css of inlineStyles(html)) {
      assert.doesNotMatch(css, /@import/i, `${rel}: no @import`);
      for (const m of css.matchAll(/url\(\s*['"]?([^'")\s]+)/g)) assert.match(m[1], /^data:/, `${rel}: CSS url() must be data:, got ${m[1].slice(0, 40)}`);
    }
    const icons = [...html.matchAll(/<link[^>]*rel="icon"[^>]*href="([^"]*)"/g)].map((m) => m[1]);
    for (const h of icons) assert.match(h, /^data:/);
    const markup = withoutScriptsAndStyles(html);
    assert.doesNotMatch(markup, /\sstyle\s*=/i, `${rel}: no style= attributes`);
    assert.doesNotMatch(markup, /<[^>]+\son[a-z]+\s*=/i, `${rel}: no inline event handlers`);
    assert.doesNotMatch(markup, /href="javascript:/i, `${rel}: no javascript: links`);
    assert.doesNotMatch(markup, /<(img|iframe|object|embed|audio|video|source)\b/i, `${rel}: no embedded resources`);
  }
  const code = inlineScripts(built.files['openbill.html'])[0].body;
  assert.doesNotMatch(code, /\beval\s*\(|new Function\s*\(|setTimeout\s*\(\s*['"`]/, 'the bundle uses no eval');
  assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/, 'the bundle makes no network calls');
  // "What were you charged?" is never stored or logged: the page keeps no browser storage at all
  // and writes nothing to the console.
  assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|document\.cookie|caches\.open|console\.(log|info|debug|warn|error)\s*\(/, 'the bundle stores and logs nothing');
});

test('the inline data unpacks to exactly data/drugs.json', () => {
  const html = built.files['openbill.html'];
  const m = /<script type="application\/json" id="openbill-data">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'openbill.html has the openbill-data block');
  assert.doesNotMatch(m[1], /</, '< is escaped in the data block');
  const desc = JSON.parse(m[1]);
  assert.equal(desc.format, 'openbill.inline/1');
  assert.equal(desc.encoding, 'deflate-raw+base64');
  // The descriptor has exactly the fields the contract lists (review DOC-5).
  assert.deepEqual(Object.keys(desc), ['format', 'encoding', 'json_bytes', 'sha256', 'data']);
  const text = zlib.inflateRawSync(Buffer.from(desc.data, 'base64'));
  assert.equal(text.length, desc.json_bytes);
  assert.equal(crypto.createHash('sha256').update(text).digest('hex'), desc.sha256);
  const doc = JSON.parse(read('data/drugs.json'));
  const back = unpackDrugs(JSON.parse(text.toString('utf8')));
  assert.deepStrictEqual(back, doc);
  assert.equal(JSON.stringify(back), JSON.stringify(doc), 'same key order');
});

test('the build block carries the build id, the source dates, the default card and the Try list', () => {
  const html = built.files['openbill.html'];
  const m = /<script type="application\/json" id="openbill-build">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m);
  const info = JSON.parse(m[1]);
  assert.equal(info.build_id, built.buildId);
  const doc = JSON.parse(read('data/drugs.json'));
  for (const [id, s] of Object.entries(doc.sources)) {
    assert.equal(info.sources[id].source_file, s.source_file);
    assert.equal(info.sources[id].retrieved_date, s.retrieved_date);
    assert.equal(info.sources[id].as_of_date, s.as_of_date ?? null);
    assert.equal(info.sources[id].period, s.period ?? null);
  }
  const names = new Set(doc.rows.map((r) => r.name));
  assert.deepEqual(info.default, { drug: DEFAULT_PRODUCT.drug, qty: DEFAULT_PRODUCT.qty });
  assert.ok(names.has(info.default.drug));
  assert.deepEqual(info.try, [...TRY_PRODUCTS]);
  assert.equal(TRY_PRODUCTS.length, 4);
  for (const n of TRY_PRODUCTS) assert.ok(names.has(n), `${n} is a product in the data`);
  assert.ok(html.includes(`build ${built.buildId}`), 'the footer shows the build id');
});

// docs/ARCHITECTURE.md, "Showcase", and the owner's decision of 2026-10-18.
test('the default card is the showcase, ARIPIPRAZOLE 10 MG TABLET at 30; metformin stays in the Try list', () => {
  assert.deepEqual({ ...DEFAULT_PRODUCT }, { drug: 'ARIPIPRAZOLE 10 MG TABLET', qty: 30 });
  assert.ok(TRY_PRODUCTS.includes('METFORMIN HCL 500 MG TABLET'));
  assert.ok(!TRY_PRODUCTS.includes(DEFAULT_PRODUCT.drug), 'the Try list does not repeat the default card');
  assert.equal(new Set(TRY_PRODUCTS).size, TRY_PRODUCTS.length);
});

function metaContent(html, attr, name) {
  const m = new RegExp(`<meta ${attr}="${name.replace(/[.:]/g, (c) => `\\${c}`)}" content="([^"]*)">`).exec(html);
  return m ? unescapeAttr(m[1]) : null;
}

test('both pages carry a canonical URL and link-preview tags; og:description is built from the showcase’s own figures', () => {
  const doc = JSON.parse(read('data/drugs.json'));
  const pages = { 'openbill.html': SITE_URL, 'methodology.html': `${SITE_URL}methodology.html` };
  assert.equal(OG_IMAGE, `${SITE_URL}og/site.png`);
  assert.match(SITE_URL, /^https:\/\/[^/]+\/.*\/$/);
  for (const [rel, url] of Object.entries(pages)) {
    const html = built.files[rel];
    const head = html.slice(0, html.indexOf('</head>'));
    const canon = [...head.matchAll(/<link rel="canonical" href="([^"]*)">/g)].map((m) => unescapeAttr(m[1]));
    assert.deepEqual(canon, [url], `${rel}: one canonical URL`);
    assert.equal(metaContent(head, 'property', 'og:url'), url, `${rel}: og:url`);
    assert.equal(metaContent(head, 'property', 'og:image'), OG_IMAGE, `${rel}: og:image`);
    assert.equal(metaContent(head, 'property', 'og:image:type'), 'image/png', `${rel}: og:image:type`);
    assert.equal(metaContent(head, 'property', 'og:type'), 'website');
    assert.equal(metaContent(head, 'name', 'twitter:card'), 'summary_large_image');
    // SEO-13: the same image and alt text for every preview service.
    assert.equal(metaContent(head, 'name', 'twitter:image'), OG_IMAGE, `${rel}: twitter:image`);
    assert.ok(metaContent(head, 'property', 'og:image:alt'), `${rel}: og:image:alt`);
    assert.equal(metaContent(head, 'name', 'twitter:image:alt'), metaContent(head, 'property', 'og:image:alt'), `${rel}: twitter:image:alt`);
    const title = unescapeAttr(/<title>([^<]*)<\/title>/.exec(head)[1]);
    assert.equal(metaContent(head, 'property', 'og:title'), title, `${rel}: og:title is the page title`);
    assert.ok(metaContent(head, 'property', 'og:description'), `${rel}: og:description`);
    // The tags are inert: the CSP still allows no image, and nothing is preloaded.
    assert.match(cspOf(html), /img-src data:;/);
  }
  const desc = metaContent(built.files['openbill.html'], 'property', 'og:description');
  assert.equal(desc, showcaseDescription(doc));
  // Every number in it is the card's own, worked out here from the core.
  const linked = linkRows(doc);
  const s = summarizeProduct(
    linked.filter((r) => r.name === DEFAULT_PRODUCT.drug),
    DEFAULT_PRODUCT.qty,
    { partDContext: partDNameContext(linked) },
  );
  assert.ok(desc.startsWith(`${DEFAULT_PRODUCT.drug}, quantity ${DEFAULT_PRODUCT.qty}: `), desc);
  for (const part of [
    `pharmacies pay ${formatMoney(s.pack.min.value)} (CMS NADAC eff. ${s.pack.min.effective_date}, ${s.pack.min.state})`,
    // H4: Part D is an average over every strength and form of the name, and says so.
    `Medicare Part D paid on average, across all strengths and forms of the name, ${formatMoney(s.reference.pack.min.value)}`,
    `${s.spread.sentence.replace(/\.$/, '')} (${s.spread.state})`,
    `cost-plus estimate ${formatMoney(s.cost_plus.min.value)} (estimated)`,
  ]) {
    assert.ok(desc.includes(part), `og:description has "${part}": ${desc}`);
  }
  assert.ok(desc.includes("Medicare's price is not your price."), 'a summary that shows the Medicare figure says it is not your price');
  // SEO-2: both pages link the static A–Z index in their HTML, so crawlers can reach the drug pages.
  for (const rel of Object.keys(pages)) assert.ok(built.files[rel].includes(`href="${SITE_URL}drugs/a/"`), `${rel}: a static link to the A–Z index`);
  // Owner decision 2026-10-18: the estimate is never called a cash price.
  for (const rel of Object.keys(pages)) assert.doesNotMatch(built.files[rel].slice(0, built.files[rel].indexOf('</head>')), /cash price/i);
  assert.throws(() => socialMeta({ title: 't', description: 'd', url: 'http://example.com/' }), /https/);
  assert.throws(() => socialMeta({ title: 't', description: 'd', url: SITE_URL, image: 'og/site.png' }), /https/);
  assert.throws(() => showcaseDescription(doc, { drug: 'NOT A DRUG', qty: 30 }), /not in data/);
});

test('openbill.html stays under the size budget', () => {
  assert.ok(built.sizes['openbill.html'] < SIZE_LIMIT, `${built.sizes['openbill.html']} bytes`);
});

test('methodology.html has an anchor for every rule and links back to the page', () => {
  const html = built.files['methodology.html'];
  for (const r of RULES) assert.match(html, new RegExp(`id="${r.id}"`), `anchor #${r.id}`);
  assert.match(html, /href="openbill\.html"/);
});

test('deflateRawFixed round-trips through zlib, edge cases included', () => {
  const cases = [
    Buffer.alloc(0),
    Buffer.from('a'),
    Buffer.from('ab'),
    Buffer.from('abc'),
    Buffer.alloc(1000, 0x41),
    Buffer.from('abcabcabcabcxyzabcab'.repeat(50)),
    Buffer.from('“quoted” × 4.9 — ünïcödé '.repeat(400)),
  ];
  const noise = Buffer.alloc(70000);
  let x = 12345;
  for (let i = 0; i < noise.length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    noise[i] = x >>> 24;
  }
  cases.push(noise);
  const far = Buffer.concat([Buffer.from('needle-in-a-haystack'), noise.subarray(0, 32700), Buffer.from('needle-in-a-haystack')]);
  cases.push(far);
  for (const c of cases) {
    const z = deflateRawFixed(c);
    assert.ok(zlib.inflateRawSync(Buffer.from(z)).equals(c), `round trip of ${c.length} bytes`);
    assert.deepEqual(deflateRawFixed(c), z, 'deterministic');
  }
});

test('the bundler follows the import/export convention and fails loudly otherwise', () => {
  const files = {
    'a/entry.js': "import { b } from './b.js';\nimport { c, d } from './c.js';\nconsole.log(b(), c, d);\n",
    'a/b.js': "import { c } from './c.js';\nexport function b() {\n  return c;\n}\n",
    'a/c.js': 'export const c = 1;\nexport class d {}\n',
  };
  const reader = (map) => (rel) => {
    if (!(rel in map)) throw new Error('no such file');
    return map[rel];
  };
  const { code, modules } = bundle('a/entry.js', reader(files));
  assert.deepEqual(modules, ['a/c.js', 'a/b.js', 'a/entry.js'], 'dependencies first');
  assert.doesNotMatch(code, /^\s*(import|export)\b/m);
  assert.match(code, /const \{ c \} = __m0;/);
  assert.match(code, /return \{ c, d \};/);

  const bad = (extra, msg) => assert.throws(() => bundle('a/entry.js', reader({ ...files, ...extra })), msg);
  bad({ 'a/c.js': 'export default 1;\n' }, /only export function/);
  bad({ 'a/c.js': 'const c = 1;\nexport { c };\n' }, /only export function/);
  bad({ 'a/c.js': "export * from './b.js';\n" }, /only export function/);
  bad({ 'a/b.js': "import c from './c.js';\nexport function b() {}\n" }, /single-line named imports/);
  bad({ 'a/b.js': "import { c as e } from './c.js';\nexport function b() {}\n" }, /single-line named imports/);
  bad({ 'a/b.js': "import { c } from 'c';\nexport function b() {}\n" }, /single-line named imports/);
  bad({ 'a/b.js': "import {\n  c,\n} from './c.js';\nexport function b() {}\n" }, /single-line named imports/);
  bad({ 'a/b.js': "export function b() { return import('./c.js'); }\n" }, /dynamic import/);
  bad({ 'a/c.js': "import { b } from './b.js';\nexport const c = 1;\nexport class d {}\n" }, /import cycle/);
  bad({ 'a/b.js': "import { nope } from './c.js';\nexport function b() {}\n" }, /does not export nope/);
  bad({ 'a/b.js': "import { c } from './missing.js';\nexport function b() {}\n" }, /cannot be read/);
  bad({ 'a/b.js': "import { c } from './c.js';\nconst c = 2;\nexport function b() {}\n" }, /already been declared|Identifier 'c'/);
  bad({ 'a/c.js': "export const c = '</script>';\nexport class d {}\n" }, /<\/script/);
  assert.throws(() => parseModule('x.js', '  export const a = 1;\n'), /column 0/);
});

// Review BLD-1: parseModule worked line by line, so `export` or `import` at column 0 inside a
// template literal or a block comment was taken as code. The build succeeded and the page broke
// (ReferenceError), or a string silently changed. Imports outside src/ were bundled although the
// build id hashes only src/**.
test('the bundler ignores import/export text inside template literals, strings and comments', () => {
  const reader = (map) => (rel) => {
    if (!(rel in map)) throw new Error('no such file');
    return map[rel];
  };
  const entry = "import { help, old, msg, re, quote, t2 } from './m.js';\nconsole.log(help, old, msg, re, quote, t2);\n";
  const m = [
    'export const help = `Usage:',
    'export const PRICE = 5',
    '`;',
    '/*',
    'export function gone() {}',
    '*/',
    'function f() {}',
    'export const msg = `Copy this:',
    'export function f() {}',
    "import { zz } from './zz.js';",
    'end ${f.name} and ${`nested',
    'export const deep = 1`} done`;',
    "export const re = /[`'\"/]/g;",
    'const ratio = 4 / 2 / 1;',
    "export const quote = 'it\\'s `fine`';",
    'export const t2 = `${{ a: 1 }.a}`;',
    'export function old() {',
    '  return f;',
    '}',
    '',
  ].join('\n');
  const { code } = bundle('a/entry.js', reader({ 'a/entry.js': entry, 'a/m.js': m }));
  const parsed = parseModule('a/m.js', m);
  assert.deepEqual(parsed.exports, ['help', 'msg', 're', 'quote', 't2', 'old']);
  assert.deepEqual(parsed.imports, []);
  // The template literals are byte-for-byte unchanged in the bundle.
  assert.ok(code.includes('const help = `Usage:\nexport const PRICE = 5\n`;'), 'help text kept');
  assert.ok(code.includes("export function f() {}\nimport { zz } from './zz.js';\nend ${f.name}"), 'msg text kept');
  assert.ok(code.includes('/*\nexport function gone() {}\n*/'), 'the comment is kept');
  // The bundle runs: the module's exports are the declared ones.
  const vmCode = code.replace('console.log(help, old, msg, re, quote, t2);', 'globalThis.out = { help, old: typeof old, msg, re: String(re), quote, t2 };');
  const ctx = vm.createContext({ console: { log() {} }, performance: { now: () => 0 } });
  new vm.Script(vmCode).runInContext(ctx);
  assert.equal(ctx.out.help, 'Usage:\nexport const PRICE = 5\n');
  assert.equal(ctx.out.old, 'function');
  assert.ok(ctx.out.msg.startsWith('Copy this:\nexport function f() {}\nimport { zz }'));
  assert.equal(ctx.out.quote, "it's `fine`");
  assert.equal(ctx.out.t2, '1');
  // Lines inside a literal are text: codeLineStarts says which lines start in code.
  const starts = codeLineStarts(m);
  assert.deepEqual(
    m.split('\n').map((_, i) => starts[i]),
    [true, false, false, true, false, false, true, true, false, false, false, false, true, true, true, true, true, true, true, true],
  );
  assert.throws(() => codeLineStarts('const s = `open\n'), /unterminated template literal/);
  assert.throws(() => codeLineStarts('/* open\n'), /unterminated block comment/);
  assert.throws(() => codeLineStarts("const s = 'open\n"), /unterminated string/);
});

test('the bundler refuses imports outside the entry folder and a bundle that fails when it runs', () => {
  const reader = (map) => (rel) => {
    if (!(rel in map)) throw new Error('no such file');
    return map[rel];
  };
  assert.throws(
    () => bundle('a/entry.js', reader({ 'a/entry.js': "import { x } from '../tools/x.js';\nconsole.log(x);\n", 'tools/x.js': 'export const x = 1;\n' })),
    /outside a\//,
  );
  assert.throws(() => bundle('a/entry.js', reader({ 'a/entry.js': 'undefinedName();\n' })), /the bundle fails when it runs: .*undefinedName/);
  // The real page bundle runs against an empty page without throwing.
  assert.ok(bundle().code.length > 1000);
});
