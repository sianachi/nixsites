import { Checkbox, cn } from '@nix/ui';
import type { ReactNode } from 'react';

import type { Item } from '@nix/web-collections/core/container-model';
import { useOptionalItemSelection } from '@nix/web-collections/core/item-selection-context';

/**
 * The selection box every selecting view draws beside an item (requirement 7): a plain toggle,
 * Shift extends across what the view shows. Drawn only on hover or focus of the enclosing `group`
 * until something is selected, then on every item, so a visit that never selects sees no boxes.
 * Renders nothing outside a selecting container. `className` positions it.
 */
export function SelectCheckbox({
  item,
  className,
}: {
  readonly item: Pick<Item, 'id' | 'title'>;
  readonly className?: string;
}): ReactNode {
  const selection = useOptionalItemSelection();
  if (selection === null) return null;
  return (
    <span
      className={cn(
        'flex',
        className,
        selection.selected.size === 0 &&
          'opacity-0 focus-within:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100',
      )}
    >
      <Checkbox
        aria-label={`Select ${item.title || 'Untitled'}`}
        checked={selection.selected.has(item.id)}
        onClick={(event) => {
          selection.toggle(item.id, selection.shown, event.shiftKey);
        }}
        onChange={() => undefined}
      />
    </span>
  );
}
