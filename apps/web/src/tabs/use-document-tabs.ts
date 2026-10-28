import { useSearchParams } from 'react-router';

import { parsePanes } from '../panes/pane-state';
import { tabsForPane } from './tab-ownership';
import { useTabStore, type OpenTab } from '@nix/web-foundation/lib/tab-store';

/**
 * The tab strip a pane actually draws.
 *
 * **Derived, not written on mount.** A fresh load, a refresh, a link, or a brand-new pane from
 * `openBeside` all arrive with an active item the tab store has never heard of - `tab-store.ts`'s
 * own doc comment is explicit that this is the honest cost of keeping the strip out of the URL.
 * Writing that item into the store from a mount effect would work, but it is a write during
 * render's shadow (an effect that exists only to keep two copies of the same fact in step) for a
 * fact this hook can simply compute instead: if the pane's active item is not already one of its
 * tabs, append it as an unpinned one. A durable store write happens only when something actually
 * navigates - `use-open-item.ts`'s `openPreview`/`openPinned`/`openBeside`.
 */
export interface DocumentTabsResult {
  readonly tabs: readonly OpenTab[];
}

export function useDocumentTabs(paneIndex: number, activeItemId: string): DocumentTabsResult {
  const [searchParams] = useSearchParams();
  const byPane = useTabStore((state) => state.byPane);
  const addressed = parsePanes(searchParams).panes;

  // Browser history can restore a multi-pane address after a destination or hidden-pane open
  // collapsed the working set into pane zero. Active URL state owns a document ahead of stale
  // session tabs, and a background tab with no active owner belongs to the first addressed pane
  // that still records it. Deriving that ownership here prevents the same tab being activated in
  // two strips and mounting two collaboration sessions for one document.
  return { tabs: tabsForPane(paneIndex, activeItemId, addressed, byPane) };
}
