import { Button, cn } from '@nix/ui';
import { useState, type DragEvent, type ReactNode } from 'react';

import type { Item } from '@nix/web-collections/core/container-model';
import { CreateItemControl } from '../../core/create-item-control';
import { ItemCard } from '../item/item-card';
import type { CardContext } from '../item/card-context';
import { DayNumber, MONTH_CELL, MONTH_VISIBLE_ITEMS, type DayCellSpec } from '../month-grid';

export interface DayCellProps {
  readonly cell: DayCellSpec;

  /** The cell's accessible name: weekday, day, month and year, spelt out. */
  readonly name: string;
  readonly isToday: boolean;
  readonly items: readonly Item[];
  readonly dragged: { readonly id: string; readonly from: string | null } | null;
  readonly card: CardContext;
}

export function DayCell(props: DayCellProps): ReactNode {
  const { cell, name, isToday, items, dragged, card } = props;
  const [over, setOver] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const visibleItems = expanded ? items : items.slice(0, MONTH_VISIBLE_ITEMS);
  const hiddenItems = items.length - visibleItems.length;

  return (
    <td
      // The cell's accessible name carries the whole date, so somebody moving through the grid with
      // a screen reader always knows which day they are on rather than hearing a bare "17".
      aria-label={name}
      aria-current={isToday ? 'date' : undefined}
      onDragOver={(event: DragEvent<HTMLTableCellElement>) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={(event: DragEvent<HTMLTableCellElement>) => {
        event.preventDefault();
        setOver(false);
        if (dragged !== null) {
          // A drop writes the date property, not a position: where a card sits is its date, and
          // anything view-local would disagree with every other view of the same folder. An item
          // with an end configured and set moves as a whole span - see `CardContext.dropOnDate` -
          // so dragging any day of a multi-day span keeps its length rather than reversing it.
          card.dropOnDate(dragged.id, dragged.from, cell.date);
        }
      }}
      className={cn(
        'group/day',
        MONTH_CELL,
        // A day from the month before or after sits on the quieter ground, so the month being
        // shown is the shape that stands out.
        cell.outside ? 'bg-surface/50' : '',
        over && dragged !== null ? 'outline-2 -outline-offset-2 outline-accent' : '',
      )}
    >
      <div className="flex h-full flex-col gap-0.5 p-1">
        <DayNumber day={cell.day} isToday={isToday} outside={cell.outside} />

        {items.length === 0 ? null : (
          <ul className="flex flex-col gap-0.5">
            {visibleItems.map((item) => (
              <li key={item.id}>
                <ItemCard item={item} card={card} occurrenceDate={cell.date} compact />
              </li>
            ))}
          </ul>
        )}

        {items.length <= MONTH_VISIBLE_ITEMS ? null : (
          <Button
            variant="ghost"
            className="self-start px-1 py-0 text-xs"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded((current) => !current);
            }}
          >
            {expanded ? 'Show fewer' : `Show ${String(hiddenItems)} more`}
          </Button>
        )}

        {/* Created already dated to this day - the same write a drop onto it makes. Revealed on
            hover and on focus, following the tree's delete control: forty-two always-visible
            buttons would be more plus signs than calendar, but one that only exists for a pointer
            would be a way to add things that a keyboard does not have.
            `opacity-0`/`pointer-events-none`, not `invisible` - see calendar-hours.tsx's hour-slot
            and all-day controls for why `visibility: hidden` breaks the keyboard path entirely.
            `pointer-coarse:*` keeps it shown and tappable on a phone, which has neither hover nor
            focus-by-tab to reveal it with - the same trio `workspace-sidebar.tsx`'s row controls
            and `drive-view.tsx`'s own touch target already use. */}
        {/* One tab stop for the whole month's add controls: the arrow keys walk the days. */}
        <div
          data-roving-row={cell.week}
          data-roving-column={cell.weekday}
          className="mt-auto self-start"
        >
          <CreateItemControl
            compact
            label={`Add an item on ${name}`}
            properties={{ [card.dateProperty]: cell.date }}
            onCreate={card.onCreate}
            className="opacity-0 pointer-events-none mt-auto self-start focus-within:pointer-events-auto focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/day:pointer-events-auto group-hover/day:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
          />
        </div>
      </div>
    </td>
  );
}
