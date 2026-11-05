import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import {
  BrowserWindow,
  Menu,
  Notification,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  powerSaveBlocker,
  session,
  shell,
  utilityProcess,
} from 'electron';

import {
  CALLBACK_SCHEME,
  handoffCode,
  loginUrl,
  newVerifier,
  serverOrigin,
} from './shell-rules.mjs';
import { BEAT_MS, SqlClient } from './sql-client.mjs';
import { Stores } from './store.mjs';

// A remote shell like apps/mobile: a bundled picker opens a Nix server's own web app, whose cookie
// session works unchanged. Every page in the window gets the preload, so three things are the
// security boundary: the navigation rule, the frame check on every IPC call, and the permissions.

const PICKER_PATH = join(import.meta.dirname, 'picker', 'index.html');
const PICKER_URL = pathToFileURL(PICKER_PATH).href;
/** How long the person may stay in the browser signing in; the handoff itself is only 60 seconds. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** Back in the app with no callback: given up, not mid-handoff (the OS delivers the callback first or at once). */
const SIGN_IN_RETURN_GRACE_MS = 5_000;
/** Chromium's "the navigation was cancelled", which is not a failure to load. */
const ERR_ABORTED = -3;
// Not clipboard-read: with no prompt in Electron, a script on a server could poll for passwords.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'notifications']);

if (!app.requestSingleInstanceLock()) app.exit(0);

// The object-store GETs and the picker's server check share no cookies with the window.
const plainSession = () => session.fromPartition('nix-plain');

/**
 * The store's download fetch: each redirect comes back to it to check, which session.fetch cannot
 * do (`redirect: 'manual'` only throws "Redirect was cancelled").
 */
function downloadFetch(url, { signal }) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, session: plainSession(), redirect: 'manual' });
    request.on('redirect', (status, _method, location) => {
      request.abort();
      resolve(new Response(null, { status, headers: { location } }));
    });
    request.on('response', (response) => {
      const empty = [204, 205, 304].includes(response.statusCode);
      // A status outside 200-599 makes the Response constructor throw, here in an event listener.
      try {
        resolve(
          new Response(empty ? null : Readable.toWeb(response), { status: response.statusCode }),
        );
      } catch (error) {
        request.abort();
        reject(error);
      }
    });
    request.on('error', reject);
    signal.addEventListener('abort', () => {
      request.abort();
      reject(signal.reason);
    });
    request.end();
  });
}

const storeDir = join(app.getPath('userData'), 'nix-store');
const stores = new Stores({
  baseDir: storeDir,
  fetch: downloadFetch,
  resolveHost: async (host) =>
    (await plainSession().resolveHost(host)).endpoints.map(({ address }) => address),
  sql: new SqlClient({
    spawn: () =>
      utilityProcess.fork(join(import.meta.dirname, 'sql-host.mjs'), [storeDir, String(BEAT_MS)], {
        serviceName: 'Nix offline copy',
      }),
  }),
});

// --- Saved servers: the navigation allowlist and the set of origins that get a store.

const serversPath = join(app.getPath('userData'), 'servers.json');

function loadServers() {
  try {
    const saved = JSON.parse(readFileSync(serversPath, 'utf8'));
    return saved.filter((origin) => serverOrigin(origin) === origin);
  } catch {
    return [];
  }
}

let servers = loadServers();

function saveServers(next) {
  mkdirSync(app.getPath('userData'), { recursive: true });
  const temporary = `${serversPath}.tmp`;
  writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
  renameSync(temporary, serversPath);
  servers = next;
}

const isSavedUrl = (url) => {
  try {
    return servers.includes(new URL(url).origin);
  } catch {
    return false;
  }
};

// --- The window.

/** @type {BrowserWindow | null} */
let win = null;
let keepAwakeId = null;

function setKeepAwake(running) {
  if (running && keepAwakeId === null) {
    keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!running && keepAwakeId !== null) {
    powerSaveBlocker.stop(keepAwakeId);
    keepAwakeId = null;
  }
}

// A load that fails reports through did-fail-load; these reject as well, even when only superseded.
const showPicker = (failedHost) =>
  win
    ?.loadFile(PICKER_PATH, failedHost === undefined ? {} : { query: { failed: failedHost } })
    .catch(() => undefined);

const openServer = (origin) => win?.loadURL(`${origin}/`).catch(() => undefined);

function focusWindow() {
  if (win === null) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}

let lastOutside = 0;

/** At most one a second: any frame can ask, with no click, and each one opens a browser tab. */
function openOutside(url) {
  if (!/^https?:/i.test(url) || Date.now() - lastOutside < 1000) return;
  lastOutside = Date.now();
  void shell.openExternal(url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 480,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff',
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const page = win.webContents;

  // Any other page (the identity provider's account page, an outside link) opens in the browser.
  const keepInside = (event) => {
    if (event.isMainFrame && !isSavedUrl(event.url)) {
      event.preventDefault();
      openOutside(event.url);
    }
  };
  page.on('will-navigate', keepInside);
  page.on('will-redirect', keepInside);
  page.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });

  // will-navigate misses some: an embedded frame can send the top to about:blank.
  page.on('did-navigate', (_event, url) => {
    // chrome-error: a failed load, which did-fail-load handles; reacting here could loop forever.
    if (!isSavedUrl(url) && url.split('?')[0] !== PICKER_URL && !url.startsWith('chrome-error:'))
      void showPicker();
  });

  page.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (isMainFrame && code !== ERR_ABORTED && isSavedUrl(url)) void showPicker(new URL(url).host);
  });
  page.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
    // A reload mid-pass never reports the end of it.
    if (isMainFrame && !isSameDocument) setKeepAwake(false);
  });
  // A page's unsaved-work warning: Electron otherwise cancels the close or navigation silently.
  page.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      message: 'Leave this page?',
      detail: 'Changes on this page may not be saved.',
    });
    if (choice === 0) event.preventDefault();
  });
  // Electron has no context menu of its own.
  page.on(
    'context-menu',
    (_event, { isEditable, selectionText, dictionarySuggestions, misspelledWord }) => {
      const spelling = misspelledWord
        ? [
            ...dictionarySuggestions.map((word) => ({
              label: word,
              click: () => {
                page.replaceMisspelling(word);
              },
            })),
            { type: 'separator' },
          ]
        : [];
      const items = isEditable
        ? [...spelling, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
        : selectionText
          ? [{ role: 'copy' }]
          : [];
      if (items.length > 0) Menu.buildFromTemplate(items).popup();
    },
  );

  win.on('closed', () => {
    win = null;
    setKeepAwake(false);
    finishSignIn('cancelled');
  });
  win.on('focus', () => {
    if (signIn === null) return;
    const started = signIn;
    setTimeout(() => {
      if (signIn === started) finishSignIn('cancelled');
    }, SIGN_IN_RETURN_GRACE_MS);
  });
}

// --- IPC. Every channel answers only the window's top frame, checked against the sending frame.

function answer(channel, admit, work) {
  ipcMain.handle(channel, async (event, body) => {
    try {
      const frame = event.senderFrame;
      const origin =
        event.sender === win?.webContents && frame !== null && frame.parent === null
          ? admit(frame)
          : null;
      if (origin === null) return { error: 'Not allowed.' };
      return { value: await work(origin, body) };
    } catch (error) {
      return { error: typeof error === 'string' ? error : (error?.message ?? 'Failed.') };
    }
  });
}

/** The frame's own origin from Chromium, never from the message; one server cannot name another's store. */
const savedServerFrame = (frame) => (servers.includes(frame.origin) ? frame.origin : null);
const pickerFrame = (frame) => (frame.url.split('?')[0] === PICKER_URL ? frame.url : null);

answer('nix:store', savedServerFrame, async (origin, request) => {
  if (request?.op === 'keepAwake') {
    setKeepAwake(request.running === true);
    return {};
  }
  if (request?.op === 'notify') {
    const { title, body } = request;
    // In the app the page says it itself.
    if (
      typeof title === 'string' &&
      typeof body === 'string' &&
      win?.isFocused() === false &&
      Notification.isSupported()
    ) {
      const notification = new Notification({
        title: title.slice(0, 100),
        body: body.slice(0, 300),
      });
      notification.on('click', focusWindow);
      notification.show();
    }
    return {};
  }
  return stores.handle(origin, request);
});

answer('nix:showPicker', savedServerFrame, () => {
  void showPicker();
});

// --- Sign-in: passkeys and federated providers need the system browser, not this window, so it
// runs there and the page redeems a one-time code for its cookie (RFC 8252). The server's redirect
// target is a constant, a code is useless without the verifier, and the page only gets the two
// together for a code its own server issued (see handoffCode).

/** @type {{ origin: string, reply: (outcome: object | string) => void, verifier: string, timer: NodeJS.Timeout } | null} */
let signIn = null;

function finishSignIn(outcome) {
  if (signIn === null) return;
  const { reply, timer } = signIn;
  signIn = null;
  clearTimeout(timer);
  reply(outcome);
}

function receiveCallback(url) {
  // A callback no sign-in here is waiting for is dropped: nothing in it can act on its own.
  if (signIn === null) return;
  const code = handoffCode(url, signIn.origin);
  if (code === null) return;
  const { verifier } = signIn;
  focusWindow();
  finishSignIn({ code, verifier });
}

answer('nix:signIn', savedServerFrame, async (origin, body) => {
  if (Date.now() - lastOutside < 1000) throw 'Sign-in could not be started.';
  lastOutside = Date.now();
  // The browser cannot be told to stop, so a new attempt replaces the one it may still be showing.
  finishSignIn('cancelled');
  const { verifier, challenge } = newVerifier();
  const outcome = await new Promise((resolve) => {
    signIn = {
      origin,
      verifier,
      reply: resolve,
      timer: setTimeout(() => {
        finishSignIn('cancelled');
      }, SIGN_IN_TIMEOUT_MS),
    };
    shell.openExternal(loginUrl(origin, challenge, body?.returnTo)).catch(() => {
      finishSignIn('Sign-in could not be started.');
    });
  });
  if (typeof outcome === 'string') throw outcome;
  return outcome;
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  receiveCallback(url);
});
app.on('second-instance', (_event, argv) => {
  const url = argv.find((argument) => argument.startsWith(`${CALLBACK_SCHEME}://`));
  if (url !== undefined) receiveCallback(url);
  focusWindow();
});

// --- The picker's channel. It alone may change the list, since that is the allowlist above.

async function checkServer(origin) {
  const host = new URL(origin).host;
  let session_;
  try {
    const response = await plainSession().fetch(`${origin}/auth/session`, {
      redirect: 'error',
      credentials: 'omit',
    });
    session_ = response.status === 200 ? await response.json() : null;
  } catch (error) {
    if (error instanceof SyntaxError) session_ = null;
    else throw new Error(`Could not reach ${host}.`, { cause: error });
  }
  if (typeof session_?.configured !== 'boolean') throw new Error(`${host} is not a Nix server.`);
}

async function forgetSession(origin) {
  const { cookies } = session.defaultSession;
  // clearStorageData({ origin }) misses cookies set for a parent domain, which this URL still sends.
  for (const { name } of await cookies.get({ url: origin })) await cookies.remove(origin, name);
  await session.defaultSession.clearStorageData({ origin });
  // Neither is kept per origin.
  await session.defaultSession.clearCache();
  await session.defaultSession.clearCodeCaches({});
}

answer('nix:picker', pickerFrame, async (_frame, request) => {
  switch (request?.op) {
    case 'getServers':
      return servers;
    case 'add': {
      const origin = serverOrigin(request.address ?? '');
      if (origin === null) throw new Error('Enter an https address, such as nix.example.com.');
      await checkServer(origin);
      saveServers([origin, ...servers.filter((saved) => saved !== origin)]);
      void openServer(origin);
      return servers;
    }
    case 'open':
      if (!servers.includes(request.origin)) throw new Error('Unknown server.');
      saveServers([request.origin, ...servers.filter((saved) => saved !== request.origin)]);
      void openServer(request.origin);
      return servers;
    case 'remove': {
      if (!servers.includes(request.origin)) return servers;
      // Stays on the list until its data is gone, so a failure can be retried and is not forgotten.
      try {
        await stores.wipe(request.origin);
        await forgetSession(request.origin);
      } catch {
        throw new Error(
          `The offline copy of ${new URL(request.origin).host} could not be deleted. Try again.`,
        );
      }
      saveServers(servers.filter((saved) => saved !== request.origin));
      return servers;
    }
    default:
      throw new Error('Unknown request.');
  }
});

// --- App lifecycle.

// A development run has to name its entry script; only a packaged app can register on macOS.
if (process.defaultApp)
  app.setAsDefaultProtocolClient(CALLBACK_SCHEME, process.execPath, [process.argv[1]]);
else app.setAsDefaultProtocolClient(CALLBACK_SCHEME);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (win === null && app.isReady()) launch();
});
app.on('will-quit', () => {
  stores.close();
});
// The default would send the first matching certificate to any server or embedded frame, unasked.
app.on('select-client-certificate', (event, _contents, _url, _list, callback) => {
  event.preventDefault();
  callback();
});

function launch() {
  createWindow();
  // Open the last server; a page that fails to load comes back to the picker.
  if (servers.length > 0) void openServer(servers[0]);
  else void showPicker();
}

void app.whenReady().then(() => {
  const defaults = session.defaultSession;
  // Electron grants every permission unless told otherwise; embedded frames get none.
  defaults.setPermissionRequestHandler((_contents, permission, grant, details) => {
    grant(
      ALLOWED_PERMISSIONS.has(permission) &&
        details.isMainFrame &&
        isSavedUrl(details.requestingUrl),
    );
  });
  defaults.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) =>
      ALLOWED_PERMISSIONS.has(permission) && isSavedUrl(requestingOrigin),
  );
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
  launch();
});
