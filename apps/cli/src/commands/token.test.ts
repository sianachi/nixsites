import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { openSession } from '../session.ts';
import { loadConfig, saveProfile } from '../config.ts';
import { executeRotateToken, rotateToken } from './token.ts';
import { makeProfile } from './cli.test-helper.ts';
import { outputOptions } from '../output.ts';

const API = 'http://nix.test';
const TOKEN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

const jwtFor = (patId: string) =>
  `h.${Buffer.from(JSON.stringify({ nix_pat_id: patId })).toString('base64url')}.s`;

const server = setupServer(
  // The exchange hands back a session whose token id depends on the secret presented.
  http.post(`${API}/public/v1/auth/token`, async ({ request }) => {
    const { token } = (await request.json()) as { token: string };
    return HttpResponse.json({
      accessToken: jwtFor(token === 'nixpat_other' ? OTHER_ID : TOKEN_ID),
      tokenType: 'Bearer',
      expiresInSeconds: 600,
    });
  }),
  http.post(`${API}/api/v1/me/tokens/${TOKEN_ID}/rotate`, () =>
    HttpResponse.json({
      token: 'nixpat_new',
      details: {
        id: TOKEN_ID,
        name: 'ci',
        scopes: ['read'],
        createdAt: '2026-11-01T00:00:00+00:00',
        expiresAt: '2026-12-31T00:00:00+00:00',
        revokedAt: null,
        lastUsedAt: null,
      },
    }),
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

describe('nixctl token rotate', () => {
  it('writes the new secret into the profiles that used the old one, and only those', async () => {
    const { env, done } = await makeProfile({ apiUrl: API, token: 'nixpat_old' });
    await saveProfile('other', { apiUrl: API, token: 'nixpat_other' }, { env });
    await saveProfile('elsewhere', { apiUrl: 'http://else.test', token: 'nixpat_old' }, { env });

    const session = openSession({ profile: { apiUrl: API, token: 'nixpat_old' } });
    const printed = await executeRotateToken(session, TOKEN_ID, { env });

    expect(printed.token).toBe('nixpat_new');
    expect(printed.updatedProfiles).toEqual(['default']);
    const config = await loadConfig(env);
    expect(config.profiles.default?.token).toBe('nixpat_new');
    expect(config.profiles.other?.token).toBe('nixpat_other');
    expect(config.profiles.elsewhere?.token).toBe('nixpat_old');
    await done();
  });

  it('refuses a token-authenticated profile before calling Core', async () => {
    const { env, done } = await makeProfile({ apiUrl: API, token: 'nixpat_old' });

    await expect(
      rotateToken(undefined, TOKEN_ID, outputOptions(true, { isTTY: false }), { env }),
    ).rejects.toThrow(/browser sign-in/);
    await done();
  });
});
