import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { Blueprint, Button, Text } from '@nix/ui';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { useState, type ReactNode } from 'react';

import { ShownItems } from '../core/item-selection-context';
import type { PropertyValue, View } from '../core/container-model';
import { CreateItemControl } from '../core/create-item-control';
import {
  addDays,
  daysInMonth,
  dayText,
  monthLabel,
  monthPrefix,
  shiftMonth,
  weekOf,
  type CalendarDay,
  type CalendarMonth,
} from '../core/calendar-dates';
import { HourGrid } from './calendar-hours';
import { EndTimeHint } from './hours/end-time-hint';
import { MonthGrid, buildWeeks } from './month-grid';
import { RescheduleDialog } from './reschedule-dialog';
import { VIEW_GUTTER_BLEED } from '../core/view-gutter';
import { readTimestampValue, readerZone } from '../core/timestamps';
import type { ContainerData } from '../core/use-container';
import { drawable, undrawable, useViewChrome } from '../core/view-chrome';
import { useViewState } from '../core/view-state';
import { PhoneAgenda } from './agenda/phone-agenda';
import type { CardContext } from './item/card-context';
import { RovingMonth } from './month/roving-month';
import { MonthDots } from './month/month-dots';
import { DayCell } from './month/day-cell';
import { NO_DATE_PROPERTY, describeUnrenderable } from './model/describe-unrenderable';
import {
  daysBetween,
  readDayValue,
  readMode,
  shiftDateText,
  today,
  todayDay,
} from './model/day-math';
import { bucketItems } from './model/bucket-items';
import { CalendarToolbar } from './toolbar/calendar-toolbar';
import { UnscheduledList } from './unscheduled/unscheduled-list';

/**
 * A container's children on a month grid, placed by the view's date property.
 *
 * **Placement is a text comparison, start to finish.** Dates are stored as `yyyy-MM-dd` with no
 * time and no zone precisely so that a property meaning "the 3rd" is the 3rd for everybody, and the
 * moment this file turned one of those strings into a `Date` to decide a cell, it would stop being
 * true: `new Date('2026-03-01')` is UTC midnight, which is the 28th of February for every reader
 * west of Greenwich. So the grid is built from integer arithmetic on the year and month numbers,
 * each cell knows its own `yyyy-MM-dd` text, and an item lands in the cell whose text equals its
 * property. No `Date` is ever constructed from a stored value - the only clock reading in this file
 * is "what is today where this person is sitting", which is a local question and is asked once.
 *
 * **Where an item sits is its date.** Dragging a card to a day and using the per-item reschedule
 * control do the same single thing: write the date property. Nothing about placement is view-local,
 * so two people looking at the same folder through different views cannot disagree about when
 * something is due.
 *
 * **The keyboard path is not a courtesy.** A calendar whose only way to move an item is a drag is a
 * calendar a person using a keyboard or a screen reader cannot operate at all, so every card
 * carries a reschedule control that reaches the same write.
 *
 * **An item with an `endDateProperty` covers every day between the two, drawn on each one**
 * (`spanDates`), rather than only on its start day with a marker saying it continues. A month
 * cell is already a list of cards, not a single-line row a bar could stretch across the way
 * timeline-view.tsx draws one, so showing the same card again on every covered day costs this
 * file one loop and no new layout, and is the one rendering that agrees with "where an item sits
 * is its date" above for a date range rather than a single date.
 */

export interface CalendarViewProps {
  readonly container: ContainerData;
  readonly view: View;

  /** Opens an item. A callback rather than a router import: this component does not own routing. */
  readonly onOpen: (itemId: string) => void;
}

export function CalendarView(props: CalendarViewProps): ReactNode {
  const { container, view, onOpen } = props;
  const narrow = useNarrowViewport();
  const [gridWanted, setShowGrid] = useState(false);
  // The day chosen on the phone's month strip; null shows the whole month.
  const [picked, setPicked] = useState<string | null>(null);
  const viewState = useViewState();
  const { mode: urlMode, setMode } = viewState;

  /*
   * Which month is on screen is local state, and deliberately not in the URL.
   *
   * The URL carries what somebody decided about the data - which view, sorted how, filtered to
   * what - because those are the things a person means to send when they paste a link. The month is
   * not one of them: it is a scroll position through time. Putting it in the URL would freeze every
   * recipient of every link on whichever month the sender happened to have paged to, so a link
   * shared in March would still open on March in June, and the reader would have to notice and
   * correct it before believing anything on the screen.
   */
  const [anchor, setAnchor] = useState<CalendarDay>(todayDay);
  const month: CalendarMonth = { year: anchor.year, month: anchor.month };

  function setMonth(next: CalendarMonth | ((current: CalendarMonth) => CalendarMonth)): void {
    setAnchor((current) => {
      const asMonth = { year: current.year, month: current.month };
      const chosen = typeof next === 'function' ? next(asMonth) : next;

      // Clamped, because the 31st does not exist in every month and an anchor that fell off the end
      // would silently roll into the next one.
      return {
        ...chosen,
        day: Math.min(current.day, daysInMonth(chosen)),
      };
    });
  }
  const [dragged, setDraggedState] = useState<{
    readonly id: string;
    readonly from: string | null;
  } | null>(null);

  function setDragged(itemId: string, occurrenceDate: string | null): void {
    setDraggedState({ id: itemId, from: occurrenceDate });
  }
  const [rescheduling, setRescheduling] = useState<string | null>(null);

  const reason = describeUnrenderable(view, container.schema, container.views);
  const configured = view.dateProperty;

  const chrome = useViewChrome({
    container,
    viewState,
    subject: 'this calendar',
    drawable:
      configured === null || reason !== null
        ? undrawable<string>({
            title: 'This calendar cannot be drawn',
            detail: reason ?? NO_DATE_PROPERTY,
          })
        : drawable(configured),
    emptyTitle: 'Nothing in here yet',
    emptyDetail:
      'There is nothing to place on a calendar yet. Items added to this one will appear on the day their date says.',
    // Made without a date, so it lands in the unscheduled list rather than on a day nobody picked.
    emptyAction: <CreateItemControl label="Add the first item" onCreate={container.create} />,
    filtered: (total) => ({
      title: 'No items match the current filters',
      detail: `This holds ${String(total)} items, and the filters in the address hide every one of them. Clearing the filters brings them back.`,
    }),
    // A calendar is ordered by the grid, not by a column header: within a day, items keep the order
    // somebody arranged them in.
    savedRules: view.filters,
    view,
    sortBy: null,
    descending: false,
  });

  if (chrome.kind === 'chrome') {
    return chrome.node;
  }

  // Named with its type stated so the closures below see a key rather than a maybe-key: a narrowing
  // does not follow a `const` into a function that is created later in the body.
  const dateProperty: string = chrome.drawable;
  const items = chrome.items;

  // Read before the buckets are filled, because which day a timestamp falls on is a question about
  // the reader, not about the value.
  const zone = readerZone();

  // Whether this calendar places by a moment or by a day, as the declared type: the default the
  // reschedule dialog falls back to for an item with nothing stored yet (see
  // `reschedulingPlacesByTime`, which a date-or-time property's per-item value can override). A
  // container with no schema cannot be asked, and a bare date is the safer assumption: it is what
  // the month grid and every existing stored value already use.
  const placesByTime =
    container.schema?.properties.find((property) => property.key === dateProperty)?.type ===
    'timestamp';

  // The view's own end-of-span property, when it has one - see `RescheduleDialogProps.endDateProperty`
  // for why the calendar's end field assumes the same shape as `dateProperty` rather than checking
  // its own type against the schema. Read before the buckets are filled: a multi-day item's own
  // bucketing below needs it.
  const endDateProperty = view.endDateProperty;

  // Whether this calendar can be given an end property from here. It needs a schema to add one
  // to and a start property to copy the shape of - the end has to be the same kind of value as
  // the start, a day or a moment, or the two could not be compared. A computed start (a formula)
  // has no shape a stored end could share, and a locked container takes no schema change.
  const startDefinition = container.schema?.properties.find(
    (property) => property.key === dateProperty,
  );
  const canAddEnd =
    endDateProperty === null && !container.locked && startDefinition?.expression === null;

  /**
   * Gives the calendar an end property and points this view at it, in one write.
   *
   * One write rather than a schema change followed by a view change: done in two, a failure
   * between them would leave a property nothing uses, and the reader with no sign of why items
   * still cannot be stretched.
   */
  async function addEndProperty(): Promise<void> {
    const schema = container.schema;
    if (!canAddEnd || schema === null) {
      return;
    }

    const taken = new Set(schema.properties.map((property) => property.key));
    let key = 'end';
    for (let suffix = 2; taken.has(key); suffix += 1) {
      key = `end_${String(suffix)}`;
    }

    const refusal = await container.replaceViewSetup(
      view.id,
      [...schema.declared, { ...startDefinition, key, label: 'End', required: false }],
      [{ ...view, endDateProperty: key }],
    );
    publishNotice({
      key: `calendar-end:${view.id}`,
      message:
        refusal ??
        'This calendar now has end times. Drag the foot of an item, or use Reschedule, to set how long it runs.',
    });
  }

  const prefix = monthPrefix(month);
  const { byDate, unscheduled, elsewhere } = bucketItems(
    items,
    dateProperty,
    endDateProperty,
    zone,
    prefix,
  );
  // The first configured column that is neither the title nor the date: what a card can usefully
  // say about itself in the two centimetres a day cell affords.
  const secondaryKey = view.columns.find((key) => key !== dateProperty && key !== 'title') ?? null;
  const secondaryProperty =
    secondaryKey === null
      ? null
      : (container.schema?.properties.find((property) => property.key === secondaryKey) ?? null);

  function moveTo(itemId: string, values: Record<string, string | null>): void {
    void container.setProperties(itemId, values);
    setRescheduling(null);
    setDraggedState(null);
  }

  /**
   * What a drop onto a day writes: the whole span shifted together when the item has one, or just
   * the date property when it does not - see `CardContext.dropOnDate`'s own note for why.
   */
  function dropOnDate(itemId: string, from: string | null, to: string): void {
    if (from !== null && from !== to && endDateProperty !== null) {
      const item = items.find((entry) => entry.id === itemId);
      const start = item === undefined ? null : readDayValue(item, dateProperty, zone);
      const end = item === undefined ? null : readDayValue(item, endDateProperty, zone);

      if (start !== null && end !== null && end > start) {
        const delta = daysBetween(from, to);
        const shiftedStart = delta === null ? null : shiftDateText(start, delta);
        const shiftedEnd = delta === null ? null : shiftDateText(end, delta);

        if (shiftedStart !== null && shiftedEnd !== null) {
          moveTo(itemId, { [dateProperty]: shiftedStart, [endDateProperty]: shiftedEnd });
          return;
        }
      }
    }

    moveTo(itemId, { [dateProperty]: to });
  }

  /** What a drop into the unscheduled list, or the dialog's own "Remove date", both write. */
  function clearedDate(): Record<string, string | null> {
    return endDateProperty === null
      ? { [dateProperty]: null }
      : { [dateProperty]: null, [endDateProperty]: null };
  }

  const card: CardContext = {
    onOpen,
    setRescheduling,
    setDragged,
    clearDragged: () => {
      setDraggedState(null);
    },
    moveTo,
    dropOnDate,
    dateProperty,
    zone,
    secondaryKey,
    secondaryProperty,
    onWrite: (itemId: string, propertyKey: string, value: PropertyValue) =>
      container.setProperties(itemId, { [propertyKey]: value }),
    onCreate: container.create,
  };

  // The item the reschedule dialog is open for, resolved from the id rather than stored as an
  // item: the id survives the item's own data changing under it, and a stale copy would show a
  // date the grid no longer agrees with.
  const reschedulingItem =
    rescheduling === null ? null : (items.find((item) => item.id === rescheduling) ?? null);

  // A date-or-time property holds either shape per item, unlike a plain `date` or `timestamp`
  // property, which is the same shape on every item. So the dialog's own control is chosen from
  // what this item currently holds - a moment, if it has one - and only falls back to the
  // property's declared type when there is nothing stored yet to go by.
  const reschedulingPlacesByTime =
    reschedulingItem !== null &&
    readTimestampValue(reschedulingItem.properties, dateProperty) !== null
      ? true
      : placesByTime;

  // One clock reading for the whole grid rather than one per cell: the answer cannot change
  // halfway through a render, and forty-two of them would be forty-two allocations for one fact.
  const todayText = today().text;

  // The view's own grain, overridable by the address the way the view itself is - a link saying
  // "look at this week" should open on a week.
  const mode = readMode(urlMode ?? view.mode);
  // The phone's month strip already is the month, so the grid toggle only exists for week and day.
  const showGrid = gridWanted && mode !== 'month';
  const shownDates = new Set(
    narrow && !showGrid && picked !== null
      ? [picked]
      : narrow && !showGrid && mode === 'month'
        ? [...byDate.keys()].filter((date) => date.startsWith(prefix))
        : mode === 'month'
          ? buildWeeks(month).flatMap((week) => week.map((cell) => cell.date))
          : mode === 'week'
            ? weekOf(anchor).map(dayText)
            : [dayText(anchor)],
  );
  const shownItems = [
    ...new Set([
      ...unscheduled.map((item) => item.id),
      ...[...byDate]
        .filter(([date]) => shownDates.has(date))
        .flatMap(([, dated]) => dated.map((item) => item.id)),
    ]),
  ];

  /** One step of whatever is on screen: a month, a week, or a day. */
  function step(delta: number): void {
    setPicked(null);
    if (mode === 'month') {
      setMonth(shiftMonth(month, delta));
      return;
    }

    setAnchor((current) => addDays(current, delta * (mode === 'week' ? 7 : 1)));
  }

  return (
    // gap-3, matching the board's, the gallery's and the timeline's own root wrapper: all four are
    // the same shape - an optional error, a header row, then the view's content - and this was the
    // one drawn one step further apart than the rest for no stated reason.
    <div className="flex min-w-0 flex-col gap-3">
      <ShownItems ids={shownItems} />
      {container.writeError === null ? null : (
        // Alongside the calendar rather than instead of it: the write was refused and the item has
        // already been put back where it was, so the grid is correct and only the reason is missing.
        <div role="alert" className="border border-divider p-3">
          <Text variant="bodySmall">{container.writeError}</Text>
        </div>
      )}

      <CalendarToolbar
        mode={mode}
        month={month}
        anchor={anchor}
        onMode={(grain) => {
          setPicked(null);
          setMode(grain);
        }}
        onCreate={container.create}
        onStep={step}
        onToday={() => {
          setPicked(null);
          setAnchor(todayDay());
        }}
      />

      {/* What the address is hiding, said separately from what the grid is: one is a filter
          somebody set, the other is a month somebody paged away from. */}
      {chrome.notice}

      {elsewhere === 0 ? null : (
        // A month grid can only show a month. Saying how much is off-screen is the difference
        // between a calendar and a calendar that appears to have lost things.
        <div role="status">
          <Text variant="caption" tone="muted">
            {elsewhere === 1
              ? `1 item is dated outside ${monthLabel(month)}.`
              : `${String(elsewhere)} items are dated outside ${monthLabel(month)}.`}
          </Text>
        </div>
      )}

      {narrow && mode !== 'month' ? (
        <Button
          variant="ghost"
          aria-pressed={showGrid}
          onClick={() => {
            setShowGrid(!showGrid);
          }}
        >
          {showGrid ? 'Show agenda' : 'Show calendar grid'}
        </Button>
      ) : null}
      {narrow && !showGrid ? (
        <>
          {mode === 'month' ? (
            <MonthDots
              month={month}
              todayText={todayText}
              byDate={byDate}
              picked={picked}
              onPick={setPicked}
            />
          ) : null}
          <PhoneAgenda
            byDate={byDate}
            mode={mode}
            prefix={prefix}
            anchor={anchor}
            card={card}
            picked={mode === 'month' ? picked : null}
          />
        </>
      ) : mode === 'month' ? (
        <RovingMonth weeks={buildWeeks(month).length}>
          <MonthGrid
            month={month}
            todayText={todayText}
            prefix={prefix}
            // The container's gutter is bled into the scroller so those pixels belong to the scroll
            // viewport rather than to the chrome around it - `VIEW_GUTTER_BLEED` owns the negative
            // margin and the padding together, so the two cannot become different numbers. The
            // collated calendar has no gutter to bleed, which is why this is the caller's to pass.
            regionClassName={VIEW_GUTTER_BLEED}
            renderDay={(cell, name, isToday) => (
              <DayCell
                key={cell.date}
                cell={cell}
                name={name}
                isToday={isToday}
                items={byDate.get(cell.date) ?? []}
                dragged={dragged}
                card={card}
              />
            )}
          />
        </RovingMonth>
      ) : (
        <>
          {/* Said out loud, because the alternative is a foot that is simply not there: without
              an end property an item is a point, there is nowhere to write a length, and a reader
              trying to stretch one would find nothing to take hold of and no reason why. */}
          {endDateProperty === null ? (
            <EndTimeHint
              canAddEnd={canAddEnd}
              onAdd={() => {
                void addEndProperty();
              }}
            />
          ) : null}
          <Blueprint className="flex min-h-[520px] flex-col overflow-hidden p-0">
            <HourGrid
              days={mode === 'week' ? weekOf(anchor) : [anchor]}
              items={items}
              siblings={container.truncated ? undefined : container.children}
              dateProperty={dateProperty}
              endDateProperty={endDateProperty}
              zone={zone}
              today={todayText}
              onOpen={onOpen}
              onCreate={container.create}
              dragged={dragged?.id ?? null}
              onMove={moveTo}
              onAddEndProperty={
                canAddEnd
                  ? () => {
                      void addEndProperty();
                    }
                  : undefined
              }
            />
          </Blueprint>
        </>
      )}

      <UnscheduledList
        items={unscheduled}
        card={card}
        dragged={dragged}
        onClear={(itemId) => {
          moveTo(itemId, clearedDate());
        }}
      />

      {/* One dialog, rendered at the root, for whichever card asked. It used to be an inline form
          swapped into the card's place, which inside a month cell meant a native date input asked
          to draw itself in a `w-[6.5rem]` column - narrower than the ~120px the control needs, so
          the date being edited was not on screen. Keyed by item so a different card's dialog
          starts with its draft and errors fresh. */}
      {reschedulingItem === null ? null : (
        <RescheduleDialog
          key={reschedulingItem.id}
          item={reschedulingItem}
          dateProperty={dateProperty}
          endDateProperty={endDateProperty}
          placesByTime={reschedulingPlacesByTime}
          siblings={container.truncated ? undefined : container.children}
          zone={zone}
          onCancel={() => {
            setRescheduling(null);
          }}
          onMove={(values) => {
            moveTo(reschedulingItem.id, values);
          }}
        />
      )}
    </div>
  );
}
