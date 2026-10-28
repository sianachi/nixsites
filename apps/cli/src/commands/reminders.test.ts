import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { clearReminder, resolveReminderWhen, setReminder } from './reminders.ts';
import { captureJson, makeProfile } from './cli.test-helper.ts';

const API = 'http://nix.test';
const ITEM = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-09-30T12:00:00Z');

describe('resolveReminderWhen', () => {
  it('passes a full RFC 9557 time through, normalised to seconds', () => {
    expect(resolveReminderWhen('2026-10-01T09:00+01:00[Europe/London]', 'UTC', NOW)).toBe(
      '2026-10-01T09:00:00+01:00[Europe/London]',
    );
  });

  it('refuses an offset its bracketed zone was not using at that moment', () => {
    expect(() =>
      resolveReminderWhen('2026-12-01T09:00:00+01:00[Europe/London]', 'UTC', NOW),
    ).toThrow("'Europe/London' was not using");
  });

  it('reads a local wall time in the given zone, summer and winter', () => {
    expect(resolveReminderWhen('2026-10-01T09:00', 'Europe/London', NOW)).toBe(
      '2026-10-01T09:00:00+01:00[Europe/London]',
    );
    expect(resolveReminderWhen('2026-12-01 09:00', 'Europe/London', NOW)).toBe(
      '2026-12-01T09:00:00+00:00[Europe/London]',
    );
    expect(resolveReminderWhen('2026-10-01T09:00', 'America/New_York', NOW)).toBe(
      '2026-10-01T09:00:00-04:00[America/New_York]',
    );
  });

  it('moves a wall time inside a spring-forward gap to the first real moment after it', () => {
    // 2027-03-28 01:30 does not exist in London; clocks jump from 01:00 to 02:00.
    expect(resolveReminderWhen('2027-03-28T01:30', 'Europe/London', NOW)).toBe(
      '2027-03-28T02:30:00+01:00[Europe/London]',
    );
    // West of UTC too: 2026-03-08 02:30 does not exist in New York; clocks jump to 03:00.
    expect(resolveReminderWhen('2026-03-08T02:30', 'America/New_York', NOW)).toBe(
      '2026-03-08T03:30:00-04:00[America/New_York]',
    );
  });

  it('takes the earlier instant of a fall-back overlap on either side of UTC', () => {
    expect(resolveReminderWhen('2026-10-25T01:30', 'Europe/London', NOW)).toBe(
      '2026-10-25T01:30:00+01:00[Europe/London]',
    );
    expect(resolveReminderWhen('2026-11-01T01:30', 'America/New_York', NOW)).toBe(
      '2026-11-01T01:30:00-04:00[America/New_York]',
    );
  });

  it('re-expresses a bare RFC 3339 instant in the given zone', () => {
    expect(resolveReminderWhen('2026-10-01T08:00:00Z', 'Europe/London', NOW)).toBe(
      '2026-10-01T09:00:00+01:00[Europe/London]',
    );
  });

  it('adds a relative offset to now', () => {
    expect(resolveReminderWhen('+90m', 'Europe/London', NOW)).toBe(
      '2026-09-30T14:30:00+01:00[Europe/London]',
    );
    expect(resolveReminderWhen('+2h', 'UTC', NOW)).toBe('2026-09-30T14:00:00+00:00[UTC]');
    expect(resolveReminderWhen('+1d', 'UTC', NOW)).toBe('2026-10-01T12:00:00+00:00[UTC]');
  });

  it.each([
    'tomorrow',
    '2026-13-01T09:00',
    '2026-10-01',
    '+0m',
    '+5y',
    '2026-10-01T09:00[Nowhere/Land]',
  ])('refuses %s', (when) => {
    expect(() => resolveReminderWhen(when, 'UTC', NOW)).toThrow();
  });
});

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

function item(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    id: ITEM,
    workspaceId: WORKSPACE,
    parentId: null,
    type: 'note',
    title: 'Pay rent',
    hasChildren: false,
    properties,
    seq: 1,
    lifecycleState: 'active',
    createdAt: '2026-09-30T08:00:00Z',
    updatedAt: '2026-09-30T08:00:00Z',
  };
}

describe('nixctl remind set and clear', () => {
  it("writes the reminder property in the caller's preferred zone when none is given", async () => {
    const { env, done } = await withProfile();
    let sent: unknown;
    server.use(
      http.get(`${API}/api/v1/me/preferences`, () =>
        HttpResponse.json({
          revision: 1,
          timeZone: 'Europe/London',
          quietStart: null,
          quietEnd: null,
          dueReminderTime: '09:00',
          dueReminders: true,
          habitReminders: true,
          mutedContainerIds: [],
        }),
      ),
      http.patch(`${API}/api/v1/items/:itemId/properties`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(item({ reminder: '2026-10-01T09:00:00+01:00[Europe/London]' }));
      }),
    );

    const printed = await captureJson((out) =>
      setReminder('default', ITEM, '2026-10-01T09:00', {}, out, { env }),
    );

    expect(sent).toEqual({ properties: { reminder: '2026-10-01T09:00:00+01:00[Europe/London]' } });
    expect(printed).toEqual({
      id: ITEM,
      title: 'Pay rent',
      reminder: '2026-10-01T09:00:00+01:00[Europe/London]',
    });
    await done();
  });

  it('uses --zone without reading preferences', async () => {
    const { env, done } = await withProfile();
    let sent: unknown;
    server.use(
      http.patch(`${API}/api/v1/items/:itemId/properties`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(item({}));
      }),
    );

    await captureJson((out) =>
      setReminder('default', ITEM, '2026-10-01T09:00', { zone: 'UTC' }, out, { env }),
    );

    expect(sent).toEqual({ properties: { reminder: '2026-10-01T09:00:00+00:00[UTC]' } });
    await done();
  });

  it('clears the reminder by writing null', async () => {
    const { env, done } = await withProfile();
    let sent: unknown;
    server.use(
      http.patch(`${API}/api/v1/items/:itemId/properties`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(item({}));
      }),
    );

    const printed = await captureJson((out) => clearReminder('default', ITEM, out, { env }));

    expect(sent).toEqual({ properties: { reminder: null } });
    expect(printed).toEqual({ id: ITEM, title: 'Pay rent', reminder: null });
    await done();
  });
});
