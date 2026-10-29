import { NewChatNote } from '../views/chat/new-chat-note';
import {
  Button,
  ContextMenu,
  Skeleton,
  chromeSurface,
  Icon,
  Menu,
  Text,
  cn,
  disabledState,
  focusRing,
  type MenuEntry,
} from '@nix/ui';
import { files as fileResources, isNixApiError } from '@nix/api-client';
import {
  ChevronDown,
  ChevronRight,
  Columns2,
  ExternalLink,
  FilePlus,
  FileText,
  FolderLock,
  FolderPlus,
  FolderUp,
  Grid3x3,
  LayoutTemplate,
  Shapes,
  Shield,
  ShieldOff,
  Trash2,
  Upload,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { announce } from '@nix/web-foundation/a11y/announcer';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { BookmarkButton } from '../bookmarks/bookmark-button';
import { useBookmarksStore } from '../collections/items/use-bookmarks';
import { OPEN_BESIDE_REFUSAL_COPY, type OpenBesideRefusal } from '../tabs/use-open-item';
import type { StructuredRecipeId } from '../views/wizard/structured-recipes';
import type { TemplateLibraryStatus } from '../templates/use-templates';
import type { TemplateSummary } from '../templates/template-api';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { isApplePlatform } from '@nix/web-foundation/lib/shortcuts';
import { useAutomateEntry } from '../collections/items/automate-entry';
import { useMuteRemindersEntry } from '@nix/web-settings/settings/notifications/mute-reminders-entry';
import {
  bookmarkEntry,
  copyLinkEntry,
  treeChildrenEntry,
} from '../collections/items/item-menu-entries';
import { useHiddenItems } from '../collections/items/use-hidden-items';
import { NewItemDialog, type NewItemDialogMode } from './new-item-dialog';
import { HiddenItemsPanel } from './hidden-items-panel';
import { siblingMoveTarget } from './sibling-move-target';
import { useOptionalItemCommands } from '../collections/items/item-commands-context';
import {
  ItemSelectionContext,
  useOptionalItemSelection,
} from '../collections/core/item-selection-context';
import { SelectionBar } from '../views/core/selection-bar';
import {
  rowGestures,
  useItemSelection,
  useSelectionShortcuts,
} from '../collections/core/use-item-selection';
import { capabilitiesOf } from '../collections/core/view-capabilities';
import type { TreeItem, WorkspaceTree } from '../collections/items/use-workspace-tree';
import { useItemLandmarks } from './use-item-landmarks';
import { ItemLandmarkDialog, ItemLandmarkIcon } from './item-landmark-dialog';
import type { ItemLandmarks } from '@nix/web-foundation/lib/item-landmarks';

/** Whether this is an Apple platform, for the one gesture whose modifier differs. */
const APPLE = isApplePlatform();

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  async function uploadFiles(selected: FileList | null): Promise<void> {
    if (selected === null || selected.length === 0) return;
    setUploading(true);
    setRefusal(null);
    try {
      for (const file of Array.from(selected)) {
        const upload = await client.execute(
          fileResources.beginUpload({
            workspaceId,
            parentId: uploadParentRef.current,
            fileName: file.name,
            mediaType: file.type || 'application/octet-stream',
            byteLength: file.size,
            idempotencyKey: `web-file:${crypto.randomUUID()}`,
          }),
        );
        await fileResources.uploadAndCompleteFile(client, upload, file);
      }
      await tree.reload();
      announce(
        selected.length === 1 ? 'File uploaded.' : `${String(selected.length)} files uploaded.`,
      );
    } catch (error) {
      setRefusal(
        isNixApiError(error)
          ? (error.detail ?? 'The file could not be uploaded.')
          : error instanceof Error
            ? error.message
            : 'The file could not be uploaded.',
      );
    } finally {
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
      className={cn('flex w-full flex-col overflow-hidden bg-surface', chromeSurface)}
    >
      <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-3">
        <Text as="span" variant="bodySmall" tone="muted" truncate className="min-w-0 flex-1">
          Explorer
        </Text>

        {/* One press, like Homebase's tile: an untitled note at the root, selected to be named. */}
        <Button
          variant="ghost"
          className="ml-auto px-1.5 py-1 text-xs"
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
            void uploadFiles(event.currentTarget.files);
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
          : 'Nothing here yet. New creates the first item.'}
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

/**
 * Where on a row a drop would land.
 *
 * The row's middle band means inside; its top and bottom edges mean before and after, as siblings.
 * This distinction used to come free from the item's type - onto a folder meant inside, onto a note
 * meant beside - and with one kind of item there is nothing left to read it from but the pointer.
 *
 * The middle is deliberately the larger share. Dropping something *into* the thing under the
 * pointer is the common intent and the one that should be easy to hit; reordering is the
 * deliberate act, and its targets sit where a miss lands you inside rather than somewhere
 * surprising.
 */
type DropZone = 'before' | 'inside' | 'after';

const EDGE_BAND = 0.25;

/**
 * How far a row is pushed in for its depth, enumerated as classes.
 *
 * The tree used to compute `paddingLeft` and set it through `style`. Inline styles are banned
 * repository-wide (`app.css` says so, and the rule is why there is one stylesheet), and a CSS
 * custom property assigned through `style` is still an inline style - it moves the value, not the
 * attribute. So the depths are written out.
 *
 * The steps are the drawing's 6px base and 12px per level, rounded onto the spacing scale: a 2-unit
 * base and 3.5 units per level. `--spacing` is 3.4px, so `ROW_INDENT` runs 0.8px wide at the root
 * and closes to exactly the drawn value by its last step.
 *
 * `CHILD_NOTICE_INDENT` is that ladder one level down plus the row's own gutter - the expand chevron
 * (`size-5`) and the gap beside it, 6 units together - so "Loading…" and "Empty" line up with the
 * titles of the children they stand in for rather than with their chevrons. It runs 1.1px wide at
 * the root and 0.4px at its last step: the gutter was written as a round 26px and the chevron and
 * gap it stands for actually measure 20.4px, so these notices end up a hair better aligned than
 * they were drawn. That is the only entry in this file that moves by more than a pixel.
 *
 * **Bounded, deliberately.** Depth is unbounded in principle and the sidebar's width is not - it
 * starts at 264px and can be dragged down to 200 - so the indent cannot be unbounded in practice:
 * nine levels already spend 102px of the width, and a tenth would be taken from the title. Past the bound the indent stops growing and deeper rows share the last
 * step. Depth is still carried where it is load-bearing - `role="treeitem"`, `aria-expanded`, and
 * each level's own `role="group"` - so what a tenth level loses is the picture of its depth, not
 * the fact of it, and assistive technology is told the same thing either way.
 *
 * **The two ladders have to stop at the same place**, which is why this one is a step shorter.
 * `CHILD_NOTICE_INDENT[i]` stands for a row at depth `i + 1`, so it runs out one level sooner: with
 * a ninth entry, a notice under a depth-8 node sat 11.9px further in than the children that then
 * replaced it, and the placeholder visibly jumped as they loaded.
 *
 * Both of those are relationships between the two ladders rather than facts about either, so they
 * are asserted in `tree-indent.test.ts` rather than only described here - which is also why all
 * three names below are exported.
 */
export const ROW_INDENT = [
  'pl-2',
  'pl-5.5',
  'pl-9',
  'pl-12.5',
  'pl-16',
  'pl-19.5',
  'pl-23',
  'pl-26.5',
  'pl-30',
] as const;

export const CHILD_NOTICE_INDENT = [
  'pl-11.5',
  'pl-15',
  'pl-18.5',
  'pl-22',
  'pl-25.5',
  'pl-29',
  'pl-32.5',
  'pl-36',
] as const;

/** The step for a depth, clamped to the deepest one the sidebar has room to draw. */
export function indentAt(scale: readonly [string, ...string[]], depth: number): string {
  return scale[Math.min(Math.max(depth, 0), scale.length - 1)] ?? scale[0];
}

export function dropZoneAt(offsetY: number, height: number): DropZone {
  if (height <= 0) {
    return 'inside';
  }

  const position = offsetY / height;

  if (position < EDGE_BAND) {
    return 'before';
  }

  return position > 1 - EDGE_BAND ? 'after' : 'inside';
}

function TreeNode(props: TreeNodeProps): ReactNode {
  const openButtonRef = useRef<HTMLButtonElement>(null);
  // A selector rather than the whole store, so a row re-renders when its own answer moves and not
  // when somebody keeps an unrelated item three folders away.
  const keptIds = useBookmarksStore((state) => state.keptIds);
  const { workspaceId } = useWorkspace();
  const automateEntry = useAutomateEntry(workspaceId);
  const muteRemindersEntry = useMuteRemindersEntry();

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

  const [zone, setZone] = useState<DropZone | null>(null);
  const dropping = zone !== null && dragged !== null && dragged !== item.id;

  const siblings = tree.childrenOf(item.parentId);
  const index = siblings.findIndex((sibling) => sibling.id === item.id);
  const previous = index > 0 ? siblings[index - 1] : undefined;
  const next = index >= 0 ? siblings[index + 1] : undefined;

  function onDragStart(event: DragEvent<HTMLDivElement>): void {
    setDragged(item.id);
    event.dataTransfer.effectAllowed = 'move';
    // Set, though nothing reads it: without data attached, Firefox refuses to start the drag.
    event.dataTransfer.setData('text/plain', item.id);
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();

    const landing = zone;
    setZone(null);

    if (dragged === null || dragged === item.id || landing === null) {
      return;
    }

    // The server refuses an item dropped into its own subtree, so the one gesture that could break
    // the tree is the one it will not perform.
    void (landing === 'inside'
      ? tree.move(dragged, item.id, null)
      : tree.move(dragged, item.parentId, landing === 'after' ? item.id : (previous?.id ?? null)));

    setDragged(null);
  }

  /**
   * The same three moves, from the keyboard.
   *
   * A drop zone that exists only for a pointer is not a move affordance, it is a move affordance
   * for some people. These are the outliner bindings - the ones anybody who has used a list of
   * nested things already has in their fingers - and they map onto exactly the three landings a
   * drag can produce.
   */
  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (!event.altKey) {
      return;
    }

    // The keyboard half of a modifier-click. A gesture that only a pointer can make is a feature
    // for only some people - the same objection that gave the moves below their alt-arrows - and
    // Alt is already the modifier this row means business with.
    if (event.key === 'Enter') {
      event.preventDefault();
      if (canOpenBeside) {
        onOpenBeside(item.id);
      } else if (besideRefusal !== null) {
        // A pointer user gets a disabled control whose name explains itself; without this a
        // keyboard user gets silence, which reads as a broken key rather than a full screen.
        announce(OPEN_BESIDE_REFUSAL_COPY[besideRefusal]);
      }
      return;
    }

    if (event.key === 'ArrowUp' && previous !== undefined) {
      event.preventDefault();
      // Before the sibling above, which is after the one above that.
      void tree.move(item.id, item.parentId, siblingMoveTarget(siblings, index, 'up'));
      return;
    }

    if (event.key === 'ArrowDown' && next !== undefined) {
      event.preventDefault();
      void tree.move(item.id, item.parentId, siblingMoveTarget(siblings, index, 'down'));
      return;
    }

    if (event.key === 'ArrowRight' && previous !== undefined) {
      event.preventDefault();
      // Inside the sibling above, which is the only unambiguous "indent": the item below cannot
      // take it without reordering them both.
      void tree.move(item.id, previous.id, null);
      return;
    }

    if (event.key === 'ArrowLeft' && item.parentId !== null) {
      event.preventDefault();
      const parent = tree.find(item.parentId);
      void tree.move(item.id, parent?.parentId ?? null, item.parentId);
    }
  }

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

  /**
   * The row's actions, gathered where the right-click lands. Every one of them already exists as a
   * control or gesture on the row - this is the place a desktop user looks for them first, not a
   * second implementation. Built when the menu opens, so the bookmark entry names the current state.
   */
  const deleteProtected = item.noDelete === true;
  const managed = item.managedBy !== undefined && item.managedBy !== null;
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

  function contextItems(): MenuEntry[] {
    return [
      {
        kind: 'action',
        label: 'Open',
        icon: FileText,
        onSelect: () => {
          onSelect(item.id);
        },
      },
      ...(rowSelection === null
        ? []
        : [
            {
              kind: 'action' as const,
              label: inSelection ? 'Deselect' : 'Select',
              shortcut: APPLE ? '⌘ Click' : 'Ctrl+Click',
              onSelect: () => {
                rowSelection.toggle(
                  item.id,
                  siblings.map((sibling) => sibling.id),
                );
              },
            },
          ]),
      {
        kind: 'action',
        label: 'Open in a new tab',
        icon: ExternalLink,
        onSelect: () => {
          onOpenPinned(item.id);
        },
      },
      ...(besideRefusal === 'narrow'
        ? []
        : [
            {
              kind: 'action' as const,
              label: 'Open beside',
              icon: Columns2,
              shortcut: APPLE ? '⌥ Click' : 'Alt+Click',
              disabled: !canOpenBeside,
              onSelect: () => {
                onOpenBeside(item.id);
              },
            },
          ]),
      { kind: 'separator' },
      ...(visibility.enabled
        ? [
            {
              kind: 'action' as const,
              label: 'Hide for me',
              onSelect: () => {
                visibility.hide(item.id, title);
              },
            },
          ]
        : []),
      treeChildrenEntry(treeChildren, item.id, title),
      bookmarkEntry(item.id),
      ...(props.onChooseIcon === undefined
        ? []
        : [
            {
              kind: 'action' as const,
              label: 'Choose icon…',
              icon: Shapes,
              onSelect: () => {
                props.onChooseIcon?.(item, openButtonRef.current);
              },
            },
          ]),
      copyLinkEntry(workspaceId, item.id, title),
      ...(automateEntry === null ? [] : [automateEntry(item.id)]),
      ...(muteRemindersEntry === null ? [] : [muteRemindersEntry(item.id, title)]),
      ...(item.parentId === null
        ? []
        : [
            {
              kind: 'action' as const,
              label: 'Move to workspace root',
              icon: FolderUp,
              onSelect: () => {
                moveToRoot();
              },
            },
          ]),
      { kind: 'separator' },
      {
        kind: 'action',
        // A managed item's protection belongs to its linked calendar, so the entry stays, to say
        // why Delete is unavailable, but cannot be switched off from here.
        label: deleteProtected ? 'Allow deletion' : 'Protect from deletion',
        icon: deleteProtected ? ShieldOff : Shield,
        disabled: managed,
        onSelect: () => {
          void tree.setProtection(item.id, { noDelete: !deleteProtected });
        },
      },
      {
        kind: 'action',
        label: item.noChildren === true ? 'Allow new children' : 'Stop new children',
        icon: item.noChildren === true ? FolderPlus : FolderLock,
        onSelect: () => {
          void tree.setProtection(item.id, { noChildren: item.noChildren !== true });
        },
      },
      {
        kind: 'action',
        // Off means one editor at a time; the workspace's own switch can still keep it off.
        label: item.collaboration === false ? 'Allow editing together' : 'Edit one at a time',
        icon: item.collaboration === false ? Users : User,
        onSelect: () => {
          void tree.setProtection(item.id, { collaboration: item.collaboration === false });
        },
      },
      {
        kind: 'action',
        label: managed
          ? 'Delete (unlink the calendar in settings)'
          : deleteProtected
            ? 'Delete (protected)'
            : 'Delete',
        icon: Trash2,
        destructive: true,
        disabled: deleteProtected,
        onSelect: () => {
          onDeleteItem(item);
        },
      },
    ];
  }

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
          <div
            {...contextTarget}
            draggable
            onDragStart={onDragStart}
            onDragEnd={() => {
              setDragged(null);
              setZone(null);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              const box = event.currentTarget.getBoundingClientRect();
              setZone(dropZoneAt(event.clientY - box.top, box.height));
            }}
            onDragLeave={() => {
              setZone(null);
            }}
            onDrop={onDrop}
            className={[
              'group relative flex items-center gap-1 rounded-md pr-1',
              indentAt(ROW_INDENT, depth),
              selected ? 'bg-accent/14' : inSelection ? 'bg-accent/10' : 'hover:bg-accent/8',
              dropping && zone === 'inside' ? 'outline-2 -outline-offset-2 outline-accent' : '',
            ].join(' ')}
          >
            {/* A line where the item would land, rather than an outline round the row it would land
            beside. An outline says "into this"; a line between two rows says "between them", which
            is the thing being chosen. */}
            {dropping && zone !== 'inside' ? (
              <span
                aria-hidden="true"
                className={[
                  'pointer-events-none absolute inset-x-0 h-0.5 bg-accent',
                  zone === 'before' ? 'top-0' : 'bottom-0',
                ].join(' ')}
              />
            ) : null}

            {/* `max-sm:size-(--control-sm)` on both the button and its placeholder, narrow-scoped:
            below `sm` this is a touch target and 20px (`size-5`) is under WCAG 2.5.8's 24px floor,
            but the two have to grow together or a row without an expand control would sit at a
            different gutter width than one with it.

            `pointer-coarse:size-(--control-sm)` rides alongside it: `group-hover:*` only applies
            under `@media(hover:hover)` (Tailwind v4's `pointer-coarse:` variant maps to
            `@media(pointer:coarse)`), so a touch-capable device *above* `sm` - an iPad in portrait,
            say - would otherwise get neither the hover reveal nor the `max-sm:` override, leaving
            it unreachable rather than merely small. */}
            {expandable ? (
              <button
                type="button"
                data-context-menu-ignore
                aria-label={expanded ? `Collapse ${item.title}` : `Expand ${item.title}`}
                onClick={() => {
                  setExpanded(!expanded);
                  if (!expanded && !tree.isExpanded(item.id)) void tree.toggle(item.id);
                }}
                className="flex size-5 max-sm:size-(--control-sm) pointer-coarse:size-(--control-sm) items-center justify-center text-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
              >
                <Icon icon={expanded ? ChevronDown : ChevronRight} size="sm" />
              </button>
            ) : (
              <span
                aria-hidden="true"
                className="size-5 max-sm:size-(--control-sm) pointer-coarse:size-(--control-sm)"
              />
            )}

            <button
              ref={openButtonRef}
              type="button"
              onClick={gestures.onClick}
              onDoubleClick={() => {
                onOpenPinned(item.id);
              }}
              // On the row's own control rather than on the wrapper: this is the element that takes
              // focus, so it is the one whose keys mean anything, and a div carrying key handlers is a
              // control that only looks like one.
              onKeyDown={(event) => {
                gestures.onKeyDown(event);
                onKeyDown(event);
              }}
              onKeyUp={gestures.onKeyUp}
              className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            >
              <ItemLandmarkIcon landmark={props.landmarks[item.id]} />
              <Text as="span" variant="bodySmall" truncate>
                {item.title || 'Untitled'}
              </Text>
              {deleteProtected ? (
                <>
                  <Icon icon={Shield} size="sm" className="shrink-0 text-muted" />
                  <span className="sr-only">
                    {managed ? 'Part of a linked calendar' : 'Protected from deletion'}
                  </span>
                </>
              ) : null}
              {item.noChildren === true ? (
                <>
                  <Icon icon={FolderLock} size="sm" className="shrink-0 text-muted" />
                  <span className="sr-only">Does not accept new children</span>
                </>
              ) : null}
            </button>

            {/* Beside Delete, in the row's own established grammar: revealed on hover, always
            reachable by keyboard - and, below `sm`, always visible and at the 28px control size
            rather than 20px, because touch has no hover to reveal a hidden control with, and a
            control under WCAG 2.5.8's 24px floor is a thumb's width from the row next to it.
            The modifier-click and Alt+Enter above are accelerators for this control rather than
            the whole feature - a gesture only a pointer can make is a feature for only some
            people, and a `title` tooltip is worse than nothing here, because it is read aloud
            after every row while never reaching a touch or keyboard user at all.

            Not rendered at all when the refusal is `'narrow'`: that reason is a fact about this
            viewport, not a transient state of the pane arrangement, and it is true of every row in
            the tree at once. A disabled, ever-present control whose label is a refusal nobody can
            ever act around is worse than no control - on a phone a screen reader would hear it on
            every single row. `'limit'` is the opposite: a temporary state of how many panes happen
            to be open, so it stays visible and disabled, with the explanation, exactly as before. */}
            {besideRefusal === 'narrow' ? null : (
              <button
                type="button"
                disabled={!canOpenBeside}
                data-context-menu-ignore
                aria-label={
                  besideRefusal === null
                    ? `Open ${item.title || 'Untitled'} beside`
                    : `Cannot open ${item.title || 'Untitled'} beside. ${OPEN_BESIDE_REFUSAL_COPY[besideRefusal]}`
                }
                onClick={() => {
                  onOpenBeside(item.id);
                }}
                // `opacity-0`, not `invisible`. `visibility: hidden` takes an element out of the tab
                // order entirely, so `focus-visible:visible` can never fire - nothing can focus it in
                // order to un-hide it. The control was pointer-only, which is the objection it exists to
                // answer. Opacity hides it and keeps it reachable.
                //
                // `pointer-events-none` rides along with that same `opacity-0` regardless of viewport
                // width: an element can be hit-tested while fully transparent, so without this a thumb
                // or pointer landing near the row's edge could trigger a control nothing on screen shows
                // it landed on. The three states that raise the opacity back to 100 - hover, focus-visible,
                // group-hover - restore pointer events with it; `max-sm:` does the same unconditionally,
                // since below `sm` this is never hidden in the first place.
                className={`flex size-5 max-sm:size-(--control-sm) items-center justify-center text-muted opacity-0 pointer-events-none hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 max-sm:pointer-events-auto max-sm:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:size-(--control-sm) ${disabledState} ${focusRing}`}
              >
                <Icon icon={Columns2} size="sm" />
              </button>
            )}

            {/* Revealed on hover and on focus like its neighbours, and always visible once the item is
            kept - a star that vanished when the pointer left would mean a reader could not tell
            what they had bookmarked without hovering every row in turn. `BookmarkButton` owns the
            pressed state and the toggle; the classes here are the row's, because only the row knows
            what its controls look like. */}
            <BookmarkButton
              compact
              itemId={item.id}
              title={item.title}
              className={`flex size-5 max-sm:size-(--control-sm) items-center justify-center text-muted opacity-0 pointer-events-none hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 max-sm:pointer-events-auto max-sm:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:size-(--control-lg) ${keptIds.has(item.id) ? 'opacity-100 pointer-events-auto' : ''} ${focusRing}`}
            />

            {/* A direct escape from nesting. Dragging beside a root or pressing Alt+Left once per
            ancestor still works, but neither is a reasonable requirement for the common outcome
            "put this in the workspace". Appended after the current last root so moving does not
            unexpectedly reorder the roots already there. */}
            {item.parentId === null ? null : (
              <button
                type="button"
                data-context-menu-ignore
                aria-label={`Move ${item.title || 'Untitled'} to the workspace root`}
                onClick={() => {
                  moveToRoot();
                }}
                className={`flex size-5 max-sm:size-(--control-sm) items-center justify-center text-muted opacity-0 pointer-events-none hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 max-sm:pointer-events-auto max-sm:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:size-(--control-sm) ${focusRing}`}
              >
                <Icon icon={FolderUp} size="sm" />
              </button>
            )}

            {/* No control at all on a protected row: a destructive button that can only refuse is
            worse than its absence, and the shield beside the title says why it is missing. */}
            {deleteProtected ? null : (
              <button
                type="button"
                data-context-menu-ignore
                aria-label={`Delete ${item.title}`}
                onClick={() => {
                  // Immediate, on purpose - see `requestDelete` on `app-shell.tsx` for why a toast
                  // with Undo replaced the `globalThis.confirm()` this control used to sit behind. The
                  // control is revealed on hover and sits a few pixels from the one that opens the
                  // item, which is exactly the situation Undo (rather than a slower "are you sure") is
                  // meant to answer.
                  onDeleteItem(item);
                }}
                // `opacity-0` for the same reason the control above it uses one: `visibility: hidden`
                // takes an element out of the tab order, so this was keyboard-unreachable - and of the
                // two controls in this row it is the destructive one. `pointer-events-none` and the
                // narrow-scoped sizing and always-visible state follow the same reasoning as that
                // control's own comment, as does the `pointer-coarse:` trio beside it: `group-hover:*`
                // needs `@media(hover:hover)`, so a touch-capable device above `sm` gets neither that nor
                // the `max-sm:` override without it.
                //
                // `pointer-coarse:ml-2` widens the gap in front of this control only: on touch, a thumb
                // landing between "move to root" and the bookmark star and this destructive action has
                // less margin for error than a mouse pointer does, and the row's own `gap-1` is otherwise
                // the same narrow spacing on every control in it.
                className={`flex size-5 max-sm:size-(--control-sm) items-center justify-center text-muted opacity-0 pointer-events-none hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 max-sm:pointer-events-auto max-sm:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:size-(--control-sm) pointer-coarse:ml-2 ${focusRing}`}
              >
                <Icon icon={Trash2} size="sm" />
              </button>
            )}
          </div>
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
