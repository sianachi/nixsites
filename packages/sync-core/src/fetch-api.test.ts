import { describe, expect, it, vi } from 'vitest';
import { createFetchMirrorApi, MirrorHttpError } from './fetch-api.js';
import { MirrorAccessRevokedError } from './mirror.js';

function api(status = 200, isSessionClosed?: () => boolean) {
  const fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(JSON.stringify({ ok: true }), { status })),
  );
  const mirror = createFetchMirrorApi({
    coreUrl: 'https://core.test/',
    collabUrl: 'https://collab.test',
    getToken: () => Promise.resolve('tok'),
    fetch: fetchMock,
    ...(isSessionClosed ? { isSessionClosed } : {}),
  });
  return { mirror, fetchMock };
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
    await expect(
      api(403).mirror.changes({ workspaceId: 'w', after: '0', limit: 1 }),
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
});
