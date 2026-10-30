/* global process, URL, localStorage, document, console */
/* eslint-disable no-console -- a command-line script reports each capture as it goes */
// Captures the landing page's screenshots from the server-free demo, so they show the real
// interface and can be retaken whenever it changes. Every shot is taken twice, in the light and
// the dark colour scheme: <name>.jpg and <name>-dark.jpg.
//
// Usage: start the web dev server (`pnpm --filter @nix/web dev`), then
//   node apps/web/scripts/capture-landing.mjs [baseUrl]
// Writes apps/web/public/landing/. Everything, habits included, comes from the demo.
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const out = fileURLToPath(new URL('../public/landing/', import.meta.url));
await mkdir(out, { recursive: true });

const browser = await chromium.launch();

/** The demo opened in one colour scheme, with its banner and toasts kept out of frame. */
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
  await page.addStyleTag({
    content:
      'aside[aria-label="Demo"], [role="status"][data-toast], [data-toast] { display: none !important; }',
  });
  return page;
}

async function capture(scheme) {
  const suffix = scheme === 'dark' ? '-dark' : '';
  const page = await demoPage(scheme);
  const shoot = async (name) => {
    await page.mouse.move(0, 0);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${out}${name}${suffix}.jpg`, type: 'jpeg', quality: 85 });
    console.log('captured', name + suffix);
  };
  const openInSidebar = (title) => page.getByText(title, { exact: true }).first().click();
  const showView = (name) => page.getByRole('button', { name, exact: true }).click();

  // Homebase: the workspace with nothing open.
  await page.getByRole('link', { name: 'Homebase' }).click();
  await page.waitForSelector('text=New note');
  await shoot('homebase');

  await openInSidebar('Launch brief');
  await page.waitForSelector('text=500 beta sign-ups');
  await shoot('note');

  // Search: the palette over the note, with the matches for "launch".
  await page.getByRole('button', { name: 'Search' }).first().click();
  await page.getByRole('combobox').fill('launch');
  await page.waitForSelector('[role="option"]:has-text("Launch video")');
  await shoot('search');
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: 'Graph' }).click();
  await page.waitForSelector('canvas, svg');
  await page.waitForTimeout(1500);
  // Scroll past the controls so the drawing fills the frame.
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('#main, #main *')) {
      if (element.scrollHeight > element.clientHeight + 100) element.scrollTop = 240;
    }
  });
  await shoot('graph');

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
    await shoot(view);
  }

  await openInSidebar('Priorities');
  await page.waitForSelector('text=Fix the leaking tap');
  await shoot('matrix');

  await openInSidebar('Habits');
  await page.waitForSelector('text=Morning run');
  await page.getByText('Week', { exact: true }).first().click();
  await page.waitForSelector('text=Habit options');
  await shoot('habits');

  await openInSidebar('Launch budget');
  await page.waitForSelector('text=Planned spend');
  await shoot('artifact');

  await openInSidebar('Plan launch week with Pip');
  await page.waitForSelector('text=Sources: Northwind Studio');
  await page.getByRole('button', { name: 'Talk with Pip' }).click();
  await page.waitForSelector('text=Remembered: Prefers Friday launches');
  await shoot('companion');

  await page.close();
}

await capture('light');
await capture('dark');
await browser.close();
