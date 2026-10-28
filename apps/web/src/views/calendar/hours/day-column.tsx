import { Button, Icon, cn } from '@nix/ui';
import { CalendarClock } from 'lucide-react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';

import { publishNotice } from '@nix/web-foundation/lib/notices';
import { dayLabel, type CalendarDay } from '../../core/calendar-dates';
import { readPropertyText, type Item } from '../../core/container-model';
import { useItemOpenProps } from '../../core/item-open-click';
import { CalendarEntryMenu } from '../calendar-entry-menu';
import { durationLabel } from '../span-gesture';
import {
  DAY_COLUMN,
  HOURS,
  MIN_SPAN_HEIGHT_PX,
  ROW_HEIGHT,
  minutesToPx,
  type Placed,
  type SpanGesture,
} from './geometry';
import { HourSlot } from './hour-slot';
import { clockAt, laneStyle, layout, timeLabel } from './placement';

export function DayColumn(props: {
  readonly day: CalendarDay;

  /** The column's position in the roving grid: which day Left and Right arrive at. */
  readonly dayIndex: number;
  readonly placed: readonly Placed[];
  readonly dateProperty: string;
  readonly zone: string;
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
  readonly dragged: string | null;
  /**
   * Reschedules an item onto the slot it was dropped on.
   *
   * Optional, and absent means the grid accepts no drops. Paired with `dragged`, which is null for
   * the same caller - a grid that took a drop it could not write would silently discard it.
   */
  readonly onMove?: ((itemId: string, values: Record<string, string | null>) => void) | undefined;

  /**
   * Opens the reschedule dialog for a placed item.
   *
   * Optional in lockstep with `onMove`: a grid that cannot write a reschedule has no business
   * opening a dialog that ends in one.
   */
  readonly onReschedule?: ((itemId: string) => void) | undefined;
  readonly onAddEnd?: ((itemId: string) => void) | undefined;

  /** Whether an item has no end property to stretch into - see `HourGridProps.endlessItemIds`. */
  readonly endless: (item: Item) => boolean;

  /** Whether the view has an end property, so a placed item can be stretched from its foot. */

  /** Whether the reader may move this item at all: by drag, by stretch or by the dialog. */
  readonly adjustable: (item: Item) => boolean;

  /** The drag in progress anywhere on the grid, for the preview this column may owe. */
  readonly gesture: SpanGesture | null;

  /**
   * Starts dragging or stretching a placed item. Absent in lockstep with `onMove`: a grid that
   * cannot write the result has no business starting the gesture.
   */
  readonly onGesture?:
    | ((
        event: ReactPointerEvent<HTMLElement>,
        entry: Placed,
        dayIndex: number,
        kind: 'move' | 'resize',
      ) => void)
    | undefined;

  /** Set while the click that ends a drag is still to arrive, so the card does not open on it. */
  readonly suppressClick: { current: boolean };
}): ReactNode {
  const {
    day,
    dayIndex,
    placed,
    dateProperty,
    zone,
    onOpen,
    onCreate,
    dragged,
    onMove,
    onReschedule,
    onAddEnd,
    endless,
    adjustable,
    gesture,
    onGesture,
    suppressClick,
  } = props;
  const openProps = useItemOpenProps(onOpen);

  return (
    <div
      aria-label={dayLabel(day)}
      data-day-column=""
      className={cn(DAY_COLUMN, 'relative border-l border-divider')}
      style={{ height: `${String(HOURS.length * ROW_HEIGHT)}px` }} // design-token-exempt: twenty-four hours of grid, computed from the row height rather than restated by hand
    >
      {HOURS.map((hour) => (
        <HourSlot
          key={hour}
          day={day}
          dayIndex={dayIndex}
          hour={hour}
          dateProperty={dateProperty}
          zone={zone}
          onCreate={onCreate}
          dragged={dragged}
          onMove={onMove}
        />
      ))}

      {layout(placed).map((entry) => {
        const { left, width } = laneStyle(entry.lane, entry.lanes);

        // One answer for all three ways of moving an item, so a fixed one offers none of them
        // rather than a control that appears and then does nothing.
        const movable = adjustable(entry.item);
        const reschedule = movable ? onReschedule : undefined;
        const beginGesture = movable ? onGesture : undefined;

        const position = {
          // design-token-exempt: where an item sits, how wide its lane is and how tall its
          // span is are all positions read off the data and the overlap sweep above, computed
          // at runtime rather than restated as a class - see ROW_HEIGHT's own comment.
          top: `${String(minutesToPx(entry.minutes))}px`,
          left,
          width,
          ...(entry.durationMinutes === null
            ? {}
            : {
                // Clamped to MIN_SPAN_HEIGHT_PX - see its own comment - so a span under about
                // thirty-eight minutes still has room for its Reschedule button. The top above
                // stays exact; only a too-short box's bottom moves.
                height: `${String(Math.max(minutesToPx(entry.durationMinutes), MIN_SPAN_HEIGHT_PX))}px`,
                // A short span's box is shorter than its two lines of text. Kept off the
                // Tailwind class list rather than reached for as `overflow-hidden`: this
                // file's own scroller-contract tests scan for anything named `overflow-*`
                // inside the grid to prove there is exactly one scroll boundary, and a class
                // saying "clip my own content" is not a second scroller - but the substring
                // match cannot tell the two apart, so this stays an inline style instead.
                overflow: 'hidden',
              }),
        };
        return (
          // A row rather than a single button: a placed item used to answer only to `onOpen`,
          // which made a drag the sole way to move a card once it had landed on the grid - a
          // gesture neither a keyboard nor a touch screen has. The reschedule control beside it
          // reaches the same write a drag makes, exactly as the month card's own reschedule
          // control does. A span sets an explicit `height`, computed from its duration; a point
          // sets none and draws at its content's own height, exactly as it always has.
          <CalendarEntryMenu
            key={entry.item.id}
            itemId={entry.item.id}
            title={readPropertyText(entry.item, 'title')}
            onOpen={onOpen}
            onReschedule={reschedule}
            onAddEnd={
              onAddEnd !== undefined && endless(entry.item)
                ? () => {
                    onAddEnd(entry.item.id);
                  }
                : undefined
            }
          >
            {(contextTarget) => (
              <div
                {...contextTarget}
                style={position} // design-token-exempt: computed from the data and the overlap sweep
                className={cn(
                  'absolute flex items-stretch gap-0.5 rounded-sm bg-accent/18 select-none',
                  // The item being dragged stays where it was, faded, so the preview reads as
                  // "from here to there" rather than as the item having already moved.
                  gesture?.itemId === entry.item.id ? 'opacity-50' : '',
                )}
              >
                <button
                  type="button"
                  onPointerDown={
                    beginGesture === undefined
                      ? undefined
                      : (event) => {
                          beginGesture(event, entry, dayIndex, 'move');
                        }
                  }
                  {...openProps(entry.item.id)}
                  onClick={(event) => {
                    if (suppressClick.current) {
                      suppressClick.current = false;
                      return;
                    }
                    openProps(entry.item.id).onClick(event);
                  }}
                  className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm px-1.5 py-1 text-left text-xs hover:bg-accent/25 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                >
                  <span className="truncate font-medium">
                    {readPropertyText(entry.item, 'title')}
                  </span>
                  <span className="truncate text-muted">{timeLabel(entry, zone)}</span>
                </button>

                {reschedule === undefined ? null : (
                  <Button
                    variant="ghost"
                    aria-label={`Reschedule ${readPropertyText(entry.item, 'title') || 'Untitled'}`}
                    aria-haspopup="dialog"
                    className="shrink-0 self-start px-0.5 py-1"
                    onClick={() => {
                      reschedule(entry.item.id);
                    }}
                  >
                    <Icon icon={CalendarClock} size="sm" />
                  </Button>
                )}

                {/* The foot of the item, for stretching it. Pointer-only and hidden from
                    assistive technology on purpose: the reschedule control beside it writes the
                    same end from a keyboard, and a second, unlabelled control saying the same
                    thing would be noise.

                    Drawn on every item that can be moved, including one whose calendar has no end
                    property yet. Leaving it off those made the precondition invisible: a reader
                    looking for something to drag found nothing and no reason. On such an item a
                    press does not stretch - there is nowhere to write a length - it says so, and
                    offers to add end times as the notice's action. */}
                {beginGesture === undefined ? null : (
                  <span
                    aria-hidden="true"
                    onPointerDown={(event) => {
                      if (!endless(entry.item)) {
                        beginGesture(event, entry, dayIndex, 'resize');
                        return;
                      }

                      event.preventDefault();
                      event.stopPropagation();
                      publishNotice({
                        key: `calendar-no-end:${entry.item.id}`,
                        message:
                          onAddEnd === undefined
                            ? 'Items in this calendar have no end time, so they cannot be stretched. Choose an End property in the calendar’s view settings.'
                            : 'Items in this calendar have no end time yet, so they cannot be stretched.',
                        ...(onAddEnd === undefined
                          ? {}
                          : {
                              action: {
                                label: 'Add end times',
                                onAction: () => {
                                  onAddEnd(entry.item.id);
                                },
                              },
                            }),
                      });
                    }}
                    // Tall enough to land on without aiming, with a grip that is always drawn - a
                    // handle a reader has to hover to discover is one most never find - and
                    // brightens under the pointer. On a coarse pointer it becomes a short, centred
                    // grip rather than the whole foot: wide enough for a thumb, narrow enough that
                    // a scroll starting anywhere else on the card is still a scroll.
                    className="group/foot absolute inset-x-0 bottom-0 flex h-3 cursor-ns-resize touch-none items-end justify-center rounded-b-sm pb-0.5 hover:bg-accent/40 pointer-coarse:inset-x-auto pointer-coarse:left-1/2 pointer-coarse:h-5 pointer-coarse:w-12 pointer-coarse:-translate-x-1/2"
                  >
                    <span className="h-1 w-8 rounded-full bg-accent opacity-70 group-hover/foot:opacity-100 pointer-coarse:opacity-100" />
                  </span>
                )}
              </div>
            )}
          </CalendarEntryMenu>
        );
      })}

      {/* Where the dragged item would land, drawn in the column it is over. `pointer-events-none`
          so the preview never sits between the pointer and the column it is measuring. */}
      {gesture?.dayIndex === dayIndex ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0.5 z-10 rounded-sm border border-accent bg-accent/25 px-1.5 py-0.5 text-xs font-medium"
          // The preview sits at the minute the pointer has snapped to and is as tall as the span
          // it stands for, both computed from the gesture.
          // prettier-ignore
          style={{ // design-token-exempt: computed from the gesture at runtime
            top: `${String(minutesToPx(gesture.minutes))}px`,
            height: `${String(Math.max(minutesToPx(gesture.durationMinutes ?? 0), MIN_SPAN_HEIGHT_PX))}px`,
          }}
        >
          {gesture.durationMinutes === null
            ? clockAt(gesture.minutes)
            : `${clockAt(gesture.minutes)} - ${clockAt(gesture.minutes + gesture.durationMinutes)} · ${durationLabel(gesture.durationMinutes)}`}
        </div>
      ) : null}
    </div>
  );
}
