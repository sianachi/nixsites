import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { runSearch } from './search.ts';
import { captureJson, makeProfile } from './cli.test-helper.ts';

const API = 'http://nix.test';

function hit(id: string, title: string): Record<string, unknown> {
  return {
    id,
    workspaceId: '22222222-2222-4222-8222-222222222222',
    type: 'note',
    title,
    parentId: null,
    updatedAt: '2026-09-01T12:00:00Z',
  };
}

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

describe('nixctl search', () => {
  it('passes the query and limit and prints the hits with the truncated flag', async () => {
    const { env, done } = await withProfile();
    let seenUrl: URL | undefined;
    server.use(
      http.get(`${API}/api/v1/search`, ({ request }) => {
        seenUrl = new URL(request.url);
        return HttpResponse.json({
          query: 'soup',
          results: [hit('a', 'Soup'), hit('b', 'Soup stock')],
          limit: 2,
          truncated: true,
        });
      }),
    );

    const printed = (await captureJson((json) =>
      runSearch('default', 'soup', { limit: 2 }, json, { env }),
    )) as {
      count: number;
      truncated: boolean;
      results: unknown[];
    };

    expect(seenUrl?.searchParams.get('q')).toBe('soup');
    expect(seenUrl?.searchParams.get('limit')).toBe('2');
    expect(printed.count).toBe(2);
    // A capped result set says so rather than looking complete.
    expect(printed.truncated).toBe(true);
    await done();
  });

  it('omits the limit parameter when none is given', async () => {
    const { env, done } = await withProfile();
    let seenUrl: URL | undefined;
    server.use(
      http.get(`${API}/api/v1/search`, ({ request }) => {
        seenUrl = new URL(request.url);
        return HttpResponse.json({ query: 'x', results: [], limit: 50, truncated: false });
      }),
    );

    await captureJson((json) => runSearch('default', 'x', {}, json, { env }));

    expect(seenUrl?.searchParams.has('limit')).toBe(false);
    await done();
  });
});
