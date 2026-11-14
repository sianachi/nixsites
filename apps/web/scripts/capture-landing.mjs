/* global process, URL, localStorage, document, console */
/* eslint-disable no-console -- a command-line script reports each capture as it goes */
// Captures the landing page's screenshots from the server-free demo, so they show the real
// interface and can be retaken whenever it changes. Every shot is taken in the light and the dark
// colour scheme, on a desktop (1280x800) and a phone (390x844):
//   <name>.jpg, <name>-dark.jpg, <name>-phone.jpg and <name>-phone-dark.jpg.
//
// Usage: pnpm --filter @nix/web capture:landing [names] [baseUrl]
// With no baseUrl it starts the web dev server on a free port and stops it when done.
// `names` is an optional comma-separated list of shots to retake, leaving the rest as they are.
// Writes apps/web/public/landing/. Everything, habits included, comes from the demo.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const only = process.argv[2] ? process.argv[2].split(',') : null;
const out = fileURLToPath(new URL('../public/landing/', import.meta.url));
await mkdir(out, { recursive: true });

/** The dev server this script started, if it was not given a baseUrl. */
let server = null;
async function startServer() {
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  server = spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.on('exit', () => reject(new Error('the dev server stopped before it was ready')));
    server.stdout.on('data', (chunk) => {
      if (String(chunk).includes('Local:')) resolve(undefined);
    });
  });
  return `http://localhost:${port}`;
}
const baseUrl = process.argv[3] ?? (await startServer());

const DEVICES = {
  desktop: { suffix: '', viewport: { width: 1280, height: 800 }, scale: 1.25 },
  phone: { suffix: '-phone', viewport: { width: 390, height: 844 }, scale: 2, touch: true },
};

const browser = await chromium.launch();

/** The demo opened in one colour scheme on one device, with its banner and toasts kept out of frame. */
async function demoPage(colorScheme, device) {
  const page = await browser.newPage({
    viewport: device.viewport,
    deviceScaleFactor: device.scale,
    hasTouch: device.touch === true,
    isMobile: device.touch === true,
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

async function capture(scheme, deviceName) {
  const device = DEVICES[deviceName];
  const phone = deviceName === 'phone';
  const suffix = `${device.suffix}${scheme === 'dark' ? '-dark' : ''}`;
  const page = await demoPage(scheme, device);
  const shoot = async (name) => {
    if (only && !only.includes(name)) return;
    await page.mouse.move(0, 0);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${out}${name}${suffix}.jpg`, type: 'jpeg', quality: 85 });
    console.log('captured', name + suffix);
  };
  // The phone keeps the Explorer in a drawer and the pages in the bottom bar's menu.
  const openInSidebar = async (title) => {
    if (phone) {
      await page.getByRole('button', { name: 'Explorer' }).first().click();
      await page.getByText(title, { exact: true }).first().click();
    } else await page.getByText(title, { exact: true }).first().click();
  };
  const openPage = async (name) => {
    if (phone) await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole(phone ? 'menuitem' : 'link', { name, exact: true }).click();
  };
  const showView = (id) =>
    phone
      ? page.locator('select').first().selectOption({ value: id })
      : page.getByRole('button', { name: id, exact: true }).click();

  // Homebase: the workspace with nothing open.
  await openPage('Homebase');
  await page.waitForSelector('text=New note');
  await shoot('homebase');

  await openInSidebar('Launch brief');
  await page.waitForSelector('text=500 beta sign-ups');
  await shoot('note');

  // Search: the palette over the note, with the matches for "launch".
  await page.getByRole('button', { name: 'Search' }).last().click();
  await page.getByRole('combobox', { name: 'Search all workspaces' }).fill('launch');
  await page.waitForSelector('[role="option"]:has-text("Launch video")');
  await shoot('search');
  await page.keyboard.press('Escape');

  await openPage('Graph');
  await page.waitForSelector('canvas, svg');
  await page.waitForTimeout(1500);
  // This build names a graph node only on hover or selection, so show the names of the launch
  // work and Pip's chat for the picture, and leave the side branches as plain nodes. The brief and
  // the chat sit side by side, so one label moves up and the other down to stay legible.
  if (!phone) await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const hidden = new Set([
      'Habits',
      'Morning run',
      'Read 20 pages',
      'Drink water',
      'Stretch before bed',
      'Priorities',
      'Fix the leaking tap',
      'Plan the garden',
      'Reply to the group chat',
      'Sort old photos',
    ]);
    for (const text of document.querySelectorAll('svg text')) {
      const name = text.textContent ?? '';
      if (name.length < 2 || hidden.has(name)) continue;
      text.style.opacity = '1';
      if (name.startsWith('Plan launch week')) text.setAttribute('dy', '-1.1em');
      if (name === 'Launch brief') text.setAttribute('dy', '1.6em');
      if (name === 'Pricing page') text.setAttribute('dy', '1.5em');
    }
  });
  // Scroll past the controls so the drawing fills the frame.
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('#main, #main *')) {
      if (element.scrollHeight > element.clientHeight + 100) element.scrollTop = 240;
    }
  });
  await shoot('graph');

  await openInSidebar('Product launch');
  await page.waitForSelector('text=Press kit');
  // Every view kind in the app: the first ten are the launch tasks, then a saved search, the
  // file manager, a guided form and a custom view.
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
    'smart',
    'drive',
    'guided',
    'custom',
  ]) {
    await showView(view);
    // Bring the work around today into frame, and show a nested branch.
    if (view === 'timeline' && !phone) await page.getByText(/^quarter$/i).click();
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

try {
  for (const device of Object.keys(DEVICES)) {
    for (const scheme of ['light', 'dark']) await capture(scheme, device);
  }
} finally {
  await browser.close();
  server?.kill();
}
