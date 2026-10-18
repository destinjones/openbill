// Browser checks for the built pages (tests/browser/*.spec.js), loaded from file:// URLs.
// Run `node build.js` first; `npx playwright test` then checks openbill.html and methodology.html
// at 360px (phone) and 1280px (desktop), in light and dark, in Chromium, and in Firefox and
// WebKit (Safari's engine). Install the browsers once with
// `npx playwright install chromium firefox webkit`.

import { defineConfig } from '@playwright/test';

const phone = { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const desktop = { viewport: { width: 1280, height: 800 } };

export default defineConfig({
  testDir: 'tests/browser',
  testMatch: '**/*.spec.js',
  outputDir: 'test-results',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'mobile-light', use: { browserName: 'chromium', ...phone, colorScheme: 'light' } },
    { name: 'mobile-dark', use: { browserName: 'chromium', ...phone, colorScheme: 'dark' } },
    { name: 'desktop-light', use: { browserName: 'chromium', ...desktop, colorScheme: 'light' } },
    { name: 'desktop-dark', use: { browserName: 'chromium', ...desktop, colorScheme: 'dark' } },
    // Firefox has no mobile emulation in Playwright, so it runs the desktop viewport.
    { name: 'firefox-desktop-light', use: { browserName: 'firefox', ...desktop, colorScheme: 'light' } },
    { name: 'webkit-mobile-light', use: { browserName: 'webkit', ...phone, colorScheme: 'light' } },
    { name: 'webkit-desktop-dark', use: { browserName: 'webkit', ...desktop, colorScheme: 'dark' } },
  ],
});
