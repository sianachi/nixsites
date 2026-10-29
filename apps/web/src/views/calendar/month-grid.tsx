import { Blueprint, Text, cn, focusRing } from '@nix/ui';
import type { ReactNode } from 'react';

import {
  addDays,
  dayText,
  monthEntry,
  monthLabel,
  weekdayIndex,
  WEEKDAY_ABBREVIATIONS,
  WEEKDAY_NAMES,
  type CalendarMonth,
} from '../../collections/core/calendar-dates';

/**
 * A month, as a grid of weeks, with the cells left to the caller.
 *
 * **The scaffolding is shared; what goes in a day is not.** Two views draw a month now - a
 * container's calendar, which can create, drag and reschedule, and the workspace's collated
 * calendar, which reads across containers and cannot do any of those, because the write would have
 * to guess which container's property it meant. Sharing the whole cell would mean either giving the
 * collated view controls that do nothing, or bolting optional-ness onto the container view's cell
 * and putting its whole test suite in the blast radius. Sharing the table instead hands each caller
 * the part that is genuinely the same: the weekday header, the blanks either end, the accessible
 * name of every day, and the scroll region below.
 *
 * Nothing here reads a clock or a zone. The month is given, and `todayText` is passed in, so the
 * grid is a pure function of its arguments and the two callers cannot disagree about what day it is.
 */

/** One day of the grid: the number to draw, and the date it stands for. */
export interface DayCellSpec {
  readonly day: number;
  readonly date: string;

  /**
   * Whether the day belongs to the month before or after the one being shown.
   *
   * A month grid is whole weeks, so its first and last rows usually reach into the neighbouring
   * months. Those days are drawn - a calendar with blank squares at its corners reads as broken,
   * and an item on the 1st of next month is something a reader planning this week wants to see -
   * but muted, so the month itself is still the shape that stands out.
   */
  readonly outside: boolean;

  /** The day spelled out, for the cell's accessible name: "Monday 3 March 2026". */
  readonly name: string;

  /** Where the cell sits (row, then column), for the keyboard walk over the grid. */
  readonly week: number;
  readonly weekday: number;
}

/**
 * How many items a day shows before the rest fold into "+N more".
 *
 * Three, because that is what fits in a row of the height below without the row growing. Rows that
 * grow with their busiest day are what make a month stop looking like a calendar: one crowded
 * Tuesday and its whole week is twice as tall as the others.
 */
export const MONTH_VISIBLE_ITEMS = 3;

/**
 * A day cell's box: every row the same height, whatever is in it.
 *
 * A table cell's `height` is a floor, so a day somebody has expanded still grows to show everything
 * - but an untouched month is an even grid.
 */
export const MONTH_CELL = 'h-32 border border-divider align-top';

/**
 * The weeks of a month as whole rows, Monday first, reaching into the months either side.
 */
export function buildWeeks(month: CalendarMonth): readonly (readonly DayCellSpec[])[] {
  const first = { year: month.year, month: month.month, day: 1 };
  const lead = weekdayIndex(month.year, month.month, 1);
  const start = addDays(first, -lead);

  const weeks: DayCellSpec[][] = [];
  for (let week = 0; week < 6; week += 1) {
    const row: DayCellSpec[] = [];
    for (let index = 0; index < 7; index += 1) {
      const day = addDays(start, week * 7 + index);
      row.push({
        day: day.day,
        date: dayText(day),
        outside: day.month !== month.month || day.year !== month.year,
        name: `${monthEntry(WEEKDAY_NAMES, index)} ${String(day.day)} ${monthLabel(day)}`,
        week,
        weekday: index,
      });
    }

    // A sixth row that lies wholly in next month is not part of this one. Five rows is the usual
    // month; four happens for a February that starts on a Monday.
    if (week > 3 && row.every((cell) => cell.outside)) {
      break;
    }
    weeks.push(row);
  }

  return weeks;
}

/**
 * The day's number. Today's is a filled disc, the way a wall calendar circles the date: it marks
 * one square without tinting the whole cell, which fought with the tint the items themselves use.
 */
export function DayNumber(props: {
  readonly day: number;
  readonly isToday: boolean;
  readonly outside: boolean;
}): ReactNode {
  const { day, isToday, outside } = props;

  return (
    <span
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs',
        isToday ? 'bg-accent-fill font-medium text-background' : outside ? 'text-muted' : '',
      )}
    >
      {String(day)}
    </span>
  );
}

/** The width floor of a single day column. */
const MONTH_DAY_COLUMN = 'w-[6.5rem]';

/**
 * The width floor of the whole grid: seven columns and their borders.
 *
 * Below this the grid scrolls rather than compressing, because seven columns squeezed into a phone
 * are seven columns of nothing legible.
 */
const MONTH_GRID_MIN_WIDTH = 'min-w-[45.5rem]';

export interface MonthGridProps {
  /** The month to draw. */
  readonly month: CalendarMonth;

  /** Today, as `yyyy-MM-dd`, so the grid can mark it without reading a clock of its own. */
  readonly todayText: string;

  /**
   * Prefixes the keys of the rows and the blank cells.
   *
   * Two panes can show the same month at once, and React keys only have to be unique among
   * siblings - but a caller that renders two grids in one list would collide without this.
   */
  readonly prefix: string;

  /** Extra classes for the scroll region, for a caller that has to bleed a gutter into it. */
  readonly regionClassName?: string;

  /**
   * Draws one day.
   *
   * Given the cell, the accessible name the grid worked out for it, and whether it is today - so
   * every caller's cells are named the same way and a reader moving between the two views hears
   * the same sentence.
   */
  readonly renderDay: (cell: DayCellSpec, name: string, isToday: boolean) => ReactNode;
}

export function MonthGrid(props: MonthGridProps): ReactNode {
  const { month, todayText, prefix, regionClassName, renderDay } = props;

  return (
    /*
      The scroller sits *outside* the frame, and the arithmetic is why. The table's floor is 728px
      (`MONTH_GRID_MIN_WIDTH`), and around it stand the frame's 2px of border and its 24px of `p-3`.
      With the scroller inside the frame, a container a little wider than the table's floor had a
      region narrower than it, so the last column slid under the frame's right border - clipped
      against a hairline rather than visibly scrollable. Because the frame now travels with the
      table, the last column ends at the frame's own edge instead of under it.

      `role="region"` plus a tab stop, matching timeline-view.tsx's and calendar-hours.tsx's own
      scrollable tracks: without one, this axis is reachable by keyboard only by tabbing through
      every focusable control inside it. `<Blueprint>` cannot carry any of this itself - it forwards
      only `children`, `as` and `className` - so the scroll moves to this plain wrapper. `min-w-fit`
      on the frame is what makes its box span the true scroll-content width - the pane's width when
      there is room, the table's floor when there is not. It was `min-w-max`, and the max-content
      width of a `table-fixed` table that is itself `width: 100%` is not a real number: Chrome
      resolved it to a million pixels, each day column came out 142,857px wide, and the month drew
      as a single column of Mondays with the other six days far off to the right; jsdom cannot verify any
      of the layout above, so the classes here are asserted as a contract in calendar-view.test.tsx.
    */
    <div
      role="region"
      aria-label={monthLabel(month)}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: a scrollable region needs a tab stop or its content cannot be scrolled without a pointer.
      tabIndex={0}
      className={cn(regionClassName, 'overflow-x-auto', focusRing)}
    >
      <Blueprint className="min-w-fit overflow-hidden p-0">
        <table className={cn('w-full table-fixed border-collapse', MONTH_GRID_MIN_WIDTH)}>
          <Text as="caption" variant="caption" className="sr-only">
            {`${monthLabel(month)}, items placed on the day their date names`}
          </Text>

          <thead>
            <tr>
              {WEEKDAY_NAMES.map((name, index) => (
                <th
                  key={name}
                  scope="col"
                  aria-label={name}
                  // Centred over its column and ruled off underneath only: the weekday row is a
                  // heading for the grid, not seven more cells of it.
                  className={cn('border-b border-divider px-1 py-2 text-center', MONTH_DAY_COLUMN)}
                >
                  <Text variant="kicker" as="span" tone="muted">
                    {monthEntry(WEEKDAY_ABBREVIATIONS, index)}
                  </Text>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {buildWeeks(month).map((week, weekIndex) => (
              <tr key={`${prefix}week-${String(weekIndex)}`}>
                {week.map((cell) => renderDay(cell, cell.name, cell.date === todayText))}
              </tr>
            ))}
          </tbody>
        </table>
      </Blueprint>
    </div>
  );
}
