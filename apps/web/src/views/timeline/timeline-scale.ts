import {
  MONTH_NAMES,
  WEEKDAY_ABBREVIATIONS,
  addDays,
  dayLabel,
  dayText,
  daysInMonth,
  monthEntry,
  monthLabel,
  shiftMonth,
  startOfWeek,
  weekLabel,
  weekOf,
  weekdayIndex,
  type CalendarDay,
  type CalendarMonth,
} from '@nix/web-collections/core/calendar-dates';

/**
 * Where a timeline's columns are, and which of them a span covers.
 *
 * **All of the timeline's arithmetic and none of its React**, for the same reason `calendar-dates`
 * exists: a grid whose day-to-column mapping is only reachable by rendering it is a grid whose
 * off-by-one is only findable by counting pixels. Everything below is integers and `yyyy-MM-dd`
 * text, and it is built entirely from `calendar-dates` - this module adds no date arithmetic of its
 * own, because a second implementation of "what is the next day" is a second place for February to
 * be wrong.
 *
 * **No `Date` is constructed from a stored value here, ever.** `new Date('2026-03-01')` is UTC
 * midnight, which is the 28th of February for every reader west of Greenwich, so a bar placed that
 * way starts a day early for half the world and looks right on the machine of whoever wrote it. The
 * one value that legitimately becomes a moment is a `timestamp` property, and it is converted to the
 * reader's day by `timestamps.ts` before it reaches any comparison here.
 *
 * **Dates are compared as text.** `yyyy-MM-dd` sorts the way the days do, so "does this bar start
 * before the window" is a string comparison and cannot disagree with "which column does it land in".
 */

/**
 * The grains a timeline is drawn at.
 *
 * **No `day`.** A one-day gantt is a list with one column in it, and offering it would be offering
 * a worse list. `week` and `month` draw a column per day - `month` compressed, because thirty-one
 * labelled columns do not fit - and `quarter` draws a column per week.
 */
export type TimelineScale = 'week' | 'month' | 'quarter';

/**
 * What a timeline shows when nothing has said otherwise.
 *
 * Not exported: which grain is the default is `readScale`'s answer to give, and a caller reaching
 * for the constant would be a second place deciding it.
 */
const DEFAULT_SCALE: TimelineScale = 'month';

/**
 * Reads a stored or addressed grain.
 *
 * Shares the `mode` field with the calendar deliberately: it was built as a per-kind grain string,
 * the server does not validate it, and the two vocabularies overlap on purpose - so a view switched
 * from a calendar to a timeline keeps a `week` and quietly loses only what the timeline has no
 * meaning for. A calendar's `day` is exactly that case and falls back here rather than being
 * refused, which is the same rule the calendar applies to a grain it does not know.
 */
export function readScale(value: string | null): TimelineScale {
  return value === 'week' || value === 'quarter' || value === 'month' ? value : DEFAULT_SCALE;
}

/** One column of the axis: the days it covers, and what it is called. */
export interface TimelineColumn {
  /** The first day in the column. A day column's only day. */
  readonly from: CalendarDay;

  /** The last day in the column, inclusive. */
  readonly to: CalendarDay;

  readonly fromText: string;
  readonly toText: string;

  /** The few characters a column header can afford. */
  readonly label: string;

  /**
   * The whole date, spelt out, for the header's accessible name.
   *
   * A column announced as "3" tells somebody moving through it with a screen reader nothing about
   * which month or which year they are in - the same reason the calendar's day cells carry theirs.
   */
  readonly name: string;
}

/** The stretch of time on screen, as columns. */
export interface TimelineWindow {
  readonly scale: TimelineScale;
  readonly columns: readonly TimelineColumn[];

  /** The first day any column covers. */
  readonly fromText: string;

  /** The last day any column covers. */
  readonly toText: string;

  /** How the window reads as a heading. */
  readonly label: string;
}

/** Which of the three months a quarter starts at, for a month index. */
function quarterStart(month: number): number {
  return Math.floor(month / 3) * 3;
}

function dayColumn(day: CalendarDay, compact: boolean): TimelineColumn {
  return {
    from: day,
    to: day,
    fromText: dayText(day),
    toText: dayText(day),
    // Compressed at month scale: thirty-one columns reading "Tue 3" do not fit across a pane, and
    // the weekday is the first thing to go because the row of them repeats every seven columns.
    label: compact
      ? String(day.day)
      : `${monthEntry(WEEKDAY_ABBREVIATIONS, weekdayIndex(day.year, day.month, day.day))} ${String(day.day)}`,
    name: dayLabel(day),
  };
}

function weekColumn(monday: CalendarDay): TimelineColumn {
  const sunday = addDays(monday, 6);

  return {
    from: monday,
    to: sunday,
    fromText: dayText(monday),
    toText: dayText(sunday),
    // The Monday's date and its month, abbreviated the way a column header has to be. The full
    // range is in the name below, where there is room for it.
    label: `${String(monday.day)} ${monthEntry(MONTH_NAMES, monday.month).slice(0, 3)}`,
    name: weekLabel(monday),
  };
}

/**
 * The columns on screen, and what the heading over them says.
 *
 * The anchor is a day rather than a month because two of the three scales do not line up with one:
 * a week straddles a month boundary about a quarter of the time, and a quarter's first column
 * usually starts in the month before it.
 */
export function buildWindow(scale: TimelineScale, anchor: CalendarDay): TimelineWindow {
  const columns = columnsFor(scale, anchor);

  // Never empty: every branch below produces at least seven columns, so reading the ends is safe.
  // Asserting that here rather than defending against it, because a window with no columns would
  // be an arithmetic bug and a fallback would hide it.
  const first = columns[0];
  const last = columns[columns.length - 1];

  if (first === undefined || last === undefined) {
    throw new RangeError(`A ${scale} window produced no columns.`);
  }

  return {
    scale,
    columns,
    fromText: first.fromText,
    toText: last.toText,
    label: windowLabel(scale, anchor),
  };
}

function columnsFor(scale: TimelineScale, anchor: CalendarDay): readonly TimelineColumn[] {
  if (scale === 'week') {
    return weekOf(anchor).map((day) => dayColumn(day, false));
  }

  if (scale === 'month') {
    const month: CalendarMonth = { year: anchor.year, month: anchor.month };
    return Array.from({ length: daysInMonth(month) }, (_, offset) =>
      dayColumn({ ...month, day: offset + 1 }, true),
    );
  }

  // A quarter, as whole weeks. The first column is the Monday of the week the quarter opens in,
  // which is usually in the month before it - a quarter cut to start on its own first day would
  // have one short column that is a different width from every other one.
  const start: CalendarMonth = { year: anchor.year, month: quarterStart(anchor.month) };
  const closing = shiftMonth(start, 2);
  const lastText = dayText({ ...closing, day: daysInMonth(closing) });

  const columns: TimelineColumn[] = [];
  let cursor = startOfWeek({ ...start, day: 1 });

  // Counted rather than fixed at thirteen: a quarter spans thirteen or fourteen weeks depending on
  // which weekday it opens on, and the constant is wrong for a quarter of them.
  while (dayText(cursor) <= lastText) {
    columns.push(weekColumn(cursor));
    cursor = addDays(cursor, 7);
  }

  return columns;
}

function windowLabel(scale: TimelineScale, anchor: CalendarDay): string {
  if (scale === 'week') {
    return weekLabel(anchor);
  }

  if (scale === 'month') {
    return monthLabel({ year: anchor.year, month: anchor.month });
  }

  const first = quarterStart(anchor.month);
  return `${monthEntry(MONTH_NAMES, first)} to ${monthEntry(MONTH_NAMES, first + 2)} ${String(anchor.year)}`;
}

/**
 * Moves the window one step.
 *
 * The month and quarter steps clamp the day, because the 31st does not exist in every month and an
 * anchor that fell off the end would roll silently into the next one - the same clamp the calendar
 * applies for the same reason.
 */
export function stepAnchor(scale: TimelineScale, anchor: CalendarDay, delta: number): CalendarDay {
  if (scale === 'week') {
    return addDays(anchor, delta * 7);
  }

  const moved = shiftMonth(
    { year: anchor.year, month: anchor.month },
    delta * (scale === 'quarter' ? 3 : 1),
  );

  return { ...moved, day: Math.min(anchor.day, daysInMonth(moved)) };
}

/**
 * Which column a day lands in, or null when the window does not reach it.
 *
 * Compares the text the column already carries rather than calling `withinRange`, which is the same
 * comparison but rebuilds both `yyyy-MM-dd` strings from the day triple on every probe. This is a
 * linear scan called up to twice per item, so at a thirty-one column month that is two strings per
 * column per lookup - thousands of transient allocations a render for an answer the column was
 * built with. `fromText` and `toText` come from the same `dayText`, so the result is identical.
 */
export function columnOf(axis: TimelineWindow, date: string): number | null {
  const index = axis.columns.findIndex(
    (column) => date >= column.fromText && date <= column.toText,
  );

  return index === -1 ? null : index;
}

/**
 * Where an item sits on the axis, or why it does not sit anywhere.
 *
 * **Five outcomes, told apart on purpose**, because collapsing any two of them puts something
 * untrue on screen:
 *
 *   - `undated` - no start at all. It is not on the axis and it has not been lost; the view lists
 *     it, the way the calendar lists its unscheduled items.
 *   - `milestone` - a start and no end. A point, not a zero-width bar and not a bar drawn to today:
 *     extending it would invent an end date nobody entered.
 *   - `reversed` - an end before its start. Neither swapped nor clamped. Somebody may need to see
 *     that the data says this, and a silently corrected date is a correction nobody made.
 *   - `span` - a bar, clipped to the window, saying at which end it continues.
 *   - `outside` - dated, and entirely off the window. Counted and said out loud rather than
 *     dropped.
 */
export type TimelinePlacement =
  | { readonly kind: 'undated' }
  | { readonly kind: 'reversed' }
  | { readonly kind: 'outside' }
  | { readonly kind: 'milestone'; readonly column: number }
  | {
      readonly kind: 'span';
      readonly first: number;
      readonly last: number;

      /** The bar really starts before the window; the drawn end is a cut, not a date. */
      readonly continuesBefore: boolean;

      /** The bar really ends after the window. */
      readonly continuesAfter: boolean;
    };

/**
 * Places one span against the window.
 *
 * Both dates are `yyyy-MM-dd` text and are compared as text throughout - which works because the
 * format sorts the way the days do, and which is what keeps this from ever needing a `Date`.
 */
export function placeSpan(
  axis: TimelineWindow,
  start: string | null,
  end: string | null,
): TimelinePlacement {
  if (start === null) {
    return { kind: 'undated' };
  }

  if (end !== null && end < start) {
    // Asked before the window is consulted, so a reversed pair is reported as reversed wherever it
    // falls. Reporting it as "outside the window" would send somebody paging through months
    // looking for an item whose dates are the actual problem.
    return { kind: 'reversed' };
  }

  if (end === null) {
    const column = columnOf(axis, start);
    return column === null ? { kind: 'outside' } : { kind: 'milestone', column };
  }

  if (end < axis.fromText || start > axis.toText) {
    return { kind: 'outside' };
  }

  const first = columnOf(axis, start < axis.fromText ? axis.fromText : start);
  const last = columnOf(axis, end > axis.toText ? axis.toText : end);

  // Both ends have just been clamped into the window, and every day of the window is in exactly one
  // column, so neither lookup can miss. Throwing rather than falling back keeps a gap in the
  // columns from being drawn as a plausible bar.
  if (first === null || last === null) {
    throw new RangeError(`A span inside the window found no column: ${start} to ${end}.`);
  }

  return {
    kind: 'span',
    first,
    last,
    continuesBefore: start < axis.fromText,
    continuesAfter: end > axis.toText,
  };
}
