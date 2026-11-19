import { z } from 'zod';

import type { ConnectorAction } from './connector.ts';
import { googleJson, googleJsonBody, googleRequest, type GoogleCall } from './google-http.ts';

const calendar = 'https://www.googleapis.com/calendar/v3/';
const eventFields =
  'id,etag,status,summary,description,location,start,end,attendees,attendeesOmitted,recurrence,recurringEventId';
const calendarId = z
  .string()
  .min(1)
  .max(254)
  .regex(/^[\w.@+#%+-]+$/u)
  .refine((id) => id !== '.' && id !== '..');
const eventId = z
  .string()
  .max(1024)
  .regex(/^[\w-]+$/u);
const email = z.email().max(254);
const date = z.iso.date();
const instant = z.iso.datetime({ offset: true });
const etag = z
  .string()
  .max(256)
  .regex(/^(?:W\/)?"[^"\p{Cc}]*"$/u);
const dayMs = 86_400_000;

const timeWindow = z.strictObject({ start: instant, end: instant }).refine(({ start, end }) => {
  const duration = Date.parse(end) - Date.parse(start);
  return duration > 0 && duration <= 31 * dayMs;
});
const time = z.object({
  date: date.optional(),
  dateTime: instant.optional(),
  timeZone: z.string().max(128).optional(),
});
const attendee = z.object({
  email,
  optional: z.boolean().optional(),
  comment: z.string().max(4096).optional(),
  additionalGuests: z.number().int().nonnegative().optional(),
  responseStatus: z.enum(['needsAction', 'declined', 'tentative', 'accepted']).optional(),
  resource: z.boolean().optional(),
});
const event = z.object({
  id: eventId,
  etag,
  status: z.enum(['confirmed', 'tentative', 'cancelled']),
  summary: z.string().max(4096).optional(),
  description: z.string().max(16_000).optional(),
  location: z.string().max(4096).optional(),
  start: time.optional(),
  end: time.optional(),
  attendees: z.array(attendee).max(100).optional(),
  attendeesOmitted: z.boolean().optional(),
  recurrence: z.array(z.string().max(2048)).max(50).optional(),
  recurringEventId: eventId.optional(),
});
const targetEvent = z.strictObject({ eventId });
const schedule = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('timed'), start: instant, end: instant }),
    z.strictObject({ kind: z.literal('all-day'), start: date, exclusiveEnd: date }),
  ])
  .refine(
    (value) =>
      Date.parse(value.start) < Date.parse(value.kind === 'timed' ? value.end : value.exclusiveEnd),
  );
const recipients = z
  .array(email)
  .max(20)
  .refine(
    (addresses) =>
      new Set(addresses.map((address) => address.toLowerCase())).size === addresses.length,
  );
const reviewedEvent = targetEvent.extend({
  etag,
  previousAttendees: recipients,
  notifyAttendees: z.boolean(),
});
const eventFieldsArgs = {
  summary: z
    .string()
    .min(1)
    .max(320)
    .regex(/^\P{Cc}+$/u),
  description: z.string().max(4096).optional(),
  location: z
    .string()
    .max(320)
    .regex(/^\P{Cc}*$/u)
    .optional(),
  schedule,
  attendees: recipients,
};
const createEvent = z.strictObject({ ...eventFieldsArgs, notifyAttendees: z.boolean() });
const updateEvent = reviewedEvent.extend(eventFieldsArgs);

function calendarUrl(call: GoogleCall, id?: string): URL {
  const events = `calendars/${encodeURIComponent(calendarId.parse(call.resourceId))}/events`;
  return new URL(id === undefined ? events : `${events}/${id}`, calendar);
}

async function readEvent(call: GoogleCall, id: string) {
  const url = calendarUrl(call, id);
  url.searchParams.set('fields', eventFields);
  const current = await googleJson(call, url, event);
  if (current.id !== id) throw new Error('Google Calendar returned a different event.');
  return current;
}

async function currentEvent(call: GoogleCall, args: z.infer<typeof reviewedEvent>) {
  const current = await readEvent(call, args.eventId);
  if (current.etag !== args.etag || current.status === 'cancelled') {
    throw new Error('The reviewed Google Calendar event changed.');
  }
  const existing = new Set(current.attendees?.map((value) => value.email.toLowerCase()));
  if (
    current.attendeesOmitted === true ||
    existing.size !== args.previousAttendees.length ||
    args.previousAttendees.some((address) => !existing.has(address.toLowerCase()))
  ) {
    throw new Error('The reviewed Google Calendar attendees changed.');
  }
  if (current.recurrence?.length) throw new Error('Choose an occurrence of the recurring event.');
  return current;
}

function eventBody(
  args: Pick<z.infer<typeof createEvent>, keyof typeof eventFieldsArgs>,
  existing: readonly z.infer<typeof attendee>[] = [],
) {
  const { schedule: when } = args;
  const dates =
    when.kind === 'timed'
      ? { start: { dateTime: when.start }, end: { dateTime: when.end } }
      : { start: { date: when.start }, end: { date: when.exclusiveEnd } };
  const byEmail = new Map(existing.map((guest) => [guest.email.toLowerCase(), guest]));
  return {
    summary: args.summary,
    description: args.description ?? '',
    location: args.location ?? '',
    ...dates,
    attendees: args.attendees.map((address) => ({
      ...byEmail.get(address.toLowerCase()),
      email: address,
    })),
  };
}

export const googleCalendarActions: readonly ConnectorAction[] = [
  {
    id: 'google-calendar.free-busy',
    kind: 'read',
    resourceKind: 'calendar',
    description: 'Find busy periods in the connected Google calendar.',
    args: timeWindow,
    async execute(call: GoogleCall): Promise<unknown> {
      const window = timeWindow.parse(call.args);
      const id = calendarId.parse(call.resourceId);
      const result = await googleJson(
        call,
        new URL('freeBusy', calendar),
        z.object({
          calendars: z.record(
            z.string().max(254),
            z.object({
              busy: z
                .array(z.object({ start: instant, end: instant }))
                .max(500)
                .optional(),
              errors: z.array(z.unknown()).optional(),
            }),
          ),
        }),
        googleJsonBody('POST', { timeMin: window.start, timeMax: window.end, items: [{ id }] }),
      );
      const selected = result.calendars[id];
      if (selected?.busy === undefined || selected.errors?.length) {
        throw new Error('Google Calendar could not determine availability.');
      }
      return { calendarId: id, ...window, busy: selected.busy };
    },
  },
  {
    id: 'google-calendar.get-event',
    kind: 'read',
    resourceKind: 'calendar',
    description: 'Read an event and its revision from the connected Google calendar.',
    args: targetEvent,
    async execute(call: GoogleCall): Promise<unknown> {
      return readEvent(call, targetEvent.parse(call.args).eventId);
    },
  },
  {
    id: 'google-calendar.create-event',
    kind: 'write',
    resourceKind: 'calendar',
    description: 'Create an approved event with its exact attendees and invitation choice.',
    args: createEvent,
    async execute(call: GoogleCall): Promise<unknown> {
      const args = createEvent.parse(call.args);
      const id = z.uuid().parse(call.executionId).toLowerCase().replaceAll('-', '');
      const url = calendarUrl(call);
      url.searchParams.set('sendUpdates', args.notifyAttendees ? 'all' : 'none');
      url.searchParams.set('fields', eventFields);
      const created = await googleJson(
        call,
        url,
        event,
        googleJsonBody('POST', { id, ...eventBody(args) }),
      );
      if (created.id !== id)
        throw new Error('Google Calendar returned an unexpected event receipt.');
      return created;
    },
  },
  {
    id: 'google-calendar.update-event',
    kind: 'write',
    resourceKind: 'calendar',
    description:
      'Apply reviewed changes to one Google Calendar event with its exact attendees and notification choice.',
    args: updateEvent,
    async execute(call: GoogleCall): Promise<unknown> {
      const args = updateEvent.parse(call.args);
      const current = await currentEvent(call, args);
      const url = calendarUrl(call, args.eventId);
      url.searchParams.set('sendUpdates', args.notifyAttendees ? 'all' : 'none');
      url.searchParams.set('fields', eventFields);
      const update = await googleJson(call, url, event, {
        ...googleJsonBody('PATCH', eventBody(args, current.attendees)),
        headers: { 'Content-Type': 'application/json', 'If-Match': args.etag },
      });
      if (update.id !== args.eventId)
        throw new Error('Google Calendar returned an unexpected event receipt.');
      return update;
    },
  },
  {
    id: 'google-calendar.delete-event',
    kind: 'write',
    resourceKind: 'calendar',
    description:
      'Cancel one reviewed Google Calendar event with its exact attendees and notification choice.',
    args: reviewedEvent,
    async execute(call: GoogleCall): Promise<unknown> {
      const args = reviewedEvent.parse(call.args);
      await currentEvent(call, args);
      const url = calendarUrl(call, args.eventId);
      url.searchParams.set('sendUpdates', args.notifyAttendees ? 'all' : 'none');
      const response = await googleRequest(call, url, {
        method: 'DELETE',
        headers: { 'If-Match': args.etag },
      });
      await response.body?.cancel();
      return { id: args.eventId, cancelled: true };
    },
  },
];
