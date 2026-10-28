/**
 * Named, memoised date/time formatters shared across the app. Each is named after what it shows
 * so a call site picks the shape it needs rather than hand-building an `Intl.DateTimeFormat`
 * options bag. `lib/` is a leaf: this file imports nothing feature-specific.
 */

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

const fullDateFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const calendarDayFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeZone: 'UTC',
});

const shortDateFormatters = new Map<string, Intl.DateTimeFormat>();

/** `en-CA` sorts `year`/`month`/`day` into `yyyy-mm-dd`, which is what every short-date call site
 * wants; formatters are cached per timezone since that's the only thing that varies. */
function shortDateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = shortDateFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    shortDateFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** A clock time in the reader's own locale - "9:41 AM". */
export function formatTime(date: Date): string {
  return timeFormatter.format(date);
}

/** A full calendar date in the reader's own locale - "Tuesday, September 22, 2026". */
export function formatFullDate(date: Date): string {
  return fullDateFormatter.format(date);
}

/** A medium date with a short time, in the reader's own locale - "Sep 22, 2026, 9:41 AM". */
export function formatDateTime(date: Date): string {
  return dateTimeFormatter.format(date);
}

/** A `yyyy-mm-dd` calendar date for the given IANA timezone - "2026-09-22". */
export function formatShortDate(date: Date, timeZone: string): string {
  return shortDateFormatter(timeZone).format(date);
}

/**
 * A stored `yyyy-mm-dd` calendar day in the reader's own locale - "Sep 1, 2026" - or `undefined`
 * when the value is not one. Read and written in UTC so the day never shifts with the reader's
 * timezone: a calendar day has no time to shift.
 */
export function formatCalendarDay(day: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) return undefined;
  const instant = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== day) {
    return undefined;
  }
  return calendarDayFormatter.format(instant);
}

/** The reader's own IANA timezone, as their runtime resolves it. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const RELATIVE_TIME_UNITS: readonly {
  readonly unit: Intl.RelativeTimeFormatUnit;
  readonly ms: number;
}[] = [
  { unit: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { unit: 'hour', ms: 60 * 60 * 1000 },
  { unit: 'minute', ms: 60 * 1000 },
];

/** How long ago (or, for a future instant, how soon) `date` is relative to `now` - "3 minutes
 * ago", "yesterday", "in 2 days". Falls back to seconds only for anything under a minute, which
 * `Intl.RelativeTimeFormat` renders as "now". */
export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = date.getTime() - now.getTime();
  for (const { unit, ms } of RELATIVE_TIME_UNITS) {
    if (Math.abs(diffMs) >= ms) {
      return relativeTimeFormatter.format(Math.round(diffMs / ms), unit);
    }
  }
  return relativeTimeFormatter.format(Math.round(diffMs / 1000), 'second');
}
