import * as bodies from '@nix/web-foundation/lib/body-cache';
import * as drafts from '@nix/web-foundation/lib/draft-journal';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { StrictMode, useState } from 'react';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '@nix/web-platform/auth/auth-provider';
import { frecencyScores, recordPick } from '@nix/web-foundation/lib/frecency';
import { readDismissals, rememberDismissal } from '@nix/web-foundation/lib/suggestion-dismissals';
import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import * as registerServiceWorker from '@nix/web-platform/pwa/register-service-worker';
import { workspaces } from '@nix/api-client';
import { ApiClientProvider, useApiClient } from '@nix/web-platform/api/api-client-provider';
import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';

const future = '2099-01-01T00:00:00+00:00';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function anonymous(configured = true): Response {
  return json({
    authenticated: false,
    configured,
    profile: null,
    accessToken: null,
    expiresAt: null,
  });
}

function authenticated(extra: Record<string, unknown> = {}): Response {
  return json({
    authenticated: true,
    configured: true,
    profile: { subject: 'person-1', name: 'Stored Person' },
    accessToken: 'core-session-token',
    expiresAt: future,
    ...extra,
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise?.(value) };
}

function SessionHarness() {
  const status = useSessionStore((state) => state.status);
  const auth = useAuth();
  const [accessToken, setAccessToken] = useState<string | null>();

  return (
    <div>
      <output>{status}</output>
      <output aria-label="Configured">{auth.isConfigured ? 'Configured' : 'Unconfigured'}</output>
      <output aria-label="Account page">{auth.accountUrl ?? 'No account page'}</output>
      <button type="button" onClick={() => void auth.signOut()}>
        Sign out
      </button>
      <button
        type="button"
        onClick={() => {
          void auth.getAccessToken().then(setAccessToken);
        }}
      >
        Read access token
      </button>
      <button
        type="button"
        onClick={() => {
          void auth.getAccessToken(true).then(setAccessToken);
        }}
      >
        Renew access token
      </button>
      <output aria-label="Access token">{accessToken === null ? 'No token' : accessToken}</output>
    </div>
  );
}

function CoreQueryHarness() {
  const client = useApiClient();
  const [result, setResult] = useState('');
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void client
            .query(workspaces.listWorkspacesPage(), { forceRefresh: true })
            .then(() => {
              setResult('Succeeded');
            })
            .catch(() => {
              setResult('Refused');
            });
        }}
      >
        Read workspaces
      </button>
      <output aria-label="API result">{result}</output>
    </>
  );
}

function pathOf(input: RequestInfo | URL): string {
  return new URL(input instanceof Request ? input.url : String(input), globalThis.location.origin)
    .pathname;
}

function renderProvider(strict = false): ReturnType<typeof render> {
  const provider = (
    <AuthProvider>
      <SessionHarness />
    </AuthProvider>
  );
  return render(strict ? <StrictMode>{provider}</StrictMode> : provider);
}

beforeEach(() => {
  useSessionStore.setState({ status: 'unknown', profile: null, error: null });
  vi.spyOn(bodies, 'sealAccountBodies').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Core-mediated browser sessions', () => {
  it.each(['same tab', 'another tab'])(
    'ignores a session response arriving after sign-out in %s',
    async (source) => {
      const restore = deferred<Response>();
      vi.spyOn(bodies, 'openBodyCache').mockResolvedValue(undefined);
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockImplementation((url: string) =>
            url === '/auth/session'
              ? restore.promise
              : Promise.resolve(new Response(null, { status: 204 })),
          ),
      );
      renderProvider();
      await screen.findByText('authenticating');
      if (source === 'same tab')
        await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
      else window.dispatchEvent(new Event('nix:signed-out-elsewhere'));
      await screen.findByText('anonymous');
      await act(async () => {
        restore.resolve(authenticated());
        await restore.promise;
      });
      await waitFor(() => {
        expect(useSessionStore.getState().status).toBe('anonymous');
      });
      expect(useSessionStore.getState().profile).toBeNull();
    },
  );

  it('restores an existing body owner without an epoch and preserves its pending draft', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const subject = 'legacy-person';
    const scope = JSON.stringify([subject, 'legacy-workspace', 'legacy-note', 'note']);
    await bodies.openBodyCache(subject);
    const doc = new Y.Doc();
    doc.getText('note').insert(0, 'Legacy pending writing');
    const update = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    await drafts.writeDraft({ id: 'legacy-auth-draft', scope, revision: 1, update });
    storage.removeItem('nix.body-cache.epoch.' + JSON.stringify(subject));
    expect(bodies.bodyCacheAccountEpoch(subject)).toBeNull();
    const clear = vi.spyOn(drafts, 'clearDrafts');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        authenticated({
          profile: { subject, name: 'Legacy Person' },
        }),
      ),
    );
    renderProvider();
    await screen.findByText('authenticated');
    expect(bodies.bodyCacheAccountEpoch(subject)).not.toBeNull();
    const restored = new Y.Doc();
    for (const record of await drafts.readDrafts(scope)) Y.applyUpdate(restored, record.update);
    expect(restored.getText('note').toJSON()).toBe('Legacy pending writing');
    expect(clear).not.toHaveBeenCalled();
    restored.destroy();
    vi.unstubAllGlobals();
  });

  it('closes cached admission after a malformed successful token renewal', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(authenticated({ expiresAt: '2000-01-01T00:00:00Z' }))
        .mockResolvedValueOnce(json({ authenticated: true })),
    );
    renderProvider();
    await screen.findByText('authenticated');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Read access token' }));
    await screen.findByText('anonymous');
    expect(useSessionStore.getState().error).toContain('invalid session');
    expect(screen.getByLabelText('Access token')).toHaveTextContent('No token');
  });

  it.each([408, 429, 500, 502, 503, 504, 507, 'network', 'offline'] as const)(
    'keeps downloaded access and durable edits when renewal encounters %s',
    async (answer) => {
      vi.stubGlobal('indexedDB', new IDBFactory());
      vi.stubGlobal('localStorage', memoryStorage());
      const clear = vi.spyOn(drafts, 'clearDrafts');
      if (answer === 'offline') vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      const fetch = vi.fn().mockResolvedValueOnce(authenticated());
      if (typeof answer === 'number')
        fetch.mockResolvedValueOnce(new Response(null, { status: answer }));
      else fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      fetch.mockResolvedValue(authenticated({ accessToken: 'restored-token' }));
      vi.stubGlobal('fetch', fetch);
      renderProvider();
      await screen.findByText('authenticated');
      const subject = 'person-1';
      const scope = JSON.stringify([subject, 'workspace-1', 'note-1', 'note']);
      const doc = new Y.Doc();
      doc.getText('note').insert(0, 'Writing preserved during renewal outage');
      await drafts.writeDraft({
        id: 'renewal-draft',
        scope,
        revision: 1,
        update: Y.encodeStateAsUpdate(doc),
      });
      doc.destroy();
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Renew access token' }));
      await screen.findByText('unreachable');
      expect(useSessionStore.getState().unreachable?.cause).toBe(
        answer === 'offline' ? 'offline' : 'server',
      );
      expect(useSessionStore.getState().profile?.subject).toBe(subject);
      expect(screen.getByLabelText('Access token')).toHaveTextContent('No token');
      expect(bodies.bodyCacheAccountAdmits(subject)).toBe(true);
      expect(bodies.bodyCacheAdmits(scope)).toBe(true);
      expect(bodies.sealAccountBodies).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
      const restored = new Y.Doc();
      for (const record of await drafts.readDrafts(scope)) Y.applyUpdate(restored, record.update);
      expect(restored.getText('note').toJSON()).toBe('Writing preserved during renewal outage');
      restored.destroy();
      await user.click(screen.getByRole('button', { name: 'Read access token' }));
      expect(fetch).toHaveBeenCalledTimes(2);
      window.dispatchEvent(new Event('online'));
      await screen.findByText('authenticated');
      await user.click(screen.getByRole('button', { name: 'Read access token' }));
      expect(screen.getByLabelText('Access token')).toHaveTextContent('restored-token');
    },
  );

  it.each(
    ['another account', 'a fresh session for the same account'].flatMap((changed) =>
      [503, 401, 403, 'success'].map((answer) => ({ changed, answer })),
    ),
  )('ignores renewal $answer arriving after $changed starts', async ({ changed, answer }) => {
    const renewal = deferred<Response>();
    const epoch = vi.spyOn(bodies, 'bodyCacheAccountEpoch').mockReturnValue('original');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(authenticated()).mockReturnValueOnce(renewal.promise),
    );
    renderProvider();
    await screen.findByText('authenticated');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Renew access token' }));
    epoch.mockReturnValue('replacement');
    if (changed === 'another account')
      useSessionStore.setState({
        profile: { subject: 'person-2', name: 'Other Person', email: null },
      });
    await act(async () => {
      renewal.resolve(
        typeof answer === 'number'
          ? new Response(null, { status: answer })
          : authenticated({ accessToken: 'obsolete-token' }),
      );
      await renewal.promise;
    });
    expect(useSessionStore.getState().status).toBe('authenticated');
    expect(useSessionStore.getState().unreachable).toBeNull();
    expect(screen.getByLabelText('Access token')).toHaveTextContent('No token');
    expect(useSessionStore.getState().profile?.subject).toBe(
      changed === 'another account' ? 'person-2' : 'person-1',
    );
  });

  it('accepts renewal after the same admitted profile is normalized', async () => {
    const renewal = deferred<Response>();
    vi.spyOn(bodies, 'bodyCacheAccountEpoch').mockReturnValue('current-epoch');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(authenticated()).mockReturnValueOnce(renewal.promise),
    );
    renderProvider();
    await screen.findByText('authenticated');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Renew access token' }));
    useSessionStore.setState({
      profile: { subject: 'person-1', name: 'Normalized Person', email: null },
    });
    await act(async () => {
      renewal.resolve(authenticated({ accessToken: 'normalized-token' }));
      await renewal.promise;
    });
    expect(screen.getByLabelText('Access token')).toHaveTextContent('normalized-token');
    expect(useSessionStore.getState().status).toBe('authenticated');
  });

  it.each([429, 500])(
    'keeps local notes through renewal failure and automatic retry HTTP%s',
    async (retryStatus) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        vi.stubGlobal('indexedDB', new IDBFactory());
        vi.stubGlobal('localStorage', memoryStorage());
        const fetch = vi
          .fn()
          .mockResolvedValueOnce(authenticated())
          .mockResolvedValueOnce(new Response(null, { status: 503 }))
          .mockResolvedValueOnce(new Response(null, { status: retryStatus }))
          .mockResolvedValue(authenticated({ accessToken: 'recovered-token' }));
        vi.stubGlobal('fetch', fetch);
        renderProvider();
        await screen.findByText('authenticated');
        const scope = JSON.stringify(['person-1', 'workspace-1', 'retry-note', 'note']);
        const doc = new Y.Doc();
        doc.getText('note').insert(0, 'Writing preserved through automatic retries');
        await drafts.writeDraft({
          id: 'retry-draft',
          scope,
          revision: 1,
          update: Y.encodeStateAsUpdate(doc),
        });
        doc.destroy();
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        await user.click(screen.getByRole('button', { name: 'Renew access token' }));
        await screen.findByText('unreachable');
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000);
        });
        await waitFor(() => {
          expect(fetch).toHaveBeenCalledTimes(3);
          expect(useSessionStore.getState().status).toBe('unreachable');
        });
        expect(bodies.bodyCacheAdmits(scope)).toBe(true);
        const recovered = new Y.Doc();
        for (const record of await drafts.readDrafts(scope))
          Y.applyUpdate(recovered, record.update);
        expect(recovered.getText('note').toJSON()).toBe(
          'Writing preserved through automatic retries',
        );
        recovered.destroy();
        window.dispatchEvent(new Event('online'));
        await screen.findByText('authenticated');
        await user.click(screen.getByRole('button', { name: 'Read access token' }));
        expect(screen.getByLabelText('Access token')).toHaveTextContent('recovered-token');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('fails the restore when the account changes in another tab while its body cache opens', async () => {
    vi.spyOn(bodies, 'openBodyCache').mockResolvedValue(undefined);
    vi.spyOn(bodies, 'bodyCacheAccountEpoch')
      .mockReturnValueOnce('before')
      .mockReturnValue('after');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(authenticated()));
    renderProvider();
    await screen.findByText('failed');
    expect(useSessionStore.getState().profile).toBeNull();
  });

  it('deletes the retired offline-notes databases and keys when signing out', async () => {
    const idb = new IDBFactory();
    const deleted = vi.spyOn(idb, 'deleteDatabase');
    vi.spyOn(bodies, 'clearBodyCache').mockResolvedValue(undefined);
    vi.spyOn(drafts, 'clearDrafts').mockResolvedValue(undefined);
    vi.stubGlobal('indexedDB', idb);
    localStorage.setItem('nix.offline.preference', 'true');
    localStorage.setItem('nix.other', 'kept');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(authenticated())
        .mockResolvedValue(new Response(null, { status: 204 })),
    );
    renderProvider();
    await screen.findByText('authenticated');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('anonymous');
    expect(deleted).toHaveBeenCalledWith('nix-offline-notes');
    expect(deleted).toHaveBeenCalledWith('nix-offline-note-assets');
    expect(localStorage.getItem('nix.offline.preference')).toBeNull();
    expect(localStorage.getItem('nix.other')).toBe('kept');
    localStorage.removeItem('nix.other');
    vi.unstubAllGlobals();
  });

  it('does not admit a session when sign-out happens while its body cache is opening', async () => {
    const opened = deferred<undefined>();
    const open = vi.spyOn(bodies, 'openBodyCache').mockReturnValue(opened.promise);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(authenticated()));
    renderProvider();
    await waitFor(() => {
      expect(open).toHaveBeenCalled();
    });
    window.dispatchEvent(new Event('nix:signed-out-elsewhere'));
    await act(async () => {
      opened.resolve(undefined);
      await opened.promise;
    });
    await screen.findByText('anonymous');
    expect(useSessionStore.getState().profile).toBeNull();
  });

  it('ignores a token renewal arriving after another tab signs out', async () => {
    const refresh = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(authenticated({ expiresAt: '2000-01-01T00:00:00Z' }))
        .mockReturnValueOnce(refresh.promise),
    );
    renderProvider();
    await screen.findByText('authenticated');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Read access token' }));
    window.dispatchEvent(new Event('nix:signed-out-elsewhere'));
    refresh.resolve(authenticated({ accessToken: 'late-token', expiresAt: future }));
    await waitFor(() =>
      expect(screen.getByLabelText('Access token')).toHaveTextContent('No token'),
    );
    expect(useSessionStore.getState().status).toBe('anonymous');
  });

  it('closes token acquisition as soon as explicit sign-out begins', async () => {
    const logout = deferred<Response>();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(authenticated())
      .mockReturnValueOnce(logout.promise);
    vi.stubGlobal('fetch', fetch);
    renderProvider();
    await screen.findByText('authenticated');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Read access token' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Access token')).toHaveTextContent('No token');
    });
    expect(fetch).not.toHaveBeenCalledWith('/auth/token', expect.anything());
    logout.resolve(new Response(null, { status: 204 }));
    await screen.findByText('anonymous');
  });

  it('closes local body and draft storage before waiting for push cleanup', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const pushCleanup = deferred<Response>();
    const bodyClear = vi.spyOn(bodies, 'clearBodyCache').mockResolvedValue(undefined);
    const draftsClear = vi.spyOn(drafts, 'clearDrafts').mockResolvedValue(undefined);
    const subscription = {
      endpoint: 'https://push.example/subscription',
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    vi.spyOn(registerServiceWorker, 'getServiceWorkerRegistration').mockReturnValue({
      pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) },
    } as unknown as ServiceWorkerRegistration);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(authenticated())
      .mockReturnValueOnce(pushCleanup.promise)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    renderProvider();
    await screen.findByText('authenticated');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/v1/me/push-subscriptions', expect.anything());
    });
    expect(bodyClear).toHaveBeenCalled();
    expect(draftsClear).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalledWith('/auth/logout', expect.anything());
    pushCleanup.resolve(new Response(null, { status: 204 }));
    await screen.findByText('anonymous');
    vi.unstubAllGlobals();
  });

  it('renews a valid cached token after Core401 and closes the session if the fresh token is refused', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('localStorage', memoryStorage());
    vi.spyOn(bodies, 'openBodyCache').mockResolvedValue(undefined);
    const clear = vi.spyOn(drafts, 'clearDrafts');
    const coreTokens: (string | null)[] = [];
    let sessions = 0;
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = pathOf(input);
      if (path === '/auth/session') {
        sessions += 1;
        return Promise.resolve(
          authenticated({
            accessToken: sessions === 1 ? 'cached-valid-token' : 'fresh-core-token',
          }),
        );
      }
      if (path === '/api/v1/workspaces') {
        coreTokens.push(
          input instanceof Request
            ? input.headers.get('Authorization')
            : new Headers(init?.headers).get('Authorization'),
        );
        return Promise.resolve(json({ message: 'Session revoked' }, 401));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetch);
    render(
      <AuthProvider>
        <ApiClientProvider>
          <SessionHarness />
          <CoreQueryHarness />
        </ApiClientProvider>
      </AuthProvider>,
    );
    await screen.findByText('authenticated');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Read workspaces' }));
    await waitFor(() => {
      expect(screen.getByLabelText('API result')).toHaveTextContent('Refused');
    });
    expect(sessions).toBe(2);
    expect(coreTokens).toEqual(['Bearer cached-valid-token', 'Bearer fresh-core-token']);
    expect(useSessionStore.getState().status).toBe('anonymous');
    expect(clear).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it.each([
    ['auth.principal_inactive', 'anonymous'],
    ['item.access_denied', 'authenticated'],
  ])('treats Core403 code %s according to its scope', async (code, expectedStatus) => {
    const fetch = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const path = pathOf(input);
      if (path === '/auth/session') return Promise.resolve(authenticated());
      return Promise.resolve(
        new Response(JSON.stringify({ type: 'about:blank', title: 'Refused', status: 403, code }), {
          status: 403,
          headers: { 'content-type': 'application/problem+json' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetch);
    render(
      <AuthProvider>
        <ApiClientProvider>
          <SessionHarness />
          <CoreQueryHarness />
        </ApiClientProvider>
      </AuthProvider>,
    );
    await screen.findByText('authenticated');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Read workspaces' }));
    await waitFor(() => {
      expect(screen.getByLabelText('API result')).toHaveTextContent('Refused');
    });
    expect(useSessionStore.getState().status).toBe(expectedStatus);
  });

  it('rejects renewal for another account and seals the departing account’s bodies', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const clear = vi.spyOn(drafts, 'clearDrafts');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(authenticated({ expiresAt: '2000-01-01T00:00:00Z' }))
        .mockResolvedValueOnce(
          authenticated({
            profile: { subject: 'person-2', name: 'Other Person' },
            accessToken: 'other-account-token',
          }),
        ),
    );
    renderProvider();
    await screen.findByText('authenticated');
    const departingEpoch = bodies.bodyCacheAccountEpoch('person-1');
    expect(departingEpoch).not.toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Read access token' }));
    await screen.findByText('anonymous');
    expect(screen.getByLabelText('Access token')).toHaveTextContent('No token');
    expect(bodies.sealAccountBodies).toHaveBeenCalledWith('person-1');
    expect(clear).not.toHaveBeenCalled();
    expect(useSessionStore.getState().profile).toBeNull();
  });

  it.each(['another account', 'a fresh session for the same account'])(
    'ignores a delayed cross-tab sign-out for %s',
    async (scope) => {
      vi.spyOn(bodies, 'bodyCacheCleanupCurrent').mockReturnValue(false);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(authenticated()));
      renderProvider();
      await screen.findByText('authenticated');
      window.dispatchEvent(
        new CustomEvent('nix:signed-out-elsewhere', {
          detail: {
            subject: scope === 'another account' ? 'person-2' : 'person-1',
            epoch: 'old-epoch',
          },
        }),
      );
      expect(useSessionStore.getState().status).toBe('authenticated');
    },
  );

  it('restores no account while Core is unreachable and never authenticates', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetch);
    renderProvider();
    await screen.findByText('unreachable');
    expect(useSessionStore.getState().profile).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Read access token' }));
    expect(await screen.findByLabelText('Access token')).toHaveTextContent('No token');
    expect(useSessionStore.getState().status).toBe('unreachable');
  });

  it('retries the session after an unreachable Core without inventing an account', async () => {
    const pending = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockReturnValueOnce(pending.promise),
    );
    renderProvider();
    await screen.findByText('unreachable');
    useSessionStore.getState().sessionRetryRequested();
    await screen.findByText('authenticating');
    expect(useSessionStore.getState().profile).toBeNull();
    pending.resolve(anonymous());
    await screen.findByText('anonymous');
    expect(useSessionStore.getState().profile).toBeNull();
  });

  it('finishes anonymously from the server session endpoint without provider traffic', async () => {
    const fetch = vi.fn().mockResolvedValue(anonymous());
    vi.stubGlobal('fetch', fetch);

    renderProvider();

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      '/auth/session',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    );
  });

  it('restores a profile and retains only the short-lived Core token in memory', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn().mockResolvedValue(authenticated());
    vi.stubGlobal('fetch', fetch);

    renderProvider();

    expect(await screen.findByText('authenticated')).toBeInTheDocument();
    expect(useSessionStore.getState().profile).toEqual({
      subject: 'person-1',
      name: 'Stored Person',
      email: null,
    });
    await user.click(screen.getByRole('button', { name: 'Read access token' }));
    expect(await screen.findByText('core-session-token')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('offers the provider account page that Core names', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          authenticated({ accountUrl: 'https://sso.example.test/ui/console/users/me' }),
        ),
    );

    renderProvider();

    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Account page' })).toHaveTextContent(
        'https://sso.example.test/ui/console/users/me',
      );
    });
  });

  it('drops an account page that is not a web address but still signs in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(authenticated({ accountUrl: 'javascript:alert(1)' })),
    );

    renderProvider();

    expect(await screen.findByText('authenticated')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Account page' })).toHaveTextContent(
      'No account page',
    );
  });

  it('reports an unconfigured server only after its authoritative response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(anonymous(false)));

    renderProvider();

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(screen.getByLabelText('Configured')).toHaveTextContent('Unconfigured');
  });

  it('restarts restoration when StrictMode replays the startup effect', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(anonymous()));
    vi.stubGlobal('fetch', fetch);

    renderProvider(true);

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('aborts a deferred restore and returns the store to unknown when unmounted', async () => {
    const response = deferred<Response>();
    const fetch = vi.fn().mockReturnValue(response.promise);
    vi.stubGlobal('fetch', fetch);
    const view = renderProvider();

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledOnce();
    });
    const signal = (fetch.mock.calls[0]?.[1] as RequestInit | undefined)?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
    response.resolve(authenticated());
    await Promise.resolve();
    expect(useSessionStore.getState().status).toBe('unknown');
  });

  it('single-flights renewal of an expired in-memory token', async () => {
    const user = userEvent.setup();
    const refresh = deferred<Response>();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          authenticated: true,
          configured: true,
          profile: { subject: 'person-1', name: 'Stored Person' },
          accessToken: 'expired-core-token',
          expiresAt: '2000-01-01T00:00:00+00:00',
        }),
      )
      .mockReturnValue(refresh.promise);
    vi.stubGlobal('fetch', fetch);
    renderProvider();
    await screen.findByText('authenticated');

    await user.click(screen.getByRole('button', { name: 'Read access token' }));
    await user.click(screen.getByRole('button', { name: 'Read access token' }));
    expect(fetch).toHaveBeenCalledTimes(2);
    refresh.resolve(authenticated({ accessToken: 'renewed-core-token', expiresAt: future }));
    expect(await screen.findByText('renewed-core-token')).toBeInTheDocument();
  });

  it('still signs out of Core when local draft cleanup is unavailable and reports the cleanup failure', async () => {
    const user = userEvent.setup();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(authenticated())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('indexedDB', { deleteDatabase: vi.fn() });
    const clear = vi.spyOn(drafts, 'clearDrafts').mockRejectedValue(new Error('Storage blocked'));
    const clearBodies = vi.spyOn(bodies, 'clearBodyCache').mockResolvedValue(undefined);
    renderProvider();
    await screen.findByText('authenticated');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('failed');
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(useSessionStore.getState().error).toContain('could not be cleared');
    clear.mockRestore();
    clearBodies.mockRestore();
    vi.unstubAllGlobals();
  });

  it('reports an unreachable Core as offline rather than a failed sign-in, and retries when the network returns', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(authenticated());
    vi.stubGlobal('fetch', fetch);
    renderProvider();
    expect(await screen.findByText('unreachable')).toBeInTheDocument();

    window.dispatchEvent(new Event('online'));

    expect(await screen.findByText('authenticated')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('treats a proxy answering for a stopped Core as unreachable, not a failed sign-in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Bad gateway', { status: 502 })));
    renderProvider();
    expect(await screen.findByText('unreachable')).toBeInTheDocument();
    expect(useSessionStore.getState().unreachable?.cause).toBe('server');
    vi.unstubAllGlobals();
  });

  it('keeps retrying on a timer while Core stays unreachable, without waiting for a network change', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(authenticated());
    vi.stubGlobal('fetch', fetch);
    renderProvider();
    expect(await screen.findByText('unreachable')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(await screen.findByText('authenticated')).toBeInTheDocument();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports a bug in reading the session as a failure, not as an outage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ authenticated: true, configured: true, profile: 7 })),
    );
    renderProvider();
    expect(await screen.findByText('failed')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('still reports a malformed session response as a failed sign-in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html></html>', { status: 200 })),
    );
    renderProvider();
    expect(await screen.findByText('failed')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('removes locally saved pages along with drafts when signing out', async () => {
    const user = userEvent.setup();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(authenticated())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('indexedDB', new IDBFactory());
    const clearDrafts = vi.spyOn(drafts, 'clearDrafts').mockResolvedValue(undefined);
    const clearBodies = vi.spyOn(bodies, 'clearBodyCache').mockResolvedValue(undefined);
    renderProvider();
    await screen.findByText('authenticated');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('anonymous');
    expect(clearDrafts).toHaveBeenCalledOnce();
    expect(clearBodies).toHaveBeenCalledOnce();
    clearDrafts.mockRestore();
    clearBodies.mockRestore();
    vi.unstubAllGlobals();
  });

  it.each(['local', 'another tab'])(
    'clears pre-upgrade recording chunks on %s sign-out',
    async (source) => {
      const factory = new IDBFactory();
      vi.stubGlobal('indexedDB', factory);
      vi.spyOn(bodies, 'openBodyCache').mockResolvedValue(undefined);
      vi.spyOn(bodies, 'clearBodyCache').mockResolvedValue(undefined);
      vi.spyOn(drafts, 'clearDrafts').mockResolvedValue(undefined);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open('nix-recordings', 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('sessions', { keyPath: 'id' });
          request.result.createObjectStore('chunks', { keyPath: ['sessionId', 'index'] });
        };
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(new Error('Recording fixture request failed.', { cause: request.error }));
        };
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(['sessions', 'chunks'], 'readwrite');
          transaction.objectStore('sessions').put({ id: 'old-recording', principalId: 'person-1' });
          transaction
            .objectStore('chunks')
            .put({ sessionId: 'old-recording', index: 0, bytes: new ArrayBuffer(16) });
          transaction.oncomplete = () => {
            resolve();
          };
          transaction.onerror = () => {
            reject(
              new Error('Recording fixture transaction failed.', { cause: transaction.error }),
            );
          };
        });
        vi.stubGlobal(
          'fetch',
          vi
            .fn()
            .mockResolvedValueOnce(authenticated())
            .mockResolvedValueOnce(new Response(null, { status: 204 })),
        );
        renderProvider();
        await screen.findByText('authenticated');
        if (source === 'local') {
          await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
        } else {
          window.dispatchEvent(new Event('nix:signed-out-elsewhere'));
        }
        await screen.findByText('anonymous');
        // Keep the old tab's handle open: deleting the database would remain blocked.
        await waitFor(async () => {
          for (const name of ['sessions', 'chunks']) {
            const count = await new Promise<number>((resolve, reject) => {
              const request = db.transaction(name).objectStore(name).count();
              request.onsuccess = () => {
                resolve(request.result);
              };
              request.onerror = () => {
                reject(new Error('Recording fixture request failed.', { cause: request.error }));
              };
            });
            expect(count).toBe(0);
          }
        });
      } finally {
        db.close();
        vi.unstubAllGlobals();
      }
    },
  );

  it('revokes the Core session and clears the in-memory token on sign-out', async () => {
    const user = userEvent.setup();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(authenticated())
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({}, 401));
    vi.stubGlobal('fetch', fetch);
    renderProvider();
    await screen.findByText('authenticated');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/auth/logout',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    // A deliberate sign-out needs no excuse - it is not the answer to "what happened", it is
    // what the person just asked for. Checked before the next click, which itself triggers a
    // renewal attempt (and this fixture's mocked 401) that is not part of what this test is about.
    expect(useSessionStore.getState().error).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Read access token' }));
    expect(await screen.findByText('No token')).toBeInTheDocument();
  });

  it('unsubscribes this device from push, and reports it to Core, before the Core session ends', async () => {
    const user = userEvent.setup();
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const getSubscription = vi
      .fn()
      .mockResolvedValue({ endpoint: 'https://push.example/device-1', unsubscribe });
    vi.spyOn(registerServiceWorker, 'getServiceWorkerRegistration').mockReturnValue({
      pushManager: { getSubscription },
    } as unknown as ServiceWorkerRegistration);

    const fetch = vi
      .fn()
      .mockResolvedValueOnce(authenticated())
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // the push-subscription DELETE
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // /auth/logout
      .mockResolvedValueOnce(json({}, 401));
    vi.stubGlobal('fetch', fetch);
    renderProvider();
    await screen.findByText('authenticated');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('anonymous')).toBeInTheDocument();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/v1/me/push-subscriptions', {
      method: 'DELETE',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer core-session-token',
      },
      body: JSON.stringify({ endpoint: 'https://push.example/device-1' }),
    });
    // The unsubscribe runs before the bearer token is cleared, and before the cookie session
    // ends - the whole point is to still be able to authenticate the DELETE.
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('signs out normally when there is no push subscription to remove', async () => {
    const user = userEvent.setup();
    vi.spyOn(registerServiceWorker, 'getServiceWorkerRegistration').mockReturnValue(undefined);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(authenticated())
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({}, 401));
    vi.stubGlobal('fetch', fetch);
    renderProvider();
    await screen.findByText('authenticated');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    // No registration means nothing to unsubscribe - straight to /auth/logout as the first call.
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('explains that the session expired when a renew finds it gone, unlike a deliberate sign-out', async () => {
    const user = userEvent.setup();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          authenticated: true,
          configured: true,
          profile: { subject: 'person-1', name: 'Stored Person' },
          accessToken: 'expired-core-token',
          expiresAt: '2000-01-01T00:00:00+00:00',
        }),
      )
      .mockResolvedValueOnce(json({}, 401));
    vi.stubGlobal('fetch', fetch);
    renderProvider();
    await screen.findByText('authenticated');

    await user.click(screen.getByRole('button', { name: 'Read access token' }));

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(useSessionStore.getState().error).toBe(
      'Your session expired. Sign in again to continue.',
    );
  });

  it('forgets pick history and dismissed suggestions when another tab signs out', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(authenticated()));
    renderProvider();
    await screen.findByText('authenticated');
    recordPick('select:w1:status', 'Done');
    rememberDismissal('mention:w1:item-1');

    window.dispatchEvent(new Event('nix:signed-out-elsewhere'));

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(frecencyScores('select:w1:status').size).toBe(0);
    expect(readDismissals().size).toBe(0);
    vi.unstubAllGlobals();
  });

  it('forgets pick history and dismissed suggestions on sign-out', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(authenticated())
        .mockResolvedValueOnce(new Response(null, { status: 204 })),
    );
    renderProvider();
    await screen.findByText('authenticated');
    recordPick('slash', 'heading');
    rememberDismissal('mention:w1:item-1');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    await screen.findByText('anonymous');
    expect(frecencyScores('slash').size).toBe(0);
    expect(readDismissals().size).toBe(0);
    vi.unstubAllGlobals();
  });
});

/** An in-memory `Storage`: the test environment's global is not a usable one. */
