/**
 * `nixctl notifications list|read|read-all|prefs`: the caller's own inbox and reminder preferences
 * (ADR-0051 sections 3 and 5).
 *
 * Every read and write here is the signed-in principal's own: Core scopes notifications and
 * preferences to the session principal, so there is no id of anyone else's to pass.
 *
 * `prefs set` changes only the preferences it is given. Preferences are one document saved with
 * compare-and-set, so the command reads the current document, applies the flags, and saves it
 * behind the revision it read - a concurrent change elsewhere fails with Core's conflict rather
 * than being silently overwritten.
 */

import {
  notifications,
  type NotificationsPageResponse,
  type PreferencesInput,
  type PrincipalPreferencesResponse,
} from '@nix/api-client';
import {
  parseTimeOfDay,
  parseTimeZone,
  parseUuid,
  resolveSession,
  type SessionDeps,
} from './shared.ts';
import { humanReadable, printResult, printTable, type OutputOptions } from '../output.ts';
import type { Session } from '../session.ts';

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_MUTED = 200;

export interface ListNotificationsOptions {
  readonly unread?: boolean | undefined;
  readonly cursor?: string | undefined;
}

/** One page of the caller's notifications, newest first. */
export async function executeListNotifications(
  session: Session,
  options: ListNotificationsOptions,
): Promise<NotificationsPageResponse> {
  return session.client.query(
    notifications.list({
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.unread === true ? { unreadOnly: true } : {}),
    }),
  );
}

export async function listNotifications(
  profileName: string | undefined,
  options: ListNotificationsOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const page = await executeListNotifications(session, options);
  if (humanReadable(output)) {
    printTable(
      ['ID', 'CREATED', 'KIND', 'READ', 'TITLE'],
      page.items.map((entry) => [
        entry.id,
        entry.createdAt,
        entry.kind,
        entry.readAt === null ? 'no' : 'yes',
        entry.title,
      ]),
    );
    process.stdout.write(
      `unread ${String(page.unread)}${page.nextCursor === null ? '' : `; next page --cursor ${page.nextCursor}`}\n`,
    );
    return;
  }
  printResult(page, output);
}

/** Marks one notification read; marking one that is already read is success. */
export async function executeReadNotification(
  session: Session,
  notificationId: string,
): Promise<{ readonly id: string; readonly read: true; readonly unread: number }> {
  parseUuid(notificationId, 'The notification id');
  const answer = await session.client.execute(notifications.markRead(notificationId));
  return { id: notificationId, read: true, unread: answer.unread };
}

export async function readNotification(
  profileName: string | undefined,
  notificationId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await executeReadNotification(session, notificationId), output);
}

export async function executeReadAllNotifications(
  session: Session,
): Promise<{ readonly unread: number }> {
  const answer = await session.client.execute(notifications.markAllRead());
  return { unread: answer.unread };
}

export async function readAllNotifications(
  profileName: string | undefined,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await executeReadAllNotifications(session), output);
}

export async function getPreferences(
  profileName: string | undefined,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.query(notifications.preferences()), output);
}

/** The raw `prefs set` flags, as commander hands them over. */
export interface PreferenceFlags {
  readonly timeZone?: string | undefined;
  /** `HH:mm-HH:mm`, or `off` to clear quiet hours. */
  readonly quiet?: string | undefined;
  readonly dueTime?: string | undefined;
  /** `on` or `off`. */
  readonly dueReminders?: string | undefined;
  /** `on` or `off`. */
  readonly habitReminders?: string | undefined;
  readonly mute?: readonly string[] | undefined;
  readonly unmute?: readonly string[] | undefined;
}

/** The validated changes a `prefs set` asks for; absent members leave the stored value alone. */
export interface PreferenceChanges {
  readonly timeZone?: string;
  readonly quiet?: { readonly start: string; readonly end: string } | null;
  readonly dueReminderTime?: string;
  readonly dueReminders?: boolean;
  readonly habitReminders?: boolean;
  readonly mute: readonly string[];
  readonly unmute: readonly string[];
}

/**
 * Checks the flags before any request, so a typo fails naming the flag rather than as Core's 422.
 *
 * @throws When no change is asked for, or a flag is malformed.
 */
export function parsePreferenceFlags(flags: PreferenceFlags): PreferenceChanges {
  const changes: {
    -readonly [K in keyof PreferenceChanges]: PreferenceChanges[K];
  } = { mute: [], unmute: [] };

  if (flags.timeZone !== undefined) {
    changes.timeZone = parseTimeZone(flags.timeZone, '--time-zone');
  }
  if (flags.quiet !== undefined) {
    changes.quiet = parseQuiet(flags.quiet);
  }
  if (flags.dueTime !== undefined) {
    changes.dueReminderTime = parseTimeOfDay(flags.dueTime, '--due-time');
  }
  if (flags.dueReminders !== undefined) {
    changes.dueReminders = parseSwitch(flags.dueReminders, '--due-reminders');
  }
  if (flags.habitReminders !== undefined) {
    changes.habitReminders = parseSwitch(flags.habitReminders, '--habit-reminders');
  }
  changes.mute = (flags.mute ?? []).map((id) => parseUuid(id, '--mute'));
  changes.unmute = (flags.unmute ?? []).map((id) => parseUuid(id, '--unmute'));
  const both = changes.mute.filter((id) => changes.unmute.includes(id));
  if (both.length > 0) {
    throw new Error(`'${both[0] ?? ''}' cannot be both muted and unmuted in one change.`);
  }

  const asked =
    Object.keys(changes).some((key) => key !== 'mute' && key !== 'unmute') ||
    changes.mute.length > 0 ||
    changes.unmute.length > 0;
  if (!asked) {
    throw new Error(
      'Nothing to change. Pass at least one of --time-zone, --quiet, --due-time, ' +
        '--due-reminders, --habit-reminders, --mute or --unmute.',
    );
  }
  return changes;
}

/**
 * Applies validated changes to the stored document, producing the full document Core saves.
 *
 * @throws When muting would exceed the 200 containers Core allows.
 */
export function applyPreferenceChanges(
  current: PrincipalPreferencesResponse,
  changes: PreferenceChanges,
): PreferencesInput {
  const muted = current.mutedContainerIds.filter((id) => !changes.unmute.includes(id));
  for (const id of changes.mute) {
    if (!muted.includes(id)) muted.push(id);
  }
  if (muted.length > MAX_MUTED) {
    throw new Error(`At most ${String(MAX_MUTED)} containers can be muted.`);
  }

  const quiet =
    changes.quiet === undefined
      ? { quietStart: current.quietStart, quietEnd: current.quietEnd }
      : changes.quiet === null
        ? { quietStart: null, quietEnd: null }
        : { quietStart: changes.quiet.start, quietEnd: changes.quiet.end };

  return {
    timeZone: changes.timeZone ?? current.timeZone,
    ...quiet,
    dueReminderTime: changes.dueReminderTime ?? current.dueReminderTime,
    dueReminders: changes.dueReminders ?? current.dueReminders,
    habitReminders: changes.habitReminders ?? current.habitReminders,
    mutedContainerIds: muted,
  };
}

/** Reads, applies and saves behind the revision read. */
export async function executeSetPreferences(
  session: Session,
  changes: PreferenceChanges,
): Promise<PrincipalPreferencesResponse> {
  const current = await session.client.query(notifications.preferences(), {
    forceRefresh: true,
  });
  const next = applyPreferenceChanges(current, changes);
  return session.client.execute(notifications.savePreferences(current.revision, next));
}

export async function setPreferences(
  profileName: string | undefined,
  flags: PreferenceFlags,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const changes = parsePreferenceFlags(flags);
  const session = await resolveSession(profileName, deps);
  printResult(await executeSetPreferences(session, changes), output);
}

function parseQuiet(value: string): { start: string; end: string } | null {
  if (value === 'off') return null;
  const [start, end, ...rest] = value.split('-');
  if (
    start === undefined ||
    end === undefined ||
    rest.length > 0 ||
    !TIME_OF_DAY.test(start) ||
    !TIME_OF_DAY.test(end)
  ) {
    throw new Error(`--quiet must be HH:mm-HH:mm or off - got '${value}'.`);
  }
  if (start === end) throw new Error('--quiet must start and end at different times.');
  return { start, end };
}

function parseSwitch(value: string, flag: string): boolean {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new Error(`${flag} must be on or off - got '${value}'.`);
}
