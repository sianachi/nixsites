import { type Day, dateOf, dayOf, daysInMonth, isoWeekday, monthOf, yearOf } from './days';
import { type RecurrenceRule, isCompleted } from './rule';

const monthIndex = (day: Day): number => yearOf(day) * 12 + monthOf(day) - 1;

/** Anchor plus whole months, the day clamped to the target month's length. */
function clampedAddMonths(anchor: Day, months: number): Day {
  const total = monthIndex(anchor) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return dayOf(year, month, Math.min(dateOf(anchor), daysInMonth(year, month)));
}

function advance(rule: RecurrenceRule, anchor: Day, index: number): Day {
  switch (rule.frequency) {
    case 'daily':
      return anchor + index * rule.interval;
    case 'weekly':
      return anchor + index * rule.interval * 7;
    case 'monthly':
      return clampedAddMonths(anchor, index * rule.interval);
    case 'yearly':
      return clampedAddMonths(anchor, index * rule.interval * 12);
  }
}

function firstIndexAtOrAfter(rule: RecurrenceRule, anchor: Day, from: Day): number {
  if (from <= anchor) return 0;
  const estimate = Math.trunc(
    rule.frequency === 'daily'
      ? (from - anchor) / rule.interval
      : rule.frequency === 'weekly'
        ? (from - anchor) / (7 * rule.interval)
        : rule.frequency === 'monthly'
          ? (monthIndex(from) - monthIndex(anchor)) / rule.interval
          : (yearOf(from) - yearOf(anchor)) / rule.interval,
  );
  // The estimate can land a step early; walk forward rather than trust the arithmetic.
  let index = Math.max(0, estimate);
  while (advance(rule, anchor, index) < from) index++;
  return index;
}

function* stepped(rule: RecurrenceRule, anchor: Day, from: Day, last: Day): Generator<Day> {
  for (let index = firstIndexAtOrAfter(rule, anchor, from); ; index++) {
    const day = advance(rule, anchor, index);
    if (day > last) return;
    if (day >= from) yield day;
  }
}

const startOfWeek = (day: Day): Day => day + 1 - isoWeekday(day);

function* weeklyOnWeekdays(
  rule: RecurrenceRule,
  anchor: Day,
  from: Day,
  last: Day,
): Generator<Day> {
  // Weeks count from the anchor's own Monday-started week.
  const anchorWeek = startOfWeek(anchor);
  const weeksApart = Math.trunc((startOfWeek(from < anchor ? anchor : from) - anchorWeek) / 7);
  let week = anchorWeek + (weeksApart - (weeksApart % rule.interval)) * 7;
  for (; week <= last; week += 7 * rule.interval)
    for (const weekday of rule.weekdays) {
      const day = week + weekday - 1;
      if (day < anchor || day < from) continue;
      if (day > last) return;
      yield day;
    }
}

/** RecurrenceExpansion.Occurrences: the days a series lands on inside [from, to]. */
export function occurrences(
  rule: RecurrenceRule,
  anchor: Day,
  from: Day,
  to: Day,
): IterableIterator<Day> {
  const last = rule.until !== null && rule.until < to ? rule.until : to;
  if (last < anchor || last < from) return [].values();
  return rule.frequency === 'weekly' && rule.weekdays.length > 0
    ? weeklyOnWeekdays(rule, anchor, from, last)
    : stepped(rule, anchor, from, last);
}

export interface Series<T> {
  readonly owner: T;
  readonly rule: RecurrenceRule;
  readonly anchor: Day;
}

export interface Occurrence<T> {
  readonly owner: T;
  readonly day: Day;
  readonly completed: boolean;
}

/**
 * RecurrenceMerge.Expand: the earliest day across all series first (ties to the earlier series),
 * stopping at the ceiling. Truncated when something was still pending at the stop.
 */
export function mergeOccurrences<T>(
  series: readonly Series<T>[],
  from: Day,
  to: Day,
  ceiling: number,
): { readonly occurrences: Occurrence<T>[]; readonly truncated: boolean } {
  const streams: { entry: Series<T>; days: Iterator<Day>; current: Day }[] = [];
  for (const entry of series) {
    const days = occurrences(entry.rule, entry.anchor, from, to);
    const first = days.next();
    if (first.done !== true) streams.push({ entry, days, current: first.value });
  }

  const merged: Occurrence<T>[] = [];
  while (streams.length > 0) {
    if (merged.length === ceiling) return { occurrences: merged, truncated: true };
    let next = 0;
    for (let index = 1; index < streams.length; index++)
      if ((streams[index]?.current ?? 0) < (streams[next]?.current ?? 0)) next = index;
    const stream = streams[next];
    if (stream === undefined) break;
    merged.push({
      owner: stream.entry.owner,
      day: stream.current,
      completed: isCompleted(stream.entry.rule, stream.current),
    });
    const after = stream.days.next();
    if (after.done === true) streams.splice(next, 1);
    else stream.current = after.value;
  }
  return { occurrences: merged, truncated: false };
}
