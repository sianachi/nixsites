import { cn, focusRing, Text } from '@nix/ui';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

/**
 * A year of days as a grid of weeks: up to 53 columns of seven, Monday at the top, each day shaded
 * by its value on a four-step scale.
 *
 * **One renderer for every year grid.** A chart view of `chartKind: year`, the habit tracker's
 * insights and, later, a dashboard tile all hand it the same thing - a run of consecutive days with
 * a value and a sentence each - so the scale, the keyboard and the readout are the same everywhere.
 * It knows nothing about items or habits.
 *
 * **A grid to read, or buttons to choose.** With nothing to do on a day it is an ARIA grid: seven
 * rows, one per weekday, each named by a row header, with one tab stop that the arrow keys move
 * (up and down by day, left and right by week). Only when a caller passes `onSelect` is each day a
 * button, sized as a touch target, because a button that does nothing is a promise the page breaks.
 *
 * **The shading is decoration; the sentence is the datum.** Every day's accessible name is its
 * sentence ("9 Oct 2026: 3 items"), and the focused or hovered day's sentence is written under the
 * grid. Nothing is only a colour.
 *
 * **Four steps of the accent, from tokens.** The accent at 40, 60 and 80 percent and then the full
 * accent fill, which flips with the theme. An empty day is transparent inside a divider ring, so
 * "nothing" is visibly not "a little". The steps are quarters of the largest value, said in the
 * legend in numbers.
 */

export interface YearGridCell {
  /** The day, `yyyy-MM-dd`. Cells are consecutive days, earliest first. */
  readonly date: string;
  /** The value that shades the day; null or zero is an empty day. */
  readonly value: number | null;
  /** The whole sentence a reader hears and sees for the day. */
  readonly label: string;
}

export interface YearGridProps {
  readonly cells: readonly YearGridCell[];
  /** What the grid as a whole shows, for its accessible name. */
  readonly label: string;
  /** What the legend calls the values, plural: "items", "check-ins", "minutes". */
  readonly unit: string;
  /** Called when a day is chosen. Its presence is what makes each day a button. */
  readonly onSelect?: ((date: string) => void) | undefined;
  readonly selected?: string | null | undefined;
}

const LEVEL_CLASSES = [
  'bg-transparent ring-1 ring-inset ring-divider',
  'bg-accent/40',
  'bg-accent/60',
  'bg-accent/80',
  'bg-accent-fill',
] as const;

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Monday is zero. */
function weekdayOf(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** Which of the four steps a value falls in, zero for an empty day. */
export function yearGridLevel(value: number | null, largest: number): number {
  if (value === null || value <= 0 || largest <= 0) {
    return 0;
  }
  return Math.min(4, Math.max(1, Math.ceil((value / largest) * 4)));
}

/**
 * Where a key moves the focus from day `index`, or null to stay put.
 *
 * Up and down move by a day, across a week boundary if need be. Left and right move by a week and
 * stay put at the grid's edge rather than wrapping. Home and End go to the first and last day of
 * the focused weekday's row; with Ctrl, to the first and last day of the whole grid.
 */
export function yearGridMove(
  key: string,
  index: number,
  count: number,
  offset: number,
  control: boolean,
): number | null {
  const row = (index + offset) % 7;
  const inRange = (target: number) => (target >= 0 && target < count ? target : null);

  switch (key) {
    case 'ArrowUp':
      return inRange(index - 1);
    case 'ArrowDown':
      return inRange(index + 1);
    case 'ArrowLeft':
      return inRange(index - 7);
    case 'ArrowRight':
      return inRange(index + 7);
    case 'Home': {
      if (control) return 0;
      const first = row - offset;
      return first >= 0 ? first : first + 7;
    }
    case 'End': {
      if (control) return count - 1;
      let last = index;
      while (last + 7 < count) last += 7;
      return last;
    }
    default:
      return null;
  }
}

export function YearGrid({ cells, label, unit, onSelect, selected }: YearGridProps): ReactNode {
  const [focused, setFocused] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const days = useRef<(HTMLElement | null)[]>([]);

  const first = cells[0];
  const offset = first === undefined ? 0 : weekdayOf(first.date);
  const columns = Math.ceil((cells.length + offset) / 7);
  const largest = cells.reduce((most, cell) => Math.max(most, cell.value ?? 0), 0);
  const selectedIndex = cells.findIndex((cell) => cell.date === selected);
  const stop = focused ?? (selectedIndex >= 0 ? selectedIndex : cells.length - 1);
  const readout = cells[hovered ?? focused ?? selectedIndex];
  const interactive = onSelect !== undefined;

  // On a phone the grid is wider than the screen; open it on the latest weeks, which are the ones
  // a person came to see, rather than on last autumn.
  useEffect(() => {
    const element = scroller.current;
    if (element !== null) {
      element.scrollLeft = element.scrollWidth;
    }
  }, [cells.length]);

  // The number of columns is the data, not a chosen dimension: a partial first week still needs
  // its column, and a run shorter than a year needs fewer of them.
  const months: CSSProperties = {
    gridTemplateColumns: `repeat(${String(columns)}, var(--year-cell))`,
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    const target = yearGridMove(
      event.key,
      index,
      cells.length,
      offset,
      event.ctrlKey || event.metaKey,
    );
    if (target === null) {
      if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
      }
      return;
    }
    event.preventDefault();
    setFocused(target);
    days.current[target]?.focus();
  };

  if (cells.length === 0) {
    return (
      <Text variant="bodySmall" tone="muted">
        There are no days to show.
      </Text>
    );
  }

  const day = (index: number): ReactNode => {
    const cell = cells[index];
    if (cell === undefined) {
      // Before the first day or after the last: a cell of the grid's shape with nothing in it.
      return (
        <div
          key={`empty-${String(index)}`}
          role={interactive ? undefined : 'gridcell'}
          className="size-(--year-cell) shrink-0"
        />
      );
    }
    const shared = {
      ref: (element: HTMLElement | null) => {
        days.current[index] = element;
      },
      tabIndex: index === stop ? 0 : -1,
      'aria-label': cell.label,
      className: cn(
        'size-(--year-cell) shrink-0 rounded-sm',
        LEVEL_CLASSES[yearGridLevel(cell.value, largest)],
        cell.date === selected && 'ring-2 ring-accent ring-offset-1 ring-offset-surface',
        focusRing,
      ),
      onFocus: () => {
        setFocused(index);
      },
      onMouseEnter: () => {
        setHovered(index);
      },
      onMouseLeave: () => {
        setHovered(null);
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        onKeyDown(event, index);
      },
    };
    return interactive ? (
      <button
        key={cell.date}
        type="button"
        {...shared}
        aria-pressed={cell.date === selected}
        onClick={() => {
          onSelect(cell.date);
        }}
      />
    ) : (
      <div key={cell.date} role="gridcell" {...shared} />
    );
  };

  const rows = WEEKDAYS.map((weekday, row) => (
    <div key={weekday} role={interactive ? undefined : 'row'} className="flex items-center gap-1">
      <span role={interactive ? undefined : 'rowheader'} className="w-4 shrink-0">
        {interactive ? null : <span className="sr-only">{weekday}</span>}
        <span aria-hidden="true">
          <Text as="span" variant="caption" tone="muted">
            {row % 2 === 0 ? weekday.slice(0, 1) : ''}
          </Text>
        </span>
      </span>
      {Array.from({ length: columns }, (_, column) => day(column * 7 + row - offset))}
    </div>
  ));

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-2',
        interactive
          ? '[--year-cell:calc(var(--spacing)*7)] any-pointer-coarse:[--year-cell:var(--control-lg)]'
          : '[--year-cell:calc(var(--spacing)*3)] any-pointer-coarse:[--year-cell:calc(var(--spacing)*5)]',
      )}
    >
      <div ref={scroller} className="min-w-0 max-w-full overflow-x-auto p-1 pb-2">
        <div className="flex min-w-fit flex-col gap-1">
          <div className="flex gap-1" aria-hidden="true">
            <span className="w-4 shrink-0" />
            <div className="grid gap-1" style={months}>
              {Array.from({ length: columns }, (_, column) => {
                const start = cells[Math.max(0, column * 7 - offset)];
                const before =
                  column === 0 ? undefined : cells[Math.max(0, (column - 1) * 7 - offset)];
                const opens =
                  start !== undefined &&
                  (column === 0 || start.date.slice(0, 7) !== before?.date.slice(0, 7));
                return (
                  <Text
                    key={column}
                    variant="caption"
                    tone="muted"
                    className="overflow-visible whitespace-nowrap leading-none"
                  >
                    {opens
                      ? new Date(`${start.date}T00:00:00Z`).toLocaleDateString(undefined, {
                          month: 'short',
                          timeZone: 'UTC',
                        })
                      : ''}
                  </Text>
                );
              })}
            </div>
          </div>
          {interactive ? (
            <div role="group" aria-label={label} className="flex flex-col gap-1">
              {rows}
            </div>
          ) : (
            <div role="grid" aria-label={label} className="flex flex-col gap-1">
              {rows}
            </div>
          )}
        </div>
      </div>

      <Text variant="bodySmall" tone={readout === undefined ? 'muted' : 'default'}>
        {readout === undefined
          ? 'Focus a day to read its value. Arrow keys move by day and by week.'
          : readout.label}
      </Text>

      <div className="flex flex-wrap items-center gap-2">
        <Text as="span" variant="caption" tone="muted">
          None
        </Text>
        {LEVEL_CLASSES.map((level) => (
          <span key={level} className={cn('size-3 rounded-sm', level)} aria-hidden="true" />
        ))}
        <Text as="span" variant="caption" tone="muted">
          {largest > 0
            ? `Four steps up to ${formatScale(largest)} ${unit}, each a quarter of that.`
            : `No ${unit} recorded in this range.`}
        </Text>
      </div>
    </div>
  );
}

function formatScale(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
