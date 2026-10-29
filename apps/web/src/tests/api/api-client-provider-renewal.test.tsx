import { defineCommand, type NixClient } from '@nix/api-client';
import { act, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { z } from 'zod';

import { ApiClientProvider, useApiClient } from '@nix/web-platform/api/api-client-provider';
import { AuthProvider } from '@nix/web-platform/auth/auth-provider';
import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import * as bodies from '@nix/web-foundation/lib/body-cache';
import * as drafts from '@nix/web-foundation/lib/draft-journal';
import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';
import { json } from '@nix/web-foundation/testing/json-response';

const profile = { subject: 'renewal-person', name: 'Stored person', email: null };
const command = defineCommand({
  operation: 'test.session-renewal',
  method: 'POST',
  path: '/session-renewal-test',
  body: { read: true },
  schema: z.object({ ok: z.literal(true) }),
});

function session(accessToken: string): Response {
  return json({
    authenticated: true,
    configured: true,
    profile,
    accessToken,
    expiresAt: '2099-01-01T00:00:00+00:00',
  });
}

function pathOf(input: RequestInfo | URL): string {
  return new URL(input instanceof Request ? input.url : String(input), globalThis.location.origin)
    .pathname;
}

function Harness({ onClient }: { readonly onClient: (client: NixClient) => void }) {
  const client = useApiClient();
  const status = useSessionStore((state) => state.status);
  useEffect(() => {
    onClient(client);
  }, [client, onClient]);
  return <output aria-label="Session status">{status}</output>;
}

function renderProviders(): { readonly client: () => NixClient } {
  let captured: NixClient | undefined;
  render(
    <AuthProvider>
      <ApiClientProvider>
        <Harness
          onClient={(client) => {
            captured = client;
          }}
        />
      </ApiClientProvider>
    </AuthProvider>,
  );
  return {
    client: () => {
      if (captured === undefined) throw new Error('The provider did not supply a client.');
      return captured;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', FakeIDBKeyRange);
  vi.stubGlobal('localStorage', memoryStorage());
  useSessionStore.setState({
    status: 'unknown',
    profile: null,
    error: null,
    restoreAttempt: 0,
    unreachable: null,
  });
  vi.spyOn(bodies, 'openBodyCache').mockResolvedValue(undefined);
  vi.spyOn(bodies, 'sealAccountBodies').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bearer renewal through the real browser session provider', () => {
  it.each(['gateway outage', 'network drop', 'rate limit'] as const)(
    'keeps the session profile after a %s and resumes through automatic restoration',
    async (failure) => {
      const clearDrafts = vi.spyOn(drafts, 'clearDrafts');
      const coreTokens: (string | null)[] = [];
      let sessions = 0;
      const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const path = pathOf(input);
        if (path === '/auth/session') {
          sessions += 1;
          if (sessions === 1) return Promise.resolve(session('cached-bearer'));
          if (sessions === 2)
            return failure === 'network drop'
              ? Promise.reject(new TypeError('Failed to fetch'))
              : Promise.resolve(
                  new Response('Service unavailable', {
                    status: failure === 'rate limit' ? 429 : 503,
                  }),
                );
          return Promise.resolve(session('restored-bearer'));
        }
        if (path === '/session-renewal-test') {
          const bearer =
            input instanceof Request
              ? input.headers.get('authorization')
              : new Headers(init?.headers).get('authorization');
          coreTokens.push(bearer);
          return Promise.resolve(
            bearer === 'Bearer restored-bearer'
              ? json({ ok: true })
              : json({ title: 'Renew bearer', status: 401, code: 'auth.unauthenticated' }, 401),
          );
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      vi.stubGlobal('fetch', fetch);
      const providers = renderProviders();
      await waitFor(() => {
        expect(screen.getByLabelText('Session status')).toHaveTextContent('authenticated');
      });
      const client = providers.client();

      await act(async () => {
        await expect(client.execute(command)).rejects.toMatchObject({
          kind: 'network',
          code: 'client.network',
        });
      });

      expect(useSessionStore.getState().status).toBe('unreachable');
      expect(useSessionStore.getState().profile).toEqual(profile);
      expect(sessions).toBe(2);
      expect(coreTokens).toEqual(['Bearer cached-bearer']);
      expect(bodies.sealAccountBodies).not.toHaveBeenCalled();
      expect(clearDrafts).not.toHaveBeenCalled();

      act(() => {
        window.dispatchEvent(new Event('online'));
      });
      await waitFor(() => {
        expect(screen.getByLabelText('Session status')).toHaveTextContent('authenticated');
      });

      expect(providers.client()).toBe(client);
      await expect(client.execute(command)).resolves.toEqual({ ok: true });
      expect(sessions).toBe(3);
      expect(coreTokens).toEqual(['Bearer cached-bearer', 'Bearer restored-bearer']);
      expect(useSessionStore.getState().profile).toEqual(profile);
      expect(bodies.sealAccountBodies).not.toHaveBeenCalled();
    },
  );

  it('preserves a fresh same-account lifecycle when an old forced renewal answers 503', async () => {
    vi.mocked(bodies.openBodyCache).mockRestore();
    const clearDrafts = vi.spyOn(drafts, 'clearDrafts');
    let resolveRenewal: (response: Response) => void = () => {
      throw new Error('The renewal request was not initialized.');
    };
    const renewal = new Promise<Response>((resolve) => {
      resolveRenewal = resolve;
    });
    let sessions = 0;
    const coreTokens: (string | null)[] = [];
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = pathOf(input);
      if (path === '/auth/session') {
        sessions += 1;
        return sessions === 1 ? Promise.resolve(session('cached-bearer')) : renewal;
      }
      if (path === '/session-renewal-test') {
        coreTokens.push(new Headers(init?.headers).get('authorization'));
        return Promise.resolve(
          json({ title: 'Renew bearer', status: 401, code: 'auth.unauthenticated' }, 401),
        );
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetch);
    const providers = renderProviders();
    await waitFor(() => {
      expect(useSessionStore.getState().status).toBe('authenticated');
    });
    const oldEpoch = bodies.bodyCacheAccountEpoch(profile.subject);
    const outcome = providers
      .client()
      .execute(command)
      .catch((cause: unknown) => cause);
    await waitFor(() => {
      expect(sessions).toBe(2);
    });

    await bodies.clearBodyCache(profile.subject);
    await bodies.openBodyCache(profile.subject, { reauthorized: true });
    const freshProfile = { ...profile, name: 'Fresh session person' };
    act(() => {
      useSessionStore.getState().signInSucceeded(freshProfile);
    });
    const freshEpoch = bodies.bodyCacheAccountEpoch(profile.subject);
    expect(freshEpoch).not.toBe(oldEpoch);
    const scope = JSON.stringify([profile.subject, 'workspace', 'note', 'note']);
    const doc = new Y.Doc();
    doc.getText('note').insert(0, 'Fresh same-person cached note');
    const update = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    await bodies.writeBodyCache({
      scope,
      docId: 'fresh-document',
      schemaVersion: 1,
      savedAt: Date.now(),
      update,
    });
    const retained = await bodies.readBodyCache(scope);
    expect(retained).not.toBeNull();
    await act(async () => {
      resolveRenewal(new Response('Service unavailable', { status: 503 }));
      expect(await outcome).toMatchObject({ kind: 'network', code: 'client.network' });
    });

    expect(coreTokens).toEqual(['Bearer cached-bearer']);
    expect(sessions).toBe(2);
    expect(useSessionStore.getState().status).toBe('authenticated');
    expect(useSessionStore.getState().profile).toBe(freshProfile);
    expect(useSessionStore.getState().unreachable).toBeNull();
    expect(bodies.bodyCacheAccountEpoch(profile.subject)).toBe(freshEpoch);
    expect(bodies.bodyCacheAdmits(scope)).toBe(true);
    expect(await bodies.readBodyCache(scope)).toEqual(retained);
    expect(bodies.sealAccountBodies).not.toHaveBeenCalled();
    expect(clearDrafts).not.toHaveBeenCalled();
  });
});
