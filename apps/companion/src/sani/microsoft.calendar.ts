import { z } from 'zod';

import type { ConnectorAction } from './connector.ts';
import {
  graphId,
  graphJson,
  graphPageSize,
  graphSegment,
  withGraphQuery,
  writeJson,
  type GraphInput,
} from './microsoft.shared.ts';

const NAMESPACE = 'outlook-calendar';
const UTC = { Prefer: 'outlook.timezone="UTC"' };
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const isoInstant = z.iso.datetime({ offset: true });
const timed = z.strictObject({ allDay: z.literal(false), start: isoInstant, end: isoInstant });
const allDay = z.strictObject({ allDay: z.literal(true), start: z.iso.date(), end: z.iso.date() });
const schedule = z
  .discriminatedUnion('allDay', [timed, allDay])
  .refine(
    ({ start, end }) => Date.parse(start) < Date.parse(end),
    'The event must end after it starts.',
  );
const dateWindow = z
  .strictObject({ start: isoInstant, end: isoInstant, limit: graphPageSize })
  .refine(({ start, end }) => {
    const length = Date.parse(end) - Date.parse(start);
    return length > 0 && length <= MAX_WINDOW_MS;
  }, 'Choose a calendar window of up to 31 days.');

const eventTitle = z
  .string()
  .min(1)
  .max(255)
  .refine((title) => title.trim().length > 0);
const description = z.string().max(12_000);
const location = z.string().max(255);
const role = z.enum(['required', 'optional', 'resource']);
const address = z.email().max(254);
const approvedAttendees = z
  .array(z.strictObject({ address, role }))
  .max(25)
  .refine(
    (people) =>
      new Set(people.map((person) => person.address.toLowerCase())).size === people.length,
    'Each attendee must have a distinct email address.',
  );
const version = z
  .string()
  .max(512)
  .regex(/^(?:(?:W\/)?"[A-Za-z0-9+/=_-]+"|[A-Za-z0-9+/=_-]+)$/);
const getArgs = z.strictObject({ eventId: graphId });
const createArgs = z.strictObject({
  title: eventTitle,
  schedule,
  description: description.optional(),
  location: location.optional(),
  attendees: approvedAttendees.optional(),
});
const updateArgs = z.strictObject({
  eventId: graphId,
  expectedVersion: version,
  expectedAttendees: approvedAttendees,
  changes: createArgs
    .partial()
    .refine((changes) => Object.keys(changes).length > 0, 'Choose an event change.'),
});

const graphTime = z
  .object({ dateTime: z.iso.datetime({ local: true }), timeZone: z.literal('UTC') })
  .transform(({ dateTime }) =>
    new Date(dateTime.endsWith('Z') ? dateTime : `${dateTime}Z`).toISOString(),
  );
const graphEventIdentity = z.object({
  id: graphId,
  '@odata.etag': version.optional(),
  changeKey: version.optional(),
});
const graphEventFlags = graphEventIdentity.extend({
  type: z.enum(['singleInstance', 'occurrence', 'exception', 'seriesMaster']),
  isOrganizer: z.boolean(),
  isCancelled: z.boolean(),
  isOnlineMeeting: z.boolean(),
  attendees: z.array(z.object({ emailAddress: z.object({ address }), type: role })).max(25),
});
const graphEventView = graphEventIdentity.extend({
  subject: z.string().max(255),
  start: graphTime,
  end: graphTime,
  isAllDay: z.boolean(),
  isCancelled: z.boolean(),
});
const graphEventDetails = graphEventView.extend(graphEventFlags.shape).extend({
  body: z.object({ contentType: z.string().max(16), content: description }).optional(),
  location: z.object({ displayName: location }).optional(),
});
const graphAvailability = z.object({
  start: graphTime,
  end: graphTime,
  showAs: z.enum(['free', 'tentative', 'busy', 'oof', 'workingElsewhere', 'unknown']),
  isCancelled: z.boolean(),
});

function calendarPath(input: GraphInput): string {
  return `/me/calendars/${graphSegment(input.resourceId)}`;
}

function eventPath(input: GraphInput, eventId: string): string {
  return `${calendarPath(input)}/events/${graphSegment(eventId)}`;
}

function revision(event: z.infer<typeof graphEventIdentity>): string {
  return version.parse(event['@odata.etag'] ?? event.changeKey);
}

function recipients(event: z.infer<typeof graphEventFlags>): z.infer<typeof approvedAttendees> {
  return event.attendees.map(({ emailAddress, type }) => ({
    address: emailAddress.address,
    role: type,
  }));
}

function recipientKeys(people: z.infer<typeof approvedAttendees>): string[] {
  return people.map((person) => `${person.address.toLowerCase()} ${person.role}`).sort();
}

function eventView(event: z.infer<typeof graphEventView>) {
  return {
    eventId: event.id,
    version: revision(event),
    title: event.subject,
    schedule: event.isAllDay
      ? { allDay: true, start: event.start.slice(0, 10), end: event.end.slice(0, 10) }
      : { allDay: false, start: event.start, end: event.end },
    cancelled: event.isCancelled,
  };
}

function eventBody(input: z.infer<typeof updateArgs>['changes']) {
  const time = input.schedule;
  const bound = (value: string) => ({
    dateTime: time?.allDay ? `${value}T00:00:00` : new Date(value).toISOString().slice(0, -1),
    timeZone: 'UTC',
  });
  return {
    subject: input.title,
    body:
      input.description === undefined
        ? undefined
        : { contentType: 'text', content: input.description },
    location: input.location === undefined ? undefined : { displayName: input.location },
    start: time === undefined ? undefined : bound(time.start),
    end: time === undefined ? undefined : bound(time.end),
    isAllDay: time?.allDay,
    attendees: input.attendees?.map((person) => ({
      emailAddress: { address: person.address },
      type: person.role,
    })),
  };
}

function calendarQuery(
  input: GraphInput,
  range: z.infer<typeof dateWindow>,
  fields: string,
): string {
  return withGraphQuery(`${calendarPath(input)}/calendarView`, {
    startDateTime: range.start,
    endDateTime: range.end,
    $top: String(range.limit ?? 25),
    $select: fields,
  });
}

const availabilityPage = z.object({
  value: z.array(graphAvailability).max(25),
  '@odata.nextLink': z.string().optional(),
});
const eventsPage = z.object({
  value: z.array(graphEventView).max(25),
  '@odata.nextLink': z.string().optional(),
});

export const outlookCalendarActions: readonly ConnectorAction[] = [
  {
    id: `${NAMESPACE}.availability`,
    kind: 'read',
    resourceKind: 'calendar',
    description:
      'Read busy intervals in the selected Outlook calendar. A truncated result cannot establish availability.',
    args: dateWindow,
    async execute(input: GraphInput): Promise<unknown> {
      const range = dateWindow.parse(input.args);
      const page = availabilityPage.parse(
        await graphJson(input, calendarQuery(input, range, 'start,end,showAs,isCancelled'), {
          headers: UTC,
        }),
      );
      const start = new Date(range.start).toISOString();
      const end = new Date(range.end).toISOString();
      const busy = page.value
        .filter((event) => !event.isCancelled && event.showAs !== 'free')
        .map((event) => ({
          start: event.start < start ? start : event.start,
          end: event.end > end ? end : event.end,
          status: event.showAs,
        }))
        .filter((interval) => interval.start < interval.end);
      return { busy, truncated: page['@odata.nextLink'] !== undefined };
    },
  },
  {
    id: `${NAMESPACE}.list-events`,
    kind: 'read',
    resourceKind: 'calendar',
    description:
      'List event titles, times and identifiers in the selected Outlook calendar and time window.',
    args: dateWindow,
    async execute(input: GraphInput): Promise<unknown> {
      const range = dateWindow.parse(input.args);
      const fields = 'id,changeKey,subject,start,end,isAllDay,isCancelled';
      const page = eventsPage.parse(
        await graphJson(input, calendarQuery(input, range, fields), { headers: UTC }),
      );
      return {
        events: page.value.map(eventView),
        truncated: page['@odata.nextLink'] !== undefined,
      };
    },
  },
  {
    id: `${NAMESPACE}.get-event`,
    kind: 'read',
    resourceKind: 'calendar',
    description:
      'Read an event in the selected calendar, including the version and attendees needed to review an update.',
    args: getArgs,
    async execute(input: GraphInput): Promise<unknown> {
      const { eventId } = getArgs.parse(input.args);
      const path = withGraphQuery(eventPath(input, eventId), {
        $select:
          'id,changeKey,subject,body,location,start,end,isAllDay,type,isOrganizer,isCancelled,isOnlineMeeting,attendees',
      });
      const event = graphEventDetails.parse(
        await graphJson(input, path, {
          headers: { Prefer: `${UTC.Prefer}, outlook.body-content-type="text"` },
        }),
      );
      if (event.id !== eventId) throw new Error('Outlook returned a different event.');
      return {
        ...eventView(event),
        description:
          event.body?.contentType.toLowerCase() === 'text' ? event.body.content : undefined,
        location: event.location?.displayName,
        attendees: recipients(event),
        canUpdate: event.isOrganizer && event.type === 'singleInstance' && !event.isCancelled,
        onlineMeeting: event.isOnlineMeeting,
      };
    },
  },
  {
    id: `${NAMESPACE}.create-event`,
    kind: 'write',
    resourceKind: 'calendar',
    description:
      'Create the approved Outlook event and invite only the listed attendees. An all-day event uses an exclusive end date.',
    args: createArgs,
    async execute(input: GraphInput): Promise<unknown> {
      const args = createArgs.parse(input.args);
      const body = { ...eventBody(args), transactionId: z.uuid().parse(input.executionId) };
      const event = graphEventIdentity.parse(
        await graphJson(input, `${calendarPath(input)}/events`, writeJson('POST', body)),
      );
      return { eventId: event.id, version: revision(event) };
    },
  },
  {
    id: `${NAMESPACE}.update-event`,
    kind: 'write',
    resourceKind: 'calendar',
    description:
      'Apply approved changes to a single Outlook event you organize. Outlook may notify the reviewed existing and new attendees.',
    args: updateArgs,
    async execute(input: GraphInput): Promise<unknown> {
      const { eventId, expectedVersion, expectedAttendees, changes } = updateArgs.parse(input.args);
      const path = eventPath(input, eventId);
      const target = withGraphQuery(path, {
        $select: 'id,changeKey,type,isOrganizer,isCancelled,isOnlineMeeting,attendees',
      });
      const current = graphEventFlags.parse(await graphJson(input, target));
      if (
        current.id !== eventId ||
        !current.isOrganizer ||
        current.type !== 'singleInstance' ||
        current.isCancelled
      ) {
        throw new Error('The selected Outlook event is unavailable for this update.');
      }
      if (
        revision(current) !== expectedVersion ||
        JSON.stringify(recipientKeys(recipients(current))) !==
          JSON.stringify(recipientKeys(expectedAttendees))
      ) {
        throw new Error('The Outlook event changed. Review the current event before updating it.');
      }
      // Replacing the body of an online meeting could remove its join details.
      if (current.isOnlineMeeting && changes.description !== undefined) {
        throw new Error('Edit the description of this online meeting in Outlook.');
      }
      const event = graphEventIdentity.parse(
        await graphJson(input, path, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'If-Match': expectedVersion },
          body: JSON.stringify(eventBody(changes)),
        }),
      );
      if (event.id !== eventId) throw new Error('Outlook returned a different event.');
      return { eventId, version: revision(event) };
    },
  },
];
