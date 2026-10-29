import type { Item } from '../../../collections/core/container-model';
import { readDayValue, spanDates } from '../../../collections/core/day-math';

/**
 * Sorts a container's items into the day buckets the grid and agenda draw, the ones with no date,
 * and how many are dated only outside the month in `prefix` (`yyyy-MM`).
 */
export function bucketItems(
  items: readonly Item[],
  dateProperty: string,
  endDateProperty: string | null,
  zone: string,
  prefix: string,
): {
  readonly byDate: Map<string, Item[]>;
  readonly unscheduled: Item[];
  readonly elsewhere: number;
} {
  const byDate = new Map<string, Item[]>();
  const unscheduled: Item[] = [];

  for (const item of items) {
    const value = readDayValue(item, dateProperty, zone);

    if (value === null) {
      // Never dropped. An item with no date is an item somebody has not scheduled yet, and a
      // calendar that silently omits it is a calendar that loses half a folder without saying so.
      unscheduled.push(item);
      continue;
    }

    // An item with an end that lands after its start covers every day in between, and this grid
    // shows it on each of them - the same "where an item sits is its date" rule extended across a
    // range rather than a single answer. An end on or before the start (no end configured, none
    // set on this item, or one that lands before its start - the reversed span timeline-view.tsx
    // also refuses to draw) collapses to the single-day case every calendar has always had.
    const end = endDateProperty === null ? null : readDayValue(item, endDateProperty, zone);
    const dates = end === null || end <= value ? [value] : spanDates(value, end);

    for (const date of dates) {
      const existing = byDate.get(date);
      if (existing === undefined) {
        byDate.set(date, [item]);
      } else {
        existing.push(item);
      }
    }
  }

  // Counted by item, not by bucket: a multi-day item now occupies one bucket per day it covers,
  // and a bucket outside this month it also reaches on some other day is not an item that has
  // gone missing from the calendar - it is right there, drawn on the day that is in view.
  const inMonth = new Set<string>();
  const outsideMonth = new Set<string>();
  for (const [date, dated] of byDate) {
    for (const dayItem of dated) {
      (date.startsWith(prefix) ? inMonth : outsideMonth).add(dayItem.id);
    }
  }
  let elsewhere = 0;
  for (const id of outsideMonth) {
    if (!inMonth.has(id)) {
      elsewhere += 1;
    }
  }

  return { byDate, unscheduled, elsewhere };
}
