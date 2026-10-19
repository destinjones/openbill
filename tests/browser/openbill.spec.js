// Browser checks for openbill.html and methodology.html, loaded from file:// URLs.
// Every expected figure is computed here from data/drugs.json with the core modules, never
// hard-coded, so a data refresh does not need these tests rewritten.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { linkRows, packDrugs, unpackDrugs } from '../../src/core/pack.js';
import { groupProducts, buildIndex, search } from '../../src/core/search.js';
import { summarizeProduct, partDNameContext, freshness, inputDates, rangesByUnit, formatSpreadMultiple, isExtremeSpread, paidComparison, parsePaid, COST_PLUS, RULES, HONESTY, EXTREME_HEADLINE, EXTREME_LOW, EXTREME_HIGH } from '../../src/core/rules.js';
import { formatMoney, formatMultiple, formatUnitPrice } from '../../src/core/money.js';
import { formatNdc } from '../../src/core/ndc.js';
import { SOURCE_INFO } from '../../src/core/sources.js';
import { REPO_URL, SITE_URL } from '../../src/core/config.js';
import { slugify, siteSlugs } from '../../src/core/slug.js';

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
  const summary = page.locator('#panel summary');
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
  const summaryEl = page.locator('#panel summary');
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
    await expect(body.locator(`ul.rules a[href="methodology.html#${id}"]`), `rules list links #${id}`).toHaveCount(1);
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
  const [r, p] = await Promise.all([link.boundingBox(), page.locator('#panel summary').boundingBox()]);
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
  await page.locator('#q').fill('apixaban');
  await expect(page.locator('#results button.result', { hasText: 'ELIQUIS' }).first().locator('.result-via')).toContainText('matched');
});

test('Enter opens the first result; no match shows a suggestion and a hint, and says so', async ({ page }) => {
  await open(page, PAGE);
  const input = page.locator('#q');
  await input.fill('eliquis 5');
  await expect(page.locator('#results button.result').first()).toBeVisible();
  const first = search(index, 'eliquis 5')[0].product.name;
  await input.press('Enter');
  await expect(page.locator('#card-title')).toHaveText(first);
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
  await expect(page.locator('#panel-body ul.rules a[href="methodology.html#part-d-name-outlier"]')).toHaveCount(1);
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
  await open(page, PAGE, { today: '2026-12-01' });
  const notes = page.locator('.notes');
  await expect(notes).toContainText(`FDA NDC Directory · ${fda.source_file} · as of ${fda.as_of_date} · retrieved ${fda.retrieved_date}`);
  const f = freshness(fda, SOURCE_INFO.fda_ndc, '2026-12-01');
  expect(f.stale).toBe(true);
  await expect(notes.locator('.fresh-stale', { hasText: 'FDA NDC Directory' })).toContainText(f.message);
  await expect(notes.locator('.fresh-stale', { hasText: 'FDA NDC Directory' }).locator('.chip-stale')).toHaveText('stale');
});

test('a #drug=…&qty=90 deep link opens that card at 90; quantity changes update it and are announced', async ({ page }) => {
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
  await page.locator('.qty-chip[data-qty="2"]').click();
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
      const changed = Buffer.from(raw.replace(/0\.01451/g, '0.09451'), 'utf8');
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
    const r = await page.evaluate(() => {
      document.querySelector('#panel') && (document.querySelector('#panel').open = true);
      return [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => !/^(https:\/\/|methodology\.html#|#|openbill\.html$|methodology\.html$|data\/drugs\.json$)/.test(h));
    });
    expect(r, hash).toEqual([]);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  }
  await expect(page.locator('#panel-body')).toContainText('This record is not valid');
});

test('no horizontal scroll, with the panel open, with search results and at 200% text', async ({ page }, info) => {
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
  await expect(body.locator('ul.rules a[href="methodology.html#cost-plus"]')).toHaveCount(1);
  await expect(body.locator('a[href="methodology.html#cost-plus"]').first()).toBeVisible();
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
  await page.locator('#q').fill('eliquis 5');
  await page.locator('#q').press('Enter');
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
