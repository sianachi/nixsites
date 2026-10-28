import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { closeLock, lockStatus, openLock, readPasswords, setLock } from './locks.ts';
import { captureJson, makeProfile } from './cli.test-helper.ts';

const API = 'http://nix.test';
const ITEM = '11111111-1111-4111-8111-111111111111';

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

/** Runs a command with stdout captured, returns the single JSON value it printed. */

/** A temp config with one signed-in profile; the caller cleans up. */
const withProfile = () => makeProfile({ apiUrl: API, token: 'nixpat_abc' });

describe('the lock commands over a stubbed Core', () => {
  it('reports the lock as this profile sees it', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${API}/api/v1/items/:itemId/lock`, () =>
        HttpResponse.json({
          locked: true,
          unlockedUntil: null,
          lockItemId: ITEM,
          selfLocked: true,
        }),
      ),
    );

    const printed = await captureJson((json) => lockStatus('default', ITEM, json, { env }));

    expect(printed).toEqual({
      id: ITEM,
      locked: true,
      unlockedUntil: null,
      lockItemId: ITEM,
      selfLocked: true,
    });
    await done();
  });

  it('sends the password in the body, never the URL, and prints when the unlock ends', async () => {
    const { env, done } = await withProfile();
    let sent: unknown = null;
    let url = '';
    server.use(
      http.post(`${API}/api/v1/items/:itemId/unlock`, async ({ request }) => {
        url = request.url;
        sent = await request.json();
        return HttpResponse.json({ unlockedUntil: '2026-09-22T12:15:00+00:00' });
      }),
    );

    const printed = await captureJson((json) =>
      openLock('default', ITEM, 'hunter22', json, { env }),
    );

    expect(sent).toEqual({ password: 'hunter22' });
    expect(url).not.toContain('hunter22');
    expect(printed).toEqual({ id: ITEM, unlockedUntil: '2026-09-22T12:15:00+00:00' });
    await done();
  });

  it('changes a password by sending the current one alongside the new one', async () => {
    const { env, done } = await withProfile();
    let sent: unknown = null;
    server.use(
      http.put(`${API}/api/v1/items/:itemId/lock`, async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await captureJson((json) => setLock('default', ITEM, 'rotated!', 'hunter22', json, { env }));

    expect(sent).toEqual({ password: 'rotated!', currentPassword: 'hunter22' });
    await done();
  });

  it('closes the body again', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.delete(
        `${API}/api/v1/items/:itemId/unlock`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const printed = await captureJson((json) => closeLock('default', ITEM, json, { env }));

    expect(printed).toEqual({ id: ITEM, unlockedUntil: null });
    await done();
  });
});

describe('reading passwords from stdin', () => {
  it('drops only the final line break', () => {
    expect(readPasswords(' spaced pass \n', 1)).toEqual([' spaced pass ']);
  });

  it('reads the current password and then the new one for a change', () => {
    expect(readPasswords('old-pass\nnew-pass\n', 2)).toEqual(['old-pass', 'new-pass']);
  });

  it('refuses the wrong number of lines, or an empty one', () => {
    expect(() => readPasswords('', 1)).toThrow(/one line/);
    expect(() => readPasswords('a\nb\n', 1)).toThrow(/one line/);
    expect(() => readPasswords('only-one\n', 2)).toThrow(/one per line/);
  });
});
