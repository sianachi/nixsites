import type { CalendarEntry } from '@nix/api-client';
import { Blueprint, Button, Icon, Segmented, Text, cn, focusRing } from '@nix/ui';
import { CalendarClock, CircleCheck, Repeat, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { HourGrid } from '@nix/web-views/calendar/calendar-hours';
import {
  DayNumber,
  MONTH_CELL,
  MONTH_VISIBLE_ITEMS,
  MonthGrid,
  type DayCellSpec,
} from '@nix/web-views/calendar/month-grid';
import { RescheduleDialog } from '@nix/web-views/calendar/reschedule-dialog';
import {
  addDays,
  dayLabel,
  dayText,
  monthLabel,
  shiftMonth,
  weekLabel,
  weekOf,
  type CalendarDay,
} from '@nix/web-collections/core/calendar-dates';
import { readTimestampValue, readerZone } from '@nix/web-collections/core/timestamps';
import type { CalendarGrain } from './calendar-window';
import {
  bucketByDay,
  isDailyNote,
  noteOptions,
  COLLATED_DATE_KEY,
  COLLATED_END_KEY,
  toGridItem,
  toGridItems,
} from './collated-entries';
import { CreateEntryButton } from './create-entry-button';
import { shiftedEnd, valueForDay } from './reschedule';

/** How many entries a month cell shows before it collapses the rest, matching `DayCell`'s own. */

/**
 * Every calendar in the workspace, drawn as one.
 *
 * **The same grids the container calendar uses.** A month is `MonthGrid`, a week and a day are
 * `HourGrid`, so a reader who learns one calendar has learnt both and a change to either lands in
 * both places at once. What differs is what a day cell says: an entry here came from somewhere, and
 * saying which container is the whole point of collating.
 *
 * **Rescheduling was always answerable; creating now is too, the same way.** The container calendar
 * can create and reschedule because it knows which property it places by. This one used to say
 * creating had no answer, because entries arrive placed by whatever their own container names. Goal
 * 3.10 answers it: `onCreate` asks which container first, then resolves *that* container's own date
 * property from its own view configuration - never a guess from whichever entries are on screen,
 * which is what would make the destination depend on the month being looked at. `onCreate` stays
 * optional, matching the grids' own `onCreate`/`onMove`: a caller that has not wired it gets a
 * calendar with no way to create, not a control that appeared and did nothing.
 */

export interface CollatedCalendarProps {
  /**
   * The entries to draw.
   *
   * The entries rather than the whole response, because the page filters them before they get here
   * and a view that took the response would have to be told twice which of its entries were live.
   */
  readonly entries: readonly CalendarEntry[];

  /** Which grain to draw. Owned by the page, because the URL carries it. */
  readonly grain: CalendarGrain;
  readonly onGrain: (grain: CalendarGrain) => void;

  /** Where in time the reader is. Owned by the page so a refetch and the drawing agree. */
  readonly anchor: CalendarDay;
  readonly onAnchor: (anchor: CalendarDay) => void;

  /** Today, so nothing below reads a clock of its own. */
  readonly today: CalendarDay;

  /** Opens an item. Wired to the same `useOpenItem` the tree and the palette use. */
  readonly onOpen: (itemId: string) => void;

  /**
   * Writes an entry's own date property.
   *
   * Answerable because the entry carries the key its own container placed it by.
   */
  readonly onReschedule: (entry: CalendarEntry, value: string) => void;

  /**
   * Writes several of an entry's own properties together - its start and its end - under the keys
   * its own container names. Optional: without it this calendar moves items but cannot give them
   * a length, which is what it did before entries carried an end.
   */
  readonly onWrite?:
    ((entry: CalendarEntry, values: Record<string, string | null>) => void) | undefined;

  /**
   * Gives the calendar an entry came from an end property, so its items can have a length.
   * Offered on entries whose calendar has none.
   */
  readonly onAddEndTimes?: ((entry: CalendarEntry) => void) | undefined;

  /**
   * Makes a new item in a chosen container, dated on that container's own calendar property.
   *
   * Optional, matching the grids' own `onCreate` - absent means this caller offers no way to
   * create, rather than a button that would have nothing to do. Wired to
   * `useWorkspaceCalendar`'s `create`, which is what actually resolves the container's property and
   * writes it; this view only asks which container and which day.
   */
  readonly onCreate?:
    ((containerId: string, title: string, day: string) => Promise<string | null>) | undefined;

  /**
   * Marks one occurrence of a repeating entry done.
   *
   * Optional, the same way `onCreate` is: absent means no "Mark done" control is offered rather
   * than one that would have nothing to do. Only offered for a `generated` entry - a stored entry
   * has no occurrence to complete, only the item's own properties to edit, which this calendar
   * already reaches through the item panel. `occurredOn` is the entry's own day, already the shape
   * `recurrence.completeOccurrence` takes.
   */
  readonly onComplete?: ((entry: CalendarEntry, occurredOn: string) => void) | undefined;
}

const GRAINS = [
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
] as const satisfies readonly { value: CalendarGrain; label: string }[];

export function CollatedCalendar(props: CollatedCalendarProps): ReactNode {
  const {
    entries,
    grain,
    onGrain,
    anchor,
    onAnchor,
    today,
    onOpen,
    onReschedule,
    onWrite,
    onAddEndTimes,
    onCreate,
    onComplete,
  } = props;

  // Keyed on the payload, so stepping the grain does not rebucket entries that have not changed.
  const byDay = useMemo(() => bucketByDay(entries), [entries]);
  const items = useMemo(() => toGridItems(entries), [entries]);

  // Occurrences a recurrence rule produced have no row to write to, and a daily note's day is the
  // note's identity, so the hour grid offers no way to move either - the month cell already
  // withholds the same controls. Memoized for the same reason `items` is: the grid takes it as a
  // prop and a fresh set every render is a fresh grid.
  const fixedIds = useMemo(
    () =>
      new Set(
        entries
          .filter((entry) => entry.generated || isDailyNote(entry))
          .map((entry) => entry.itemId),
      ),
    [entries],
  );

  // Entries whose own calendar has no end property: the grid draws no foot on them and offers to
  // add one instead. Memoized for the same reason as the set above.
  const endlessIds = useMemo(
    () =>
      new Set(
        entries
          .filter((entry) => entry.endProperty === null || onWrite === undefined)
          .map((entry) => entry.itemId),
      ),
    [entries, onWrite],
  );

  /**
   * Moves an entry's start, carrying its end with it so it keeps its length.
   *
   * Every road that sets a start alone comes through here - a drop on a month cell, the
   * reschedule dialog of an entry with no end - so none of them can leave an end behind.
   */
  const moveStart = (entry: CalendarEntry, value: string): void => {
    const end = shiftedEnd(entry, value, zone);
    if (end !== null && entry.endProperty !== null && onWrite !== undefined) {
      onWrite(entry, { [entry.dateProperty]: value, [entry.endProperty]: end });
      return;
    }
    onReschedule(entry, value);
  };

  // The containers a new entry may land in - the same notes the filter above offers, since every
  // one of them is already known to place by a real property (an entry could not exist otherwise).
  // Not memoised: it is a map and a sort over what is already in hand, not a cost worth guarding.
  const destinations = noteOptions(entries);

  // One clock reading for the whole grid rather than one per cell: the answer cannot change halfway
  // through a render, and forty-two of them would be forty-two allocations for one fact.
  const todayText = dayText(today);
  const zone = readerZone();

  // Which entry is in the air. Held by id rather than by value, so a refetch mid-drag cannot leave
  // this holding a copy of a row the server has since changed.
  const [dragged, setDragged] = useState<string | null>(null);

  // Which day the pointer is over, so exactly one cell can show it will take the drop. A boolean
  // per cell would mean forty-two pieces of state for one fact.
  const [over, setOver] = useState<string | null>(null);
  const draggedEntry = entries.find((entry) => entry.itemId === dragged) ?? null;

  const dropOn = (day: string): void => {
    if (draggedEntry === null) {
      return;
    }

    const value = valueForDay(draggedEntry, day, zone);
    setDragged(null);

    // A drop whose value cannot be expressed is refused rather than written as something else - the
    // same condition the page counts as unplaceable.
    if (value !== null && value !== draggedEntry.value) {
      moveStart(draggedEntry, value);
    }
  };

  // Which entry's reschedule dialog is open, or null. Tap-and-keyboard's own counterpart to
  // `dragged` above: the month cell used to answer only to a drag, which a keyboard and a touch
  // screen alike cannot perform.
  const [rescheduling, setRescheduling] = useState<string | null>(null);
  const reschedulingEntry = entries.find((entry) => entry.itemId === rescheduling) ?? null;

  const step = (delta: number): void => {
    if (grain === 'month') {
      const moved = shiftMonth({ year: anchor.year, month: anchor.month }, delta);
      // Clamped, so stepping from the 31st into a shorter month does not roll into the next one.
      onAnchor({ ...moved, day: Math.min(anchor.day, 28) });
      return;
    }

    onAnchor(addDays(anchor, delta * (grain === 'week' ? 7 : 1)));
  };

  const label =
    grain === 'month'
      ? monthLabel({ year: anchor.year, month: anchor.month })
      : grain === 'week'
        ? weekLabel(anchor)
        : dayLabel(anchor);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Calendar grain"
          options={GRAINS}
          value={grain}
          onChange={(next) => {
            onGrain(next);
          }}
        />

        <Button
          variant="icon"
          aria-label={`Previous ${grain}`}
          onClick={() => {
            step(-1);
          }}
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </Button>

        <Button
          variant="icon"
          aria-label={`Next ${grain}`}
          onClick={() => {
            step(1);
          }}
        >
          <ChevronRight aria-hidden="true" className="size-4" />
        </Button>

        <Button
          variant="secondary"
          onClick={() => {
            onAnchor(today);
          }}
        >
          Today
        </Button>

        {/* Live, because the two step buttons change it and a reader who cannot see the grid
            redraw has no other way to know the press did anything. */}
        <Text as="span" variant="note" tone="muted" aria-live="polite">
          {label}
        </Text>

        {/* Absent entirely when the caller has not wired a way to create - see this component's own
            docblock and the grids' own optional `onCreate` for why silence is the right answer
            rather than a button with nothing to do. */}
        {onCreate !== undefined && (
          <CreateEntryButton
            destinations={destinations}
            day={dayText(anchor)}
            onCreate={onCreate}
          />
        )}
      </div>

      {grain === 'month' ? (
        <MonthGrid
          month={{ year: anchor.year, month: anchor.month }}
          todayText={todayText}
          prefix="collated-"
          renderDay={(cell, name, isToday) => (
            <CollatedDayCell
              key={cell.date}
              cell={cell}
              name={name}
              isToday={isToday}
              entries={byDay.get(cell.date) ?? []}
              over={over === cell.date && dragged !== null}
              onDragOver={() => {
                setOver(cell.date);
              }}
              onDragLeave={() => {
                setOver((current) => (current === cell.date ? null : current));
              }}
              onDrop={() => {
                setOver(null);
                dropOn(cell.date);
              }}
              onOpen={onOpen}
              onDragStart={setDragged}
              onDragEnd={() => {
                setDragged(null);
              }}
              onReschedule={setRescheduling}
              onComplete={onComplete}
            />
          )}
        />
      ) : (
        <Blueprint className="flex min-h-[520px] flex-col overflow-hidden p-0">
          <HourGrid
            days={grain === 'week' ? weekOf(anchor) : [anchor]}
            items={items}
            // Every entry was rewritten onto one key, because the grid takes one and these entries
            // came placed by whatever their own container names. See collated-entries.ts.
            dateProperty={COLLATED_DATE_KEY}
            // And every end onto one key, likewise. An entry whose own calendar has no end
            // property is named in `endlessItemIds`, so it gets no foot to stretch.
            endDateProperty={COLLATED_END_KEY}
            endlessItemIds={endlessIds}
            onAddEndProperty={
              onAddEndTimes === undefined
                ? undefined
                : (itemId) => {
                    const entry = entries.find((candidate) => candidate.itemId === itemId);
                    if (entry !== undefined && !entry.generated && !isDailyNote(entry)) {
                      onAddEndTimes(entry);
                    }
                  }
            }
            zone={zone}
            today={todayText}
            onOpen={onOpen}
            // Still no per-slot create here: `HourGrid`'s own control takes one property bag and
            // has nowhere to ask which container, and this view has no cell-sized way to add a
            // destination picker to a shared control other views also use. The toolbar's
            // `CreateEntryButton` above is where creating lives in every grain instead. Moving is
            // unaffected either way, because the entry carries its own property key.
            dragged={dragged}
            fixedItemIds={fixedIds}
            onMove={(itemId, values) => {
              // The bag holds the start, the end, or both, each under the collated key it was
              // given: a move writes the start and carries the end, a stretch writes the end alone.
              const value = values[COLLATED_DATE_KEY] ?? null;
              const end = values[COLLATED_END_KEY];
              const entry = entries.find((candidate) => candidate.itemId === itemId);
              setDragged(null);
              if (entry === undefined) {
                return;
              }

              // A generated occurrence has no row of its own to move: the write would land on the
              // series it came from and shift every occurrence with it.
              // A daily note keeps the day it is for, so it cannot be moved either.
              if (entry.generated || isDailyNote(entry)) {
                return;
              }

              // Anything that touches the end goes out as one write under the entry's own keys,
              // so a start and the end that travelled with it cannot land separately.
              if (end !== undefined && entry.endProperty !== null && onWrite !== undefined) {
                onWrite(entry, {
                  ...(value === null ? {} : { [entry.dateProperty]: value }),
                  [entry.endProperty]: end,
                });
                return;
              }

              if (value === null) {
                return;
              }

              // The grid hands back a moment in the reader's zone, to the minute it was dropped
              // or dragged to. An all-day item keeps only the day of it, so it stays all-day
              // rather than becoming a moment its property cannot hold.
              const written = entry.kind === 'date' ? value.slice(0, 10) : value;

              if (written !== entry.value) {
                moveStart(entry, written);
              }
            }}
          />
        </Blueprint>
      )}

      {/* Tap-and-keyboard's own road to the same write a drag onto a month cell makes. `canRemove`
          is false: this calendar has no unscheduled list for "Remove date" to be the counterpart
          of, and offering the button anyway would be a control that silently did nothing. */}
      {reschedulingEntry === null ? null : (
        <RescheduleDialog
          key={reschedulingEntry.itemId}
          item={toGridItem(reschedulingEntry)}
          dateProperty={COLLATED_DATE_KEY}
          // The end field, and the one-tap lengths with it, for an entry whose calendar has an
          // end property to write them to.
          endDateProperty={
            reschedulingEntry.endProperty !== null && onWrite !== undefined
              ? COLLATED_END_KEY
              : null
          }
          placesByTime={reschedulingEntry.kind === 'timestamp'}
          zone={zone}
          canRemove={false}
          onCancel={() => {
            setRescheduling(null);
          }}
          onMove={(values) => {
            const value = values[COLLATED_DATE_KEY] ?? null;
            const end = values[COLLATED_END_KEY];
            setRescheduling(null);
            if (value === null) {
              return;
            }

            // With an end field drawn, the dialog hands back both and they are written together
            // exactly as drafted - a blank end clears it. Without one it hands back the start
            // alone, and the end, if there is one, travels with it.
            if (
              end !== undefined &&
              reschedulingEntry.endProperty !== null &&
              onWrite !== undefined
            ) {
              onWrite(reschedulingEntry, {
                [reschedulingEntry.dateProperty]: value,
                [reschedulingEntry.endProperty]: end,
              });
              return;
            }
            if (value !== reschedulingEntry.value) {
              moveStart(reschedulingEntry, value);
            }
          }}
        />
      )}
    </div>
  );
}

interface CollatedDayCellProps {
  readonly cell: DayCellSpec;

  /** The cell's accessible name: weekday, day, month and year, spelt out. */
  readonly name: string;
  readonly isToday: boolean;
  readonly entries: readonly CalendarEntry[];

  /** Whether a drop here right now would be taken. */
  readonly over: boolean;
  readonly onDragOver: () => void;
  readonly onDragLeave: () => void;
  readonly onDrop: () => void;
  readonly onOpen: (itemId: string) => void;
  readonly onDragStart: (itemId: string) => void;
  readonly onDragEnd: () => void;
  readonly onReschedule: (itemId: string) => void;

  /** See `CollatedCalendarProps.onComplete`. */
  readonly onComplete?: ((entry: CalendarEntry, occurredOn: string) => void) | undefined;
}

/**
 * One month cell of the collated calendar.
 *
 * Its own component, rather than the inline function `MonthGrid.renderDay` used to be, for the same
 * reason `calendar-view.tsx`'s own `DayCell` is one: the "show N more" disclosure is a fact about a
 * single cell, and a flag held anywhere else would either re-render every cell in the month for one
 * of them opening or have nowhere honest to live.
 */
/** The time of day a timed entry is at, in the reader's zone, or nothing if it cannot be read. */
function timeOf(entry: CalendarEntry): string {
  const moment = readTimestampValue({ value: entry.value }, 'value');
  return moment === null ? '' : moment.at.setZone(readerZone()).toFormat('HH:mm');
}

function CollatedDayCell(props: CollatedDayCellProps): ReactNode {
  const {
    cell,
    name,
    isToday,
    entries,
    over,
    onDragOver,
    onDragLeave,
    onDrop,
    onOpen,
    onDragStart,
    onDragEnd,
    onReschedule,
    onComplete,
  } = props;
  const [expanded, setExpanded] = useState(false);
  const visibleEntries = expanded ? entries : entries.slice(0, MONTH_VISIBLE_ITEMS);
  const hiddenEntries = entries.length - visibleEntries.length;

  return (
    <td
      aria-label={name}
      aria-current={isToday ? 'date' : undefined}
      onDragOver={(event) => {
        // Without this the browser refuses the drop outright, so it runs whether or not this
        // calendar started the drag; the highlight below is what is conditional.
        event.preventDefault();
        onDragOver();
      }}
      onDragLeave={onDragLeave}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      className={cn(
        MONTH_CELL,
        cell.outside ? 'bg-surface/50' : '',
        over ? 'outline-2 -outline-offset-2 outline-accent' : '',
      )}
    >
      <div className="flex h-full flex-col gap-0.5 p-1">
        <DayNumber day={cell.day} isToday={isToday} outside={cell.outside} />

        {visibleEntries.length === 0 ? null : (
          <ul className="flex flex-col gap-0.5">
            {visibleEntries.map((entry) => {
              const title = entry.title ?? '';
              const container = entry.containerTitle ?? 'Untitled';
              const done = entry.completed === true;

              // A generated occurrence has no row of its own - it is drawn from the series, not
              // read from storage - so there is nothing here for a drag or a reschedule write to
              // land on. "Mark done" is the one write this calendar offers it, through the
              // recurrence completion endpoint rather than the item's own properties.
              if (entry.generated) {
                return (
                  <li key={entry.itemId} className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        onOpen(entry.itemId);
                      }}
                      aria-label={`${title}, in ${container}, repeats`}
                      className={cn(
                        focusRing,
                        'min-w-0 flex-1 truncate rounded-sm px-1.5 py-0.5 text-left text-xs',
                        done
                          ? 'bg-muted text-muted line-through'
                          : 'bg-accent/18 hover:bg-accent/25',
                      )}
                    >
                      <Icon
                        icon={Repeat}
                        size="sm"
                        className="mr-1 inline-block align-text-bottom"
                      />
                      {title}
                    </button>

                    {done ? (
                      <span className="shrink-0 px-0.5 py-0.5">
                        <Icon icon={CircleCheck} size="sm" label="Done" />
                      </span>
                    ) : onComplete === undefined ? null : (
                      <Button
                        variant="ghost"
                        aria-label={`Mark ${title || 'Untitled'} done`}
                        className="shrink-0 px-0.5 py-0.5"
                        onClick={() => {
                          onComplete(entry, entry.value.slice(0, 10));
                        }}
                      >
                        <Icon icon={CircleCheck} size="sm" />
                      </Button>
                    )}
                  </li>
                );
              }

              // A daily note is a stored row but its day is what makes it that day's note, so it is
              // drawn as a plain chip that opens: not draggable, with no reschedule control, and
              // without the repeat marks and "Mark done" of an occurrence, which it is not.
              if (isDailyNote(entry)) {
                return (
                  <li key={entry.itemId} className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        onOpen(entry.itemId);
                      }}
                      aria-label={`${title}, in ${container}`}
                      className={`${focusRing} min-w-0 flex-1 truncate rounded-sm bg-accent/18 px-1.5 py-0.5 text-left text-xs hover:bg-accent/25`}
                    >
                      {title}
                    </button>
                  </li>
                );
              }

              return (
                <li key={entry.itemId} className="group/chip relative flex items-center gap-0.5">
                  <button
                    type="button"
                    draggable
                    onDragStart={() => {
                      onDragStart(entry.itemId);
                    }}
                    onDragEnd={onDragEnd}
                    onClick={() => {
                      onOpen(entry.itemId);
                    }}
                    // The container's name is in the accessible name rather than on screen: a day
                    // cell is two centimetres wide, and a reader who needs to know where something
                    // came from needs it said rather than truncated.
                    aria-label={`${title}, in ${container}`}
                    className={`${focusRing} min-w-0 flex-1 truncate rounded-sm bg-accent/18 px-1.5 py-0.5 text-left text-xs hover:bg-accent/25`}
                  >
                    {entry.kind === 'timestamp' ? (
                      <span className="mr-1 text-muted">{timeOf(entry)}</span>
                    ) : null}
                    {title}
                  </button>

                  <Button
                    variant="ghost"
                    aria-label={`Reschedule ${title || 'Untitled'}`}
                    aria-haspopup="dialog"
                    // Shown on hover, on focus and always on a coarse pointer: on every chip at
                    // once it is forty clocks beside forty titles.
                    className="absolute inset-y-0 right-0 rounded-sm bg-background px-0.5 py-0 opacity-0 focus-visible:opacity-100 group-hover/chip:opacity-100 pointer-coarse:opacity-100"
                    onClick={() => {
                      onReschedule(entry.itemId);
                    }}
                  >
                    <Icon icon={CalendarClock} size="sm" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {entries.length <= MONTH_VISIBLE_ITEMS ? null : (
          <Button
            variant="ghost"
            className="self-start px-1 py-0 text-xs"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded((current) => !current);
            }}
          >
            {expanded ? 'Show fewer' : `Show ${String(hiddenEntries)} more`}
          </Button>
        )}
      </div>
    </td>
  );
}
