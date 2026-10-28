import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { runQuery } from './query.ts';
import { captureJson, makeProfile } from './cli.test-helper.ts';

const API = 'http://nix.test';
const ITEM = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    workspaceId: WORKSPACE,
    containerId: ITEM,
    containerTitle: 'Recipes',
    title: 'Pancakes',
    type: 'note',
    properties: { ingredient: 'flour' },
    ...overrides,
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

describe('nixctl query', () => {
  it("runs a view's saved query and prints the rows with the truncation flag", async () => {
    const { env, done } = await withProfile();
    let seenUrl = '';
    server.use(
      http.get(`${API}/api/v1/items/:itemId/query`, ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          itemId: ITEM,
          viewId: 'board',
          today: '2026-08-19',
          results: [row(), row({ id: '44444444-4444-4444-8444-444444444444', title: 'Waffles' })],
          limit: 200,
          truncated: true,
        });
      }),
    );

    const printed = (await captureJson((json) =>
      runQuery('default', ITEM, { view: 'board', today: '2026-08-19' }, json, { env }),
    )) as { count: number; truncated: boolean; results: { title: string }[] };

    expect(printed.count).toBe(2);
    expect(printed.truncated).toBe(true);
    expect(printed.results.map((r) => r.title)).toEqual(['Pancakes', 'Waffles']);
    // The view id and the caller's day both reach the server, as the query contract requires.
    expect(seenUrl).toContain('view=board');
    expect(seenUrl).toContain('today=2026-08-19');
    await done();
  });

  it('surfaces a not-found container as the API error the entry point maps to exit 4', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${API}/api/v1/items/:itemId/query`, () =>
        HttpResponse.json(
          { code: 'items.not_found', detail: 'No item is visible.' },
          { status: 404 },
        ),
      ),
    );

    await expect(
      captureJson((json) =>
        runQuery('default', ITEM, { view: 'board', today: '2026-08-19' }, json, { env }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await done();
  });
});
