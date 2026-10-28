import { defineFunction } from '@openuidev/react-lang';
import { z } from 'zod';

import {
  formatCalendarDay,
  formatShortDate,
  localTimeZone,
} from '@nix/web-foundation/lib/date-format';

/**
 * Date functions a program may call as `@Name(...)`. Days are `yyyy-MM-dd` strings, the form
 * Nix stores and `read_calendar` returns, and are handled in UTC so a day never shifts with the
 * reader's timezone; only `@Today` reads the clock, in the reader's own zone. A bad argument
 * makes a call evaluate to null (the library's rule), never throw.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function instant(day: string): Date {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day)
    throw new Error(`${day} is not a yyyy-MM-dd day.`);
  return date;
}

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: 'UTC' });
const long = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeZone: 'UTC' });

export const NIX_FUNCTIONS = [
  defineFunction({
    name: 'Today',
    description: "Today's date in the owner's time zone, as yyyy-MM-dd.",
    params: z.object({}),
    returns: z.string(),
    fn: () => formatShortDate(new Date(), localTimeZone()),
  }),
  defineFunction({
    name: 'AddDays',
    description: 'The yyyy-MM-dd day n days after day (n may be negative).',
    params: z.object({ day: z.string(), n: z.number() }),
    returns: z.string(),
    fn: ({ day, n }) =>
      new Date(instant(day).getTime() + Math.trunc(n) * DAY_MS).toISOString().slice(0, 10),
  }),
  defineFunction({
    name: 'DaysBetween',
    description: 'Whole days from one yyyy-MM-dd day to another; negative when to is earlier.',
    params: z.object({ from: z.string(), to: z.string() }),
    returns: z.number(),
    fn: ({ from, to }) => Math.round((instant(to).getTime() - instant(from).getTime()) / DAY_MS),
  }),
  defineFunction({
    name: 'FormatDate',
    description: 'A yyyy-MM-dd day for reading: "short" (Sep 1, 2026), "long" or "weekday".',
    params: z.object({ day: z.string(), style: z.enum(['short', 'long', 'weekday']).optional() }),
    returns: z.string(),
    fn: ({ day, style }) => {
      const date = instant(day);
      if (style === 'long') return long.format(date);
      if (style === 'weekday') return weekday.format(date);
      return formatCalendarDay(day) ?? day;
    },
  }),
];
