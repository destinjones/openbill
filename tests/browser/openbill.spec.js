// Browser checks for openbill.html and methodology.html, loaded from file:// URLs.
// Every expected figure is computed here from data/drugs.json with the core modules, never
// hard-coded, so a data refresh does not need these tests rewritten.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { linkRows, packDrugs, unpackDrugs } from '../../src/core/pack.js';
import { groupProducts, buildIndex, search, enterChoice } from '../../src/core/search.js';
import { summarizeProduct, partDNameContext, freshness, inputDates, rangesByUnit, formatSpreadMultiple, isExtremeSpread, paidComparison, parsePaid, COST_PLUS, RULES, HONESTY, EXTREME_HEADLINE, EXTREME_LOW, EXTREME_HIGH } from '../../src/core/rules.js';
import { formatMoney, formatMultiple, formatUnitPrice } from '../../src/core/money.js';
import { formatNdc } from '../../src/core/ndc.js';
import { SOURCE_INFO } from '../../src/core/sources.js';
import { REPO_URL, SITE_URL } from '../../src/core/config.js';
import { slugify, siteSlugs } from '../../src/core/slug.js';
import { parseHash, clipText } from '../../src/core/hash.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PAGE = pathToFileURL(path.join(ROOT, 'openbill.html')).href;
const METHODOLOGY = pathToFileURL(path.join(ROOT, 'methodology.html')).href;
const TODAY = '2026-10-17';
// The default card: the showcase (docs/ARCHITECTURE.md, "Showcase"; owner decision 2026-10-18).
const DEFAULT = 'ARIPIPRAZOLE 10 MG TABLET';
const DEFAULT_QTY = 30;
// The first showcase, now a Try link; still covered by the search, NDC and Try-link checks.
const METFORMIN = 'METFORMIN HCL 500 MG TABLET';

const doc = JSON.parse(readFileSync(path.join(ROOT, 'data/drugs.json'), 'utf8'));
const linked = linkRows(doc);
const partDContext = partDNameContext(linked);
const products = groupProducts(linked);
const byName = new Map(products.map((p) => [p.name, p]));
const index = buildIndex(products);
const NOT_YOURS = HONESTY.find((h) => h.id === 'not-your-price').parts.find((p) => p.strong).text;
/** A date this many days after an ISO date. */
const dayAfter = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
/** A product can leave NADAC in any week: a test about one named product says so and skips. */
const skipIfGone = (...names) => test.skip(!names.every((n) => byName.has(n)), `${names.join(', ')}: not in this data (decision 55)`);
// For a test that needs some other drug: a query with several results, the first of them not the
// default card, this week. Several, because Enter only moves to a list that has more than one.
const OTHER_QUERY = ['eliquis 5', 'lisinopril 20', 'omeprazole 20', 'gabapentin 300'].find((q) => {
  const hits = search(index, q);
  return hits.length > 1 && hits[0].product.name !== DEFAULT;
});

function moneyRange(min, max) {
  const a = formatMoney(min.value);
  const b = formatMoney(max.value);
  return a === b ? a : `${a} – ${b}`;
}

function unitText(range) {
  const a = formatUnitPrice(range.min.value);
  const b = formatUnitPrice(range.max.value);
  const per = range.units.length === 1 ? ` per ${range.units[0]}` : '';
  return a === b ? `${a}${per}` : `${a} to ${b}${per}`;
}

/** The strings the card should show for a product at a quantity, from the core. */
function expected(name, qty) {
  const s = summarizeProduct(byName.get(name).rows, qty, { partDContext });
  const out = { s, pharmacy: s.pack.missing ? null : moneyRange(s.pack.min, s.pack.max) };
  if (!s.reference.missing) {
    out.medicare = s.reference.pack.missing ? null : moneyRange(s.reference.pack.min, s.reference.pack.max);
    out.medicareLabel = s.reference.kind === 'part_b' ? 'Medicare Part B pays' : 'Medicare Part D paid';
  }
  if (!s.spread.missing) {
    const a = formatSpreadMultiple(s.spread.range.min.value);
    const b = formatSpreadMultiple(s.spread.range.max.value);
    out.spread = a === b ? a : `${a} – ${b}`;
    out.sentence = s.spread.sentence;
  }
  if (!s.cost_plus.missing) {
    out.costPlus = moneyRange(s.cost_plus.min, s.cost_plus.max);
    // The formula starts from the pack total the card prints (in cents), as costPlusEstimate() does.
    const a = formatMoney(s.pack.min.value);
    const b = formatMoney(s.pack.max.value);
    out.costPlusFormula = `${a === b ? `${a} (NADAC)` : `(${a} to ${b}, NADAC)`} × ${(100 + COST_PLUS.markup_pct) / 100} + ${formatMoney(COST_PLUS.fee_usd)} fee`;
    // Worked out by hand from what the card shows, it gives the card's estimate to the cent.
    for (const [pack, cp] of [[s.pack.min, s.cost_plus.min], [s.pack.max, s.cost_plus.max]]) {
      const cents = Math.round(pack.value * 100);
      expect(Math.round((cents * (100 + COST_PLUS.markup_pct)) / 100) + COST_PLUS.fee_usd * 100, `${name} at ${qty}`).toBe(Math.round(cp.value * 100));
    }
  }
  return out;
}

/** The multiples the card shows for what the reader paid: "3.6×" or "3.2× – 3.6×". */
function multiples(vs) {
  const a = formatMultiple(vs.min);
  const b = formatMultiple(vs.max);
  return a === b ? a : `${a} – ${b}`;
}

function hashFor(name, qty, paid) {
  return `#drug=${encodeURIComponent(name)}${qty === undefined ? '' : `&qty=${qty}`}${paid === undefined ? '' : `&paid=${encodeURIComponent(paid)}`}`;
}

/** The page's own #… parameters. */
async function hashParams(page) {
  return new URLSearchParams(new URL(page.url()).hash.replace(/^#/, ''));
}

const summary = (p) => summarizeProduct(p.rows, undefined, { partDContext });
const noReference = products.find((p) => /^[A-Z]/.test(p.name) && summary(p).reference.missing && !summary(p).coinsurance).name;
const coinsuranceOnly = products.find((p) => summary(p).reference.missing && summary(p).coinsurance).name;
const partB =
  ['GRANISETRON HCL 1 MG TABLET'].find((n) => byName.has(n) && summary(byName.get(n)).reference.kind === 'part_b') ||
  products.find((p) => summary(p).reference.kind === 'part_b').name;
// The contract's own example of an extreme estimated spread, when it still has a reference.
const extreme =
  ['METFORMIN HCL 750 MG TABLET'].find((n) => byName.has(n) && summarizeProduct(byName.get(n).rows, 60).spread.extreme) ||
  products.find((p) => summarizeProduct(p.rows, 30).spread.extreme).name;
const mixedUnits = ['POLYETHYLENE GLYCOL 3350 POWD'].find((n) => byName.has(n) && summary(byName.get(n)).nadac.units.length > 1) || products.find((p) => summary(p).nadac.units.length > 1).name;
const carried = products.find((p) => summary(p).counts.carried_forward > 0 && !summary(p).reference.missing).name;
// A spread just inside a threshold, which the plain formatMultiple would show as the threshold.
const nearThreshold = (() => {
  for (const p of products) {
    const s = summarizeProduct(p.rows, 30);
    if (s.spread.missing || s.spread.extreme) continue;
    for (const r of s.spread.range.records) {
      const shown = formatMultiple(r.value);
      const v = Number(shown.replace(/[×,]/g, ''));
      if (!isExtremeSpread(r) && (v <= EXTREME_LOW || v >= EXTREME_HIGH)) return { name: p.name, record: r };
    }
  }
  return null;
})();
// Review BOUT-5: a product far dearer than the other products CMS averages under its Part D name.
const nameOutlierProduct = products.find((p) => {
  const s = summary(p);
  return !s.spread.missing && s.spread.name_outliers.length > 0;
});
const withGeneric = products.find((p) => p.rows.some((r) => r.generic_nadac)).name;
// A product whose NDCs have different NADAC prices, so the cost-plus estimate is a range.
const costPlusRange = products.find((p) => {
  const s = summarizeProduct(p.rows, 30, { partDContext });
  return !s.cost_plus.missing && !s.cost_plus.same && s.nadac.units.length === 1;
}).name;
// Two product names that share a slug each link their own suffixed page (siteSlugs, decision 46).
const slugGroups = new Map();
for (const p of products) {
  const k = slugify(p.name);
  slugGroups.set(k, [...(slugGroups.get(k) || []), p.name]);
}
const sharedSlug = [...slugGroups.values()].find((names) => names.length > 1);

/** Open a page with listeners for network requests, console errors and CSP violations. */
async function open(page, url, { today = TODAY, ready = 'true' } = {}) {
  const seen = { requests: [], errors: [], csp: [] };
  page.on('request', (r) => {
    if (!/^(file|data):/.test(r.url())) seen.requests.push(r.url());
  });
  page.on('console', (m) => {
    if (m.type() === 'error') seen.errors.push(m.text());
  });
  page.on('pageerror', (e) => seen.errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.clock.setFixedTime(new Date(`${today}T12:00:00Z`));
  await page.goto(url);
  if (url.startsWith('file:') && !url.startsWith(METHODOLOGY)) {
    await expect(page.locator('html')).toHaveAttribute('data-ready', /.+/, { timeout: 30_000 });
    expect(await page.locator('html').getAttribute('data-ready')).toBe(ready);
  }
  seen.check = async () => {
    seen.csp = await page.evaluate(() => window.__csp);
    expect(seen.requests, 'no network requests other than file: and data:').toEqual([]);
    expect(seen.errors, 'no console errors').toEqual([]);
    expect(seen.csp, 'no CSP violations').toEqual([]);
  };
  return seen;
}

/**
 * Click "Sources and method". The page scrolls smoothly where motion is allowed
 * (scroll-behavior: smooth), which also makes Playwright's own scroll-into-view animate in
 * Firefox, so a click can land where the summary was a frame earlier. Scroll it into view and
 * let the page settle first; the click itself is still a real click.
 */
async function openPanel(page) {
  const summary = page.locator('#panel > summary');
  await scrollSettled(page);
  await summary.scrollIntoViewIfNeeded();
  await scrollSettled(page);
  await summary.click();
}

/** Resolves once the page has kept the same scroll position for three animation frames. */
async function scrollSettled(page) {
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        let last = null;
        let same = 0;
        const tick = () => {
          const y = window.scrollY;
          same = y === last ? same + 1 : 0;
          last = y;
          if (same >= 3) resolve(true);
          else requestAnimationFrame(tick);
        };
        tick();
      }),
  );
}

/**
 * A copy of openbill.html whose inline data block is replaced. It is written to a short temporary
 * directory, not the test's output dir: Firefox cannot open a file:// path over 260 characters
 * on Windows, and the checkout path plus test-results/<test name>/ passes that.
 */
function pageWithData(info, name, { mutate, descriptor }) {
  const html = readFileSync(path.join(ROOT, 'openbill.html'), 'utf8');
  const re = /(<script type="application\/json" id="openbill-data">)([\s\S]*?)(<\/script>)/;
  const desc = JSON.parse(re.exec(html)[2]);
  let next = { ...desc };
  if (mutate) {
    const d = unpackDrugs(JSON.parse(zlib.inflateRawSync(Buffer.from(desc.data, 'base64')).toString('utf8')));
    mutate(d);
    const raw = Buffer.from(JSON.stringify(packDrugs(d)), 'utf8');
    next = { ...desc, json_bytes: raw.length, sha256: crypto.createHash('sha256').update(raw).digest('hex'), data: zlib.deflateRawSync(raw).toString('base64') };
  }
  if (descriptor) next = descriptor(next);
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), `openbill-${info.project.name}-`)), name);
  writeFileSync(file, html.replace(re, (_, a, __, c) => `${a}${JSON.stringify(next).replace(/</g, '\\u003c')}${c}`), 'utf8');
  return pathToFileURL(file).href;
}

test('loads offline: no network, no console errors, no CSP violations; reports startup time', async ({ page }, info) => {
  const seen = await open(page, PAGE);
  await page.locator('#q').fill('metformin');
  await expect(page.locator('#results button.result').first()).toBeVisible();
  await openPanel(page);
  await expect(page.locator('#panel-body')).toBeVisible();
  await seen.check();
  const startup = await page.evaluate(() => ({ ms: document.documentElement.dataset.startupMs, timings: JSON.parse(document.documentElement.dataset.timings) }));
  info.annotations.push({ type: 'startup', description: `${startup.ms} ms from script start to first card; ${JSON.stringify(startup.timings)}` });
  console.log(`[${info.project.name}] startup ${startup.ms} ms ${JSON.stringify(startup.timings)}`);
  expect(Number(startup.ms)).toBeGreaterThan(0);
  // The card is drawn before the search index is built (review PERF-1).
  expect(startup.timings.first_card_since_navigation_ms).toBeLessThanOrEqual(startup.timings.since_navigation_ms);
});

test('the default card is ARIPIPRAZOLE 10 MG TABLET at 30 with the real values', async ({ page }) => {
  const seen = await open(page, PAGE);
  const e = expected(DEFAULT, DEFAULT_QTY);
  const card = page.locator('#card');
  await expect(card.locator('#card-title')).toHaveText(DEFAULT);
  await expect(card.locator('#qty')).toHaveValue(String(DEFAULT_QTY));
  await expect(card.locator(`.qty-chip[data-qty="${DEFAULT_QTY}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(card.locator('[data-figure="pharmacy"]')).toHaveText(e.pharmacy);
  await expect(card.locator('.fig-pharmacy .arith')).toContainText(`${DEFAULT_QTY} × `);
  await expect(card.locator('[data-figure="cost-plus"]')).toHaveText(e.costPlus);
  await expect(card.locator('.fig-medicare .fig-label')).toHaveText(e.medicareLabel);
  await expect(card.locator('[data-figure="medicare"]')).toHaveText(e.medicare);
  await expect(card.locator('[data-figure="spread"]')).toHaveText(e.spread);
  await expect(card.locator('.spread-sentence')).toHaveText(e.sentence);
  const range = HONESTY.find((h) => h.id === 'range').text;
  await expect(card.locator('.honesty')).toContainText(range);
  // "Medicare's price is not your price." sits with the Medicare figure itself.
  await expect(card.locator('.fig-medicare .not-yours')).toHaveText(NOT_YOURS);
  // The build block names the same default, and the page opened it without a #drug= in the URL.
  const build = JSON.parse(await page.locator('#openbill-build').textContent());
  expect(build.default).toEqual({ drug: DEFAULT, qty: DEFAULT_QTY });
  expect(new URL(page.url()).hash).toBe('');
  await seen.check();
});

// Contract: at 360×780 (and on the desktop viewport) the default card's two prices, the spread
// and their state chips are on the first screen, and each figure's provenance line follows it.
test('the hero: both prices, the spread and their chips are visible without scrolling', async ({ page }, info) => {
  await open(page, PAGE);
  const vp = page.viewportSize();
  const box = await page.evaluate(() => {
    const bottom = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect().bottom : null;
    };
    const order = ['.fig-pharmacy', '.fig-medicare', '.spread'].map((s) => {
      const sec = document.querySelector(s);
      const kids = [...sec.children].map((c) => c.className);
      return { value: kids.findIndex((c) => /fig-value/.test(c)), prov: kids.findIndex((c) => /\bprov\b/.test(c)) };
    });
    return {
      h: window.innerHeight,
      scrollY: window.scrollY,
      figures: ['[data-figure="pharmacy"]', '.fig-pharmacy .fig-value .chip', '[data-figure="medicare"]', '.fig-medicare .fig-value .chip', '[data-figure="cost-plus"]', '.costplus .chip', '[data-figure="spread"]', '.spread .fig-value .chip'].map((s) => [s, bottom(s)]),
      order,
      // The cost-plus line sits under the two figures and before the spread.
      sections: [...document.querySelectorAll('#figures > section')].map((x) => x.className.split(' ')[0]),
    };
  });
  expect(box.scrollY).toBe(0);
  expect(box.sections).toEqual(['fig', 'fig', 'costplus', 'spread']);
  for (const [sel, b] of box.figures) {
    expect(b, `${sel} exists`).not.toBeNull();
    expect(b, `${sel} bottom ${b} within the ${vp.width}×${vp.height} first screen (${info.project.name})`).toBeLessThanOrEqual(box.h);
  }
  for (const o of box.order) {
    expect(o.value).toBeGreaterThanOrEqual(0);
    expect(o.prov, 'each figure has its own provenance line after it').toBeGreaterThan(o.value);
  }
  for (const sel of ['[data-figure="pharmacy"]', '[data-figure="medicare"]', '[data-figure="cost-plus"]', '[data-figure="spread"]', '.fig-pharmacy .fig-value .chip', '.costplus .chip', '.spread .fig-value .chip']) await expect(page.locator(sel)).toBeInViewport({ ratio: 1 });
});

test('the state chips are on the card as visible text', async ({ page }) => {
  await open(page, PAGE);
  const e = expected(DEFAULT, DEFAULT_QTY);
  const ph = page.locator('.fig-pharmacy .fig-value .chip').first();
  await expect(ph).toBeVisible();
  await expect(ph).toHaveText(e.s.pack.min.state);
  await expect(page.locator('.fig-medicare .fig-value .chip').first()).toHaveText(e.s.reference.range.state);
  const sp = page.locator('.spread .fig-value .chip').first();
  await expect(sp).toBeVisible();
  await expect(sp).toHaveText(e.s.spread.state);
});

test('the provenance lines show the file, effective date and retrieved date, always visible', async ({ page }) => {
  await open(page, PAGE);
  const e = expected(DEFAULT, DEFAULT_QTY);
  const prov = page.locator('.fig-pharmacy .prov').first();
  await expect(prov).toBeVisible();
  const n = e.s.nadac.min;
  for (const part of [n.source_name, n.source_file, `eff. ${n.effective_date}`, `retrieved ${n.retrieved_date}`, `as of ${n.as_of_date}`]) await expect(prov).toContainText(part);
  const ref = e.s.reference.range.min;
  const mprov = page.locator('.fig-medicare .prov').first();
  await expect(mprov).toBeVisible();
  for (const part of [ref.source_file, `eff. ${ref.effective_date}`, `retrieved ${ref.retrieved_date}`, ref.period.split('/')[1]]) await expect(mprov).toContainText(part);
  const f = freshness(e.s.freshness_inputs.find((x) => x.source === 'nadac').record, SOURCE_INFO.nadac, TODAY);
  await expect(page.locator('.notes .fresh').first()).toHaveText(f.message);
});

// Contract: next to any calculated figure the card shows each input's own date or period, never
// the oldest date alone (review NUM-3, CORE-2, DOC-3, UI-6).
test('the spread and a Part B conversion show each input’s own date or period', async ({ page }) => {
  await open(page, PAGE);
  const e = expected(DEFAULT, DEFAULT_QTY);
  const line = page.locator('.spread .prov');
  await expect(line).toHaveCount(1);
  const n = e.s.nadac.min;
  const d = e.s.reference.range.min;
  const [ps, pe] = d.period.split('/');
  await expect(line).toContainText(`NADAC eff. ${n.effective_date}`);
  await expect(line).toContainText(`Part D ${ps} to ${pe}`);
  for (const i of e.s.spread.inputs) await expect(line).toContainText(i.text);
  // The calculated record's merged oldest dates are not offered as the spread's date.
  await expect(line).not.toContainText(`eff. ${e.s.spread.range.min.effective_date} ·`);
  // Part B: the Medicare figure is itself calculated from the limit and the crosswalk.
  await page.goto(PAGE + hashFor(partB));
  const b = summary(byName.get(partB));
  const mline = page.locator('.fig-medicare .prov');
  for (const i of b.reference.inputs) await expect(mline).toContainText(i.text);
  await expect(mline).toContainText(`Part B limit ${b.reference.range.min.period.replace('/', ' to ')}`);
  await expect(page.locator('.spread .prov')).toContainText('NADAC eff.');
  // In the panel, each calculated record lists its inputs.
  await openPanel(page);
  await expect(page.locator('#panel-body .input-date').first()).toBeVisible();
  const sp = b.per_ndc.find((x) => !x.spread.missing).spread;
  await expect(page.locator('#panel-body')).toContainText(inputDates(sp.inputs)[0].text);
});

test('opening Sources and method shows every reason and every NDC', async ({ page }) => {
  await open(page, PAGE);
  const e = expected(DEFAULT, DEFAULT_QTY);
  const summaryEl = page.locator('#panel > summary');
  await expect(summaryEl).toHaveText('Sources and method');
  await openPanel(page);
  const body = page.locator('#panel-body');
  await expect(body).toBeVisible();
  await expect(body).toContainText(e.s.nadac.min.reason);
  await expect(body).toContainText(e.s.spread.range.min.reason);
  await expect(body).toContainText(e.s.reference.range.min.reason);
  await expect(body.locator('li.ndc')).toHaveCount(e.s.ndcs.length);
  for (const ndc of [e.s.ndcs[0], e.s.ndcs[e.s.ndcs.length - 1]]) await expect(body).toContainText(`NDC ${formatNdc(ndc)}`);
  await expect(body).toContainText('calculated from the most recently completed pharmacy survey');
  for (const id of ['unit-total', 'reference-price', 'spread', 'cost-plus', 'what-you-paid', 'freshness']) {
    await expect(body.locator(`ul.rules a[href="${SITE_URL}methodology.html#${id}"]`), `rules list links #${id}`).toHaveCount(1);
  }
  await expect(body.locator('.not-yours').first()).toHaveText(NOT_YOURS);
});

test('"Wrong? Tell us" opens a prefilled wrong-price issue in a new tab, before the panel in reading order', async ({ page }) => {
  await open(page, PAGE);
  const link = page.locator('#report');
  await expect(link).toHaveText('Wrong? Tell us');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  const href = await link.getAttribute('href');
  expect(href.startsWith(`${REPO_URL}/issues/new?template=wrong-price.yml`)).toBe(true);
  const params = new URL(href).searchParams;
  expect(params.get('product')).toBe(DEFAULT);
  expect(params.get('ndc')).toContain(formatNdc(byName.get(DEFAULT).ndcs[0]));
  expect(params.get('shown_value')).toContain(expected(DEFAULT, DEFAULT_QTY).pharmacy);
  expect(params.get('shown_value')).toContain(`cost-plus estimate ${expected(DEFAULT, DEFAULT_QTY).costPlus} (estimated)`);
  expect(params.get('source_file')).toContain(doc.sources.nadac.source_file);
  const build = JSON.parse(await page.locator('#openbill-build').textContent());
  expect(params.get('build_id')).toBe(build.build_id);
  // Review A11Y-2: DOM order (and so tab order) matches what is seen: the link, then the panel.
  const before = await page.evaluate(() => Boolean(document.getElementById('report').compareDocumentPosition(document.getElementById('panel')) & Node.DOCUMENT_POSITION_FOLLOWING));
  expect(before).toBe(true);
  const [r, p] = await Promise.all([link.boundingBox(), page.locator('#panel > summary').boundingBox()]);
  expect(r.y).toBeLessThan(p.y);
});

test('search "metformin" lists results and opens a card', async ({ page }) => {
  const seen = await open(page, PAGE);
  const input = page.locator('#q');
  await expect(input).toBeEnabled();
  await input.fill('metformin');
  const all = search(index, 'metformin', { limit: 1000 });
  const results = page.locator('#results button.result');
  await expect(results).toHaveCount(Math.min(20, all.length));
  await expect(results.first().locator('.result-name')).toHaveText(all[0].product.name);
  await expect(page.locator('#search-status')).toContainText(String(all.length));
  await expect(results.first().locator('.chip')).toBeVisible();
  const target = results.filter({ has: page.locator('.result-name', { hasText: /^METFORMIN HCL 500 MG TABLET$/ }) });
  await target.click();
  await expect(page.locator('#card-title')).toHaveText(METFORMIN);
  const q = summary(byName.get(METFORMIN)).default_quantity.qty;
  await expect(page.locator('#qty')).toHaveValue(String(q));
  const e = expected(METFORMIN, q);
  await expect(page.locator('[data-figure="pharmacy"]')).toHaveText(e.pharmacy);
  await expect(page.locator('[data-figure="medicare"]')).toHaveText(e.medicare);
  await expect(page.locator('[data-figure="spread"]')).toHaveText(e.spread);
  await expect(page.locator('[data-figure="cost-plus"]')).toHaveText(e.costPlus);
  await expect(page.locator('#results button')).toHaveCount(0);
  expect(decodeURIComponent(new URL(page.url()).hash)).toBe(`#drug=${METFORMIN}&qty=${q}`);
  await seen.check();
});

test('the Try links are real products; metformin, the first showcase, opens from there', async ({ page }) => {
  await open(page, PAGE);
  const build = JSON.parse(await page.locator('#openbill-build').textContent());
  const links = page.locator('.try-list a');
  await expect(links).toHaveCount(build.try.length);
  expect(build.try).toContain(METFORMIN);
  for (const n of build.try) expect(byName.has(n), n).toBe(true);
  await page.locator('.try-list a', { hasText: METFORMIN }).click();
  await expect(page.locator('#card-title')).toHaveText(METFORMIN);
  const q = summary(byName.get(METFORMIN)).default_quantity.qty;
  await expect(page.locator('[data-figure="pharmacy"]')).toHaveText(expected(METFORMIN, q).pharmacy);
});

// Review DES-3: a result whose own name contains the query does not repeat 'matched "…"'.
test('search results say which name matched only when the product name does not show it', async ({ page }) => {
  await open(page, PAGE);
  await page.locator('#q').fill('insulin');
  const results = page.locator('#results button.result');
  await expect(results.first()).toBeVisible();
  const names = await results.locator('.result-name').allTextContents();
  const vias = await results.evaluateAll((els) => els.map((b) => (b.querySelector('.result-via') ? b.querySelector('.result-via').textContent : null)));
  names.forEach((n, i) => {
    if (n.includes('INSULIN')) expect(vias[i], n).toBeNull();
  });
  // A brand found by its generic name says so. Which one depends on the week (decision 55).
  const brand = search(index, 'apixaban').find((r) => !r.product.name.includes('APIXABAN'));
  if (brand) {
    await page.locator('#q').fill('apixaban');
    await expect(page.locator('#results button.result', { hasText: brand.product.name }).first().locator('.result-via')).toContainText('matched');
  }
});

// This test used to pin Enter opening the first of several results, which is OB-13 and J25: typing
// "metformin" and pressing Enter opened a price the reader had not chosen.
test('Enter on several results stays on the list, and the next Enter chooses; no match shows a suggestion and a hint, and says so', async ({ page }) => {
  await open(page, PAGE);
  const input = page.locator('#q');
  await input.fill(OTHER_QUERY);
  await expect(page.locator('#results button.result').first()).toBeVisible();
  const found = search(index, OTHER_QUERY);
  expect(found.length).toBeGreaterThan(1);
  await input.press('Enter');
  await expect(page.locator('#results button.result').first()).toBeFocused();
  await expect(page.locator('#card-title')).toHaveText(DEFAULT);
  await page.keyboard.press('Enter');
  await expect(page.locator('#card-title')).toHaveText(found[0].product.name);
  await input.fill('metfromin');
  // Review A11Y-1: the suggestion is in the live status region, so it is read out.
  await expect(page.locator('#search-status')).toHaveText('No drug matches “metfromin”. Did you mean METFORMIN?');
  await expect(page.locator('#search-status')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#search-help button.suggest').first()).toHaveText('METFORMIN');
  await expect(page.locator('#search-help')).toContainText('generic name');
});

test('NDC search works in three formats', async ({ page }) => {
  await open(page, PAGE);
  const row = byName.get(METFORMIN).rows.find((r) => r.identity && r.identity.package_ndc.replace(/-/g, '').length === 10);
  const formats = [row.ndc, formatNdc(row.ndc), row.identity.package_ndc];
  expect(new Set(formats).size).toBe(3);
  for (const q of formats) {
    await page.locator('#q').fill(q);
    const results = page.locator('#results button.result');
    await expect(results).toHaveCount(1);
    await expect(results.first().locator('.result-name')).toHaveText(METFORMIN);
    await expect(results.first().locator('.result-ndc')).toHaveText(`NDC ${formatNdc(row.ndc)}`);
  }
  await page.locator('#q').press('Enter');
  await expect(page.locator('#card-title')).toHaveText(METFORMIN);
});

test('a product with no Medicare figure says "we don\'t know yet", never a zero', async ({ page }) => {
  const seen = await open(page, PAGE + hashFor(noReference));
  await expect(page.locator('#card-title')).toHaveText(noReference);
  const md = page.locator('.fig-medicare');
  await expect(md).toContainText(/we don.t know yet/i);
  await expect(md.locator('.why')).toHaveText(summary(byName.get(noReference)).reference.reason);
  await expect(page.locator('.spread')).toContainText(/we don.t know yet/i);
  await expect(page.locator('[data-figure="medicare"]')).toHaveCount(0);
  await expect(page.locator('#card')).not.toContainText('$0.00');
  // No Medicare figure anywhere on the card or in its panel, so no Medicare line either.
  await expect(page.locator('#card')).not.toContainText(NOT_YOURS);
  await seen.check();
});

// Review NUM-4: the panel showed Part B coinsurance (a Medicare figure) with no "Medicare's
// price is not your price." anywhere on the card.
test('a product with Part B coinsurance but no reference still says Medicare’s price is not your price', async ({ page }) => {
  await open(page, PAGE + hashFor(coinsuranceOnly));
  await expect(page.locator('#card-title')).toHaveText(coinsuranceOnly);
  await expect(page.locator('.honesty')).toContainText(NOT_YOURS);
  await openPanel(page);
  await expect(page.locator('#panel-body')).toContainText('Part B coinsurance per billing unit');
  await expect(page.locator('#panel-body .not-yours').first()).toHaveText(NOT_YOURS);
});

test('a product whose reference is Medicare Part B renders, with the setting note for its kind of drug', async ({ page }) => {
  const seen = await open(page, PAGE + hashFor(partB));
  const s = summary(byName.get(partB));
  const q = s.default_quantity.qty;
  const e = expected(partB, q);
  await expect(page.locator('#card-title')).toHaveText(partB);
  await expect(page.locator('.fig-medicare .fig-label')).toHaveText('Medicare Part B pays');
  await expect(page.locator('[data-figure="medicare"]')).toHaveText(e.medicare);
  await expect(page.locator('[data-figure="spread"]')).toHaveText(e.spread);
  await expect(page.locator('.spread-sentence')).toHaveText(e.sentence);
  // Review PARTB-9: an oral Part B drug is not told it is "given in a clinic".
  for (const note of s.reference.setting_notes) await expect(page.locator('.notes')).toContainText(note);
  if (byName.get(partB).rows.some((r) => r.identity && r.identity.route === 'ORAL')) await expect(page.locator('.notes')).toContainText('this oral drug');
  await expect(page.locator('.spread .fig-value .chip')).toHaveText(e.s.spread.state);
  await seen.check();
});

// Contract and review NUM-2, UI-6, CORE-1, DOC-2, BOUT-5: an extreme estimated spread leads with
// "These two figures may not measure the same thing", the multiple beside it, and the caveat.
test('an extreme spread leads with "These two figures may not measure the same thing"', async ({ page }) => {
  const qty = 60;
  const seen = await open(page, PAGE + hashFor(extreme, qty));
  const e = expected(extreme, qty);
  await expect(page.locator('#card-title')).toHaveText(extreme);
  await expect(page.locator('.spread-sentence')).toHaveText(EXTREME_HEADLINE);
  await expect(page.locator('.spread-sentence')).toBeVisible();
  await expect(page.locator('[data-figure="spread"]')).toHaveText(e.spread);
  await expect(page.locator('.spread .caveat-extreme')).toContainText('may not describe the same unit or product');
  await expect(page.locator('.spread .fig-value .chip')).toHaveText('estimated');
  // No confident "Medicare paid 99% less" / "less than 1%" / "N× what pharmacies pay" sentence.
  await expect(page.locator('.spread')).not.toContainText(/% less|less than 1%|what pharmacies pay\./);
  await openPanel(page);
  for (const li of await page.locator('#panel-body li.ndc').all()) await expect(li).not.toContainText(/Medicare paid (\d+% less|less than 1%)/);
  await seen.check();
});

// Review follow-up (g): the thresholds are tested on the unrounded ratio, so a spread just inside
// one (KENALOG-40 200 MG/5 ML VIAL, 0.2046) is shown with the digits that keep it inside, never
// as "0.20×" or "20.0×" without the headline.
test('a spread just inside a threshold is not shown as the threshold without the headline', async ({ page }) => {
  test.skip(!nearThreshold, 'no spread in this build sits just inside a threshold');
  await open(page, PAGE + hashFor(nearThreshold.name, 30));
  const shown = await page.locator('[data-figure="spread"]').textContent();
  expect(shown).toContain(formatSpreadMultiple(nearThreshold.record.value));
  expect(shown).not.toContain(formatMultiple(nearThreshold.record.value));
  await expect(page.locator('.spread-sentence')).not.toHaveText(EXTREME_HEADLINE);
});

// Review BOUT-5: the card says when this product costs far more than the other products CMS
// averages under the same Part D name, with both prices; the rule is listed in the panel.
test('a Part D spread far from the other products under its name says so on the card', async ({ page }) => {
  test.skip(!nameOutlierProduct, 'no product in this build is far from the others under its Part D name');
  await open(page, PAGE + hashFor(nameOutlierProduct.name));
  const s = summary(nameOutlierProduct);
  await expect(page.locator('.spread')).toContainText(s.spread.name_outliers[0]);
  await openPanel(page);
  await expect(page.locator(`#panel-body ul.rules a[href="${SITE_URL}methodology.html#part-d-name-outlier"]`)).toHaveCount(1);
});

// Review NUM-5: NDCs priced per different units showed only four prices and merged the units.
test('a product priced per several units shows one range per unit, on the card and in the report', async ({ page }) => {
  await open(page, PAGE + hashFor(mixedUnits));
  const s = summary(byName.get(mixedUnits));
  // One range per unit, the unit with the most NDCs first (rangesByUnit over every row).
  const want = rangesByUnit(s.per_ndc.map((x) => x.nadac)).map((g) => unitText(g.range)).join('; ');
  expect(want).toBe(s.nadac_by_unit.map((g) => unitText(g.range)).join('; '));
  await expect(page.locator('[data-figure="pharmacy-unit"]')).toHaveText(want);
  for (const u of s.nadac.units) await expect(page.locator('[data-figure="pharmacy-unit"]')).toContainText(`per ${u}`);
  const params = new URL(await page.locator('#report').getAttribute('href')).searchParams;
  expect(params.get('shown_value')).toContain(`Pharmacy pays ${want}`);
});

// Review NUM-6: the Part B total is worked out from the filed inputs before rounding.
test('a Part B total at a quantity is the exact figure rounded half-up', async ({ page }) => {
  const name = 'ALBUTEROL SUL 0.63 MG/3 ML SOL';
  test.skip(!byName.has(name) || summary(byName.get(name)).reference.kind !== 'part_b', `${name} has no Part B reference in this build`);
  await open(page, PAGE + hashFor(name, 75));
  const e = expected(name, 75);
  await expect(page.locator('[data-figure="medicare"]')).toHaveText(e.medicare);
  await openPanel(page);
  await expect(page.locator('#panel-body')).toContainText('worked out exactly and rounded half-up to cents');
});

// Review NUM-9: a carried-forward NADAC is labelled on the card, not only in the panel.
test('a carried-forward NADAC is said on the card', async ({ page }) => {
  await open(page, PAGE + hashFor(carried));
  const s = summary(byName.get(carried));
  await expect(page.locator('.notes .carried')).toContainText('carried forward from an earlier file');
  const d = s.per_ndc.find((x) => x.row.carried_forward).nadac.effective_date;
  await expect(page.locator('.notes .carried')).toContainText(d);
});

// Review GEN-11: the generic's NADAC is labelled as a different product, with its own date.
test('a generic equivalent’s NADAC in the panel says it is a different product, with its date', async ({ page }) => {
  await open(page, PAGE + hashFor(withGeneric));
  await openPanel(page);
  const row = byName.get(withGeneric).rows.find((r) => r.generic_nadac);
  const li = page.locator(`#panel-body li#ndc-${row.ndc}`);
  await expect(li).toContainText('Generic equivalent’s NADAC (a different product):');
  await expect(li).toContainText(`eff. ${row.generic_nadac.effective_date}`);
});

// docs/ARCHITECTURE.md, the multi-route rule: an NDC whose package is not in the FDA NDC
// Directory may join a Part D name marked * on the route of FDA's record for the same product
// (part_d.route_from "fda_product"). Its panel entry says so plainly, names the route and FDA's
// product NDC as FDA writes it, and the FDA packages that list the NDC inside them.
const routeFromText = (r) => {
  const inner = r.part_d.inner_of;
  const within = inner.length ? `; FDA lists it as a unit inside ${inner.length === 1 ? 'its package' : 'its packages'} ${inner.length < 2 ? inner[0] : `${inner.slice(0, -1).join(', ')} and ${inner[inner.length - 1]}`}` : '';
  return `Route for the Part D match: ${r.part_d.route}. The FDA NDC Directory does not list this NDC as a package of its own${within}. Its route was taken from FDA’s record for the same product, product NDC ${r.part_d.product_ndc} (labeler and product code). ${r.part_d.brand_name} is a Part D name CMS marks with * (one average over several routes), which only NDCs on the route its NDCs share point at.`;
};
const routeFromRow =
  ['50268066211'].map((n) => linked.find((r) => r.ndc === n)).find((r) => r && r.part_d && r.part_d.route_from === 'fda_product') ||
  linked.find((r) => r.part_d && r.part_d.route_from === 'fda_product' && !summary(byName.get(r.name)).reference.missing);
test('an NDC whose * route came from FDA’s product record says so in the panel and names the route', async ({ page }) => {
  expect(routeFromRow, 'some row takes its * route from the FDA product record').toBeTruthy();
  expect(routeFromRow.identity).toBeNull();
  await open(page, PAGE + hashFor(routeFromRow.name));
  await openPanel(page);
  const li = page.locator(`#panel-body li#ndc-${routeFromRow.ndc}`);
  if (routeFromRow.ndc === '50268066211') {
    // FDA's product.txt writes this product NDC 50268-662 (5-3), not 50268-0662, and package.txt
    // prints 50268-662-11 inside package 50268-662-15 ('50 BLISTER PACK in 1 BOX (50268-662-15) /
    // 1 TABLET in 1 BLISTER PACK (50268-662-11)'), FDA NDC Directory file of this build.
    expect(routeFromRow.part_d.product_ndc).toBe('50268-662');
    expect(routeFromRow.part_d.inner_of).toEqual(['50268-662-15']);
  }
  await expect(li).toContainText('The FDA NDC Directory file used for this build does not list this NDC as a package of its own');
  await expect(li.locator('p.route-from')).toHaveText(routeFromText(routeFromRow));
  // The row's own Part D figure is shown, not "we don't know yet".
  await expect(li).toContainText(formatUnitPrice(routeFromRow.part_d.avg_per_unit.value));
  // NDCs of the same product with an FDA identity carry no such note.
  for (const r of byName.get(routeFromRow.name).rows.filter((x) => x.identity)) {
    await expect(page.locator(`#panel-body li#ndc-${r.ndc} p.route-from`)).toHaveCount(0);
  }
  // The Part D name's reason says how many of its NDCs took their route this way.
  await expect(page.locator('#panel-body')).toContainText('NDCs that point at this name');
});

// A route_from row whose NDC no FDA package description prints names no containing package.
const routeFromLoneRow = linked.find((r) => r.part_d && r.part_d.route_from === 'fda_product' && Array.isArray(r.part_d.inner_of) && r.part_d.inner_of.length === 0);
test('an NDC whose * route came from FDA’s product record, and that no FDA package lists inside it, names no package', async ({ page }) => {
  expect(routeFromLoneRow, 'some route_from row has no FDA package listing it inside').toBeTruthy();
  await open(page, PAGE + hashFor(routeFromLoneRow.name));
  await openPanel(page);
  const p = page.locator(`#panel-body li#ndc-${routeFromLoneRow.ndc} p.route-from`);
  await expect(p).toHaveText(routeFromText(routeFromLoneRow));
  await expect(p).not.toContainText('lists it as a unit inside');
});

// Review NUM-8: the FDA NDC Directory supplies names and package amounts, so its date and age
// are on the card, and it is labelled stale when it is.
test('the FDA NDC Directory line and its age are on the card; stale when old', async ({ page }) => {
  const fda = doc.sources.fda_ndc;
  const today = dayAfter(fda.as_of_date, SOURCE_INFO.fda_ndc.stale_after_days + 1);
  await open(page, PAGE, { today });
  const notes = page.locator('.notes');
  await expect(notes).toContainText(`FDA NDC Directory · ${fda.source_file} · as of ${fda.as_of_date} · retrieved ${fda.retrieved_date}`);
  const f = freshness(fda, SOURCE_INFO.fda_ndc, today);
  expect(f.stale).toBe(true);
  await expect(notes.locator('.fresh-stale', { hasText: 'FDA NDC Directory' })).toContainText(f.message);
  await expect(notes.locator('.fresh-stale', { hasText: 'FDA NDC Directory' }).locator('.chip-stale')).toHaveText('stale');
});

// INFRA-10: the chip beside the number itself, which no other test held, in each form of the figure.
test('a stale figure carries a visible stale chip beside the number: pack total, per-unit prices and Medicare', async ({ page }) => {
  const staleBeside = (figure) => page.locator('.fig-value', { has: page.locator(`[data-figure="${figure}"]`) }).locator('.chip-stale');
  // Fresh: no chip beside any of them.
  await open(page, PAGE, { today: doc.sources.nadac.as_of_date });
  await expect(page.locator('[data-figure="pharmacy"]')).toBeVisible();
  await expect(staleBeside('pharmacy')).toHaveCount(0);
  await expect(staleBeside('medicare')).toHaveCount(0);
  // NADAC past its limit, 15 days after its as-of date.
  const nadacStale = dayAfter(doc.sources.nadac.as_of_date, 15);
  expect(freshness(doc.sources.nadac, SOURCE_INFO.nadac, nadacStale).stale).toBe(true);
  await page.clock.setFixedTime(new Date(`${nadacStale}T12:00:00Z`));
  await page.goto(PAGE);
  await expect(staleBeside('pharmacy')).toBeVisible();
  await expect(staleBeside('pharmacy')).toHaveText('stale');
  await expect(staleBeside('medicare')).toHaveCount(0);
  // The per-unit form, on a product with no single pack total.
  await page.goto(PAGE + hashFor(mixedUnits));
  await expect(page.locator('[data-figure="pharmacy-unit"]')).toBeVisible();
  await expect(staleBeside('pharmacy-unit')).toBeVisible();
  await expect(staleBeside('pharmacy-unit')).toHaveText('stale');
  // Medicare past its limit: a day after the Part D data year's limit.
  const partd = doc.sources.partd;
  const reference = summary(byName.get(DEFAULT)).reference.range.min;
  const medicareStale = dayAfter(reference.period.split('/')[1], SOURCE_INFO.partd.stale_after_days + 1);
  expect(freshness(reference, SOURCE_INFO.partd, medicareStale).stale, partd.source_file).toBe(true);
  await page.clock.setFixedTime(new Date(`${medicareStale}T12:00:00Z`));
  await page.goto(PAGE);
  await expect(staleBeside('medicare')).toBeVisible();
  await expect(staleBeside('medicare')).toHaveText('stale');
});

// INFRA-10: esc() on the product name everywhere it is drawn. The name comes from the data file,
// and a built page would still have to run what a hostile one holds were esc() ever dropped.
test('a hostile product name creates no element in the title, search results, panel or report link', async ({ page }, info) => {
  const hostile = 'ZZHOSTILE <img src=x onerror="window.__xss=1"><script>window.__xss=2</script> 5 MG TABLET';
  const target = byName.get(DEFAULT).rows[0].ndc;
  const url = pageWithData(info, 'hostile-name.html', {
    mutate: (d) => {
      for (const r of d.rows) if (r.ndc === target) r.name = hostile;
    },
  });
  await page.goto(url + hashFor(hostile));
  await expect(page.locator('html')).toHaveAttribute('data-ready', /.+/);
  await expect(page.locator('#card-title')).toHaveText(hostile);
  await page.locator('#q').fill('zzhostile');
  await expect(page.locator('#results button.result .result-name').first()).toHaveText(hostile);
  await openPanel(page);
  await expect(page.locator('#panel-body')).toBeVisible();
  const planted = await page.evaluate(() => ({
    xss: window.__xss,
    inCard: document.querySelectorAll('#card-title *, #card-title ~ * img[src="x"], .card img[src="x"]').length,
    inResults: document.querySelectorAll('#results .result-name *').length,
    anywhere: document.querySelectorAll('img[src="x"], img[onerror], script:not([type])').length - document.querySelectorAll('head script:not([type]), body > script:not([type])').length,
    title: document.title.includes('<img') ? 'text' : 'none',
  }));
  expect(planted.xss).toBeUndefined();
  expect(planted.inCard).toBe(0);
  expect(planted.inResults).toBe(0);
  expect(planted.anywhere).toBeLessThanOrEqual(0);
});

test('a #drug=…&qty=90 deep link opens that card at 90; quantity changes update it and are announced', async ({ page }) => {
  skipIfGone('ATORVASTATIN 20 MG TABLET');
  await open(page, PAGE + hashFor('ATORVASTATIN 20 MG TABLET', 90));
  await expect(page.locator('#card-title')).toHaveText('ATORVASTATIN 20 MG TABLET');
  await expect(page.locator('#qty')).toHaveValue('90');
  await expect(page.locator('.qty-chip[data-qty="90"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-figure="pharmacy"]')).toHaveText(expected('ATORVASTATIN 20 MG TABLET', 90).pharmacy);
  // Review DES-2: the quantity has a visible label and the unit in words.
  await expect(page.locator('.qty-label')).toBeVisible();
  await expect(page.locator('.qty-label')).toHaveText('Quantity');
  await expect(page.locator('#qty-unit')).toHaveText('each (EA)');
  await page.locator('.qty-chip[data-qty="30"]').click();
  const e30 = expected('ATORVASTATIN 20 MG TABLET', 30);
  await expect(page.locator('[data-figure="pharmacy"]')).toHaveText(e30.pharmacy);
  expect(new URL(page.url()).hash).toBe(hashFor('ATORVASTATIN 20 MG TABLET', 30));
  // Review A11Y-1: the change is announced in a status region.
  const status = page.locator('#card-status');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toContainText(`pharmacy pays ${e30.pharmacy}`);
  await expect(status).toContainText(e30.medicare);
  await page.locator('#qty').fill('45');
  await expect(page.locator('[data-figure="pharmacy"]')).toHaveText(expected('ATORVASTATIN 20 MG TABLET', 45).pharmacy);
  await expect(page.locator('#qty')).toBeFocused();
  await page.locator('#qty').fill('');
  await expect(page.locator('.fig-pharmacy .why')).toHaveText('No quantity entered.');
});

// Decision 48: a kit priced per EA used to open at "Pharmacies pay $263,287.57 for 30 kits". It
// opens at 1 now, offers 1 / 2 / 3, and the card says why, naming FDA's form.
test('a kit priced per EA opens at 1 with 1, 2 and 3 to choose from, and says why', async ({ page }) => {
  const KIT = 'AVONEX 30 MCG/0.5 ML SYRINGE KIT (4 PACK)';
  skipIfGone(KIT);
  const dq = summary(byName.get(KIT)).default_quantity;
  expect([dq.qty, dq.form.oral_solid]).toEqual([1, false]);
  const seen = await open(page, PAGE);
  await page.locator('#q').fill('avonex');
  await page.locator('#results button.result').filter({ has: page.locator('.result-name', { hasText: KIT }) }).click();
  await expect(page.locator('#card-title')).toHaveText(KIT);
  await expect(page.locator('#qty')).toHaveValue('1');
  expect(decodeURIComponent(new URL(page.url()).hash)).toBe(`#drug=${KIT}&qty=1`);
  await expect(page.locator('.qty-chip')).toHaveText(['1', '2', '3']);
  await expect(page.locator('.qty-chip[data-qty="1"]')).toHaveAttribute('aria-pressed', 'true');
  const e1 = expected(KIT, 1);
  await expect(page.locator('[data-figure="pharmacy"]')).toHaveText(e1.pharmacy);
  await expect(page.locator('[data-figure="cost-plus"]')).toHaveText(e1.costPlus);
  await expect(page.locator('.qty-note')).toHaveText(dq.reason);
  await expect(page.locator('.qty-note')).toContainText('dosage form “KIT”');
  await settledClick(page, page.locator('.qty-chip[data-qty="2"]'));
  await expect(page.locator('[data-figure="pharmacy"]')).toHaveText(expected(KIT, 2).pharmacy);
  await expect(page.locator('.qty-chip[data-qty="2"]')).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).hash).toBe(hashFor(KIT, 2));
  // An oral tablet keeps 30 / 60 / 90 and no starting-quantity note on the card.
  await page.goto(PAGE + hashFor(DEFAULT));
  await expect(page.locator('#card-title')).toHaveText(DEFAULT);
  await expect(page.locator('.qty-chip')).toHaveText(['30', '60', '90']);
  await expect(page.locator('.qty-note')).toHaveCount(0);
  await seen.check();
});

// Decision 49: a sublingual tablet and a tablet with an outlier FDA listing open at 30 like any
// oral tablet, and the card says why under the quantity.
test('a sublingual tablet and a tablet with an outlier FDA listing open at 30, with the reason under the quantity', async ({ page }) => {
  skipIfGone('BUPRENORPHINE 8 MG TABLET SL', 'FEBUXOSTAT 40 MG TABLET');
  const seen = await open(page, PAGE);
  for (const [name, words] of [
    ['BUPRENORPHINE 8 MG TABLET SL', 'taken under the tongue'],
    ['FEBUXOSTAT 40 MG TABLET', 'looks like an error in the listing'],
  ]) {
    const dq = summary(byName.get(name)).default_quantity;
    expect([dq.qty, dq.form.oral_solid, dq.form.plain]).toEqual([30, true, false]);
    await page.goto(PAGE + hashFor(name));
    await expect(page.locator('#card-title')).toHaveText(name);
    await expect(page.locator('#qty')).toHaveValue('30');
    await expect(page.locator('.qty-chip')).toHaveText(['30', '60', '90']);
    await expect(page.locator('[data-figure="pharmacy"]')).toHaveText(expected(name, 30).pharmacy);
    await expect(page.locator('.qty-note')).toHaveText(dq.reason);
    await expect(page.locator('.qty-note')).toContainText(words);
  }
  await seen.check();
});

test('an unknown drug in the link shows a clear message, not a crash', async ({ page }) => {
  const seen = await open(page, `${PAGE}#drug=NOT%20A%20DRUG&qty=30`);
  await expect(page.locator('#card-title')).toHaveText('No drug by that name');
  await expect(page.locator('#card')).toContainText('NOT A DRUG');
  await page.goto(`${PAGE}#qty=30`);
  await expect(page.locator('#card-title')).toHaveText('That link does not name a drug');
  await seen.check();
});

// Review NUM-7, APP-1, APP-2, DOC-5: the page checks the inline data against its sha256.
test('inline data that does not match its sha256 is refused', async ({ page }, info) => {
  const zeros = pageWithData(info, 'bad-sha.html', { descriptor: (d) => ({ ...d, sha256: '0'.repeat(64) }) });
  await open(page, zeros, { ready: 'error' });
  await expect(page.locator('#card-title')).toHaveText('The data did not load');
  await expect(page.locator('#card')).toContainText('does not match its recorded checksum');
  await expect(page.locator('[data-figure]')).toHaveCount(0);
  // Same length, one price changed, the recorded sha256 left as it was.
  const tampered = pageWithData(info, 'tampered.html', {
    descriptor: (d) => {
      const raw = zlib.inflateRawSync(Buffer.from(d.data, 'base64')).toString('utf8');
      // The first price in the data, one digit changed: no particular week's price.
      const changed = Buffer.from(raw.replace(/"\d*\.\d+/, (price) => price.slice(0, -1) + (price.endsWith('9') ? '8' : '9')), 'utf8');
      expect(changed.equals(Buffer.from(raw, 'utf8'))).toBe(false);
      expect(changed.length).toBe(d.json_bytes);
      return { ...d, data: zlib.deflateRawSync(changed).toString('base64') };
    },
  });
  await page.goto(tampered);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'error');
  await expect(page.locator('#card')).toContainText('does not match its recorded checksum');
  const noFormat = pageWithData(info, 'no-format.html', { descriptor: (d) => ({ ...d, format: 'something/else' }) });
  await page.goto(noFormat);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'error');
  await expect(page.locator('#card')).toContainText('not in the format this page reads');
});

// A browser without DecompressionStream, or (Chrome/Edge 80 to 102) one whose DecompressionStream
// has no 'deflate-raw' format and throws a TypeError, gets the same plain sentence.
test('a browser that cannot inflate deflate-raw is told so plainly', async ({ page }) => {
  for (const shim of [
    () => {
      const Real = window.DecompressionStream;
      window.DecompressionStream = function DecompressionStream(format) {
        if (format === 'deflate-raw') throw new TypeError(`Failed to construct 'DecompressionStream': Unsupported compression format: '${format}'`);
        return new Real(format);
      };
    },
    () => {
      delete window.DecompressionStream;
    },
  ]) {
    const ctx = await page.context().browser().newContext();
    const p = await ctx.newPage();
    await p.addInitScript(shim);
    await p.goto(PAGE);
    await expect(p.locator('html')).toHaveAttribute('data-ready', 'error');
    await expect(p.locator('#card-title')).toHaveText('The data did not load');
    await expect(p.locator('#card')).toContainText('This browser cannot unpack the inline data');
    await expect(p.locator('[data-figure]')).toHaveCount(0);
    await ctx.close();
  }
});

// Review APP-1 (security): a hostile source_url never becomes a live link.
test('a hostile source_url in the data is never rendered as a link', async ({ page }, info) => {
  skipIfGone('ATORVASTATIN 20 MG TABLET');
  const hostile = ['javascript:window.__xss="nadac"', 'JaVaScRiPt:window.__xss=1', 'data:text/html,<script>alert(1)</script>', '//evil.example/x'];
  const url = pageWithData(info, 'hostile.html', {
    mutate: (d) => {
      let i = 0;
      for (const r of d.rows) {
        if (r.name === 'ATORVASTATIN 20 MG TABLET') r.nadac.source_url = hostile[i++ % hostile.length];
        if (r.name === withGeneric && r.generic_nadac) r.generic_nadac.source_url = 'javascript:window.__xss="generic"';
      }
    },
  });
  for (const hash of [hashFor('ATORVASTATIN 20 MG TABLET', 'abc'), hashFor('ATORVASTATIN 20 MG TABLET', ''), hashFor(withGeneric)]) {
    await page.goto(url + hash);
    await expect(page.locator('html')).toHaveAttribute('data-ready', /.+/);
    await page.evaluate(() => {
      document.querySelector('#panel').open = true;
    });
    await expect(page.locator('#panel-body li.ndc').first(), hash).toBeAttached();
    const r = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => !/^(https:\/\/|methodology\.html#|#|openbill\.html$|methodology\.html$|data\/drugs\.json$)/.test(h)));
    expect(r, hash).toEqual([]);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  }
  await expect(page.locator('#panel-body')).toContainText('This record is not valid');
});

test('no horizontal scroll, with the panel open, with search results and at 200% text', async ({ page }, info) => {
  skipIfGone('ABILIFY ASIMTUFII 720 MG/2.4 ML');
  await open(page, PAGE + hashFor('ABILIFY ASIMTUFII 720 MG/2.4 ML'));
  const noScroll = async (what) => {
    const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(sw, `${what}: scrollWidth ${sw} > clientWidth ${cw}`).toBeLessThanOrEqual(cw);
  };
  await noScroll('Part B card');
  await openPanel(page);
  await noScroll('panel open');
  await page.locator('#q').fill('insulin');
  await expect(page.locator('#results button.result').first()).toBeVisible();
  await noScroll('search results');
  await page.goto(PAGE + hashFor(DEFAULT, DEFAULT_QTY, '12.00'));
  await expect(page.locator('.paid-sentence')).toBeVisible();
  await openPanel(page);
  await noScroll('default card with what you paid, panel open');
  // Review A11Y-3: at 200% text the state chip wraps below the multiple instead of overflowing.
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await noScroll(`default card at 200% text (${info.project.name})`);
  await page.goto(PAGE + hashFor(extreme, 60));
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await noScroll('extreme card at 200% text');
});

test('every button, link, summary and input in the card and search is at least 44×44 CSS px', async ({ page }) => {
  await open(page, PAGE + hashFor(partB));
  await openPanel(page);
  await page.locator('#q').fill('granisetron');
  await expect(page.locator('#results button.result').first()).toBeVisible();
  const small = await page.evaluate(() => {
    const els = document.querySelectorAll('#card button, #card a, #card input, #card summary, .search button, .search input, .search a');
    const out = [];
    let n = 0;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      n++;
      if (r.width < 44 - 0.01 || r.height < 44 - 0.01) out.push(`${el.tagName}.${el.className} "${(el.textContent || el.value || '').trim().slice(0, 30)}" ${r.width.toFixed(1)}×${r.height.toFixed(1)}`);
    }
    return { n, out };
  });
  expect(small.n).toBeGreaterThan(10);
  expect(small.out).toEqual([]);
});

// Review DES-4: the Source link keeps its 44px target without sitting below its label.
test('in the panel, each record’s Source link is level with its label', async ({ page }) => {
  await open(page, PAGE);
  await openPanel(page);
  const gap = await page.evaluate(() => {
    const dd = [...document.querySelectorAll('#panel-body .rec dd')].find((d) => d.querySelector('a'));
    const dt = dd.previousElementSibling;
    const text = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getClientRects()[0].bottom;
    };
    return Math.abs(text(dt) - text(dd.querySelector('a')));
  });
  expect(gap).toBeLessThanOrEqual(4);
});

test('inputs use at least 16px text', async ({ page }) => {
  await open(page, PAGE);
  for (const sel of ['#q', '#qty', '#paid']) {
    const px = await page.locator(sel).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(px, sel).toBeGreaterThanOrEqual(16);
  }
});

// Review A11Y-3: the home link's accessible name includes its visible text.
test('the masthead link’s accessible name includes its visible words', async ({ page }) => {
  await open(page, PAGE);
  const stamp = page.locator('a.stamp');
  const visible = (await stamp.innerText()).replace(/\s+/g, ' ').trim().toLowerCase();
  const label = (await stamp.getAttribute('aria-label')).toLowerCase();
  expect(label).toContain(visible);
});

test('the colour scheme uses the matching tokens; the accent is only on the spread', async ({ page }, info) => {
  await open(page, PAGE);
  const dark = info.project.use.colorScheme === 'dark';
  const got = await page.evaluate(() => ({
    bg: getComputedStyle(document.body).backgroundColor,
    paper: getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    spread: getComputedStyle(document.querySelector('.multiple')).color,
    others: [...document.querySelectorAll('body *')].filter((el) => !el.closest('.multiple') && getComputedStyle(el).color === getComputedStyle(document.querySelector('.multiple')).color).length,
  }));
  expect(got.paper).toBe(dark ? '#121211' : '#fbfaf6');
  expect(got.bg).toBe(dark ? 'rgb(18, 18, 17)' : 'rgb(251, 250, 246)');
  expect(got.accent).toBe(dark ? '#ff8b7b' : '#b3261e');
  expect(got.spread).toBe(dark ? 'rgb(255, 139, 123)' : 'rgb(179, 38, 30)');
  expect(got.others).toBe(0);
});

test('methodology.html loads offline with an anchor for every rule', async ({ page }) => {
  const seen = await open(page, METHODOLOGY);
  await expect(page.locator('h1')).toBeVisible();
  for (const r of RULES) await expect(page.locator(`[id="${r.id}"]`), `#${r.id}`).toHaveCount(1);
  await expect(page.locator('body')).toContainText(EXTREME_HEADLINE);
  // Stand-alone links (the contents list, links alone in a table cell, the header and footer) are
  // controls and get 44×44 CSS px; links inside a sentence are text, as WCAG 2.5.8 treats them.
  const small = await page.evaluate(() => {
    const out = [];
    let n = 0;
    for (const el of document.querySelectorAll('.toc a, .doc td a, header a, footer a, button, summary, input')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      n++;
      if (r.width < 44 - 0.01 || r.height < 44 - 0.01) out.push(`${el.tagName} "${el.textContent.trim().slice(0, 30)}" ${r.width.toFixed(1)}×${r.height.toFixed(1)}`);
    }
    return { n, out };
  });
  expect(small.n).toBeGreaterThan(10);
  expect(small.out).toEqual([]);
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
  await seen.check();
});

// ---------------------------------------------------------------------------------------------
// Phase 2 (docs/ARCHITECTURE.md): the cost-plus estimate, "What were you charged?" and the page link.

test('the cost-plus line shows the core’s estimate, its chip, formula, explanation and source line; its record is in the panel', async ({ page }) => {
  const seen = await open(page, PAGE);
  const e = expected(DEFAULT, DEFAULT_QTY);
  const cp = e.s.cost_plus;
  const n = e.s.nadac.min;
  const block = page.locator('.costplus');
  await expect(block.locator('.cp-label')).toHaveText('Cost-plus estimate');
  await expect(block.locator('[data-figure="cost-plus"]')).toHaveText(e.costPlus);
  expect(cp.min.state).toBe('estimated');
  await expect(block.locator('.chip')).toHaveText('estimated');
  await expect(block.locator('.cp-formula')).toHaveText(e.costPlusFormula);
  expect(e.costPlusFormula).toBe(`${e.pharmacy} (NADAC) × 1.15 + $5.00 fee`);
  await expect(page.locator('.fig-pharmacy .arith')).toContainText(`${DEFAULT_QTY} × ${formatUnitPrice(n.value)}`);
  await expect(block.locator('.cp-what')).toHaveText('What a pharmacy that paid NADAC and charged cost + 15% + a $5.00 fee would charge; not a price anyone quoted.');
  await expect(block.locator('.prov')).toHaveText(`OpenBill calculation from NADAC eff. ${n.effective_date} (file of ${n.as_of_date})`);
  // Owner decision 2026-10-18: never a "cash price", and no spread against the estimate.
  await expect(page.locator('#card')).not.toContainText(/cash price/i);
  await expect(page.locator('.spread')).not.toContainText(/cost-plus/i);
  await openPanel(page);
  const body = page.locator('#panel-body');
  await expect(body.locator('.rec-title', { hasText: 'Cost-plus estimate: pack total' })).toHaveCount(1);
  await expect(body).toContainText(cp.min.reason);
  await expect(body.locator(`ul.rules a[href="${SITE_URL}methodology.html#cost-plus"]`)).toHaveCount(1);
  await expect(body.locator(`a[href="${SITE_URL}methodology.html#cost-plus"]`).first()).toBeVisible();
  // The quantity changes the estimate with the pack.
  await page.locator('.qty-chip[data-qty="90"]').click();
  await expect(page.locator('[data-figure="cost-plus"]')).toHaveText(expected(DEFAULT, 90).costPlus);
  await expect(page.locator('.cp-formula')).toHaveText(expected(DEFAULT, 90).costPlusFormula);
  await seen.check();
});

test('the cost-plus estimate is a range when NADAC varies, and "we don’t know yet" without a quantity', async ({ page }) => {
  await open(page, PAGE + hashFor(costPlusRange, 30));
  const e = expected(costPlusRange, 30);
  expect(e.costPlus).toContain(' – ');
  await expect(page.locator('[data-figure="cost-plus"]')).toHaveText(e.costPlus);
  await expect(page.locator('.cp-formula')).toHaveText(e.costPlusFormula);
  await expect(page.locator('.cp-formula')).toContainText(' to ');
  await page.locator('#qty').fill('');
  await expect(page.locator('.costplus')).toContainText(/we don.t know yet/i);
  await expect(page.locator('.costplus .why')).toHaveText('No quantity entered.');
  await expect(page.locator('[data-figure="cost-plus"]')).toHaveCount(0);
});

test('What were you charged?: a valid amount shows the core’s sentence and multiples as "your number", mirrored in the address, never sent', async ({ page }) => {
  const seen = await open(page, PAGE);
  const input = page.getByRole('textbox', { name: 'What were you charged?' });
  await expect(input).toHaveAttribute('id', 'paid');
  await expect(input).toHaveAttribute('autocomplete', 'off');
  await expect(input).toHaveValue('');
  await expect(page.locator('#paid-result')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('.paid-hint')).toContainText('OpenBill never sends or saves it');
  await expect(page.locator('.paid-hint')).toContainText('your browser’s history keeps it');
  const s = expected(DEFAULT, DEFAULT_QTY).s;
  await input.fill('12');
  const r = paidComparison('12', s.pack, s.cost_plus);
  expect(r.valid).toBe(true);
  await expect(page.locator('.paid-sentence')).toHaveText(r.sentence);
  await expect(page.locator('[data-figure="paid-pharmacy"]')).toHaveText(multiples(r.vs_pharmacy));
  await expect(page.locator('[data-figure="paid-cost-plus"]')).toHaveText(multiples(r.vs_cost_plus));
  await expect(page.locator('.paid-list .chip-yours')).toHaveText(['your number', 'your number']);
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await expect.poll(async () => (await hashParams(page)).get('paid')).toBe('12.00');
  expect((await hashParams(page)).get('drug')).toBe(DEFAULT);
  // A new quantity is a new pack: the comparison follows it and the address keeps both.
  await page.locator('.qty-chip[data-qty="60"]').click();
  const s60 = expected(DEFAULT, 60).s;
  await expect(page.locator('.paid-sentence')).toHaveText(paidComparison('12', s60.pack, s60.cost_plus).sentence);
  const params = await hashParams(page);
  expect([params.get('qty'), params.get('paid')]).toEqual(['60', '12.00']);
  // The reader's number goes nowhere else: not into the report link or the page link, not into storage.
  const report = new URL(await page.locator('#report').getAttribute('href'));
  expect([...report.searchParams.keys()]).not.toContain('paid');
  for (const v of report.searchParams.values()) expect(v).not.toMatch(/12\.00|your number/);
  if (await page.locator('#share').count()) expect(await page.locator('#share').getAttribute('href')).not.toMatch(/paid|#|\?/);
  const stored = await page.evaluate(() => {
    try {
      return [localStorage.length, sessionStorage.length, document.cookie];
    } catch {
      return [0, 0, ''];
    }
  });
  expect(stored).toEqual([0, 0, '']);
  // Clearing the box clears the result and the address.
  await input.fill('');
  await expect(page.locator('#paid-result')).toBeEmpty();
  await expect.poll(async () => (await hashParams(page)).has('paid')).toBe(false);
  await seen.check();
});

test('What were you charged?: an unusable amount says why, without repeating it, and shows no multiple', async ({ page }) => {
  const seen = await open(page, PAGE);
  const input = page.locator('#paid');
  const cases = ['abc', '0', '-5', '12.345', '100000.01', '<img src=x id=xss>'];
  for (const v of cases) {
    const p = parsePaid(v);
    expect(p.valid, v).toBe(false);
    await input.fill(v);
    await expect(page.locator('.paid-problem'), v).toHaveText(p.problem);
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.paid-sentence')).toHaveCount(0);
    await expect(page.locator('[data-figure^="paid-"]')).toHaveCount(0);
    await expect.poll(async () => (await hashParams(page)).has('paid'), v).toBe(false);
  }
  await expect(page.locator('#xss')).toHaveCount(0);
  await expect(page.locator('#paid-result')).not.toContainText('<img');
  // "$1,234.50" is a usable amount.
  await input.fill('$1,234.50');
  await expect(page.locator('.paid-problem')).toHaveCount(0);
  await expect(page.locator('.paid-sentence')).toBeVisible();
  await expect.poll(async () => (await hashParams(page)).get('paid')).toBe('1234.50');
  await seen.check();
});

test('What were you charged?: &paid= in the address is checked on load and round-trips', async ({ page }) => {
  const seen = await open(page, PAGE + hashFor(DEFAULT, DEFAULT_QTY, '12.5'));
  const s = expected(DEFAULT, DEFAULT_QTY).s;
  await expect(page.locator('#paid')).toHaveValue('12.50');
  await expect(page.locator('.paid-sentence')).toHaveText(paidComparison('12.5', s.pack, s.cost_plus).sentence);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#paid')).toHaveValue('12.50');
  await expect(page.locator('.paid-sentence')).toBeVisible();
  // A changed address updates the box.
  await page.evaluate((h) => {
    location.hash = h;
  }, hashFor(DEFAULT, DEFAULT_QTY, '20'));
  await expect(page.locator('#paid')).toHaveValue('20.00');
  await expect(page.locator('.paid-sentence')).toHaveText(paidComparison('20', s.pack, s.cost_plus).sentence);
  // An unusable value in a link is not used: the box stays empty, the card says why, the address drops it.
  for (const bad of ['-5', '<script>window.__xss=1</script>', '1e9', 'abc']) {
    await page.goto(PAGE + hashFor(DEFAULT, DEFAULT_QTY, bad));
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('#paid')).toHaveValue('');
    await expect(page.locator('.paid-problem')).toHaveText(`The amount in this link was not used. ${parsePaid(bad).problem}`);
    await expect(page.locator('.paid-sentence')).toHaveCount(0);
    expect((await hashParams(page)).has('paid'), bad).toBe(false);
    expect((await hashParams(page)).get('qty')).toBe(String(DEFAULT_QTY));
  }
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  // Another drug starts without the reader's number.
  await page.goto(PAGE + hashFor(DEFAULT, DEFAULT_QTY, '12'));
  await expect(page.locator('#paid')).toHaveValue('12.00');
  await page.locator('#q').fill(OTHER_QUERY);
  await page.locator('#results button.result').first().click();
  await expect(page.locator('#card-title')).not.toHaveText(DEFAULT);
  await expect(page.locator('#paid')).toHaveValue('');
  expect((await hashParams(page)).has('paid')).toBe(false);
  await seen.check();
});

test('What were you charged?: a crafted, very long &paid= in a link is refused; the card and search still work', async ({ page }) => {
  // Regression: 400,000 nines used to throw a BigInt RangeError in WebKit and Firefox, and the
  // whole card said "The data did not load" with the search box never enabled.
  const seen = await open(page, PAGE + hashFor(DEFAULT, DEFAULT_QTY, '9'.repeat(400000)));
  await expect(page.locator('#card-title')).toHaveText(DEFAULT);
  await expect(page.locator('#paid')).toHaveValue('');
  await expect(page.locator('.paid-problem')).toHaveText(`The amount in this link was not used. ${parsePaid('9'.repeat(400000)).problem}`);
  await expect(page.locator('#q')).toBeEnabled();
  expect((await hashParams(page)).has('paid')).toBe(false);
  await seen.check();
});

test('"Shareable page" links to the product’s page on the website; it loads nothing by itself', async ({ page }) => {
  const seen = await open(page, PAGE);
  const link = page.locator('#share');
  await expect(link).toHaveText('Shareable page');
  await expect(link).toHaveAttribute('href', `${SITE_URL}drug/${slugify(DEFAULT)}/`);
  expect(`${SITE_URL}drug/${slugify(DEFAULT)}/`).toBe('https://destinjones.github.io/openbill/drug/aripiprazole-10-mg-tablet/');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  // It follows the card to another product.
  await page.goto(PAGE + hashFor(METFORMIN, 60));
  await expect(page.locator('#share')).toHaveAttribute('href', `${SITE_URL}drug/${slugify(METFORMIN)}/`);
  await seen.check();
});

test('products whose names share a slug each link their own page, with the site build’s suffix', async ({ page }) => {
  test.skip(!sharedSlug, 'no two product names share a slug in this build');
  const slugs = siteSlugs(products.map((p) => p.name));
  const hrefs = [];
  const seen = await open(page, PAGE + hashFor(sharedSlug[0]));
  for (const name of sharedSlug) {
    await page.goto(PAGE + hashFor(name));
    await expect(page.locator('#card-title')).toHaveText(name);
    const want = `${SITE_URL}drug/${slugs.get(name)}/`;
    expect(want).toMatch(new RegExp(`/drug/${slugify(name)}-[0-9a-f]{8}/$`));
    await expect(page.locator('#share')).toHaveAttribute('href', want);
    hrefs.push(want);
  }
  expect(new Set(hrefs).size).toBe(sharedSlug.length);
  await expect(page.locator('#report')).toBeVisible();
  await seen.check();
});

// ---------------------------------------------------------------------------------------------
// Decision 53: what an address can do to the card, what a screen reader hears, what happens before
// and instead of the data arriving.

const OTHER = ['ELIQUIS 5 MG TABLET'].find((n) => byName.has(n)) || products.find((p) => p.name !== METFORMIN && p.name !== DEFAULT && /\s/.test(p.name)).name;
const AZ = `${SITE_URL}drugs/a/`;
// Each of these took from 5 to 25 seconds in BigInt maths, or crashed the tab, or (WebKit) put the
// engine's own "Out of memory: BigInt" on the card.
const CRAFTED_QUANTITIES = ['1e300000000', '1e999999999', '1e10000000', '0e-999999999', '0e-99999999999999', '1e-999999999', '9'.repeat(400000)];

const pageReady = (page, value = 'true') => expect(page.locator('html')).toHaveAttribute('data-ready', value, { timeout: 30_000 });

/** A full load of this address. A goto that only changes the hash would not load anything. */
async function load(page, url, value = 'true') {
  await page.goto(url);
  await page.reload();
  await pageReady(page, value);
}

/** The hash changes as it does when a link on another part of the page, or a person, changes it. */
const followHash = (page, hash) => page.evaluate((h) => { location.hash = h; }, hash);

const addressHash = (page) => new URL(page.url()).hash;

/** Records every text written to these live regions, and what the card said at that moment. */
async function recordWrites(page, ids) {
  await page.evaluate((list) => {
    window.__writes = [];
    for (const id of list) {
      const el = document.getElementById(id);
      new MutationObserver(() => window.__writes.push({ id, text: el.textContent, card: document.getElementById('card-title').textContent })).observe(el, { childList: true, subtree: true, characterData: true });
    }
  }, ids);
}

const takeWrites = (page, id) => page.evaluate((which) => window.__writes.splice(0).filter((w) => !which || w.id === which), id);

/**
 * The page over local HTTP, with everything after the search box held back until release(): a slow
 * connection, with no waiting on a clock. Gzip is not used, so each part is written when it is due.
 */
async function pageHeldBack() {
  const html = readFileSync(path.join(ROOT, 'openbill.html'));
  const cut = html.indexOf('</section>') + '</section>'.length;
  let release;
  const held = new Promise((r) => {
    release = r;
  });
  const server = http.createServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.write(html.subarray(0, cut));
    // Enough for an engine that waits for a first screenful before it draws anything.
    res.write(`<!--${' '.repeat(4096)}-->`);
    await held;
    res.end(html.subarray(cut));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    release,
    close: () => {
      release();
      server.closeAllConnections();
      server.close();
    },
  };
}

/** What the search status says while the data loads, to someone who has typed or pressed something. */
const SEARCH_WAIT = 'Search starts when the data has loaded; keep typing.';

/**
 * The data's unpacking held back until release(), with the rest of the page already there: the
 * seconds a phone spends loading, as start() sees them. held() resolves once start() is waiting.
 */
async function holdUnpack(page) {
  await page.addInitScript(() => {
    const real = Response.prototype.arrayBuffer;
    let go;
    const gate = new Promise((r) => {
      go = r;
    });
    window.__releaseUnpack = () => go();
    Response.prototype.arrayBuffer = async function arrayBuffer(...args) {
      window.__unpackHeld = true;
      await gate;
      return real.apply(this, args);
    };
  });
  return {
    held: () => page.waitForFunction(() => window.__unpackHeld === true),
    release: () => page.evaluate(() => window.__releaseUnpack()),
  };
}

/** The distances between the lines of a paragraph, from the tops of its characters. */
const lineGaps = (locator) =>
  locator.evaluate((p) => {
    const tops = new Set();
    const walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      for (let i = 0; i < n.length; i++) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 1);
        const box = r.getBoundingClientRect();
        if (box.height && n.data[i].trim()) tops.add(Math.round(box.top));
      }
    }
    const t = [...tops].sort((x, y) => x - y);
    return t.slice(1).map((x, i) => x - t[i]);
  });

/** A sentence's links are 44 px targets that leave its lines evenly spaced (BEH-11). */
async function evenLinesWithTargets(locator, label) {
  const gaps = await lineGaps(locator);
  if (gaps.length) expect(Math.max(...gaps) - Math.min(...gaps), `${label}: line gaps ${gaps}`).toBeLessThanOrEqual(1);
  for (const a of await locator.locator('a').all()) {
    const heights = await a.evaluate((el) => [...el.getClientRects()].map((r) => r.height));
    expect(Math.min(...heights), `${label}: link height`).toBeGreaterThanOrEqual(44);
  }
}

/** A real click, once any smooth scroll has finished; see openPanel(). */
async function settledClick(page, locator) {
  await scrollSettled(page);
  await locator.scrollIntoViewIfNeeded();
  await scrollSettled(page);
  await locator.click();
}

// J02, A17: the skip link's #card used to be read as a card link with no drug in it, and replaced
// the prices with "That link does not name a drug".
for (const [label, hash, name] of [
  ['the default card', '', DEFAULT],
  ['a drug card', hashFor(METFORMIN, 60), METFORMIN],
]) {
  test(`the skip link on ${label} keeps the card and lands on its title`, async ({ page, browserName }) => {
    const seen = await open(page, PAGE + hash);
    const figures = await page.locator('[data-figure]').count();
    expect(figures).toBeGreaterThan(0);
    // WebKit's Tab skips links unless the reader has asked otherwise, as Safari's does.
    if (browserName === 'webkit') await page.locator('.skip').focus();
    else await page.keyboard.press('Tab');
    await expect(page.locator('.skip')).toBeFocused();
    expect((await page.locator('.skip').boundingBox()).y, 'on the screen once focused').toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Enter');
    await expect(page.locator('#card-title')).toHaveText(name);
    await expect(page.locator('#card-title')).toBeFocused();
    await expect(page.locator('[data-figure]')).toHaveCount(figures);
    await expect(page).toHaveTitle(`${name}: OpenBill`);
    expect(addressHash(page), 'the address still names the card').toBe(hash);
    await page.reload();
    await pageReady(page);
    await expect(page.locator('#card-title')).toHaveText(name);
    await expect(page.locator('[data-figure]')).toHaveCount(figures);
    await seen.check();
  });
}

test('an address of #card opens the default card, focused on its title, and while reading goes back to the card', async ({ page }) => {
  const seen = await open(page, `${PAGE}#card`);
  await expect(page.locator('#card-title')).toHaveText(DEFAULT);
  await expect(page.locator('#card-title')).toBeFocused();
  await expect(page.locator('[data-figure]').first()).toBeVisible();
  await page.goto(PAGE + hashFor(METFORMIN, 60));
  await expect(page.locator('#card-title')).toHaveText(METFORMIN);
  await page.locator('#qty').focus();
  await followHash(page, '#card');
  await expect(page.locator('#card-title')).toBeFocused();
  await expect(page.locator('#card-title')).toHaveText(METFORMIN);
  await expect.poll(() => addressHash(page)).toBe(hashFor(METFORMIN, 60));
  await seen.check();
});

// SITE-20: a link shared with #utm_source=reddit used to open on the same error.
const NOT_ADDRESSED_TO_US = ['#main', '#top', '#foo', '#how-to', '#ndc-00093104801', '#utm_source=reddit', '#utm_source=reddit&utm_medium=social', '#fbclid=abc', '#=', '#&', '#%', '#__proto__=1'];

test('a plain fragment or someone else’s parameter opens the default card, never an error', async ({ page }) => {
  const seen = await open(page, PAGE);
  for (const fragment of NOT_ADDRESSED_TO_US) {
    await load(page, PAGE + fragment);
    await expect(page.locator('#card-title'), fragment).toHaveText(DEFAULT);
    await expect(page.locator('[data-figure]').first(), fragment).toBeVisible();
    await expect(page, fragment).toHaveTitle(`${DEFAULT}: OpenBill`);
  }
  await seen.check();
});

test('a plain fragment or someone else’s parameter arriving while a card is open leaves it, and its address, alone', async ({ page }) => {
  const hash = hashFor(METFORMIN, 60);
  const seen = await open(page, PAGE + hash);
  for (const fragment of NOT_ADDRESSED_TO_US) {
    await followHash(page, fragment);
    await expect.poll(() => addressHash(page), fragment).toBe(hash);
    await expect(page.locator('#card-title'), fragment).toHaveText(METFORMIN);
    await expect(page.locator('#qty'), fragment).toHaveValue('60');
    await expect(page.locator('[data-figure]').first(), fragment).toBeVisible();
  }
  await seen.check();
});

test('a parameter of ours with no drug in it still says so, and the tab says it too', async ({ page }) => {
  const seen = await open(page, PAGE);
  // BEH-12: a name of control characters only used to be "No drug by that name" with empty quotes.
  for (const hash of ['#drug=', '#drug=%20', '#drug=+', '#drug=%00%00', '#drug=%01%20%7F', '#qty=30', '#paid=12', '#qty=30&paid=12', '#utm_source=x&qty=30']) {
    await load(page, PAGE + hash);
    await expect(page.locator('#card-title'), hash).toHaveText('That link does not name a drug');
    await expect(page, hash).toHaveTitle('That link does not name a drug: OpenBill');
    await expect(page.locator('[data-figure]'), hash).toHaveCount(0);
  }
  // And back to a card, the title comes with it.
  await followHash(page, hashFor(METFORMIN));
  await expect(page.locator('#card-title')).toHaveText(METFORMIN);
  await expect(page).toHaveTitle(`${METFORMIN}: OpenBill`);
  await expect(page.locator('#card-title')).toBeFocused();
  await seen.check();
});

test('a name in any case, or with no drug= before it, opens its card and writes the address the page’s way', async ({ page }) => {
  const seen = await open(page, PAGE);
  const lower = METFORMIN.toLowerCase();
  for (const hash of [`#drug=${encodeURIComponent(lower)}`, `#drug=${encodeURIComponent(METFORMIN.replace(/ /g, '  '))}`, `#${encodeURIComponent(METFORMIN)}`, `#${encodeURIComponent(lower)}`, `#${lower.replace(/ /g, '+')}`]) {
    await load(page, PAGE + hash);
    await expect(page.locator('#card-title'), hash).toHaveText(METFORMIN);
    await expect(page, hash).toHaveTitle(`${METFORMIN}: OpenBill`);
    await expect.poll(() => addressHash(page), hash).toBe(hashFor(METFORMIN));
  }
  // What the link says about the quantity comes along.
  await load(page, `${PAGE}#drug=${encodeURIComponent(lower)}&qty=90`);
  await expect(page.locator('#qty')).toHaveValue('90');
  await expect.poll(() => addressHash(page)).toBe(hashFor(METFORMIN, 90));
  // BEH-12: a name with no drug= before it takes the same keys after it.
  await load(page, `${PAGE}#${encodeURIComponent(METFORMIN)}&qty=45`);
  await expect(page.locator('#card-title')).toHaveText(METFORMIN);
  await expect(page.locator('#qty')).toHaveValue('45');
  await expect(page.locator('[data-figure="pharmacy"]')).toHaveText(expected(METFORMIN, 45).pharmacy);
  await expect.poll(() => addressHash(page)).toBe(hashFor(METFORMIN, 45));
  // One word is a name only if it is a product's whole name; otherwise it is an anchor.
  const oneWord = products.find((p) => !/\s/.test(p.name) && p.name !== 'card');
  if (oneWord) {
    await load(page, `${PAGE}#${encodeURIComponent(oneWord.name.toLowerCase())}`);
    await expect(page.locator('#card-title')).toHaveText(oneWord.name);
  }
  await seen.check();
});

// OB-17: a link with a real word in it used to dead-end with an empty search box.
test('a name that is not in the file goes into the search box, with results and the reason', async ({ page }) => {
  const seen = await open(page, PAGE);
  const want = search(index, 'metformin er', { limit: 1 })[0].product.name;
  for (const hash of ['#drug=metformin%20er', '#metformin%20er', '#drug=metformin+er', '#metformin+er']) {
    await load(page, PAGE + hash);
    await expect(page.locator('#card-title'), hash).toHaveText('No drug by that name');
    await expect(page, hash).toHaveTitle('No drug by that name: OpenBill');
    await expect(page.locator('#card'), hash).toContainText('“metformin er”');
    await expect(page.locator('#card'), hash).toContainText('in the search box above');
    await expect(page.locator('#q'), hash).toHaveValue('metformin er');
    await expect(page.locator('#results button.result').first(), hash).toBeVisible();
    await expect(page.locator('#search-status'), hash).toContainText(/^No drug by that name\. .*metformin er/);
  }
  await settledClick(page, page.locator('#results button.result').first());
  await expect(page.locator('#card-title')).toHaveText(want);
  await expect(page).toHaveTitle(`${want}: OpenBill`);
  // The reason was about the link. Once a real card is open, back in the box, it is not said again
  // (BEH-05, R14): the list for the same words comes back without it.
  await settledClick(page, page.locator('#q'));
  await expect(page.locator('#search-status')).toContainText(/^(?!No drug).*metformin er/);
  // The same from the miss to the default card by the address.
  await load(page, `${PAGE}#drug=metformin%20er`);
  await followHash(page, '');
  await expect(page.locator('#card-title')).toHaveText(DEFAULT);
  await settledClick(page, page.locator('#q'));
  await expect(page.locator('#search-status')).toContainText(/^(?!No drug).*metformin er/);
  // Typing something else drops it too.
  await page.locator('#q').fill('metformin');
  await expect(page.locator('#search-status')).toContainText(/^(?!No drug).*metformin/);
  // A8: a link's unknown name never replaces what the reader is typing.
  await page.locator('#q').fill('lisin');
  await followHash(page, '#drug=metformin%20er');
  await expect(page.locator('#card-title')).toHaveText('No drug by that name');
  await expect(page.locator('#card')).toContainText('Search for it above');
  await expect(page.locator('#q')).toHaveValue('lisin');
  await seen.check();
});

test('a link to the same drug at another quantity lands on the title, but never from under someone typing', async ({ page }) => {
  const seen = await open(page, PAGE + hashFor(METFORMIN, 30));
  await page.locator('.stamp').focus();
  await followHash(page, hashFor(METFORMIN, 90));
  await expect(page.locator('#qty')).toHaveValue('90');
  await expect(page.locator('#card-title')).toBeFocused();
  await settledClick(page, page.locator('#qty'));
  await page.locator('#qty').fill('45');
  await expect.poll(() => addressHash(page)).toBe(hashFor(METFORMIN, 45));
  await expect(page.locator('#qty')).toBeFocused();
  await expect(page.locator('#qty')).toHaveValue('45');
  await seen.check();
});

// R01, BEH-06, A19 to A21: with the focus in a box, a link, Back or Forward changed the figures and
// left the box saying the old number, even after it lost the focus.
test('the quantity and paid boxes follow the address wherever the focus is, and keep the focus', async ({ page }) => {
  const seen = await open(page, PAGE + hashFor(METFORMIN, 30, '10'));
  const qty = page.locator('#qty');
  const paid = page.locator('#paid');
  const agrees = async (q, label) => {
    await expect(qty, label).toHaveValue(String(q));
    const chip = page.locator(`.qty-chip[data-qty="${q}"]`);
    if (await chip.count()) await expect(chip, label).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-figure="pharmacy"]'), label).toHaveText(expected(METFORMIN, q).pharmacy);
  };
  await qty.focus();
  await followHash(page, hashFor(METFORMIN, 90, '10'));
  await agrees(90, 'a link');
  await expect(qty).toBeFocused();
  await page.goBack();
  await agrees(30, 'Back');
  await expect(qty).toBeFocused();
  await page.goForward();
  await agrees(90, 'Forward');
  await expect(qty).toBeFocused();
  // Leaving the box changes nothing: it already says what the figures say.
  await page.locator('#card-title').focus();
  await agrees(90, 'after blur');

  const s = expected(METFORMIN, 90).s;
  await paid.focus();
  await followHash(page, hashFor(METFORMIN, 90, '99'));
  await expect(paid).toHaveValue('99.00');
  await expect(page.locator('.paid-sentence')).toHaveText(paidComparison('99', s.pack, s.cost_plus).sentence);
  await expect(paid).toBeFocused();
  await page.goBack();
  await expect(paid).toHaveValue('10.00');
  await expect(page.locator('.paid-sentence')).toHaveText(paidComparison('10', s.pack, s.cost_plus).sentence);
  await expect(paid).toBeFocused();
  await seen.check();
});

// Decision 50 keeps location.replace for a browser whose replaceState throws. There the reader's own
// typing comes back through hashchange, and must find the box as they left it.
test('where replaceState fails, what the reader types in the boxes is left as typed', async ({ page }) => {
  await page.addInitScript(() => {
    History.prototype.replaceState = function replaceState() {
      throw new DOMException('Blocked', 'SecurityError');
    };
  });
  const seen = await open(page, PAGE + hashFor(METFORMIN, 30));
  const qty = page.locator('#qty');
  const why = page.locator('#qty-why');
  await qty.fill('1.50');
  await expect.poll(async () => (await hashParams(page)).get('qty')).toBe('1.50');
  await page.waitForTimeout(100);
  await expect(qty).toHaveValue('1.50');
  await expect(qty).toBeFocused();
  // Emptied: the address has no quantity, and the box is not filled again with the default.
  await qty.fill('');
  await expect.poll(async () => (await hashParams(page)).has('qty')).toBe(false);
  await page.waitForTimeout(100);
  await expect(qty).toHaveValue('');
  await expect(why).toContainText('No quantity entered');
  // Not a number: said as such, though the box reports it as empty.
  await qty.pressSequentially('1e');
  await expect(why).toContainText('not a number');
  await expect(qty).toHaveAttribute('aria-invalid', 'true');
  await expect(qty).toBeFocused();
  await page.locator('#paid').fill('12.5');
  await expect.poll(async () => (await hashParams(page)).get('paid')).toBe('12.50');
  await page.waitForTimeout(100);
  await expect(page.locator('#paid')).toHaveValue('12.5');
  await expect(page.locator('#paid')).toBeFocused();
  await seen.check();
});

// R15, A18: a same-drug link kept the card as it was, so a dropped NDC's note came or went with the
// wrong link.
test('a same-drug link with a wrong NDC says so, and a clean link takes the note away', async ({ page }) => {
  const other = byName.get(DEFAULT).rows[0];
  const seen = await open(page, PAGE + hashFor(METFORMIN, 30));
  const note = page.locator('#your-ndc');
  await expect(note).toHaveCount(0);
  await followHash(page, `${hashFor(METFORMIN, 30)}&ndc=${other.ndc}`);
  await expect(note).toHaveText(`NDC ${formatNdc(other.ndc)} in this link is not a package of this drug, so it was left out.`);
  await expect.poll(() => addressHash(page)).toBe(hashFor(METFORMIN, 30));
  await followHash(page, hashFor(METFORMIN, 90));
  await expect(page.locator('#qty')).toHaveValue('90');
  await expect(note).toHaveCount(0);
  await seen.check();
});

// R16, A66, A67: an anchor over a message left itself in the address, or put back the card before
// the message, so a reload opened something else.
test('a plain fragment over a message keeps the message’s address, so a reload opens the same thing', async ({ page }) => {
  const seen = await open(page, PAGE + hashFor(METFORMIN, 60));
  for (const [hash, title] of [
    ['#drug=nothing%20here', 'No drug by that name'],
    ['#qty=30', 'That link does not name a drug'],
  ]) {
    await followHash(page, hashFor(METFORMIN, 60));
    await expect(page.locator('#card-title'), hash).toHaveText(METFORMIN);
    await followHash(page, hash);
    await expect(page.locator('#card-title'), hash).toHaveText(title);
    await followHash(page, '#utm_source=x');
    await expect.poll(() => addressHash(page), hash).toBe(hash);
    await expect(page.locator('#card-title'), hash).toHaveText(title);
    await page.reload();
    await pageReady(page);
    await expect(page.locator('#card-title'), hash).toHaveText(title);
  }
  await seen.check();
});

// A17: a fixed offset left the bottom of the link over the masthead at a large default font size.
test('the skip link stays off the page until focused, at a large font size', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const seen = await open(page, PAGE);
  const r = await page.evaluate(() => {
    document.documentElement.style.fontSize = '32px';
    document.body.style.fontSize = '32px';
    const skip = document.querySelector('.skip');
    skip.style.fontSize = '32px';
    const box = skip.getBoundingClientRect();
    const stamp = document.querySelector('.stamp').getBoundingClientRect();
    return { bottom: box.bottom, height: box.height, hit: document.elementFromPoint(stamp.left + 4, stamp.top + 2).className };
  });
  expect(r.height).toBeGreaterThan(44);
  expect(r.bottom).toBeLessThanOrEqual(0);
  expect(r.hit).not.toBe('skip');
  await seen.check();
});

// A11: the status region's last words used to stay, and be read out, over the next drug's card.
test('a screen reader never hears the last drug’s prices over the new card', async ({ page }) => {
  const seen = await open(page, PAGE + hashFor(METFORMIN, 30));
  const status = page.locator('#card-status');
  await recordWrites(page, ['card-status']);
  const namesTheCardOrNothing = async (when) => {
    const text = await status.textContent();
    expect(text === '' || text.includes(OTHER), `${when}: "${text}"`).toBe(true);
  };

  // Still queued when the next card opens.
  await page.locator('#qty').fill('45');
  await followHash(page, hashFor(OTHER));
  await expect(page.locator('#card-title')).toHaveText(OTHER);
  await namesTheCardOrNothing('straight away');
  await page.waitForTimeout(900);
  await namesTheCardOrNothing('after the pause');

  // Already said when the next card opens.
  await followHash(page, hashFor(METFORMIN, 30));
  await expect(page.locator('#card-title')).toHaveText(METFORMIN);
  await page.locator('#qty').fill('45');
  await expect(status).toHaveText(new RegExp(`^${METFORMIN}\\. At 45 `));
  await followHash(page, hashFor(OTHER));
  await expect(page.locator('#card-title')).toHaveText(OTHER);
  await namesTheCardOrNothing('straight away, once said');
  await expect(status).toHaveText('');

  // A card with no prices must not keep them either.
  await followHash(page, hashFor(METFORMIN, 30));
  await page.locator('#qty').fill('45');
  await followHash(page, '#drug=NOT%20A%20DRUG');
  await expect(page.locator('#card-title')).toHaveText('No drug by that name');
  await expect(status).toHaveText('');
  await page.waitForTimeout(900);
  await expect(status).toHaveText('');

  for (const w of await takeWrites(page, 'card-status')) {
    if (w.text) expect(w.text.startsWith(`${w.card}.`), `"${w.text}" written over "${w.card}"`).toBe(true);
  }
  await seen.check();
});

// A13: three writes to the paid result and one to the status for one typed quantity, and two more
// for pressing the chip that was already pressed. Each write is one more announcement.
test('the live regions are written once per change, and not at all when nothing changed', async ({ page }) => {
  const seen = await open(page, PAGE + hashFor(DEFAULT, 30, '50'));
  await recordWrites(page, ['card-status', 'paid-result']);
  // Three keystrokes well inside the pause. On the page's own clock, so that a busy test machine
  // cannot stretch them past the pause and count as three pauses.
  await page.evaluate(async () => {
    const q = document.getElementById('qty');
    q.focus();
    for (const v of ['1', '12', '120']) {
      q.value = v;
      q.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
    }
  });
  await expect(page.locator('#card-status')).toHaveText(new RegExp(`^${DEFAULT}\\. At 120 `));
  await page.waitForTimeout(100);
  const typed = await takeWrites(page);
  expect(typed.filter((w) => w.id === 'card-status').length, 'status writes').toBe(1);
  expect(typed.filter((w) => w.id === 'paid-result').length, 'paid result writes').toBe(1);
  await expect(page.locator('#paid-result')).not.toHaveAttribute('aria-busy', 'true');

  await settledClick(page, page.locator('.qty-chip[data-qty="30"]'));
  await expect(page.locator('#card-status')).toHaveText(new RegExp(`^${DEFAULT}\\. At 30 `));
  await page.waitForTimeout(100);
  await takeWrites(page);
  await settledClick(page, page.locator('.qty-chip[data-qty="30"]'));
  await page.waitForTimeout(800);
  expect(await takeWrites(page), 'the same chip again').toEqual([]);
  await seen.check();
});

// A9: the reason was on the card, and neither the field nor the status said so.
test('an unusable quantity is tied to its field and said in the status; both clear once it is usable', async ({ page }) => {
  const seen = await open(page, PAGE + hashFor(METFORMIN, 30));
  const qty = page.locator('#qty');
  const why = page.locator('#qty-why');
  const status = page.locator('#card-status');
  await expect(qty).not.toHaveAttribute('aria-invalid', /.*/);
  await expect(qty).not.toHaveAttribute('aria-describedby', /.*/);
  const saysWhy = async (bad) => {
    await expect(qty, bad).toHaveAttribute('aria-invalid', 'true');
    await expect(qty, bad).toHaveAttribute('aria-describedby', 'qty-why');
    await expect(why, bad).toContainText('is not usable');
    const reason = await why.textContent();
    await expect(status, bad).toContainText(`${METFORMIN}. ${reason}`);
  };
  for (const bad of ['0', '-3', '12000']) {
    await qty.fill(bad);
    await saysWhy(bad);
  }
  // A number box cannot be typed into with letters, but a link can carry them.
  await followHash(page, hashFor(METFORMIN, 'abc'));
  await saysWhy('abc');
  await qty.fill('60');
  await expect(qty).not.toHaveAttribute('aria-invalid', /.*/);
  await expect(qty).not.toHaveAttribute('aria-describedby', /.*/);
  await expect(why).toHaveCount(0);
  await expect(status).toHaveText(new RegExp(`^${METFORMIN}\\. At 60 `));
  // An empty box is not a mistake, and the card still says why it shows no total.
  await qty.fill('');
  await expect(qty).toHaveAttribute('aria-describedby', 'qty-why');
  await expect(qty).not.toHaveAttribute('aria-invalid', /.*/);
  await expect(why).toContainText('No quantity entered');
  // BEH-10: a number box holding what is not a number reports it as empty. It is a mistake, and
  // said as one, in words that do not repeat the page's own stand-in for it.
  await qty.pressSequentially('1e');
  await expect(qty).toHaveAttribute('aria-invalid', 'true');
  await expect(why).toContainText('not a number');
  await expect(why).not.toContainText('unreadable');
  await expect(status).toContainText(`${METFORMIN}. ${await why.textContent()}`);
  await expect.poll(async () => (await hashParams(page)).has('qty')).toBe(false);
  // A link's "5." is 5, and the box says so.
  await followHash(page, hashFor(METFORMIN, '5.'));
  await expect(qty).toHaveValue('5');
  await expect(qty).not.toHaveAttribute('aria-invalid', /.*/);
  await load(page, PAGE + hashFor(METFORMIN, '5.'));
  await expect(qty).toHaveValue('5');
  await expect(page.locator('[data-figure="pharmacy"]')).toHaveText(expected(METFORMIN, 5).pharmacy);
  await seen.check();
});

// A7: nothing told a screen reader when a wait of seconds ended, either way.
test('the page says when it is ready', async ({ page }) => {
  const seen = await open(page, PAGE + hashFor(METFORMIN));
  await expect(page.locator('#card-status')).toHaveText(`${METFORMIN}. Search is ready.`);
  await expect(page.locator('#card')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#card')).not.toHaveClass(/card-pending/);
  await seen.check();
});

// A6, A7, A17: the engine's words on the card, dead controls, nothing announced, and a title that
// went on saying the page was fine.
test('when the data cannot load: a plain sentence, announced, no dead controls, and a way to the plain pages', async ({ page }, info) => {
  for (const [file, descriptor, said] of [
    ['bad-base64.html', (d) => ({ ...d, data: '$$$$' }), 'could not be read, so it may be damaged'],
    ['bad-json.html', (d) => ({ ...d, data: 'AAAA' }), 'could not be read, so it may be damaged'],
    ['bad-sum.html', (d) => ({ ...d, sha256: '0'.repeat(64) }), 'does not match its recorded checksum'],
  ]) {
    await page.goto(pageWithData(info, file, { descriptor }));
    await pageReady(page, 'error');
    await expect(page.locator('#card-title'), file).toHaveText('The data did not load');
    await expect(page, file).toHaveTitle('The data did not load: OpenBill');
    await expect(page.locator('#card-title'), file).toBeFocused();
    const message = page.locator('#card [role="alert"]');
    await expect(message, file).toContainText(said);
    await expect(message, file).toContainText('No figures are shown rather than wrong ones.');
    await expect(message, file).not.toContainText(/atob|InvalidCharacter|DOMException|TypeError|RangeError|SyntaxError|decod/i);
    await expect(page.locator('[data-figure]'), file).toHaveCount(0);
    await expect(page.locator('#card')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.search'), file).toBeHidden();
    await expect(page.locator('.try'), file).toBeHidden();
    await expect(message.locator(`a[href="${AZ}"]`), file).toBeVisible();
    await expect(message.locator('a', { hasText: 'report this' }), file).toHaveAttribute('href', new RegExp(`^${REPO_URL}/issues/new\\?template=bug\\.yml`));
    await evenLinesWithTargets(message.locator('p').last(), file);
  }
});

// BEH-09: the Try links go with the data, and the focus on one went with them, to <body>.
test('a Try link focused while the data unpacks hands the focus to the message when the data fails', async ({ page }, info) => {
  const hold = await holdUnpack(page);
  await page.goto(pageWithData(info, 'bad-sum-held.html', { descriptor: (d) => ({ ...d, sha256: '0'.repeat(64) }) }));
  await hold.held();
  await page.locator('.try-list a').first().focus();
  await hold.release();
  await pageReady(page, 'error');
  const title = page.locator('#card-title');
  await expect(title).toHaveText('The data did not load');
  await expect(title).toBeFocused();
  await scrollSettled(page);
  await expect(title).toBeInViewport();
});

// OB-11, A18: core checks are in tests/money.test.js; these are the same links in a real page.
test('a crafted quantity in a link is refused at once, in plain words, and the card still works', async ({ page }) => {
  const seen = await open(page, PAGE + hashFor(METFORMIN, 30));
  for (const crafted of CRAFTED_QUANTITIES) {
    const label = crafted.slice(0, 24);
    const t = Date.now();
    await followHash(page, hashFor(METFORMIN, crafted));
    await expect(page.locator('#qty-why'), label).toContainText('is not usable');
    const took = Date.now() - t;
    expect(took, `${label} took ${took} ms`).toBeLessThan(3000);
    const shown = await page.locator('#qty-why').textContent();
    expect(shown.length, `${label}: ${shown.length} characters`).toBeLessThanOrEqual(200);
    await expect(page.locator('#card'), label).not.toContainText(/BigInt|Out of memory|Maximum|RangeError/);
    const height = (await page.locator('#card').boundingBox()).height;
    expect(height, label).toBeLessThan(2500);
    expect((await page.locator('#qty').inputValue()).length, label).toBeLessThanOrEqual(32);
  }
  // The same links opened from nothing.
  for (const crafted of ['1e300000000', '0e-99999999999999']) {
    await load(page, PAGE + hashFor(METFORMIN, crafted));
    await expect(page.locator('#card-title')).toHaveText(METFORMIN);
    await expect(page.locator('#qty-why')).toContainText('is not usable');
    await expect(page.locator('#qty')).toHaveAttribute('aria-invalid', 'true');
  }
  await settledClick(page, page.locator('.qty-chip').first());
  await expect(page.locator('#qty-why')).toHaveCount(0);
  await expect(page.locator('[data-figure]').first()).toBeVisible();
  await seen.check();
});

test('a very long name in a link stays bounded on the screen and in the search box', async ({ page }) => {
  const seen = await open(page, PAGE);
  await expect(page.locator('#q')).toHaveAttribute('maxlength', '200');
  for (const hash of [`#drug=${'A'.repeat(100000)}`, `#${'metformin '.repeat(10000).replace(/ /g, '%20')}`]) {
    const label = hash.slice(0, 20);
    await load(page, PAGE + hash);
    await expect(page.locator('#card-title'), label).toHaveText('No drug by that name');
    const r = await page.evaluate(() => ({
      card: document.getElementById('card').getBoundingClientRect().height,
      cardText: document.getElementById('card').textContent.length,
      q: document.getElementById('q').value.length,
      search: document.getElementById('search-status').textContent.length,
      wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    expect(r.card, label).toBeLessThan(1000);
    expect(r.cardText, label).toBeLessThan(600);
    expect(r.q, label).toBeLessThanOrEqual(200);
    expect(r.search, label).toBeLessThan(400);
    expect(r.wide, label).toBeLessThanOrEqual(0);
    // A10, A80: what is said back is clipText()'s cut of the name, not the name.
    const { drug } = parseHash(hash);
    expect(drug.length, label).toBeGreaterThan(clipText(drug).length);
    await expect(page.locator('#card'), label).toContainText(`“${clipText(drug)}”`);
    await expect(page.locator('#q'), label).toHaveValue(drug);
    await expect(page.locator('#search-status'), label).toContainText(`“${clipText(drug.trim())}”`);
  }
  await seen.check();
});

// A5: the box was disabled until the data had unpacked, which on a phone is seconds of tapping on
// nothing, and what was typed before the script ran was lost.
test('typing before the page has loaded keeps the text, and shows results when it has', async ({ page, browserName }) => {
  const held = await pageHeldBack();
  try {
    await page.goto(held.url, { waitUntil: 'commit' });
    const q = page.locator('#q');
    await q.waitFor({ state: 'attached' });
    await expect(q).toBeEnabled();
    await expect(q).toHaveAttribute('placeholder', /Search starts/);
    // WebKit holds its first paint back until more of the page has arrived, so Playwright's check
    // that the box has stopped moving, which waits on a frame, would never finish there.
    if (browserName === 'chromium') await q.click();
    else await q.focus();
    await page.keyboard.type('metformin');
    await expect(q).toHaveValue('metformin');
    held.release();
    await pageReady(page);
    await expect(q).toHaveValue('metformin');
    await expect(q).toBeFocused();
    // A63: the wait the placeholder spoke of is over.
    await expect(q).not.toHaveAttribute('placeholder', /.*/);
    await expect(page.locator('#results button.result').first()).toContainText(/metformin/i);
    await expect(page.locator('#search-status')).toContainText('metformin');
    await expect(page.locator('#card-title')).toHaveText(DEFAULT);
  } finally {
    held.close();
  }
});

test('Enter pressed while the data is unpacking opens an exact name once it has', async ({ page }) => {
  // Between this script's first task and the index being built, as a fast typist on a phone is.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const q = document.getElementById('q');
      q.focus();
      q.value = 'metformin hcl 500 mg tablet';
      window.__saidWhileWaiting = document.getElementById('search-status').textContent;
      q.dispatchEvent(new Event('input', { bubbles: true }));
      q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      window.__said = document.getElementById('search-status').textContent;
    });
  });
  await page.goto(PAGE);
  await pageReady(page);
  expect(await page.evaluate(() => window.__said)).toBe('Search starts when the data has loaded; keep typing.');
  await expect(page.locator('#card-title')).toHaveText(METFORMIN);
});

// BEH-03: Enter waiting for the index used to be acted on whatever the reader did next.
for (const [label, typed, after, focused] of [
  ['moves to a Try link', 'metformin hcl 500 mg tablet', (page) => page.locator('.try-list a').first().focus(), '.try-list a >> nth=0'],
  ['presses Escape', 'metformin hcl 500 mg tablet', (page) => page.keyboard.press('Escape'), '#q'],
  ['keeps typing', 'metformin', (page) => page.keyboard.type(' hcl 500 mg tablet'), '#q'],
]) {
  test(`Enter pressed while the data is unpacking is taken back when the reader ${label}`, async ({ page }) => {
    const hold = await holdUnpack(page);
    await page.goto(PAGE);
    await hold.held();
    const q = page.locator('#q');
    await q.focus();
    await page.keyboard.type(typed);
    await page.keyboard.press('Enter');
    await after(page);
    await hold.release();
    await pageReady(page);
    await expect(page.locator('#card-title')).toHaveText(DEFAULT);
    await expect(page.locator(focused)).toBeFocused();
    expect(addressHash(page)).toBe('');
    const results = page.locator('#results button.result');
    if (label === 'keeps typing') {
      await expect(results.first()).toBeVisible();
      return;
    }
    // Nor does a list open where the reader is not, or after Escape; coming back to the box brings it.
    await page.waitForTimeout(100);
    await expect(results).toHaveCount(0);
    if (label === 'moves to a Try link') {
      await q.focus();
      await expect(results.first()).toBeVisible();
      await expect(page.locator('#card-title')).toHaveText(DEFAULT);
    }
  });
}

test('Enter in the empty box while the data unpacks is not kept for a link’s unknown name filled in after', async ({ page }) => {
  const name = 'metformin hcl 500 mg tablets';
  // The search would open its one exact match for those words; the reader never typed them.
  expect(enterChoice(search(index, name)).product.name).toBe(METFORMIN);
  const hold = await holdUnpack(page);
  await page.goto(`${PAGE}#drug=${encodeURIComponent(name)}`);
  await hold.held();
  await page.locator('#q').focus();
  await page.keyboard.press('Enter');
  await hold.release();
  await pageReady(page);
  await expect(page.locator('#card-title')).toHaveText('No drug by that name');
  await expect(page.locator('#q')).toHaveValue(name);
  await expect(page.locator('#q')).toBeFocused();
  await expect(page.locator('#results button.result').first()).toBeVisible();
  expect(addressHash(page)).toBe(`#drug=${encodeURIComponent(name)}`);
});

// BEH-02, R04, A40: the skip link and the loading line's link work while the data unpacks, and the
// card that replaces the placeholder used to drop their focus on <body>.
for (const [label, go] of [
  [
    'the skip link',
    async (page, browserName) => {
      // WebKit's Tab skips links unless the reader has asked otherwise, as Safari's does.
      if (browserName === 'webkit') await page.locator('.skip').focus();
      else await page.keyboard.press('Tab');
      await expect(page.locator('.skip')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('#card-title')).toBeFocused();
    },
  ],
  ['the loading line’s link', (page) => page.locator('.card-loading-script a').focus()],
]) {
  test(`${label}, used while the data unpacks, keeps the focus in the card when it arrives`, async ({ page, browserName }) => {
    const hold = await holdUnpack(page);
    await page.goto(PAGE);
    await hold.held();
    await expect(page.locator('#card')).toHaveAttribute('aria-busy', 'true');
    await go(page, browserName);
    await hold.release();
    await pageReady(page);
    await expect(page.locator('#card-title')).toHaveText(DEFAULT);
    await expect(page.locator('#card-title')).toBeFocused();
    await expect(page.locator('#card')).not.toHaveAttribute('aria-busy', 'true');
  });
}

// BEH-08: "Search is ready" was said in both live regions at once.
test('ready is said once, in the card’s status, with the focus in the search box', async ({ page }) => {
  const hold = await holdUnpack(page);
  await page.goto(PAGE);
  await hold.held();
  await page.locator('#q').focus();
  await recordWrites(page, ['card-status', 'search-status']);
  await hold.release();
  await pageReady(page);
  await expect(page.locator('#card-status')).toHaveText(`${DEFAULT}. Search is ready.`);
  await page.waitForTimeout(100);
  const ready = (await takeWrites(page)).filter((w) => w.text.includes('Search is ready'));
  expect(ready.map((w) => w.id)).toEqual(['card-status']);
  await expect(page.locator('#search-status')).toHaveText('');
});

test('a link’s unknown name found before the search index is built still gets its results, and no word about waiting', async ({ page }) => {
  // BEH-08: from the first moment, as a screen reader hears it; nothing was typed, so nothing waits.
  await page.addInitScript(() => {
    window.__searchSaid = [];
    new MutationObserver(() => {
      const el = document.getElementById('search-status');
      if (el && window.__searchSaid[window.__searchSaid.length - 1] !== el.textContent) window.__searchSaid.push(el.textContent);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.goto(`${PAGE}#drug=metformin%20er`);
  await pageReady(page);
  await expect(page.locator('#q')).toHaveValue('metformin er');
  await expect(page.locator('#results button.result').first()).toBeVisible();
  await expect(page.locator('#search-status')).toContainText(/^No drug by that name\./);
  expect(await page.evaluate(() => window.__searchSaid)).not.toContain(SEARCH_WAIT);
});

// BEH-01: Back to a card focused its title out of view. The browser restored the old scroll after
// the page had scrolled to the card, in WebKit and with reduced motion, and in Chromium its own
// smooth restoring ran on after the page's.
for (const motion of ['no-preference', 'reduce']) {
  test(`Back to a card lands on its title, in view (motion: ${motion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: motion });
    const seen = await open(page, PAGE);
    const title = page.locator('#card-title');
    const landed = async (name) => {
      await expect(title).toHaveText(name);
      await expect(title).toBeFocused();
      await scrollSettled(page);
      await expect(title).toBeInViewport();
    };
    await settledClick(page, page.locator('.try-list a', { hasText: METFORMIN }));
    await expect(title).toHaveText(METFORMIN);
    await page.goBack();
    await landed(DEFAULT);
    await page.goForward();
    await landed(METFORMIN);
    // From the foot of another card.
    await followHash(page, hashFor(OTHER));
    await expect(title).toHaveText(OTHER);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await scrollSettled(page);
    await page.goBack();
    await landed(METFORMIN);
    await seen.check();
  });
}

// A3: with scripts off, the page offered a dead search box, Try links that did nothing and a link
// to a 38 MB JSON file.
test('with JavaScript off: a heading, a plain sentence and the plain pages, with no dead controls', async ({ browser }, info) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: info.project.use.viewport, colorScheme: info.project.use.colorScheme });
  const page = await ctx.newPage();
  await page.goto(PAGE);
  await expect(page.locator('#card-title')).toBeVisible();
  await expect(page.locator('#card-title')).toHaveText('Drug prices');
  // Named directly: Playwright's text matching skips what is inside a <noscript> when asked about its parent.
  const line = page.locator('#card noscript p');
  await expect(line).toBeVisible();
  await expect(line).toContainText('JavaScript');
  await expect(line.locator(`a[href="${AZ}"]`)).toBeVisible();
  await expect(page.locator('#card')).not.toHaveAttribute('aria-busy', /.*/);
  await expect(page.locator('.card-loading-script')).toBeHidden();
  await expect(page.locator('.search')).toBeHidden();
  await expect(page.locator('.try')).toBeHidden();
  await expect(page.locator('#card a[href*="drugs.json"]')).toHaveCount(0);
  await evenLinesWithTargets(line, 'no JavaScript');
  const box = await page.locator('#card').boundingBox();
  expect(box.height, 'no room is kept for a card that is not coming').toBeLessThan(500);
  await ctx.close();
});

test('with the script blocked or unparseable, the loading line itself has the way out', async ({ page }, info) => {
  const html = readFileSync(path.join(ROOT, 'openbill.html'), 'utf8');
  const at = html.lastIndexOf('</script>');
  // One character more, so the script no longer matches its CSP hash: what a filter or an old engine
  // leaves, a page that never starts.
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), `openbill-${info.project.name}-`)), 'blocked.html');
  writeFileSync(file, `${html.slice(0, at)};${html.slice(at)}`, 'utf8');
  await page.goto(pathToFileURL(file).href);
  await expect(page.locator('#card-title')).toHaveText('Drug prices');
  await expect(page.locator('.card-loading-script')).toContainText('Loading');
  await expect(page.locator(`.card-loading-script a[href="${AZ}"]`)).toBeVisible();
  await evenLinesWithTargets(page.locator('.card-loading-script'), 'script blocked');
  await expect(page.locator('#card')).not.toHaveAttribute('aria-busy', /.*/);
  expect(await page.locator('html').getAttribute('data-ready')).toBeNull();
});

// A20: a page saved from the website, or opened alone, had a dozen links that went nowhere.
test('a saved copy, alone in a folder, has no link that needs a file beside it', async ({ page }, info) => {
  const url = pageWithData(info, 'saved.html', {});
  await page.goto(url);
  await pageReady(page);
  await openPanel(page);
  await expect(page.locator('#panel-body li.ndc').first()).toBeVisible();
  const relative = (hrefs) => hrefs.filter((h) => !/^(https:\/\/|#)/.test(h));
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')));
  expect(relative(hrefs)).toEqual([]);
  expect(hrefs.some((h) => h.startsWith(`${SITE_URL}methodology.html#`))).toBe(true);
  expect(hrefs).toContain(`${SITE_URL}methodology.html`);
  // Figures redrawn later keep to the same rule.
  await settledClick(page, page.locator('.qty-chip').last());
  await expect(page.locator('#panel-body li.ndc').first()).toBeVisible();
  expect(relative(await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))))).toEqual([]);
});

test('on the website the same links stay relative, so they follow the site that serves them', async ({ page }) => {
  const html = readFileSync(path.join(ROOT, 'openbill.html'), 'utf8');
  await page.route(`${SITE_URL}**`, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(`${SITE_URL}openbill.html`);
  await pageReady(page);
  await openPanel(page);
  const body = page.locator('#panel-body');
  await expect(body.locator('ul.rules a[href="methodology.html#spread"]')).toHaveCount(1);
  await expect(page.locator('a[href="methodology.html"]').first()).toBeAttached();
});

// A16: the stamp reloaded 1.8 MB, and a reader in a saved copy lost it altogether.
test('the stamp returns to the default card without loading the page again', async ({ page }) => {
  const seen = await open(page, PAGE + hashFor(METFORMIN, 60));
  const stamp = page.locator('.stamp');
  await expect(stamp).toHaveAttribute('href', '#');
  await page.evaluate(() => {
    window.__sameDocument = true;
  });
  await settledClick(page, stamp);
  await expect(page.locator('#card-title')).toHaveText(DEFAULT);
  await expect(page.locator('[data-figure]').first()).toBeVisible();
  await expect(page).toHaveTitle(`${DEFAULT}: OpenBill`);
  // On the default card it changes nothing.
  await settledClick(page, stamp);
  await expect(page.locator('#card-title')).toHaveText(DEFAULT);
  await expect(page.locator('[data-figure]').first()).toBeVisible();
  await followHash(page, '#drug=NOT%20A%20DRUG');
  await expect(page.locator('#card-title')).toHaveText('No drug by that name');
  await settledClick(page, stamp);
  await expect(page.locator('#card-title')).toHaveText(DEFAULT);
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  await seen.check();
});

// A15: every keystroke rebuilt the panel, which is most of the card on a product with many NDCs.
test('the panel is built when it opens, kept current while open, and left alone while closed', async ({ page }) => {
  const seen = await open(page, PAGE + hashFor(DEFAULT, 30));
  const body = page.locator('#panel-body');
  const reason = (qty) => expected(DEFAULT, qty).s.cost_plus.min.reason;
  expect(reason(90)).not.toBe(reason(60));
  await expect(body).toBeEmpty();
  await page.evaluate(() => {
    window.__panelWrites = 0;
    new MutationObserver(() => {
      window.__panelWrites += 1;
    }).observe(document.getElementById('panel-body'), { childList: true, subtree: true });
  });
  const writes = () => page.evaluate(() => window.__panelWrites);
  await settledClick(page, page.locator('.qty-chip[data-qty="90"]'));
  await expect(page.locator('#card-status')).toContainText('At 90 ');
  expect(await writes(), 'closed: not written').toBe(0);
  await expect(body).toBeEmpty();
  // Opened by a click, it shows the quantity on the card, not the one it opened with.
  await openPanel(page);
  await expect(body).toContainText(reason(90));
  await expect(body.locator('li.ndc').first()).toBeVisible();
  // While open it keeps up.
  await settledClick(page, page.locator('.qty-chip[data-qty="60"]'));
  await expect(body).toContainText(reason(60));
  // Closed, it is left alone; open again, it has caught up.
  await openPanel(page);
  await page.evaluate(() => {
    window.__panelWrites = 0;
  });
  await settledClick(page, page.locator('.qty-chip[data-qty="90"]'));
  await expect(page.locator('#card-status')).toContainText('At 90 ');
  expect(await writes(), 'closed again: not written').toBe(0);
  await openPanel(page);
  await expect(body).toContainText(reason(90));
  await seen.check();
});

test('the panel is also built when it is opened some other way, and for printing', async ({ page }) => {
  const seen = await open(page, PAGE + hashFor(DEFAULT, 30));
  const body = page.locator('#panel-body');
  await expect(body).toBeEmpty();
  await page.evaluate(() => {
    document.getElementById('panel').open = true;
  });
  await expect(body.locator('li.ndc').first()).toBeVisible();
  // A new card starts empty, and printing fills it, because print shows it open.
  await followHash(page, hashFor(METFORMIN, 30));
  await expect(page.locator('#card-title')).toHaveText(METFORMIN);
  await expect(body).toBeEmpty();
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await expect(body.locator('li.ndc').first()).toBeAttached();
  await seen.check();
});

// A8, SITE-05: the figures arriving pushed "Try" and "How to read a card" down the page. The room is
// kept for a card, so a message or the fatal state, far shorter, gives it back when it arrives: that
// moves things up, on a link that has already failed (decision 53). Neither state is checked here.
test('the card arriving does not move the page: layout shift under 0.1, at 6× CPU on slow 4G; reports timings', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile-light', 'throttling is Chromium’s, and one phone is enough; the next test has the other sizes');
  test.setTimeout(120_000);
  const gz = zlib.gzipSync(readFileSync(path.join(ROOT, 'openbill.html')), { level: 9 });
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', 'cache-control': 'no-store' });
    res.end(gz);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 562.5, downloadThroughput: 1.44e6 / 8, uploadThroughput: 675e3 / 8 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await page.addInitScript(recordLoadShifts);
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'commit' });
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 90_000 });
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => ({ cls: window.__cls, longest: window.__longest, timings: JSON.parse(document.documentElement.dataset.timings) }));
    const line = `CLS ${r.cls.toFixed(4)}; longest task ${r.longest} ms; unpack ${r.timings.unpack_ms} ms; inflate ${r.timings.inflate_ms} ms; first card ${r.timings.first_card_since_navigation_ms} ms; ready ${r.timings.since_navigation_ms} ms`;
    info.annotations.push({ type: '6x + slow 4G', description: line });
    console.log(`[6x + slow 4G] ${line}`);
    expect(r.cls).toBeLessThan(0.1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

for (const [label, hash] of [
  ['the default card', ''],
  ['a drug with no Medicare figure', hashFor(noReference)],
  ['a drug at a quantity', hashFor(METFORMIN, 90)],
]) {
  test(`the card arriving does not move the page: layout shift under 0.1 on ${label}`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'only Chromium reports layout shifts');
    await page.addInitScript(recordLoadShifts);
    await page.goto(PAGE + hash);
    await pageReady(page);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__cls)).toBeLessThan(0.1);
  });
}

/** In the page, before anything else runs: layout shifts and long tasks, as they happen. */
function recordLoadShifts() {
  window.__cls = 0;
  window.__longest = 0;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
  }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__longest = Math.max(window.__longest, Math.round(e.duration));
  }).observe({ type: 'longtask', buffered: true });
}

// ---------------------------------------------------------------------------------------------
// Decision 54: what Enter may open, when the list comes and goes, and the NDC a reader came with.

const resultButtons = (page) => page.locator('#results button.result');

/** A query with one result that Enter may open. */
const soloQuery = products
  .map((p) => p.name.split(' ').slice(0, 2).join(' ').toLowerCase())
  .find((q) => {
    const all = search(index, q, { limit: 1000 });
    return all.length === 1 && enterChoice(all) && all[0].match !== 'exact';
  });
/** The start of a word other than a name's first, where that is all the query finds. */
const partialQuery = products
  .flatMap((p) => p.name.split(' ').slice(1, 2))
  .filter((w) => /^[A-Z]{6,}$/.test(w))
  .map((w) => w.slice(0, -1).toLowerCase())
  .find((q) => {
    const all = search(index, q, { limit: 1000 });
    return all.length > 0 && all.every((r) => r.match === 'partial');
  });
/** A row whose FDA form, without its hyphens, reads as more than one product's NDC. */
const severalWays = linked.find((r) => {
  const printed = r.identity && r.identity.package_ndc;
  return printed && printed.replace(/-/g, '').length === 10 && search(index, printed.replace(/-/g, '')).length > 1;
});
const byNdcRow = new Map(linked.map((r) => [r.ndc, r]));
/** A package NADAC does not have, of a labeler and product it does. */
const missingPackage = (() => {
  for (const r of linked) {
    if (search(index, r.ndc.slice(0, 9)).length !== 1) continue;
    for (let i = 0; i < 100; i++) {
      const ndc = r.ndc.slice(0, 9) + String(i).padStart(2, '0');
      if (!byNdcRow.has(ndc)) return { ndc, name: r.name };
    }
  }
  return null;
})();
/** As missingPackage, of a product that has more than one package of that labeler's (A85). */
const missingOfSeveral = (() => {
  for (const p of products) {
    const byPrefix = new Map();
    for (const r of p.rows) byPrefix.set(r.ndc.slice(0, 9), [...(byPrefix.get(r.ndc.slice(0, 9)) || []), r]);
    for (const [prefix, rows] of byPrefix) {
      if (rows.length < 2) continue;
      for (let i = 0; i < 100; i++) {
        const ndc = prefix + String(i).padStart(2, '0');
        if (!byNdcRow.has(ndc)) return { ndc, name: p.name, more: rows.length - 1 };
      }
    }
  }
  return null;
})();
/** A product's exact name that other products' results share, so Enter alone would open it (J25). */
const exactAmongOthers = [METFORMIN, ...products.map((p) => p.name)]
  .map((n) => n.toLowerCase())
  .find((q) => {
    const all = search(index, q, { limit: 1000 });
    return all.length > 1 && enterChoice(all) === all[0];
  });
const mostNdcs = [...products].sort((a, b) => b.rows.length - a.rows.length)[0];
/** No panel at 360 px should pass this on any product; the audit found 53,961 on mostNdcs. */
const PANEL_LIMIT = 13000;

test('Enter: a list stays, one result or an exact name opens, and the same text never jumps to another card', async ({ page }) => {
  const seen = await open(page, PAGE);
  const input = page.locator('#q');
  const title = page.locator('#card-title');
  const status = page.locator('#search-status');

  await input.fill('metformin');
  await expect(resultButtons(page).first().locator('.result-name')).toHaveText(METFORMIN);
  await expect(status).toContainText('Showing the first 20');
  await input.press('Enter');
  await expect(resultButtons(page).first()).toBeFocused();
  await expect(title).toHaveText(DEFAULT);

  await input.fill(soloQuery);
  await expect(status).toContainText('Press Enter to open it.');
  await input.press('Enter');
  await expect(title).toHaveText(search(index, soloQuery)[0].product.name);

  // Its own exact name: the wording depends on whether, this week, anything else matches it too.
  await input.fill(METFORMIN.toLowerCase());
  await expect(status).toContainText(search(index, METFORMIN.toLowerCase()).length === 1 ? 'Press Enter to open it.' : `Press Enter to open ${METFORMIN}.`);
  await input.press('Enter');
  await expect(title).toHaveText(METFORMIN);

  // A partial match is labelled, and Enter leaves it for the reader.
  await input.fill(partialQuery);
  await expect(status).toContainText('partial match');
  await expect(resultButtons(page).first().locator('.result-partial')).toContainText('Partial match');
  await input.press('Enter');
  await expect(input).toBeFocused();
  await expect(title).toHaveText(METFORMIN);

  // Back in the box after a choice: the same text and Enter never replace the card (J25). The text
  // is a product's exact name that finds others too, so without the rule Enter would open it (R02).
  const all = search(index, exactAmongOthers, { limit: 1000 });
  expect(enterChoice(all), exactAmongOthers).toBe(all[0]);
  await input.fill(exactAmongOthers);
  await expect(status).toContainText(`Press Enter to open ${all[0].product.name}.`);
  const second = await resultButtons(page).nth(1).locator('.result-name').textContent();
  expect(second).not.toBe(all[0].product.name);
  await resultButtons(page).nth(1).click();
  await expect(title).toHaveText(second);
  await input.click();
  await expect(resultButtons(page).first()).toBeVisible();
  await expect(status).not.toContainText('Press Enter');
  await input.press('Enter');
  await expect(resultButtons(page).first()).toBeFocused();
  await expect(title).toHaveText(second);
  // Typing in the box again makes it a new search, and Enter opens the exact name (A45).
  await input.focus();
  await input.press('End');
  await input.press('Backspace');
  await input.press(exactAmongOthers.slice(-1));
  await expect(status).toContainText(`Press Enter to open ${all[0].product.name}.`);
  await input.press('Enter');
  await expect(title).toHaveText(all[0].product.name);
  await seen.check();
});

test('Enter does not guess a number: every reading is listed, with a note about the hyphens', async ({ page }) => {
  const seen = await open(page, PAGE);
  const input = page.locator('#q');
  const digits = severalWays.identity.package_ndc.replace(/-/g, '');
  await input.fill(digits);
  const readings = search(index, digits);
  await expect(resultButtons(page)).toHaveCount(readings.length);
  await expect(page.locator('#search-status')).toContainText('Check the hyphens on your label');
  await expect(resultButtons(page).first().locator('.result-name')).toHaveText(severalWays.name);
  await expect(resultButtons(page).first().locator('.result-ndc')).toContainText(`printed ${severalWays.identity.package_ndc} by FDA`);
  await input.press('Enter');
  await expect(input).toBeFocused();
  await expect(page.locator('#card-title')).toHaveText(DEFAULT);
  // The reader chooses, and the address keeps the reading chosen.
  await resultButtons(page).first().click();
  await expect(page.locator('#card-title')).toHaveText(severalWays.name);
  expect((await hashParams(page)).get('ndc')).toBe(severalWays.ndc);
  // With its hyphens the same number is one package, and Enter opens it.
  await input.fill(severalWays.identity.package_ndc);
  await expect(resultButtons(page)).toHaveCount(1);
  await input.press('Enter');
  await expect(page.locator('#your-ndc')).toContainText(formatNdc(severalWays.ndc));
  await seen.check();
});

test('the list comes back with the box, and leaves on an outside click, a followed link and Back', async ({ page }) => {
  const seen = await open(page, PAGE);
  const input = page.locator('#q');
  const list = resultButtons(page);
  await input.fill('metformin');
  await expect(list.first()).toBeVisible();

  // A click outside closes it; focus comes back with it; a click in the box does too.
  await page.locator('#card-title').click();
  await expect(list).toHaveCount(0);
  await expect(page.locator('#search-status')).toHaveText('');
  await input.focus();
  await expect(list.first()).toBeVisible();
  await page.locator('.search-label').click();
  await expect(list.first()).toBeVisible();
  // Escape closes it (a search box may also clear its own text, as Chromium's does).
  await input.press('Escape');
  await expect(list).toHaveCount(0);
  await input.fill('metformin');
  await expect(list.first()).toBeVisible();

  // Opening a result closes it, and the box brings the same list back (A10).
  await list.nth(1).click();
  await expect(list).toHaveCount(0);
  await expect(page.locator('#card-title')).not.toHaveText(DEFAULT);
  await input.click();
  await expect(list.first()).toBeVisible();

  // A change of address closes it, and so does Back.
  await followHash(page, hashFor(METFORMIN));
  await expect(page.locator('#card-title')).toHaveText(METFORMIN);
  await expect(list).toHaveCount(0);
  await input.focus();
  await expect(list.first()).toBeVisible();
  await page.goBack();
  await expect(list).toHaveCount(0);

  // A pending keystroke does not bring it back after the click.
  await page.evaluate(() => {
    const q = document.getElementById('q');
    q.value = 'metformin hcl';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('card-title').click();
  });
  await page.waitForTimeout(150);
  await expect(list).toHaveCount(0);
  await seen.check();
});

test('arrow keys move through the list and back to the box; typing goes to the box; Escape closes', async ({ page }) => {
  const seen = await open(page, PAGE);
  const input = page.locator('#q');
  const list = resultButtons(page);
  await input.fill('metformin');
  await expect(list.first()).toBeVisible();
  await input.press('ArrowDown');
  await expect(list.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(list.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(list.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(input).toBeFocused();
  await input.press('ArrowUp');
  await expect(list.last()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(list.last()).toBeFocused();
  await page.keyboard.press(' ');
  await expect(page.locator('#card-title')).not.toHaveText(DEFAULT);
  await input.click();
  await input.press('ArrowDown');
  await expect(list.nth(0)).toBeFocused();
  await page.keyboard.press('a');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('metformina');
  await input.fill('metformin');
  await expect(list.first()).toBeVisible();
  await input.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(input).toBeFocused();
  await expect(list).toHaveCount(0);
  // With the list closed, the arrow opens it.
  await input.press('ArrowDown');
  await expect(list.nth(0)).toBeFocused();
  await seen.check();
});

// A keystroke's search waits 60 ms. An arrow key inside that wait used to take the focus into a list
// the timer then replaced, which dropped the focus on <body>, where Escape reaches nothing.
test('an arrow key in the pause after a keystroke stays in the list, and in the list for that text', async ({ page }) => {
  const seen = await open(page, PAGE);
  const input = page.locator('#q');
  const list = resultButtons(page);
  await input.fill('metformin');
  await expect(list.first()).toBeVisible();
  // In one task, so the key is inside the pause however busy the machine is.
  const typeThenArrow = (text) =>
    page.evaluate((value) => {
      const q = document.getElementById('q');
      q.focus();
      q.value = value;
      q.dispatchEvent(new Event('input', { bubbles: true }));
      q.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    }, text);
  await typeThenArrow('metformin');
  await expect(list.nth(0)).toBeFocused();
  await page.waitForTimeout(200); // longer than the pause
  await expect(list.nth(0)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(input).toBeFocused();
  await expect(list).toHaveCount(0);
  // Other words: the arrow goes into their list, not the one still on the screen.
  await input.fill('metformin');
  await expect(list.first()).toBeVisible();
  await typeThenArrow(OTHER_QUERY);
  await expect(list.nth(0)).toHaveAttribute('data-name', search(index, OTHER_QUERY)[0].product.name);
  await expect(list.nth(0)).toBeFocused();
  await seen.check();
});

// The click after a press and a release on different elements lands on an ancestor of both, which
// used to read as a click outside: the list opened on the press and closed on the release.
test('a press that began in the box is not a click outside, wherever it ended', async ({ page }) => {
  const seen = await open(page, PAGE);
  const input = page.locator('#q');
  const list = resultButtons(page);
  await input.fill('metformin');
  await expect(list.first()).toBeVisible();
  const spot = await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    const r = document.querySelector('.search').getBoundingClientRect();
    const out = { x: r.x + 40, y: r.y - 6 };
    return { ...out, outside: !document.elementFromPoint(out.x, out.y).closest('.search') };
  });
  expect(spot.outside).toBe(true);
  const box = await input.boundingBox();
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await expect(input).toBeFocused();
  await page.mouse.move(spot.x, spot.y);
  await page.mouse.up();
  await page.waitForTimeout(100);
  await expect(list.first()).toBeVisible();
  // A press outside still closes it, and so does a click with no press, as a key on a link makes.
  await page.locator('#card-title').click();
  await expect(list).toHaveCount(0);
  await input.click();
  await expect(list.first()).toBeVisible();
  await page.evaluate(() => document.getElementById('card-title').click());
  await expect(list).toHaveCount(0);
  await seen.check();
});

test('an entered NDC stays with the card: named above the figures, in the address, across a reload', async ({ page }) => {
  const seen = await open(page, PAGE);
  const row = byName.get(METFORMIN).rows.find((r) => r.identity);
  const input = page.locator('#q');
  await input.fill(formatNdc(row.ndc));
  await expect(resultButtons(page).first().locator('.result-ndc')).toHaveText(`NDC ${formatNdc(row.ndc)}`);
  await input.press('Enter');
  await expect(page.locator('#card-title')).toHaveText(METFORMIN);
  expect((await hashParams(page)).get('ndc')).toBe(row.ndc);
  const line = page.locator('#your-ndc');
  const check = async () => {
    await expect(line).toContainText(`Your NDC: ${formatNdc(row.ndc)}`);
    await expect(line).toContainText(row.identity.labeler);
    await expect(line).toContainText(row.identity.package_description);
    await expect(line).toContainText(formatUnitPrice(row.nadac.value));
    await expect(line).toContainText(`eff. ${row.nadac.effective_date}`);
    await expect(line.locator('.chip')).toHaveCount(1);
  };
  await check();
  expect(await page.evaluate(() => document.getElementById('your-ndc').nextElementSibling.id)).toBe('figures');

  // A quantity change keeps it in the address, and a reload brings it all back.
  await page.locator('.qty-chip[data-qty="60"]').click();
  await expect.poll(async () => (await hashParams(page)).get('ndc')).toBe(row.ndc);
  await expect.poll(async () => (await hashParams(page)).get('qty')).toBe('60');
  await page.reload();
  await pageReady(page);
  await check();
  expect((await hashParams(page)).get('qty')).toBe('60');

  // It leads to its own entry in the panel, opened, with the others closed.
  await page.locator('button.your-ndc-more').click();
  await expect(page.locator('#panel')).toHaveJSProperty('open', true);
  const item = page.locator(`#panel-body li#ndc-${row.ndc}`);
  await expect(item.locator('details')).toHaveJSProperty('open', true);
  await expect(item.locator('summary')).toBeFocused();
  await expect(item.locator('.ndc-body')).toBeVisible();
  await expect(page.locator('#panel-body details.ndc-more[open]')).toHaveCount(1);

  // The same drug without the NDC is the same drug without the line.
  await followHash(page, hashFor(METFORMIN, 60));
  await expect(line).toHaveCount(0);
  await page.goBack();
  await expect(line).toContainText(formatNdc(row.ndc));
  await seen.check();
});

test('a link’s &ndc= is checked: spelled another way it is rewritten, wrong it is dropped and said so', async ({ page }) => {
  const seen = await open(page, PAGE);
  const row = byName.get(METFORMIN).rows[0];
  const other = byName.get(DEFAULT).rows[0];
  const go = async (raw) => {
    await page.goto('about:blank');
    await page.goto(`${PAGE}#drug=${encodeURIComponent(METFORMIN)}&qty=30&ndc=${encodeURIComponent(raw)}`);
    await pageReady(page);
    await expect(page.locator('#card-title')).toHaveText(METFORMIN);
  };
  await go(formatNdc(row.ndc));
  expect((await hashParams(page)).get('ndc')).toBe(row.ndc);
  await expect(page.locator('#your-ndc')).toContainText(`Your NDC: ${formatNdc(row.ndc)}`);

  await go(other.ndc);
  expect((await hashParams(page)).has('ndc')).toBe(false);
  await expect(page.locator('#your-ndc')).toHaveText(`NDC ${formatNdc(other.ndc)} in this link is not a package of this drug, so it was left out.`);

  const hostile = `<img src=x onerror="window.__xss=1">${'A'.repeat(500)}`;
  await go(hostile);
  expect((await hashParams(page)).has('ndc')).toBe(false);
  await expect(page.locator('#your-ndc')).toContainText('could not be read');
  expect((await page.locator('#your-ndc').textContent()).length).toBeLessThan(200);
  await expect(page.locator('#your-ndc img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  await go('');
  await expect(page.locator('#your-ndc')).toHaveCount(0);
  expect((await hashParams(page)).has('ndc')).toBe(false);
  await seen.check();
});

test('a package NADAC does not list is labelled as a different one, and never opened on Enter', async ({ page }) => {
  const seen = await open(page, PAGE);
  const input = page.locator('#q');
  const shown = formatNdc(missingPackage.ndc);
  await input.fill(shown);
  await expect(resultButtons(page)).toHaveCount(1);
  await expect(resultButtons(page).first().locator('.result-name')).toHaveText(missingPackage.name);
  await expect(resultButtons(page).first().locator('.result-ndc')).toContainText('A different package: NDC');
  await expect(page.locator('#search-status')).toHaveText(new RegExp(`^No package in the NADAC file has NDC ${shown}\\. This is the same labeler’s product in a different package`));
  await input.press('Enter');
  await expect(page.locator('#card-title')).toHaveText(DEFAULT);
  await resultButtons(page).first().click();
  await expect(page.locator('#card-title')).toHaveText(missingPackage.name);
  const line = page.locator('#your-ndc');
  await expect(line).toContainText(`Your NDC: ${shown}`);
  await expect(line).toContainText('This NDC is not in the NADAC file.');
  await expect(line).toContainText('not yours');
  expect((await hashParams(page)).get('ndc')).toBe(missingPackage.ndc);
  await page.reload();
  await pageReady(page);
  await expect(line).toContainText(`Your NDC: ${shown}`);
  await seen.check();
});

test('a number with no match says so once, and a 12-digit number is not called an NDC or a barcode', async ({ page }) => {
  const seen = await open(page, PAGE);
  const input = page.locator('#q');
  const status = page.locator('#search-status');
  const help = page.locator('#search-help');
  await input.fill('99999-9999-99');
  await expect(status).toHaveText('No drug matches “99999-9999-99”. No product in the NADAC file has NDC 99999-9999-99.');
  await expect(help).toContainText('most packages on FDA’s list of prescription drugs are not in it');
  await expect(help).not.toContainText('No product in');

  await input.fill('99999-9999');
  await expect(status).toContainText('No product in the NADAC file has labeler and product code 99999-9999.');

  await input.fill('399999999999');
  await expect(status).toHaveText('No drug matches “399999999999”. A 12-digit number is not an NDC.');
  const row = byName.get(METFORMIN).rows[0];
  await input.fill(`3${row.ndc}`);
  await expect(resultButtons(page).first().locator('.result-name')).toHaveText(METFORMIN);
  await expect(status).toContainText('A 12-digit number is not an NDC.');
  await expect(resultButtons(page).first().locator('.result-ndc')).toContainText('check your label');
  await expect(page.locator('.search')).not.toContainText(/bar ?code|UPC/i);
  await input.press('Enter');
  await expect(page.locator('#card-title')).toHaveText(DEFAULT);
  // BEH-07: chosen, the guess opens the drug, and is not carried as the reader's NDC, which would
  // name it on the card without the hedge.
  await resultButtons(page).first().click();
  await expect(page.locator('#card-title')).toHaveText(METFORMIN);
  expect((await hashParams(page)).has('ndc')).toBe(false);
  await expect(page.locator('#your-ndc')).toHaveCount(0);
  await seen.check();
});

// A85: the count of the labeler's other packages was never checked.
test('a link to a package NADAC does not list counts the labeler’s other packages of it', async ({ page }) => {
  test.skip(!missingOfSeveral, 'no product this week has two packages of one labeler');
  const seen = await open(page, `${PAGE}${hashFor(missingOfSeveral.name)}&ndc=${missingOfSeveral.ndc}`);
  const { more } = missingOfSeveral;
  await expect(page.locator('#your-ndc')).toContainText('This NDC is not in the NADAC file.');
  await expect(page.locator('#your-ndc')).toContainText(`${more} more of this labeler’s package${more === 1 ? ' is' : 's are'} in Sources and method.`);
  await seen.check();
});

// A70: the reader's own NDC was open only when its button opened the panel.
test('opened by its own summary, the panel has the reader’s NDC open and the others closed', async ({ page }) => {
  const row = byName.get(METFORMIN).rows.find((r) => r.identity);
  const seen = await open(page, `${PAGE}${hashFor(METFORMIN, 30)}&ndc=${row.ndc}`);
  await openPanel(page);
  await expect(page.locator(`#panel-body li#ndc-${row.ndc} > details`)).toHaveJSProperty('open', true);
  await expect(page.locator('#panel-body details.ndc-more[open]')).toHaveCount(1);
  await seen.check();
});

for (const name of [mostNdcs.name, 'NALOXONE 2 MG/2 ML SYRINGE']) {
  test(`the panel stays under ${PANEL_LIMIT} px at 360 wide: ${name}`, async ({ page }) => {
    test.skip(!byName.has(name), `${name} is not in this build`);
    await page.setViewportSize({ width: 360, height: 780 });
    const seen = await open(page, PAGE + hashFor(name));
    await openPanel(page);
    const body = page.locator('#panel-body');
    await expect(body.locator('li.ndc')).toHaveCount(byName.get(name).rows.length);
    expect((await body.boundingBox()).height).toBeLessThan(PANEL_LIMIT);
    await expect(body.locator('details[open]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    const sizes = await page.evaluate(() => [...document.querySelectorAll('#panel-body summary')].map((s) => s.getBoundingClientRect().height));
    expect(Math.min(...sizes), 'each summary is a 44px target').toBeGreaterThanOrEqual(44);
    // A nested details stays open when a new quantity rebuilds the panel.
    const first = body.locator('details.ndc-more').first();
    await first.locator('summary').click();
    await expect(first).toHaveJSProperty('open', true);
    await page.locator('#qty').fill('45');
    await expect(body.locator('details.ndc-more').first()).toHaveJSProperty('open', true);
    await seen.check();
  });
}

test('a #ndc- anchor opens that entry on the card that has it, and leaves any other card alone', async ({ page }) => {
  const seen = await open(page, PAGE + hashFor(METFORMIN, DEFAULT_QTY));
  const row = byName.get(METFORMIN).rows[0];
  await followHash(page, `#ndc-${row.ndc}`);
  await expect(page.locator(`#panel-body li#ndc-${row.ndc} details`)).toHaveJSProperty('open', true);
  await expect.poll(() => addressHash(page)).toBe(hashFor(METFORMIN, DEFAULT_QTY));
  await followHash(page, `#ndc-${byName.get(DEFAULT).rows[0].ndc}`);
  await expect.poll(() => addressHash(page)).toBe(hashFor(METFORMIN, DEFAULT_QTY));
  await expect(page.locator('#card-title')).toHaveText(METFORMIN);
  await seen.check();
});

test('printing opens the panel’s nested details and puts them back', async ({ page }) => {
  await open(page, PAGE + hashFor(METFORMIN));
  const nested = page.locator('#panel-body details:not([open])');
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await expect(page.locator('#panel-body li.ndc').first()).toBeAttached();
  await expect(nested).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('#panel-body details.ndc-more[open]')).toHaveCount(0);
});
