import { Button, Icon, Text, cn, focusRing } from '@nix/ui';
import { CalendarClock } from 'lucide-react';
import type { DragEvent, ReactNode } from 'react';

import { useClickSelects } from '../../../collections/core/item-open-click';
import { useOptionalItemSelection } from '../../../collections/core/item-selection-context';
import { SelectCheckbox } from '../../core/select-checkbox';
import { rowGestures } from '../../../collections/core/use-item-selection';
import type { Item } from '../../../collections/core/container-model';
import { readTimestampValue } from '../../../collections/core/timestamps';
import { ListCell } from '../../list/list-cell';
import { CalendarEntryMenu } from '../calendar-entry-menu';
import type { CardContext } from './card-context';

export interface ItemCardProps {
  readonly item: Item;
  readonly card: CardContext;

  /**
   * The day this card is drawn on right now, or null when it has none - the unscheduled list.
   * A multi-day span is drawn once per day it covers, so the same item's card carries a different
   * value here on each of them; `card.dropOnDate` uses it to tell which day of the span the drag
   * actually started from.
   */
  readonly occurrenceDate: string | null;

  /**
   * One line: the time, the title, and nothing else. What a day on the month grid draws.
   *
   * The full card - a bordered box with a second property editable in place - is right for the
   * unscheduled list, which has the width for it. Seven to a row it made every day a stack of
   * small forms, and a month stopped looking like a month.
   */
  readonly compact?: boolean;
}

export function ItemCard(props: ItemCardProps): ReactNode {
  const { item, occurrenceDate, compact = false } = props;
  const {
    onOpen,
    setRescheduling,
    setDragged,
    clearDragged,
    secondaryProperty,
    onWrite,
    dateProperty,
    zone,
  } = props.card;
  const selection = useOptionalItemSelection();
  const clickSelects = useClickSelects();
  const openBeside = selection?.openBeside;
  const openProps = rowGestures(
    selection,
    item.id,
    selection?.shown ?? [],
    () => {
      onOpen(item.id);
    },
    openBeside === undefined
      ? undefined
      : () => {
          openBeside(item.id);
        },
    clickSelects,
  );

  const startDrag = (event: DragEvent<HTMLDivElement>): void => {
    setDragged(item.id, occurrenceDate);
    event.dataTransfer.effectAllowed = 'move';
    // Set although nothing reads it: without data attached, Firefox refuses to start the drag.
    event.dataTransfer.setData('text/plain', item.id);
  };

  // The time of day, when the item is placed by a moment rather than by a day.
  const moment = readTimestampValue(item.properties, dateProperty);
  const time = moment === null ? null : moment.at.setZone(zone).toFormat('HH:mm');

  if (compact) {
    return (
      <CalendarEntryMenu
        itemId={item.id}
        title={item.title}
        onOpen={onOpen}
        onReschedule={setRescheduling}
      >
        {(contextTarget) => (
          <div className="group group/card relative">
            <SelectCheckbox
              item={item}
              className="absolute left-1 top-1 z-20 rounded-sm bg-surface"
            />
            <div
              {...contextTarget}
              draggable
              onDragStart={startDrag}
              onDragEnd={() => {
                clearDragged();
              }}
              className="group/chip relative flex items-center gap-0.5 rounded-sm bg-accent/18 hover:bg-accent/25"
            >
              <button
                type="button"
                {...openProps}
                className={cn(
                  focusRing,
                  'min-w-0 flex-1 truncate rounded-sm py-0.5 pl-7 pr-1.5 text-left text-xs',
                )}
              >
                {time === null ? null : <span className="mr-1 text-muted">{time}</span>}
                {item.title || 'Untitled'}
              </button>

              {/* Reschedule, for a keyboard and for touch, which have no drag. Shown on hover, on
                focus and always on a coarse pointer - on every chip at once it is forty clocks
                beside forty titles. It lies over the chip's end rather than beside it, so a
                chip is the full width of its day whether or not the control is showing. `opacity`, not `visibility`, so it stays in the tab order. */}
              <Button
                variant="ghost"
                aria-label={`Reschedule ${item.title || 'Untitled'}`}
                aria-haspopup="dialog"
                className="absolute inset-y-0 right-0 rounded-sm bg-background px-0.5 py-0 opacity-0 focus-visible:opacity-100 group-hover/chip:opacity-100 pointer-coarse:opacity-100"
                onClick={() => {
                  setRescheduling(item.id);
                }}
              >
                <Icon icon={CalendarClock} size="sm" />
              </Button>
            </div>
          </div>
        )}
      </CalendarEntryMenu>
    );
  }

  return (
    <CalendarEntryMenu
      itemId={item.id}
      title={item.title}
      onOpen={onOpen}
      onReschedule={setRescheduling}
    >
      {(contextTarget) => (
        <div className="group group/card flex items-start gap-1">
          <SelectCheckbox item={item} className="self-start" />
          <div
            {...contextTarget}
            draggable
            onDragStart={startDrag}
            onDragEnd={() => {
              clearDragged();
            }}
            className="flex min-w-0 flex-1 items-start gap-1 border border-divider bg-surface px-1"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              {/* `before:-inset-x-0.5`: the control keeps `<Button>`'s 36px height, but with `px-0` its
            width is its text's, and a one- or two-character title lands under WCAG 2.5.8's 24px
            floor. Half a step each side is the widest the hit area can grow without reaching the
            reschedule control's own widened area beside it. */}
              <Button
                variant="ghost"
                className="relative min-w-0 justify-start px-0 py-0.5 text-left text-sm before:absolute before:inset-y-0 before:-inset-x-0.5"
                {...openProps}
              >
                <span className="truncate">{item.title || 'Untitled'}</span>
              </Button>

              {secondaryProperty === null ? null : (
                <div className="min-w-0">
                  <Text variant="kicker" tone="muted" as="span">
                    {secondaryProperty.label}
                  </Text>
                  <ListCell
                    item={item}
                    property={secondaryProperty}
                    tabIndex={-1}
                    onWrite={(value) => onWrite(item.id, secondaryProperty.key, value)}
                  />
                </div>
              )}
            </div>
          </div>

          {/* `before:-inset-x-1`: with `px-0` this is an 18px-wide target - the 16px glyph plus the
          hairline borders - under the 24px floor, and giving the padding back would cost the day
          cell width it does not have. One spacing step each side clears the floor invisibly, the
          pane-divider technique again. */}
          <Button
            variant="ghost"
            aria-label={`Reschedule ${item.title || 'Untitled'}${time === null ? '' : `, ${time}`}`}
            aria-haspopup="dialog"
            className="relative gap-1 px-0 py-0.5 text-xs before:absolute before:inset-y-0 before:-inset-x-1 pointer-coarse:min-w-(--control-lg)"
            onClick={() => {
              setRescheduling(item.id);
            }}
          >
            {/* The time is the quick edit: one tap opens the dialog on it. */}
            {time === null ? null : <span>{time}</span>}
            <Icon icon={CalendarClock} size="sm" />
          </Button>
        </div>
      )}
    </CalendarEntryMenu>
  );
}
