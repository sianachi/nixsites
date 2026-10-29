/**
 * Calendar arithmetic, as integers.
 *
 * **No `Date` is ever constructed from a stored value here, and none ever should be.**
 * `new Date('2026-03-01')` is UTC midnight, which is the 28th of February for every reader west of
 * Greenwich - so a grid built by parsing its own date strings is a grid that is off by one for half
 * the world, and correct on the machine of whoever wrote it. The whole module works on
 * `{ year, month, day }` triples and `yyyy-MM-dd` text.
 *
 * A **date** never leaves this arithmetic. A **timestamp** is a different thing and is converted
 * elsewhere, in `timestamps.ts`, because it genuinely is a moment and genuinely must move with the
 * reader. Keeping the two in separate files is what stops one rule being applied to the other.
 *
 * Extracted from `calendar-view.tsx`, which could only move whole months. Day and week need to
 * cross a month boundary and a year boundary, and needed arithmetic that did not exist.
 */

/** A month on a calendar. Never a `Date`; `month` is 0-11, as everywhere else in this file. */
export interface CalendarMonth {
  readonly year: number;
  readonly month: number;
}

/** A day on a calendar. */
export interface CalendarDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export const WEEKDAY_ABBREVIATIONS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Sakamoto's table, which turns a date into a weekday with integers and no calendar object. */
const SAKAMOTO_OFFSETS = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4] as const;

/**
 * Reads an entry a month index is known to be in range for.
 *
 * A month outside 0-11 is a bug in the arithmetic rather than bad input, so it throws instead of
 * falling back: a silent wrong answer here is a calendar that is quietly off by a month.
 */
export function monthEntry<T>(table: readonly T[], month: number): T {
  const entry = table[month];
  if (entry === undefined) {
    throw new RangeError(`Month index out of range: ${String(month)}`);
  }

  return entry;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(value: CalendarMonth): number {
  return value.month === 1 && isLeapYear(value.year) ? 29 : monthEntry(MONTH_LENGTHS, value.month);
}

/** The weekday of a date, 0 = Monday, by pure integer arithmetic. */
export function weekdayIndex(year: number, month: number, day: number): number {
  const shifted = month < 2 ? year - 1 : year;
  const sundayFirst =
    (shifted +
      Math.floor(shifted / 4) -
      Math.floor(shifted / 100) +
      Math.floor(shifted / 400) +
      monthEntry(SAKAMOTO_OFFSETS, month) +
      day) %
    7;

  return (sundayFirst + 6) % 7;
}

function pad(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
}

/** The `yyyy-MM-dd` text of a day. The only date representation a grid compares against. */
export function dayText(value: CalendarDay): string {
  return `${String(value.year)}-${pad(value.month + 1)}-${pad(value.day)}`;
}

/**
 * The inverse of {@link dayText}: a stored `yyyy-MM-dd` back as a day.
 *
 * Here rather than at a caller because this module owns the mapping between the text and the
 * triple, and a second parse somewhere else is a second place for the month's off-by-one to live -
 * the stored month is 1-12 and everything in this file is 0-11.
 *
 * **Still no `Date`.** This is three integer reads, which is the whole point: `new Date(text)` is
 * UTC midnight and would hand back the previous day for every reader west of Greenwich.
 *
 * Null for anything that is not a complete date, so a property holding "next Tuesday" cannot be
 * spoken as though it were one.
 */
export function dayFromText(text: string): CalendarDay | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (parts === null) {
    return null;
  }

  const [, year, month, day] = parts;
  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }

  const value = { year: Number(year), month: Number(month) - 1, day: Number(day) };

  // A well-formed string can still name a day that does not exist - "2026-02-31" and "2026-13-01"
  // both match the shape. Rejecting them here is what keeps `monthEntry` from throwing several
  // frames away, where the message would be about a table index rather than about a stored value.
  return value.month >= 0 && value.month <= 11 && value.day >= 1 && value.day <= daysInMonth(value)
    ? value
    : null;
}

/** The `yyyy-MM-` prefix of a month, for telling apart the dates a month grid can show. */
export function monthPrefix(value: CalendarMonth): string {
  return `${String(value.year)}-${pad(value.month + 1)}-`;
}

export function monthLabel(value: CalendarMonth): string {
  return `${monthEntry(MONTH_NAMES, value.month)} ${String(value.year)}`;
}

export function shiftMonth(value: CalendarMonth, delta: number): CalendarMonth {
  const absolute = value.year * 12 + value.month + delta;
  return { year: Math.floor(absolute / 12), month: ((absolute % 12) + 12) % 12 };
}

/**
 * Moves a day by a number of days, across month and year boundaries.
 *
 * The primitive week and day modes are built from, and the one the month-only view never needed.
 * Written as a loop over month lengths rather than by converting to a day number and back, because
 * the conversion is where a leap year gets forgotten - and this way `daysInMonth` is the single
 * place that knows about February.
 */
export function addDays(value: CalendarDay, delta: number): CalendarDay {
  let { year, month, day } = value;
  let remaining = delta;

  while (remaining > 0) {
    const length = daysInMonth({ year, month });
    if (day + remaining <= length) {
      day += remaining;
      remaining = 0;
      break;
    }

    remaining -= length - day + 1;
    day = 1;
    ({ year, month } = shiftMonth({ year, month }, 1));
  }

  while (remaining < 0) {
    if (day + remaining >= 1) {
      day += remaining;
      remaining = 0;
      break;
    }

    remaining += day;
    ({ year, month } = shiftMonth({ year, month }, -1));
    day = daysInMonth({ year, month });
  }

  return { year, month, day };
}

/** The Monday of the week a day falls in. Weeks start on Monday throughout. */
export function startOfWeek(value: CalendarDay): CalendarDay {
  return addDays(value, -weekdayIndex(value.year, value.month, value.day));
}

/** The seven days of the week a day falls in, Monday first. */
export function weekOf(value: CalendarDay): readonly CalendarDay[] {
  const monday = startOfWeek(value);
  return Array.from({ length: 7 }, (_, offset) => addDays(monday, offset));
}

/**
 * How a week reads as a heading.
 *
 * Names both months when the week straddles one and both years when it straddles that, because a
 * week labelled only by its Monday is a week whose other end is a guess.
 */
export function weekLabel(value: CalendarDay): string {
  const monday = startOfWeek(value);
  const sunday = addDays(monday, 6);

  if (monday.year !== sunday.year) {
    return `${String(monday.day)} ${monthEntry(MONTH_NAMES, monday.month)} ${String(monday.year)} to ${String(sunday.day)} ${monthEntry(MONTH_NAMES, sunday.month)} ${String(sunday.year)}`;
  }

  if (monday.month !== sunday.month) {
    return `${String(monday.day)} ${monthEntry(MONTH_NAMES, monday.month)} to ${String(sunday.day)} ${monthEntry(MONTH_NAMES, sunday.month)} ${String(monday.year)}`;
  }

  return `${String(monday.day)} to ${String(sunday.day)} ${monthEntry(MONTH_NAMES, monday.month)} ${String(monday.year)}`;
}

/** How a single day reads as a heading. */
export function dayLabel(value: CalendarDay): string {
  const weekday = monthEntry(WEEKDAY_NAMES, weekdayIndex(value.year, value.month, value.day));
  return `${weekday} ${String(value.day)} ${monthEntry(MONTH_NAMES, value.month)} ${String(value.year)}`;
}

/**
 * Whether a `yyyy-MM-dd` falls inside a range, both ends included.
 *
 * A text comparison, which works because the format sorts the way the dates do. The month grid asks
 * a prefix question instead; a week that straddles two months has no single prefix to ask about,
 * which is why this exists.
 */
export function withinRange(date: string, from: CalendarDay, to: CalendarDay): boolean {
  return date >= dayText(from) && date <= dayText(to);
}
