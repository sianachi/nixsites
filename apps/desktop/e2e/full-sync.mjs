import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, deliverCallback, external, launch, newProfile, sql, store } from './harness.mjs';

// Sign-in, sync, offline launch, offline rename, replay, against a real server you can sign in to:
//   pnpm --filter @nix/desktop test:full-sync http://nix.localhost
// A browser window opens: sign in there, without clicking the app's window meanwhile (coming back
// to it cancels the sign-in). This never types a password. It creates one note in your first
// workspace and trashes it at the end.

const server = process.argv[2];
assert.ok(server, 'Name the server, for example http://nix.localhost');
const OFFLINE = '--host-resolver-rules=MAP * ~NOTFOUND';
const profile = newProfile();
const step = (text) => {
  console.log(`• ${text}`);
};
async function until(what, check, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });
  }
}
const api = (page, method, path, body) =>
  page.evaluate(
    async ([verb, url, payload]) => {
      const { accessToken } = await (await fetch('/auth/session')).json();
      const response = await fetch(url, {
        method: verb,
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      if (!response.ok)
        throw new Error(`${verb} ${url}: ${response.status} ${await response.text()}`);
      return response.status === 204 ? null : response.json();
    },
    [method, path, body],
  );

let { app, page } = await launch(profile);
await page.fill('#address', server);
await page.click('button[type=submit]');
await page.waitForURL(`${server}/**`, { timeout: 20_000 });
await page.getByRole('button', { name: /Continue with SSO/i }).click();
const loginUrl = await until('the login address', async () => (await external(app))[0], 10);

const browser = await chromium.launch({ headless: false });
const tab = await (await browser.newContext()).newPage();
let callback = null;
tab.on('response', (response) => {
  const location = response.headers().location;
  if (location?.startsWith('app.nix.shell://')) callback = location;
});
await tab.goto(loginUrl);
step('Sign in in the browser window that just opened.');
await until('you to sign in', async () => callback, 300);
await browser.close();
// A server from before the issuer parameter: add it, as the only thing this run cannot prove.
await deliverCallback(
  app,
  callback.includes('&iss=') ? callback : `${callback}&iss=${encodeURIComponent(server)}`,
);
await until('the session', () =>
  page.evaluate(async () => (await (await fetch('/auth/session')).json()).authenticated),
);
step('Signed in through the handoff.');

const workspaceId = await until(
  'the first sync',
  async () => (await sql(page, 'SELECT workspace_id AS id FROM mirror_item LIMIT 1'))[0]?.id,
  180,
);
const counts = async () => ({
  items: (await sql(page, 'SELECT count(*) AS n FROM mirror_item'))[0].n,
  bodies: (await sql(page, 'SELECT count(*) AS n FROM mirror_body'))[0].n,
  ...(await store(page, { op: 'usage' })),
});
step(`Synced: ${JSON.stringify(await counts())}`);

const title = `Desktop sync test ${Date.now()}`;
const note = await api(page, 'POST', `/api/v1/workspaces/${workspaceId}/items`, {
  type: 'prose',
  title,
});
step(`Created "${title}" on the server.`);
await page.reload();
await until(
  'the note to reach the offline copy',
  async () => (await sql(page, 'SELECT id FROM mirror_item WHERE id=?', [note.id])).length === 1,
);
step('It reached the offline copy.');
await page.waitForFunction(
  async () => (await navigator.serviceWorker.ready).active?.state === 'activated',
);
await app.close();

({ app, page } = await launch(profile, [OFFLINE]));
await until(
  'the offline launch',
  async () => {
    const text = await page.evaluate(() => document.body.innerText);
    return (
      !/Continue with SSO|can.t reach its server|Restoring session/.test(text) && text.trim() !== ''
    );
  },
  60,
);
assert.equal(
  await page.evaluate(() =>
    fetch('/auth/session', { cache: 'no-store' }).then(
      () => 'reached',
      () => 'blocked',
    ),
  ),
  'blocked',
);
step('Launched offline, signed in, from the copy.');
await page.goto(`${server}/w/${workspaceId}?item=${note.id}`);
const renamed = `${title} renamed offline`;
const titleField = page.getByRole('textbox', { name: /title/i }).first();
await titleField.waitFor({ timeout: 30_000 });
assert.equal(await titleField.inputValue(), title);
await page.screenshot({ path: join(profile, '..', 'nix-desktop-offline.png') });
await titleField.fill(renamed);
await titleField.press('Enter');
await until(
  'the rename to queue',
  async () => (await sql(page, 'SELECT count(*) AS n FROM mirror_outbox'))[0].n > 0,
  20,
);
step('Renamed offline: queued in the outbox.');
await app.close();

({ app, page } = await launch(profile));
await until(
  'the replay to reach the server',
  async () => (await api(page, 'GET', `/api/v1/items/${note.id}`)).title === renamed,
);
await until(
  'the outbox to empty',
  async () => (await sql(page, 'SELECT count(*) AS n FROM mirror_outbox'))[0].n === 0,
);
step('Back online: the rename reached the server and the outbox emptied.');

await api(page, 'DELETE', `/api/v1/items/${note.id}`);
step('Trashed the test note.');
await page.evaluate(() => {
  void window.Capacitor.nativePromise('NixShell', 'showPicker');
});
await page.waitForURL(/picker\/index\.html/);
await page.click('li button[aria-label^=Remove]');
await page.waitForFunction(() => /Removed/.test(document.getElementById('status').textContent));
step('Removed the server: its offline copy is gone.');
await app.close();
rmSync(profile, { recursive: true, force: true });
console.log('FULL SYNC PASSED');
