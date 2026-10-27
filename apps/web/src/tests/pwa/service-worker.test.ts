// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../../public/service-worker.js', import.meta.url), 'utf8');

/** A built worker: the same source with the placeholders the build fills in. */
function built(entry: string): string {
  return source
    .replace(
      /const SHELL_ASSETS = \[.*?\];/su,
      `const SHELL_ASSETS = ${JSON.stringify(['/offline.html', '/index.html', entry])};`,
    )
    .replace('const SHELL_ENTRY = null;', `const SHELL_ENTRY = ${JSON.stringify(entry)};`);
}

function worker({
  script = source,
  cached = {},
  network = () => Promise.reject(new Error('offline')),
  storedPushKey,
  windowClients = [],
  cacheNames = [],
}: {
  readonly script?: string;
  readonly cached?: Record<string, Response>;
  readonly network?: () => Promise<Response>;
  readonly storedPushKey?: string;
  readonly windowClients?: readonly {
    readonly focus: () => Promise<unknown>;
    readonly navigate?: (url: string) => Promise<unknown>;
  }[];
  readonly cacheNames?: readonly string[];
} = {}) {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const entries = new Map(Object.entries(cached));
  const pushKeyCache = {
    match: vi.fn(() =>
      Promise.resolve(
        storedPushKey === undefined
          ? undefined
          : new Response(JSON.stringify({ applicationServerKey: storedPushKey })),
      ),
    ),
    put: vi.fn(),
    delete: vi.fn(),
  };
  const cache = {
    match: vi.fn((request: string | { url: string }) => {
      const key = typeof request === 'string' ? request : new URL(request.url).pathname;
      return Promise.resolve(entries.get(key)?.clone());
    }),
    put: vi.fn(),
    delete: vi.fn((key: string) => Promise.resolve(entries.delete(key))),
    addAll: vi.fn(() => Promise.resolve(undefined)),
  };
  // The worker calls this both ways: `fetch(request)` for a shell navigation, with a duck-typed
  // request object rather than a real `Request` (this file runs under the `node` environment,
  // which has neither), and `fetch(url, init)` directly for the push-subscription re-report - so
  // the mock has to accept either shape rather than assume a bare string.
  const fetch = vi.fn<
    (input: string | { readonly url: string }, init?: RequestInit) => Promise<Response>
  >((input) => {
    const url = typeof input === 'string' ? input : input.url;
    return url.includes('/api/v1/me/push-subscriptions')
      ? Promise.resolve(new Response(null, { status: 201 }))
      : network();
  });
  const skipWaiting = vi.fn();
  const showNotification = vi.fn(() => Promise.resolve(undefined));
  const subscribe = vi.fn(() =>
    Promise.resolve({
      toJSON: () => ({ endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }),
    }),
  );
  const openWindow = vi.fn(() => Promise.resolve(undefined));
  const deleteCache = vi.fn(() => Promise.resolve(true));
  const claim = vi.fn(() => Promise.resolve(undefined));
  runInNewContext(script, {
    self: {
      addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) =>
        handlers.set(name, handler),
      location: { origin: 'https://nix.test' },
      skipWaiting,
      registration: { showNotification, pushManager: { subscribe } },
      clients: {
        matchAll: vi.fn(() => Promise.resolve(windowClients)),
        openWindow,
        claim,
      },
    },
    caches: {
      open: (name: string) => Promise.resolve(name === 'nix-push-key' ? pushKeyCache : cache),
      keys: () => Promise.resolve([...cacheNames]),
      delete: deleteCache,
    },
    fetch,
    URL,
    Response,
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
  });
  return {
    handlers,
    cache,
    pushKeyCache,
    fetch,
    skipWaiting,
    showNotification,
    subscribe,
    openWindow,
    deleteCache,
  };
}

function navigate(runtime: ReturnType<typeof worker>, path: string): Promise<Response> | undefined {
  let response: Promise<Response> | undefined;
  runtime.handlers.get('fetch')?.({
    request: { method: 'GET', url: `https://nix.test${path}`, mode: 'navigate' },
    respondWith: (value: Promise<Response>) => {
      response = value;
    },
  });
  return response;
}

describe('PWA caching boundaries', () => {
  it('never intercepts authenticated API, sign-in, public form or capability requests', () => {
    const runtime = worker({ cached: { '/index.html': new Response('shell') } });
    for (const path of [
      '/auth/session',
      '/api/v1/me',
      '/public/v1/files/x',
      '/collab/documents/x/ws',
      '/internal/jobs',
      '/forms/private-link',
      // The object store serves capability URLs from this origin under a deployment-chosen path.
      '/nix-files/5b8f0c9e-object',
      '/offline/signed-file',
    ]) {
      expect(navigate(runtime, path)).toBeUndefined();
    }
  });

  it('opens an application route from the installed shell without touching the network', async () => {
    const runtime = worker({ cached: { '/index.html': new Response('installed shell') } });
    for (const path of ['/', '/w/workspace?item=x', '/workspaces/archived', '/launch/new']) {
      expect(await (await navigate(runtime, path))?.text()).toBe('installed shell');
    }
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it('uses the network, then the offline screen, before a shell is installed', async () => {
    const online = worker({ network: () => Promise.resolve(new Response('from network')) });
    expect(await (await navigate(online, '/w/workspace'))?.text()).toBe('from network');

    const offline = worker({ cached: { '/offline.html': new Response('Offline fallback') } });
    expect(await (await navigate(offline, '/w/workspace'))?.text()).toBe('Offline fallback');
    expect(offline.cache.put).not.toHaveBeenCalled();
  });

  it('installs a shell only when its document names this build entry script', async () => {
    const entry = '/assets/index-abc.js';
    const matching = worker({
      script: built(entry),
      cached: { '/index.html': new Response(`<script src="${entry}"></script>`) },
    });
    let installing: Promise<unknown> | undefined;
    matching.handlers.get('install')?.({
      waitUntil: (value: Promise<unknown>) => {
        installing = value;
      },
    });
    await expect(installing).resolves.toBeUndefined();
    expect(matching.cache.addAll).toHaveBeenCalledWith(['/offline.html', '/index.html', entry]);

    const mismatched = worker({
      script: built(entry),
      cached: { '/index.html': new Response('<script src="/assets/index-other.js"></script>') },
    });
    mismatched.handlers.get('install')?.({
      waitUntil: (value: Promise<unknown>) => {
        installing = value;
      },
    });
    await expect(installing).rejects.toThrow('does not match');
    expect(mismatched.cache.delete).toHaveBeenCalledWith('/index.html');
  });

  it('serves a precached script regardless of the Origin header it is requested with', async () => {
    const runtime = worker({ cached: { '/offline.html': new Response('x') } });
    let response: Promise<Response> | undefined;
    runtime.handlers.get('fetch')?.({
      request: { method: 'GET', url: 'https://nix.test/offline.html', mode: 'cors' },
      respondWith: (value: Promise<Response>) => {
        response = value;
      },
    });
    await response;
    expect(runtime.cache.match).toHaveBeenCalledWith(expect.anything(), { ignoreVary: true });
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it('retires older shell caches on activation but keeps the remembered push key', async () => {
    const runtime = worker({ cacheNames: ['nix-pwa-old', 'nix-pwa-dev', 'nix-push-key'] });
    let activating: Promise<unknown> | undefined;
    runtime.handlers.get('activate')?.({
      waitUntil: (value: Promise<unknown>) => {
        activating = value;
      },
    });
    await activating;
    expect(runtime.deleteCache.mock.calls).toEqual([['nix-pwa-old']]);
  });

  it('only activates early after an explicit update message', () => {
    const runtime = worker();
    runtime.handlers.get('install')?.({ waitUntil: () => undefined });
    expect(runtime.skipWaiting).not.toHaveBeenCalled();
    runtime.handlers.get('message')?.({ data: { type: 'ACTIVATE_UPDATE' } });
    expect(runtime.skipWaiting).toHaveBeenCalledOnce();
  });
});

describe('push notifications', () => {
  it('shows a notification with the payload title, body, tag and url', async () => {
    const runtime = worker();
    let waited: Promise<unknown> | undefined;
    runtime.handlers.get('push')?.({
      data: {
        json: () => ({
          title: 'Due today',
          body: 'Ship the release',
          tag: 'reminder',
          url: '/w/x/y',
        }),
      },
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    });
    await waited;
    expect(runtime.showNotification).toHaveBeenCalledWith('Due today', {
      body: 'Ship the release',
      tag: 'reminder',
      icon: '/nix-icon-192.png',
      data: { url: '/w/x/y' },
    });
  });

  it('falls back to a default title when the payload is missing or unparsable', async () => {
    const runtime = worker();
    let waited: Promise<unknown> | undefined;
    runtime.handlers.get('push')?.({
      data: undefined,
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    });
    await waited;
    expect(runtime.showNotification).toHaveBeenCalledWith(
      'Nix',
      expect.objectContaining({ body: '' }),
    );
  });

  it('focuses and navigates an existing window to the notification url', async () => {
    const navigate = vi.fn(() => Promise.resolve(undefined));
    const focus = vi.fn(() => Promise.resolve(undefined));
    const runtime = worker({ windowClients: [{ focus, navigate }] });

    let waited: Promise<unknown> | undefined;
    const notification = { close: vi.fn(), data: { url: '/w/x/y' } };
    runtime.handlers.get('notificationclick')?.({
      notification,
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    });
    await waited;
    expect(notification.close).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('https://nix.test/w/x/y');
  });

  it('opens a new window when no existing client can be focused', async () => {
    const runtime = worker();
    let waited: Promise<unknown> | undefined;
    const notification = { close: vi.fn(), data: { url: '/w/x/y' } };
    runtime.handlers.get('notificationclick')?.({
      notification,
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    });
    await waited;
    expect(runtime.openWindow).toHaveBeenCalledWith('https://nix.test/w/x/y');
  });

  it('never navigates to a cross-origin notification url', async () => {
    const runtime = worker();
    let waited: Promise<unknown> | undefined;
    const notification = { close: vi.fn(), data: { url: 'https://evil.example/steal' } };
    runtime.handlers.get('notificationclick')?.({
      notification,
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    });
    await waited;
    expect(runtime.openWindow).toHaveBeenCalledWith('https://nix.test/');
  });

  it('re-subscribes with the remembered applicationServerKey and reports the new subscription', async () => {
    const runtime = worker({ storedPushKey: 'AAAA' });
    let waited: Promise<unknown> | undefined;
    runtime.handlers.get('pushsubscriptionchange')?.({
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    });
    await waited;
    expect(runtime.subscribe).toHaveBeenCalledOnce();
    expect(runtime.fetch).toHaveBeenCalledWith(
      '/api/v1/me/push-subscriptions',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    const body = JSON.parse((runtime.fetch.mock.calls[0]?.[1] as { body: string }).body) as {
      endpoint: string;
    };
    expect(body.endpoint).toBe('https://push.example/x');
  });

  it('does nothing when no applicationServerKey was ever remembered', async () => {
    const runtime = worker();
    let waited: Promise<unknown> | undefined;
    runtime.handlers.get('pushsubscriptionchange')?.({
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    });
    await waited;
    expect(runtime.subscribe).not.toHaveBeenCalled();
    expect(runtime.fetch).not.toHaveBeenCalled();
  });
});
