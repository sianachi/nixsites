import { DateTime } from 'luxon';

/**
 * Reading and writing a timestamp property.
 *
 * **One file knows how a stored value becomes a position on a grid**, so the calendar never
 * constructs a moment for itself and there is one place to look when a time is off by an hour.
 *
 * A timestamp is stored as RFC 9557 - a local time, the offset it was written at, and the zone it
 * belongs to:
 *
 * ```
 * 2026-03-17T09:00:00+00:00[Europe/London]
 * ```
 *
 * The zone is kept because the instant alone is not enough. A 09:00 Europe/London standup stored as
 * a moment becomes 10:00 London the day the clocks change: the instant survived and the meaning did
 * not. The server refuses a value whose offset disagrees with what its zone was doing at that
 * moment, so anything reaching here is internally consistent.
 *
 * **Luxon rather than a library that bundles the zone database.** The platform already carries it -
 * `Intl` reports several hundred IANA zones - so shipping a second copy would be paying in bytes
 * for something already installed. The cost is that Luxon resolves an ambiguous local time by
 * picking one rather than making the caller choose; the values this reads have already been through
 * a server that checked them, so that only matters at the moment one is written.
 */

/** A stored timestamp, as it exists on screen. */
export interface Timestamp {
  /** The moment, for placing and ordering. */
  readonly at: DateTime;

  /** The zone it was written in, which is not necessarily the reader's. */
  readonly zone: string;
}

const STORED = /^(.+)\[([^\]]+)\]$/;

/**
 * Reads a property as a timestamp, or nothing.
 *
 * Refuses anything not carrying a zone, which includes a bare ISO instant. That is deliberate and
 * matches the server: an offset says what the clock read, not which rules it was following.
 */
export function readTimestampValue(
  properties: Readonly<Record<string, unknown>>,
  key: string,
): Timestamp | null {
  const value = properties[key];
  if (typeof value !== 'string') {
    return null;
  }

  const parts = STORED.exec(value);
  if (parts === null) {
    return null;
  }

  const [, moment, zone] = parts;
  if (moment === undefined || zone === undefined) {
    return null;
  }

  // `setZone` with `keepLocalTime: false` reinterprets the parsed instant in the named zone, which
  // is what the stored offset already fixed. An unknown zone leaves Luxon invalid rather than
  // throwing, so the check below covers both that and a malformed moment.
  const at = DateTime.fromISO(moment, { setZone: true }).setZone(zone);

  return at.isValid ? { at, zone } : null;
}

/**
 * Writes a local time in a zone into the stored form.
 *
 * `local` is a wall clock - `2026-03-17T09:00` - and means what it says in the zone given, which is
 * how somebody types a time into a calendar. The offset is derived rather than supplied, so it can
 * never disagree with the zone.
 */
export function writeTimestampValue(local: string, zone: string): string | null {
  const at = DateTime.fromISO(local, { zone });
  if (!at.isValid) {
    return null;
  }

  // `toISO` only returns null for an invalid DateTime, and the guard above has already ruled that
  // out - the types say so, so a second check here would be a branch that can never be taken.
  const moment = at.toISO({ suppressMilliseconds: true, includeOffset: true });
  return `${moment}[${zone}]`;
}

/** The zone this reader is sitting in, which is the clock a grid is drawn against. */
export function readerZone(): string {
  return DateTime.local().zoneName;
}

/** Today as the reader's own calendar day, `yyyy-MM-dd`. */
export function readerToday(): string {
  // en-CA formats as YYYY-MM-DD, which is the one locale trick this file allows itself: the
  // alternative is hand-assembling parts, and both are pinned by the test asserting the shape.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: readerZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * The day a timestamp falls on, for the reader.
 *
 * `yyyy-MM-dd`, so it compares against a calendar cell's own date text exactly as a plain date does.
 * Converting first is the point: an instant placed without being converted is placed in whatever
 * zone it was written in, which for a reader ten hours away is the wrong day about half the time.
 */
export function dayFor(value: Timestamp, zone: string): string {
  return value.at.setZone(zone).toFormat('yyyy-MM-dd');
}

/** The time of day a timestamp falls at, for the reader. Minutes since midnight. */
export function minutesFor(value: Timestamp, zone: string): number {
  const local = value.at.setZone(zone);
  return local.hour * 60 + local.minute;
}

/** How a timestamp reads on a card, in the reader's own clock. */
export function formatTime(value: Timestamp, zone: string): string {
  return value.at.setZone(zone).toFormat('HH:mm');
}
