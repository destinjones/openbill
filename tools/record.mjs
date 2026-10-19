// The reveal clip: node tools/record.mjs --out <dir> [--layout wide|tall]
//
// Writes, from data/drugs.json, a 6-second looping GIF of the showcase's card (decision 51):
//   openbill-reveal.gif        1200×675 (16:9), for the README and most feeds
//   openbill-reveal.png        its last frame, a still
//   openbill-reveal-9x16.gif   540×960 (9:16), for stories
// The search box types the product's first word, the card resolves, what pharmacies pay appears,
// the rule draws, what Medicare paid lands, the spread counts up to core's value, the source lines
// fade in, it holds and loops. No cursor, no scrolling.
//
// Each frame is a whole page from renderRevealHtml() (src/build/reveal.js), rendered in Playwright's
// Chromium with JavaScript off and every request refused, screenshot as a PNG and encoded by
// tools/gif.mjs (no other dependency). The same data gives the same frames. The deploy runs this
// through tools/site.mjs, which writes the clips into press/ next to the press page; nothing it
// writes is committed, so --out must be outside the repository.
//
// Needs the dev dependency: npm ci && npx playwright install chromium.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { decodePng, encodeGif } from './gif.mjs';
import { buildModel, SHOWCASE } from '../src/build/drugpage.js';
import { REVEAL_LAYOUTS, revealFacts, revealTimeline, renderRevealHtml } from '../src/build/reveal.js';
import { SITE_URL } from '../src/core/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The most a clip may weigh: it is embedded in the README and posted to social feeds. */
export const MAX_GIF_BYTES = 3 * 1024 * 1024;

/** The GIF comment says what the clip shows and which data made it, in the 7-bit ASCII GIF comments allow. */
function ascii(s) {
  return String(s)
    .replace(/×/g, 'x')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7e]/g, '');
}

function clipComment(model, f, dataSha256) {
  const m = f.medicare;
  return ascii(
    `OpenBill reveal clip: ${f.name}, ${f.qtyText}. Pharmacies pay ${f.pharmacy.text} (${f.pharmacy.state}, CMS NADAC file of ${model.doc.sources.nadac.as_of_date}); ` +
      `${m.label} ${m.text} (${m.state}${m.year ? `, ${m.year} average` : ''}); the spread ${f.spread.text} (${f.spread.state}). ` +
      `Rendered by tools/record.mjs from data/drugs.json${dataSha256 ? ` sha256 ${dataSha256}` : ''}. ${SITE_URL}`,
  );
}

/**
 * Record the clips into `out`. Pass `browser` to reuse one (tools/site.mjs does); otherwise one is
 * launched and closed.
 * @param {object} opts
 * @param {object} opts.model buildModel()
 * @param {{ name: string, rows: object[] }} opts.product
 * @param {string} opts.out
 * @param {string} opts.fontCss the IBM Plex @font-face rules with the fonts as data: URIs (inlineFontCss() in tools/site.mjs)
 * @param {string[]} [opts.layouts] keys of REVEAL_LAYOUTS
 * @param {string} [opts.dataSha256]
 * @param {object} [opts.browser] a Playwright Browser
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{ file: string, still: string|null, width: number, height: number, bytes: number, frames: number, stored: number, duration: number }[]>}
 */
export async function recordReveal({ model, product, out, fontCss, layouts = Object.keys(REVEAL_LAYOUTS), dataSha256, browser, log = (l) => console.log(l) }) {
  if (typeof fontCss !== 'string' || !fontCss.includes('@font-face')) throw new Error('recordReveal needs the @font-face rules (fontCss)');
  const css = fontCss + fs.readFileSync(path.join(ROOT, 'src/site/reveal.css'), 'utf8');
  const f = revealFacts(model, product);
  const timeline = revealTimeline(f);
  const comment = clipComment(model, f, dataSha256);
  let own = null;
  if (!browser) {
    let chromium;
    try {
      ({ chromium } = await import('@playwright/test'));
    } catch (e) {
      throw new Error(`The clip needs Playwright (npm ci && npx playwright install chromium): ${e.message}`);
    }
    own = await chromium.launch();
  }
  const results = [];
  fs.mkdirSync(out, { recursive: true });
  try {
    for (const key of layouts) {
      const layout = REVEAL_LAYOUTS[key];
      if (!layout) throw new Error(`no reveal layout ${JSON.stringify(key)}`);
      const { width, height } = layout;
      const problems = [];
      // As for the preview cards: no script can run in the frames, and every request is refused.
      const context = await (browser || own).newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'light', offline: true, javaScriptEnabled: false });
      await context.route('**/*', (route) => {
        problems.push(`the clip asked for ${route.request().url()}`);
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
      const t0 = Date.now();
      const frames = [];
      let lastPng = null;
      for (let i = 0; i < timeline.length; i++) {
        const { state, delay } = timeline[i];
        await page.setContent(renderRevealHtml(model, f, { css, layout: key, state }), { waitUntil: 'load' });
        const check = await page.evaluate(async () => {
          await document.fonts.ready;
          const scene = document.querySelector('.scene');
          const over = (el) => (el ? Math.max(el.scrollHeight - el.clientHeight, el.scrollWidth - el.clientWidth) : -1);
          return {
            fonts: document.fonts.check('600 20px "IBM Plex Sans"') && document.fonts.check('20px "IBM Plex Mono"'),
            overflow: Math.max(over(scene), over(document.body), over(document.querySelector('.card'))),
            scripts: document.scripts.length,
          };
        });
        if (!check.fonts) problems.push(`frame ${i}: the fonts did not load`);
        if (check.overflow !== 0) problems.push(`frame ${i}: the ${key} layout does not fit its ${width}×${height} frame (${check.overflow}px over)`);
        if (check.scripts !== 0) problems.push(`frame ${i}: the frame has a script`);
        if (problems.length) throw new Error(`reveal clip ${layout.file}: ${problems.join('; ')}`);
        const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height }, animations: 'disabled', caret: 'hide' });
        const img = decodePng(png);
        if (img.width !== width || img.height !== height) throw new Error(`reveal clip ${layout.file}: a frame is ${img.width}×${img.height}, not ${width}×${height}`);
        frames.push({ rgb: img.rgb, delay });
        lastPng = png;
      }
      await context.close();
      const tShot = Date.now();
      const { gif, stored } = encodeGif(frames, { width, height, comment });
      if (gif.length > MAX_GIF_BYTES) throw new Error(`reveal clip ${layout.file} is ${gif.length} bytes, over the ${MAX_GIF_BYTES}-byte limit`);
      fs.writeFileSync(path.join(out, layout.file), gif);
      if (layout.still) fs.writeFileSync(path.join(out, layout.still), lastPng);
      const duration = frames.reduce((a, x) => a + x.delay, 0);
      results.push({ file: layout.file, still: layout.still, width, height, bytes: gif.length, frames: frames.length, stored, duration });
      log(`  clip: ${layout.file} ${width}×${height}, ${frames.length} frames (${stored} stored), ${(duration / 100).toFixed(2)} s, ${(gif.length / 1024).toFixed(0)} KB; frames ${((tShot - t0) / 1000).toFixed(1)} s, encode ${((Date.now() - tShot) / 1000).toFixed(1)} s`);
    }
  } finally {
    if (own) await own.close();
  }
  return results;
}

// ---------------------------------------------------------------- CLI

export function parseArgs(argv) {
  const opts = { layouts: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--out') opts.out = value();
    else if (a === '--layout') {
      const v = value();
      if (!REVEAL_LAYOUTS[v]) throw new Error(`--layout is one of ${Object.keys(REVEAL_LAYOUTS).join(', ')}, got ${JSON.stringify(v)}`);
      opts.layouts.push(v);
    } else throw new Error(`unknown option ${JSON.stringify(a)}; see the top of tools/record.mjs`);
  }
  if (!opts.out) throw new Error('usage: node tools/record.mjs --out <dir> [--layout wide|tall]');
  const rel = path.relative(ROOT, path.resolve(opts.out));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error(`--out ${opts.out} is inside the repository; the clips are built on deploy and never committed (decision 51)`);
  if (!opts.layouts.length) delete opts.layouts;
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    // Imported here, not at the top: tools/site.mjs imports this file while it is still running.
    const { readData, inlineFontCss } = await import('./site.mjs');
    const { doc, bytes } = readData();
    const model = buildModel(doc);
    const product = model.byName.get(SHOWCASE.drug);
    if (!product) throw new Error(`the showcase product ${JSON.stringify(SHOWCASE.drug)} is not in data/drugs.json`);
    const dataSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    await recordReveal({ model, product, out: path.resolve(opts.out), fontCss: inlineFontCss(), layouts: opts.layouts, dataSha256 });
  } catch (e) {
    console.error(`record.mjs: ${e.message}`);
    process.exitCode = 1;
  }
}
