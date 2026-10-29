import { type CellRef } from '@nix/sheet';
import { useState, type Dispatch } from 'react';

import { type Item } from '../../collections/core/container-model';
import { clamp, type GridBounds, type SelectionAction } from '../../collections/sheet/selection';

/**
 * The selection follows the item, not the index. Recorded and reconciled during render (the
 * `useDraft` pattern): when `items` reorders under the grid, the active cell is moved to where
 * its item went, so the next Delete or fill acts on the row somebody selected rather than on
 * whichever row slid into its place. The anchor is deliberately dropped - a range of indexes
 * over a reordered list no longer means anything.
 */
export function useSelectionFollowsItem(args: {
  readonly items: readonly Item[];
  readonly active: CellRef;
  readonly bounds: GridBounds;
  readonly navigating: boolean;
  readonly dispatch: Dispatch<SelectionAction>;
  readonly setNotice: (notice: string | null) => void;
}): void {
  const { items, active, bounds, navigating, dispatch, setNotice } = args;
  const activeItem = items[active.row];
  const [tracked, setTracked] = useState<{
    items: readonly Item[];
    activeId: string | null;
  }>({ items, activeId: activeItem?.id ?? null });

  if (items !== tracked.items) {
    const followedIndex =
      tracked.activeId === null ? -1 : items.findIndex((item) => item.id === tracked.activeId);
    setTracked({ items, activeId: tracked.activeId });

    if (followedIndex !== -1 && followedIndex !== active.row && navigating) {
      dispatch({
        type: 'moveTo',
        ref: clamp({ row: followedIndex, col: active.col }, bounds),
        extend: false,
      });
    }
  } else if ((activeItem?.id ?? null) !== tracked.activeId) {
    // The person moved the selection: record where it is, and retire whatever sentence the last
    // cell earned - a stale notice under the grid describes an edit that is no longer where they
    // are. Render-time adjustment, the same pattern as the block above.
    setTracked({ items, activeId: activeItem?.id ?? null });
    setNotice(null);
  }
}
