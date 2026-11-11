import {
  Button,
  ContextMenu,
  Skeleton,
  chromeSurface,
  Icon,
  Text,
  cn,
  focusRing,
  useFlash,
} from '@nix/ui';
import { collectDropped, uploadErrorText, uploadWorkspaceEntries } from './drop-upload';
import { FilePlus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { announce } from '@nix/web-foundation/a11y/announcer';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { BookmarkButton } from '../bookmarks/bookmark-button';
import { useBookmarksStore } from '@nix/web-collections/items/use-bookmarks';
import { type OpenBesideRefusal } from '../tabs/use-open-item';
import { useHiddenItems } from '@nix/web-collections/items/use-hidden-items';
import { TreeRow } from './tree-row';
import { handleRowMoveKey } from './tree-row-keys';
import { useRowDragDrop } from './use-row-drag-drop';
import { useRowMenuItems } from './use-row-menu-items';
import { MobileItemMove } from './mobile-item-move';
import { useUndoableMove } from './use-undoable-move';
import { useOptionalItemCommands } from '@nix/web-collections/items/item-commands-context';
import {
  ItemSelectionContext,
  useOptionalItemSelection,
} from '@nix/web-collections/core/item-selection-context';
import { SelectionBar } from '@nix/web-views/core/selection-bar';
import {
  rowGestures,
  useItemSelection,
  useSelectionShortcuts,
} from '@nix/web-collections/core/use-item-selection';
import { capabilitiesOf } from '@nix/web-collections/core/view-capabilities';
import type { TreeItem, WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';
import { useItemLandmarks } from './use-item-landmarks';
import { ItemLandmarkDialog, ItemLandmarkIcon } from './item-landmark-dialog';
import { SharePublicLinkDialog } from './share-public-link-dialog';
import type { ItemLandmarks } from '@nix/web-foundation/lib/item-landmarks';

const NO_ROWS: readonly string[] = [];
const noRows = (): void => undefined;

/**
 * The workspace tree, in the sidebar, always on screen.
 *
 * It is part of the shell rather than of a page because it is how you move around the product; a
 * tree that appeared only on the editor screen would make every other screen a dead end you had to
 * navigate back out of.
 *
 * **Reordering and reparenting are drags, and a drag is a document edit like any other.** It goes
 * through the move endpoint, which refuses a folder dropped into its own subtree, so the one
 * genuinely destructive gesture in a tree is the one the server will not perform.
 */

export interface WorkspaceSidebarProps {
  readonly tree: WorkspaceTree;
  readonly selectedId: string | null;
  readonly onSelect: (itemId: string) => void;

  /**
   * Opens an item in a pane beside the ones already open.
   *
   * Separate from `onSelect` because it is a different intention - "as well as", not "instead
   * of" - and because the shell is the only thing that knows how many panes there are and
   * whether another will fit.
   */
  readonly onOpenBeside: (itemId: string) => void;

  /**
   * Commits to an item as a permanent tab, rather than the preview tab a plain click leaves
   * behind. A double-click, in the row's own established grammar - the same gesture a file
   * manager already uses to mean "open this one for real".
   */
  readonly onOpenPinned: (itemId: string) => void;

  /** Whether another pane would fit. A control that silently refuses reads as a broken one. */
  readonly canOpenBeside: boolean;

  /** Why not, when it would not - so the control can say what must change before it can work. */
  readonly besideRefusal: OpenBesideRefusal | null;

  /**
   * Deletes an item. Owned by `app-shell.tsx` rather than by this component - see its own
   * `requestDelete` for the full reasoning - because the undo toast it shows lives at shell level,
   * not nested inside whatever is currently presenting this sidebar. On a phone that presenter is
   * the off-canvas drawer (`sidebar-drawer.tsx`), and a toast nested inside it would unmount, undo
   * window and all, the moment the drawer closes - which is the very next thing a phone user does
   * after deleting something, to get back to their document.
   */
  readonly onDeleteItem: (item: TreeItem) => void;

  /**
   * Where focus should land once a delete toast's undo window closes, by any path. Supplied by
   * `app-shell.tsx` - which owns the toast - rather than created here, so the shell can pass the
   * same ref to `<Toast returnFocusRef>`. The row that opened a toast is gone by then - deleted,
   * which is why there is a toast at all - so there is no invoker to return focus to the way
   * `<Dialog>` does; this scroll region is the nearest thing that is still guaranteed to be there.
   */
  readonly treeRegionRef: RefObject<HTMLDivElement | null>;

  readonly onAdd?: () => void;
}

export function WorkspaceSidebar(props: WorkspaceSidebarProps): ReactNode {
  const {
    tree,
    selectedId,
    onSelect,
    onOpenBeside,
    onOpenPinned,
    canOpenBeside,
    besideRefusal,
    onDeleteItem,
    treeRegionRef,
  } = props;
  const [dragged, setDragged] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  // The row that just moved, tinted once where it landed (`useFlash` in the row).
  const [flashed, setFlashed] = useState<{ readonly id: string; readonly n: number } | null>(null);
  const flash = (id: string): void => {
    setFlashed((current) => ({ id, n: (current?.n ?? 0) + 1 }));
  };
  // "Move to..." for one row: the destination-then-position dialog the phone already uses.
  const [movingId, setMovingId] = useState<string | null>(null);
  // Several rows at once (requirement 7): Shift+click or the row menu's Select, then one move.
  const selection = useItemSelection();
  const commands = useOptionalItemCommands();
  const treeItemIds = tree.items.map((item) => item.id).join('\u0000');
  useEffect(() => {
    selection.prune(treeItemIds.length === 0 ? [] : treeItemIds.split('\u0000'));
    // `prune` is stable; the joined ids are what change when the tree does.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `prune` is stable; the joined ids change when the tree does.
  }, [treeItemIds]);
  const selectionValue = {
    selected: selection.selected,
    toggle: selection.toggle,
    capabilities: capabilitiesOf('list'),
    // The sidebar reads what it shows from its rows (below) rather than from a view.
    shown: NO_ROWS,
    show: noRows,
  };
  // Cmd/Ctrl-A and Escape, heard while focus is anywhere in the sidebar. What is shown is whatever
  // rows are drawn right now, in the order they are drawn: collapsed branches are not there.
  const asideRef = useRef<HTMLElement>(null);
  const shownRows = (): readonly string[] =>
    [...(asideRef.current?.querySelectorAll<HTMLElement>('[data-tree-item-id]') ?? [])].map(
      (row) => row.dataset.treeItemId ?? '',
    );
  const [shownCount, setShownCount] = useState(0);
  // After every render, but only while something is selected: the count feeds "Select all N", and
  // the drawn rows are DOM state that any render may have changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately no deps: the DOM rows can change on any render.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (selection.selected.size > 0) setShownCount(shownRows().length);
  });
  useSelectionShortcuts(asideRef, selection, shownRows);
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const landmarks = useItemLandmarks();
  const iconReturnFocus = useRef<HTMLElement | null>(null);
  const [iconItem, setIconItem] = useState<{
    readonly scope: string | null;
    readonly id: string;
    readonly title: string;
  } | null>(null);
  const [sharing, setSharing] = useState<{ readonly id: string; readonly title: string } | null>(
    null,
  );

  /** Drops queue behind each other: two pools at once would double the concurrency cap. */
  const uploadQueue = useRef<Promise<void>>(Promise.resolve());
  function uploadFiles(
    dropped: readonly (File | FileSystemEntry)[],
    parentId: string | null,
  ): Promise<void> {
    uploadQueue.current = uploadQueue.current.then(() => runUpload(dropped, parentId));
    return uploadQueue.current;
  }

  async function runUpload(
    dropped: readonly (File | FileSystemEntry)[],
    parentId: string | null,
  ): Promise<void> {
    if (dropped.length === 0) return;
    setRefusal(null);
    try {
      const outcome = await uploadWorkspaceEntries(client, workspaceId, dropped, parentId);
      const { folders, uploaded, failed, error } = outcome;
      if (failed > 0) {
        setRefusal(
          `${String(uploaded)} uploaded, ${String(failed)} failed: ${uploadErrorText(error)}`,
        );
      } else if (uploaded > 0) {
        announce(uploaded === 1 ? 'File uploaded.' : `${String(uploaded)} files uploaded.`);
      } else if (folders > 0) {
        announce(folders === 1 ? 'Folder created.' : `${String(folders)} folders created.`);
      }
    } catch (error) {
      setRefusal(uploadErrorText(error));
    } finally {
      await tree.reload();
    }
  }

  return (
    // The width belongs to the shell, which sizes and resizes the region this fills; a width
    // here as well would be two owners for one dimension.
    <aside
      ref={asideRef}
      aria-label="Explorer"
      // Rows handle their own OS drops; whatever reaches here landed on empty space: the root.
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        void uploadFiles(collectDropped(event.dataTransfer), null);
      }}
      className={cn('@container flex w-full flex-col overflow-hidden bg-surface', chromeSurface)}
    >
      {props.onAdd ? (
        <div className="flex shrink-0 justify-center px-3 py-3">
          <Button
            variant="ghost"
            aria-label="Add note"
            title="Add note"
            className="p-1.5"
            disabled={tree.status !== 'ready' || tree.isCreating}
            onClick={props.onAdd}
          >
            <Icon icon={FilePlus} size="md" />
          </Button>
        </div>
      ) : null}

      {refusal === null ? null : (
        <Text
          variant="caption"
          as="p"
          role="alert"
          className="mx-2 mb-2 rounded-md bg-background px-3 py-2"
        >
          {refusal}
        </Text>
      )}

      {/* `tabIndex={-1}`: not in the tab order on its own, but a legitimate script-focusable
          landing spot - see `treeRegionRef`'s own comment on why the delete toast returns focus
          here rather than to the row it deleted, which is gone by the time that matters. */}
      {selection.selected.size === 0 ? null : (
        <div className="mx-2 mb-2">
          <SelectionBar
            compact
            count={selection.selected.size}
            shownCount={selection.selected.size < shownCount ? shownCount : 0}
            onSelectAll={() => {
              selection.setAll(shownRows());
            }}
            onMove={
              commands === null
                ? undefined
                : () => {
                    commands.moveItems([...selection.selected]);
                  }
            }
            onDelete={
              commands === null
                ? undefined
                : () => {
                    void commands
                      .deleteItems(tree.items.filter((item) => selection.selected.has(item.id)))
                      .then((deleted) => {
                        const gone = new Set(deleted);
                        selection.setAll([...selection.selected].filter((id) => !gone.has(id)));
                      });
                  }
            }
            onClear={selection.clear}
          />
        </div>
      )}
      <div ref={treeRegionRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto">
        <SidebarPins onSelect={onSelect} selectedId={selectedId} landmarks={landmarks.landmarks} />
        <ItemSelectionContext value={selectionValue}>
          <TreeBody
            tree={tree}
            selectedId={selectedId}
            onSelect={onSelect}
            onOpenBeside={onOpenBeside}
            onOpenPinned={onOpenPinned}
            canOpenBeside={canOpenBeside}
            besideRefusal={besideRefusal}
            dragged={dragged}
            setDragged={setDragged}
            onDropFiles={(dropped, parentId) => {
              void uploadFiles(dropped, parentId);
            }}
            onDeleteItem={onDeleteItem}
            flashed={flashed}
            onFlash={flash}
            onMoveItem={setMovingId}
            landmarks={landmarks.landmarks}
            onSharePublicLink={(item) => {
              setSharing({ id: item.id, title: item.title || 'Untitled' });
            }}
            onChooseIcon={
              landmarks.enabled
                ? (item, invoker) => {
                    iconReturnFocus.current = invoker;
                    setIconItem({
                      scope: landmarks.scope,
                      id: item.id,
                      title: item.title || 'Untitled',
                    });
                  }
                : undefined
            }
          />
        </ItemSelectionContext>
      </div>

      {/* The error lives at the foot rather than replacing the tree: a failed rename must not take
          away the items that loaded perfectly well. It is also where a failed delete surfaces -
          `app-shell.tsx`'s `requestDelete` shows no toast at all when `tree.remove` refuses, so
          this is the only report of it. */}
      {tree.error === null ? null : (
        <div role="alert" className="mx-2 mb-2 rounded-md bg-background px-3 py-2">
          <Text variant="caption" as="p" tone="muted">
            {tree.error}
          </Text>
        </div>
      )}
      {movingId === null ? null : (
        <MobileItemMove
          itemId={movingId}
          tree={tree}
          onMoved={flash}
          onClose={() => {
            setMovingId(null);
          }}
        />
      )}
      {sharing === null ? null : (
        <SharePublicLinkDialog
          key={sharing.id}
          itemId={sharing.id}
          title={sharing.title}
          onClose={() => {
            setSharing(null);
          }}
        />
      )}
      {iconItem?.scope !== landmarks.scope ? null : (
        <ItemLandmarkDialog
          key={`${workspaceId}:${iconItem.id}`}
          title={iconItem.title}
          landmark={landmarks.landmarks[iconItem.id]}
          onSave={(landmark) => {
            landmarks.save(iconItem.id, landmark);
          }}
          onClose={() => {
            setIconItem(null);
            const invoker = iconReturnFocus.current;
            requestAnimationFrame(() => {
              if (invoker?.isConnected === true) invoker.focus();
            });
          }}
        />
      )}
    </aside>
  );
}

interface TreeBodyProps {
  readonly tree: WorkspaceTree;
  readonly selectedId: string | null;
  readonly onSelect: (itemId: string) => void;
  readonly onOpenBeside: (itemId: string) => void;
  readonly onOpenPinned: (itemId: string) => void;
  readonly canOpenBeside: boolean;
  readonly besideRefusal: OpenBesideRefusal | null;
  readonly dragged: string | null;
  readonly setDragged: (itemId: string | null) => void;
  /** Uploads files and folders dropped from the OS into a parent (null for the root). */
  readonly onDropFiles: (dropped: (File | FileSystemEntry)[], parentId: string | null) => void;

  /** Deletes an item and starts its undo window. */
  readonly onDeleteItem: (item: TreeItem) => void;
  /** The row to tint now, and how to name one after a move. */
  readonly flashed: { readonly id: string; readonly n: number } | null;
  readonly onFlash: (itemId: string) => void;
  readonly onMoveItem: (itemId: string) => void;
  readonly landmarks: ItemLandmarks;
  readonly onChooseIcon: ((item: TreeItem, invoker: HTMLElement | null) => void) | undefined;
  readonly onSharePublicLink: (item: TreeItem) => void;
}

/** A loading tree's rows: ragged, like titles, rather than a ruled table of equal bars. */
const TREE_SKELETON_WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3', 'w-5/12', 'w-3/5'] as const;

function TreeBody(props: TreeBodyProps): ReactNode {
  const { tree, dragged, setDragged } = props;
  const visibility = useHiddenItems();
  const move = useUndoableMove(tree, props.onFlash);
  const [overTop, setOverTop] = useState(false);

  if (tree.status === 'loading') {
    // Rows in the positions the tree will take, so the sidebar fills in rather than appearing.
    return (
      <div role="status" aria-busy={true} className="flex flex-col gap-3 px-3 py-2.5">
        <span className="sr-only">Loading the workspace…</span>
        {TREE_SKELETON_WIDTHS.map((width, index) => (
          <Skeleton key={index} className={width} />
        ))}
      </div>
    );
  }

  if (tree.status === 'error') {
    return (
      <div role="alert" className="px-3 py-2">
        <Text variant="note" tone="muted" className="mb-2">
          {tree.error}
        </Text>
        <Button
          variant="secondary"
          className="px-2 py-1 text-xs"
          onClick={() => {
            void tree.reload();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  const roots = tree.childrenOf(null).filter((item) => !visibility.hiddenSet.has(item.id));
  if (roots.length === 0) {
    return (
      <Text variant="note" tone="muted" className="px-3 py-2">
        {tree.childrenOf(null).length > 0
          ? 'Items here are hidden for you. Open Hidden items to show them.'
          : 'Nothing here yet. Use Add note to get started.'}
      </Text>
    );
  }

  return (
    <ul role="tree" aria-label="Items" className="px-2 pb-3">
      {roots.map((item) => (
        <TreeNode key={item.id} item={item} depth={0} {...props} />
      ))}
      {/* Only while an item is being dragged: the way to the top level without a sibling to aim at. */}
      {dragged === null ? null : (
        <li
          role="presentation"
          onDragOver={(event) => {
            event.preventDefault();
            setOverTop(true);
          }}
          onDragLeave={() => {
            setOverTop(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setOverTop(false);
            const last = tree.childrenOf(null).filter((item) => item.id !== dragged);
            void move(dragged, null, last.at(-1)?.id ?? null);
            setDragged(null);
          }}
          className={cn(
            'mx-1 mt-3 rounded-md border border-dashed border-divider px-3 py-3 text-center',
            overTop && 'border-accent bg-accent/10',
          )}
        >
          <Text variant="caption" tone="muted">
            Drop here to move to the top level
          </Text>
        </li>
      )}
    </ul>
  );
}

interface TreeNodeProps extends TreeBodyProps {
  readonly item: TreeItem;
  readonly depth: number;
}

export { ROW_INDENT, CHILD_NOTICE_INDENT, indentAt, dropZoneAt } from './tree-geometry';
import { CHILD_NOTICE_INDENT, indentAt } from './tree-geometry';

function TreeNode(props: TreeNodeProps): ReactNode {
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const {
    item,
    depth,
    tree,
    selectedId,
    onSelect,
    onOpenBeside,
    onOpenPinned,
    canOpenBeside,
    besideRefusal,
    dragged,
    setDragged,
    onDropFiles,
    onDeleteItem,
    flashed,
    onFlash,
    onMoveItem,
  } = props;
  const move = useUndoableMove(tree, onFlash);
  const flashProps = useFlash(flashed?.id === item.id ? flashed.n : null);

  // Loading/revealing children must not opt the sidebar into showing them.
  const [expanded, setExpanded] = useState(false);
  const treeChildren = useHiddenItems('tree-children');
  const childrenHidden = treeChildren.hiddenSet.has(item.id);
  const visibility = useHiddenItems();
  const children = tree.childrenOf(item.id).filter((child) => !visibility.hiddenSet.has(child.id));
  const selected = selectedId === item.id;

  // Whether to offer an expand control at all. From the server's answer rather than from the
  // item's type: every item can hold children, so the alternative is a control on every row, most
  // of which would open onto nothing. Kept while expanded so emptying an item does not strip the
  // control out from under the pointer that just opened it.
  const expandable = !childrenHidden && (item.hasChildren || expanded);

  const siblings = tree.childrenOf(item.parentId);
  const index = siblings.findIndex((sibling) => sibling.id === item.id);
  const { zone, dropping, dragProps } = useRowDragDrop({
    item,
    move,
    previousId: index > 0 ? (siblings[index - 1]?.id ?? null) : null,
    dragged,
    setDragged,
    onDropFiles,
  });

  const title = item.title || 'Untitled';

  /**
   * Out of every parent, to the end of the workspace's top level - after the current last root, so
   * moving does not reorder the roots already there. Its refusal is said, not dropped: the row not
   * moving is otherwise indistinguishable from a click that missed.
   */
  function moveToRoot(): void {
    const lastRoot = tree.childrenOf(null).at(-1);
    void move(item.id, null, lastRoot?.id ?? null);
  }

  const contextItems = useRowMenuItems({
    item,
    title,
    tree,
    siblings,
    canOpenBeside,
    besideRefusal,
    onSelect,
    onOpenPinned,
    onOpenBeside,
    onDeleteItem,
    onChooseIcon: props.onChooseIcon,
    onSharePublicLink: props.onSharePublicLink,
    openButtonRef,
    moveToRoot,
    onMoveItem,
  });

  const rowSelection = useOptionalItemSelection();
  const inSelection = rowSelection?.selected.has(item.id) === true;

  // The same gestures as every view: click opens, Cmd/Ctrl-click toggles, Shift-click ranges across
  // the siblings, Alt-click opens beside, Space toggles. `openBeside` is deliberately not gated
  // here: it refuses on its own - announcing the reason and writing nothing - which is the only
  // place the check can live and still be true of every caller.
  const rowGesture = rowGestures(
    rowSelection,
    item.id,
    siblings.map((sibling) => sibling.id),
    () => {
      onSelect(item.id);
    },
    () => {
      onOpenBeside(item.id);
    },
  );
  // Cmd/Ctrl-click opens in a new tab, as in a browser; Shift-click and Space still select.
  const gestures = {
    ...rowGesture,
    onClick: (event: Parameters<typeof rowGesture.onClick>[0]) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey) {
        event.preventDefault();
        onOpenPinned(item.id);
      } else rowGesture.onClick(event);
    },
  };

  return (
    <li
      role="treeitem"
      aria-expanded={expandable ? expanded : undefined}
      aria-selected={selected || inSelection}
      data-tree-item-id={item.id}
    >
      <ContextMenu
        label={`${title} actions`}
        items={contextItems}
        // A touch long-press starts a selection; once one exists it opens the row menu as before.
        onLongPress={() => {
          if (rowSelection === null || rowSelection.selected.size > 0) return false;
          rowSelection.toggle(
            item.id,
            siblings.map((sibling) => sibling.id),
          );
          return true;
        }}
      >
        {(contextTarget) => (
          <TreeRow
            contextTarget={contextTarget}
            dragProps={dragProps}
            item={item}
            depth={depth}
            landmark={props.landmarks[item.id]}
            selected={selected}
            inSelection={inSelection}
            zone={zone}
            dropping={dropping}
            expandable={expandable}
            expanded={expanded}
            onToggleExpanded={() => {
              setExpanded(!expanded);
              if (!expanded && !tree.isExpanded(item.id)) void tree.toggle(item.id);
            }}
            gestures={gestures}
            onKeyDown={(event) => {
              gestures.onKeyDown(event);
              handleRowMoveKey(event, {
                item,
                tree,
                move,
                siblings,
                index,
                canOpenBeside,
                besideRefusal,
                onOpenBeside,
              });
            }}
            openButtonRef={openButtonRef}
            canOpenBeside={canOpenBeside}
            besideRefusal={besideRefusal}
            onOpenBeside={onOpenBeside}
            onOpenPinned={onOpenPinned}
            onDeleteItem={onDeleteItem}
            moveToRoot={moveToRoot}
            onMoveItem={onMoveItem}
            flashProps={flashProps}
            contextItems={contextItems}
          />
        )}
      </ContextMenu>

      {expanded && !childrenHidden ? (
        <ul role="group">
          {tree.isLoadingChildren(item.id) && children.length === 0 ? (
            <Text
              variant="note"
              as="li"
              tone="muted"
              className={`py-1 ${indentAt(CHILD_NOTICE_INDENT, depth)}`}
            >
              Loading…
            </Text>
          ) : children.length === 0 && tree.isLocked(item.id) ? (
            <Text
              variant="note"
              as="li"
              tone="muted"
              className={`py-1 ${indentAt(CHILD_NOTICE_INDENT, depth)}`}
            >
              Locked. Open it to unlock.
            </Text>
          ) : children.length === 0 ? (
            <Text
              variant="note"
              as="li"
              tone="muted"
              className={`py-1 ${indentAt(CHILD_NOTICE_INDENT, depth)}`}
            >
              Empty
            </Text>
          ) : (
            children.map((child) => (
              <TreeNode key={child.id} {...props} item={child} depth={depth + 1} />
            ))
          )}
        </ul>
      ) : null}
    </li>
  );
}

function SidebarPins({
  onSelect,
  selectedId,
  landmarks,
}: {
  readonly onSelect: (itemId: string) => void;
  readonly selectedId: string | null;
  readonly landmarks: ItemLandmarks;
}): ReactNode {
  const { workspaceId } = useWorkspace();
  const items = useBookmarksStore((state) => state.items);
  const status = useBookmarksStore((state) => state.status);
  const error = useBookmarksStore((state) => state.error);
  const visibility = useHiddenItems();
  const pins = items.filter(
    (item) => item.workspaceId === workspaceId && !visibility.hiddenSet.has(item.itemId),
  );
  return (
    <section aria-label="Pinned items" className="mx-2 mb-3 border-b border-divider px-2 pb-3">
      <Text as="p" variant="note" tone="muted" className="mb-2">
        Pinned items
      </Text>
      {status === 'loading' ? (
        <Text as="p" variant="caption">
          Loading pins…
        </Text>
      ) : null}
      {error ? (
        <Text as="p" variant="caption" role="status">
          Pins are unavailable. Open Bookmarks to retry.
        </Text>
      ) : null}
      {status === 'ready' && pins.length === 0 ? (
        <Text as="p" variant="caption" tone="muted">
          Bookmark an item to pin it here.
        </Text>
      ) : null}
      <ul>
        {pins.map((item) => (
          <li
            key={item.itemId}
            className={cn(
              'group flex min-w-0 items-center gap-2 rounded-md px-2',
              selectedId === item.itemId ? 'bg-accent/14' : 'hover:bg-accent/8',
            )}
          >
            <button
              type="button"
              aria-current={selectedId === item.itemId ? 'page' : undefined}
              className={`flex min-w-0 flex-1 items-center gap-2 py-2 text-left ${focusRing}`}
              onClick={() => {
                onSelect(item.itemId);
              }}
            >
              <ItemLandmarkIcon landmark={landmarks[item.itemId]} />
              <Text as="span" variant="bodySmall" truncate>
                {item.title !== null && item.title.length > 0 ? item.title : 'Untitled'}
              </Text>
            </button>
            <BookmarkButton
              itemId={item.itemId}
              title={item.title ?? ''}
              compact
              className="opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:pointer-events-auto max-sm:opacity-100 max-sm:pointer-events-auto"
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
