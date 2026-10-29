import {
  addDays,
  dayFromText,
  dayText,
  monthEntry,
  weekdayIndex,
  WEEKDAY_ABBREVIATIONS,
  type CalendarDay,
  type CalendarMonth,
} from './calendar-dates';
import { readDateValue, type Item } from './container-model';
import { dayFor, readTimestampValue } from './timestamps';

/**
 * Today, in the reader's own zone.
 *
 * The one place a clock is read, and the one place local time is the right question: "today" is
 * where the person is sitting, not where the server is. The result is immediately turned into month
 * numbers and `yyyy-MM-dd` text, so nothing downstream handles an instant.
 */
export function today(): { readonly month: CalendarMonth; readonly text: string } {
  const now = new Date();
  const month = { year: now.getFullYear(), month: now.getMonth() };
  return { month, text: dayText({ ...month, day: now.getDate() }) };
}

/** Today as a whole day, which is what week and day modes anchor on. */
export function todayDay(): CalendarDay {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };
}

/** The three grains, with anything unrecognised falling back to the one every view had. */
export function readMode(value: string | null): 'month' | 'week' | 'day' {
  return value === 'week' || value === 'day' ? value : 'month';
}

/** A month, abbreviated to three letters, in the order `MONTH_NAMES` names them. */
const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * A `yyyy-MM-dd` date, said the way the rest of the calendar says a day when the sentence has room
 * for one but not for `dayLabel`'s full spelling: a weekday and a month abbreviated, as
 * `month-grid.tsx`'s header row and `timeline-scale.ts`'s own compact column already abbreviate
 * theirs. The agenda used to print the stored text verbatim - "2026-09-24" - which is the one date
 * shape nobody reading a calendar actually thinks in.
 *
 * Falls back to the raw text on a date this cannot parse, which should not happen for a key already
 * used to bucket the agenda, but a heading that could throw is worse than one that is occasionally
 * literal.
 */
export function agendaDayLabel(date: string): string {
  const day = dayFromText(date);
  if (day === null) {
    return date;
  }

  const weekday = monthEntry(WEEKDAY_ABBREVIATIONS, weekdayIndex(day.year, day.month, day.day));
  return `${weekday} ${String(day.day)} ${monthEntry(MONTH_ABBREVIATIONS, day.month)}`;
}

/**
 * The day an item sits on for this reader, whichever shape its date property carries.
 *
 * A `date` is already a day. A `timestamp` is a moment, and which day that falls on depends on who
 * is looking, so it is converted to the reader's zone first - exactly as the hour grid does when it
 * decides which column an item belongs in.
 *
 * **Reading only the plain-date shape here is what used to send every timestamped item to
 * "unscheduled".** That was invisible while nothing could write a time from the interface; the
 * moment an hour slot accepted a drop it became visible immediately, as a card that appeared in the
 * slot it was dropped on and stayed in the unscheduled list underneath.
 */
export function readDayValue(item: Item, key: string, zone: string): string | null {
  const plain = readDateValue(item, key);
  if (plain !== null) {
    return plain;
  }

  const moment = readTimestampValue(item.properties, key);
  return moment === null ? null : dayFor(moment, zone);
}

/**
 * The safety valve on a span the interface can only ever have written a sane length: a bound
 * nobody scheduling a real item would reach, so a malformed value cannot turn one item into a
 * year of buckets that cost memory and mean nothing.
 */
const MAX_SPAN_DAYS = 366;

/**
 * Every `yyyy-MM-dd` day from `start` to `end`, inclusive.
 *
 * Called only once `end` is already known to be after `start` - see the loop that builds
 * `byDate`. Falls back to the single start day on a date this cannot parse, which should not
 * happen for text `readDayValue` already produced, but a month grid that could throw on bad data
 * is worse than one that occasionally under-covers a span.
 */
export function spanDates(start: string, end: string): readonly string[] {
  const first = dayFromText(start);
  if (first === null) {
    return [start];
  }

  const dates: string[] = [];
  let cursor = first;
  for (let count = 0; count < MAX_SPAN_DAYS; count += 1) {
    const text = dayText(cursor);
    dates.push(text);
    if (text === end) {
      break;
    }
    cursor = addDays(cursor, 1);
  }

  return dates;
}

/**
 * A proleptic-Gregorian day number, counted the way `addDays` counts - as integers, never through
 * a `Date`. This is the one piece of arithmetic that module's helpers do not offer: a distance
 * between two days, rather than a day moved by one. `month` here is 1-12, matching the stored text
 * `dayFromText` already parsed it from, not the 0-11 `CalendarDay` carries.
 *
 * The formula is Howard Hinnant's `days_from_civil`: pure integer arithmetic, correct across every
 * month and year boundary the calendar can reach, and exactly the kind of "no wall clock, no
 * timezone" fact this file's own dates already are.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const monthIndex = (month + 9) % 12;
  const dayOfYear = Math.floor((153 * monthIndex + 2) / 5) + day - 1;
  const dayOfEra = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** The number of days from `from` to `to`, negative when `to` is the earlier date. Null on text that isn't a whole calendar day. */
export function daysBetween(from: string, to: string): number | null {
  const start = dayFromText(from);
  const end = dayFromText(to);
  if (start === null || end === null) {
    return null;
  }

  return (
    daysFromCivil(end.year, end.month + 1, end.day) -
    daysFromCivil(start.year, start.month + 1, start.day)
  );
}

/** `value`, moved by `delta` days - the text form `spanDates` and every drop already deal in. */
export function shiftDateText(value: string, delta: number): string | null {
  const day = dayFromText(value);
  return day === null ? null : dayText(addDays(day, delta));
}
