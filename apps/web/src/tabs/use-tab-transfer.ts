import { TITLE_ROW_TABS_ID } from './title-row-slot';
import { useLocation, useSearchParams } from 'react-router';
import { useLayoutEffect, useRef } from 'react';
import { useUndo } from '@nix/ui';

import { announce } from '@nix/web-foundation/a11y/announcer';
import { paneElementId } from '@nix/web-platform/panes/pane-params';
import {
  planTabTransfer,
  type TabDockEdge,
  type TabTransferPayload,
  type TabTransferRefusal,
} from './tab-transfer';
import { useTabStore } from '@nix/web-foundation/lib/tab-store';
import { useRoomForAnotherPane } from '@nix/web-foundation/layout/viewport';
import { publishNotice } from '@nix/web-foundation/lib/notices';

const REFUSAL_COPY: Readonly<Record<TabTransferRefusal, string>> = {
  'same-pane': 'That tab is already in this pane.',
  'hidden-pane': 'That pane is no longer visible.',
  'missing-pane': 'That pane is no longer open.',
  'stale-tab': 'That tab can no longer be moved.',
  limit: 'Close a pane before docking another tab.',
};

export interface TabTransferControl {
  readonly canDockTab: (payload: TabTransferPayload, destinationPane: number) => boolean;
  readonly moveTab: (
    payload: TabTransferPayload,
    destinationPane: number,
    title: string,
    edge?: TabDockEdge,
  ) => boolean;
}

function focusMovedTab(pane: number): void {
  requestAnimationFrame(() => {
    // The first pane's strip is drawn in the title row, outside its pane.
    const roots = [document.getElementById(paneElementId(pane))];
    if (pane === 0) roots.push(document.getElementById(TITLE_ROW_TABS_ID));
    roots
      .flatMap(
        (root) => root?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? [],
      )
      .at(0)
      ?.focus();
  });
}

/** Coordinates the planner's URL and Zustand results without exposing an intermediate owner. */
export function useTabTransfer(visiblePaneIndexes: readonly number[]): TabTransferControl {
  const [searchParams, setSearchParams] = useSearchParams();
  const { pathname } = useLocation();
  const undo = useUndo();
  const address = `${pathname}?${searchParams.toString()}`;
  const currentAddress = useRef(address);
  useLayoutEffect(() => {
    currentAddress.current = address;
  }, [address]);
  const byPane = useTabStore((state) => state.byPane);
  const tabsTransferred = useTabStore((state) => state.tabsTransferred);
  const roomy = useRoomForAnotherPane();

  function canDockTab(payload: TabTransferPayload, destinationPane: number): boolean {
    return (
      roomy &&
      planTabTransfer({
        params: searchParams,
        byPane,
        visiblePaneIndexes,
        payload,
        destinationPane,
        edge: 'left',
      }).plan !== null
    );
  }

  function moveTab(
    payload: TabTransferPayload,
    destinationPane: number,
    title: string,
    edge?: TabDockEdge,
  ): boolean {
    if (edge !== undefined && !roomy) return false;
    const result = planTabTransfer({
      params: searchParams,
      byPane,
      visiblePaneIndexes,
      payload,
      destinationPane,
      edge,
    });

    if (result.plan === null) {
      announce(REFUSAL_COPY[result.refusal]);
      return false;
    }

    const { nextByPane, nextParams, finalDestinationPane } = result.plan;
    const label = `${edge === undefined ? 'Moved' : 'Docked'} ${title || 'Untitled'} to pane ${String(finalDestinationPane + 1)}.`;
    tabsTransferred(nextByPane);
    setSearchParams(nextParams);
    if (edge === undefined) announce(label);
    else {
      const after = `${pathname}?${nextParams.toString()}`;
      undo.push(label, () => {
        if (currentAddress.current !== after || useTabStore.getState().byPane !== nextByPane) {
          publishNotice({
            key: 'dock-undo',
            message: 'The panes changed after docking. Move the tab to dock it again.',
          });
          return;
        }
        tabsTransferred(byPane);
        setSearchParams(searchParams, { replace: true });
        focusMovedTab(payload.sourcePane);
      });
    }
    focusMovedTab(finalDestinationPane);
    return true;
  }

  return { moveTab, canDockTab };
}
