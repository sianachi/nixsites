import { describe, expect, it, vi } from 'vitest';
import { createFetchMirrorApi, MirrorHttpError, MirrorUnreachableError } from './fetch-api.js';
import { MirrorAccessRevokedError } from './mirror.js';

function api(
  status = 200,
  isSessionClosed?: () => boolean,
  body: unknown = { ok: true },
  statuses: number[] = [],
) {
  const fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status: statuses.shift() ?? status,
        headers: { 'retry-after': '1' },
      }),
    ),
  );
  const wait = vi.fn(() => Promise.resolve());
  const mirror = createFetchMirrorApi({
    coreUrl: 'https://core.test/',
    collabUrl: 'https://collab.test',
    getToken: () => Promise.resolve('tok'),
    fetch: fetchMock,
    wait,
    ...(isSessionClosed ? { isSessionClosed } : {}),
  });
  return { mirror, fetchMock, wait };
}

describe('createFetchMirrorApi', () => {
  it('builds the sync routes with a bearer token and no cookies', async () => {
    const { mirror, fetchMock } = api();
    await mirror.snapshot({ workspaceId: 'w1', boundary: '9', cursor: 'c', limit: 500 });
    await mirror.changes({ workspaceId: 'w1', after: '91', limit: 200 });
    await mirror.reconcile({ workspaceId: 'w1', itemIds: ['a'] });
    await mirror.syncBodies({ documents: [] });
    const calls = fetchMock.mock.calls.map(([url, init = {}]) => [url as string, init] as const);
    expect(calls.map(([url, init]) => `${String(init.method)} ${url}`)).toEqual([
      'GET https://core.test/api/v1/workspaces/w1/sync/snapshot?limit=500&boundary=9&cursor=c',
      'GET https://core.test/api/v1/workspaces/w1/sync/changes?after=91&limit=200',
      'POST https://core.test/api/v1/workspaces/w1/sync/reconcile',
      'POST https://collab.test/documents/sync',
    ]);
    expect(calls[0]?.[1].headers).toMatchObject({ authorization: 'Bearer tok' });
    expect(calls[0]?.[1].credentials).toBe('omit');
    expect(JSON.parse(calls[2]?.[1].body as string)).toEqual({ itemIds: ['a'] });
  });

  it('maps 403/404 on workspace routes to workspace revocation, not on replay', async () => {
    const refusal = { code: 'workspace.not_found' };
    await expect(
      api(403, undefined, refusal).mirror.changes({ workspaceId: 'w', after: '0', limit: 1 }),
    ).rejects.toEqual(new MirrorAccessRevokedError('workspace'));
    await expect(
      api(404).mirror.replay({ workspaceId: 'w', operation: {} as never }),
    ).rejects.toBeInstanceOf(MirrorHttpError);
  });

  it('revokes the account on 401 only when the session is closed', async () => {
    await expect(api(401).mirror.syncBodies({} as never)).rejects.toBeInstanceOf(MirrorHttpError);
    await expect(api(401, () => true).mirror.syncBodies({} as never)).rejects.toEqual(
      new MirrorAccessRevokedError('account'),
    );
  });

  it("does not take a 403/404 that is not Core's own refusal as revocation", async () => {
    for (const body of ['<html>Checking your browser</html>', { ok: true }])
      for (const status of [403, 404])
        await expect(
          api(status, undefined, body).mirror.changes({ workspaceId: 'w', after: '0', limit: 1 }),
        ).rejects.toBeInstanceOf(MirrorHttpError);
  });

  it('waits out a rate limit and tries again, three attempts in all', async () => {
    const once = api(200, undefined, { ok: true }, [429]);
    await expect(once.mirror.syncBodies({ documents: [] })).resolves.toEqual({ ok: true });
    expect(once.wait).toHaveBeenCalledExactlyOnceWith(1000);
    const always = api(429);
    await expect(always.mirror.syncBodies({ documents: [] })).rejects.toBeInstanceOf(
      MirrorHttpError,
    );
    expect(always.fetchMock).toHaveBeenCalledTimes(3);
  });

  it('names a request that got no answer, apart from one the server refused', async () => {
    const mirror = createFetchMirrorApi({
      coreUrl: 'https://core.test',
      collabUrl: 'https://collab.test',
      getToken: () => Promise.resolve('tok'),
      fetch: () => Promise.reject(new TypeError('Load failed')),
    });
    await expect(mirror.syncBodies({ documents: [] })).rejects.toBeInstanceOf(
      MirrorUnreachableError,
    );
  });
});
