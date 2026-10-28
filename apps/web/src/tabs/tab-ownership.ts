import type { PaneState } from '../panes/pane-state';
import { chatTabId, itemIsPinned, type OpenTab } from '../lib/tab-store';

/**
 * Finds the one addressed pane that owns a document.
 *
 * The URL's active document wins over session-local background tabs. Otherwise, the first
 * addressed pane recording the tab owns it. Keeping this precedence in one pure function makes
 * the open path and every rendered tab strip enforce the same collaboration-session invariant.
 */
export function ownerOfItem(
  itemId: string,
  addressedPanes: readonly PaneState[],
  byPane: Readonly<Record<number, readonly OpenTab[]>>,
): number | null {
  const active = addressedPanes.find(
    (pane) =>
      pane.itemId === itemId || (pane.chat !== undefined && chatTabId(pane.chat) === itemId),
  );
  if (active !== undefined) {
    return active.index;
  }

  const background = addressedPanes.find((pane) =>
    (byPane[pane.index] ?? []).some((tab) => tab.itemId === itemId),
  );
  return background?.index ?? null;
}

/**
 * Materializes one pane's complete strip from its session tabs and URL-owned active document.
 *
 * Kept pure because tab transfer needs the same answer for both source and destination before it
 * changes either owner. A fresh split link has no Zustand records at all, so transferring from the
 * stored arrays alone would silently lose the destination's old active document.
 */
export function tabsForPane(
  paneIndex: number,
  activeItemId: string,
  addressed: readonly PaneState[],
  byPane: Readonly<Record<number, readonly OpenTab[]>>,
): readonly OpenTab[] {
  const stored = byPane[paneIndex] ?? [];
  const owned = stored.filter((tab) => {
    const owner = ownerOfItem(tab.itemId, addressed, byPane);
    return owner === null || owner === paneIndex;
  });

  const activeChat = addressed.find((pane) => pane.index === paneIndex)?.chat;
  const withItem = owned.some((tab) => tab.itemId === activeItemId)
    ? owned
    : [...owned, { itemId: activeItemId, pinned: itemIsPinned(byPane, activeItemId) }];

  // The pane's open conversation is a tab beside its item, always pinned.
  return activeChat === undefined || withItem.some((tab) => tab.itemId === chatTabId(activeChat))
    ? withItem
    : [...withItem, { itemId: chatTabId(activeChat), pinned: true }];
}
