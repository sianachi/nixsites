import { describe, expect, it, vi } from 'vitest';
import {
  createInteractiveTokenProvider,
  createPatTokenProvider,
  endpointsFor,
  openSession,
  whoami,
} from './session.ts';
import type { Profile } from './config.ts';
import { workspaces } from '@nix/api-client';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

const profile: Profile = { apiUrl: 'http://localhost:5014', token: 'nixpat_abc' };

function exchangeResponse(accessToken: string, expiresInSeconds = 600): Response {
  return new Response(JSON.stringify({ accessToken, tokenType: 'Bearer', expiresInSeconds }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('the PAT token provider', () => {
  it('exchanges the personal access token for a session JWT', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(exchangeResponse('jwt-1')));
    const tokens = createPatTokenProvider({ profile, fetchImpl });

    expect(await tokens.getAccessToken()).toBe('jwt-1');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:5014/public/v1/auth/token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('serves the cached JWT until it nears expiry, then re-exchanges', async () => {
    let clock = 0;
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(exchangeResponse('jwt-1', 600))
      .mockResolvedValueOnce(exchangeResponse('jwt-2', 600));
    const tokens = createPatTokenProvider({ profile, fetchImpl, now: () => clock });

    expect(await tokens.getAccessToken()).toBe('jwt-1');
    clock = 100_000; // still comfortably inside the 600s lifetime
    expect(await tokens.getAccessToken()).toBe('jwt-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock = 590_000; // inside the 30s skew of the 600s expiry
    expect(await tokens.getAccessToken()).toBe('jwt-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('collapses a burst of concurrent stale reads into one exchange', async () => {
    const fetchImpl = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return exchangeResponse('jwt-1');
    });
    const tokens = createPatTokenProvider({ profile, fetchImpl });

    const results = await Promise.all([
      tokens.getAccessToken(),
      tokens.getAccessToken(),
      tokens.getAccessToken(),
    ]);

    expect(results).toEqual(['jwt-1', 'jwt-1', 'jwt-1']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces Core its own refusal when the token cannot mint a session', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ code: 'auth.token_revoked', detail: 'That token was revoked.' }),
          {
            status: 401,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    );
    const tokens = createPatTokenProvider({ profile, fetchImpl });

    await expect(tokens.getAccessToken()).rejects.toThrow('That token was revoked.');
  });
});

describe('browser-approved CLI token provider', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const interactive: Profile = {
    apiUrl: profile.apiUrl,
    token: '',
    interactiveSession: { refreshToken: 'nixcli_test', expiresAt: '2026-10-09T13:00:00Z' },
  };
  function token(accessToken: string, expiresAt = now + 600_000): Response {
    return new Response(
      JSON.stringify({
        accessToken,
        expiresAt: new Date(expiresAt).toISOString(),
        sessionExpiresAt: interactive.interactiveSession?.expiresAt,
      }),
      { status: 200 },
    );
  }

  it('renews from the saved CLI credential, caches it and refreshes before expiry', async () => {
    let clock = now;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(token('first'))
      .mockResolvedValueOnce(token('next', now + 1_200_000));
    const provider = createInteractiveTokenProvider({
      profile: interactive,
      now: () => clock,
      fetchImpl,
    });
    expect(await provider.getAccessToken()).toBe('first');
    clock += 60_000;
    expect(await provider.getAccessToken()).toBe('first');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock = now + 580_000;
    expect(await provider.getAccessToken()).toBe('next');
    expect(fetchImpl).toHaveBeenLastCalledWith(
      `${interactive.apiUrl}/auth/cli/token`,
      expect.objectContaining({
        body: JSON.stringify({ refreshToken: 'nixcli_test' }),
        redirect: 'error',
      }),
    );
  });

  it('collapses concurrent initial reads and forced 401 refreshes into one exchange each', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(token('first'))
      .mockResolvedValueOnce(token('next'));
    const provider = createInteractiveTokenProvider({
      profile: interactive,
      now: () => now,
      fetchImpl,
    });
    expect(await Promise.all([provider.getAccessToken(), provider.getAccessToken()])).toEqual([
      'first',
      'first',
    ]);
    expect(
      await Promise.all([provider.refreshAccessToken(), provider.refreshAccessToken()]),
    ).toEqual(['next', 'next']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never refreshes after the hard session expiry', async () => {
    let clock = now;
    const fetchImpl = vi.fn().mockResolvedValue(token('first'));
    const provider = createInteractiveTokenProvider({
      profile: interactive,
      now: () => clock,
      fetchImpl,
    });
    await provider.getAccessToken();
    clock += 3_600_000;
    await expect(provider.getAccessToken()).rejects.toThrow(/session has expired/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retains the final capped token when the session has less than the refresh skew left', async () => {
    const expiry = new Date(now + 20_000).toISOString();
    const finalProfile: Profile = {
      ...interactive,
      interactiveSession: { refreshToken: 'nixcli_test', expiresAt: expiry },
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ accessToken: 'final', expiresAt: expiry, sessionExpiresAt: expiry }),
        ),
      );
    const provider = createInteractiveTokenProvider({
      profile: finalProfile,
      now: () => now,
      fetchImpl,
    });
    expect(await provider.getAccessToken()).toBe('final');
    expect(await provider.getAccessToken()).toBe('final');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('clears cached credentials on refusal without leaking a response body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(token('first'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: 'nixcli_test' }), { status: 401 }),
      );
    const provider = createInteractiveTokenProvider({
      profile: interactive,
      now: () => now,
      fetchImpl,
    });
    await provider.getAccessToken();
    await expect(provider.refreshAccessToken()).rejects.toThrow(
      /Core could not complete CLI authentication/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a server response that extends the saved hard session expiry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: 'first',
          expiresAt: '2026-10-09T14:00:00Z',
          sessionExpiresAt: '2026-10-09T14:00:00Z',
        }),
      ),
    );
    const provider = createInteractiveTokenProvider({
      profile: interactive,
      now: () => now,
      fetchImpl,
    });
    await expect(provider.getAccessToken()).rejects.toThrow(/invalid CLI session expiry/);
  });

  it('automatically refreshes and retries a real client request after a 401', async () => {
    const authorization: (string | null)[] = [];
    const server = setupServer(
      http.get(`${interactive.apiUrl}/api/v1/workspaces`, ({ request }) => {
        authorization.push(request.headers.get('authorization'));
        return authorization.length === 1
          ? new HttpResponse(null, { status: 401 })
          : HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    server.listen({ onUnhandledRequest: 'error' });
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(token('first'))
        .mockResolvedValueOnce(token('next'));
      const session = openSession({ profile: interactive, now: () => now, fetchImpl });
      expect(await session.client.query(workspaces.listWorkspacesPage())).toEqual({
        items: [],
        nextCursor: null,
      });
      expect(authorization).toEqual(['Bearer first', 'Bearer next']);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      server.close();
    }
  });
});

describe('endpoint resolution', () => {
  it('derives the collab and media origins from the API URL when a profile omits them', () => {
    expect(endpointsFor(profile)).toEqual({
      apiUrl: 'http://localhost:5014',
      collabUrl: 'http://localhost:8100',
      mediaUrl: 'http://localhost:8200',
    });
  });

  it('honours explicit service URLs', () => {
    expect(
      endpointsFor({ ...profile, collabUrl: 'http://collab', mediaUrl: 'http://media' }),
    ).toEqual({
      apiUrl: 'http://localhost:5014',
      collabUrl: 'http://collab',
      mediaUrl: 'http://media',
    });
  });
});

describe('whoami', () => {
  it('reads the acting principal from /api/v1/me with the exchanged bearer', async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url.endsWith('/public/v1/auth/token')) {
        return Promise.resolve(exchangeResponse('jwt-1'));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'p1',
            tenantId: 't1',
            displayName: 'Ada',
            email: 'ada@example.test',
            isTenantAdministrator: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    const session = openSession({ profile, fetchImpl });

    const principal = await whoami(session, fetchImpl);

    expect(principal.displayName).toBe('Ada');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:5014/api/v1/me',
      expect.objectContaining({ headers: { authorization: 'Bearer jwt-1' } }),
    );
  });
});

describe('authKind', () => {
  it('tells a browser-approved login from a token or an external bearer', () => {
    const login: Profile = {
      apiUrl: 'http://nix.test',
      token: '',
      interactiveSession: { refreshToken: 'nixcli_x', expiresAt: '2099-01-01T00:00:00.000Z' },
    };
    expect(openSession({ profile: login }).authKind).toBe('interactive');
    expect(
      openSession({ profile: { apiUrl: 'http://nix.test', token: 'nixpat_x' } }).authKind,
    ).toBe('token');
    expect(openSession({ profile: login, bearerToken: 'jwt' }).authKind).toBe('token');
  });
});
