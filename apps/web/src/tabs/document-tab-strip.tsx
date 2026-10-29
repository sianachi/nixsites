import {
  Icon,
  Select,
  Tabs,
  Text,
  cn,
  focusRing,
  inkWashStates,
  type MenuEntry,
  type TabItem,
} from '@nix/ui';
import { PanelLeft, PanelTop, Pin, X } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import { useMediaQuery } from '@nix/web-foundation/layout/viewport';
import { copyLinkEntry } from '../collections/items/item-menu-entries';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { CHAT_PARAM, paneParam } from '@nix/web-platform/panes/pane-params';
import type { PaneState } from '@nix/web-platform/panes/pane-state';
import type { ShellContext } from '../shell/shell-context';
import { useSelectedItem } from '@nix/web-platform/routing/selected-item';
import { useOptionalWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import {
  carriesTabTransfer,
  readTabTransfer,
  writeTabTransfer,
  type TabTransferPayload,
} from './tab-transfer';
import { useTabOrientationStore } from './tab-orientation-store';
import {
  chatScopeOfTab,
  chatTabId,
  isChatTabId,
  useTabStore,
} from '@nix/web-foundation/lib/tab-store';
import { useDocumentTabs } from './use-document-tabs';
import { useOpenChat } from './use-open-chat';
import { useOpenItem } from './use-open-item';

/**
 * One pane's open documents.
 *
 * **This is not the tab strip `app-shell.tsx` and `view-switcher.tsx` describe rejecting.** Those
 * rejected turning a *view of one container* (Board vs. List) or a *page in the shell's chrome*
 * into a destination. This strip does neither: it does not choose how to look at anything, and it
 * is not shell chrome - it lives inside one pane and chooses which **item's own screen** (its
 * body, its own `ViewSwitcher`, its own breadcrumbs) that pane currently mounts. A pane held
 * exactly one item before panes could hold more than one at a time; this is that, not a reopening
 * of either prior decision. If you are about to remove this on the grounds that "we already
 * decided against tabs", re-read `pane-state.ts`'s `openBeside` doc comment first - the
 * multi-document problem this solves already existed.
 *
 * Closing the last tab in a pane closes the pane itself, matching an editor group whose last file
 * closes: there is no shape here for an empty pane to render, and inventing one would be a second
 * way to say "nothing is open" beside the one `EditorPage` already has. Closing the last tab of
 * the last pane clears the selection instead, which is the same empty state.
 *
 * **Horizontal or vertical is one preference for every pane, not one per pane** - see
 * `tab-orientation-store.ts`. The toggle lives here, beside the tabs it changes, rather than in a
 * settings screen this product does not otherwise have one of.
 */
export interface DocumentTabStripProps {
  readonly paneIndex: number;
  readonly tree: ShellContext['tree'];
  readonly activeItemId: string;

  /** The conversation scope this pane shows instead of its item, when it does. */
  readonly activeChat: string | undefined;
  readonly visiblePanes: readonly PaneState[];
  readonly draggedTab: TabTransferPayload | null;
  readonly onTabDragStarted: (payload: TabTransferPayload) => void;
  readonly onTabDragEnded: () => void;
  readonly onMoveTab: (
    payload: TabTransferPayload,
    destinationPane: number,
    title: string,
  ) => boolean;

  /** Closes this pane. Absent when it is the only one, matching `OpenItem`'s own `onClose`. */
  readonly onClosePane: (() => void) | undefined;
}

export function DocumentTabStrip({
  paneIndex,
  tree,
  activeItemId,
  activeChat,
  visiblePanes,
  draggedTab,
  onTabDragStarted,
  onTabDragEnded,
  onMoveTab,
  onClosePane,
}: DocumentTabStripProps): ReactNode {
  const { tabs } = useDocumentTabs(paneIndex, activeItemId);
  const { clear } = useSelectedItem();
  const { activateTab } = useOpenItem();
  const openChat = useOpenChat();
  const [searchParams, setSearchParams] = useSearchParams();
  // The tab showing: the conversation when the pane has one open, else its item.
  const activeId = activeChat === undefined ? activeItemId : chatTabId(activeChat);
  // A conversation opened by a link is only in the address; keep it as a tab once the pane moves
  // on to a note, the way one opened from the menu already is.
  const chatRecorded = useTabStore((state) =>
    (state.byPane[paneIndex] ?? []).some((tab) => tab.itemId === activeId),
  );
  const tabPinned = useTabStore((state) => state.tabPinned);
  // Set when the conversation is closed, so the record is not made again before the address follows.
  const dismissedChat = useRef<string | null>(null);
  useEffect(() => {
    if (activeChat === undefined) dismissedChat.current = null;
    else if (!chatRecorded && dismissedChat.current !== activeId) tabPinned(paneIndex, activeId);
  }, [activeChat, activeId, chatRecorded, tabPinned, paneIndex]);
  const tabClosed = useTabStore((state) => state.tabClosed);
  const workspace = useOptionalWorkspace();
  const orientation = useTabOrientationStore((state) => state.orientation);
  const orientationToggled = useTabOrientationStore((state) => state.orientationToggled);
  const finePointer = useMediaQuery('(pointer: fine)');
  // The payload object is the drag session token. A cancelled drag may leave this local value
  // behind after its source unmounts, but a later drag creates a different object, so stale
  // highlighting cannot revive before that later pointer actually enters this strip.
  const [dropTarget, setDropTarget] = useState<TabTransferPayload | null>(null);

  const items: TabItem[] = tabs.map((tab) => {
    const scope = chatScopeOfTab(tab.itemId);
    if (scope !== null) {
      const noteTitle = scope === 'workspace' ? undefined : tree.find(scope)?.title;
      return {
        id: tab.itemId,
        label: noteTitle !== undefined && noteTitle.length > 0 ? `Chat: ${noteTitle}` : 'Chat',
        pinned: true,
      };
    }
    const title = tree.find(tab.itemId)?.title;

    return {
      id: tab.itemId,
      // `??` alone would not catch an empty string, and an untitled note is ordinary - the same
      // reasoning `editor-page.tsx`'s `describe()` gives for a pane's own fallback name.
      label: title !== undefined && title.length > 0 ? title : 'Untitled',
      pinned: tab.pinned,
    };
  });

  const activeTitle = items.find((item) => item.id === activeId)?.label ?? 'Untitled';
  const destinations = visiblePanes.filter((pane) => pane.index !== paneIndex);
  const canReceive =
    draggedTab !== null &&
    draggedTab.sourcePane !== paneIndex &&
    destinations.some((pane) => pane.index === draggedTab.sourcePane);

  function onDragEnter(event: DragEvent<HTMLDivElement>): void {
    if (canReceive && carriesTabTransfer(event.dataTransfer)) {
      event.preventDefault();
      setDropTarget(draggedTab);
    }
  }

  function onDragOver(event: DragEvent<HTMLDivElement>): void {
    if (canReceive && carriesTabTransfer(event.dataTransfer)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    if (!canReceive || !carriesTabTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    setDropTarget(null);
    const payload = readTabTransfer(event.dataTransfer);
    if (
      payload !== null &&
      payload.itemId === draggedTab.itemId &&
      payload.sourcePane === draggedTab.sourcePane
    ) {
      const title = tree.find(payload.itemId)?.title ?? '';
      onMoveTab(payload, paneIndex, title);
    }
    onTabDragEnded();
  }

  /** The pane goes back to its item. Replaces, so Back does not reopen a conversation just closed. */
  function leaveChat(): void {
    const next = new URLSearchParams(searchParams);
    next.delete(paneParam(CHAT_PARAM, paneIndex));
    setSearchParams(next, { replace: true });
  }

  function handleClose(itemId: string): void {
    // Closing a conversation never empties the pane: its item is still open beneath it.
    if (isChatTabId(itemId)) {
      dismissedChat.current = itemId;
      tabClosed(itemId);
      if (itemId === activeId) leaveChat();
      return;
    }

    // Conversations are not documents: a pane whose last document closes closes with them.
    const documents = tabs.filter((tab) => !isChatTabId(tab.itemId));
    const index = documents.findIndex((tab) => tab.itemId === itemId);
    const remaining = documents.filter((tab) => tab.itemId !== itemId);

    tabClosed(itemId);

    if (remaining.length === 0) {
      for (const tab of tabs) if (isChatTabId(tab.itemId)) tabClosed(tab.itemId);
      if (onClosePane === undefined) {
        clear();
      } else {
        onClosePane();
      }
      return;
    }

    if (itemId === activeItemId) {
      // The immediate left neighbour, falling back to the right when the closed tab was
      // leftmost - the same convention VS Code's own tab strip uses.
      const neighbor = remaining[Math.max(0, index - 1)];
      if (neighbor !== undefined) {
        activateTab(neighbor.itemId);
      }
    }
  }

  function activate(id: string): void {
    const scope = chatScopeOfTab(id);
    if (scope !== null) openChat(scope === 'workspace' ? null : scope);
    else activateTab(id);
  }

  /**
   * Closes several tabs at once, keeping `keep` open and showing it if the showing tab is among
   * those closed - the editor-group convention for "Close Others" and "Close to the Right".
   */
  function closeAllBut(keep: string, requested: readonly string[]): void {
    // Keeping a conversation keeps the item it sits on: that item is the pane's address.
    const closing = isChatTabId(keep) ? requested.filter((id) => id !== activeItemId) : requested;
    if (closing.length === 0) return;
    if (closing.includes(activeId)) activate(keep);
    if (closing.includes(activeId)) dismissedChat.current = activeId;
    for (const itemId of closing) tabClosed(itemId);
    publishNotice({
      key: 'tabs-closed',
      message: `${String(closing.length)} ${closing.length === 1 ? 'tab' : 'tabs'} closed.`,
    });
  }

  function tabActions(itemId: string): MenuEntry[] {
    const index = tabs.findIndex((tab) => tab.itemId === itemId);
    const tab = tabs[index];
    if (tab === undefined) return [];
    const others = tabs.filter((other) => other.itemId !== itemId).map((other) => other.itemId);
    const toTheRight = tabs.slice(index + 1).map((other) => other.itemId);
    const title = items[index]?.label ?? 'Untitled';
    return [
      {
        kind: 'action',
        label: 'Close',
        icon: X,
        shortcut: 'Delete',
        onSelect: () => {
          handleClose(itemId);
        },
      },
      {
        kind: 'action',
        label: 'Close other tabs',
        disabled: others.length === 0,
        onSelect: () => {
          closeAllBut(itemId, others);
        },
      },
      {
        kind: 'action',
        label: 'Close tabs to the right',
        disabled: toTheRight.length === 0,
        onSelect: () => {
          closeAllBut(itemId, toTheRight);
        },
      },
      // A conversation is always kept and has no document link to copy.
      ...(isChatTabId(itemId) ? [] : [{ kind: 'separator' as const }]),
      ...(tab.pinned || isChatTabId(itemId)
        ? []
        : [
            {
              kind: 'action' as const,
              label: 'Keep open',
              icon: Pin,
              onSelect: () => {
                tabPinned(paneIndex, itemId);
              },
            },
          ]),
      ...(workspace === null || isChatTabId(itemId)
        ? []
        : [copyLinkEntry(workspace.workspaceId, itemId, title)]),
    ];
  }

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropTarget(null);
        }
      }}
      onDrop={onDrop}
      className={cn(
        'relative flex min-w-0',
        orientation === 'vertical' ? 'flex-col' : 'flex-row items-center',
        dropTarget === draggedTab &&
          canReceive &&
          'bg-accent/10 outline-2 -outline-offset-2 outline-accent',
      )}
    >
      <Tabs
        label="Open documents"
        items={items}
        activeId={activeId}
        orientation={orientation}
        onActivate={(itemId) => {
          if (itemId !== activeId) {
            activate(itemId);
          }
        }}
        onClose={handleClose}
        contextMenu={tabActions}
        {...(finePointer && destinations.length > 0
          ? {
              drag: {
                onStart: (itemId: string, event: DragEvent<HTMLElement>) => {
                  // A conversation is bound to its pane's runtime; it is not moved between panes.
                  if (isChatTabId(itemId)) {
                    event.preventDefault();
                    return;
                  }
                  const payload: TabTransferPayload = {
                    version: 1,
                    itemId,
                    sourcePane: paneIndex,
                  };
                  writeTabTransfer(event.dataTransfer, payload);
                  onTabDragStarted(payload);
                },
                onEnd: () => {
                  setDropTarget(null);
                  onTabDragEnded();
                },
              },
            }
          : {})}
        className="min-w-0 flex-1"
      />

      <div
        className={cn(
          'flex shrink-0',
          orientation === 'vertical' ? 'flex-col items-stretch' : 'flex-row items-center',
        )}
      >
        {destinations.length > 0 && activeChat === undefined ? (
          <Select
            value=""
            aria-label={`Move active tab, ${activeTitle}, to another pane`}
            onChange={(event) => {
              const destination = Number(event.currentTarget.value);
              if (Number.isInteger(destination)) {
                onMoveTab(
                  { version: 1, itemId: activeItemId, sourcePane: paneIndex },
                  destination,
                  activeTitle,
                );
              }
            }}
            className="h-(--control-sm) w-40 max-w-full px-2 text-xs focus-visible:-outline-offset-2"
          >
            <option value="" disabled>
              Move active tab…
            </option>
            {destinations.map((pane) => {
              const title = tree.find(pane.itemId)?.title;
              return (
                <option key={pane.index} value={pane.index}>
                  Pane {String(pane.index + 1)}:{' '}
                  {title !== undefined && title.length > 0 ? title : 'Untitled'}
                </option>
              );
            })}
          </Select>
        ) : null}

        {/* Beside the strip it changes, not in a settings screen this product does not have one
            of. The icon names the *destination* layout, the same convention the sidebar's own
            collapse control uses. */}
        <button
          type="button"
          aria-label={
            orientation === 'vertical' ? 'Show tabs across the top' : 'Show tabs on the side'
          }
          onClick={orientationToggled}
          className={cn(
            'flex shrink-0 items-center justify-center p-1.5 text-muted hover:text-foreground any-pointer-coarse:min-h-(--control-lg) any-pointer-coarse:min-w-(--control-lg)',
            focusRing,
            inkWashStates,
          )}
        >
          <Icon icon={orientation === 'vertical' ? PanelTop : PanelLeft} size="sm" />
        </button>
      </div>

      {dropTarget === draggedTab && canReceive ? (
        <Text
          as="span"
          variant="caption"
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-accent-fill px-2 py-1 text-background shadow-sm"
        >
          Drop tab here
        </Text>
      ) : null}
    </div>
  );
}
