import { createContext, useContext, useEffect, type ReactNode } from 'react';

import type { ViewCapabilities } from './view-capabilities';

/**
 * The selection a view's rows and cards take part in, provided by the screen around the view so
 * the selection bar, the context menu's Select entry and a row's checkbox all read one set.
 */
export interface ItemSelectionContextValue {
  readonly selected: ReadonlySet<string>;
  /** Toggles one item; with `shiftKey` extends from the last clicked id across `order`. */
  readonly toggle: (itemId: string, order: readonly string[], shiftKey?: boolean) => void;
  readonly capabilities: ViewCapabilities;
  /** Every item the view currently shows, in order: what Select all and Shift-click range over. */
  readonly shown: readonly string[];
  /** The view reports what it shows; the selection cannot know, because filters live in the view. */
  readonly show: (ids: readonly string[]) => void;
  /** Opens beside, when the surface around the view can; an Alt-click does this. */
  readonly openBeside?: ((itemId: string) => void) | undefined;
  /** Per-view controls appended to the shared selection tray. */
  readonly setTrayActions?: ((actions: ReactNode) => void) | undefined;
}

export const ItemSelectionContext = createContext<ItemSelectionContextValue | null>(null);

/** Null outside a selecting container, so a view drawn alone (a story, a dialog) offers no boxes. */
export function useOptionalItemSelection(): ItemSelectionContextValue | null {
  return useContext(ItemSelectionContext);
}

/** Draws nothing; tells the selection which items its view currently shows, and when it stops. */
export function ShownItems({ ids }: { readonly ids: readonly string[] }): ReactNode {
  const show = useOptionalItemSelection()?.show;
  const key = ids.join('\u0000');
  useEffect(() => {
    show?.(key.length === 0 ? [] : key.split('\u0000'));
    return () => {
      show?.([]);
    };
  }, [show, key]);
  return null;
}
