/**
 * Calendar sync: the external accounts a principal has connected, and the links that mirror one
 * external calendar into one container.
 *
 * Nothing here carries a credential. A connection is described by its provider, its account and
 * its state; the tokens behind it never leave Core.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

/** An int32 the contract may spell as a number or a digit string. */
const int32Schema = z.union([z.number(), z.string()]);

const calendarProviderSchema = z.object({
  provider: z.string(),
  /** Whether this deployment is configured to connect the provider at all. */
  available: z.boolean(),
});

const calendarConnectionSchema = z.object({
  id: z.string(),
  provider: z.string(),
  accountEmail: z.string(),
  /** `active`, `needs_reauth` or `revoked`. */
  status: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  lastError: z.string().nullable(),
});

export type CalendarConnection = z.infer<typeof calendarConnectionSchema>;

export const calendarConnectionsSchema = z.object({
  providers: z.array(calendarProviderSchema),
  connections: z.array(calendarConnectionSchema),
});

export type CalendarConnections = z.infer<typeof calendarConnectionsSchema>;

export const authorizeCalendarSchema = z.object({
  /** Where to send the browser so the account's owner can consent. */
  authorizationUrl: z.string(),
});

export type AuthorizeCalendar = z.infer<typeof authorizeCalendarSchema>;

const externalCalendarSchema = z.object({
  id: z.string(),
  name: z.string(),
  primary: z.boolean(),
  /** A calendar the account cannot write to; it can only be linked `import_only`. */
  readOnly: z.boolean(),
});

export type ExternalCalendar = z.infer<typeof externalCalendarSchema>;

export const externalCalendarsSchema = z.object({
  calendars: z.array(externalCalendarSchema),
});

export type ExternalCalendars = z.infer<typeof externalCalendarsSchema>;

export const calendarLinkSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  provider: z.string(),
  workspaceId: z.string(),
  containerItemId: z.string(),
  externalCalendarId: z.string(),
  name: z.string(),
  /** `two_way` or `import_only`. */
  direction: z.string(),
  windowPastDays: int32Schema,
  windowFutureDays: int32Schema,
  /** `active`, `paused`, `error` or `stopped`. */
  status: z.string(),
  lastSyncedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Sent back on an update so a stale edit is refused rather than applied. */
  revision: int32Schema,
});

export type CalendarLink = z.infer<typeof calendarLinkSchema>;

export const calendarLinksSchema = z.object({
  links: z.array(calendarLinkSchema),
});

export type CalendarLinks = z.infer<typeof calendarLinksSchema>;

export const syncCalendarLinkSchema = z.object({
  jobId: z.string(),
});

export type SyncCalendarLink = z.infer<typeof syncCalendarLinkSchema>;

const calendarSyncLogEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  /** `pull` or `push`. */
  direction: z.string(),
  /** `created`, `updated`, `deleted`, `conflict`, `skipped` or `error`. */
  action: z.string(),
  itemId: z.string().nullable(),
  externalId: z.string().nullable(),
  detail: z.string(),
});

export type CalendarSyncLogEntry = z.infer<typeof calendarSyncLogEntrySchema>;

export const calendarSyncLogPageSchema = z.object({
  entries: z.array(calendarSyncLogEntrySchema),
  nextCursor: z.string().nullable(),
});

export type CalendarSyncLogPage = z.infer<typeof calendarSyncLogPageSchema>;

const workspaceCalendarLinkSchema = z.object({
  /** The container a calendar is linked into. */
  containerItemId: z.string(),
  title: z.string(),
});

export type WorkspaceCalendarLink = z.infer<typeof workspaceCalendarLinkSchema>;

export const workspaceCalendarLinksSchema = z.object({
  links: z.array(workspaceCalendarLinkSchema),
});

export type WorkspaceCalendarLinks = z.infer<typeof workspaceCalendarLinksSchema>;

const _workspaceLinksContract = workspaceCalendarLinksSchema satisfies z.ZodType<
  components['schemas']['WorkspaceCalendarLinksResponse']
>;
void _workspaceLinksContract;

const _connectionsContract = calendarConnectionsSchema satisfies z.ZodType<
  components['schemas']['CalendarConnectionsResponse']
>;
void _connectionsContract;

const _authorizeContract = authorizeCalendarSchema satisfies z.ZodType<
  components['schemas']['AuthorizeCalendarResponse']
>;
void _authorizeContract;

const _externalCalendarsContract = externalCalendarsSchema satisfies z.ZodType<
  components['schemas']['ExternalCalendarsResponse']
>;
void _externalCalendarsContract;

const _linksContract = calendarLinksSchema satisfies z.ZodType<
  components['schemas']['CalendarLinksResponse']
>;
void _linksContract;

const _syncContract = syncCalendarLinkSchema satisfies z.ZodType<
  components['schemas']['SyncCalendarLinkResponse']
>;
void _syncContract;

const _logContract = calendarSyncLogPageSchema satisfies z.ZodType<
  components['schemas']['CalendarSyncLogPageResponse']
>;
void _logContract;
