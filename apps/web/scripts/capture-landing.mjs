/* global process, URL, localStorage, console */
/* eslint-disable no-console -- a command-line script reports each capture as it goes */
// Captures the landing page's screenshots from the server-free demo, so they show the real
// interface and can be retaken whenever it changes.
//
// Usage: start the web dev server (`pnpm --filter @nix/web dev`), then
//   node apps/web/scripts/capture-landing.mjs [baseUrl]
// Writes apps/web/public/landing/<name>.jpg, and companion.png (the pet's panel over its seeded
// chat). Habits are not in the demo and keep their hand-taken picture.
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const out = fileURLToPath(new URL('../public/landing/', import.meta.url));
await mkdir(out, { recursive: true });

const browser = await chromium.launch();

async function demoPage(colorScheme) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1.25,
    colorScheme,
  });
  await page.route('**/web-config.json', (route) =>
    route.fulfill({ json: { landing: true, demo: true } }),
  );
  await page.addInitScript(() => localStorage.removeItem('nix.theme'));
  await page.goto(`${baseUrl}/demo`);
  await page.waitForSelector('text=Press kit');
  await page.addStyleTag({ content: 'aside[aria-label="Demo"] { display: none !important; }' });
  return page;
}

async function shoot(page, name, type = 'jpeg') {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
  await page.screenshot(
    type === 'png'
      ? { path: `${out}${name}.png`, type }
      : { path: `${out}${name}.jpg`, type, quality: 85 },
  );
  console.log('captured', name);
}

const page = await demoPage('light');
const openInSidebar = (title) => page.getByText(title, { exact: true }).first().click();
const showView = (name) => page.getByRole('button', { name, exact: true }).click();

await openInSidebar('Launch brief');
await page.waitForSelector('text=500 beta sign-ups');
await shoot(page, 'note');

await openInSidebar('Product launch');
await page.waitForSelector('text=Press kit');
for (const view of [
  'board',
  'list',
  'calendar',
  'timeline',
  'sheet',
  'gallery',
  'checklist',
  'chart',
  'outline',
  'form',
]) {
  await showView(view);
  // Bring the work around today into frame, and show a nested branch.
  if (view === 'timeline') await page.getByText(/^quarter$/i).click();
  if (view === 'outline') {
    await page
      .locator('#main')
      .getByRole('treeitem', { name: /Launch video/ })
      .focus();
    await page.keyboard.press('ArrowRight');
  }
  await shoot(page, view);
}

await openInSidebar('Priorities');
await page.waitForSelector('text=Fix the leaking tap');
await shoot(page, 'matrix');

await openInSidebar('Plan launch week with Pip');
await page.waitForSelector('text=Sources: Northwind Studio');
await page.getByRole('button', { name: 'Talk with Pip' }).click();
await page.waitForSelector('text=Remembered: Prefers Friday launches');
await shoot(page, 'companion', 'png');

const dark = await demoPage('dark');
await shoot(dark, 'dark-theme');

await browser.close();
