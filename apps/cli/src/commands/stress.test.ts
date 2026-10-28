import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { percentile, seed, seededProperties, stressRun } from './stress.ts';
import { captureJson, makeProfile } from './cli.test-helper.ts';

const API = 'http://nix.test';
const WS = '22222222-2222-4222-8222-222222222222';

let nextId = 0;

/** A full ItemResponse, so the client's item schema parses each create. */
function itemFrom(body: {
  type?: string;
  title?: string;
  parentId?: string | null;
}): Record<string, unknown> {
  nextId += 1;
  const id = `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`;
  return {
    id,
    workspaceId: WS,
    parentId: body.parentId ?? null,
    type: body.type ?? 'note',
    title: body.title ?? 'x',
    hasChildren: false,
    seq: '1',
    lifecycleState: 'active',
    properties: {},
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
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
  nextId = 0;
});
afterAll(() => {
  server.close();
});

const withProfile = () => makeProfile({ apiUrl: API, token: 'nixpat_abc' });

describe('nixctl stress seed', () => {
  it('creates a parent, then the requested children under it', async () => {
    const { env, done } = await withProfile();
    const parentIds: (string | null)[] = [];
    server.use(
      http.post(`${API}/api/v1/workspaces/:workspaceId/items`, async ({ request }) => {
        const body = (await request.json()) as {
          type?: string;
          title?: string;
          parentId?: string | null;
        };
        parentIds.push(body.parentId ?? null);
        return HttpResponse.json(itemFrom(body));
      }),
    );

    const printed = (await captureJson((json) =>
      seed('default', { workspaceId: WS, count: 3 }, json, { env }),
    )) as { requested: number; created: number; stoppedEarly: boolean; parentId: string };

    expect(printed.requested).toBe(3);
    expect(printed.created).toBe(3);
    expect(printed.stoppedEarly).toBe(false);
    // Four creates in all: one parent (at the root, parentId null) then three children under it.
    expect(parentIds).toHaveLength(4);
    expect(parentIds[0]).toBeNull();
    expect(parentIds.slice(1)).toEqual([printed.parentId, printed.parentId, printed.parentId]);
    await done();
  });

  it('seeds under an existing parent without creating one', async () => {
    const { env, done } = await withProfile();
    const parent = '11111111-1111-4111-8111-111111111111';
    let creates = 0;
    server.use(
      http.post(`${API}/api/v1/workspaces/:workspaceId/items`, async ({ request }) => {
        creates += 1;
        const body = (await request.json()) as {
          type?: string;
          title?: string;
          parentId?: string | null;
        };
        return HttpResponse.json(itemFrom(body));
      }),
    );

    const printed = (await captureJson((json) =>
      seed('default', { workspaceId: WS, count: 2, parentId: parent }, json, { env }),
    )) as { created: number; parentId: string };

    expect(printed.parentId).toBe(parent);
    expect(printed.created).toBe(2);
    // Only the two children, no parent create.
    expect(creates).toBe(2);
    await done();
  });

  it('stops on the write rate limit, keeping what it made and naming the override', async () => {
    const { env, done } = await withProfile();
    const parent = '11111111-1111-4111-8111-111111111111';
    let creates = 0;
    server.use(
      http.post(`${API}/api/v1/workspaces/:workspaceId/items`, async ({ request }) => {
        creates += 1;
        // The third child create meets the limit.
        if (creates === 3) {
          return HttpResponse.json(
            { code: 'rate.limited', detail: 'Too many writes.' },
            { status: 429 },
          );
        }
        const body = (await request.json()) as {
          type?: string;
          title?: string;
          parentId?: string | null;
        };
        return HttpResponse.json(itemFrom(body));
      }),
    );

    const printed = (await captureJson((json) =>
      seed('default', { workspaceId: WS, count: 10, parentId: parent }, json, { env }),
    )) as { created: number; stoppedEarly: boolean; reason: string };

    expect(printed.stoppedEarly).toBe(true);
    expect(printed.created).toBe(2);
    expect(printed.reason).toContain('Nix__RateLimits__WritesPerMinute');
    await done();
  });

  it('rejects a non-positive count before opening a session', async () => {
    const { env, done } = await withProfile();
    await expect(
      captureJson((json) => seed('default', { workspaceId: WS, count: 0 }, json, { env })),
    ).rejects.toThrow(/positive integer/);
    await done();
  });
});

describe('percentile', () => {
  it('is the nearest-rank value, and 0 for an empty sample', () => {
    const sorted = [1, 5, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 100)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('nixctl stress run read-storm', () => {
  const ITEM = '11111111-1111-4111-8111-111111111111';

  it('reads the item each iteration and reports the latency spread from an injected clock', async () => {
    const { env, done } = await withProfile();
    let reads = 0;
    server.use(
      http.get(`${API}/api/v1/items/:itemId`, () => {
        reads += 1;
        return HttpResponse.json(itemFrom({ title: 'target' }));
      }),
    );

    // A deterministic clock: start,end per iteration → durations 5, 10, 1 → sorted [1,5,10].
    const ticks = [0, 5, 100, 110, 200, 201];
    let tick = 0;
    const now = (): number => ticks[tick++] ?? 0;

    const printed = (await captureJson((json) =>
      stressRun('default', { scenario: 'read-storm', itemId: ITEM, iterations: 3 }, json, {
        env,
        now,
      }),
    )) as {
      ok: number;
      errors: number;
      latencyMs: { p50: number; p95: number; p99: number; max: number };
    };

    expect(reads).toBe(3);
    expect(printed.ok).toBe(3);
    expect(printed.errors).toBe(0);
    expect(printed.latencyMs).toEqual({ p50: 5, p95: 10, p99: 10, max: 10 });
    await done();
  });

  it('tallies failures by problem code and keeps going', async () => {
    const { env, done } = await withProfile();
    let reads = 0;
    server.use(
      http.get(`${API}/api/v1/items/:itemId`, () => {
        reads += 1;
        // Every other read is refused; the storm counts it and continues.
        if (reads % 2 === 0) {
          return HttpResponse.json({ code: 'server.busy', detail: 'Busy.' }, { status: 503 });
        }
        return HttpResponse.json(itemFrom({ title: 'target' }));
      }),
    );

    const printed = (await captureJson((json) =>
      stressRun('default', { scenario: 'read-storm', itemId: ITEM, iterations: 4 }, json, { env }),
    )) as { ok: number; errors: number; errorsByCode: Record<string, number> };

    expect(printed.ok).toBe(2);
    expect(printed.errors).toBe(2);
    // Both failures are tallied under one code (the exact string is the client's to assign); the
    // point is the storm counted them rather than aborting on the first.
    const tallied = Object.values(printed.errorsByCode).reduce((sum, n) => sum + n, 0);
    expect(tallied).toBe(2);
    expect(Object.keys(printed.errorsByCode)).toHaveLength(1);
    await done();
  });

  it('rejects an unknown scenario before opening a session', async () => {
    const { env, done } = await withProfile();
    await expect(
      captureJson((json) =>
        stressRun('default', { scenario: 'chaos', itemId: ITEM, iterations: 1 }, json, { env }),
      ),
    ).rejects.toThrow(/Unknown scenario/);
    await done();
  });

  it('rejects read-storm with no --item', async () => {
    const { env, done } = await withProfile();
    await expect(
      captureJson((json) =>
        stressRun('default', { scenario: 'read-storm', iterations: 1 }, json, { env }),
      ),
    ).rejects.toThrow(/needs --item/);
    await done();
  });
});

describe('nixctl stress run search-storm', () => {
  it('runs the query each iteration and reports the latency spread', async () => {
    const { env, done } = await withProfile();
    let searches = 0;
    let lastQ: string | null = null;
    server.use(
      http.get(`${API}/api/v1/search`, ({ request }) => {
        searches += 1;
        lastQ = new URL(request.url).searchParams.get('q');
        return HttpResponse.json({ query: lastQ ?? '', results: [], limit: 50, truncated: false });
      }),
    );

    const ticks = [0, 5, 100, 110, 200, 201];
    let tick = 0;
    const now = (): number => ticks[tick++] ?? 0;

    const printed = (await captureJson((json) =>
      stressRun('default', { scenario: 'search-storm', query: 'soup', iterations: 3 }, json, {
        env,
        now,
      }),
    )) as { scenario: string; target: string; ok: number; latencyMs: { p50: number; max: number } };

    expect(searches).toBe(3);
    expect(lastQ).toBe('soup');
    expect(printed.scenario).toBe('search-storm');
    expect(printed.target).toBe('soup');
    expect(printed.ok).toBe(3);
    expect(printed.latencyMs).toMatchObject({ p50: 5, max: 10 });
    await done();
  });

  it('rejects search-storm with no --query', async () => {
    const { env, done } = await withProfile();
    await expect(
      captureJson((json) =>
        stressRun('default', { scenario: 'search-storm', iterations: 1 }, json, { env }),
      ),
    ).rejects.toThrow(/needs --query/);
    await done();
  });
});

describe('nixctl stress run query-storm', () => {
  const ITEM = '11111111-1111-4111-8111-111111111111';

  it('runs the container view each iteration and reports the latency spread', async () => {
    const { env, done } = await withProfile();
    let queries = 0;
    server.use(
      http.get(`${API}/api/v1/items/:itemId/query`, () => {
        queries += 1;
        return HttpResponse.json({
          itemId: ITEM,
          viewId: 'board',
          today: '2026-01-01',
          results: [],
          limit: 100,
          truncated: false,
        });
      }),
    );

    const ticks = [0, 5, 100, 110, 200, 201];
    let tick = 0;
    const now = (): number => ticks[tick++] ?? 0;

    const printed = (await captureJson((json) =>
      stressRun(
        'default',
        {
          scenario: 'query-storm',
          itemId: ITEM,
          viewId: 'board',
          today: '2026-01-01',
          iterations: 3,
        },
        json,
        { env, now },
      ),
    )) as { scenario: string; target: string; ok: number; latencyMs: { p50: number; max: number } };

    expect(queries).toBe(3);
    expect(printed.scenario).toBe('query-storm');
    expect(printed.target).toBe(`${ITEM}#board`);
    expect(printed.ok).toBe(3);
    expect(printed.latencyMs).toMatchObject({ p50: 5, max: 10 });
    await done();
  });

  it('rejects query-storm missing --view or --today', async () => {
    const { env, done } = await withProfile();
    await expect(
      captureJson((json) =>
        stressRun('default', { scenario: 'query-storm', itemId: ITEM, iterations: 1 }, json, {
          env,
        }),
      ),
    ).rejects.toThrow(/needs --item .*--view .*--today/);
    await done();
  });
});

describe('seeded properties', () => {
  it('gives every child the same value when the value is a literal', () => {
    expect(seededProperties(['status=Todo'], 7)).toEqual({ status: 'Todo' });
  });

  it('gives each child its own index, so a seed is a spread rather than one repeated number', () => {
    // An average over three thousand copies of one value measures nothing, and a chart grouped by
    // a constant has one bar.
    expect(seededProperties(['n=#n'], 41)).toEqual({ n: 41 });
  });

  it('wraps the index at a bound, for a spread across a set of known size', () => {
    expect(seededProperties(['estimate=#n%13'], 41)).toEqual({ estimate: 2 });
  });

  it('parses a literal the way props set does, so a seeded value is a stored one', () => {
    expect(seededProperties(['done=true', 'hours=3.5'], 0)).toEqual({ done: true, hours: 3.5 });
  });

  it('refuses a pair with no key rather than storing one called nothing', () => {
    expect(() => seededProperties(['=Todo'], 0)).toThrow(/key is required/i);
  });

  it('costs nothing when no properties were asked for', () => {
    expect(seededProperties(undefined, 3)).toBeUndefined();
    expect(seededProperties([], 3)).toBeUndefined();
  });
});
