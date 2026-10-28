import { useCallback } from 'react';
import { useLocation, useNavigate, useSearchParams, type NavigateFunction } from 'react-router';

import { announce } from '@nix/web-foundation/a11y/announcer';
import { usePaneIndex } from '../panes/pane-context';
import { focusPane } from '../panes/pane-params';
import { BESIDE_REFUSAL_COPY, parsePanes, usePanes, type BesideRefusal } from '../panes/pane-state';
import { useSelectedItem, writeSelectedItem } from '../routing/selected-item';
import { ownerOfItem } from './tab-ownership';
import { useTabStore, type OpenTab } from '@nix/web-foundation/lib/tab-store';
import { withViewTransition } from '@nix/web-foundation/lib/view-transition';

/**
 * The one door a document is opened through - previewed, pinned, or opened beside - and the
 * place cross-pane deduplication lives.
 *
 * **Why this exists rather than calling `useSelectedItem`/`usePanes` directly.** Those two only
 * know about the *active* item in each pane; once a pane can hold several backgrounded tabs, a
 * document can be open without being any pane's current `itemId`. Clicking a sidebar row for a
 * document that is sitting in pane 2's tab strip, backgrounded, has to focus pane 2 and switch it
 * there - not open a second copy in pane 0, which is what `useSelectedItem().select` alone would
 * do, and a second copy is exactly the "two `Y.Doc`s for one document" problem `pane-state.ts`'s
 * `openBeside` already exists to avoid for the active-item case.
 */

export interface OpenItemControl {
  /** A light-touch open - a sidebar click, a breadcrumb, an in-document link. Previews. */
  readonly openPreview: (itemId: string) => void;

  /** A committed open - a double-click, or promoting an existing tab. Pins. */
  readonly openPinned: (itemId: string) => void;

  /** Opens in another pane, pinned immediately - an explicit "beside" is already deliberate. */
  readonly openBeside: (itemId: string) => number | null;

  /** Activates a tab without moving focus away from its tablist or announcing a duplicate open. */
  readonly activateTab: (itemId: string) => void;

  readonly canOpenBeside: boolean;
  readonly besideRefusal: OpenBesideRefusal | null;
}

export type OpenBesideRefusal = BesideRefusal | 'destination';

export const OPEN_BESIDE_REFUSAL_COPY: Readonly<Record<OpenBesideRefusal, string>> = {
  ...BESIDE_REFUSAL_COPY,
  destination: 'Open a note before opening another beside it.',
};

/**
 * Replaces any addressed pane arrangement with one visible document.
 *
 * A module function rather than another memoized hook callback: it owns no state and callers pass
 * every effect explicitly, so it has stable identity without adding a manual-memoization contract.
 */
function openAsOnlyPane(
  itemId: string,
  pinned: boolean,
  editorPath: string,
  navigate: NavigateFunction,
  itemOpenedAlone: (itemId: string, pinned: boolean) => void,
): number {
  const next = new URLSearchParams();
  writeSelectedItem(next, 0, itemId);
  itemOpenedAlone(itemId, pinned);
  void navigate(`${editorPath}?${next.toString()}`);
  focusPane(0);
  return 0;
}

/** Claims a history-restored active tab for this pane before another document replaces it. */
function claimRestoredActiveTab(
  searchParams: URLSearchParams,
  byPane: Readonly<Record<number, readonly OpenTab[]>>,
  pane: number,
  tabActivated: (pane: number, itemId: string) => void,
): void {
  const active = parsePanes(searchParams).panes.find((candidate) => candidate.index === pane);
  const recordedElsewhere =
    active !== undefined &&
    Object.entries(byPane).some(
      ([key, tabs]) => Number(key) !== pane && tabs.some((tab) => tab.itemId === active.itemId),
    );
  if (active !== undefined && recordedElsewhere) {
    tabActivated(pane, active.itemId);
  }
}

export function useOpenItem(): OpenItemControl {
  const pane = usePaneIndex();
  const { select } = useSelectedItem();
  const paneControl = usePanes();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const editorPath = /^\/w\/[^/]+/.exec(location.pathname)?.[0] ?? '/';
  const isEditorRoute = location.pathname === editorPath;
  const byPane = useTabStore((state) => state.byPane);
  const itemOpenedAlone = useTabStore((state) => state.itemOpenedAlone);
  const tabPreviewed = useTabStore((state) => state.tabPreviewed);
  const tabPinned = useTabStore((state) => state.tabPinned);
  const tabActivated = useTabStore((state) => state.tabActivated);
  /** Which pane already has this document open, active or backgrounded - null if none does. */
  const locate = useCallback(
    (itemId: string): number | null => {
      const addressedPanes = parsePanes(searchParams).panes;
      return ownerOfItem(itemId, addressedPanes, byPane);
    },
    [searchParams, byPane],
  );

  /** Makes an already-open document the pane's active tab and moves focus there. */
  const focusExisting = useCallback(
    (foundPane: number, itemId: string): void => {
      const alreadyActive = paneControl.panes.some(
        (candidate) => candidate.index === foundPane && candidate.itemId === itemId,
      );

      if (!alreadyActive) {
        const next = new URLSearchParams(searchParams);
        writeSelectedItem(next, foundPane, itemId);
        setSearchParams(next);
      }

      announce(`Already open in pane ${String(foundPane + 1)}.`);
      focusPane(foundPane);
    },
    [paneControl.panes, searchParams, setSearchParams],
  );

  const activateTab = useCallback(
    (itemId: string): void => {
      const found = locate(itemId);
      if (found !== null && found !== pane) {
        focusExisting(found, itemId);
        return;
      }

      select(itemId);
      tabActivated(pane, itemId);
    },
    [locate, pane, focusExisting, select, tabActivated],
  );

  const openPreview = useCallback(
    (itemId: string): void => {
      if (!isEditorRoute) {
        openAsOnlyPane(itemId, false, editorPath, navigate, itemOpenedAlone);
        return;
      }

      const found = locate(itemId);
      if (found !== null) {
        if (!paneControl.panes.some((candidate) => candidate.index === found)) {
          openAsOnlyPane(itemId, false, editorPath, navigate, itemOpenedAlone);
          return;
        }
        focusExisting(found, itemId);
        return;
      }

      claimRestoredActiveTab(searchParams, byPane, pane, tabActivated);
      select(itemId);
      tabPreviewed(pane, itemId);
    },
    [
      isEditorRoute,
      editorPath,
      navigate,
      itemOpenedAlone,
      locate,
      paneControl.panes,
      focusExisting,
      searchParams,
      byPane,
      tabActivated,
      select,
      tabPreviewed,
      pane,
    ],
  );

  const openPinned = useCallback(
    (itemId: string): void => {
      if (!isEditorRoute) {
        openAsOnlyPane(itemId, true, editorPath, navigate, itemOpenedAlone);
        return;
      }

      const found = locate(itemId);
      if (found !== null) {
        if (!paneControl.panes.some((candidate) => candidate.index === found)) {
          openAsOnlyPane(itemId, true, editorPath, navigate, itemOpenedAlone);
          return;
        }
        focusExisting(found, itemId);
        tabPinned(found, itemId);
        return;
      }

      claimRestoredActiveTab(searchParams, byPane, pane, tabActivated);
      select(itemId);
      tabPinned(pane, itemId);
    },
    [
      isEditorRoute,
      editorPath,
      navigate,
      itemOpenedAlone,
      locate,
      paneControl.panes,
      focusExisting,
      searchParams,
      byPane,
      tabActivated,
      select,
      tabPinned,
      pane,
    ],
  );

  const besideRefusal: OpenBesideRefusal | null = isEditorRoute
    ? paneControl.besideRefusal
    : paneControl.besideRefusal === 'narrow'
      ? 'narrow'
      : 'destination';

  const openBeside = useCallback(
    (itemId: string): number | null => {
      if (!isEditorRoute) {
        announce(OPEN_BESIDE_REFUSAL_COPY[besideRefusal ?? 'destination']);
        return null;
      }

      // A later addressed pane may be hidden at this viewport width. Treat the gesture as the
      // narrow refusal before locating it, or focusing the hidden pane loses focus and still does
      // not satisfy the request to open something beside the visible document.
      if (besideRefusal === 'narrow') {
        announce(BESIDE_REFUSAL_COPY.narrow);
        return null;
      }

      const found = locate(itemId);
      if (found !== null) {
        focusExisting(found, itemId);
        tabPinned(found, itemId);
        return found;
      }

      const index = paneControl.openBeside(itemId);
      if (index !== null) {
        tabPinned(index, itemId);
      }
      return index;
    },
    [isEditorRoute, locate, focusExisting, tabPinned, paneControl, besideRefusal],
  );

  // Opening a document or switching tabs replaces what a pane shows, so it crossfades rather than
  // cuts (`withViewTransition` explains how, and when it steps aside). Memoized like the callbacks
  // they wrap: consumers hold these in effect dependencies and in props of memoized rows.
  const openPreviewTransition = useCallback(
    (itemId: string): void => {
      withViewTransition(() => {
        openPreview(itemId);
      });
    },
    [openPreview],
  );
  const openPinnedTransition = useCallback(
    (itemId: string): void => {
      withViewTransition(() => {
        openPinned(itemId);
      });
    },
    [openPinned],
  );
  const activateTabTransition = useCallback(
    (itemId: string): void => {
      withViewTransition(() => {
        activateTab(itemId);
      });
    },
    [activateTab],
  );

  return {
    openPreview: openPreviewTransition,
    openPinned: openPinnedTransition,
    openBeside,
    activateTab: activateTabTransition,
    canOpenBeside: besideRefusal === null,
    besideRefusal,
  };
}
