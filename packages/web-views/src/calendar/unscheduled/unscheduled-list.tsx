import { Text } from '@nix/ui';
import { useId, type DragEvent, type ReactNode } from 'react';

import type { Item } from '@nix/web-collections/core/container-model';
import type { CardContext } from '../item/card-context';
import { ItemCard } from '../item/item-card';

interface UnscheduledListProps {
  readonly items: readonly Item[];
  readonly card: CardContext;

  /** The card being dragged, when one is. */
  readonly dragged: { readonly id: string } | null;

  /** Takes the dragged item's date off. */
  readonly onClear: (itemId: string) => void;
}

/** Items with no date, and the drop target that takes a date off. */
export function UnscheduledList(props: UnscheduledListProps): ReactNode {
  const { items, card, dragged, onClear } = props;
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      onDragOver={(event: DragEvent<HTMLElement>) => {
        event.preventDefault();
      }}
      onDrop={(event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        if (dragged !== null) {
          onClear(dragged.id);
        }
      }}
      className="flex flex-col gap-2 border border-divider p-3"
    >
      <Text variant="h6" as="h3" id={headingId}>
        {`Unscheduled (${String(items.length)})`}
      </Text>

      {items.length === 0 ? (
        <Text variant="caption" tone="muted">
          Nothing unscheduled.
        </Text>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.id}>
              <ItemCard item={item} card={card} occurrenceDate={null} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
