import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getViews, inspectViews, setViews } from './views.ts';
import { captureJson, makeProfile } from './cli.test-helper.ts';

const API = 'http://nix.test';
const ITEM = '11111111-1111-4111-8111-111111111111';

/** A full ViewResponse, so the client's summary schema parses it and drops the rest. */
function view(id: string, name: string, kind: string): Record<string, unknown> {
  return {
    id,
    name,
    kind,
    columns: [],
    groupBy: null,
    groupOrder: [],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    endDateProperty: null,
    cardSize: null,
    filters: [],
    companionViewId: null,
    companionPlacement: null,
    interactiveForm: null,
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

describe('nixctl views get', () => {
  it('lists the views with their renderable flag and the default', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${API}/api/v1/items/:itemId/views`, () =>
        HttpResponse.json({
          views: [view('board', 'Board', 'board'), view('cal', 'Calendar', 'calendar')],
          unrenderable: ['cal'],
          default: 'board',
        }),
      ),
    );

    const printed = (await captureJson((json) => getViews('default', ITEM, json, { env }))) as {
      count: number;
      default: string;
      views: { id: string; kind: string; renderable: boolean }[];
    };

    expect(printed.count).toBe(2);
    expect(printed.default).toBe('board');
    // The unrenderable one is named as such rather than looking like an empty view.
    expect(printed.views.find((v) => v.id === 'board')?.renderable).toBe(true);
    expect(printed.views.find((v) => v.id === 'cal')?.renderable).toBe(false);
    await done();
  });

  it('maps a not-found container to exit 4', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${API}/api/v1/items/:itemId/views`, () =>
        HttpResponse.json(
          { code: 'items.not_found', detail: 'No item is visible.' },
          { status: 404 },
        ),
      ),
    );

    await expect(
      captureJson((json) => getViews('default', ITEM, json, { env })),
    ).rejects.toMatchObject({ status: 404 });
    await done();
  });
});

describe('nixctl views set', () => {
  it('sends the file body to PUT and prints the resulting view set', async () => {
    const { env, dir, done } = await withProfile();
    const file = join(dir, 'views.json');
    // A minimal smart-list authoring file; the per-view shape is the server's to validate.
    const smartList = { ...view('due-soon', 'Due soon', 'query'), filters: [] };
    await writeFile(file, JSON.stringify({ views: [smartList], default: 'due-soon' }), 'utf8');

    let sentBody: unknown;
    server.use(
      http.put(`${API}/api/v1/items/:itemId/views`, async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json({
          views: [view('due-soon', 'Due soon', 'query')],
          unrenderable: [],
          default: 'due-soon',
        });
      }),
    );

    const printed = (await captureJson((json) =>
      setViews('default', ITEM, file, json, { env }),
    )) as {
      count: number;
      default: string;
      views: { id: string; kind: string }[];
    };

    expect((sentBody as { default: string }).default).toBe('due-soon');
    expect((sentBody as { views: unknown[] }).views).toHaveLength(1);
    expect(printed.count).toBe(1);
    expect(printed.default).toBe('due-soon');
    expect(printed.views[0]).toMatchObject({ id: 'due-soon', kind: 'query' });
    await done();
  });

  it('rejects a file with no views array before any request', async () => {
    const { env, dir, done } = await withProfile();
    const file = join(dir, 'bad.json');
    await writeFile(file, JSON.stringify({ default: null }), 'utf8');
    // onUnhandledRequest:'error' would fail if it reached the network; it must not.
    await expect(
      captureJson((json) => setViews('default', ITEM, file, json, { env })),
    ).rejects.toThrow(/views/);
    await done();
  });

  it('maps a rejected view set (422) to exit 1 with the server detail', async () => {
    const { env, dir, done } = await withProfile();
    const file = join(dir, 'views.json');
    await writeFile(
      file,
      JSON.stringify({ views: [view('x', 'X', 'query')], default: 'x' }),
      'utf8',
    );
    server.use(
      http.put(`${API}/api/v1/items/:itemId/views`, () =>
        HttpResponse.json(
          { code: 'views.invalid', detail: 'That view is not valid.' },
          { status: 422 },
        ),
      ),
    );
    await expect(
      captureJson((json) => setViews('default', ITEM, file, json, { env })),
    ).rejects.toMatchObject({
      status: 422,
    });
    await done();
  });
});

describe('nixctl views inspect', () => {
  it('retains persisted widget configuration in its output', async () => {
    const { env, done } = await withProfile();
    const habitWidgets = [
      { id: 'progress', kind: 'completion', habitId: ITEM, from: '2026-09-01', to: '2026-09-14' },
    ];
    server.use(
      http.get(`${API}/api/v1/items/:itemId/views`, () =>
        HttpResponse.json({
          views: [{ ...view('habits', 'Habits', 'habit_tracker'), habitWidgets }],
          unrenderable: [],
          default: 'habits',
        }),
      ),
    );
    try {
      const printed = await captureJson((json) => inspectViews('default', ITEM, json, { env }));
      expect(printed).toMatchObject({ views: [{ habitWidgets }] });
    } finally {
      await done();
    }
  });
});
