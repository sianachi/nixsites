import { useSearchParams } from 'react-router';

import { announce } from '@nix/web-foundation/a11y/announcer';
import { paneElementId } from '../panes/pane-params';
import { planTabTransfer, type TabTransferPayload, type TabTransferRefusal } from './tab-transfer';
import { useTabStore } from '@nix/web-foundation/lib/tab-store';

const REFUSAL_COPY: Readonly<Record<TabTransferRefusal, string>> = {
  'same-pane': 'That tab is already in this pane.',
  'hidden-pane': 'That pane is no longer visible.',
  'missing-pane': 'That pane is no longer open.',
  'stale-tab': 'That tab can no longer be moved.',
};

export interface TabTransferControl {
  readonly moveTab: (
    payload: TabTransferPayload,
    destinationPane: number,
    title: string,
  ) => boolean;
}

function focusMovedTab(pane: number): void {
  requestAnimationFrame(() => {
    document
      .getElementById(paneElementId(pane))
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.focus();
  });
}

/** Coordinates the planner's URL and Zustand results without exposing an intermediate owner. */
export function useTabTransfer(visiblePaneIndexes: readonly number[]): TabTransferControl {
  const [searchParams, setSearchParams] = useSearchParams();
  const byPane = useTabStore((state) => state.byPane);
  const tabsTransferred = useTabStore((state) => state.tabsTransferred);

  function moveTab(payload: TabTransferPayload, destinationPane: number, title: string): boolean {
    const result = planTabTransfer({
      params: searchParams,
      byPane,
      visiblePaneIndexes,
      payload,
      destinationPane,
    });

    if (result.plan === null) {
      announce(REFUSAL_COPY[result.refusal]);
      return false;
    }

    tabsTransferred(result.plan.nextByPane);
    setSearchParams(result.plan.nextParams);
    announce(
      `Moved ${title || 'Untitled'} to pane ${String(result.plan.finalDestinationPane + 1)}.`,
    );
    focusMovedTab(result.plan.finalDestinationPane);
    return true;
  }

  return { moveTab };
}
