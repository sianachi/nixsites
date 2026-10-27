/* global self, caches, fetch, URL, Response, atob */
const VERSION = 'nix-pwa-dev';
// VERSION, ASSETS, SHELL_ASSETS and SHELL_ENTRY are placeholders the build replaces (vite.config.ts)
// with this build's own values, so one worker version always serves one coherent application: its
// own document, and the scripts and styles that document names.
const PUSH_KEY_CACHE = 'nix-push-key';
const PUSH_KEY_REQUEST = '/__push-key';
const ASSETS = ['/offline.html', '/nix-icon-192.png', '/nix-icon-512.png'];
const SHELL_ASSETS = ['/offline.html', '/nix-icon-192.png', '/nix-icon-512.png'];
const SHELL_ENTRY = null;
const SHELL_DOCUMENT = '/index.html';
const knownAssets = new Set(ASSETS);
// Client-side routes the shell may answer. An allowlist, not "anything without an extension":
// the object store's capability URLs are served from this origin under a deployment-chosen path,
// and a navigation to one must reach the network rather than be swallowed by the application.
const APP_ROUTE_PREFIXES = ['/w/', '/workspaces/', '/launch/'];

function isAppNavigation(url) {
  return (
    url.pathname === '/' || APP_ROUTE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
  );
}

async function precacheShell() {
  const cache = await caches.open(VERSION);
  await cache.addAll(SHELL_ASSETS);
  if (SHELL_ENTRY === null) return;
  // Refuse to install a shell whose document belongs to a different build - a deploy landing
  // between this worker's download and its install - rather than pairing it with these scripts.
  const shell = await cache.match(SHELL_DOCUMENT);
  const text = shell ? await shell.clone().text() : '';
  if (!text.includes(SHELL_ENTRY)) {
    await cache.delete(SHELL_DOCUMENT);
    throw new Error('The application document does not match this worker build.');
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell());
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_UPDATE') void self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('nix-pwa-') && key !== VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Auth, API, collaboration and capability URLs always use the network.
  if (knownAssets.has(url.pathname) && url.search === '') {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        // `ignoreVary`: a module script asks with an Origin header the install-time fetch did not
        // send, and a server that answers `Vary: Origin` would otherwise make every precached
        // script a miss exactly when there is no network. A hashed build file never varies.
        const cached = await cache.match(request, { ignoreVary: true });
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && !response.redirected && response.type !== 'opaque')
          await cache.put(request, response.clone()).catch(() => undefined);
        return response;
      }),
    );
  } else if (request.mode === 'navigate' && isAppNavigation(url)) {
    // The installed shell opens at once and without a network, like an installed application; a
    // newer build arrives through the update prompt rather than halfway through a launch. The
    // document holds no user data - the session and every item still come from Core.
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const shell = await cache.match(SHELL_DOCUMENT);
        if (shell) return shell;
        try {
          return await fetch(request);
        } catch {
          return (await cache.match('/offline.html')) ?? Response.error();
        }
      }),
    );
  }
});

// A push message carries a same-origin URL and short title/body only (ADR-0051 section 5) - never
// bytes to render, so there is nothing here to cache or fall back on offline.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title =
    typeof payload.title === 'string' && payload.title.length > 0 ? payload.title : 'Nix';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const url = typeof payload.url === 'string' ? payload.url : '/';
  const options = {
    body,
    tag: typeof payload.tag === 'string' ? payload.tag : undefined,
    icon: '/nix-icon-192.png',
    data: { url },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Focuses an existing tab and navigates it, or opens a new one - only ever to a same-origin path,
// since `data.url` came from a push payload and a push payload is attacker-reachable input the
// moment an endpoint is stolen.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl =
    event.notification.data && typeof event.notification.data.url === 'string'
      ? event.notification.data.url
      : '/';
  let target;
  try {
    target = new URL(rawUrl, self.location.origin);
  } catch {
    target = new URL('/', self.location.origin);
  }
  if (target.origin !== self.location.origin) {
    target = new URL('/', self.location.origin);
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus().then(() => {
            return 'navigate' in client ? client.navigate(target.href) : undefined;
          });
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(target.href) : undefined;
    }),
  );
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let index = 0; index < rawData.length; index += 1) {
    output[index] = rawData.charCodeAt(index);
  }
  return output;
}

// The browser rotated the push subscription (key expiry, provider-side reset). Re-subscribe with
// the applicationServerKey the page remembered when it first subscribed, and tell Core about the
// new endpoint. No page needs to be open for this to fire, so if the key was never remembered -
// or re-subscribing or the report fails - this does nothing rather than leave a broken
// subscription behind; the settings screen's own read will show push as off next time it opens.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    caches
      .open(PUSH_KEY_CACHE)
      .then((cache) => cache.match(PUSH_KEY_REQUEST))
      .then((response) => (response ? response.json() : null))
      .then((stored) => {
        if (!stored || typeof stored.applicationServerKey !== 'string') return undefined;
        return self.registration.pushManager
          .subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(stored.applicationServerKey),
          })
          .then((subscription) => {
            const json = subscription.toJSON();
            return fetch('/api/v1/me/push-subscriptions', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                endpoint: json.endpoint,
                p256dh: json.keys && json.keys.p256dh,
                auth: json.keys && json.keys.auth,
              }),
            });
          });
      })
      .catch(() => undefined),
  );
});
