/** Period arithmetic, ported from Core's DatePeriods. A date is a day number (days since 1970-01-01). */

export type Period = 'day' | 'week' | 'month' | 'quarter' | 'year';
export const PERIODS: readonly string[] = ['day', 'week', 'month', 'quarter', 'year'];

const DAY_MS = 86_400_000;

export function dayNumber(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return Math.round(date.getTime() / DAY_MS);
}

export const EARLIEST = dayNumber(2, 1, 1);
export const LATEST = dayNumber(9998, 12, 31);

function parts(day: number): { year: number; month: number; date: number; weekday: number } {
  const date = new Date(day * DAY_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    date: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
}

export function format(day: number): string {
  const { year, month, date } = parts(day);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${two(month)}-${two(date)}`;
}

/** Core's TryReadDate: a leading yyyy-MM-dd that is a real date inside the supported range. */
export function readDate(text: string | null): number | null {
  if (text === null || text.length < 10) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (match === null) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const day = dayNumber(year, month, date);
  const back = parts(day);
  if (back.year !== year || back.month !== month || back.date !== date) return null;
  return day >= EARLIEST && day <= LATEST ? day : null;
}

export function start(day: number, period: Period): number {
  const { year, month, weekday } = parts(day);
  switch (period) {
    case 'day':
      return day;
    case 'week':
      return day - ((weekday + 6) % 7);
    case 'month':
      return dayNumber(year, month, 1);
    case 'quarter':
      return dayNumber(year, Math.floor((month - 1) / 3) * 3 + 1, 1);
    case 'year':
      return dayNumber(year, 1, 1);
  }
}

/** Steps a period start by whole periods (starts are the 1st for month and up, so no clamping). */
export function add(from: number, period: Period, steps: number): number {
  const { year, month } = parts(from);
  switch (period) {
    case 'day':
      return from + steps;
    case 'week':
      return from + 7 * steps;
    case 'month':
      return dayNumber(year, month + steps, 1);
    case 'quarter':
      return dayNumber(year, month + 3 * steps, 1);
    case 'year':
      return dayNumber(year + steps, 1, 1);
  }
}

export const end = (from: number, period: Period): number => add(from, period, 1) - 1;

export function between(first: number, last: number, period: Period): number {
  const a = parts(first);
  const b = parts(last);
  const months = (b.year - a.year) * 12 + (b.month - a.month);
  switch (period) {
    case 'day':
      return last - first;
    case 'week':
      return Math.trunc((last - first) / 7);
    case 'month':
      return months;
    case 'quarter':
      return Math.trunc(months / 3);
    case 'year':
      return b.year - a.year;
  }
}

export interface PeriodRange {
  readonly first: number;
  readonly last: number;
  readonly period: Period;
}

export const size = (range: PeriodRange): number =>
  between(range.first, range.last, range.period) + 1;

export function lastPeriods(today: number, period: Period, n: number): PeriodRange {
  const last = start(today, period);
  return { first: add(last, period, -(n - 1)), last, period };
}

export function keepLatest(range: PeriodRange, maximum: number): PeriodRange {
  return size(range) <= maximum
    ? range
    : { ...range, first: add(range.last, range.period, -(maximum - 1)) };
}

export function* enumerate(range: PeriodRange): Generator<number> {
  for (let day = range.first; day <= range.last; day = add(day, range.period, 1)) yield day;
}
