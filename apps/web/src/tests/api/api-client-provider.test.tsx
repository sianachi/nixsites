import { defineCommand, type NixClient } from '@nix/api-client';
import { act, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ApiClientProvider, useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { json } from '@nix/web-foundation/testing/json-response';

const auth = vi.hoisted(() => ({
  getAccessToken: vi.fn<(forceRefresh?: boolean) => Promise<string | null>>(),
  handleSessionRefusal: vi.fn<(subject: string) => void>(),
}));

vi.mock('@nix/web-platform/auth/auth-provider', () => ({
  useAuth: () => auth,
}));

const SUBJECT = 'provider-session-person';
const profile = { subject: SUBJECT, name: 'Stored person', email: null };
const command = defineCommand({
  operation: 'test.session-token',
  method: 'POST',
  path: '/session-token-test',
  body: { read: true },
  schema: z.object({ ok: z.literal(true) }),
});

function ClientHarness({ onClient }: { readonly onClient: (client: NixClient) => void }) {
  const client = useApiClient();
  useEffect(() => {
    onClient(client);
  }, [client, onClient]);
  return null;
}

function renderClient(): NixClient {
  let captured: NixClient | undefined;
  render(
    <ApiClientProvider>
      <ClientHarness
        onClient={(client) => {
          captured = client;
        }}
      />
    </ApiClientProvider>,
  );
  if (captured === undefined) throw new Error('The provider did not supply a client.');
  return captured;
}

beforeEach(() => {
  auth.getAccessToken.mockReset();
  auth.getAccessToken.mockResolvedValue('current-token');
  auth.handleSessionRefusal.mockReset();
  useSessionStore.setState({
    status: 'authenticated',
    profile,
    error: null,
    restoreAttempt: 0,
    unreachable: null,
  });
});

describe('API client browser session admission', () => {
  it.each(['unreachable', 'authenticating'] as const)(
    'rejects locally when the stored account is %s and has no bearer token',
    async (status) => {
      useSessionStore.setState({ status });
      auth.getAccessToken.mockResolvedValue(null);
      const fetch = vi.fn(() =>
        Promise.resolve(
          json({ title: 'No bearer', status: 401, code: 'auth.unauthenticated' }, 401),
        ),
      );
      vi.stubGlobal('fetch', fetch);
      const client = renderClient();

      await expect(client.execute(command)).rejects.toBeInstanceOf(Error);

      expect(fetch).not.toHaveBeenCalled();
      expect(auth.handleSessionRefusal).not.toHaveBeenCalled();
      expect(useSessionStore.getState().profile).toEqual(profile);
      expect(useSessionStore.getState().status).toBe(status);
    },
  );

  it('uses a later fresh token through the same client after a tokenless restore attempt', async () => {
    useSessionStore.setState({ status: 'unreachable' });
    auth.getAccessToken.mockResolvedValue(null);
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer restored-token');
      return Promise.resolve(json({ ok: true }));
    });
    vi.stubGlobal('fetch', fetch);
    const client = renderClient();
    await expect(client.execute(command)).rejects.toBeInstanceOf(Error);
    expect(fetch).not.toHaveBeenCalled();

    act(() => {
      useSessionStore.getState().signInSucceeded(profile);
    });
    auth.getAccessToken.mockResolvedValue('restored-token');

    await expect(client.execute(command)).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledOnce();
    expect(auth.handleSessionRefusal).not.toHaveBeenCalled();
  });

  it('refuses a delayed token belonging to another account before the old client sends it', async () => {
    let resolveToken: (token: string | null) => void = () => {
      throw new Error('The token request was not initialized.');
    };
    const token = new Promise<string | null>((resolve) => {
      resolveToken = resolve;
    });
    auth.getAccessToken.mockImplementation(() => token);
    const fetch = vi.fn(() => Promise.resolve(json({ ok: true })));
    vi.stubGlobal('fetch', fetch);
    const client = renderClient();
    const outcome = client.execute(command).catch((cause: unknown) => cause);
    await waitFor(() => {
      expect(auth.getAccessToken).toHaveBeenCalledOnce();
    });
    act(() => {
      useSessionStore.getState().signInSucceeded({
        subject: 'another-person',
        name: 'Another person',
        email: null,
      });
    });
    resolveToken('another-person-token');

    expect(await outcome).toBeInstanceOf(Error);
    expect(fetch).not.toHaveBeenCalled();
    expect(auth.handleSessionRefusal).not.toHaveBeenCalled();
    expect(useSessionStore.getState().profile?.subject).toBe('another-person');
  });

  it('reports an authoritative 401 after both the current and refreshed bearer are refused', async () => {
    auth.getAccessToken.mockImplementation((forceRefresh = false) =>
      Promise.resolve(forceRefresh ? 'refreshed-token' : 'expired-token'),
    );
    const authorization: (string | null)[] = [];
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      authorization.push(new Headers(init?.headers).get('authorization'));
      return Promise.resolve(
        json({ title: 'Session expired', status: 401, code: 'auth.unauthenticated' }, 401),
      );
    });
    vi.stubGlobal('fetch', fetch);
    const client = renderClient();

    await expect(client.execute(command)).rejects.toMatchObject({
      status: 401,
      code: 'auth.unauthenticated',
    });

    expect(authorization).toEqual(['Bearer expired-token', 'Bearer refreshed-token']);
    expect(auth.getAccessToken).toHaveBeenCalledWith(true);
    expect(auth.handleSessionRefusal).toHaveBeenCalledExactlyOnceWith(SUBJECT);
  });

  it('refuses a refreshed token from another account before retrying the old request', async () => {
    let resolveRefresh: (token: string | null) => void = () => {
      throw new Error('The refresh request was not initialized.');
    };
    const refreshed = new Promise<string | null>((resolve) => {
      resolveRefresh = resolve;
    });
    auth.getAccessToken.mockImplementation((forceRefresh = false) =>
      forceRefresh ? refreshed : Promise.resolve('expired-token'),
    );
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer expired-token');
      return Promise.resolve(
        json({ title: 'Session expired', status: 401, code: 'auth.unauthenticated' }, 401),
      );
    });
    vi.stubGlobal('fetch', fetch);
    const client = renderClient();
    const outcome = client.execute(command).catch((cause: unknown) => cause);
    await waitFor(() => {
      expect(auth.getAccessToken).toHaveBeenCalledWith(true);
    });
    act(() => {
      useSessionStore.getState().signInSucceeded({
        subject: 'another-person',
        name: 'Another person',
        email: null,
      });
    });
    resolveRefresh('another-person-token');

    expect(await outcome).toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledOnce();
    expect(auth.handleSessionRefusal).not.toHaveBeenCalled();
    expect(useSessionStore.getState().profile?.subject).toBe('another-person');
  });

  it('accepts a fresh bearer when the same admitted profile is normalized during renewal', async () => {
    let resolveRefresh: (token: string | null) => void = () => {
      throw new Error('The refresh request was not initialized.');
    };
    const refreshed = new Promise<string | null>((resolve) => {
      resolveRefresh = resolve;
    });
    auth.getAccessToken.mockImplementation((forceRefresh = false) =>
      forceRefresh ? refreshed : Promise.resolve('expired-token'),
    );
    const authorization: (string | null)[] = [];
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const bearer = new Headers(init?.headers).get('authorization');
      authorization.push(bearer);
      return Promise.resolve(
        bearer === 'Bearer refreshed-token'
          ? json({ ok: true })
          : json({ title: 'Session expired', status: 401, code: 'auth.unauthenticated' }, 401),
      );
    });
    vi.stubGlobal('fetch', fetch);
    const client = renderClient();
    const outcome = client.execute(command);
    await waitFor(() => {
      expect(auth.getAccessToken).toHaveBeenCalledWith(true);
    });
    act(() => {
      useSessionStore.getState().signInSucceeded({ ...profile, name: 'Normalized person' });
    });
    resolveRefresh('refreshed-token');

    await expect(outcome).resolves.toEqual({ ok: true });
    expect(authorization).toEqual(['Bearer expired-token', 'Bearer refreshed-token']);
    expect(auth.handleSessionRefusal).not.toHaveBeenCalled();
    expect(useSessionStore.getState().profile?.name).toBe('Normalized person');
  });

  it('preserves a genuine bearer 401 refusal when forced refresh returns no token', async () => {
    auth.getAccessToken.mockImplementation((forceRefresh = false) =>
      Promise.resolve(forceRefresh ? null : 'expired-token'),
    );
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer expired-token');
      return Promise.resolve(
        json({ title: 'Session expired', status: 401, code: 'auth.unauthenticated' }, 401),
      );
    });
    vi.stubGlobal('fetch', fetch);
    const client = renderClient();

    await expect(client.execute(command)).rejects.toMatchObject({
      status: 401,
      code: 'auth.unauthenticated',
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(auth.getAccessToken).toHaveBeenCalledWith(true);
    expect(auth.handleSessionRefusal).toHaveBeenCalledExactlyOnceWith(SUBJECT);
  });

  it.each(['unknown', 'authenticating'] as const)(
    'keeps the stored account when a pending forced renewal returns null during %s',
    async (status) => {
      let resolveRefresh: (token: string | null) => void = () => {
        throw new Error('The refresh request was not initialized.');
      };
      const refreshed = new Promise<string | null>((resolve) => {
        resolveRefresh = resolve;
      });
      auth.getAccessToken.mockImplementation((forceRefresh = false) =>
        forceRefresh ? refreshed : Promise.resolve('expired-token'),
      );
      const fetch = vi.fn(() =>
        Promise.resolve(
          json({ title: 'Session expired', status: 401, code: 'auth.unauthenticated' }, 401),
        ),
      );
      vi.stubGlobal('fetch', fetch);
      const client = renderClient();
      const outcome = client.execute(command).catch((cause: unknown) => cause);
      await waitFor(() => {
        expect(auth.getAccessToken).toHaveBeenCalledWith(true);
      });
      act(() => {
        useSessionStore.setState({ status });
      });
      resolveRefresh(null);

      expect(await outcome).toMatchObject({ kind: 'network', code: 'client.network' });
      expect(fetch).toHaveBeenCalledOnce();
      expect(auth.handleSessionRefusal).not.toHaveBeenCalled();
      expect(useSessionStore.getState().status).toBe(status);
      expect(useSessionStore.getState().profile).toBe(profile);
    },
  );

  it('reports an authoritative principal-inactive refusal made with a real bearer', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer current-token');
      return Promise.resolve(
        json({ title: 'Principal inactive', status: 403, code: 'auth.principal_inactive' }, 403),
      );
    });
    vi.stubGlobal('fetch', fetch);
    const client = renderClient();

    await expect(client.execute(command)).rejects.toMatchObject({
      status: 403,
      code: 'auth.principal_inactive',
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(auth.getAccessToken).not.toHaveBeenCalledWith(true);
    expect(auth.handleSessionRefusal).toHaveBeenCalledExactlyOnceWith(SUBJECT);
  });

  it('preserves unsigned requests when there is no stored account subject', async () => {
    useSessionStore.setState({ status: 'anonymous', profile: null });
    auth.getAccessToken.mockResolvedValue(null);
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return Promise.resolve(json({ ok: true }));
    });
    vi.stubGlobal('fetch', fetch);
    const client = renderClient();

    await expect(client.execute(command)).resolves.toEqual({ ok: true });

    expect(fetch).toHaveBeenCalledOnce();
    expect(auth.handleSessionRefusal).not.toHaveBeenCalled();
  });
});
