import { ContextMenu, type ContextMenuTargetProps, type MenuEntry } from '@nix/ui';
import { CalendarClock, Timer } from 'lucide-react';
import type { ReactNode } from 'react';

import { useItemContextActions } from '@nix/web-collections/core/use-item-context-actions';

/**
 * A calendar entry's secondary-click menu: the actions every view offers on an entry, plus
 * Reschedule - the calendar's own move, which the entry's clock control already reaches - where
 * the calendar can write one.
 */
export function CalendarEntryMenu(props: {
  readonly itemId: string;
  readonly title: string;
  readonly onOpen: (itemId: string) => void;
  readonly onReschedule?: ((itemId: string) => void) | undefined;

  /**
   * Gives this calendar an end property, so its items can have a length. Passed only while the
   * calendar has none: once it does the entry would have nothing left to do.
   */
  readonly onAddEnd?: (() => void) | undefined;
  readonly children: (target: ContextMenuTargetProps) => ReactNode;
}): ReactNode {
  const { itemId, title, onOpen, onReschedule, onAddEnd, children } = props;
  const itemActions = useItemContextActions(onOpen);

  function items(): MenuEntry[] {
    const extra: MenuEntry[] = [];
    if (onReschedule !== undefined) {
      extra.push({
        kind: 'action',
        label: 'Reschedule…',
        icon: CalendarClock,
        onSelect: () => {
          onReschedule(itemId);
        },
      });
    }
    if (onAddEnd !== undefined) {
      extra.push({
        kind: 'action',
        // Says it is the calendar that changes, not this one item: the property is added for
        // every item here, and a label that sounded like "end this item" would hide that.
        label: 'Add end times to this calendar',
        icon: Timer,
        onSelect: onAddEnd,
      });
    }
    return itemActions(itemId, title, extra);
  }

  return (
    <ContextMenu label={`${title || 'Untitled'} actions`} items={items}>
      {children}
    </ContextMenu>
  );
}
