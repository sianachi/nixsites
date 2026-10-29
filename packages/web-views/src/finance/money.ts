/**
 * Formatting for money and months, in the reader's locale.
 *
 * Nothing here does arithmetic. Every figure arrives from Core already summed and rounded, and the
 * one job of the browser is to print it; a sum done here would be the second owner of a number
 * that must have one.
 */

const MONTH = /^(\d{4})-(\d{2})$/;

export function formatMoney(
  amount: number,
  currency: string,
  options: { signed?: boolean } = {},
): string {
  const formatter = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    ...(options.signed ? { signDisplay: 'exceptZero' as const } : {}),
  });
  return formatter.format(amount);
}

/** A whole-pound reading for tiles and headings, where pennies are noise. */
export function formatMoneyRound(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatPercent(fraction: number): string {
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format(
    fraction,
  );
}

/** `2026-09` as `Sep 2026`, or the text itself when it is not a month. */
export function formatMonth(month: string, style: 'short' | 'long' = 'short'): string {
  const match = MONTH.exec(month);
  if (match === null) return month;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return new Intl.DateTimeFormat(undefined, {
    month: style,
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
}

export function shiftMonth(month: string, offset: number): string {
  const match = MONTH.exec(month);
  if (match === null) return month;
  const index = Number(match[1]) * 12 + Number(match[2]) - 1 + offset;
  const year = Math.floor(index / 12);
  const number = (index % 12) + 1;
  return `${String(year).padStart(4, '0')}-${String(number).padStart(2, '0')}`;
}

export function compareMonths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The month a day belongs to. */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** Today as `yyyy-MM-dd` in a timezone, the same idiom the habit tracker uses. */
export function todayIn(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Reads a typed amount without silently turning malformed input into a different amount. */
export function parseAmount(text: string): number | null {
  const trimmed = text.trim();
  const match = /^(?:£\s*)?(-?)(?:(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|\.(\d{1,2}))$/.exec(
    trimmed,
  );
  if (match === null) return null;
  const value = Number(
    `${match[1] ?? ''}${(match[2] ?? '0').replaceAll(',', '')}.${match[3] ?? match[4] ?? '0'}`,
  );
  if (!Number.isFinite(value)) return null;
  return value;
}
