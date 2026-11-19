import { describe, expect, it, vi } from 'vitest';

import { outlookCalendarActions } from './microsoft.calendar.ts';

const executionId = '14a0a77b-2a77-407b-835f-4535f40d191c';
const calendar = 'calendar+A=';
const calendarPath = `/v1.0/me/calendars/${encodeURIComponent(calendar)}`;
const start = '2026-02-10T09:00:00Z';
const end = '2026-02-10T13:00:00Z';
const attendee = { address: 'alex@example.com', role: 'optional' };
const current = {
  id: 'event=1',
  '@odata.etag': 'W/"reviewed=="',
  isCancelled: false,
  isOrganizer: true,
  isOnlineMeeting: false,
  type: 'singleInstance',
  attendees: [{ emailAddress: { address: attendee.address }, type: attendee.role }],
};

function run(name: string, args: unknown, fetch: typeof globalThis.fetch, resourceId = calendar) {
  const action = outlookCalendarActions.find(({ id }) => id === `outlook-calendar.${name}`);
  if (!action) throw new Error('Missing fixture action.');
  return action.execute({
    executionId,
    resourceId,
    accessToken: 'example-token',
    args,
    fetch,
    signal: new AbortController().signal,
  });
}

function fixtureTime(dateTime: string) {
  return { dateTime, timeZone: 'UTC' };
}

function requestUrl(input?: Parameters<typeof globalThis.fetch>[0]): URL {
  if (input === undefined) throw new Error('Fixture requires a request URL.');
  return new URL(input instanceof Request ? input.url : input);
}

function requestBody(init?: RequestInit): unknown {
  if (typeof init?.body !== 'string') throw new Error('Fixture requires a JSON body.');
  const parsed: unknown = JSON.parse(init.body);
  return parsed;
}

describe('Outlook calendar connector', () => {
  it('only returns clipped busy intervals and marks a partial calendar view', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
      const target = requestUrl(url);
      expect(target.origin).toBe('https://graph.microsoft.com');
      expect(target.pathname).toBe(`${calendarPath}/calendarView`);
      expect(target.searchParams.get('startDateTime')).toBe(start);
      expect(target.searchParams.get('$top')).toBe('4');
      expect(target.searchParams.get('$select')).toBe('start,end,showAs,isCancelled');
      expect(new Headers(init?.headers).get('prefer')).toBe('outlook.timezone="UTC"');
      expect(init?.redirect).toBe('manual');
      const event = {
        id: 'keep-this-out-of-the-result',
        subject: 'Private meeting',
        isCancelled: false,
        start: fixtureTime('2026-02-10T08:00:00.0000000'),
        end: fixtureTime('2026-02-10T10:00:00.0000000'),
      };
      return Promise.resolve(
        Response.json({
          value: [
            { ...event, showAs: 'busy' },
            { ...event, showAs: 'free' },
            { ...event, showAs: 'busy', isCancelled: true },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/contains-provider-page-token',
        }),
      );
    });
    await expect(run('availability', { start, end, limit: 4 }, fetch)).resolves.toEqual({
      busy: [
        { start: '2026-02-10T09:00:00.000Z', end: '2026-02-10T10:00:00.000Z', status: 'busy' },
      ],
      truncated: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('creates exactly the approved calendar event and uses the execution id for retries', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
      expect(requestUrl(url).pathname).toBe(`${calendarPath}/events`);
      expect(init?.method).toBe('POST');
      expect(requestBody(init)).toEqual({
        subject: 'Plan review',
        start: { dateTime: '2026-02-10T09:00:00.000', timeZone: 'UTC' },
        end: { dateTime: '2026-02-10T13:00:00.000', timeZone: 'UTC' },
        isAllDay: false,
        body: { contentType: 'text', content: 'Decide the date.' },
        attendees: [{ emailAddress: { address: attendee.address }, type: attendee.role }],
        transactionId: executionId,
      });
      return Promise.resolve(
        Response.json({ id: 'new-event=', changeKey: 'version==' }, { status: 201 }),
      );
    });
    await expect(
      run(
        'create-event',
        {
          title: 'Plan review',
          schedule: { allDay: false, start: '2026-02-10T10:00:00+01:00', end },
          description: 'Decide the date.',
          attendees: [attendee],
        },
        fetch,
      ),
    ).resolves.toEqual({ eventId: 'new-event=', version: 'version==' });
  });

  it('returns the reviewed event version and attendee roles while keeping HTML out of results', async () => {
    const event = {
      ...current,
      subject: 'Team day',
      start: fixtureTime('2026-02-10T00:00:00'),
      end: fixtureTime('2026-02-11T00:00:00'),
      isAllDay: true,
      body: { contentType: 'html', content: '<p>Private body</p>' },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ value: [event] }))
      .mockResolvedValueOnce(Response.json(event));
    const view = {
      eventId: current.id,
      version: current['@odata.etag'],
      title: event.subject,
      schedule: { allDay: true, start: '2026-02-10', end: '2026-02-11' },
      cancelled: false,
    };
    await expect(run('list-events', { start, end }, fetch)).resolves.toEqual({
      events: [view],
      truncated: false,
    });
    await expect(run('get-event', { eventId: current.id }, fetch)).resolves.toEqual({
      ...view,
      description: undefined,
      location: undefined,
      attendees: [attendee],
      canUpdate: true,
      onlineMeeting: false,
    });
    expect(requestUrl(fetch.mock.calls[0]?.[0]).pathname).toBe(`${calendarPath}/calendarView`);
    expect(requestUrl(fetch.mock.calls[1]?.[0]).pathname).toBe(
      `${calendarPath}/events/${encodeURIComponent(current.id)}`,
    );
  });

  it('checks the reviewed event and attendees before applying the revision-bound patch', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(current))
      .mockResolvedValueOnce(Response.json({ id: current.id, '@odata.etag': 'W/"updated=="' }));
    await expect(
      run(
        'update-event',
        {
          eventId: current.id,
          expectedVersion: current['@odata.etag'],
          expectedAttendees: [attendee],
          changes: { title: 'Approved title' },
        },
        fetch,
      ),
    ).resolves.toEqual({ eventId: current.id, version: 'W/"updated=="' });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[1] ?? [];
    expect(requestUrl(url).pathname).toBe(
      `${calendarPath}/events/${encodeURIComponent(current.id)}`,
    );
    expect(init?.method).toBe('PATCH');
    expect(new Headers(init?.headers).get('if-match')).toBe(current['@odata.etag']);
    expect(requestBody(init)).toEqual({ subject: 'Approved title' });
  });

  it.each([
    { '@odata.etag': 'W/"changed=="' },
    { attendees: [{ emailAddress: { address: 'unexpected@example.com' }, type: 'optional' }] },
    { isOnlineMeeting: true },
  ])('refuses to patch when the reviewed changes cannot be applied safely', async (override) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ ...current, ...override }));
    await expect(
      run(
        'update-event',
        {
          eventId: current.id,
          expectedVersion: current['@odata.etag'],
          expectedAttendees: [attendee],
          changes: { description: 'Approved text.' },
        },
        fetch,
      ),
    ).rejects.toThrow(/Review the current event|online meeting in Outlook/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.method).toBeUndefined();
  });

  it('rejects invalid date ranges and provider path segments before dispatch', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(run('availability', { start: end, end: start }, fetch)).rejects.toThrow();
    await expect(run('availability', { start, end }, fetch, '..')).rejects.toThrow();
    await expect(
      run(
        'update-event',
        {
          eventId: current.id,
          expectedVersion: '*',
          expectedAttendees: [attendee],
          changes: { title: 'Wildcard update' },
        },
        fetch,
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
