import { cn } from '@nix/ui';
import { useState, type DragEvent, type ReactNode } from 'react';

import { dayLabel, type CalendarDay } from '../../../collections/core/calendar-dates';
import { CreateItemControl } from '../../core/create-item-control';
import { ROW_HEIGHT } from './geometry';
import { writeSlot } from './placement';

/**
 * One hour of one day: the thing an item is created in, and the thing an item is dropped into.
 *
 * Its own component because each of the 168 slots owns a `hovered` flag, and a flag held in the
 * column would re-render all twenty-four rows of it on every `dragover` the pointer crosses.
 *
 * **The drop writes a time; the keyboard needs to be able to write one too.** That is why
 * `RescheduleDialog` takes a `datetime-local` for a timestamp property rather than a bare date -
 * the same argument ADR-0009 made against a drop zone that existed only for a pointer, applied to
 * the hour rather than to the day.
 */
export function HourSlot(props: {
  readonly day: CalendarDay;
  readonly dayIndex: number;
  readonly hour: number;
  readonly dateProperty: string;
  readonly zone: string;
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
}): ReactNode {
  const { day, dayIndex, hour, dateProperty, zone, onCreate, dragged, onMove } = props;
  const [over, setOver] = useState(false);

  const at = `${String(hour).padStart(2, '0')}:00`;

  return (
    <div
      // The roving-grid markers: which cell this slot is, for the hook that keeps exactly one
      // of the 168 create controls in the tab order. See use-roving-grid.ts.
      data-roving-row={hour}
      data-roving-column={dayIndex}
      onDragOver={(event: DragEvent<HTMLDivElement>) => {
        // Without this the browser refuses the drop outright, so it runs whether or not this
        // calendar started the drag - the highlight below is what is conditional.
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setOver(false);
        if (dragged !== null && onMove !== undefined) {
          // The hour is the whole point of dropping here rather than on a day: a drop writes the
          // moment the slot stands for, in the reader's zone, through the same function the slot's
          // create control writes.
          onMove(dragged, { [dateProperty]: writeSlot(day, hour, zone) });
        }
      }}
      className={cn(
        'group/slot border-b border-divider',
        over && dragged !== null ? 'outline-2 -outline-offset-2 outline-accent' : '',
      )}
      style={{ height: `${String(ROW_HEIGHT)}px` }} // design-token-exempt: the same hour height as the labels beside it
    >
      {/* One per hour, revealed on hover and on focus. Always in the tree, because a way to add
          something that exists only for a pointer is not a way everybody has.
          `opacity-0`/`pointer-events-none`, not `invisible`: `visibility: hidden` takes an
          element out of the tab order entirely, so `focus-visible:visible` could never fire -
          nothing could tab to the control in order to un-hide it. See the same pattern, with
          the same reasoning, on workspace-sidebar.tsx's row-hover controls.
          `pointer-coarse:*` keeps it shown and tappable on a phone, which has no hover and no way
          to tab through 168 slots to focus one - the same trio workspace-sidebar.tsx's row
          controls and drive-view.tsx's own touch target already use. */}
      {onCreate !== undefined && (
        <CreateItemControl
          compact
          label={`Add an item at ${at} on ${dayLabel(day)}`}
          properties={{ [dateProperty]: writeSlot(day, hour, zone) }}
          onCreate={onCreate}
          className="opacity-0 pointer-events-none focus-within:pointer-events-auto focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/slot:pointer-events-auto group-hover/slot:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
        />
      )}
    </div>
  );
}
