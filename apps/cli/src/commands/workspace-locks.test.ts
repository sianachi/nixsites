import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  joinWorkspace,
  relockWorkspace,
  removeWorkspacePassword,
  setWorkspacePassword,
  unlockWorkspace,
} from './workspace-locks.ts';
import { captureJson, makeProfile } from './cli.test-helper.ts';

const API = 'http://nix.test';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';

const server = setupServer(
  http.post(`${API}/public/v1/auth/token`, () =>
    HttpResponse.json({ accessToken: 'jwt-1', tokenType: 'Bearer', expiresInSeconds: 600 }),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

const withProfile = () => makeProfile({ apiUrl: API, token: 'nixpat_abc' });

describe('the workspace password commands over a stubbed Core', () => {
  it('sets a password with the password in the body, never the URL', async () => {
    const { env, done } = await withProfile();
    let sent: unknown = null;
    let url = '';
    server.use(
      http.put(`${API}/api/v1/workspaces/:workspaceId/password`, async ({ request }) => {
        url = request.url;
        sent = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const printed = await captureJson((json) =>
      setWorkspacePassword('default', WORKSPACE, 'hunter22', undefined, json, { env }),
    );

    expect(sent).toEqual({ password: 'hunter22' });
    expect(url).not.toContain('hunter22');
    expect(printed).toEqual({ id: WORKSPACE, passwordProtected: true, changed: false });
    await done();
  });

  it('changes a password by sending the current one with the new one', async () => {
    const { env, done } = await withProfile();
    let sent: unknown = null;
    server.use(
      http.put(`${API}/api/v1/workspaces/:workspaceId/password`, async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await captureJson((json) =>
      setWorkspacePassword('default', WORKSPACE, 'rotated!', 'hunter22', json, { env }),
    );

    expect(sent).toEqual({ password: 'rotated!', currentPassword: 'hunter22' });
    await done();
  });

  it('removes a password, unlocks, relocks and joins through their own routes', async () => {
    const { env, done } = await withProfile();
    const seen: string[] = [];
    server.use(
      http.post(`${API}/api/v1/workspaces/:workspaceId/password/remove`, async ({ request }) => {
        seen.push(`remove ${JSON.stringify(await request.json())}`);
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${API}/api/v1/workspaces/:workspaceId/unlock`, async ({ request }) => {
        seen.push(`unlock ${JSON.stringify(await request.json())}`);
        return HttpResponse.json({ unlockedUntil: '2026-11-09T12:15:00+00:00' });
      }),
      http.delete(`${API}/api/v1/workspaces/:workspaceId/unlock`, () => {
        seen.push('relock');
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${API}/api/v1/workspaces/:workspaceId/join`, async ({ request }) => {
        seen.push(`join ${JSON.stringify(await request.json())}`);
        return HttpResponse.json({ unlockedUntil: '2026-11-09T12:15:00+00:00' });
      }),
    );

    expect(
      await captureJson((json) =>
        removeWorkspacePassword('default', WORKSPACE, 'pw-one', json, { env }),
      ),
    ).toEqual({ id: WORKSPACE, passwordProtected: false });
    expect(
      await captureJson((json) => unlockWorkspace('default', WORKSPACE, 'pw-two', json, { env })),
    ).toEqual({ id: WORKSPACE, unlockedUntil: '2026-11-09T12:15:00+00:00' });
    expect(
      await captureJson((json) => relockWorkspace('default', WORKSPACE, json, { env })),
    ).toEqual({
      id: WORKSPACE,
      unlockedUntil: null,
    });
    expect(
      await captureJson((json) => joinWorkspace('default', WORKSPACE, 'pw-three', json, { env })),
    ).toEqual({ id: WORKSPACE, joined: true, unlockedUntil: '2026-11-09T12:15:00+00:00' });

    expect(seen).toEqual([
      'remove {"password":"pw-one"}',
      'unlock {"password":"pw-two"}',
      'relock',
      'join {"password":"pw-three"}',
    ]);
    await done();
  });
});
