// The press kit (press/index.html, src/build/presspage.js) and the reveal clip's frames
// (src/build/reveal.js), decision 51. The site is built for the showcase alone, without images,
// and the page is checked against the core: every number on it is the one core computes from
// data/drugs.json, the DOIs are CITATION.cff's, the honesty lines are verbatim, and every link
// resolves. The pictures themselves are rendered and checked in tests/browser/press.spec.js.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSite, readData, ROOT, appDefault } from '../tools/site.mjs';
import { SITE_CSP, SHOWCASE, METHODOLOGY_ANCHORS } from '../src/build/drugpage.js';
import { PRESS_PATH, PRESS_SHOTS, PRESS_WORDMARKS, pressMediaFiles, citationDois, renderPressPage, renderWordmarkHtml } from '../src/build/presspage.js';
import { REVEAL_LAYOUTS, REVEAL_DURATION_CS, REVEAL_FRAME_CS, revealFacts, revealTimeline, revealQuery, renderRevealHtml } from '../src/build/reveal.js';
import { linkRows } from '../src/core/pack.js';
import { groupProducts } from '../src/core/search.js';
import { summarizeProduct, defaultQuantity, partDNameContext, formatSpreadMultiple, HONESTY } from '../src/core/rules.js';
import { formatMoney, formatCount } from '../src/core/money.js';
import { esc } from '../src/core/esc.js';
import { SITE_URL, REPO_URL } from '../src/core/config.js';

const { doc } = readData();
const rows = linkRows(doc);
const products = groupProducts(rows);
const context = partDNameContext(rows);
const miss = (x) => !x || x.missing === true;
const show = products.find((p) => p.name === SHOWCASE.drug);
const s = summarizeProduct(show.rows, defaultQuantity(show).qty, { partDContext: context });
const CFF = fs.readFileSync(path.join(ROOT, 'CITATION.cff'), 'utf8');

let tmp;
let site;
let html;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openbill-press-'));
  site = await buildSite({ out: path.join(tmp, 'site'), only: [SHOWCASE.drug], og: false, checkAnchors: false, log: () => {} });
  html = fs.readFileSync(path.join(site.out, 'press', 'index.html'), 'utf8');
});

after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers

function unesc(t) {
  return String(t)
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#96;/g, '`')
    .replace(/&amp;/g, '&');
}

function textOf(fragment) {
  return unesc(String(fragment).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function meta(page, attr, key) {
  const m = new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`).exec(page);
  return m ? unesc(m[1]) : null;
}

function figure(page, key) {
  const m = new RegExp(`<span class="[^"]*" data-figure="${key}">([^<]*)</span>`).exec(page);
  return m ? unesc(m[1]) : null;
}

function count(page, key) {
  const m = new RegExp(`data-count="${key}">([^<]*)</span>`).exec(page);
  return m ? m[1] : null;
}

/** Every URL the page refers to: href, src and srcset. */
function urls(page) {
  return [...page.matchAll(/\s(?:href|src|srcset)="([^"]*)"/g)].map((m) => unesc(m[1]));
}

/** The core's own figures for the showcase, worked out here from summarizeProduct(). */
const want = {
  pharmacy: formatMoney(s.pack.min.value),
  medicare: formatMoney(s.reference.pack.min.value),
  spread: formatSpreadMultiple(s.spread.range.min.value),
  year: s.reference.range.min.period.slice(0, 4),
};

// ---------------------------------------------------------------- the page

test('the showcase still suits the press kit: one pack total, a Part D figure, a spread that is not extreme', () => {
  assert.ok(!miss(s.pack) && s.pack.same, 'one pack total');
  assert.ok(!miss(s.reference) && s.reference.kind === 'part_d' && s.reference.pack.same, 'one Part D figure');
  assert.ok(!miss(s.spread) && !s.spread.extreme && s.spread.range.min.value === s.spread.range.max.value, 'one spread, not extreme');
  // The figures decision 45 records; a data refresh that moves them must re-check the showcase.
  assert.deepEqual(want, { pharmacy: '$3.35', medicare: '$46.50', spread: '13.9×', year: '2024' });
});

test('press/index.html: static, no script at all, the site CSP and stylesheet, canonical and preview tags', () => {
  assert.ok(html.startsWith('<!doctype html>\n<html lang="en">'));
  assert.equal(meta(html, 'http-equiv', 'Content-Security-Policy'), SITE_CSP);
  assert.doesNotMatch(html, /<script/i, 'no script, not even JSON-LD');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no event handler attribute');
  assert.doesNotMatch(html, /\sstyle\s*=|<style|javascript:/i, 'no inline style or javascript: URL');
  assert.match(html, /<link rel="stylesheet" href="\.\.\/assets\/site\.css">/);
  assert.ok(html.includes(`<link rel="canonical" href="${SITE_URL}press/">`));
  assert.equal(meta(html, 'property', 'og:url'), `${SITE_URL}press/`);
  assert.equal(meta(html, 'property', 'og:image'), `${SITE_URL}og/site.png`);
  assert.equal(unesc(/<title>([^<]*)<\/title>/.exec(html)[1]), 'Press kit | OpenBill');
  assert.ok(html.includes('<h1 class="page-title">Press kit</h1>'));
  const sitemap = fs.readFileSync(path.join(site.out, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, new RegExp(`<url><loc>${SITE_URL}press/</loc><lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod></url>`));
  assert.equal(site.press.file, `${PRESS_PATH}index.html`);
});

test('the headline numbers are core’s: figures, states, the Part D year, and every source line', () => {
  assert.equal(figure(html, 'pharmacy'), want.pharmacy);
  assert.equal(figure(html, 'medicare'), want.medicare);
  assert.equal(figure(html, 'spread'), want.spread);
  const chips = [...html.matchAll(/data-figure="(pharmacy|medicare|spread)">[^<]*<\/span> <span class="chip chip-([a-z]+)">/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(chips, [
    ['pharmacy', s.pack.min.state],
    ['medicare', s.reference.range.state],
    ['spread', s.spread.state],
  ]);
  assert.equal(s.spread.state, 'estimated');
  const text = textOf(html);
  assert.ok(text.includes(`The ${want.year} average across every strength and form sold under the name`), 'the Part D figure is a name-level average');
  assert.ok(text.includes(s.spread.sentence), 'the spread sentence, from core');
  assert.match(html, /data-prov="pharmacy">CMS NADAC · nadac-[^<]+\.csv · eff\. \d{4}-\d{2}-\d{2}/);
  assert.match(html, /data-prov="medicare">Medicare Part D · DSD_PTD_[^<]+ · eff\. /);
  assert.match(html, /data-prov="spread">OpenBill calculation · /);
  assert.ok(html.includes('<strong>Medicare&#39;s price is not your price.</strong>'), 'not your price, next to the Medicare figure');
  // The links to the showcase's own page and card.
  const slug = site.model.slugs.get(SHOWCASE.drug);
  assert.ok(html.includes(`href="../drug/${slug}/"`));
  assert.ok(html.includes(`href="../#drug=${esc(encodeURIComponent(SHOWCASE.drug))}&amp;qty=${SHOWCASE.qty}"`));
});

test('the counts are the build’s: products, NDCs and products with a Medicare figure', () => {
  assert.equal(count(html, 'products'), formatCount(products.length));
  assert.equal(count(html, 'ndcs'), formatCount(new Set(rows.map((r) => r.ndc)).size));
  const withMedicare = products.filter((p) => !miss(summarizeProduct(p.rows, defaultQuantity(p).qty, { partDContext: context }).reference)).length;
  assert.equal(count(html, 'medicare'), formatCount(withMedicare));
  // Source dates: every source in the build with its file and dates.
  for (const src of Object.values(doc.sources)) {
    assert.ok(html.includes(esc(src.source_file)), `${src.source_file} is listed`);
    if (src.as_of_date) assert.ok(html.includes(`as of ${src.as_of_date}`));
    assert.ok(html.includes(`retrieved ${src.retrieved_date}`));
  }
});

test('the paragraph to paste: one paragraph, every number and date in it from the build, the DOI from CITATION.cff', () => {
  const m = /<blockquote class="paste"><p>([^<]*)<\/p><\/blockquote>/.exec(html);
  assert.ok(m, 'one plain paragraph, no markup inside');
  const p = unesc(m[1]);
  assert.equal(p, site.press.paragraph);
  for (const bit of [
    SITE_URL,
    `${formatCount(products.length)} drug products`,
    `${formatCount(rows.length)} National Drug Codes`,
    `NADAC) file of ${doc.sources.nadac.as_of_date}`,
    `for 30 tablets, pharmacies pay ${want.pharmacy}`,
    `Medicare Part D paid ${want.medicare}, its ${want.year} average`,
    `${s.spread.sentence.replace(/\.$/, '')}, a comparison OpenBill labels estimated.`,
    "Medicare's price is not your price.",
    `(DOI ${citationDois(CFF)[0].doi})`,
  ]) {
    assert.ok(p.includes(bit), `the paragraph says ${JSON.stringify(bit)}`);
  }
  // Every number in it is one of the build's, a date, or the DOI: none typed by hand.
  const allowed = new Set([want.pharmacy, want.medicare, want.spread, want.year, formatCount(products.length), formatCount(rows.length), '30', '10']);
  const scrubbed = p
    .replace(SITE_URL, '')
    .replace(/\d{4}-\d{2}-\d{2}/g, '')
    .replace(/10\.5281\/zenodo\.\d+/g, '');
  for (const n of scrubbed.match(/\$?\d[\d,]*(\.\d+)?×?/g) || []) assert.ok(allowed.has(n), `${n} in the paragraph is not one of the build's numbers`);
});

test('the DOIs are CITATION.cff’s, each linked at doi.org', () => {
  const dois = citationDois(CFF);
  assert.deepEqual(
    dois.map((d) => d.doi),
    ['10.5281/zenodo.23457871', '10.5281/zenodo.23457872'],
  );
  assert.match(CFF, new RegExp(`^doi: "${dois[0].doi.replace(/\./g, '\\.')}"$`, 'm'), 'the first listed DOI is the all-versions DOI');
  for (const d of dois) {
    assert.ok(html.includes(`<a href="https://doi.org/${d.doi}" rel="noopener">${d.doi}</a>`), d.doi);
    assert.ok(textOf(html).includes(`${d.description}: ${d.doi}`), `${d.doi} with its description`);
  }
  assert.deepEqual(citationDois('title: "x"\n'), []);
  assert.throws(() => citationDois('identifiers:\n  - type: doi\n    value: "not-a-doi"\n'), /not a DOI/);
});

test('contact through GitHub issues; the five honesty lines verbatim', () => {
  assert.ok(html.includes(`<a href="${REPO_URL}/issues" rel="noopener">`), 'issues link');
  assert.ok(html.includes(`<a href="${REPO_URL}/blob/main/SECURITY.md" rel="noopener">`), 'security goes privately');
  const text = textOf(html);
  for (const h of HONESTY) assert.ok(text.includes(h.text), `honesty line ${h.id}`);
  assert.ok(text.includes('holds every page to these five rules, written by the project’s owner and quoted word for word:'));
});

test('pictures: every one the image step writes is shown and offered for download, and nothing else is referenced', () => {
  const files = pressMediaFiles();
  assert.deepEqual([...files].sort(), [
    'card-360-dark.png',
    'card-360.png',
    'card-desktop.png',
    'openbill-reveal-9x16.gif',
    'openbill-reveal.gif',
    'openbill-reveal.png',
    'openbill-wordmark-on-dark.png',
    'openbill-wordmark.png',
  ]);
  const local = urls(html).filter((u) => /\.(png|gif)$/.test(u));
  assert.deepEqual([...new Set(local)].sort(), [...files].sort());
  for (const f of files) assert.ok(html.includes(`<a href="${f}" download>`), `${f} can be downloaded`);
  // Sizes stated on the page are the layouts' own.
  for (const l of Object.values(REVEAL_LAYOUTS)) assert.ok(html.includes(`<img src="${l.file}" width="${l.width}" height="${l.height}"`), l.file);
  for (const sh of PRESS_SHOTS) assert.ok(html.includes(`<img src="${sh.file}" width="${sh.viewport.width}" height="${sh.viewport.height}"`), sh.file);
  // Alt text carries the figures, and the clip has a still for readers who ask for less motion.
  for (const m of html.matchAll(/<img [^>]*alt="([^"]*)"/g)) assert.ok(unesc(m[1]).length > 40, `alt text: ${m[1]}`);
  assert.ok(html.includes(`<source media="(prefers-reduced-motion: reduce)" srcset="${REVEAL_LAYOUTS.wide.still}">`));
  // --no-og writes none of them.
  assert.ok(!fs.existsSync(path.join(site.out, 'press', REVEAL_LAYOUTS.wide.file)));
  assert.equal(site.press.media, null);
});

test('every link on the press page resolves in the built site, or is a picture the image step writes, or an https page', () => {
  const media = new Set(pressMediaFiles());
  let n = 0;
  for (const href of urls(html)) {
    n += 1;
    if (href === 'data:,') continue;
    if (/^https:\/\//.test(href)) {
      assert.doesNotThrow(() => new URL(href), href);
      continue;
    }
    if (href === '#main') continue;
    assert.ok(!/^(javascript|data|http):/i.test(href), `unsafe link ${href}`);
    const [pathPart, frag] = href.split('#');
    const target = path.posix.normalize(path.posix.join('press', pathPart));
    assert.ok(!target.startsWith('..'), `${href} leaves the site`);
    const file = target.endsWith('/') || target === '.' ? `${target === '.' ? '' : target}index.html` : target;
    if (frag !== undefined && file === 'methodology.html') assert.ok(METHODOLOGY_ANCHORS.includes(frag), `methodology.html has no #${frag}`);
    if (frag !== undefined && file === 'index.html') assert.match(frag, /^drug=[^&]+&qty=\d+$/, href);
    if (file.startsWith('press/') && media.has(file.slice('press/'.length))) continue;
    assert.ok(fs.existsSync(path.join(site.out, file)), `${href} resolves to ${file}, which is not in the site`);
  }
  assert.ok(n > 30, `checked ${n} links`);
  // Every static page's footer links the press kit.
  const drug = fs.readFileSync(path.join(site.out, 'drug', site.model.slugs.get(SHOWCASE.drug), 'index.html'), 'utf8');
  assert.ok(drug.includes('<a href="../../press/">Press kit</a>'));
});

test('the press page is deterministic and stops the build for a showcase it cannot show', () => {
  const dois = citationDois(CFF);
  const a = renderPressPage(site.model, site.model.byName.get(SHOWCASE.drug), { dois });
  assert.equal(a.html, html, 'the same inputs give the same bytes');
  assert.throws(() => renderPressPage(site.model, site.model.byName.get(SHOWCASE.drug), { dois: [] }), /DOIs/);
  const extreme = site.model.products.find((p) => {
    const x = summarizeProduct(p.rows, defaultQuantity(p).qty, { partDContext: context });
    return !miss(x.spread) && x.spread.extreme && !miss(x.pack);
  });
  assert.ok(extreme, 'the data has a product with an extreme spread');
  assert.throws(() => renderPressPage(site.model, extreme, { dois }), /extreme.+Choose another showcase \(decision 45\)/);
  const none = site.model.products.find((p) => miss(summarizeProduct(p.rows, defaultQuantity(p).qty, { partDContext: context }).reference));
  assert.throws(() => revealFacts(site.model, none), /no Medicare figure/);
});

test('the app opens on the showcase, so the press screenshots show the press page’s numbers', () => {
  const d = appDefault(fs.readFileSync(path.join(ROOT, 'openbill.html'), 'utf8'));
  assert.deepEqual({ drug: d.drug, qty: Number(d.qty) }, { drug: SHOWCASE.drug, qty: SHOWCASE.qty });
  assert.throws(() => appDefault('<html></html>'), /no openbill-build/);
});

// ---------------------------------------------------------------- the reveal clip's frames

test('the reveal timeline: 6 seconds, typed a letter a frame, each beat in order, settling on core’s spread and holding', () => {
  const f = revealFacts(site.model, site.model.byName.get(SHOWCASE.drug));
  const tl = revealTimeline(f);
  assert.equal(tl.reduce((a, x) => a + x.delay, 0), REVEAL_DURATION_CS);
  assert.ok(tl.slice(0, -1).every((x) => x.delay === REVEAL_FRAME_CS));
  assert.ok(tl.at(-1).delay >= 100, 'it holds for at least a second');
  const q = revealQuery(SHOWCASE.drug);
  assert.equal(q, 'aripiprazole');
  const typed = [...new Set(tl.map((x) => x.state.typed))];
  assert.deepEqual(typed, ['', ...Array.from(q, (_, i) => q.slice(0, i + 1))]);
  // The beats, in the order the brief gives: card, pharmacy, rule, Medicare, spread, sources.
  const firstFull = (key) => tl.findIndex((x) => x.state[key] >= 1);
  const firstSpread = tl.findIndex((x) => x.state.spread !== null);
  const settled = tl.findIndex((x) => x.state.settled);
  const order = [tl.findIndex((x) => x.state.typed === q), firstFull('head'), firstFull('pharmacy'), firstFull('rule'), firstFull('medicare'), firstSpread, settled, firstFull('sources')];
  assert.deepEqual([...order].sort((a, b) => a - b), order, `beats in order: ${order}`);
  // The count-up: from 1.0× to core's spread, never down, and only the last value carries the chip.
  const values = tl.filter((x) => x.state.spread !== null).map((x) => x.state.spread);
  assert.equal(values[0], '1.0×');
  assert.equal(values.at(-1), want.spread);
  const nums = values.map((v) => Number(v.replace('×', '')));
  for (let i = 1; i < nums.length; i++) assert.ok(nums[i] >= nums[i - 1], `the count-up never goes down: ${values}`);
  assert.equal(tl.filter((x) => x.state.settled).at(0).state.spread, want.spread);
  assert.ok(tl.filter((x) => !x.state.settled).every((x) => x.state.sources === 0), 'the sources come after the spread settles');
});

test('the reveal frames: core’s figures, states, source lines and the honesty line; nothing shown early', () => {
  const f = revealFacts(site.model, site.model.byName.get(SHOWCASE.drug));
  const tl = revealTimeline(f);
  const css = '.x{}';
  for (const layout of Object.keys(REVEAL_LAYOUTS)) {
    const last = renderRevealHtml(site.model, f, { css, layout, state: tl.at(-1).state });
    assert.doesNotMatch(last, /<script|\son[a-z]+=/i);
    assert.ok(last.includes(`<body class="${layout}">`));
    assert.ok(last.includes(`data-reveal="pharmacy">${want.pharmacy}</span> <span class="chip chip-${s.pack.min.state}">`));
    assert.ok(last.includes(`data-reveal="medicare">${want.medicare}</span> <span class="chip chip-${s.reference.range.state}">`));
    assert.ok(last.includes(`data-reveal="spread">${want.spread}</span> <span><span class="chip chip-estimated">`), 'the settled spread shows its chip');
    assert.ok(last.includes(`data-reveal="typed">aripiprazole</span>`));
    assert.ok(last.includes('Medicare&#39;s price is not your price.'));
    assert.ok(last.includes(esc(s.spread.sentence)));
    assert.match(last, /<p class="prov">CMS NADAC · nadac-[^<]+ · eff\. /);
    assert.match(last, /<p class="prov">Medicare Part D · DSD_PTD_/);
    assert.ok(last.includes(`Data year ${want.year}, every strength and form together`));
    assert.ok(last.includes(esc(HONESTY.find((h) => h.id === 'range').text)));
    assert.doesNotMatch(last, /style="[^"]*opacity/, 'everything is fully shown at the end');
    const first = renderRevealHtml(site.model, f, { css, layout, state: tl[0].state });
    assert.equal((first.match(/style="opacity:0"/g) || []).length, 5, 'the card head, both figures, the spread and the source lines start hidden');
    assert.match(first, /<div class="rule" style="transform:scale[XY]\(0\)">/, 'the rule starts undrawn');
    assert.match(first, /<div class="sources" style="opacity:0">/);
  }
  assert.throws(() => renderRevealHtml(site.model, f, { css: '</style>', layout: 'wide', state: tl[0].state }), /CSS/);
  assert.throws(() => renderRevealHtml(site.model, f, { css, layout: 'square', state: tl[0].state }), /layout/);
  assert.deepEqual(
    Object.values(REVEAL_LAYOUTS).map((l) => [l.width, l.height]),
    [
      [1200, 675],
      [540, 960],
    ],
    '16:9 and 9:16',
  );
});

test('the wordmark markup: the stamp alone, no script', () => {
  for (const w of PRESS_WORDMARKS) {
    const page = renderWordmarkHtml({ css: '.x{}', ink: w.ink });
    assert.ok(page.includes(`<body class="wordmark ink-${w.ink}">`));
    assert.ok(page.includes('<span class="stamp-name">OpenBill</span><span class="stamp-sub">drug price receipt</span>'));
    assert.doesNotMatch(page, /<script/);
  }
  assert.throws(() => renderWordmarkHtml({ css: '.x{}', ink: 'red' }), /ink/);
});
