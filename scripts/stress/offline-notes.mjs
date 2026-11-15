/* global navigator, WebSocket, URL, fetch, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, console */

// Run against a built local PWA with NIX_OFFLINE_WEB_URL, NIX_OFFLINE_PROFILE and
// NIX_OFFLINE_WORKSPACE. Login uses NIX_OFFLINE_USERNAME/NIX_OFFLINE_PASSWORD or
// the development account (dev@nix.localhost). Failure preserves recovery data.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

function localOrigin(value) {
  const url = new URL(value);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Use a local test server.');
  assert(['http:', 'https:'].includes(url.protocol), 'Use an HTTP or HTTPS origin.');
  assert.equal(url.href, `${url.origin}/`, 'Use an origin without a path or credentials.');
  return url.origin;
}

if (process.argv.includes('--self-test')) {
  assert.equal(localOrigin('http://localhost:5173'), 'http://localhost:5173');
  assert.equal(localOrigin('http://127.0.0.1:5173/'), 'http://127.0.0.1:5173');
  assert.equal(localOrigin('http://[::1]:5173'), 'http://[::1]:5173');
  for (const value of [
    'https://nix.example.org',
    'http://localhost:5173/w/test',
    'ftp://localhost',
    'http://user:secret@localhost',
  ]) {
    assert.throws(() => localOrigin(value));
  }
  process.stdout.write('Offline acceptance configuration checks passed.\n');
  process.exit(0);
}

const repository = resolve(import.meta.dirname, '../..');
const requireFromWeb = createRequire(resolve(repository, 'apps/web/package.json'));
const playwright = requireFromWeb('playwright');
const decoding = requireFromWeb('lib0/decoding');
const browserName = process.env.NIX_OFFLINE_BROWSER ?? 'chromium';
assert(['chromium', 'webkit'].includes(browserName), 'Choose chromium or webkit.');
const browserType = playwright[browserName];
const origin = localOrigin(process.env.NIX_OFFLINE_WEB_URL ?? 'http://localhost:5173');
const collabOrigin = process.env.NIX_OFFLINE_COLLAB_URL
  ? localOrigin(process.env.NIX_OFFLINE_COLLAB_URL)
  : null;
const profile = process.env.NIX_OFFLINE_PROFILE;
const workspace = process.env.NIX_OFFLINE_WORKSPACE;
assert(profile, 'Set NIX_OFFLINE_PROFILE to an authenticated local nixctl profile.');
assert(
  workspace && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(workspace),
  'Set NIX_OFFLINE_WORKSPACE to a dedicated test workspace UUID.',
);
const runFile = promisify(execFile);
const cli = process.env.NIXCTL_BIN ?? resolve(repository, 'deploy/compose/nixctl.sh');

async function nixctl(args, stdin) {
  const child = runFile(cli, ['--profile', profile, '--json', ...args], {
    cwd: repository,
    timeout: 90_000,
    maxBuffer: 1_048_576,
  });
  child.child.stdin.end(stdin);
  const { stdout } = await child.catch(() => {
    throw new Error(
      `nixctl ${args.slice(0, 2).join(' ')} failed; check the local profile and service logs.`,
    );
  });
  return JSON.parse(stdout);
}

const auth = await nixctl(['auth', 'status']);
const callbackOrigin = localOrigin(auth.apiUrl);
await nixctl(['item', 'ls', '--workspace', workspace]);
const username = process.env.NIX_OFFLINE_USERNAME ?? 'dev@nix.localhost';
const password = process.env.NIX_OFFLINE_PASSWORD ?? 'nix-dev-password';

const directory = await mkdtemp(resolve(tmpdir(), 'nix-offline-acceptance-'));
const userData = resolve(directory, 'browser');
const runId = `${browserName}-${String(Date.now())}`;
const initialText = `Original note ${runId}`;
const offlineText = `Offline edit ${runId}`;
const concurrentText = `Concurrent web edit ${runId}`;
const workspaceEditText = `Workspace draft before sign-out ${runId}`;
const createdText = `Offline new note body ${runId}`;
const createdTitle = `Offline capture ${runId}`;
let root;
let context;
let counterpart;
let page;
let succeeded = false;
const deadlineTimer = setTimeout(() => {
  process.stderr.write(
    `Offline acceptance exceeded 15 minutes. Recovery data: ${directory}. Disposable root: ${root?.id ?? 'not created'}.\n`,
  );
  process.exit(1);
}, 15 * 60_000);
deadlineTimer.unref();
const persisted = new Map();

async function residentDocuments(stage) {
  if (collabOrigin === null) return;
  const response = await fetch(`${collabOrigin}/metrics`, { signal: AbortSignal.timeout(10_000) });
  assert(response.ok, 'The local Collab metrics endpoint must be available.');
  const metrics = await response.text();
  const resident = /^nix_collab_loaded_documents (\d+)$/mu.exec(metrics)?.[1];
  assert(resident !== undefined, 'Collab must expose its resident document count.');
  process.stdout.write(`Collab resident documents ${stage}: ${resident}.\n`);
}

async function waitForAllNotes() {
  const status = page.getByRole('complementary', { name: 'Offline notes status', exact: true });
  let lastProgress = '';
  const progress = setInterval(() => {
    void status
      .getByRole('status')
      .innerText()
      .then(async (message) => {
        const alerts = await status.getByRole('alert').allTextContents();
        if (alerts.length > 0) message += ` ${alerts.join(' ')}`;
        if (message !== lastProgress) {
          lastProgress = message;
          process.stdout.write(`${message}\n`);
        }
      })
      .catch(() => undefined);
  }, 30_000);
  try {
    await status
      .getByText('All unlocked notes are available offline.', { exact: true })
      .waitFor({ timeout: 10 * 60_000 });
  } finally {
    clearInterval(progress);
  }
}

async function observePersistence(target) {
  let authenticated = null;
  target.on('pageerror', (error) => {
    process.stdout.write(`Browser page error: ${error.stack ?? error.message}\n`);
  });
  const closePrefix = 'Offline acceptance WebSocket closed: ';
  target.on('console', (message) => {
    if (message.text().startsWith(closePrefix)) process.stdout.write(`${message.text()}\n`);
  });
  await target.addInitScript((prefix) => {
    const NativeWebSocket = WebSocket;
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('close', (event) => {
          // eslint-disable-next-line no-console -- Forward browser socket diagnostics to the runner.
          console.info(
            `${prefix}${JSON.stringify({
              path: new URL(this.url).pathname,
              code: event.code,
              tokenExpired: event.reason === 'The session token has expired. Reconnect.',
              authorizationRevoked: event.reason === 'This session is no longer authorized.',
            })}`,
          );
        });
      }
    };
  }, closePrefix);
  target.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    const itemId = /\/documents\/([^/]+)\/updates$/u.exec(path)?.[1];
    if (itemId && response.request().method() === 'POST' && response.status() === 202) {
      persisted.set(itemId, (persisted.get(itemId) ?? 0) + 1);
    }
    if (path === '/auth/session' && response.ok()) {
      void response
        .json()
        .then((session) => {
          authenticated = session.authenticated === true;
          process.stdout.write(`Browser session restored: ${String(session.authenticated)}.\n`);
        })
        .catch(() => undefined);
    }
    if (response.status() >= 400 && /^\/(?:auth\/|api\/v1\/|collab\/)/u.test(path)) {
      process.stdout.write(
        `${JSON.stringify({
          method: response.request().method(),
          path,
          status: response.status(),
          authorizationHeaderPresent: Boolean(response.request().headers().authorization),
          lastSessionAuthenticated: authenticated,
        })}\n`,
      );
    }
  });
  target.on('websocket', (socket) => {
    const itemId = /\/documents\/([^/]+)\/ws$/u.exec(new URL(socket.url()).pathname)?.[1];
    if (!itemId) return;
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string') return;
      const decoder = decoding.createDecoder(new Uint8Array(payload));
      if (decoding.readVarUint(decoder) === 3) {
        decoding.readVarString(decoder);
        persisted.set(itemId, (persisted.get(itemId) ?? 0) + 1);
      }
    });
  });
}

async function persistenceBarrier(itemId, previous) {
  const deadline = Date.now() + 90_000;
  while ((persisted.get(itemId) ?? 0) <= previous) {
    assert(Date.now() < deadline, `The server did not acknowledge persistence for ${itemId}.`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

async function durableBody(itemId, values) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = await nixctl(['note', 'read', itemId]);
    if (values.every((value) => result.markdown.includes(value))) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`The committed body for ${itemId} did not contain the expected edits.`);
}

function itemUrl(itemId) {
  return `${origin}/w/${workspace}?item=${itemId}`;
}

function offlineUrl(itemId) {
  return `${origin}/offline?workspace=${workspace}${itemId ? `&item=${itemId}` : ''}`;
}

function body(target) {
  return target.getByRole('textbox', { name: 'Note body', exact: true });
}

async function signIn(target, url) {
  await target.goto(url, { waitUntil: 'domcontentloaded' });
  const email = target.getByLabel('Email');
  await body(target).or(email).first().waitFor();
  if (await email.isVisible()) {
    await email.fill(username);
    await target.getByLabel('Password').fill(password);
    await target.getByRole('button', { name: 'Sign in', exact: true }).click();
    await target.waitForURL((value) => value.origin === origin || value.origin === callbackOrigin);
    await target.goto(url, { waitUntil: 'domcontentloaded' });
  }
  await body(target).waitFor();
}

async function openPersistent(offline, url) {
  context = await browserType.launchPersistentContext(userData, {
    headless: process.env.NIX_OFFLINE_HEADED !== '1',
    viewport: { width: 1440, height: 900 },
    offline,
    serviceWorkers: 'allow',
  });
  context.setDefaultTimeout(45_000);
  context.setDefaultNavigationTimeout(45_000);
  page = context.pages()[0] ?? (await context.newPage());
  await observePersistence(page);
  if (offline) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (new URL(url).pathname === '/offline' && !new URL(url).searchParams.has('item')) {
      await page.getByRole('heading', { name: 'Notes on this device', exact: true }).waitFor();
    } else await body(page).waitFor();
  } else await signIn(page, url);
}

async function hasText(target, values, timeout = 45_000) {
  for (const value of values) {
    await body(target).getByText(value, { exact: false }).first().waitFor({ timeout });
  }
}

async function append(target, text) {
  const editor = body(target);
  await editor.click();
  await editor.press('ControlOrMeta+End');
  await editor.press('Enter');
  await target.keyboard.insertText(text);
  await hasText(target, [text]);
}

async function locallySaved(target) {
  await target
    .getByText(/saved on this device|saved offline/i)
    .first()
    .waitFor();
}

async function keepEditing(target, workspaceMenu = false) {
  if (workspaceMenu) {
    assert(
      typeof auth.principal?.displayName === 'string',
      'The profile must identify the account menu.',
    );
    await target.getByRole('button', { name: auth.principal.displayName, exact: true }).click();
    const account = target
      .getByRole('dialog', { name: 'Account', exact: true })
      .or(target.getByRole('menu', { name: 'Account', exact: true }));
    await account
      .getByRole('button', { name: 'Sign out', exact: true })
      .or(account.getByRole('menuitem', { name: 'Sign out', exact: true }))
      .click();
  } else await target.getByRole('button', { name: 'Sign out', exact: true }).click();
  const pending = target.getByRole('dialog', {
    name: 'Sign out with pending changes?',
    exact: true,
  });
  const confirmation = workspaceMenu
    ? pending.or(
        target.getByRole('dialog', { name: 'Sign out and remove local notes?', exact: true }),
      )
    : pending;
  await confirmation.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await confirmation.waitFor({ state: 'hidden' });
}

async function flushThroughNavigation(itemId, title) {
  const search = page.getByRole('searchbox', { name: 'Search saved notes', exact: true });
  await search.fill(root.title);
  const notes = page.getByRole('navigation', { name: 'Saved notes', exact: true });
  await notes.getByRole('button', { name: new RegExp(`^${root.title}`) }).click();
  await page.waitForURL((url) => url.searchParams.get('item') === root.id);
  await search.fill(title);
  await notes.getByRole('button', { name: new RegExp(`^${title}`) }).click();
  await page.waitForURL((url) => url.searchParams.get('item') === itemId);
  await body(page).waitFor();
}

try {
  await residentDocuments('before acceptance');
  root = await nixctl([
    'item',
    'create',
    '--workspace',
    workspace,
    '--title',
    `Offline acceptance ${runId}`,
  ]);
  await nixctl(['note', 'write', root.id], `Parent note ${runId}\n`);
  const nested = await nixctl([
    'item',
    'create',
    '--workspace',
    workspace,
    '--parent',
    root.id,
    '--title',
    `Unopened nested note ${runId}`,
  ]);
  await nixctl(['note', 'write', nested.id], `${initialText}\n`);
  await openPersistent(false, itemUrl(root.id));
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  process.stdout.write('Authenticated built PWA; waiting for all accessible notes to download.\n');
  await waitForAllNotes();
  await residentDocuments('after all-note download');
  process.stdout.write('Initial download completed, including the unopened nested note.\n');
  const beforeWorkspace = persisted.get(root.id) ?? 0;
  await append(page, workspaceEditText);
  await keepEditing(page, true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await hasText(page, [workspaceEditText]);
  await persistenceBarrier(root.id, beforeWorkspace);
  await durableBody(root.id, [workspaceEditText]);
  process.stdout.write('Workspace sign-out confirmation kept the immediate edit through reload.\n');

  await context.close();
  await openPersistent(true, offlineUrl());
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption(workspace);
  const offlineStatus = page.getByRole('complementary', {
    name: 'Offline notes status',
    exact: true,
  });
  await offlineStatus.getByText(/^[1-9]\d* notes? available on this device\.$/u).waitFor();
  const available = await offlineStatus.getByRole('status').innerText();
  assert(
    /^[1-9]\d* notes? available on this device\.$/u.test(available),
    'Report the loaded offline corpus size.',
  );
  process.stdout.write(`${available}\n`);
  await page.getByRole('searchbox', { name: 'Search saved notes', exact: true }).fill(nested.title);
  await page
    .getByRole('navigation', { name: 'Saved notes', exact: true })
    .getByRole('button', { name: new RegExp(`^${nested.title}`) })
    .click();
  await hasText(page, [initialText]);
  await append(page, offlineText);
  await keepEditing(page);
  await hasText(page, [offlineText]);
  process.stdout.write('Offline sign-out confirmation kept the immediate unsynced edit.\n');
  await locallySaved(page);
  await flushThroughNavigation(nested.id, nested.title);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await hasText(page, [initialText, offlineText]);
  await context.close();
  await openPersistent(true, offlineUrl(nested.id));
  await hasText(page, [initialText, offlineText]);
  process.stdout.write('Offline opening and editing survived reload and a cold browser restart.\n');

  counterpart = await browserType.launch();
  const online = await counterpart.newContext({ viewport: { width: 1440, height: 900 } });
  const onlinePage = await online.newPage();
  await observePersistence(onlinePage);
  online.setDefaultTimeout(45_000);
  await signIn(onlinePage, itemUrl(nested.id));
  await hasText(onlinePage, [initialText]);
  const beforeConcurrent = persisted.get(nested.id) ?? 0;
  await append(onlinePage, concurrentText);
  await persistenceBarrier(nested.id, beforeConcurrent);
  await durableBody(nested.id, [initialText, concurrentText]);

  await page.goto(offlineUrl(), { waitUntil: 'domcontentloaded' });
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption(workspace);
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New note', exact: true });
  await dialog.getByRole('textbox', { name: 'Note title', exact: true }).fill(createdTitle);
  await dialog.getByRole('combobox', { name: 'Create in', exact: true }).selectOption(root.id);
  await dialog.getByRole('button', { name: 'Create note', exact: true }).click();
  await page.waitForURL(
    (url) => url.searchParams.get('item') !== null && url.searchParams.get('item') !== root.id,
  );
  const createdId = new URL(page.url()).searchParams.get('item');
  assert(createdId, 'The new note must have a stable item identity.');
  await append(page, createdText);
  await locallySaved(page);
  await flushThroughNavigation(createdId, createdTitle);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await hasText(page, [createdText]);
  await context.close();
  await openPersistent(true, offlineUrl(createdId));
  await hasText(page, [createdText]);
  process.stdout.write('Offline creation survived reload and a cold browser restart.\n');

  const beforeReconnect = persisted.get(nested.id) ?? 0;
  await context.setOffline(false);
  await hasText(onlinePage, [offlineText], 5 * 60_000);
  await persistenceBarrier(nested.id, beforeReconnect);
  await durableBody(nested.id, [initialText, offlineText, concurrentText]);
  let created;
  let children;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    children = await nixctl(['item', 'ls', '--workspace', workspace, '--parent', root.id]);
    created = children.items.find((item) => item.title === createdTitle);
    if (created) break;
    await new Promise((done) => setTimeout(done, 500));
  }
  assert(created, 'The new note was not published within three minutes.');
  created = await nixctl(['item', 'get', created.id]);
  assert.equal(created.parentId, root.id);
  assert.equal(created.title, createdTitle);
  await persistenceBarrier(created.id, 0);
  await durableBody(created.id, [createdText]);
  await context.close();
  await openPersistent(false, offlineUrl(createdId));
  await hasText(page, [createdText]);
  children = await nixctl(['item', 'ls', '--workspace', workspace, '--parent', root.id]);
  assert.equal(
    children.items.filter((item) => item.title === createdTitle).length,
    1,
    'Reconnection must publish one new note.',
  );

  await online.close();
  const authoritative = await counterpart.newContext({ viewport: { width: 1440, height: 900 } });
  authoritative.setDefaultTimeout(45_000);
  const serverPage = await authoritative.newPage();
  await signIn(serverPage, itemUrl(nested.id));
  await hasText(serverPage, [initialText, offlineText, concurrentText]);
  await serverPage.goto(itemUrl(created.id), { waitUntil: 'domcontentloaded' });
  await hasText(serverPage, [createdText]);
  process.stdout.write(
    'Committed CLI reads and fresh browsers confirm the concurrent merge and exactly one new note.\n',
  );
  await residentDocuments('after durable reconciliation');
  await nixctl(['item', 'rm', root.id, '--workspace', workspace]);
  succeeded = true;
  process.stdout.write(
    `Offline acceptance passed in ${browserName}; disposable root ${root.id} deleted.\n`,
  );
} catch (error) {
  await page
    ?.screenshot({ path: resolve(directory, 'failure.png'), fullPage: true })
    .catch(() => undefined);
  process.stderr.write(
    `Offline acceptance failed. Recovery data: ${directory}. Disposable root: ${root?.id ?? 'not created'}. Pending edits and test notes were preserved.\n`,
  );
  throw error;
} finally {
  await context?.close().catch(() => undefined);
  await counterpart?.close().catch(() => undefined);
  clearTimeout(deadlineTimer);
  if (succeeded) {
    if (process.env.NIX_OFFLINE_PRESERVE_PROFILE === '1') {
      process.stdout.write(`Passed persistent browser profile: ${userData}.\n`);
    } else await rm(directory, { recursive: true });
  }
}
