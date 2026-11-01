import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { useAutomateEntry } from '@nix/web-collections/items/automate-entry';
import { useMuteRemindersEntry } from '@nix/web-settings/settings/notifications/mute-reminders-entry';
import {
  bookmarkEntry,
  copyLinkEntry,
  treeChildrenEntry,
} from '@nix/web-collections/items/item-menu-entries';
import { useHiddenItems } from '@nix/web-collections/items/use-hidden-items';
import { useOptionalItemSelection } from '@nix/web-collections/core/item-selection-context';
import type { TreeItem, WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';
import { isApplePlatform } from '@nix/web-foundation/lib/shortcuts';
import type { MenuEntry } from '@nix/ui';
import {
  Columns2,
  ExternalLink,
  FileText,
  FolderLock,
  FolderPlus,
  FolderUp,
  Shapes,
  Shield,
  ShieldOff,
  Trash2,
  User,
  Users,
} from 'lucide-react';
import type { RefObject } from 'react';
import type { OpenBesideRefusal } from '../tabs/use-open-item';

/** Whether this is an Apple platform, for the one gesture whose modifier differs. */
const APPLE = isApplePlatform();

interface RowMenuArgs {
  readonly item: TreeItem;
  readonly title: string;
  readonly tree: WorkspaceTree;
  readonly siblings: readonly TreeItem[];
  readonly canOpenBeside: boolean;
  readonly besideRefusal: OpenBesideRefusal | null;
  readonly onSelect: (itemId: string) => void;
  readonly onOpenPinned: (itemId: string) => void;
  readonly onOpenBeside: (itemId: string) => void;
  readonly onDeleteItem: (item: TreeItem) => void;
  readonly onChooseIcon: ((item: TreeItem, invoker: HTMLElement | null) => void) | undefined;
  readonly openButtonRef: RefObject<HTMLButtonElement | null>;
  readonly moveToRoot: () => void;
}

/**
 * The row's context-menu entries, as a function so they are built when the menu opens and the
 * bookmark entry names the current state.
 */
export function useRowMenuItems(args: RowMenuArgs): () => MenuEntry[] {
  const {
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
    onChooseIcon,
    openButtonRef,
    moveToRoot,
  } = args;
  const { workspaceId } = useWorkspace();
  const automateEntry = useAutomateEntry(workspaceId);
  const muteRemindersEntry = useMuteRemindersEntry();
  const treeChildren = useHiddenItems('tree-children');
  const visibility = useHiddenItems();
  const rowSelection = useOptionalItemSelection();
  const inSelection = rowSelection?.selected.has(item.id) === true;
  const deleteProtected = item.noDelete === true;
  const managed = item.managedBy !== undefined && item.managedBy !== null;

  return (): MenuEntry[] => {
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
      ...(onChooseIcon === undefined
        ? []
        : [
            {
              kind: 'action' as const,
              label: 'Choose icon…',
              icon: Shapes,
              onSelect: () => {
                onChooseIcon(item, openButtonRef.current);
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
  };
}
