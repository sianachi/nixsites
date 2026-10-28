import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

import { usePaneIndex } from '../panes/pane-context';
import {
  CHAT_PARAM,
  SELECTED_ITEM_PARAM,
  clearViewState,
  paneParam,
  parseSelectedItem,
  selectedItemParam,
} from '../panes/pane-params';

/**
 * Which item is open, held in the URL.
 *
 * The state ladder puts the URL above local state for anything that should survive a refresh or
 * be shareable, and "the note I am looking at" is the most shareable fact in a document
 * workspace. Holding it in a store instead would make every link to a note a link to the
 * application's front door.
 *
 * Selecting pushes rather than replaces, because Back meaning "the note I was reading" is what
 * everybody expects of a document application.
 *
 * **Which item, in which pane.** The pane comes from context, and outside any provider it is the
 * first - whose parameter is the plain `item` this has always used. So every existing link keeps
 * working and every existing caller is unchanged; a second pane simply addresses `item2`.
 */

/** Builds the search string for an item, for use as a <Link> target. */
export function selectedItemSearch(itemId: string): string {
  return `?${new URLSearchParams({ [SELECTED_ITEM_PARAM]: itemId }).toString()}`;
}

/**
 * Writes one pane's selected item into a set of parameters. Exported, and taking `pane` rather
 * than reading it from context, so cross-pane navigation - focusing a document that is already
 * open in a pane other than the one a click originated in - can target that pane directly.
 * `useSelectedItem` cannot do this itself: it is pinned to `usePaneIndex()`, which only ever
 * names the pane the calling component is rendered inside.
 */
export function writeSelectedItem(params: URLSearchParams, pane: number, itemId: string): void {
  // See `select`, below, for why the view state is cleared alongside the item. The pane's chat goes
  // too: choosing an item in a pane that shows the conversation means showing that item.
  clearViewState(params, pane);
  params.delete(paneParam(CHAT_PARAM, pane));
  params.set(selectedItemParam(pane), itemId);
}

export interface SelectedItemControl {
  readonly selectedId: string | null;
  readonly select: (itemId: string) => void;
  readonly clear: () => void;
}

export function useSelectedItem(): SelectedItemControl {
  const pane = usePaneIndex();
  const [searchParams, setSearchParams] = useSearchParams();
  const name = selectedItemParam(pane);
  const selectedId = parseSelectedItem(searchParams.get(name), pane);

  const select = useCallback(
    (itemId: string): void => {
      const next = new URLSearchParams(searchParams);

      // The view, sort and filters belonged to the item being left, and every item can carry views
      // of its own now. Left in place, opening a sibling that happens to have a view with the same
      // id would land on a board nobody asked for - and one that does not would look like the
      // choice had been ignored.
      //
      // Scoped to this pane. Unscoped, navigating here would clear the *other* pane's view too,
      // which is a change nobody asked for in a part of the screen they were not looking at.
      writeSelectedItem(next, pane, itemId);
      setSearchParams(next);
    },
    [pane, searchParams, setSearchParams],
  );

  const clear = useCallback((): void => {
    const next = new URLSearchParams(searchParams);
    next.delete(name);
    setSearchParams(next, { replace: true });
  }, [name, searchParams, setSearchParams]);

  return { selectedId, select, clear };
}
