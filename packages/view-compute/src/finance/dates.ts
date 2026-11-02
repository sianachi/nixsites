/** Calendar helpers on `yyyy-MM-dd` text, day numbers (days since 0001-01-01) and month indexes. */

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

/** A month as `year * 12 + month - 1`, so month arithmetic is integer arithmetic. */
export type Month = number;

export const monthOf = (year: number, month: number): Month => year * 12 + month - 1;
export const monthYear = (m: Month): number => Math.floor(m / 12);
export const monthNumber = (m: Month): number => (m % 12) + 1;
export const monthText = (m: Month): string =>
  `${String(monthYear(m)).padStart(4, '0')}-${String(monthNumber(m)).padStart(2, '0')}`;

/** `yyyy-MM`, nothing else. */
export function parseMonth(text: string | null | undefined): Month | null {
  const match = text === null || text === undefined ? null : /^(\d{4})-(\d{2})$/.exec(text);
  if (match === null) return null;
  const [year, month] = [Number(match[1]), Number(match[2])];
  return year >= 1 && month >= 1 && month <= 12 ? monthOf(year, month) : null;
}

export const monthOfDay = (day: number): Month => {
  const text = dayText(day);
  return monthOf(Number(text.slice(0, 4)), Number(text.slice(5, 7)));
};

const daysIn = (m: Month): number => utcDate(monthYear(m), monthNumber(m) + 1, 0).getUTCDate();

export const monthFirstDay = (m: Month): number => dayNumber(`${monthText(m)}-01`) ?? 0;
export const monthLastDay = (m: Month): number => monthFirstDay(m) + daysIn(m) - 1;
/** A day of the month, clamping a day past its end to the last. */
export const monthDay = (m: Month, day: number): number =>
  monthFirstDay(m) + Math.min(Math.max(day, 1), daysIn(m)) - 1;
