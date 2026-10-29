import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { Blueprint, Button, Icon, Text, cn, focusRing } from '@nix/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { PartialNotice } from '@nix/web-foundation/components/states/status-panels';
import { todayDay } from '../../collections/core/day-math';
import { ShownItems } from '../../collections/core/item-selection-context';
import { dayText, type CalendarDay } from '../../collections/core/calendar-dates';
import { CreateItemControl } from '../core/create-item-control';
import { buildWindow, readScale, stepAnchor, type TimelineScale } from './timeline-scale';
import { drawable, undrawable, useViewChrome } from '../core/view-chrome';
import type { ViewRendererProps } from '../core/view-kinds';
import { useViewState } from '../../collections/core/view-state';
import { readerZone } from '../../collections/core/timestamps';
import {
  NO_START_PROPERTY,
  byId,
  describeLostEndProperty,
  describeUndrawable,
  describeWhere,
  place,
  propertyWord,
  titleOf,
  type AsideContext,
} from './timeline-model';
import { TimelineAgenda } from './timeline-agenda';
import { OffAxisList } from './timeline-off-axis';
import { RescheduleFields } from './timeline-reschedule';
import { TimelineTable } from './timeline-table';

/**
 * A container's children as bars across a time axis, placed by a start date and an optional end.
 *
 * **All of the arithmetic is in `timeline-scale.ts` and none of it is here.** Which column a day
 * falls in, how many columns a quarter takes, and whether a span misses the window entirely are
 * questions that can be asked directly of that module; asked of this one they could only be
 * answered by counting cells on a rendered screen. Nothing in this file constructs a `Date` from a
 * stored value, for the reason the calendar's header sets out at length: `new Date('2026-03-01')`
 * is UTC midnight, which is the previous day for every reader west of Greenwich.
 *
 * **The start is `dateProperty` - the calendar's field, under the calendar's name.** That is what
 * makes switching a view between calendar and timeline lossless, and it is why there is no
 * `startDateProperty` anywhere in the system. The end is a second field and is genuinely optional.
 *
 * **Five things can be true of an item that a bar cannot draw, and each gets its own sentence**,
 * because collapsing any two of them puts something untrue on the screen:
 *
 *   - *A start and no end.* A milestone: a marker on the start day. Not a zero-width bar, and
 *     emphatically not a bar drawn to today - extending it would invent an end date nobody entered,
 *     and it would grow every morning.
 *   - *An end before its start.* Neither swapped nor clamped. It is stated in a band below the
 *     grid, showing both dates, with the same reschedule control the bars have. Swapping would
 *     silently correct a data error somebody may need to see; the server does not refuse the pair
 *     either, because two independent property writes cannot both be valid at every instant.
 *   - *Entirely outside the window.* Counted above the grid and listed below it, so it stays
 *     reachable. A window is a scroll position through time and an item is not less real for being
 *     off it. A bar that only partly overlaps is drawn clipped, with a marker at the cut end - and
 *     its accessible name carries the dates it really has, never the ones it was truncated to.
 *   - *No start at all.* The unscheduled list, exactly as the calendar keeps one. A timeline that
 *     dropped undated items would lose half a folder without saying so.
 *   - *A start that is not a date.* Its own band, and told apart from the one above deliberately.
 *     Retyping a text property to Date does not revalidate what is already stored, so `starts:
 *     "next Tuesday"` is reachable, and filing it under "no start date yet" would send somebody
 *     looking for a value that is sitting right there. `PropertyInput` already refuses to overwrite
 *     such a value; this refuses to misdescribe it.
 *
 * **The bars are read-only in this build, and the keyboard path is the only path.** There is no
 * drag-a-range primitive anywhere in this application - the board and the calendar's month grid
 * both drag a *point*, and the hour grid has no drag at all - and a range needs pointer capture, a
 * ghost, snap-to-day arithmetic and an edge-versus-body hit test. That is a goal of its own. Both
 * views that do have a drag also have keyboard parity, so shipping a drag here without one would be
 * the first break in that pattern. What ships instead is the reschedule disclosure every item
 * carries, which reaches the same two writes a drag eventually will.
 *
 * **There is no `writeError` banner here, and that is a decision rather than an omission.**
 * `useContainer` answers a refused write on two channels - the returned reason, and the
 * `writeError` field - and its contract says a caller reads one and never both. The second exists
 * for a gesture nobody awaits: a dragged card has already snapped back and is not a place to put a
 * sentence. Every write this view makes is awaited, so the refusal goes in the field that caused
 * it, and a banner as well would say the same thing twice in two places at once.
 */

export function TimelineView(props: ViewRendererProps): ReactNode {
  const { container, view, onOpen } = props;
  const viewState = useViewState();
  const { mode: urlMode, setMode } = viewState;

  /*
   * Which stretch of time is on screen is local state, and deliberately not in the URL.
   *
   * The address carries what somebody decided about the data - which view, at what grain, sorted
   * how, filtered to what - because those are the things a person means to send when they paste a
   * link. The window is not one of them: it is a scroll position through time. In the address, a
   * link shared in March would still open on March in June, and every recipient would have to
   * notice and correct it before believing anything on the screen. The grain *is* in the address,
   * for the opposite reason: "look at this quarter" is a decision worth sending.
   */
  const narrow = useNarrowViewport();
  const [anchor, setAnchor] = useState<CalendarDay>(todayDay);
  const [rescheduling, setRescheduling] = useState<string | null>(null);
  const panelId = useId();

  // A tab stop of its own and a place `scrollIntoView` can point at. Narrow renders the panel
  // below the whole agenda list rather than beside the row that opened it (`~318` versus `~374`
  // below), and moving neither the scroll position nor the focus left it looking dead - opened,
  // yet nowhere a phone screen or the keyboard's own place would put it.
  const panelRef = useRef<HTMLElement>(null);

  // Runs after the panel that opened it has already committed to the DOM - `rescheduling` and the
  // section below are set from the same click, so by the time this effect runs the ref is live.
  // Every toggle in the view points at this one panel, so one effect covers all of them rather
  // than each row having to know it should move focus itself.
  useEffect(() => {
    if (rescheduling !== null) {
      panelRef.current?.focus();
      panelRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [rescheduling]);

  const reason = describeUndrawable(view, container.schema, container.views);

  const chrome = useViewChrome({
    container,
    viewState,
    subject: 'this timeline',
    drawable:
      view.dateProperty === null || reason !== null
        ? undrawable<string>({
            title: 'This timeline cannot be drawn',
            detail: reason ?? NO_START_PROPERTY,
          })
        : drawable(view.dateProperty),
    emptyTitle: 'Nothing in here yet',
    emptyDetail:
      'There is nothing to put on a timeline yet. Items added to this one appear on the days their dates name.',
    // Made without dates, so it lands in the unscheduled list rather than on a day nobody picked.
    emptyAction: <CreateItemControl label="Add the first item" onCreate={container.create} />,
    filtered: (total) => ({
      title: 'No items match the current filters',
      detail:
        total === 1
          ? 'This holds one item, and the filters in the address hide it. Clearing the filters brings it back.'
          : `This holds ${String(total)} items, and the filters in the address hide every one of them. Clearing the filters brings them back.`,
    }),
    // Rows, unlike calendar cells, are a list and have an order worth choosing - so a sort in the
    // address or on the view decides it, and sibling order is what somebody arranged by hand when
    // neither says anything. The calendar pins this to null because a day cell is not a list.
    savedRules: view.filters,
    view,
    sortBy: viewState.sortBy ?? view.sortBy,
    descending:
      viewState.sortBy === null ? view.sortDescending : viewState.direction === 'descending',
  });

  if (chrome.kind === 'chrome') {
    return chrome.node;
  }

  // Named with its type stated so the closures below see a key rather than a maybe-key: a narrowing
  // does not follow a `const` into a function created later in the body.
  const startKey: string = chrome.drawable;
  const endKey: string | null = view.endDateProperty;

  // The view's own grain, overridable by the address the way the view itself is - a link saying
  // "look at this quarter" should open on a quarter. A grain left behind by a calendar that this
  // view has no meaning for falls back rather than being refused; see `readScale`.
  const scale = readScale(urlMode ?? view.mode);

  // `axis`, never `window`: a local called `window` shadows the DOM global for the whole of this
  // function body, and `window.name` and `window.length` both type-check against the wrong object.
  const axis = buildWindow(scale, anchor);
  const zone = readerZone();

  const placed = chrome.items.map((item) => place(item, startKey, endKey, zone, axis));

  const rows = placed.filter(
    (entry) => entry.placement.kind === 'span' || entry.placement.kind === 'milestone',
  );
  const reversed = placed.filter((entry) => entry.placement.kind === 'reversed');
  const outside = placed.filter((entry) => entry.placement.kind === 'outside');

  // Told apart on the raw value rather than on the placement, because the placement cannot see the
  // difference: `readDayValue` returns null both for a property nobody has filled in and for one
  // holding something that is not a date.
  const undated = placed.filter((entry) => entry.placement.kind === 'undated' && !entry.unreadable);
  const unreadable = placed.filter((entry) => entry.unreadable);
  const dated = placed.filter((entry) => entry.start !== null);

  const todayText = dayText(todayDay());
  const lostEnd = describeLostEndProperty(view, container.schema);

  const open = rescheduling === null ? null : (placed.find(byId(rescheduling)) ?? null);

  const aside: AsideContext = {
    onOpen,
    rescheduling,
    setRescheduling,
    panelId,
    schema: container.schema,
    startKey,
    endKey,
    setProperties: container.setProperties,
  };

  return (
    // `min-h-0 flex-1` so the pane keeps the vertical axis: the wide axis is this view's and is
    // owned by the track below, and a second vertical scroller here would compete with the pane's.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <ShownItems ids={placed.map((entry) => entry.item.id)} />
      {narrow ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Text variant="h6" as="h2" className="min-w-0 break-words">
            {axis.label}
          </Text>

          {/* aria-current rather than a tablist, following the calendar and the view switcher: these
            are three ways of looking at one thing, and claiming to be tabs would owe arrow-key
            navigation nobody asked for. */}
          <nav aria-label="Timeline scale" className="flex items-center gap-0.5">
            {SCALES.map((grain) => (
              <button
                key={grain}
                type="button"
                aria-current={scale === grain ? 'page' : undefined}
                onClick={() => {
                  setMode(grain);
                }}
                className={cn(
                  // `relative before:*`: the drawn pill is about 22px tall (`text-xs` at its 1.4
                  // line height plus `py-1`), just under WCAG 2.5.8's 24px floor - the same fix,
                  // for the same control, as the calendar's grain switcher.
                  'relative rounded-sm px-2 py-1 text-xs capitalize before:absolute before:inset-x-0 before:-inset-y-0.5 pointer-coarse:min-h-(--control-lg)',
                  focusRing,
                  scale === grain
                    ? 'bg-foreground/7 text-foreground'
                    : 'text-muted hover:bg-foreground/7 hover:text-foreground',
                )}
              >
                {grain}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              aria-label={`Previous ${scale}`}
              className="px-2"
              onClick={() => {
                setAnchor((current) => stepAnchor(scale, current, -1));
              }}
            >
              <Icon icon={ChevronLeft} size="sm" />
            </Button>

            <Button
              variant="secondary"
              className="py-1"
              onClick={() => {
                setAnchor(todayDay());
              }}
            >
              Today
            </Button>

            <Button
              variant="ghost"
              aria-label={`Next ${scale}`}
              className="px-2"
              onClick={() => {
                setAnchor((current) => stepAnchor(scale, current, 1));
              }}
            >
              <Icon icon={ChevronRight} size="sm" />
            </Button>
          </div>
        </div>
      )}

      {/* What the address is hiding, said separately from what the window is: one is a filter
          somebody set, the other is a stretch of time somebody paged away from. */}
      {chrome.notice}

      {lostEnd === null ? null : <PartialNotice pending={lostEnd} />}

      {narrow || outside.length === 0 ? null : (
        // A window can only show a window. Saying how much is off it is the difference between a
        // timeline and a timeline that appears to have lost things - and the list further down is
        // what keeps them reachable rather than merely counted.
        <PartialNotice
          pending={
            outside.length === 1
              ? `1 item is dated outside ${axis.label}. It is listed under "Outside this window".`
              : `${String(outside.length)} items are dated outside ${axis.label}. They are listed under "Outside this window".`
          }
        />
      )}

      {narrow ? (
        <TimelineAgenda dated={dated} undated={undated} aside={aside} />
      ) : (
        <Blueprint className="p-3">
          {/* The track owns the wide axis, which is this view's to own - the pane's scroller is
            y-only for exactly this reason. Inside the frame's padding rather than around it, so
            scrolled columns do not slide under the gutter beside the sticky column.

            Focusable and named, which is the standard treatment for a scrollable region: without a
            tab stop the axis can only be scrolled by tabbing through the bars inside it, so a
            keyboard user who wants to read the dates has to activate something to move. */}
          <div
            role="region"
            aria-label={`${view.name}, ${axis.label}`}
            // The rule cannot see that this element scrolls, and only its author can. Without a tab
            // stop the axis is reachable by keyboard only by tabbing through the bars inside it, so
            // somebody who wants to read the dates has to activate something to move.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: a scrollable region needs a tab stop or its content cannot be scrolled without a pointer.
            tabIndex={0}
            className={cn('overflow-x-auto', focusRing)}
          >
            <TimelineTable
              name={view.name}
              axis={axis}
              rows={rows}
              todayText={todayText}
              aside={aside}
            />
          </div>
        </Blueprint>
      )}

      {/*
        **One panel, in one place, for whichever item is being rescheduled.**

        It used to be rendered inside the row or the list entry it belonged to, which was tidier to
        read and dropped the keyboard's place on the most ordinary edit this view offers: a property
        write is optimistic, so typing a start date that now falls after the end moves the item from
        the grid to the band below *during the same render*. The row unmounted, the list entry
        mounted, and the focused field went with it - in a view whose only editing path is the
        keyboard. Here the panel is at a fixed position in the tree, so the input survives the item
        changing bucket underneath it.

        Keyed by item, so opening a different item's panel starts with its errors cleared - but not
        keyed by anything that moves when the same item is edited.
      */}
      {open === null ? null : (
        <section
          ref={panelRef}
          id={panelId}
          aria-label={`Reschedule ${titleOf(open.item)}`}
          // A tab stop only while it holds the panel a toggle just opened - the effect above is
          // what actually moves focus here, this is what makes moving it possible on an element
          // that carries no interaction of its own.
          tabIndex={-1}
          className="flex flex-col gap-2 border border-divider p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <Text variant="h6" as="h3">
              {`Reschedule ${titleOf(open.item)}`}
            </Text>

            <Button
              variant="ghost"
              className="py-1 text-sm"
              onClick={() => {
                setRescheduling(null);
              }}
            >
              Done
            </Button>
          </div>

          {/* Where the item sits *now*, announced when it changes. The visual move from the grid to
              a band below is silent otherwise, and somebody who has just typed a date has every
              reason to want to know their item left the axis. */}
          <div role="status">
            <Text variant="caption" tone="muted">
              {describeWhere(open, axis)}
            </Text>
          </div>

          <RescheduleFields key={open.item.id} item={open.item} aside={aside} />
        </section>
      )}

      {narrow ? null : (
        <>
          <OffAxisList
            heading={
              reversed.length === 1
                ? '1 item has an end date before its start date'
                : `${String(reversed.length)} items have an end date before their start date`
            }
            detail="Both dates are shown as they are stored. Nothing has been changed - correct whichever one is wrong."
            placed={reversed}
            aside={aside}
          />

          <OffAxisList
            heading={`Outside this window (${String(outside.length)})`}
            detail={`These are dated, and their dates fall outside ${axis.label}.`}
            placed={outside}
            aside={aside}
          />
        </>
      )}

      <OffAxisList
        heading={`Dates that could not be read (${String(unreadable.length)})`}
        detail={`These hold a ${propertyWord(container.schema, startKey, 'start date')} that is not a date, so there is no day to draw them on. Nothing has been overwritten.`}
        placed={unreadable}
        aside={aside}
      />

      {narrow ? null : (
        <OffAxisList
          heading={`Unscheduled (${String(undated.length)})`}
          detail={`Nothing has been lost: these have no ${propertyWord(container.schema, startKey, 'start date')} yet, so there is no day to draw them on.`}
          placed={undated}
          aside={aside}
          // Always drawn, even at zero, so "everything here is scheduled" is a statement the view
          // makes rather than an absence a reader has to infer from a missing heading.
          showWhenEmpty
          empty="Every item here has a start date."
        />
      )}

      <CreateItemControl
        label="Add an item"
        onCreate={container.create}
        className="mt-1 self-start"
      />
    </div>
  );
}

/** The grains offered, in the order they widen. */
const SCALES: readonly TimelineScale[] = ['week', 'month', 'quarter'];
