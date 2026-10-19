// Screenshots of the built page for the README: node tools/shots.mjs
//
// Opens openbill.html from a file:// URL (offline, no network) in Playwright's Chromium and
// writes the default card at three sizes:
//   docs/img/card-360.png        360×780, light
//   docs/img/card-360-dark.png   360×780, dark
//   docs/img/card-desktop.png    1280×800, light
//
// Run `node build.js` first. Needs the dev dependency (`npm ci`, `npx playwright install chromium`).
// The page counts each source's age against today's date, so the clock is fixed to the NADAC
// file's retrieved_date from data/drugs.json (or --today=YYYY-MM-DD): the same inputs give the
// same pictures. tools/site.mjs takes the same three, with shootCards(), for the press page
// (press/card-*.png) on every deploy; the list is PRESS_SHOTS in src/build/presspage.js.

import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PRESS_SHOTS } from '../src/build/presspage.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PAGE = pathToFileURL(path.join(ROOT, 'openbill.html')).href;
const OUT = path.join(ROOT, 'docs', 'img');

export const SHOTS = PRESS_SHOTS;

function today() {
  const arg = process.argv.find((a) => a.startsWith('--today='));
  const value = arg ? arg.slice('--today='.length) : JSON.parse(readFileSync(path.join(ROOT, 'data', 'drugs.json'), 'utf8')).sources.nadac.retrieved_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new Error(`not an ISO date: ${value}`);
  return value;
}

/**
 * Screenshot the page's default card once per shot into `outDir`, with the clock fixed to `day`.
 * Stops if the page does not load its data or asks for anything outside file: and data: URLs.
 * @param {{ browser: object, page: string, outDir: string, day: string, shots?: object[], log?: (line: string) => void }} opts
 * @returns {Promise<string[]>} the files written
 */
export async function shootCards({ browser, page: url, outDir, day, shots = SHOTS, log = () => {} }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new Error(`not an ISO date: ${day}`);
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const shot of shots) {
    const context = await browser.newContext({
      viewport: shot.viewport,
      colorScheme: shot.colorScheme,
      isMobile: shot.isMobile,
      hasTouch: shot.isMobile,
      deviceScaleFactor: 1,
      offline: true,
    });
    try {
      const page = await context.newPage();
      const outside = [];
      page.on('request', (r) => {
        if (!/^(file|data):/.test(r.url())) outside.push(r.url());
      });
      await page.clock.setFixedTime(new Date(`${day}T12:00:00Z`));
      await page.goto(url);
      await page.waitForFunction(() => document.documentElement.dataset.ready, null, { timeout: 60_000 });
      const ready = await page.evaluate(() => document.documentElement.dataset.ready);
      if (ready !== 'true') throw new Error(`${url} did not load its data (data-ready=${ready})`);
      await page.evaluate(() => document.fonts.ready);
      if (outside.length) throw new Error(`the page made network requests: ${outside.join(', ')}`);
      const file = path.join(outDir, shot.file);
      await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
      written.push(file);
      log(`${shot.file}  ${shot.viewport.width}×${shot.viewport.height} ${shot.colorScheme}  (today ${day})`);
    } finally {
      await context.close();
    }
  }
  return written;
}

async function main() {
  const browser = await chromium.launch();
  try {
    await shootCards({ browser, page: PAGE, outDir: OUT, day: today(), log: (l) => console.log(`docs/img/${l}`) });
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
