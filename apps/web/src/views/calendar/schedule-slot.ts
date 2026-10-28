import { DateTime } from 'luxon';

import { nextFreeSlot, type Span } from '@nix/web-foundation/lib/suggest/free-slot';
import type { Item } from '../core/container-model';
import { readTimestampValue } from '../core/timestamps';

/**
 * The next free slot on a calendar for one item, from the items the calendar has already loaded.
 *
 * The calendar-shaped half of `lib/suggest/free-slot.ts`: this file decides what counts as busy,
 * how long the item takes, and which hours are working hours, in the reader's zone; the library
 * does the interval arithmetic.
 *
 * **Busy is what this view has loaded and placed by time.** Siblings with a moment on the view's
 * date property, each lasting until its end property when it has one and {@link DEFAULT_DURATION_MINUTES}
 * when it does not. All-day items do not block an hour - they are drawn above the grid, not in it -
 * and nothing outside this container is consulted: the calendar shows this container, so the
 * suggestion is about this container. A person's other calendars are not something this view can
 * see, and the sentence offering the slot says "free here" for that reason.
 *
 * **Working hours are a fixed default** - {@link WORK_START_HOUR}:00 to {@link WORK_END_HOUR}:00,
 * Monday to Friday, in the reader's zone - because no preference for them exists yet. The search
 * looks {@link SEARCH_DAYS} days ahead from the next half hour and gives up after that rather than
 * proposing something weeks away.
 */

const WORK_START_HOUR = 9;
const WORK_END_HOUR = 17;
const SEARCH_DAYS = 14;
const DEFAULT_DURATION_MINUTES = 60;

/** The longest duration taken from an item's own span; past a working day it is not a slot. */
const MAXIMUM_DURATION_MINUTES = (WORK_END_HOUR - WORK_START_HOUR) * 60;

const MINUTE = 60 * 1000;

function spanOf(item: Item, dateProperty: string, endDateProperty: string | null): Span | null {
  const start = readTimestampValue(item.properties, dateProperty);
  if (start === null) {
    return null;
  }
  const end =
    endDateProperty === null ? null : readTimestampValue(item.properties, endDateProperty);
  const startMs = start.at.toMillis();
  const endMs = end === null ? startMs + DEFAULT_DURATION_MINUTES * MINUTE : end.at.toMillis();
  return { start: startMs, end: Math.max(endMs, startMs) };
}

/** How long the item takes: its own span when it has a sensible one, else the default hour. */
export function durationOf(
  item: Item,
  dateProperty: string,
  endDateProperty: string | null,
): number {
  const own = spanOf(item, dateProperty, endDateProperty);
  const minutes = own === null ? 0 : (own.end - own.start) / MINUTE;
  return minutes > 0 && minutes <= MAXIMUM_DURATION_MINUTES
    ? minutes * MINUTE
    : DEFAULT_DURATION_MINUTES * MINUTE;
}

/** The working-hour windows from `now` for {@link SEARCH_DAYS} days, in `zone`. */
export function workingWindows(now: number, zone: string): readonly Span[] {
  const windows: Span[] = [];
  const today = DateTime.fromMillis(now, { zone }).startOf('day');
  for (let offset = 0; offset < SEARCH_DAYS; offset += 1) {
    const day = today.plus({ days: offset });
    // Luxon's weekday: 1 is Monday, 7 is Sunday.
    if (day.weekday > 5) {
      continue;
    }
    windows.push({
      start: day.set({ hour: WORK_START_HOUR }).toMillis(),
      end: day.set({ hour: WORK_END_HOUR }).toMillis(),
    });
  }
  return windows;
}

/** The next half hour at or after `now`, so a suggestion never starts at 10:07. */
export function nextHalfHour(now: number, zone: string): number {
  const at = DateTime.fromMillis(now, { zone }).startOf('minute');
  const minutes = at.minute <= 30 ? 30 : 60;
  return at.minute === 0 || at.minute === 30
    ? at.toMillis()
    : at.startOf('hour').plus({ minutes }).toMillis();
}

/** A slot, as the reschedule dialog's `datetime-local` fields take it, and as a sentence reads it. */
export interface SuggestedSlot {
  readonly start: string;
  readonly end: string;
  readonly label: string;
}

/**
 * The next free slot for `item` among `siblings`, or null when none fits in the search window.
 *
 * The item itself never counts as busy - rescheduling it frees the time it occupies now.
 */
export function suggestSlot(
  item: Item,
  siblings: readonly Item[],
  dateProperty: string,
  endDateProperty: string | null,
  now: number,
  zone: string,
): SuggestedSlot | null {
  const busy = siblings
    .filter((sibling) => sibling.id !== item.id)
    .flatMap((sibling) => {
      const span = spanOf(sibling, dateProperty, endDateProperty);
      return span === null ? [] : [span];
    });
  const slot = nextFreeSlot(
    workingWindows(now, zone),
    busy,
    durationOf(item, dateProperty, endDateProperty),
    nextHalfHour(now, zone),
  );
  if (slot === null) {
    return null;
  }
  const start = DateTime.fromMillis(slot.start, { zone });
  const end = DateTime.fromMillis(slot.end, { zone });
  return {
    start: start.toFormat("yyyy-MM-dd'T'HH:mm"),
    end: end.toFormat("yyyy-MM-dd'T'HH:mm"),
    label: `${start.toFormat('ccc d LLL, HH:mm')} to ${end.toFormat('HH:mm')}`,
  };
}
