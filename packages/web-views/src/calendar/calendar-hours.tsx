import { ScrollRegion, Text, cn, focusRing } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import { dayLabel, dayText, type CalendarDay } from '@nix/web-collections/core/calendar-dates';
import type { Item } from '@nix/web-collections/core/container-model';
import { AllDayBand } from './hours/all-day-band';
import { DayColumn } from './hours/day-column';
import { DAY_COLUMN, HOURS, HOUR_GUTTER, ROW_HEIGHT } from './hours/geometry';
import { isAdjustable, placeOn, regionLabel } from './hours/placement';
import { useSpanGesture } from './hours/use-span-gesture';
import { RescheduleDialog } from './reschedule-dialog';
import { useRovingGrid } from './use-roving-grid';

// Kept as this module's export: the tests and the collated calendar import it from here.

/**
 * A day or a week, drawn against the hours.
 *
 * **The grid is the reader's clock, always.** A timestamp keeps the zone it was written in, so an
 * item scheduled for 09:00 in London is not at 09:00 for somebody in Honolulu - it is at 23:00 the
 * evening before. Placing it without converting would put it in the right-looking slot for whoever
 * wrote it and the wrong one for everybody else, and it would look correct from the author's desk.
 *
 * An item whose zone differs from the reader's says so on the card. One whose zone matches says
 * nothing extra: repeating "Europe/London" beside every entry for somebody in London trains people
 * to stop reading it, and then it is not there when it matters.
 *
 * **All-day items are not on the grid.** A `date` property means "the 3rd" and has no hour to be
 * placed at; converting one into a moment to find a row is precisely the bug the date type exists
 * to avoid. They sit in a band above the hours, where a calendar has always put them.
 */

export interface HourGridProps {
  /** The days across the top. One for a day view, seven for a week. */
  readonly days: readonly CalendarDay[];

  /** Everything the container holds that this grid might place. */
  readonly items: readonly Item[];

  /**
   * Every child of the container, unfiltered, for the reschedule dialog's free-slot suggestion -
   * or undefined when the caller cannot vouch for the whole set (a truncated container, or the
   * collated calendar reading across several), and then no slot is offered.
   */
  readonly siblings?: readonly Item[] | undefined;

  /** The property that places an item. */
  readonly dateProperty: string;

  /**
   * The property that closes a placed item's span, or null when the view has none configured.
   *
   * Threaded through to `placeOn`, which draws an item that has one as a bar reaching from its
   * start to its end rather than as a point, and to the reschedule dialog, which is where that
   * end gets written.
   */
  readonly endDateProperty?: string | null;

  /** The clock the grid is drawn in. */
  readonly zone: string;

  /** Today, as `yyyy-MM-dd` in the reader's zone, for marking the column. */
  readonly today: string;

  readonly onOpen: (itemId: string) => void;
  /**
   * Adds an item to the day or slot it is offered on.
   *
   * Optional, and absent means the grid offers no way to create. The collated calendar reads across
   * containers, so "create here" has no answer - there is no one container a new item would belong
   * to. A control that appeared and did nothing would be worse than no control.
   */
  readonly onCreate?:
    ((title: string, properties?: Record<string, unknown>) => Promise<string | null>) | undefined;

  /**
   * The item a pointer is currently dragging, or null.
   *
   * Read from the calendar rather than from `dataTransfer`, for the reason `board-view.tsx` gives:
   * the payload a drag starts with is not readable during `dragover`, so a slot cannot decide
   * whether to light up from the event alone.
   */
  readonly dragged: string | null;

  /**
   * Reschedules an item onto the slot it was dropped on, or onto the draft the reschedule dialog
   * was submitted with.
   *
   * Takes a bag of properties rather than a bare value, because the dialog may write two - the
   * start and, when this grid was given `endDateProperty`, the end - as one edit. A drop still
   * writes only `dateProperty`; the bag has one key either way.
   *
   * Optional, and absent means the grid accepts no drops. Paired with `dragged`, which is null for
   * the same caller - a grid that took a drop it could not write would silently discard it.
   */
  readonly onMove?: ((itemId: string, values: Record<string, string | null>) => void) | undefined;

  /**
   * Items this grid draws but may not move: no drag, no stretch, no reschedule control. The
   * collated calendar names its generated occurrences here, which have no row of their own to
   * write to. An event its calendar marks read-only is fixed without being named.
   */
  readonly fixedItemIds?: ReadonlySet<string> | undefined;

  /**
   * Gives the calendar an end property. Passed only while it has none; each item's menu then
   * offers it, since that menu is where a reader who tried to stretch an item and could not goes
   * looking for why.
   */
  readonly onAddEndProperty?: ((itemId: string) => void) | undefined;

  /**
   * Items whose own calendar has no end property, on a grid that otherwise has one.
   *
   * Only the collated calendar needs this: it draws items from many calendars at once, some with
   * ends and some without. An item named here has no foot to stretch and is offered
   * {@link onAddEndProperty} instead, exactly as every item is on a grid with no end property.
   */
  readonly endlessItemIds?: ReadonlySet<string> | undefined;
}

export function HourGrid(props: HourGridProps): ReactNode {
  const {
    days,
    items,
    dateProperty,
    endDateProperty = null,
    zone,
    today,
    onOpen,
    onCreate,
    dragged,
    onMove,
    siblings,
    fixedItemIds,
    onAddEndProperty,
    endlessItemIds,
  } = props;

  const adjustable = (item: Item): boolean =>
    isAdjustable(item) && fixedItemIds?.has(item.id) !== true;

  // One tab stop for all 168 hour-slot create controls, with the arrow keys moving which slot it
  // is: Up and Down walk the hours, Left and Right walk the days, Home and End jump to the first
  // and last day at the same hour, and Ctrl with either to midnight on the first day and 23:00 on
  // the last. See the hook's own doc for the APG mapping and for why the tabindex is managed from
  // here rather than by each control.
  const { containerRef, onKeyDown, onFocusCapture } = useRovingGrid(HOURS.length, days.length);

  // Which placed item's reschedule dialog is open, or null. Held here rather than per column: a
  // week has seven `DayColumn`s and the dialog is one modal, not seven that would have to agree
  // which of them owns it.
  const [rescheduling, setRescheduling] = useState<string | null>(null);
  const reschedulingItem =
    rescheduling === null ? null : (items.find((item) => item.id === rescheduling) ?? null);

  const { gesture, beginGesture, suppressClick } = useSpanGesture({
    days,
    zone,
    dateProperty,
    endDateProperty,
    onMove,
    adjustable,
  });

  return (
    <div data-hour-grid="" className="flex min-h-0 flex-1 flex-col">
      {/*
       * One scroll container for the whole grid, on both axes, rather than the header and the
       * all-day band scrolling through an outer frame while the hour body scrolls through a nested
       * one of its own. CSS ties `overflow-x` and `overflow-y` together the moment either leaves
       * `visible`: an element given `overflow-y-auto` and no opinion on `overflow-x` does not let
       * its horizontal content spill out to a wider ancestor's scrollbar - it silently computes its
       * own `overflow-x` to `auto` and clips right there instead. Two scroll boundaries for content
       * that has to move together as one grid would mean two scrollbars that can drift out of sync,
       * with the day headers no longer lined up over the hours they name. So the header, the
       * all-day band and the hour rows all live inside this single scroller, and staying in view
       * while it scrolls is `sticky`'s job below rather than a second scroller's.
       *
       * `role="region"` plus a tab stop, matching timeline-view.tsx's own scrollable track: without
       * one, this content is reachable only by dragging a scrollbar, which a keyboard user does not
       * have.
       */}
      <ScrollRegion
        aria-label={regionLabel(days)}
        className={cn('min-h-0 flex-1 overflow-auto', focusRing)}
      >
        {/* The one element whose own box actually spans the true scroll-content width. `min-w-max`
            asks it to be at least as wide as its content's max-content size - and that size is now
            trustworthy because every `DAY_COLUMN` inside carries `[contain:inline-size]`, so a long
            title cannot inflate it. The sticky header block and the hour body both have to sit
            inside this same width owner: a `sticky` element's containing block is its nearest
            scrolling ancestor, but its *edge* only reaches as far as this box actually extends, so
            without a shared wide ancestor the header's background and the gutter's sticky
            positioning would both stop at the scroller's own (narrower) viewport width instead of
            the real scrolled extent. */}
        <div className="min-w-max">
          {/* Pinned to the top of the scroller as the hour rows scroll past beneath it - the same
              frozen header a spreadsheet gives its column titles. Both rows sit inside one sticky
              block, rather than each being sticky on its own, so nothing has to know the header's
              rendered height to place the all-day band directly under it. */}
          <div className="sticky top-0 z-20 bg-surface">
            <div className="flex">
              <span aria-hidden="true" className={HOUR_GUTTER} />

              {days.map((day) => (
                <div key={dayText(day)} className={cn(DAY_COLUMN, 'px-1 py-1 text-center')}>
                  <Text
                    variant="caption"
                    as="span"
                    tone={dayText(day) === today ? 'accent' : 'muted'}
                  >
                    {dayLabel(day)}
                  </Text>
                </div>
              ))}
            </div>

            <AllDayBand
              days={days}
              items={items}
              dateProperty={dateProperty}
              onOpen={onOpen}
              onCreate={onCreate}
            />
          </div>

          {/* The roving container: keydown and focus are watched from here because the slots
              inside come and go as their create fields open, while this element is the one stable
              ancestor they all share. It is not itself interactive - the handlers only steer
              which of the buttons inside is the tab stop - which is what the rule below cannot
              see from the outside. */}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Justification: the handlers implement a roving tabindex over the buttons inside; the element itself is never a target and gets no role, no tab stop and no name. */}
          <div
            ref={containerRef}
            onKeyDown={onKeyDown}
            onFocusCapture={onFocusCapture}
            className="flex"
          >
            <div className={HOUR_GUTTER}>
              {HOURS.map((hour) => (
                <div
                  key={hour}
                  style={{ height: `${String(ROW_HEIGHT)}px` }} // design-token-exempt: an hour's height is the grid's unit; the labels must share it exactly or the columns drift apart down the day
                  className="pr-1 text-right"
                >
                  <Text variant="caption" as="span" tone="muted">
                    {`${String(hour).padStart(2, '0')}:00`}
                  </Text>
                </div>
              ))}
            </div>

            {days.map((day, dayIndex) => (
              <DayColumn
                key={dayText(day)}
                day={day}
                dayIndex={dayIndex}
                placed={placeOn(day, items, dateProperty, endDateProperty, zone)}
                dateProperty={dateProperty}
                zone={zone}
                onOpen={onOpen}
                onCreate={onCreate}
                dragged={dragged}
                onMove={onMove}
                onReschedule={onMove === undefined ? undefined : setRescheduling}
                onAddEnd={onAddEndProperty}
                endless={(item) =>
                  endDateProperty === null || endlessItemIds?.has(item.id) === true
                }
                adjustable={adjustable}
                gesture={gesture}
                onGesture={onMove === undefined ? undefined : beginGesture}
                suppressClick={suppressClick}
              />
            ))}
          </div>
        </div>
      </ScrollRegion>

      {/* One dialog, at the root of the grid, for whichever placed item asked. Placed items used
          to answer only to `onOpen` - a click opened the item, and there was no way to move it
          except to drag it, which a keyboard and a touch screen alike cannot do. This reaches the
          same write `onMove` makes for a drop, from a tap or from the keyboard. */}
      {reschedulingItem === null || onMove === undefined ? null : (
        <RescheduleDialog
          key={reschedulingItem.id}
          item={reschedulingItem}
          dateProperty={dateProperty}
          endDateProperty={endDateProperty}
          // Every item this grid places has a moment on `dateProperty` - `placeOn` below reads one
          // to decide the row, so nothing reaches this dialog without one. The end field, when the
          // view has one, is assumed to be the same shape - see `RescheduleDialogProps.endDateProperty`.
          placesByTime
          siblings={siblings}
          zone={zone}
          onCancel={() => {
            setRescheduling(null);
          }}
          onMove={(values) => {
            onMove(reschedulingItem.id, values);
            setRescheduling(null);
          }}
        />
      )}
    </div>
  );
}
