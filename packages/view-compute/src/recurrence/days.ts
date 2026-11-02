/** A calendar day as whole days since 1970-01-01. Dates carry no zone, so DST never enters. */
export type Day = number;

const MS = 86_400_000;

export function dayOf(year: number, month: number, date: number): Day {
  const moment = new Date(0);
  moment.setUTCFullYear(year, month - 1, date);
  return Math.round(moment.getTime() / MS);
}

export function daysInMonth(year: number, month: number): number {
  return (
    dayOf(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1) - dayOf(year, month, 1)
  );
}

/** Core's strict `yyyy-MM-dd` parse (DateOnly.TryParseExact): null for anything else. */
export function parseDay(text: unknown): Day | null {
  if (typeof text !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])] as [
    number,
    number,
    number,
  ];
  if (year < 1 || month < 1 || month > 12 || date < 1 || date > daysInMonth(year, month))
    return null;
  return dayOf(year, month, date);
}

export function formatDay(day: Day): string {
  return new Date(day * MS).toISOString().slice(0, 10);
}

export const yearOf = (day: Day): number => new Date(day * MS).getUTCFullYear();
export const monthOf = (day: Day): number => new Date(day * MS).getUTCMonth() + 1;
export const dateOf = (day: Day): number => new Date(day * MS).getUTCDate();
/** ISO weekday, Monday 1 to Sunday 7. */
export const isoWeekday = (day: Day): number => new Date(day * MS).getUTCDay() || 7;
