// The website: node tools/site.mjs --out <dir> [--limit N] [--only NAME]... [--no-og]
//
// Builds the site that .github/workflows/pages.yml deploys (docs/ARCHITECTURE.md, "Drug pages"):
//   index.html, openbill.html     the app, copied byte for byte from the built openbill.html
//   methodology.html              copied byte for byte
//   data/drugs.json               the real data file (an LFS pointer stops the build)
//   drug/<slug>/index.html        one static page per product
//   class/<slug>/index.html       one page per FDA Established Pharmacologic Class
//   drugs/<letter>/index.html     the A–Z index
//   og/<slug>.png, og/site.png    1200×630 preview cards (PNG), rendered with Playwright's Chromium
//   press/index.html              the press kit (src/build/presspage.js, decision 51)
//   press/*.png, press/*.gif      its pictures: the wordmark, three screenshots of the card
//                                 (tools/shots.mjs) and the reveal clips (tools/record.mjs)
//   assets/site.css, assets/fonts/  shared by the static pages
//   sitemap.xml                   every page, lastmod from git
//
// Static pages are built on deploy and never committed. The output is deterministic: the same
// commit gives the same bytes (no build time anywhere; sitemap dates come from git history).
//
// Options:
//   --out <dir>        where to write the site (required). Emptied first; it must be empty, or a
//                      site this tool wrote before (it holds the .openbill-site marker this tool
//                      writes, and no .git). Never the repository itself.
//   --limit N          only the first N products by name (plus the showcase) get drug pages and
//                      preview cards; class and A–Z pages are always complete. For quick looks.
//   --only NAME        only this product (repeatable); for tests and spot checks.
//   --no-og            skip every rendered image: the preview cards and the press kit's pictures
//                      and clips (og:image tags and the press page still point at them).
//   --pages <dir>      read openbill.html and methodology.html from <dir> instead of the
//                      repository root (for a local look before `node build.js` is run).
//
// Product names that would share a slug each get a suffix from their own name (siteSlugs in
// src/core/slug.js, decision 46); the build prints which.
//
// Needs the dev dependency for the images: npm ci && npx playwright install chromium.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import { buildModel, renderDrugPage, renderClassPage, renderLetterPage, renderNotFoundPage, renderOgHtml, sitemapXml, linkedAnchors, ogImagePath, SHOWCASE, OG_WIDTH, OG_HEIGHT, SITEMAP_CLASS_MIN } from '../src/build/drugpage.js';
import { renderPressPage, renderWordmarkHtml, citationDois, PRESS_PATH, PRESS_SHOTS, PRESS_WORDMARKS, WORDMARK } from '../src/build/presspage.js';
import { slugify, siteSlugs } from '../src/core/slug.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FONT_DIR = 'src/app/fonts';

/** Written into every site this tool builds; prepareOut() empties a non-empty folder only if it has it. */
export const MARKER = '.openbill-site';
const MARKER_TEXT = 'Written by OpenBill tools/site.mjs. This folder is emptied and rebuilt by it.\n';

/** The files a static page is built from: its sitemap lastmod is the newest commit touching any. */
export const PAGE_INPUTS = Object.freeze(['data/drugs.json', 'src/build/drugpage.js', 'src/build/methodology.js', 'src/core', 'src/site']);

/** The press page also changes with its own renderers and with the DOIs in CITATION.cff. */
export const PRESS_INPUTS = Object.freeze([...PAGE_INPUTS, 'src/build/presspage.js', 'src/build/reveal.js', 'CITATION.cff']);
const LFS_POINTER = 'version https://git-lfs.github.com/spec/';

// The latin subset's unicode-range, as build.js writes it for these files.
const LATIN_RANGE =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

// ---------------------------------------------------------------- inputs

/**
 * data/drugs.json, parsed. Refuses a Git LFS pointer (a clone without git-lfs has only that).
 * @param {string} file
 * @returns {{ doc: object, bytes: Buffer }}
 */
export function readData(file = path.join(ROOT, 'data', 'drugs.json')) {
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, LFS_POINTER.length).toString('utf8') === LFS_POINTER) {
    throw new Error(`${file} is a Git LFS pointer, not the data. Install Git LFS (https://git-lfs.com), then run: git lfs install && git lfs pull`);
  }
  const doc = JSON.parse(bytes.toString('utf8'));
  if (!doc || !Array.isArray(doc.rows) || !doc.sources || !doc.sources.nadac) throw new Error(`${file} has no rows or no nadac source`);
  return { doc, bytes };
}

/**
 * The date of the last commit touching `rel` (git log -1 --format=%cs), or null with the reason
 * git cannot say (not installed, not a repository, a shallow clone, no commit touches the file).
 * @param {string} rel repository-relative path
 * @returns {{ date: string|null, why: string|null }}
 */
export function gitLastmod(rel, cwd = ROOT) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    if (git(['rev-parse', '--is-shallow-repository']) === 'true') return { date: null, why: 'the clone is shallow, so its history is incomplete' };
    const date = git(['log', '-1', '--format=%cs', '--', rel]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { date: null, why: `no commit in this clone touches ${rel}` };
    return { date, why: null };
  } catch (e) {
    return { date: null, why: `git could not be asked (${String(e.message).split('\n')[0]})` };
  }
}

/** Every slug that two or more product names share: [[slug, names]]. */
export function slugCollisions(names) {
  const bySlug = new Map();
  for (const n of new Set(names)) {
    const s = slugify(n);
    if (!bySlug.has(s)) bySlug.set(s, []);
    bySlug.get(s).push(n);
  }
  return [...bySlug.entries()].filter(([, list]) => list.length > 1).map(([s, list]) => [s, list.sort()]);
}

function fontFiles() {
  return fs
    .readdirSync(path.join(ROOT, FONT_DIR))
    .filter((f) => f.endsWith('.woff2'))
    .sort();
}

/** The cards' @font-face rules with the fonts as data: URIs, so rendering a card, a clip frame or the wordmark fetches nothing. */
export function inlineFontCss() {
  const faces = [
    ['IBM Plex Sans', 400, 'ibm-plex-sans-latin-400-normal.woff2'],
    ['IBM Plex Sans', 600, 'ibm-plex-sans-latin-600-normal.woff2'],
    ['IBM Plex Mono', 400, 'ibm-plex-mono-latin-400-normal.woff2'],
  ];
  return faces
    .map(([family, weight, file]) => {
      const b64 = fs.readFileSync(path.join(ROOT, FONT_DIR, file)).toString('base64');
      return `@font-face { font-family: '${family}'; font-style: normal; font-weight: ${weight}; src: url(data:font/woff2;base64,${b64}) format('woff2'); unicode-range: ${LATIN_RANGE}; }\n`;
    })
    .join('');
}

// ---------------------------------------------------------------- output

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Empty the output folder, after checking it is safe to: never the repository, never a git
 * checkout, and a non-empty folder only when it carries the marker this tool writes into every
 * site (two common file names, such as index.html and sitemap.xml, are not proof enough).
 */
export function prepareOut(out) {
  const abs = path.resolve(out);
  if (isInside(ROOT, abs)) throw new Error(`--out ${out} is the repository or a folder above it; refusing to empty it`);
  if (isInside(abs, ROOT) && path.relative(ROOT, abs) !== '_site') throw new Error(`--out ${out} is inside the repository; only _site (in CI) is allowed there`);
  if (fs.existsSync(abs)) {
    const entries = fs.readdirSync(abs);
    if (entries.includes('.git')) throw new Error(`--out ${out} holds a .git folder; refusing to empty it`);
    let marked = false;
    try {
      marked = fs.readFileSync(path.join(abs, MARKER), 'utf8') === MARKER_TEXT;
    } catch {
      marked = false;
    }
    if (entries.length > 0 && !marked) throw new Error(`--out ${out} is not empty and has no ${MARKER} marker, so it is not a site this tool wrote; refusing to empty it`);
    fs.rmSync(abs, { recursive: true, force: true });
  }
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, MARKER), MARKER_TEXT);
  return abs;
}

function writeFile(out, rel, content) {
  const abs = path.join(out, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length;
}

function readPage(dir, name) {
  const abs = path.join(dir, name);
  if (!fs.existsSync(abs)) throw new Error(`${abs} is missing; run node build.js first`);
  return fs.readFileSync(abs);
}

/** Anchors the static pages link to that methodology.html does not have. */
export function missingAnchors(methodologyHtml, anchors = linkedAnchors()) {
  const text = String(methodologyHtml);
  return anchors.filter((a) => !text.includes(`id="${a}"`));
}

function walk(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(abs, base, out);
    else out.push({ rel: path.relative(base, abs).split(path.sep).join('/'), bytes: fs.statSync(abs).size });
  }
  return out;
}

function mb(n) {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ms(n) {
  return `${n.toFixed(1)} ms`;
}

// ---------------------------------------------------------------- preview cards

/**
 * Render each card with Playwright's Chromium, reusing one page: setContent per card, wait for the
 * fonts, screenshot 1200×630 as a PNG. Any console error, page error or request to the network
 * stops it.
 * @returns {Promise<{ count: number, times: number[], total: number }>}
 */
async function renderOgImages(model, jobs, out, log) {
  let chromium;
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch (e) {
    throw new Error(`The preview images need Playwright (npm ci && npx playwright install chromium), or pass --no-og: ${e.message}`);
  }
  const css = inlineFontCss() + fs.readFileSync(path.join(ROOT, 'src/site/og.css'), 'utf8');
  const t0 = performance.now();
  const browser = await chromium.launch();
  const problems = [];
  const times = [];
  try {
    // The card markup is built from data: no script may run in it (it has none, and JavaScript is
    // off here), so a slip in escaping could never execute inside the build job. Every request is
    // aborted below. (A CSP meta in the markup was tried: on this one reused page it made each card
    // slower than the last, so the context settings do this job instead.)
    const context = await browser.newContext({ viewport: { width: OG_WIDTH, height: OG_HEIGHT }, deviceScaleFactor: 1, colorScheme: 'light', offline: true, javaScriptEnabled: false });
    await context.route('**/*', (route) => {
      problems.push(`the card asked for ${route.request().url()}`);
      return route.abort();
    });
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(`console ${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('dialog', (d) => {
      problems.push(`a ${d.type()} dialog opened`);
      return d.dismiss();
    });
    fs.mkdirSync(path.join(out, 'og'), { recursive: true });
    let i = 0;
    for (const job of jobs) {
      const t = performance.now();
      await page.setContent(renderOgHtml(model, job.product, { css, site: job.site }), { waitUntil: 'load' });
      const check = await page.evaluate(async () => {
        await document.fonts.ready;
        const og = document.querySelector('.og');
        return {
          fonts: document.fonts.check('600 20px "IBM Plex Sans"') && document.fonts.check('20px "IBM Plex Mono"'),
          overflow: og ? og.scrollHeight - og.clientHeight : -1,
          scripts: document.scripts.length,
        };
      });
      if (!check.fonts) problems.push(`${job.file}: the fonts did not load`);
      if (check.overflow !== 0) problems.push(`${job.file}: the card's content does not fit (${check.overflow}px over)`);
      if (check.scripts !== 0) problems.push(`${job.file}: the card markup has a script`);
      const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: OG_WIDTH, height: OG_HEIGHT }, animations: 'disabled', caret: 'hide' });
      writeFile(out, job.file, png);
      times.push(performance.now() - t);
      if (problems.length) throw new Error(`preview card ${job.file}: ${problems.join('; ')}`);
      i += 1;
      if (i % 500 === 0) log(`  og: ${i} of ${jobs.length} cards, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
    }
    await context.close();
  } finally {
    await browser.close();
  }
  return { count: times.length, times, total: performance.now() - t0 };
}

// ---------------------------------------------------------------- the press kit's pictures

/** The card openbill.html opens on: the press screenshots show it, so it must be the showcase. */
export function appDefault(appHtml) {
  const m = /<script type="application\/json" id="openbill-build">([\s\S]*?)<\/script>/.exec(String(appHtml));
  if (!m) throw new Error('openbill.html has no openbill-build block');
  const d = JSON.parse(m[1]).default;
  if (!d || typeof d.drug !== 'string') throw new Error('openbill.html names no default card');
  return d;
}

/**
 * The press kit's pictures, into press/: the wordmark in both inks (transparent PNG), the three
 * screenshots of the app's default card (tools/shots.mjs, clock fixed to the NADAC retrieved date)
 * and the reveal clips (tools/record.mjs). One Chromium for all of them.
 */
async function renderPressMedia(model, showcase, out, { pagesDir, dataSha256, log }) {
  const { chromium } = await import('@playwright/test');
  const { shootCards } = await import('./shots.mjs');
  const { recordReveal } = await import('./record.mjs');
  const dir = path.join(out, ...PRESS_PATH.split('/').filter(Boolean));
  const t0 = performance.now();
  const browser = await chromium.launch();
  try {
    const css = inlineFontCss() + fs.readFileSync(path.join(ROOT, 'src/site/reveal.css'), 'utf8');
    for (const w of PRESS_WORDMARKS) {
      const context = await browser.newContext({ viewport: { width: WORDMARK.width, height: WORDMARK.height }, deviceScaleFactor: WORDMARK.scale, offline: true, javaScriptEnabled: false });
      try {
        await context.route('**/*', (route) => route.abort());
        const page = await context.newPage();
        await page.setContent(renderWordmarkHtml({ css, ink: w.ink }), { waitUntil: 'load' });
        const ok = await page.evaluate(async () => {
          await document.fonts.ready;
          return document.fonts.check('600 20px "IBM Plex Sans"') && document.fonts.check('11px "IBM Plex Mono"');
        });
        if (!ok) throw new Error(`${w.file}: the fonts did not load`);
        writeFile(out, `${PRESS_PATH}${w.file}`, await page.screenshot({ type: 'png', omitBackground: true, animations: 'disabled' }));
      } finally {
        await context.close();
      }
    }
    const shots = await shootCards({ browser, page: pathToFileURL(path.join(pagesDir, 'openbill.html')).href, outDir: dir, day: model.doc.sources.nadac.retrieved_date, shots: PRESS_SHOTS });
    const clips = await recordReveal({ model, product: showcase, out: dir, fontCss: inlineFontCss(), browser, dataSha256, log });
    return { wordmarks: PRESS_WORDMARKS.length, shots: shots.length, clips, total: performance.now() - t0 };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- the build

/**
 * Build the site into `out`. Returns what was written, for the CLI's report and the tests.
 * @param {object} opts
 * @param {string} opts.out
 * @param {number} [opts.limit]
 * @param {string[]} [opts.only]
 * @param {boolean} [opts.og=true]
 * @param {string} [opts.pagesDir] where openbill.html and methodology.html are read from
 * @param {boolean} [opts.checkAnchors=true] stop if methodology.html lacks an anchor the pages link to
 * @param {string} [opts.dataFile]
 * @param {(line: string) => void} [opts.log]
 */
export async function buildSite(opts) {
  const { out, limit, only, og = true, pagesDir = ROOT, checkAnchors = true, dataFile, log = (l) => console.log(l) } = opts || {};
  if (!out) throw new Error('buildSite needs --out <dir>');
  const t0 = performance.now();
  const { doc: fullDoc, bytes: dataBytes } = readData(dataFile);

  // Names that share a slug: each gets a suffix from its own name (siteSlugs); say which.
  const doc = fullDoc;
  const collisions = slugCollisions(doc.rows.map((r) => r.name));
  if (collisions.length) {
    const suffixed = siteSlugs(collisions.flatMap(([, names]) => names));
    log(`  slugs: ${collisions.length} shared slug${collisions.length === 1 ? '' : 's'}, so these names get a suffix from their own name: ${[...suffixed].map(([n, s]) => `${JSON.stringify(n)} -> ${s}`).join('; ')}`);
  }

  // sitemap lastmod from git; the NADAC file date only when git history is unavailable.
  const notes = [];
  const lastmod = (rel) => {
    const g = gitLastmod(rel);
    if (g.date) return g.date;
    notes.push(`lastmod for ${rel}: git history unavailable (${g.why}); used the NADAC as-of date ${doc.sources.nadac.as_of_date} instead`);
    return doc.sources.nadac.as_of_date;
  };
  // A data page changes when the data or the code that renders it changes: its lastmod is the
  // newest commit touching any of PAGE_INPUTS (ISO dates compare as strings).
  const dataDate = PAGE_INPUTS.map(lastmod).sort().at(-1);
  const pressDate = PRESS_INPUTS.map(lastmod).sort().at(-1);
  const appDate = lastmod('openbill.html');
  const methodologyDate = lastmod('methodology.html');

  const model = buildModel(doc, { dataDate });
  const tModel = performance.now();

  let chosen;
  if (only && only.length) {
    chosen = only.map((n) => {
      const p = model.byName.get(n);
      if (!p) throw new Error(`--only ${JSON.stringify(n)}: no such product in data/drugs.json`);
      return p;
    });
  } else if (Number.isInteger(limit) && limit >= 0) {
    chosen = model.products.slice(0, limit);
  } else {
    chosen = model.products;
  }
  const showcase = model.byName.get(SHOWCASE.drug);
  if (!showcase) throw new Error(`the showcase product ${JSON.stringify(SHOWCASE.drug)} is not in data/drugs.json`);
  if (!chosen.includes(showcase)) chosen = [...chosen, showcase];
  chosen = [...new Set(chosen)];

  const app = readPage(pagesDir, 'openbill.html');
  const methodology = readPage(pagesDir, 'methodology.html');
  const missing = missingAnchors(methodology);
  if (checkAnchors && missing.length) {
    throw new Error(`methodology.html has no ${missing.map((a) => `#${a}`).join(', ')}, which the drug pages link to: it is out of date (run node build.js)`);
  }

  const dir = prepareOut(out);
  const written = { drug: 0, class: 0, classUnlisted: 0, letter: 0 };
  const sitemap = [
    { path: '', lastmod: appDate },
    { path: 'methodology.html', lastmod: methodologyDate },
  ];
  writeFile(dir, 'index.html', app);
  writeFile(dir, 'openbill.html', app);
  writeFile(dir, 'methodology.html', methodology);
  writeFile(dir, 'data/drugs.json', dataBytes);
  writeFile(dir, 'assets/site.css', fs.readFileSync(path.join(ROOT, 'src/site/site.css')));
  for (const f of fontFiles()) writeFile(dir, `assets/fonts/${f}`, fs.readFileSync(path.join(ROOT, FONT_DIR, f)));
  writeFile(dir, 'assets/fonts/OFL.txt', fs.readFileSync(path.join(ROOT, FONT_DIR, 'OFL.txt')));

  const titles = new Map();
  for (const p of chosen) {
    const r = renderDrugPage(model, p);
    if (titles.has(r.title)) throw new Error(`two drug pages would share the title ${JSON.stringify(r.title)}`);
    titles.set(r.title, r.path);
    writeFile(dir, r.file, r.html);
    sitemap.push({ path: r.path, lastmod: dataDate });
    written.drug += 1;
  }
  for (const [key, list] of model.classes) {
    const r = renderClassPage(model, key);
    writeFile(dir, r.file, r.html);
    // A class of one or two products is mostly shared explanation: published and linked from its
    // drug pages, but not offered to search engines in the sitemap.
    if (list.length >= SITEMAP_CLASS_MIN) sitemap.push({ path: r.path, lastmod: dataDate });
    else written.classUnlisted += 1;
    written.class += 1;
  }
  for (const letter of model.letterOrder) {
    const r = renderLetterPage(model, letter);
    writeFile(dir, r.file, r.html);
    sitemap.push({ path: r.path, lastmod: dataDate });
    written.letter += 1;
  }
  writeFile(dir, '404.html', renderNotFoundPage(model).html);
  // The press kit, after the class and A–Z pages, which have worked out every product's figures.
  const press = renderPressPage(model, showcase, { dois: citationDois(fs.readFileSync(path.join(ROOT, 'CITATION.cff'), 'utf8')) });
  writeFile(dir, press.file, press.html);
  sitemap.push({ path: press.path, lastmod: pressDate });
  writeFile(dir, 'sitemap.xml', sitemapXml(sitemap));
  const tPages = performance.now();

  let images = null;
  let pressMedia = null;
  if (og) {
    const jobs = chosen.map((p) => ({ product: p, file: ogImagePath(model.slugs.get(p.name)), site: false }));
    jobs.push({ product: showcase, file: ogImagePath('site'), site: true });
    images = await renderOgImages(model, jobs, dir, log);
    const shown = appDefault(app);
    if (shown.drug !== SHOWCASE.drug || Number(shown.qty) !== SHOWCASE.qty) {
      throw new Error(`openbill.html opens on ${shown.drug} × ${shown.qty}, not the showcase ${SHOWCASE.drug} × ${SHOWCASE.qty}, so the press screenshots would not show the press page's numbers`);
    }
    pressMedia = await renderPressMedia(model, showcase, dir, { pagesDir, dataSha256: crypto.createHash('sha256').update(dataBytes).digest('hex'), log });
  }

  if (!fs.existsSync(path.join(dir, 'index.html'))) throw new Error('the site has no index.html');
  if (written.drug < chosen.length) throw new Error(`only ${written.drug} of ${chosen.length} drug pages were written`);

  const files = walk(dir);
  const sizes = {};
  for (const f of files) {
    const top = f.rel.includes('/') ? `${f.rel.split('/')[0]}/` : f.rel;
    sizes[top] = (sizes[top] || 0) + f.bytes;
  }
  const result = {
    out: dir,
    products: model.products.length,
    slugCollisions: collisions,
    pages: written,
    images,
    press: { file: press.file, facts: press.facts, paragraph: press.paragraph, media: pressMedia },
    files: files.length,
    bytes: files.reduce((a, f) => a + f.bytes, 0),
    sizes,
    notes,
    dates: { data: dataDate, press: pressDate, app: appDate, methodology: methodologyDate },
    anchorsMissing: missing,
    timing: { model: tModel - t0, pages: tPages - tModel, total: performance.now() - t0 },
    model,
  };
  report(result, log);
  return result;
}

function report(r, log) {
  const n = (x) => x.toLocaleString('en-US');
  log(`Site written to ${r.out}`);
  log(`  products in data: ${n(r.products)}`);
  log(`  pages: ${n(r.pages.drug)} drug, ${n(r.pages.class)} class (${n(r.pages.classUnlisted)} left out of the sitemap, under ${SITEMAP_CLASS_MIN} products), ${n(r.pages.letter)} A–Z, plus index.html, openbill.html, methodology.html, 404.html, ${r.press.file}`);
  if (r.images) {
    const t = [...r.images.times].sort((a, b) => a - b);
    const mean = t.reduce((a, b) => a + b, 0) / (t.length || 1);
    log(`  images: ${n(r.images.count)} preview cards in ${(r.images.total / 1000).toFixed(1)} s; per image mean ${ms(mean)}, median ${ms(t[Math.floor(t.length / 2)] || 0)}, slowest ${ms(t[t.length - 1] || 0)}`);
  } else log('  images: skipped (--no-og)');
  if (r.press.media) log(`  press: ${r.press.media.wordmarks} wordmarks, ${r.press.media.shots} screenshots, ${r.press.media.clips.length} clips in ${(r.press.media.total / 1000).toFixed(1)} s`);
  else log('  press: pictures and clips skipped (--no-og)');
  log(`  files: ${n(r.files)}, ${mb(r.bytes)} in all`);
  for (const [k, v] of Object.entries(r.sizes).sort((a, b) => b[1] - a[1])) log(`    ${k.padEnd(18)} ${mb(v).padStart(9)}  (${n(v)} bytes)`);
  log(`  sitemap lastmod: data pages ${r.dates.data} (newest of ${PAGE_INPUTS.join(', ')}), press ${r.dates.press}, home ${r.dates.app}, methodology ${r.dates.methodology}`);
  for (const note of r.notes) log(`  NOTE ${note}`);
  if (r.anchorsMissing.length) log(`  WARNING methodology.html has no ${r.anchorsMissing.map((a) => `#${a}`).join(', ')} (run node build.js)`);
  log(`  time: model ${(r.timing.model / 1000).toFixed(1)} s, pages ${(r.timing.pages / 1000).toFixed(1)} s, total ${(r.timing.total / 1000).toFixed(1)} s`);
}

// ---------------------------------------------------------------- CLI

export function parseArgs(argv) {
  const opts = { only: [], og: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--out') opts.out = value();
    else if (a === '--limit') {
      const v = value();
      if (!/^\d+$/.test(v)) throw new Error(`--limit needs a whole number, got ${JSON.stringify(v)}`);
      opts.limit = Number(v);
    } else if (a === '--only') opts.only.push(value());
    else if (a === '--no-og') opts.og = false;
    else if (a === '--pages') opts.pagesDir = path.resolve(value());
    else throw new Error(`unknown option ${JSON.stringify(a)}; see the top of tools/site.mjs`);
  }
  if (!opts.out) throw new Error('usage: node tools/site.mjs --out <dir> [--limit N] [--only NAME]... [--no-og] [--pages <dir>]');
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await buildSite(parseArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(`site.mjs: ${e.message}`);
    process.exitCode = 1;
  }
}
