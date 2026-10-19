// The static site (tools/site.mjs, src/build/drugpage.js): a sample of about 40 real products,
// chosen from data/drugs.json to cover every case a page can be in, plus the showcase, is built
// into a temporary folder without preview images, and every page is checked against the core:
// its numbers, their states and source lines, its prose, its metadata, its JSON-LD and its links.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSite, readData, slugCollisions, missingAnchors, parseArgs, prepareOut, ROOT, MARKER } from '../tools/site.mjs';
import { SITE_CSP, SHOWCASE, METHODOLOGY_ANCHORS, SITEMAP_CLASS_MIN, TITLE_TARGET, TITLE_GENERIC_MAX, OG_IMAGE_TYPE, sitemapXml, letterOf, renderOgHtml, ogImagePath } from '../src/build/drugpage.js';
import { siteSlugs, slugify } from '../src/core/slug.js';
import { linkRows } from '../src/core/pack.js';
import { groupProducts } from '../src/core/search.js';
import { summarizeProduct, defaultQuantity, partDNameContext, formatSpreadMultiple, HONESTY, EXTREME_HEADLINE } from '../src/core/rules.js';
import { formatMoney, formatUnitPrice } from '../src/core/money.js';
import { siblings } from '../src/core/related.js';
import { esc } from '../src/core/esc.js';
import { SITE_URL } from '../src/core/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'drugs.v3.sample.json');

// ---------------------------------------------------------------- the sample

const { doc } = readData();
const rows = linkRows(doc);
const products = groupProducts(rows);
const context = partDNameContext(rows);
const summaries = new Map();
function sum(p) {
  if (!summaries.has(p.name)) summaries.set(p.name, summarizeProduct(p.rows, defaultQuantity(p).qty, { partDContext: context }));
  return summaries.get(p.name);
}

const miss = (x) => !x || x.missing === true;
const CASES = [
  ['Part D reference, ordinary spread', (p, s) => !miss(s.reference) && s.reference.kind === 'part_d' && !miss(s.spread) && !s.spread.extreme, 3],
  ['Part B, derived spread', (p, s) => !miss(s.spread) && s.spread.kind === 'part_b' && s.spread.state === 'derived'],
  ['Part B, estimated spread', (p, s) => !miss(s.spread) && s.spread.kind === 'part_b' && s.spread.state === 'estimated' && !s.spread.extreme],
  ['Part D with Part B too (alternate)', (p, s) => !miss(s.reference) && s.reference.alternate],
  ['no Medicare reference', (p, s) => miss(s.reference)],
  ['extreme high spread', (p, s) => !miss(s.spread) && s.spread.extreme && s.spread.range.max.value >= 20],
  ['extreme low spread', (p, s) => !miss(s.spread) && s.spread.extreme && s.spread.range.min.value <= 0.2],
  ['Part D name outlier', (p, s) => !miss(s.spread) && s.spread.name_outliers.length > 0, 1],
  ['every NDC carried forward', (p, s) => s.counts.carried_forward > 0 && s.counts.carried_forward === s.counts.rows],
  ['some NDCs carried forward', (p, s) => s.counts.carried_forward > 0 && s.counts.carried_forward < s.counts.rows],
  ['OTC', (p, s) => s.otc === true],
  ['OTC on some NDCs only', (p, s) => s.otc === null, 1],
  ['priced per EA, an oral solid by its NADAC name (no FDA listing)', (p, s) => s.unit === 'EA' && s.default_quantity.form.oral_solid && s.default_quantity.form.basis === 'name', 1],
  ['priced per EA, not an oral solid: starts at 1 of a named unit', (p, s) => s.unit === 'EA' && !s.default_quantity.form.oral_solid && s.default_quantity.form.one !== 'unit (EA)', 1],
  ['priced per EA, not an oral solid: starts at 1 unit (EA)', (p, s) => s.unit === 'EA' && !s.default_quantity.form.oral_solid && s.default_quantity.form.one === 'unit (EA)' && s.default_quantity.form.basis === 'fda', 1],
  ['priced per EA, the form undecided', (p, s) => s.unit === 'EA' && s.default_quantity.form.basis === 'none', 1],
  ['priced per ML, one package', (p, s) => s.unit === 'ML' && s.default_quantity.qty !== 1],
  ['priced per ML, starts at 1', (p, s) => s.unit === 'ML' && s.default_quantity.qty === 1],
  ['priced per GM', (p, s) => s.unit === 'GM'],
  ['NDCs priced in different units', (p, s) => s.unit === null],
  ['several NDCs at different prices', (p, s) => !s.nadac.same && s.nadac.units.length === 1],
  ['one NDC', (p, s) => s.counts.rows === 1, 1],
  ['brand with a generic sibling', (p, s) => s.rate_classes.includes('B') && siblings(p, products).some((q) => q.rows.some((r) => r.rate_class === 'G'))],
  ['generic NADAC on a brand row', (p, s) => s.generic_nadac !== null, 1],
  ['no FDA identity', (p, s) => s.counts.with_identity === 0],
  ['some NDCs without the Medicare figure', (p, s) => !miss(s.reference) && s.reference.without.length > 0, 1],
  ['name with characters to escape', (p) => /[&'"()%/]/.test(p.name), 1],
];

const sample = new Map(); // name → cases
function add(name, why) {
  if (!sample.has(name)) sample.set(name, []);
  sample.get(name).push(why);
}
const uncovered = [];
for (const [why, pred, n = 2] of CASES) {
  let k = 0;
  for (const p of products) {
    if (k >= n) break;
    // A product not picked yet, so the sample spreads across as many products as it can.
    if (!sample.has(p.name) && pred(p, sum(p))) {
      add(p.name, why);
      k += 1;
    }
  }
  if (k === 0) uncovered.push(why);
}
add(SHOWCASE.drug, 'showcase');
add('ELIQUIS 5 MG TABLET', 'the contract’s example row');
// Products the phase 2 review named, pinned so their fixes stay fixed.
const PINNED = {
  'MICONAZOLE 7 CREAM': 'shares a slug with MICONAZOLE-7 CREAM (decision 46)',
  'MICONAZOLE-7 CREAM': 'shares a slug with MICONAZOLE 7 CREAM (decision 46)',
  'AMBIEN CR 12.5 MG TABLET': 'H1: no immediate-release generic named',
  'GRALISE ER 600 MG TABLET': 'H1: only the extended-release generic named',
  'BASAGLAR 100 UNIT/ML KWIKPEN': 'H1: no other-concentration insulin named',
  'ABILIFY 10 MG TABLET': 'H1: the exact generic is named',
  'AMOXICILLIN 500 MG CAPSULE': 'H2: Part D has a row with its name',
  'AVONEX 30 MCG/0.5 ML SYRINGE KIT (4 PACK)': 'H8/SEO-4: a kit priced per EA',
  'BUPRENORPHINE 8 MG TABLET SL': 'decision 49: a sublingual tablet starts at 30, and the page says why',
  'TACLONEX 0.005%-0.064% SUSPENSION': 'decision 49: a shipping case starts at one inner unit',
  'ALL DAY RELIEF 220 MG CAPLET': 'SEO-7: the NADAC name lacks the generic name',
  'PNV-SELECT TABLET': 'SEO-7: a twenty-ingredient generic name stays out of the title',
};
for (const [n, why] of Object.entries(PINNED)) add(n, why);
const collisions = slugCollisions(products.map((p) => p.name));

let tmp;
let site;
const pages = new Map(); // name → { rel, html }

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openbill-site-'));
  site = await buildSite({
    out: path.join(tmp, 'site'),
    only: [...sample.keys()],
    og: false,
    // The committed methodology.html may lag a rule until `node build.js` runs; the anchors the pages
    // link to are checked against the rules methodology.html is generated from instead (below).
    checkAnchors: false,
    log: () => {},
  });
  for (const name of sample.keys()) {
    const rel = `drug/${site.model.slugs.get(name)}/index.html`;
    pages.set(name, { rel, html: fs.readFileSync(path.join(site.out, rel), 'utf8') });
  }
});

after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers

function unesc(s) {
  return String(s)
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

function meta(html, attr, key) {
  const re = new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`);
  const m = re.exec(html);
  return m ? unesc(m[1]) : null;
}

/** The text of the element carrying data-figure="key", or null. */
function figure(html, key) {
  const m = new RegExp(`<span class="[^"]*" data-figure="${key}">([^<]*)</span>`).exec(html);
  return m ? unesc(m[1]) : null;
}

/** The section of the card that holds a figure: from its <section> to the next </section>. */
function figureSection(html, key) {
  const at = html.indexOf(`data-figure="${key}"`);
  if (at < 0) return null;
  const start = html.lastIndexOf('<section', at);
  return html.slice(start, html.indexOf('</section>', at));
}

function chipAfter(section) {
  const m = /<span class="chip chip-([a-z]+)">/.exec(section);
  return m ? m[1] : null;
}

function rangeText(min, max, same, fmt) {
  const a = fmt(min.value);
  const b = fmt(max.value);
  return same || a === b ? a : `${a} – ${b}`;
}

function sectionText(html, id) {
  const at = html.indexOf(`id="${id}"`);
  assert.ok(at >= 0, `no section ${id}`);
  return textOf(html.slice(at, html.indexOf('</section>', at)).replace(/^[^>]*>/, ''));
}

function sentences(text) {
  return (String(text).match(/[.!?](?=\s|$)/g) || []).length;
}

function jsonLd(html) {
  const blocks = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  return blocks;
}

function hrefs(html) {
  return [...html.matchAll(/<(?:a|link)\s[^>]*href="([^"]*)"/g)].map((m) => unesc(m[1]));
}

const knownDrugSlugs = () => new Set(site.model.slugs.values());
const knownClassSlugs = () => new Set(site.model.classSlugs.values());

/** A link resolves to a file in the built site, or is a well-formed link to a page of the full site. */
function checkLink(fromRel, href) {
  if (href === 'data:,') return; // <link rel="icon" href="data:,">: no favicon request
  if (/^https:\/\//.test(href)) {
    assert.doesNotThrow(() => new URL(href), `${fromRel}: bad URL ${href}`);
    return;
  }
  assert.ok(!/^(javascript|data|http):/i.test(href), `${fromRel}: unsafe link ${href}`);
  const [pathPart, frag] = href.split('#');
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), pathPart));
  assert.ok(!target.startsWith('..'), `${fromRel}: ${href} leaves the site`);
  const file = target.endsWith('/') || target === '.' ? `${target === '.' ? '' : target}index.html` : target;
  if (frag !== undefined && file === 'methodology.html') assert.ok(METHODOLOGY_ANCHORS.includes(frag), `${fromRel}: methodology.html has no #${frag}`);
  if (frag !== undefined && file === 'index.html') assert.match(frag, /^drug=[^&]+&qty=\d+(\.\d+)?$/, `${fromRel}: app link ${href}`);
  if (fs.existsSync(path.join(site.out, file))) return;
  const m = /^(drug|class)\/([a-z0-9-]+)\/index\.html$/.exec(file);
  assert.ok(m, `${fromRel}: ${href} resolves to ${file}, which is not in the site`);
  assert.ok((m[1] === 'drug' ? knownDrugSlugs() : knownClassSlugs()).has(m[2]), `${fromRel}: ${href} names no known ${m[1]}`);
}

// ---------------------------------------------------------------- tests

test('the sample covers every case', () => {
  assert.deepEqual(uncovered, [], `no product in data/drugs.json for: ${uncovered.join(', ')}`);
  assert.ok(sample.size >= 35 && sample.size <= 60, `sample has ${sample.size} products`);
  assert.equal(site.pages.drug, sample.size);
});

test('every drug page: CSP meta, no script but one JSON-LD block, no inline style or handlers', () => {
  for (const [name, { rel, html }] of pages) {
    assert.ok(html.startsWith('<!doctype html>\n<html lang="en">'), rel);
    assert.equal(meta(html, 'http-equiv', 'Content-Security-Policy'), SITE_CSP, `${rel}: CSP`);
    const scripts = jsonLd(html);
    assert.equal(scripts.length, 1, `${rel}: one <script>`);
    assert.equal(scripts[0][1], ' type="application/ld+json"', `${rel}: the only script is JSON-LD data`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${rel}: event handler attribute`);
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${rel}: style attribute`);
    assert.doesNotMatch(html, /<style|javascript:/i, `${rel}: inline style or javascript: URL`);
    assert.match(html, /<link rel="stylesheet" href="\.\.\/\.\.\/assets\/site\.css">/, rel);
    assert.ok(html.includes(`<h1 class="page-title">${esc(name)}</h1>`), `${rel}: the name, escaped`);
  }
});

test('every drug page: unique title and description from its own numbers, canonical, og and twitter tags', () => {
  const titles = new Set();
  const descriptions = new Set();
  for (const [name, { rel, html }] of pages) {
    const title = unesc(/<title>([^<]*)<\/title>/.exec(html)[1]);
    const description = meta(html, 'name', 'description');
    assert.ok(title.includes(name), `${rel}: title names the product`);
    assert.ok(description.includes(name), `${rel}: description names the product`);
    assert.ok(!titles.has(title), `${rel}: duplicate title`);
    assert.ok(!descriptions.has(description), `${rel}: duplicate description`);
    titles.add(title);
    descriptions.add(description);
    const s = sum(site.model.byName.get(name));
    const f = site.model.facts.get(name);
    const ph = miss(s.pack) ? null : rangeText(s.pack.min, s.pack.max, s.pack.same, formatMoney);
    // SEO-4, decision 48: the card's own pack total, for the quantity the card starts at, which is
    // a plain supply now (30 oral tablets or capsules; 1 of anything else per EA; one package per ML or GM).
    if (ph) {
      assert.ok(title.includes(`${ph} for ${f.qtyText}`) && description.includes(`${ph} for ${f.qtyText}`), `${rel}: title and description carry the pack total ${ph} for ${f.qtyText}`);
      assert.ok(meta(html, 'property', 'og:image:alt').includes(`${ph} for ${f.qtyText}`), `${rel}: alt text carries the pack total`);
      if (!miss(s.cost_plus)) assert.ok(description.includes(`Cost-plus estimate ${rangeText(s.cost_plus.min, s.cost_plus.max, s.cost_plus.same, formatMoney)}.`), `${rel}: the description carries the cost-plus estimate`);
    }
    if (s.unit === 'EA') {
      assert.equal(f.qty, s.default_quantity.form.oral_solid ? 30 : 1, `${rel}: starting quantity`);
      assert.ok(!/for 30 (kits|units \(EA\)|patches|syringes|pens|vials)/.test(title + description), `${rel}: never 30 of something that is not an oral solid`);
    }
    // SEO-6: the site name only when the title still fits.
    if (title.endsWith(' | OpenBill')) assert.ok(title.length <= TITLE_TARGET, `${rel}: ${title.length} characters`);
    // H4: a summary that shows the Medicare figure says what it is and that it is not your price.
    if (!miss(s.reference)) {
      assert.ok(description.includes("Medicare's price is not your price."), `${rel}: description says not your price`);
      assert.ok(meta(html, 'property', 'og:image:alt').includes("Medicare's price is not your price."), `${rel}: alt text says not your price`);
      if (s.reference.kind === 'part_d') assert.match(description, /Medicare Part D (\d{4} )?average, all strengths and forms: /, `${rel}: Part D is an average`);
    }
    const slug = site.model.slugs.get(name);
    const canonical = `${SITE_URL}drug/${slug}/`;
    assert.ok(html.includes(`<link rel="canonical" href="${canonical}">`), `${rel}: canonical`);
    assert.equal(meta(html, 'property', 'og:url'), canonical);
    assert.equal(meta(html, 'property', 'og:image'), `${SITE_URL}og/${slug}.png`);
    assert.equal(meta(html, 'property', 'og:image:type'), 'image/png');
    assert.equal(meta(html, 'name', 'twitter:image'), `${SITE_URL}og/${slug}.png`);
    assert.equal(ogImagePath(slug), `og/${slug}.png`);
    assert.equal(meta(html, 'name', 'twitter:card'), 'summary_large_image');
    assert.equal(meta(html, 'property', 'og:title'), title);
    assert.ok(meta(html, 'property', 'og:image:alt'), `${rel}: og:image:alt`);
  }
});

test('every figure: the number core computes, its state chip, and a source line (or the reason it is unknown)', () => {
  for (const [name, { rel, html }] of pages) {
    const s = sum(site.model.byName.get(name));
    // What pharmacies pay
    const ph = figureSection(html, 'pharmacy');
    if (miss(s.pack)) assert.ok(figure(html, 'pharmacy').startsWith(formatUnitPrice(s.nadac_by_unit[0].range.min.value)), `${rel}: per-unit price`);
    else assert.equal(figure(html, 'pharmacy'), rangeText(s.pack.min, s.pack.max, s.pack.same, formatMoney), `${rel}: pharmacy`);
    assert.equal(chipAfter(ph), miss(s.pack) || s.pack.min.state !== s.pack.max.state ? s.nadac.state : s.pack.min.state, `${rel}: pharmacy chip`);
    assert.match(html, /data-prov="pharmacy">CMS NADAC · nadac-[^<]+\.csv · eff\. \d{4}-\d{2}-\d{2}/, `${rel}: pharmacy source line`);
    // Medicare
    const md = figureSection(html, 'medicare');
    if (miss(s.reference)) {
      assert.equal(figure(html, 'medicare'), 'We don’t know yet', `${rel}: medicare unknown`);
      assert.match(md, /<p class="why">[^<]{20,}<\/p>/, `${rel}: why Medicare is unknown`);
    } else {
      const refPack = miss(s.reference.pack) ? null : s.reference.pack;
      if (refPack) assert.equal(figure(html, 'medicare'), rangeText(refPack.min, refPack.max, refPack.same, formatMoney), `${rel}: medicare`);
      else assert.ok(figure(html, 'medicare').startsWith(formatUnitPrice(s.reference.range.min.value)), `${rel}: medicare per unit`);
      assert.equal(chipAfter(md), s.reference.range.state, `${rel}: medicare chip`);
      assert.match(md, /data-prov="medicare">(Medicare Part D|Medicare Part B|OpenBill calculation) · /, `${rel}: medicare source line`);
      assert.ok(md.includes('<strong>Medicare&#39;s price is not your price.</strong>'), `${rel}: not your price, next to the figure`);
    }
    // The spread
    const sp = figureSection(html, 'spread');
    if (miss(s.spread)) {
      assert.equal(figure(html, 'spread'), 'We don’t know yet');
      assert.match(sp, /<p class="why">[^<]{20,}<\/p>/, `${rel}: why the spread is unknown`);
    } else {
      const want = rangeText(s.spread.range.min, s.spread.range.max, false, formatSpreadMultiple);
      assert.equal(figure(html, 'spread'), want, `${rel}: spread`);
      assert.equal(chipAfter(sp), s.spread.state, `${rel}: spread chip`);
      assert.match(sp, /data-prov="spread">OpenBill calculation · /, `${rel}: spread source line`);
      if (s.spread.extreme) {
        assert.ok(sp.includes(`<p class="spread-sentence spread-headline">${esc(EXTREME_HEADLINE)}</p>`), `${rel}: extreme headline`);
        assert.match(sp, /<p class="caveat caveat-extreme">At [^<]+may not describe the same unit or product/, `${rel}: extreme caveat`);
        assert.doesNotMatch(sp, /Medicare (paid|pays) \d+% less/, `${rel}: no plain sentence for an extreme spread`);
      } else {
        assert.ok(sp.includes(esc(s.spread.sentence)), `${rel}: spread sentence`);
      }
      if (s.spread.state === 'estimated') assert.match(sp, /<p class="caveat">/, `${rel}: an estimated spread shows its caveat`);
    }
    // The cost-plus estimate
    const cp = figureSection(html, 'cost-plus');
    if (miss(s.cost_plus)) assert.equal(figure(html, 'cost-plus'), 'We don’t know yet');
    else {
      assert.equal(figure(html, 'cost-plus'), rangeText(s.cost_plus.min, s.cost_plus.max, s.cost_plus.same, formatMoney), `${rel}: cost-plus`);
      assert.equal(chipAfter(cp), 'estimated', `${rel}: cost-plus is estimated`);
      assert.match(cp, /data-prov="cost-plus">OpenBill calculation · nadac-/, `${rel}: cost-plus source line`);
      assert.ok(cp.includes('This is a model, not a price any pharmacy quoted.'), `${rel}: cost-plus caveat`);
    }
    // Every figure that shows a number has a source line; every unknown one says why.
    for (const key of ['pharmacy', 'medicare', 'spread', 'cost-plus']) {
      const section = figureSection(html, key);
      if (figure(html, key) === 'We don’t know yet') assert.match(section, /<p class="why">/, `${rel}: ${key} reason`);
      else assert.ok(section.includes(`data-prov="${key}"`), `${rel}: ${key} source line`);
    }
  }
});

test('every drug page: prose generated from its data, several sentences per section, the honesty lines verbatim', () => {
  const openings = new Set();
  for (const [name, { rel, html }] of pages) {
    const s = sum(site.model.byName.get(name));
    const what = sectionText(html, 'h-what');
    const pharmacy = sectionText(html, 'h-pharmacy');
    const medicare = sectionText(html, 'h-medicare');
    const costPlus = sectionText(html, 'h-costplus');
    const ask = sectionText(html, 'h-ask');
    assert.ok(sentences(what) >= 3, `${rel}: what it is (${what})`);
    assert.ok(sentences(pharmacy) >= 4, `${rel}: what pharmacies pay`);
    assert.ok(sentences(medicare) >= 2, `${rel}: what Medicare paid`);
    assert.ok(sentences(costPlus) >= 2, `${rel}: cost-plus`);
    assert.ok(sentences(ask) >= 2, `${rel}: what to ask`);
    assert.ok(sentences(what + pharmacy + medicare + costPlus + ask) >= 15, `${rel}: prose`);
    assert.ok(what.includes(name), `${rel}: what it is names the product`);
    assert.ok(ask.includes('not medical advice'), `${rel}: the counter questions say they are not medical advice`);
    if (s.counts.carried_forward) assert.match(pharmacy, /carried forward from an earlier file/, `${rel}: carried-forward note`);
    if (!miss(s.pack)) assert.ok(pharmacy.includes(rangeText(s.pack.min, s.pack.max, s.pack.same, formatMoney)), `${rel}: the pack total in prose`);
    if (miss(s.reference)) assert.match(medicare, /We don’t know yet/, `${rel}: unknown Medicare in prose`);
    else if (s.spread.state === 'estimated') assert.ok(medicare.includes('OpenBill labels this comparison estimated because:'), `${rel}: the record's own caveats`);
    for (const h of HONESTY) assert.ok(textOf(html).includes(h.text), `${rel}: honesty line ${h.id}`);
    assert.doesNotMatch(textOf(html), /typical cash price/i, `${rel}: never "typical cash price"`);
    openings.add(`${what.slice(0, 200)}|${pharmacy.slice(0, 120)}`);
  }
  assert.equal(openings.size, pages.size, 'no two pages open with the same words');
});

test('every drug page: JSON-LD parses; BreadcrumbList, Drug with DrugCost, FAQPage; its numbers equal the page’s', () => {
  for (const [name, { rel, html }] of pages) {
    const ld = JSON.parse(jsonLd(html)[0][2]);
    assert.equal(ld['@context'], 'https://schema.org');
    const types = ld['@graph'].map((x) => x['@type']);
    assert.deepEqual(types, ['BreadcrumbList', 'Drug', 'FAQPage'], rel);
    const [crumbs, drug, faq] = ld['@graph'];
    const slug = site.model.slugs.get(name);
    assert.equal(crumbs.itemListElement.at(-1).item, `${SITE_URL}drug/${slug}/`);
    assert.equal(crumbs.itemListElement[1].item, `${SITE_URL}drugs/${letterOf(name)}/`);
    assert.equal(drug.name, name);
    const text = textOf(html.slice(html.indexOf('<body>')));
    const s = sum(site.model.byName.get(name));
    assert.ok(Array.isArray(drug.cost) && drug.cost.length >= 1, `${rel}: DrugCost entries`);
    for (const c of drug.cost) {
      assert.equal(c['@type'], 'DrugCost');
      assert.equal(c.costCurrency, 'USD');
      assert.ok(typeof c.costOrigin === 'string' && c.costOrigin.length > 20, `${rel}: costOrigin`);
      assert.ok(!/Offer|PriceSpecification/.test(JSON.stringify(c)), `${rel}: not an offer`);
      const n = c.costPerUnit;
      assert.ok(typeof n === 'number' || n === '<$0.01', `${rel}: costPerUnit ${n}`);
      if (typeof n === 'number') assert.ok(text.includes(formatUnitPrice(n)) || text.includes(formatMoney(n)), `${rel}: JSON-LD ${n} is on the page`);
    }
    const nadacMin = Number(formatUnitPrice(s.nadac_by_unit[0].range.min.value).slice(1).replace(/,/g, ''));
    assert.ok(drug.cost.some((c) => c.costPerUnit === nadacMin && /CMS NADAC/.test(c.costOrigin) && c.costOrigin.includes(s.nadac.min.source_file)), `${rel}: NADAC cost names its file`);
    if (!miss(s.pack)) assert.ok(drug.cost.some((c) => formatMoney(c.costPerUnit) === formatMoney(s.pack.min.value)), `${rel}: pack total in JSON-LD`);
    if (!miss(s.reference)) {
      const refMin = Number(formatUnitPrice(s.reference.range.min.value).slice(1).replace(/,/g, ''));
      const c = drug.cost.find((x) => x.costPerUnit === refMin && /Medicare/.test(x.costOrigin));
      assert.ok(c, `${rel}: Medicare cost`);
      if (s.reference.range.min.period) assert.ok(c.costOrigin.includes(s.reference.range.min.period.replace('/', ' to ')), `${rel}: Medicare cost carries its period`);
    } else assert.ok(!drug.cost.some((c) => /Medicare/.test(c.costOrigin)), `${rel}: no Medicare cost when unknown`);
    assert.ok(faq.mainEntity.length >= 3, `${rel}: FAQ`);
    const dds = [...html.matchAll(/<dt>([^<]*)<\/dt><dd>([^<]*)<\/dd>/g)].map((m) => [unesc(m[1]), unesc(m[2])]);
    assert.deepEqual(
      faq.mainEntity.map((q) => [q.name, q.acceptedAnswer.text]),
      dds,
      `${rel}: the FAQ answers are the page's own visible text`,
    );
  }
});

test('every link on every page resolves in the built site or is a well-formed link to a page of the full site', () => {
  const all = [];
  for (const { rel, html } of pages.values()) all.push([rel, html]);
  for (const dir of ['class', 'drugs']) {
    for (const ent of fs.readdirSync(path.join(site.out, dir))) all.push([`${dir}/${ent}/index.html`, fs.readFileSync(path.join(site.out, dir, ent, 'index.html'), 'utf8')]);
  }
  let n = 0;
  for (const [rel, html] of all) {
    for (const href of hrefs(html)) {
      checkLink(rel, href);
      n += 1;
    }
  }
  assert.ok(n > 1000, `checked ${n} links`);
  // The app links carry the product and its starting quantity.
  const show = pages.get(SHOWCASE.drug).html;
  assert.ok(show.includes(`href="../../#drug=${esc(encodeURIComponent(SHOWCASE.drug))}&amp;qty=${SHOWCASE.qty}"`), 'the showcase links to its app card');
});

test('class and A–Z pages: complete, counted, with CSP and canonical', () => {
  assert.equal(site.pages.class, site.model.classes.size);
  assert.equal(site.pages.letter, site.model.letters.size);
  let listed = 0;
  for (const [key, list] of site.model.classes) {
    const rel = `class/${site.model.classSlugs.get(key)}/index.html`;
    const html = fs.readFileSync(path.join(site.out, rel), 'utf8');
    assert.equal(meta(html, 'http-equiv', 'Content-Security-Policy'), SITE_CSP, rel);
    assert.ok(html.includes(`<link rel="canonical" href="${SITE_URL}class/${site.model.classSlugs.get(key)}/">`), rel);
    assert.equal((html.match(/<li><a href="\.\.\/\.\.\/drug\//g) || []).length, list.length, `${rel}: lists every product`);
    assert.match(html, /data-prov="list">Prices per unit: CMS NADAC · /, `${rel}: source line for the prices`);
    JSON.parse(jsonLd(html)[0][2]);
  }
  for (const [letter, list] of site.model.letters) {
    const html = fs.readFileSync(path.join(site.out, 'drugs', letter, 'index.html'), 'utf8');
    assert.equal((html.match(/<li><a href="\.\.\/\.\.\/drug\//g) || []).length, list.length, `drugs/${letter}`);
    listed += list.length;
  }
  assert.equal(listed, site.model.products.length, 'the A–Z pages list every product once');
});

test('the rest of the site: app pages, data, assets, sitemap', () => {
  const app = fs.readFileSync(path.join(ROOT, 'openbill.html'));
  assert.ok(fs.readFileSync(path.join(site.out, 'index.html')).equals(app), 'index.html is openbill.html');
  assert.ok(fs.readFileSync(path.join(site.out, 'openbill.html')).equals(app));
  assert.equal(fs.statSync(path.join(site.out, 'data', 'drugs.json')).size, fs.statSync(path.join(ROOT, 'data', 'drugs.json')).size);
  const css = fs.readFileSync(path.join(site.out, 'assets', 'site.css'), 'utf8');
  for (const m of css.matchAll(/url\(([^)]+)\)/g)) assert.ok(fs.existsSync(path.join(site.out, 'assets', m[1])), `site.css font ${m[1]}`);
  assert.ok(fs.existsSync(path.join(site.out, 'assets', 'fonts', 'OFL.txt')), 'the font licence travels with the fonts');
  const xml = fs.readFileSync(path.join(site.out, 'sitemap.xml'), 'utf8');
  const locs = [...xml.matchAll(/<url><loc>([^<]+)<\/loc><lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod><\/url>/g)];
  // SEO-9: class pages of fewer than SITEMAP_CLASS_MIN products are published but not listed.
  const listedClasses = [...site.model.classes.values()].filter((l) => l.length >= SITEMAP_CLASS_MIN).length;
  assert.equal(site.pages.class - site.pages.classUnlisted, listedClasses);
  assert.ok(site.pages.classUnlisted > 0, 'some classes are too small to list');
  // The home page, methodology.html and the press kit (decision 51), then the data pages.
  assert.equal(locs.length, 3 + site.pages.drug + listedClasses + site.pages.letter);
  for (const [key, list] of site.model.classes) {
    const loc = `<loc>${SITE_URL}class/${site.model.classSlugs.get(key)}/</loc>`;
    assert.equal(xml.includes(loc), list.length >= SITEMAP_CLASS_MIN, loc);
  }
  // 404.html: absolute links (it is served at any missing path), noindex, the site CSP, not listed.
  const nf = fs.readFileSync(path.join(site.out, '404.html'), 'utf8');
  assert.equal(meta(nf, 'http-equiv', 'Content-Security-Policy'), SITE_CSP);
  assert.equal(meta(nf, 'name', 'robots'), 'noindex');
  for (const href of hrefs(nf)) assert.ok(href === 'data:,' || href.startsWith(SITE_URL), `404.html: ${href} is absolute`);
  assert.ok(nf.includes(`href="${SITE_URL}drugs/a/"`), '404.html links the A–Z index');
  assert.ok(!xml.includes('404.html'));
  // SEC-4: the marker that lets a later build empty this folder.
  assert.ok(fs.existsSync(path.join(site.out, MARKER)));
  for (const { rel } of pages.values()) assert.ok(xml.includes(`<loc>${SITE_URL}${rel.replace(/index\.html$/, '')}</loc>`), `sitemap lists ${rel}`);
  assert.ok(xml.includes(`<loc>${SITE_URL}</loc>`) && xml.includes(`<loc>${SITE_URL}methodology.html</loc>`));
  assert.ok(!fs.existsSync(path.join(site.out, 'og')), '--no-og writes no images');
});

test('the build is deterministic: the same inputs give the same bytes', async () => {
  const again = await buildSite({ out: path.join(tmp, 'again'), only: [SHOWCASE.drug, 'ELIQUIS 5 MG TABLET'], og: false, checkAnchors: false, log: () => {} });
  for (const rel of [pages.get(SHOWCASE.drug).rel, pages.get('ELIQUIS 5 MG TABLET').rel, 'drugs/a/index.html']) {
    assert.equal(fs.readFileSync(path.join(again.out, rel), 'utf8'), fs.readFileSync(path.join(site.out, rel), 'utf8'), rel);
  }
});

test('names that share a slug each get their own suffixed page (decision 46); an LFS pointer, a stale methodology.html, or an unsafe --out stop the build', async () => {
  // Regression (SEO-1, SEC-1): the real data's two pairs used to stop the deploy.
  assert.deepEqual(
    collisions.map(([slug]) => slug),
    ['miconazole-7-cream', 'tioconazole-1-6-5-ointment'],
    'the real pairs, so a new one is noticed',
  );
  const a = site.model.slugs.get('MICONAZOLE 7 CREAM');
  const b = site.model.slugs.get('MICONAZOLE-7 CREAM');
  assert.notEqual(a, b);
  for (const [name, slug] of [['MICONAZOLE 7 CREAM', a], ['MICONAZOLE-7 CREAM', b]]) {
    assert.match(slug, /^miconazole-7-cream-[0-9a-f]{8}$/);
    assert.equal(slug, siteSlugs([name, 'MICONAZOLE-7 CREAM', 'MICONAZOLE 7 CREAM']).get(name), 'the suffix depends on the name alone');
    const html = fs.readFileSync(path.join(site.out, 'drug', slug, 'index.html'), 'utf8');
    assert.ok(html.includes(`<h1 class="page-title">${esc(name)}</h1>`), `${slug} is ${name}'s page`);
    assert.ok(html.includes(`<link rel="canonical" href="${SITE_URL}drug/${slug}/">`));
  }
  assert.ok(!fs.existsSync(path.join(site.out, 'drug', 'miconazole-7-cream')), 'neither keeps the plain slug');
  // Every product has a slug, all different; unshared names keep their plain slug.
  const all = siteSlugs(products.map((p) => p.name));
  assert.equal(new Set(all.values()).size, products.length);
  assert.equal(all.get(SHOWCASE.drug), slugify(SHOWCASE.drug));
  assert.equal(slugCollisions(['A-B C', 'A B C', 'D']).length, 1);

  const pointer = path.join(tmp, 'pointer.json');
  fs.writeFileSync(pointer, 'version https://git-lfs.github.com/spec/v1\noid sha256:0\nsize 1\n');
  assert.throws(() => readData(pointer), /Git LFS pointer/);

  assert.deepEqual(missingAnchors('<section id="cost-plus">'), []);
  assert.deepEqual(missingAnchors('<section id="spread">'), ['cost-plus']);
  assert.ok(METHODOLOGY_ANCHORS.includes('cost-plus'), 'the rule the pages link to is one methodology.html is generated from');

  assert.throws(() => prepareOut(ROOT), /repository/);
  assert.throws(() => prepareOut(path.join(ROOT, 'src')), /inside the repository/);
  const busy = path.join(tmp, 'busy');
  fs.mkdirSync(busy);
  fs.writeFileSync(path.join(busy, 'notes.txt'), 'mine');
  assert.throws(() => prepareOut(busy), /not empty/);
  // SEC-4: a folder that merely has index.html and sitemap.xml (any static-site project) is not
  // emptied; nor is one with .git, even if it has the marker.
  const victim = path.join(tmp, 'victim-project');
  fs.mkdirSync(path.join(victim, '.git'), { recursive: true });
  for (const f of ['index.html', 'sitemap.xml', 'precious-notes.txt']) fs.writeFileSync(path.join(victim, f), 'x');
  assert.throws(() => prepareOut(victim), /\.git/);
  fs.rmSync(path.join(victim, '.git'), { recursive: true });
  assert.throws(() => prepareOut(victim), /no \.openbill-site marker/);
  assert.ok(fs.existsSync(path.join(victim, 'precious-notes.txt')));
  fs.mkdirSync(path.join(victim, '.git'));
  fs.writeFileSync(path.join(victim, MARKER), fs.readFileSync(path.join(site.out, MARKER)));
  assert.throws(() => prepareOut(victim), /\.git/);
  assert.ok(fs.existsSync(path.join(victim, 'precious-notes.txt')));
  // A site this tool wrote is emptied and rebuilt.
  const ours = path.join(tmp, 'ours');
  prepareOut(ours);
  fs.writeFileSync(path.join(ours, 'old.html'), 'x');
  prepareOut(ours);
  assert.deepEqual(fs.readdirSync(ours), [MARKER]);
});

test('phase 2 review regressions: honest counter questions, Part D wording, quantities, dates, framing', () => {
  const page = (name) => pages.get(name).html;
  const ask = (name) => sectionText(page(name), 'h-ask');
  // H1: a generic is named only when FDA lists the same forms, routes and strengths and the names agree.
  assert.doesNotMatch(ask('AMBIEN CR 12.5 MG TABLET'), /ZOLPIDEM TARTRATE 10 MG TABLET|such as/);
  assert.match(ask('GRALISE ER 600 MG TABLET'), /same ingredient, strength and dosage form by FDA: GABAPENTIN ER 600 MG TABLET\./);
  assert.doesNotMatch(ask('GRALISE ER 600 MG TABLET'), /GABAPENTIN 600 MG TABLET/);
  assert.doesNotMatch(ask('BASAGLAR 100 UNIT/ML KWIKPEN'), /Is a generic version available/);
  assert.match(ask('ABILIFY 10 MG TABLET'), /by FDA: ARIPIPRAZOLE 10 MG TABLET\./);
  // H2: never "no Part D row matched" (amoxicillin's Part D row exists; it was refused for mixed units).
  for (const [name, { rel, html }] of pages) assert.doesNotMatch(html, /No Medicare Part D spending row matched/, rel);
  assert.ok(textOf(page('AMOXICILLIN 500 MG CAPSULE')).includes('OpenBill did not match this NDC to a usable Medicare Part D spending row.'));
  for (const [name, { rel, html }] of pages) {
    const text = textOf(html);
    // H9: a static page names its NADAC file's date, never "this week's".
    assert.doesNotMatch(text, /this week’s NADAC/i, rel);
    // H3: the brief's sentence "Say so on every screen that shows it." appears only in the framed list of rules.
    const said = text.split('Say so on every screen that shows it.').length - 1;
    assert.equal(said, 1, `${rel}: the instruction sentence once, in the rules list`);
    assert.ok(text.includes('holds every page to these five rules, written by the project’s owner and quoted word for word:'), `${rel}: the rules are introduced`);
    const f = site.model.facts.get(name);
    // H8: "once-a-day medicine" only for oral tablets and capsules.
    if (/one-month supply of a once-a-day medicine/.test(sectionText(html, 'h-pharmacy'))) assert.ok(f.oralSolid, `${rel}: once-a-day for a non-oral-solid`);
    // SEO-10, SEO-12
    assert.match(html, /<a href="https:\/\/github\.com\/[^"]+issues\/new[^"]*" rel="nofollow noopener">Wrong\? Tell us<\/a>/, rel);
    assert.ok(html.includes('<a href="../../data/drugs.json" rel="nofollow">'), rel);
    assert.ok(html.includes('<p class="more-link"><a href="../../methodology.html#cost-plus">'), rel);
  }
  // H8 / SEO-4, decision 48: a kit starts at 1, and its title, card and preview say so; its page
  // names FDA's form and does not say what one EA of a kit is.
  const avonexName = 'AVONEX 30 MCG/0.5 ML SYRINGE KIT (4 PACK)';
  const avonex = pages.get(avonexName);
  const avonexS = sum(site.model.byName.get(avonexName));
  const avonexPack = formatMoney(avonexS.pack.min.value);
  assert.equal(avonexS.pack.qty, 1);
  assert.equal(avonexPack, formatMoney(Math.round(avonexS.nadac.min.value * 100) / 100), 'the 1-unit total is the unit price to the cent');
  const avonexTitle = unesc(/<title>([^<]*)<\/title>/.exec(avonex.html)[1]);
  assert.ok(avonexTitle.startsWith(avonexName) && avonexTitle.includes(`: pharmacies pay ${avonexPack} for 1 unit (EA)`), `the title quotes the 1-unit total: ${avonexTitle}`);
  assert.ok(avonex.html.includes('<p class="card-kicker">For 1 unit (EA)</p>'));
  assert.doesNotMatch(avonex.html, /for 30 |30 units/);
  assert.match(sectionText(avonex.html, 'h-pharmacy'), /lists its NDC as dosage form “KIT” with route “INTRAMUSCULAR”\..+NADAC’s EA for it may be the whole kit or one item in it, and the files do not say which\. So the card starts at 1 unit \(EA\)/);
  assert.doesNotMatch(sectionText(avonex.html, 'h-pharmacy'), /once-a-day/);
  const og = renderOgHtml(site.model, site.model.byName.get(avonexName), { css: '.og{}' });
  assert.ok(og.includes('<p class="qty">For 1 unit (EA)</p>'), 'the preview card shows the 1-unit pack');
  // Decision 48: JPEG made these flat-colour cards 14.4% larger, so they are PNG again.
  assert.equal(OG_IMAGE_TYPE, 'image/png');
  assert.equal(ogImagePath('site'), 'og/site.png');
  // SEO-7: the generic name the NADAC name lacks is in the title and under the heading.
  const allDay = pages.get('ALL DAY RELIEF 220 MG CAPLET').html;
  assert.match(allDay, /<title>ALL DAY RELIEF 220 MG CAPLET \(naproxen sodium\): /);
  assert.ok(allDay.includes('<p class="page-generic">FDA nonproprietary name: naproxen sodium</p>'));
  const pnv = pages.get('PNV-SELECT TABLET').html;
  assert.match(pnv, /<title>PNV-SELECT TABLET: pharmacies pay /, 'a long multi-ingredient generic name is not in the title');
  assert.match(pnv, /<p class="page-generic">FDA nonproprietary name: [^<]*cupric oxide<\/p>/, 'but it is under the heading');
  for (const [name, { html }] of pages) {
    const t = unesc(/<title>([^<]*)<\/title>/.exec(html)[1]);
    const g = site.model.facts.get(name).genericName;
    if (g && t.startsWith(`${name} (`)) assert.ok(g.length <= TITLE_GENERIC_MAX && !g.includes(','), t);
  }
  // H4: the Part D DrugCost says it is a name-level average, not this NDC's price.
  const ld = JSON.parse(jsonLd(page(SHOWCASE.drug))[0][2]);
  const pd = ld['@graph'][1].cost.filter((c) => /Medicare Part D/.test(c.costOrigin));
  assert.ok(pd.length >= 1);
  for (const c of pd) assert.match(c.costOrigin, /across every strength and form sold under “Aripiprazole”, not specific to these NDCs; Medicare’s price is not your price/);
});

test('decision 49: a sublingual tablet starts at 30 and its page gives the reason; a shipping case starts at one inner unit', () => {
  const bup = pages.get('BUPRENORPHINE 8 MG TABLET SL').html;
  assert.match(unesc(/<title>([^<]*)<\/title>/.exec(bup)[1]), /: pharmacies pay \$[0-9.,]+ for 30 tablets/);
  const why = sectionText(bup, 'h-pharmacy');
  assert.match(why, /as a tablet taken under the tongue \(dosage form “TABLET”, route “SUBLINGUAL”\)/);
  assert.match(why, /OpenBill counts a tablet or film taken under the tongue or against the cheek as an oral solid/);
  const tac = pages.get('TACLONEX 0.005%-0.064% SUSPENSION').html;
  assert.match(unesc(/<title>([^<]*)<\/title>/.exec(tac)[1]), /: pharmacies pay \$1,241\.81 for 60 g/);
  assert.match(sectionText(tac, 'h-pharmacy'), /is a shipping case of 40 cartons, 2,400 g in all: a wholesale pack of identical units, so OpenBill counts one carton of it\. So the card starts at one carton: 60 GM\./);
});

test('every sampled page: its preview card opens with the same quantity line as the page’s card', () => {
  // The verifier's sweep found "Per unit: no single pack total" on the page and "Per unit; no
  // single pack total" on the preview card of the 12 products priced in different units.
  let perUnit = 0;
  for (const [name, { html }] of pages) {
    const kicker = /<p class="card-kicker">([^<]*)<\/p>/.exec(html)[1];
    const og = renderOgHtml(site.model, site.model.byName.get(name), { css: '.og{}' });
    assert.equal(/<p class="qty">([^<]*)<\/p>/.exec(og)[1], kicker, name);
    if (kicker === 'Per unit: no single pack total') perUnit += 1;
  }
  assert.ok(perUnit >= 1, 'the sample has a product priced in different units');
});

test('the preview cards render with no script able to run and no request allowed (SEC-6)', () => {
  const html = renderOgHtml(site.model, site.model.byName.get(SHOWCASE.drug), { css: '.og{}' });
  assert.doesNotMatch(html, /<script|\son[a-z]+=/i);
  // JavaScript is off in the rendering context, every request is aborted, and a dialog stops the
  // build. (No CSP meta in the card markup: on one reused page it made each card slower than the
  // last, 6 s to 15 s per 100 cards within 500, measured on 2026-10-18.)
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'site.mjs'), 'utf8');
  assert.match(src, /javaScriptEnabled: false/);
  assert.match(src, /page\.on\('dialog'/);
});

test('sitemapXml and the command line', () => {
  assert.equal(
    sitemapXml([
      { path: 'drug/b/', lastmod: '2026-10-18' },
      { path: '', lastmod: '2026-10-17' },
    ]),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${SITE_URL}</loc><lastmod>2026-10-17</lastmod></url>\n<url><loc>${SITE_URL}drug/b/</loc><lastmod>2026-10-18</lastmod></url>\n</urlset>\n`,
  );
  assert.throws(() => sitemapXml([{ path: 'x/', lastmod: 'today' }]), /lastmod/);
  assert.deepEqual(parseArgs(['--out', 'x', '--limit', '3', '--no-og', '--only', 'A']), { out: 'x', limit: 3, og: false, only: ['A'] });
  assert.throws(() => parseArgs(['--limit', '3']), /usage/);
  assert.throws(() => parseArgs(['--out', 'x', '--bogus']), /unknown option/);
});
