import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { captureText, makeProfile } from './cli.test-helper.ts';
import {
  applyPreferenceChanges,
  listNotifications,
  parsePreferenceFlags,
  readAllNotifications,
  readNotification,
  setPreferences,
} from './notifications.ts';

const API = 'http://nix.test';
const NOTE = '44444444-4444-4444-8444-444444444444';
const MUTED_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MUTED_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function preferences(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revision: 3,
    timeZone: 'Europe/London',
    quietStart: '22:00',
    quietEnd: '07:00',
    dueReminderTime: '09:00',
    dueReminders: true,
    habitReminders: true,
    mutedContainerIds: [MUTED_A],
    ...overrides,
  };
}

function page(): Record<string, unknown> {
  return {
    items: [
      {
        id: NOTE,
        kind: 'reminder',
        title: 'Pay rent',
        body: '',
        itemId: null,
        workspaceId: null,
        createdAt: '2026-09-30T08:00:00Z',
        readAt: null,
      },
    ],
    nextCursor: 'next-1',
    unread: 1,
    revision: 7,
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

describe('nixctl notifications list', () => {
  it('asks for unread only and the given cursor, and prints the page as Core returned it', async () => {
    const { env, done } = await withProfile();
    let query: URLSearchParams | undefined;
    server.use(
      http.get(`${API}/api/v1/me/notifications`, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json(page());
      }),
    );

    const printed = JSON.parse(
      await captureText((out) =>
        listNotifications('default', { unread: true, cursor: 'c-0' }, out, { env }),
      ),
    ) as { unread: number; nextCursor: string };

    expect(query?.get('unreadOnly')).toBe('true');
    expect(query?.get('cursor')).toBe('c-0');
    expect(printed.unread).toBe(1);
    expect(printed.nextCursor).toBe('next-1');
    await done();
  });

  it('prints a table and the next-page hint for a person at a terminal', async () => {
    const { env, done } = await withProfile();
    server.use(http.get(`${API}/api/v1/me/notifications`, () => HttpResponse.json(page())));

    const printed = await captureText(
      (out) => listNotifications('default', {}, out, { env }),
      true,
    );

    expect(printed).toContain('Pay rent');
    expect(printed).toContain('unread 1; next page --cursor next-1');
    await done();
  });
});

describe('nixctl notifications read and read-all', () => {
  it('marks one read and reports what is still unread', async () => {
    const { env, done } = await withProfile();
    let path = '';
    server.use(
      http.post(`${API}/api/v1/me/notifications/:id/read`, ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ unread: 0 });
      }),
    );

    const printed = JSON.parse(
      await captureText((out) => readNotification('default', NOTE, out, { env })),
    ) as unknown;

    expect(path).toBe(`/api/v1/me/notifications/${NOTE}/read`);
    expect(printed).toEqual({ id: NOTE, read: true, unread: 0 });
    await done();
  });

  it('refuses an id that is not a UUID before any request', async () => {
    const { env, done } = await withProfile();
    await expect(
      captureText((out) => readNotification('default', 'nope', out, { env })),
    ).rejects.toThrow('UUID');
    await done();
  });

  it('marks everything read', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.post(`${API}/api/v1/me/notifications/read-all`, () => HttpResponse.json({ unread: 0 })),
    );

    const printed = JSON.parse(
      await captureText((out) => readAllNotifications('default', out, { env })),
    ) as unknown;

    expect(printed).toEqual({ unread: 0 });
    await done();
  });
});

describe('nixctl notifications prefs set', () => {
  it('saves the changed document behind the revision it read', async () => {
    const { env, done } = await withProfile();
    let sent: unknown;
    server.use(
      http.get(`${API}/api/v1/me/preferences`, () => HttpResponse.json(preferences())),
      http.put(`${API}/api/v1/me/preferences`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(preferences({ revision: 4, quietStart: null, quietEnd: null }));
      }),
    );

    await captureText((out) =>
      setPreferences(
        'default',
        { quiet: 'off', dueReminders: 'off', mute: [MUTED_B], unmute: [MUTED_A] },
        out,
        { env },
      ),
    );

    expect(sent).toEqual({
      expectedRevision: 3,
      preferences: {
        timeZone: 'Europe/London',
        quietStart: null,
        quietEnd: null,
        dueReminderTime: '09:00',
        dueReminders: false,
        habitReminders: true,
        mutedContainerIds: [MUTED_B],
      },
    });
    await done();
  });

  it('refuses an empty change before any request', async () => {
    const { env, done } = await withProfile();
    await expect(captureText((out) => setPreferences('default', {}, out, { env }))).rejects.toThrow(
      'Nothing to change',
    );
    await done();
  });
});

describe('parsePreferenceFlags', () => {
  it('reads quiet hours as a start and an end', () => {
    expect(parsePreferenceFlags({ quiet: '22:30-06:45' }).quiet).toEqual({
      start: '22:30',
      end: '06:45',
    });
  });

  it.each([
    [{ quiet: '22:00' }, '--quiet'],
    [{ quiet: '25:00-07:00' }, '--quiet'],
    [{ dueTime: '9am' }, '--due-time'],
    [{ dueReminders: 'yes' }, '--due-reminders'],
    [{ habitReminders: 'true' }, '--habit-reminders'],
    [{ timeZone: 'Mars/Olympus' }, '--time-zone'],
    [{ mute: ['not-an-id'] }, '--mute'],
  ])('refuses %j naming %s', (flags, flag) => {
    expect(() => parsePreferenceFlags(flags)).toThrow(flag);
  });

  it('refuses muting and unmuting the same container at once', () => {
    expect(() => parsePreferenceFlags({ mute: [MUTED_A], unmute: [MUTED_A] })).toThrow(
      'both muted and unmuted',
    );
  });
});

describe('applyPreferenceChanges', () => {
  it('leaves everything it was not asked to change as stored', () => {
    const current = preferences() as never;
    const next = applyPreferenceChanges(current, parsePreferenceFlags({ dueTime: '08:15' }));
    expect(next).toEqual({
      timeZone: 'Europe/London',
      quietStart: '22:00',
      quietEnd: '07:00',
      dueReminderTime: '08:15',
      dueReminders: true,
      habitReminders: true,
      mutedContainerIds: [MUTED_A],
    });
  });

  it('does not mute a container twice', () => {
    const next = applyPreferenceChanges(
      preferences() as never,
      parsePreferenceFlags({ mute: [MUTED_A] }),
    );
    expect(next.mutedContainerIds).toEqual([MUTED_A]);
  });

  it('refuses to mute past the 200 containers Core allows', () => {
    const full = Array.from(
      { length: 200 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    expect(() =>
      applyPreferenceChanges(
        preferences({ mutedContainerIds: full }) as never,
        parsePreferenceFlags({ mute: [MUTED_B] }),
      ),
    ).toThrow('At most 200');
  });
});
