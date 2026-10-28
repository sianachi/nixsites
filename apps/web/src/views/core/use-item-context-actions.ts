import type { MenuEntry } from '@nix/ui';
import {
  CheckSquare,
  Eye,
  EyeOff,
  FileText,
  FolderInput,
  Pencil,
  Square,
  Trash2,
} from 'lucide-react';

import { useAutomateEntry } from '../../automations/automate-entry';
import { useOptionalItemCommands } from '../../items/item-commands-context';
import { useOptionalItemSelection } from './item-selection-context';
import { bookmarkEntry, copyLinkEntry } from '../../items/item-menu-entries';
import { useMuteRemindersEntry } from '../../settings/notifications/mute-reminders-entry';
import { useOptionalWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { useHiddenItems } from '../../items/use-hidden-items';

/**
 * The secondary-click actions every view offers on an entry - a list row, a board or gallery card,
 * a calendar entry: Open, then any the view adds of its own, then the ones that mean the same
 * thing everywhere. Deliberately a builder called when a menu opens, so nothing here subscribes a
 * row to state it only needs at that moment.
 */
export function useItemContextActions(
  onOpen: (itemId: string) => void,
): (itemId: string, title: string, extra?: readonly MenuEntry[]) => MenuEntry[] {
  const workspace = useOptionalWorkspace();
  const automateEntry = useAutomateEntry(workspace?.workspaceId ?? null);
  const muteRemindersEntry = useMuteRemindersEntry();
  const visibility = useHiddenItems();
  const commands = useOptionalItemCommands();
  const selection = useOptionalItemSelection();

  return (itemId, title, extra = []) => {
    // What the view around this row allows (view-capabilities.ts); every entry below is also
    // checked by Core when it runs, so an entry is an offer and never a permission.
    const allows = selection?.capabilities;
    const treeItem = commands?.tree.find(itemId) ?? null;
    const deleteProtected = treeItem?.noDelete === true;
    const shared: MenuEntry[] = [
      ...(selection !== null && allows?.select === true
        ? [
            {
              kind: 'action' as const,
              label: selection.selected.has(itemId) ? 'Deselect' : 'Select',
              icon: selection.selected.has(itemId) ? CheckSquare : Square,
              onSelect: () => {
                selection.toggle(itemId, []);
              },
            },
          ]
        : []),
      ...(commands !== null && allows?.rename !== false
        ? [
            {
              kind: 'action' as const,
              label: 'Rename…',
              icon: Pencil,
              onSelect: () => {
                commands.renameItem(itemId);
              },
            },
          ]
        : []),
      ...(commands !== null && allows?.move !== false
        ? [
            {
              kind: 'action' as const,
              label: 'Move to…',
              icon: FolderInput,
              onSelect: () => {
                // A selected row moves with the rest of the selection, the way a drag would.
                commands.moveItems(
                  selection?.selected.has(itemId) === true ? [...selection.selected] : [itemId],
                );
              },
            },
          ]
        : []),
    ];
    const destructive: MenuEntry[] =
      commands !== null && allows?.delete !== false
        ? [
            { kind: 'separator' as const },
            {
              kind: 'action' as const,
              label: deleteProtected ? 'Delete (protected)' : 'Delete',
              icon: Trash2,
              destructive: true,
              disabled: deleteProtected,
              onSelect: () => {
                commands.deleteItem({
                  id: itemId,
                  title,
                  hasChildren: treeItem?.hasChildren ?? false,
                });
              },
            },
          ]
        : [];
    return [
      {
        kind: 'action',
        label: 'Open',
        icon: FileText,
        onSelect: () => {
          onOpen(itemId);
        },
      },
      ...extra,
      ...shared,
      ...(!visibility.enabled
        ? []
        : [
            {
              kind: 'action' as const,
              label: visibility.hiddenSet.has(itemId) ? 'Show for me' : 'Hide for me',
              icon: visibility.hiddenSet.has(itemId) ? Eye : EyeOff,
              onSelect: () => {
                if (visibility.hiddenSet.has(itemId)) visibility.show(itemId, title);
                else visibility.hide(itemId, title);
              },
            },
          ]),
      bookmarkEntry(itemId),
      ...(workspace === null ? [] : [copyLinkEntry(workspace.workspaceId, itemId, title)]),
      ...(automateEntry === null ? [] : [automateEntry(itemId)]),
      ...(muteRemindersEntry === null ? [] : [muteRemindersEntry(itemId, title)]),
      ...destructive,
    ];
  };
}
