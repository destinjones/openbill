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
// same pictures.

import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PAGE = pathToFileURL(path.join(ROOT, 'openbill.html')).href;
const OUT = path.join(ROOT, 'docs', 'img');

const SHOTS = [
  { file: 'card-360.png', viewport: { width: 360, height: 780 }, colorScheme: 'light', isMobile: true },
  { file: 'card-360-dark.png', viewport: { width: 360, height: 780 }, colorScheme: 'dark', isMobile: true },
  { file: 'card-desktop.png', viewport: { width: 1280, height: 800 }, colorScheme: 'light', isMobile: false },
];

function today() {
  const arg = process.argv.find((a) => a.startsWith('--today='));
  const value = arg ? arg.slice('--today='.length) : JSON.parse(readFileSync(path.join(ROOT, 'data', 'drugs.json'), 'utf8')).sources.nadac.retrieved_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new Error(`not an ISO date: ${value}`);
  return value;
}

async function main() {
  const day = today();
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const shot of SHOTS) {
      const context = await browser.newContext({
        viewport: shot.viewport,
        colorScheme: shot.colorScheme,
        isMobile: shot.isMobile,
        hasTouch: shot.isMobile,
        deviceScaleFactor: 1,
        offline: true,
      });
      const page = await context.newPage();
      const outside = [];
      page.on('request', (r) => {
        if (!/^(file|data):/.test(r.url())) outside.push(r.url());
      });
      await page.clock.setFixedTime(new Date(`${day}T12:00:00Z`));
      await page.goto(PAGE);
      await page.waitForFunction(() => document.documentElement.dataset.ready, null, { timeout: 60_000 });
      const ready = await page.evaluate(() => document.documentElement.dataset.ready);
      if (ready !== 'true') throw new Error(`openbill.html did not load its data (data-ready=${ready})`);
      await page.evaluate(() => document.fonts.ready);
      if (outside.length) throw new Error(`the page made network requests: ${outside.join(', ')}`);
      const file = path.join(OUT, shot.file);
      await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
      console.log(`${path.relative(ROOT, file).split(path.sep).join('/')}  ${shot.viewport.width}×${shot.viewport.height} ${shot.colorScheme}  (today ${day})`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
