import { DateTime } from 'luxon';

import {
  dayLabel,
  dayText,
  weekLabel,
  type CalendarDay,
} from '../../../collections/core/calendar-dates';
import type { Item } from '../../../collections/core/container-model';
import {
  formatTime,
  minutesFor,
  readTimestampValue,
  writeTimestampValue,
} from '../../../collections/core/timestamps';
import { MINUTES_PER_DAY, MIN_SPAN_MINUTES, type Placed } from './geometry';

/** The moment a minute of a day stands for, on the reader's clock. Midnight rolls to the next day. */
export function momentAt(day: CalendarDay, minutes: number, zone: string): DateTime {
  const midnight = DateTime.fromISO(`${dayText(day)}T00:00`, { zone });
  return minutes >= MINUTES_PER_DAY
    ? midnight.plus({ days: 1 })
    : midnight.set({ hour: Math.floor(minutes / 60), minute: minutes % 60 });
}

/** A moment as the stored value it is written as, in the reader's own zone. */
export function writeMoment(moment: DateTime, zone: string): string | null {
  return writeTimestampValue(moment.setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm"), zone);
}

/** What the clock reads at a minute of the day, for the label on a dragged item. */
export function clockAt(minutes: number): string {
  return DateTime.fromObject({
    hour: Math.floor(minutes / 60) % 24,
    minute: minutes % 60,
  }).toLocaleString(DateTime.TIME_SIMPLE);
}

/**
 * Whether the reader may drag this item. An event its calendar refuses edits to is drawn like any
 * other but stays where its source put it; Core would refuse the write, and offering the gesture
 * only to undo it would be a lie told with the pointer.
 */
export function isAdjustable(item: Item): boolean {
  return !(item.managedBy === 'calendar_event' && item.properties.$cal_readonly === true);
}

/**
 * How the scroll region names itself to a screen reader: the week it spans, or the single day, the
 * same distinction `weekLabel`/`dayLabel` already draw for the heading above this grid.
 *
 * Falls back to a bare "Calendar" rather than throwing on an empty `days` - callers only ever pass
 * one day or seven, but a prop typed as an array can still arrive empty, and a label is not worth a
 * crash.
 */
export function regionLabel(days: readonly CalendarDay[]): string {
  const first = days[0];
  if (first === undefined) {
    return 'Calendar';
  }

  return days.length === 1 ? dayLabel(first) : weekLabel(first);
}

/**
 * The items that fall on a day, in the reader's zone, with the minute each sits at.
 *
 * Converted before it is compared, which is the whole difference between this and the month grid.
 */
export function placeOn(
  day: CalendarDay,
  items: readonly Item[],
  dateProperty: string,
  endDateProperty: string | null,
  zone: string,
): readonly Placed[] {
  const wanted = dayText(day);

  return items
    .flatMap((item) => {
      const value = readTimestampValue(item.properties, dateProperty);
      if (value === null) {
        return [];
      }

      const local = value.at.setZone(zone);
      if (local.toFormat('yyyy-MM-dd') !== wanted) {
        return [];
      }

      const minutes = minutesFor(value, zone);

      return [
        {
          item,
          minutes,
          at: formatTime(value, zone),
          zone: value.zone,
          durationMinutes: spanMinutes(item, endDateProperty, wanted, minutes, zone),
        },
      ];
    })
    .sort((left, right) => left.minutes - right.minutes);
}

/**
 * How long a placed item's span reaches into this day, or null for a point.
 *
 * See `Placed.durationMinutes` for the three cases that all collapse to null and the clamp that
 * keeps an overnight item's bar from running into a column that is not this one.
 */
function spanMinutes(
  item: Item,
  endDateProperty: string | null,
  startDay: string,
  startMinutes: number,
  zone: string,
): number | null {
  if (endDateProperty === null) {
    return null;
  }

  const end = readTimestampValue(item.properties, endDateProperty);
  if (end === null) {
    return null;
  }

  const endLocal = end.at.setZone(zone);
  const endDay = endLocal.toFormat('yyyy-MM-dd');

  if (endDay === startDay) {
    const duration = endLocal.hour * 60 + endLocal.minute - startMinutes;
    return duration > 0 ? duration : null;
  }

  // `yyyy-MM-dd` text sorts the same lexically as it does by calendar day - the same fact
  // reschedule-dialog.tsx's own end check leans on for a bare date. An end on an earlier day is
  // the reversed case above and draws as a point; an end on a later day runs off the bottom of
  // this one column, clamped to midnight.
  return endDay > startDay ? MINUTES_PER_DAY - startMinutes : null;
}

/**
 * Where each placed item sits sideways, so two items whose spans overlap in time sit side by side
 * rather than one painting over the other.
 *
 * A greedy sweep over intervals sorted by start: an item takes the lowest lane whose last
 * occupant has already ended, or opens a new one. Lanes are scoped to a cluster of
 * mutually-touching intervals rather than to the whole day, so a single busy hour does not
 * squeeze every other item on the day down to a sliver it does not need. A point (no
 * `durationMinutes`) counts as occupying one minute for this purpose only - long enough that two
 * items placed at the exact same minute are still treated as overlapping and laned apart, short
 * enough that it never overlaps a neighbour a whole hour away.
 */
export function layout(
  placed: readonly Placed[],
): readonly (Placed & { lane: number; lanes: number })[] {
  const intervals = placed
    .map((entry) => ({
      entry,
      start: entry.minutes,
      end:
        entry.minutes +
        (entry.durationMinutes === null ? 1 : Math.max(entry.durationMinutes, MIN_SPAN_MINUTES)),
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const results: (Placed & { lane: number; lanes: number })[] = [];

  // The end minute each open lane's current occupant reaches, index by lane number.
  let laneEnds: number[] = [];
  let cluster: { readonly entry: Placed; readonly lane: number }[] = [];

  function closeCluster(): void {
    const lanes = laneEnds.length;
    for (const member of cluster) {
      results.push({ ...member.entry, lane: member.lane, lanes });
    }
    cluster = [];
    laneEnds = [];
  }

  for (const interval of intervals) {
    if (laneEnds.length > 0 && laneEnds.every((end) => end <= interval.start)) {
      closeCluster();
    }

    let lane = laneEnds.findIndex((end) => end <= interval.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(interval.end);
    } else {
      laneEnds[lane] = interval.end;
    }

    cluster.push({ entry: interval.entry, lane });
  }

  closeCluster();

  return results;
}

/**
 * The inline position and width a lane resolves to, as CSS `calc()` expressions.
 *
 * Percent for the column's own width, which this file does not know in pixels, and a fixed pixel
 * gutter for the same 4px `inset-x-1` every point already drew with, split so lanes get 2px
 * between them rather than 4px in the middle and none at the edges.
 */
export function laneStyle(lane: number, lanes: number): { left: string; width: string } {
  const gap = 2;
  const inset = 4;
  const available = `(100% - ${String(inset * 2)}px - ${String((lanes - 1) * gap)}px)`;

  return {
    left: `calc(${String(inset)}px + (${available}) * ${String(lane)} / ${String(lanes)} + ${String(lane * gap)}px)`,
    width: `calc((${available}) / ${String(lanes)})`,
  };
}

/**
 * What an entry says about when it is.
 *
 * The zone is named only when it is not the reader's. Saying it every time would make the one time
 * it matters look like all the rest.
 */
export function timeLabel(entry: Placed, zone: string): string {
  if (entry.zone !== zone) {
    return `${entry.at} · ${entry.zone}`;
  }

  // A span says when it ends as well as when it starts. The box cannot always say it: a quarter
  // hour is drawn at the shortest box's height, so the words are what tell it from half an hour.
  return entry.durationMinutes === null
    ? entry.at
    : `${entry.at} - ${clockAt(entry.minutes + entry.durationMinutes)}`;
}

/**
 * The stored value a slot stands for: that hour, on that day, in the reader's own zone.
 *
 * Written through the same function every other timestamp goes through, so the offset is derived
 * from the zone rather than assembled by hand - which is the one way it could end up disagreeing
 * with the zone beside it, and the server refuses exactly that.
 */
export function writeSlot(day: CalendarDay, hour: number, zone: string): string | null {
  return writeTimestampValue(`${dayText(day)}T${String(hour).padStart(2, '0')}:00`, zone);
}
