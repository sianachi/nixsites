import { createContext, useContext } from 'react';

import { useOptionalItemSelection } from './item-selection-context';
import { rowGestures } from './use-item-selection';

/** True under a container whose open mode is `none`: a click selects instead of opening. */
export const ClickSelectsContext = createContext(false);

export function useClickSelects(): boolean {
  return useContext(ClickSelectsContext);
}

/**
 * What a view spreads on the control that opens an item, so every view honours the open mode `none`
 * the same way: click selects (or does nothing in a view that cannot select), double-click and
 * Enter open. In any other mode it is the plain click-to-open every view had before.
 */
export function useItemOpenProps<T = never>(
  onOpen: (itemId: string, entry?: T) => void,
): (
  itemId: string,
  entry?: T,
) => Partial<ReturnType<typeof rowGestures>> & {
  readonly onClick: ReturnType<typeof rowGestures>['onClick'];
} {
  const clickSelects = useClickSelects();
  const selection = useOptionalItemSelection();
  return (itemId, entry) =>
    clickSelects
      ? rowGestures(
          selection,
          itemId,
          selection?.shown ?? [],
          () => {
            if (entry === undefined) onOpen(itemId);
            else onOpen(itemId, entry);
          },
          undefined,
          true,
        )
      : {
          onClick: () => {
            if (entry === undefined) onOpen(itemId);
            else onOpen(itemId, entry);
          },
        };
}
