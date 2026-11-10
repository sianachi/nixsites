/** Calendar helpers on `yyyy-MM-dd` text and day numbers (days since 0001-01-01). */

const DAY_MS = 86_400_000;
const UNIX_DAY_NUMBER = 719_162;

function utcDate(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

/** A day's number, or null when the text is not a real `yyyy-MM-dd` date (years 0001-9999). */
export function dayNumber(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = utcDate(year, month, day);
  const real =
    year >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  return real ? Math.floor(date.getTime() / DAY_MS) + UNIX_DAY_NUMBER : null;
}

export function dayText(number: number): string {
  const date = new Date((number - UNIX_DAY_NUMBER) * DAY_MS);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  return `${year}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** 0 for Sunday through 6 for Saturday. */
export const weekday = (number: number): number => (number + 1) % 7;

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormat(zone: string): Intl.DateTimeFormat {
  let format = formatters.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(zone, format);
  }
  return format;
}

/** Whether the runtime knows this IANA zone. */
export function validZone(zone: string): boolean {
  try {
    zoneFormat(zone);
    return true;
  } catch {
    return false;
  }
}

/** The local date at `now` in a zone, as a day number. */
export function localDay(now: Date, zone: string): number {
  const parts = Object.fromEntries(
    zoneFormat(zone)
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return dayNumber([String(parts.year).padStart(4, '0'), parts.month, parts.day].join('-')) ?? 0;
}
