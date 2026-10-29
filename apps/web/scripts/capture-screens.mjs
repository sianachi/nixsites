/* global process, URL, console, document */
/* eslint-disable no-console -- a command-line script reports each capture as it goes */
// Screenshots every screen listed in a manifest, in light and dark, desktop and phone, so two
// runs can be compared byte for byte (a refactor must not move a pixel) and reviewed side by side.
//
// Usage, with the web dev server running against a signed-in local stack:
//   node apps/web/scripts/capture-screens.mjs login <state.json> [baseUrl]
//     opens a window; sign in, and it saves the session once the workspace menu shows.
//   node apps/web/scripts/capture-screens.mjs capture <manifest.json> <outDir> <state.json> [baseUrl]
//   node apps/web/scripts/capture-screens.mjs compare <dirA> <dirB>
// Pass "-" as <state.json> for screens that need no session, such as /demo.
// A manifest is { "fixedTime"?: ISO, "webConfig"?: object, "screens": [{ "name", "url",
// "steps"?: Step[] }] }, where a step is { "click": { "role", "name" } } | { "clickText": text }
// | { "press": key } | { "text": waitForText }. Console errors are printed per screen.
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [mode, ...args] = process.argv.slice(2);
const VARIANTS = [
  { id: 'desktop-light', colorScheme: 'light', viewport: { width: 1440, height: 900 } },
  { id: 'desktop-dark', colorScheme: 'dark', viewport: { width: 1440, height: 900 } },
  { id: 'phone-light', colorScheme: 'light', viewport: { width: 390, height: 844 }, mobile: true },
  { id: 'phone-dark', colorScheme: 'dark', viewport: { width: 390, height: 844 }, mobile: true },
];

if (mode === 'login') await login(args[0], args[1] ?? 'http://localhost:5173');
else if (mode === 'capture')
  await capture(args[0], args[1], args[2], args[3] ?? 'http://localhost:5173');
else if (mode === 'compare') await compare(args[0], args[1]);
else {
  console.error('usage: capture-screens.mjs login|capture|compare …');
  process.exit(2);
}

async function login(statePath, baseUrl) {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseUrl);
  console.log('Sign in in the window that opened; waiting up to 10 minutes.');
  await page.getByRole('button', { name: /, workspace menu$/ }).waitFor({ timeout: 600_000 });
  await context.storageState({ path: statePath });
  console.log('saved session to', statePath);
  await browser.close();
}

async function capture(manifestPath, outDir, statePath, baseUrl) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  let failures = 0;
  for (const variant of VARIANTS) {
    const context = await browser.newContext({
      ...(statePath === '-' ? {} : { storageState: statePath }),
      viewport: variant.viewport,
      colorScheme: variant.colorScheme,
      reducedMotion: 'reduce',
      ...(variant.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : {}),
    });
    const page = await context.newPage();
    if (manifest.webConfig)
      await page.route('**/web-config.json', (route) =>
        route.fulfill({ json: manifest.webConfig }),
      );
    let screenName = '';
    page.on('console', (message) => {
      if (message.type() === 'error') console.error('console error', screenName, message.text());
    });
    page.on('pageerror', (error) => console.error('page error', screenName, error.message));
    // A fixed clock keeps "today", relative times and calendars identical between runs.
    if (manifest.fixedTime) await page.clock.setFixedTime(new Date(manifest.fixedTime));
    for (const screen of manifest.screens) {
      const file = join(outDir, `${screen.name}--${variant.id}.png`);
      screenName = `${screen.name} ${variant.id}`;
      try {
        await page.goto(new URL(screen.url, baseUrl).href);
        await page.waitForLoadState('networkidle');
        for (const step of screen.steps ?? []) await run(page, step);
        await settle(page);
        await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
        console.log('captured', screen.name, variant.id);
      } catch (error) {
        failures += 1;
        console.error('FAILED', screen.name, variant.id, error.message.split('\n')[0]);
      }
    }
    await context.close();
  }
  await browser.close();
  if (failures > 0) process.exitCode = 1;
}

async function run(page, step) {
  if (step.click)
    await page.getByRole(step.click.role, { name: step.click.name, exact: true }).first().click();
  else if (step.clickText) await page.getByText(step.clickText, { exact: true }).first().click();
  else if (step.press) await page.keyboard.press(step.press);
  else if (step.text) await page.getByText(step.text, { exact: false }).first().waitFor();
}

async function settle(page) {
  await page.mouse.move(0, 0);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => document.querySelector('[aria-busy="true"]') === null, null, {
    timeout: 10_000,
  });
  await page.waitForTimeout(500);
}

async function compare(dirA, dirB) {
  const names = new Set([...(await readdir(dirA)), ...(await readdir(dirB))]);
  const changed = [];
  for (const name of [...names].sort()) {
    const [a, b] = await Promise.all(
      [dirA, dirB].map((dir) => readFile(join(dir, name)).catch(() => null)),
    );
    if (a === null || b === null)
      changed.push(`${a === null ? 'only in B' : 'only in A'}: ${name}`);
    else if (!a.equals(b)) changed.push(`differs: ${name}`);
  }
  console.log(`${names.size - changed.length} identical, ${changed.length} not`);
  for (const line of changed) console.log(line);
  if (changed.length > 0) process.exitCode = 1;
}
