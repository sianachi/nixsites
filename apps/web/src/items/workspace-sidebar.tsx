import { NewChatNote } from '@nix/web-pets/pets/chat/new-chat-note';
import {
  Button,
  ContextMenu,
  Skeleton,
  chromeSurface,
  Icon,
  Menu,
  Text,
  cn,
  focusRing,
  type MenuEntry,
} from '@nix/ui';
import { files as fileResources, isNixApiError, items as coreItems } from '@nix/api-client';
import { collectDropped, uploadEntries } from './drop-upload';
import {
  ChevronDown,
  Columns2,
  FilePlus,
  Grid3x3,
  LayoutTemplate,
  Shapes,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { announce } from '@nix/web-foundation/a11y/announcer';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { BookmarkButton } from '../bookmarks/bookmark-button';
import { useBookmarksStore } from '@nix/web-collections/items/use-bookmarks';
import { type OpenBesideRefusal } from '../tabs/use-open-item';
import type { StructuredRecipeId } from '@nix/web-views/wizard/structured-recipes';
import type { TemplateLibraryStatus } from '@nix/web-templates/templates/use-templates';
import type { TemplateSummary } from '@nix/web-templates/templates/template-api';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { useHiddenItems } from '@nix/web-collections/items/use-hidden-items';
import { NewItemDialog, type NewItemDialogMode } from './new-item-dialog';
import { HiddenItemsPanel } from './hidden-items-panel';
import { TreeRow } from './tree-row';
import { handleRowMoveKey } from './tree-row-keys';
import { useRowDragDrop } from './use-row-drag-drop';
import { useRowMenuItems } from './use-row-menu-items';
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

  /** Opens the shell's guided setup route for a structured item. */
  readonly onStartStructured?: (parentId: string | null, recipe: StructuredRecipeId) => void;

  readonly templates?: readonly TemplateSummary[];
  readonly templateStatus?: TemplateLibraryStatus;
  readonly onStartTemplate?: (parentId: string | null, templateId: string) => void;
  readonly onBrowseTemplates?: (parentId: string | null) => void;
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
  const [uploading, setUploading] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadParentRef = useRef<string | null>(null);
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const landmarks = useItemLandmarks();
  const iconReturnFocus = useRef<HTMLElement | null>(null);
  const [iconItem, setIconItem] = useState<{
    readonly scope: string | null;
    readonly id: string;
    readonly title: string;
  } | null>(null);

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
    setUploading(true);
    setRefusal(null);
    try {
      const outcome = await uploadEntries(dropped, parentId, {
        createFolder: async (title, folderParentId) =>
          (
            await client.execute(
              coreItems.createItem(workspaceId, {
                type: 'note',
                title,
                parentId: folderParentId,
                // Core binds this key as a Guid, so no prefix.
                idempotencyKey: crypto.randomUUID(),
              }),
            )
          ).id,
        uploadFile: async (file, fileParentId) => {
          const upload = await client.execute(
            fileResources.beginUpload({
              workspaceId,
              parentId: fileParentId,
              fileName: file.name,
              mediaType: file.type || 'application/octet-stream',
              byteLength: file.size,
              idempotencyKey: `web-file:${crypto.randomUUID()}`,
            }),
          );
          await fileResources.uploadAndCompleteFile(client, upload, file);
        },
      });
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
      setUploading(false);
      if (uploadInputRef.current !== null) uploadInputRef.current.value = '';
    }
  }

  /** The explicit child destination offered alongside the workspace-level create actions. */
  const selectedItem = selectedId === null ? null : tree.find(selectedId);
  const childDestination =
    selectedItem === null ? null : { id: selectedItem.id, name: selectedItem.title || 'Untitled' };

  async function create(parentId: string | null, title: string, type: string): Promise<void> {
    setRefusal(null);
    const { id: created, refusal: reason } = await tree.create(parentId, title, type);

    if (reason !== null) {
      // Shown here, beside the control that was pressed. The refusal names the property at fault,
      // and a message that names a field is only useful next to the thing that has fields.
      setRefusal(reason);
      return;
    }

    // Selected on creation, so the thing that just appeared is the thing in front of you and its
    // name is ready to be typed over. Creating something and leaving it unfound in a tree is how
    // people end up with six items called "Untitled note".
    if (created !== null) {
      onSelect(created);
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
      <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-3">
        {/* Shown only when the whole row fits: at the default width it could only show "E…", and
            the region keeps its name for assistive technology either way. */}
        <Text as="span" variant="bodySmall" tone="muted" className="hidden @xs:inline">
          Explorer
        </Text>

        {/* One press, like Homebase's tile: an untitled note at the root, selected to be named. */}
        <Button
          variant="ghost"
          className="px-1.5 py-1 text-xs @xs:ml-auto"
          disabled={tree.status !== 'ready' || tree.isCreating}
          onClick={() => {
            void create(null, 'Untitled note', 'note');
          }}
        >
          <Icon icon={FilePlus} size="sm" />
          New note
        </Button>
        <CreateMenu
          childDestination={childDestination}
          disabled={tree.status !== 'ready' || tree.isCreating}
          onCreate={(parentId, title, type) => {
            void create(parentId, title, type);
          }}
          onStartStructured={(parentId, recipe) => {
            props.onStartStructured?.(parentId, recipe);
          }}
          templates={props.templates ?? []}
          templateStatus={props.templateStatus ?? 'loading'}
          onStartTemplate={(parentId, templateId) => {
            props.onStartTemplate?.(parentId, templateId);
          }}
          onBrowseTemplates={(parentId) => {
            props.onBrowseTemplates?.(parentId);
          }}
          onUpload={(parentId) => {
            uploadParentRef.current = parentId;
            uploadInputRef.current?.click();
          }}
        />
        <HiddenItemsPanel onOpen={onSelect} />
        <input
          ref={uploadInputRef}
          type="file"
          multiple
          className="sr-only"
          aria-label="Upload files"
          disabled={uploading}
          onChange={(event) => {
            void uploadFiles(Array.from(event.currentTarget.files ?? []), uploadParentRef.current);
          }}
        />
      </div>

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
            landmarks={landmarks.landmarks}
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

/**
 * The New menu's six entries: the three body kinds this client can draw, upload, and one entry
 * each for structured items and templates. Every entry opens `NewItemDialog`, which asks where the
 * item goes (and, for a plain item, its title) before anything is made.
 *
 * `item.type` is an open string on the server - there is one kind of item, and the type only says
 * how its body renders - so the kinds here are the client's vocabulary, not the schema's.
 *
 * Recording a meeting is not in this menu; it is in the command palette, beside the other actions
 * that are not "make an item here".
 */
const MENU_ENTRIES: readonly {
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly mode: NewItemDialogMode;
}[] = [
  { key: 'canvas', label: 'Canvas…', icon: Shapes, mode: { kind: 'item', type: 'canvas' } },
  { key: 'sheet', label: 'Sheet…', icon: Grid3x3, mode: { kind: 'item', type: 'spreadsheet' } },
  { key: 'upload', label: 'Upload files…', icon: Upload, mode: { kind: 'upload' } },
  { key: 'structured', label: 'Structured…', icon: Columns2, mode: { kind: 'structured' } },
  { key: 'template', label: 'From a template…', icon: LayoutTemplate, mode: { kind: 'template' } },
];

interface CreateMenuProps {
  readonly childDestination: { readonly id: string; readonly name: string } | null;
  readonly disabled: boolean;
  readonly onCreate: (parentId: string | null, title: string, type: string) => void;
  readonly onStartStructured: (parentId: string | null, recipe: StructuredRecipeId) => void;
  readonly templates: readonly TemplateSummary[];
  readonly templateStatus: TemplateLibraryStatus;
  readonly onStartTemplate: (parentId: string | null, templateId: string) => void;
  readonly onBrowseTemplates: (parentId: string | null) => void;
  readonly onUpload: (parentId: string | null) => void;
}

/**
 * "New view": every other kind of item, in a short menu, each entry of which opens a dialog.
 *
 * Built on `<Menu>` for its disclosure mechanics - open state, outside-click and Escape dismissal,
 * viewport-clamped placement, the phone bottom sheet, 44px touch targets, arrow-key roving. The
 * dialog is a sibling rather than a child of the menu, so closing the menu on selection does not
 * unmount the dialog it just opened.
 */
function CreateMenu({ childDestination, disabled, ...actions }: CreateMenuProps): ReactNode {
  const [mode, setMode] = useState<NewItemDialogMode | null>(null);
  const [newChat, setNewChat] = useState(false);
  const { workspaceId } = useWorkspace();

  const items: MenuEntry[] = MENU_ENTRIES.map((entry): MenuEntry => ({
    kind: 'action',
    key: entry.key,
    icon: entry.icon,
    label: entry.label,
    onSelect: () => {
      setMode(entry.mode);
    },
  }));

  items.push({
    kind: 'action',
    key: 'chat',
    label: 'Chat…',
    onSelect: () => {
      setNewChat(true);
    },
  });
  return (
    <>
      {newChat ? (
        <NewChatNote
          sourceWorkspaceIds={[workspaceId]}
          onClose={() => {
            setNewChat(false);
          }}
        />
      ) : null}
      <Menu label="New view" items={items}>
        {(trigger) => (
          <Button {...trigger} variant="ghost" className="px-1.5 py-1 text-xs" disabled={disabled}>
            New view
            <Icon icon={ChevronDown} size="sm" />
          </Button>
        )}
      </Menu>
      {mode === null ? null : (
        <NewItemDialog
          mode={mode}
          childDestination={childDestination}
          templates={actions.templates}
          templateStatus={actions.templateStatus}
          onClose={() => {
            setMode(null);
          }}
          onCreate={actions.onCreate}
          onUpload={actions.onUpload}
          onStartStructured={actions.onStartStructured}
          onStartTemplate={actions.onStartTemplate}
          onBrowseTemplates={actions.onBrowseTemplates}
        />
      )}
    </>
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
  readonly landmarks: ItemLandmarks;
  readonly onChooseIcon: ((item: TreeItem, invoker: HTMLElement | null) => void) | undefined;
}

/** A loading tree's rows: ragged, like titles, rather than a ruled table of equal bars. */
const TREE_SKELETON_WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3', 'w-5/12', 'w-3/5'] as const;

function TreeBody(props: TreeBodyProps): ReactNode {
  const { tree } = props;
  const visibility = useHiddenItems();

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
          : 'Nothing here yet. New note creates the first item.'}
      </Text>
    );
  }

  return (
    <ul role="tree" aria-label="Items" className="px-2 pb-3">
      {roots.map((item) => (
        <TreeNode key={item.id} item={item} depth={0} {...props} />
      ))}
    </ul>
  );
}

interface TreeNodeProps extends TreeBodyProps {
  readonly item: TreeItem;
  readonly depth: number;
}

function uploadErrorText(error: unknown): string {
  if (isNixApiError(error)) return error.detail ?? 'The file could not be uploaded.';
  return error instanceof Error ? error.message : 'The file could not be uploaded.';
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
  } = props;

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
    tree,
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
    void tree.move(item.id, null, lastRoot?.id ?? null).then((outcome) => {
      if (outcome.refusal !== null)
        publishNotice({ key: 'move-refused', message: outcome.refusal });
    });
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
    openButtonRef,
    moveToRoot,
  });

  const rowSelection = useOptionalItemSelection();
  const inSelection = rowSelection?.selected.has(item.id) === true;

  // The same gestures as every view: click opens, Cmd/Ctrl-click toggles, Shift-click ranges across
  // the siblings, Alt-click opens beside, Space toggles. `openBeside` is deliberately not gated
  // here: it refuses on its own - announcing the reason and writing nothing - which is the only
  // place the check can live and still be true of every caller.
  const gestures = rowGestures(
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
