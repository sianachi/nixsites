import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { clearRecurrence, completeRecurrence, runCalendar, setRecurrence } from './recurrence.ts';
import { captureJson, makeProfile } from './cli.test-helper.ts';

const API = 'http://nix.test';
const ITEM = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';

/** A full RecurrenceRuleResponse. */
function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    freq: 'weekly',
    interval: 1,
    weekdays: ['mo', 'we', 'fr'],
    until: null,
    completedThrough: null,
    completed: [],
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

describe('nixctl recur set', () => {
  it('sends the parsed rule as the PUT body and prints the rule Core returns', async () => {
    const { env, done } = await withProfile();
    let sentBody: unknown;
    server.use(
      http.put(`${API}/api/v1/items/:itemId/recurrence`, async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json({ rule: rule() });
      }),
    );

    const printed = (await captureJson((json) =>
      setRecurrence(
        'default',
        ITEM,
        { freq: 'weekly', interval: '1', weekdays: 'mo,we,fr', until: undefined },
        json,
        { env },
      ),
    )) as { id: string; rule: { freq: string; weekdays: string[] } };

    expect(sentBody).toEqual({
      freq: 'weekly',
      interval: 1,
      weekdays: ['mo', 'we', 'fr'],
      until: null,
    });
    expect(printed.id).toBe(ITEM);
    expect(printed.rule.freq).toBe('weekly');
    expect(printed.rule.weekdays).toEqual(['mo', 'we', 'fr']);
    await done();
  });

  it('defaults --interval to 1 and --until to null when omitted', async () => {
    const { env, done } = await withProfile();
    let sentBody: unknown;
    server.use(
      http.put(`${API}/api/v1/items/:itemId/recurrence`, async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json({ rule: rule({ freq: 'daily', weekdays: [] }) });
      }),
    );

    await captureJson((json) => setRecurrence('default', ITEM, { freq: 'daily' }, json, { env }));

    expect(sentBody).toEqual({ freq: 'daily', interval: 1, weekdays: null, until: null });
    await done();
  });

  it('refuses a frequency outside the closed set before any request', async () => {
    const { env, done } = await withProfile();
    // onUnhandledRequest:'error' fails the test if this reaches the network; it must not.
    await expect(
      captureJson((json) => setRecurrence('default', ITEM, { freq: 'fortnightly' }, json, { env })),
    ).rejects.toThrow(/--freq must be one of/);
    await done();
  });

  it('refuses an interval below 1 before any request', async () => {
    const { env, done } = await withProfile();
    await expect(
      captureJson((json) =>
        setRecurrence('default', ITEM, { freq: 'daily', interval: '0' }, json, { env }),
      ),
    ).rejects.toThrow(/--interval must be a whole number between 1 and 366/);
    await done();
  });

  it('refuses an interval above 366 before any request', async () => {
    const { env, done } = await withProfile();
    await expect(
      captureJson((json) =>
        setRecurrence('default', ITEM, { freq: 'daily', interval: '400' }, json, { env }),
      ),
    ).rejects.toThrow(/--interval must be a whole number between 1 and 366/);
    await done();
  });

  it('refuses a malformed --until date before any request', async () => {
    const { env, done } = await withProfile();
    await expect(
      captureJson((json) =>
        setRecurrence('default', ITEM, { freq: 'daily', until: '2026-02-30' }, json, { env }),
      ),
    ).rejects.toThrow(/--until must be a real calendar day/);
    await done();
  });

  it('refuses --weekdays on a non-weekly rule before any request', async () => {
    const { env, done } = await withProfile();
    await expect(
      captureJson((json) =>
        setRecurrence('default', ITEM, { freq: 'daily', weekdays: 'mo,we' }, json, { env }),
      ),
    ).rejects.toThrow(/--weekdays only applies to --freq weekly/);
    await done();
  });

  it('maps a not-found item to exit 4', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.put(`${API}/api/v1/items/:itemId/recurrence`, () =>
        HttpResponse.json(
          { code: 'items.not_found', detail: 'No item is visible.' },
          { status: 404 },
        ),
      ),
    );
    await expect(
      captureJson((json) => setRecurrence('default', ITEM, { freq: 'daily' }, json, { env })),
    ).rejects.toMatchObject({ status: 404 });
    await done();
  });
});

describe('nixctl recur clear', () => {
  it('sends a null PUT body and prints the cleared rule', async () => {
    const { env, done } = await withProfile();
    let sentBody: unknown;
    let sawBody = false;
    server.use(
      http.put(`${API}/api/v1/items/:itemId/recurrence`, async ({ request }) => {
        sawBody = true;
        sentBody = await request.json();
        return HttpResponse.json({ rule: null });
      }),
    );

    const printed = (await captureJson((json) =>
      clearRecurrence('default', ITEM, json, { env }),
    )) as {
      id: string;
      rule: unknown;
    };

    expect(sawBody).toBe(true);
    expect(sentBody).toBeNull();
    expect(printed.id).toBe(ITEM);
    expect(printed.rule).toBeNull();
    await done();
  });

  it('maps a refused clear to exit 3', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.put(`${API}/api/v1/items/:itemId/recurrence`, () =>
        HttpResponse.json({ code: 'auth.forbidden', detail: 'Not allowed.' }, { status: 403 }),
      ),
    );
    await expect(
      captureJson((json) => clearRecurrence('default', ITEM, json, { env })),
    ).rejects.toMatchObject({
      status: 403,
    });
    await done();
  });
});

describe('nixctl recur complete', () => {
  it('sends the occurred-on day as the POST body and prints the rule and day', async () => {
    const { env, done } = await withProfile();
    let sentBody: unknown;
    server.use(
      http.post(`${API}/api/v1/items/:itemId/recurrence/completions`, async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json({
          rule: rule({ completed: ['2026-08-17'] }),
          occurredOn: '2026-08-17',
        });
      }),
    );

    const printed = (await captureJson((json) =>
      completeRecurrence('default', ITEM, { on: '2026-08-17' }, json, { env }),
    )) as { id: string; occurredOn: string; rule: { completed: string[] } };

    expect(sentBody).toEqual({ occurredOn: '2026-08-17' });
    expect(printed.occurredOn).toBe('2026-08-17');
    expect(printed.rule.completed).toEqual(['2026-08-17']);
    await done();
  });

  it('presents completing an already-completed day as success, not a refusal', async () => {
    const { env, done } = await withProfile();
    // The contract says a repeat completion succeeds with nothing changed - the response is
    // indistinguishable from a fresh completion, and so must this command's outcome be.
    server.use(
      http.post(`${API}/api/v1/items/:itemId/recurrence/completions`, () =>
        HttpResponse.json({ rule: rule({ completed: ['2026-08-17'] }), occurredOn: '2026-08-17' }),
      ),
    );

    const printed = (await captureJson((json) =>
      completeRecurrence('default', ITEM, { on: '2026-08-17' }, json, { env }),
    )) as { occurredOn: string };

    expect(printed.occurredOn).toBe('2026-08-17');
    await done();
  });

  it('refuses a malformed --on date before any request', async () => {
    const { env, done } = await withProfile();
    await expect(
      captureJson((json) =>
        completeRecurrence('default', ITEM, { on: 'not-a-date' }, json, { env }),
      ),
    ).rejects.toThrow(/--on must be a real calendar day/);
    await done();
  });

  it('maps a not-found item to exit 4', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.post(`${API}/api/v1/items/:itemId/recurrence/completions`, () =>
        HttpResponse.json(
          { code: 'items.not_found', detail: 'No item is visible.' },
          { status: 404 },
        ),
      ),
    );
    await expect(
      captureJson((json) =>
        completeRecurrence('default', ITEM, { on: '2026-08-17' }, json, { env }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await done();
  });
});

describe('nixctl calendar', () => {
  it('prints entries with generated/completed, both truncation flags, and unplaceable reasons', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${API}/api/v1/workspaces/:workspaceId/calendar`, () =>
        HttpResponse.json({
          workspaceId: WORKSPACE,
          from: '2026-08-01',
          to: '2026-08-31',
          entries: [
            {
              itemId: ITEM,
              title: 'Stored task',
              containerId: '33333333-3333-4333-8333-333333333333',
              containerTitle: 'Board',
              dateProperty: 'due',
              value: '2026-08-05',
              kind: 'date',
              generated: false,
              completed: null,
            },
            {
              itemId: '44444444-4444-4444-8444-444444444444',
              title: 'Take out bins',
              containerId: '33333333-3333-4333-8333-333333333333',
              containerTitle: 'Board',
              dateProperty: 'due',
              value: '2026-08-12',
              kind: 'date',
              generated: true,
              completed: false,
            },
          ],
          unplaceable: [
            {
              containerId: '55555555-5555-4555-8555-555555555555',
              containerTitle: 'Untitled board',
              reason: 'no_date_property',
              itemId: null,
              itemTitle: null,
            },
            {
              containerId: '33333333-3333-4333-8333-333333333333',
              containerTitle: 'Board',
              reason: 'calendar_not_by_due_date',
              itemId: '66666666-6666-4666-8666-666666666666',
              itemTitle: 'Weekly review',
            },
            {
              containerId: '33333333-3333-4333-8333-333333333333',
              containerTitle: 'Board',
              reason: 'no_due_date',
              itemId: '77777777-7777-4777-8777-777777777777',
              itemTitle: 'Water plants',
            },
            {
              containerId: '33333333-3333-4333-8333-333333333333',
              containerTitle: 'Board',
              reason: 'unreadable_rule',
              itemId: '88888888-8888-4888-8888-888888888888',
              itemTitle: 'Broken series',
            },
          ],
          entryLimit: 2000,
          entriesTruncated: true,
          seriesTruncated: true,
        }),
      ),
    );

    const printed = (await captureJson((json) =>
      runCalendar(
        'default',
        { workspaceId: WORKSPACE, from: '2026-08-01', to: '2026-08-31' },
        json,
        {
          env,
        },
      ),
    )) as {
      entries: { generated: boolean; completed: boolean | null }[];
      entriesTruncated: boolean;
      seriesTruncated: boolean;
      unplaceable: { reason: string; itemId: string | null }[];
      unplaceableCount: number;
    };

    expect(printed.entries).toHaveLength(2);
    expect(printed.entries[0]).toMatchObject({ generated: false, completed: null });
    expect(printed.entries[1]).toMatchObject({ generated: true, completed: false });
    expect(printed.entriesTruncated).toBe(true);
    expect(printed.seriesTruncated).toBe(true);
    expect(printed.unplaceableCount).toBe(4);
    expect(printed.unplaceable.map((row) => row.reason)).toEqual([
      'no_date_property',
      'calendar_not_by_due_date',
      'no_due_date',
      'unreadable_rule',
    ]);
    expect(printed.unplaceable[0]?.itemId).toBeNull();
    expect(printed.unplaceable[1]?.itemId).toBe('66666666-6666-4666-8666-666666666666');
    await done();
  });

  it('refuses a malformed --from date before any request', async () => {
    const { env, done } = await withProfile();
    await expect(
      captureJson((json) =>
        runCalendar(
          'default',
          { workspaceId: WORKSPACE, from: '2026-13-01', to: '2026-08-31' },
          json,
          {
            env,
          },
        ),
      ),
    ).rejects.toThrow(/--from must be a real calendar day/);
    await done();
  });

  it('refuses a malformed --to date before any request', async () => {
    const { env, done } = await withProfile();
    await expect(
      captureJson((json) =>
        runCalendar('default', { workspaceId: WORKSPACE, from: '2026-08-01', to: 'nope' }, json, {
          env,
        }),
      ),
    ).rejects.toThrow(/--to must be a real calendar day/);
    await done();
  });

  it('maps a not-found workspace to exit 4', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${API}/api/v1/workspaces/:workspaceId/calendar`, () =>
        HttpResponse.json(
          { code: 'workspaces.not_found', detail: 'No workspace is visible.' },
          { status: 404 },
        ),
      ),
    );
    await expect(
      captureJson((json) =>
        runCalendar(
          'default',
          { workspaceId: WORKSPACE, from: '2026-08-01', to: '2026-08-31' },
          json,
          {
            env,
          },
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await done();
  });
});
