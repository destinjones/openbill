// Browser checks for the press kit (decision 51). The site is built for the showcase alone, with
// every rendered image (preview cards, the wordmark, the three screenshots and the reveal clips),
// into a temporary folder; press/index.html is then opened from a file:// URL. Building the
// pictures takes Chromium about 15 s, so it runs once, in the mobile-light project (Chromium at
// 360px), which also looks at the page at desktop width.
//
// Expected figures are computed here from data/drugs.json with the core modules, never typed.

import { test, expect } from '@playwright/test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildSite } from '../../tools/site.mjs';
import { MAX_GIF_BYTES } from '../../tools/record.mjs';
import { decodePng } from '../../tools/gif.mjs';
import { decodeGif } from '../gifdecode.js';
import { SHOWCASE } from '../../src/build/drugpage.js';
import { PRESS_SHOTS, PRESS_WORDMARKS, WORDMARK } from '../../src/build/presspage.js';
import { REVEAL_LAYOUTS, REVEAL_DURATION_CS } from '../../src/build/reveal.js';
import { linkRows } from '../../src/core/pack.js';
import { groupProducts } from '../../src/core/search.js';
import { summarizeProduct, defaultQuantity, partDNameContext, formatSpreadMultiple } from '../../src/core/rules.js';
import { formatMoney } from '../../src/core/money.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const dataBytes = readFileSync(path.join(ROOT, 'data/drugs.json'));
const doc = JSON.parse(dataBytes.toString('utf8'));
const rows = linkRows(doc);
const show = groupProducts(rows).find((p) => p.name === SHOWCASE.drug);
const s = summarizeProduct(show.rows, defaultQuantity(show).qty, { partDContext: partDNameContext(rows) });
const WANT = {
  pharmacy: formatMoney(s.pack.min.value),
  medicare: formatMoney(s.reference.pack.min.value),
  spread: formatSpreadMultiple(s.spread.range.min.value),
};
const ACCENT = [179, 38, 30]; // the spread's red, #b3261e in src/site/reveal.css

/** PNG size and colour type, from its IHDR. */
function pngHeader(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}

function nearAccent(rgb) {
  let n = 0;
  for (let i = 0; i < rgb.length; i += 3) if (Math.abs(rgb[i] - ACCENT[0]) + Math.abs(rgb[i + 1] - ACCENT[1]) + Math.abs(rgb[i + 2] - ACCENT[2]) < 40) n += 1;
  return n;
}

test.describe('the press kit', () => {
  test.skip(({ browserName, isMobile, colorScheme }) => !(browserName === 'chromium' && isMobile && colorScheme === 'light'), 'built and checked once, in Chromium at 360px');
  test.describe.configure({ mode: 'serial' });

  let tmp;
  let press;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    tmp = mkdtempSync(path.join(os.tmpdir(), 'openbill-press-'));
    const site = await buildSite({ out: path.join(tmp, 'site'), only: [SHOWCASE.drug], log: () => {} });
    press = path.join(site.out, 'press');
  });

  test.afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test('the page loads every picture from the site itself, with no error, at 360px and at desktop width', async ({ page }) => {
    const errors = [];
    const outside = [];
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (!/^(file|data):/.test(r.url())) outside.push(r.url());
    });
    for (const size of [null, { width: 1280, height: 800 }]) {
      if (size) await page.setViewportSize(size);
      await page.goto(pathToFileURL(path.join(press, 'index.html')).href);
      await page.evaluate(() => {
        for (const img of document.images) img.loading = 'eager';
      });
      await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30_000 });
      const sizes = await page.evaluate(() => Object.fromEntries([...document.images].map((i) => [i.getAttribute('src'), [i.naturalWidth, i.naturalHeight]])));
      for (const l of Object.values(REVEAL_LAYOUTS)) expect(sizes[l.file]).toEqual([l.width, l.height]);
      for (const sh of PRESS_SHOTS) expect(sizes[sh.file]).toEqual([sh.viewport.width, sh.viewport.height]);
      for (const w of PRESS_WORDMARKS) expect(sizes[w.file]).toEqual([WORDMARK.width * WORDMARK.scale, WORDMARK.height * WORDMARK.scale]);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'no sideways scrolling').toBe(0);
      await expect(page.locator('[data-figure="pharmacy"]')).toHaveText(WANT.pharmacy);
      await expect(page.locator('[data-figure="medicare"]')).toHaveText(WANT.medicare);
      await expect(page.locator('[data-figure="spread"]')).toHaveText(WANT.spread);
      expect(await page.locator('script').count()).toBe(0);
    }
    expect(errors).toEqual([]);
    expect(outside).toEqual([]);
  });

  test('the clips: looping GIFs of 6 seconds at their stated sizes, under 3 MB, from the empty search box to the red spread', async () => {
    const sha = crypto.createHash('sha256').update(dataBytes).digest('hex');
    for (const l of Object.values(REVEAL_LAYOUTS)) {
      const buf = readFileSync(path.join(press, l.file));
      expect(buf.length, `${l.file} is ${buf.length} bytes`).toBeLessThan(MAX_GIF_BYTES);
      const g = decodeGif(buf);
      expect([g.width, g.height]).toEqual([l.width, l.height]);
      expect(g.loop, 'loops forever').toBe(0);
      expect(g.frames.reduce((a, f) => a + f.delay, 0)).toBe(REVEAL_DURATION_CS);
      expect(g.frames.length).toBeGreaterThan(30);
      expect(g.frames.at(-1).delay, 'it holds at the end').toBeGreaterThanOrEqual(100);
      // The comment names the figures, the data's sha256 and the site.
      const c = g.comments.join(' ');
      expect(c).toContain(`Pharmacies pay ${WANT.pharmacy}`);
      expect(c).toContain(`Medicare Part D paid ${WANT.medicare}`);
      expect(c).toContain(`the spread ${WANT.spread.replace('×', 'x')} (estimated)`);
      expect(c).toContain(`sha256 ${sha}`);
      // The spread is the only red: none in the first frame, plenty in the last.
      expect(nearAccent(g.frames[0].rgb)).toBe(0);
      expect(nearAccent(g.frames.at(-1).rgb)).toBeGreaterThan(500);
      if (l.still) {
        const still = decodePng(readFileSync(path.join(press, l.still)));
        expect([still.width, still.height]).toEqual([l.width, l.height]);
        let diff = 0;
        for (let i = 0; i < still.rgb.length; i++) diff += Math.abs(still.rgb[i] - g.frames.at(-1).rgb[i]);
        expect(diff / still.rgb.length, 'the still is the last frame').toBeLessThan(3);
      }
    }
  });

  test('the screenshots and the wordmarks: the sizes the page states; the wordmarks on a transparent background', async () => {
    for (const sh of PRESS_SHOTS) {
      const h = pngHeader(readFileSync(path.join(press, sh.file)));
      expect([h.width, h.height]).toEqual([sh.viewport.width, sh.viewport.height]);
    }
    for (const w of PRESS_WORDMARKS) {
      const h = pngHeader(readFileSync(path.join(press, w.file)));
      expect([h.width, h.height]).toEqual([WORDMARK.width * WORDMARK.scale, WORDMARK.height * WORDMARK.scale]);
      expect(h.colorType, 'RGBA').toBe(6);
    }
  });
});
