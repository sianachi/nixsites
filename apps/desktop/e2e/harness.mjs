import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { _electron, chromium } from 'playwright';

export { chromium };

const appDir = dirname(import.meta.dirname);
/** Outside Electron, the npm package's export is the path to its binary. */
const executablePath = createRequire(import.meta.url)('electron');

export const newProfile = () => mkdtempSync(join(tmpdir(), 'nix-desktop-e2e-'));

/** Runs the unpackaged app. `shell.openExternal` only records, so no real browser opens. */
export async function launch(profile, args = []) {
  const app = await _electron.launch({
    executablePath,
    args: [appDir, `--user-data-dir=${profile}`, ...args],
    timeout: 60_000,
  });
  await app.evaluate(({ shell }) => {
    globalThis.__external = [];
    shell.openExternal = async (url) => {
      globalThis.__external.push(url);
    };
  });
  return { app, page: await app.firstWindow() };
}

export const external = (app) => app.evaluate(() => globalThis.__external);

export const store = (page, request) =>
  page.evaluate((body) => window.webkit.messageHandlers.nixStore.postMessage(body), request);

export const sql = async (page, text, params = []) =>
  (await store(page, { op: 'execute', sql: text, params })).rows;

/** What the OS does with the sign-in callback; only a packaged app can receive the real one. */
export const deliverCallback = (app, url) =>
  app.evaluate(({ app: electronApp }, callback) => {
    electronApp.emit('open-url', { preventDefault() {} }, callback);
  }, url);
