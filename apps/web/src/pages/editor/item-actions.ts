import type { MenuAction } from '@nix/ui';
import {
  Clock,
  Download,
  Globe,
  LayoutTemplate,
  Lock,
  LockOpen,
  MessageSquare,
  PanelRightClose,
  Save,
  Upload,
} from 'lucide-react';
import type { NavigateFunction } from 'react-router';

import { treeChildrenEntry } from '@nix/web-collections/items/item-menu-entries';
import type { useHiddenItems } from '@nix/web-collections/items/use-hidden-items';
import type { useItemLock } from '../../locks/use-item-lock';
import type { useOptionalWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import type { ItemDialogName } from './item-dialogs';
import { clockTime } from './lock-copy';

export interface ItemActionArgs {
  readonly itemId: string;
  readonly title: string;
  readonly lockNoun: string;
  readonly lock: ReturnType<typeof useItemLock>;
  readonly workspace: ReturnType<typeof useOptionalWorkspace>;
  readonly visibility: ReturnType<typeof useHiddenItems>;
  readonly treeChildren: ReturnType<typeof useHiddenItems>;
  readonly navigate: NavigateFunction;
  readonly openChat: (itemId: string) => void;
  readonly onNavigateAway: (() => void) | undefined;
  readonly onClose: (() => void) | undefined;
  readonly sitesEnabled: boolean;
  readonly hasSite: boolean | null;
  readonly openSitePane: () => void;
  /** Opens the comments pane; absent for bodies that cannot be commented on. */
  readonly openCommentsPane: (() => void) | undefined;
  readonly canApplyTemplates: boolean;
  readonly canManageTemplates: boolean;
  readonly historyOpen: boolean;
  readonly setHistoryOpen: (open: boolean) => void;
  readonly openDialog: (name: ItemDialogName) => void;
}

/** The item's actions, in menu order: one list feeds the desktop menu and the phone sheet. */
export function itemActionEntries({
  itemId,
  title,
  lockNoun,
  lock,
  workspace,
  visibility,
  treeChildren,
  navigate,
  openChat,
  onNavigateAway,
  onClose,
  sitesEnabled,
  hasSite,
  openSitePane,
  openCommentsPane,
  canApplyTemplates,
  canManageTemplates,
  historyOpen,
  setHistoryOpen,
  openDialog,
}: ItemActionArgs): MenuAction[] {
  return [
    treeChildrenEntry(treeChildren, itemId, title),
    ...(workspace && lock.open
      ? [
          {
            key: 'note-chat',
            label: 'Chat about this note',
            onSelect: () => {
              onNavigateAway?.();
              openChat(itemId);
            },
          },
          {
            key: 'focus-graph',
            label: 'Focus in graph',
            onSelect: () => {
              onNavigateAway?.();
              void navigate(
                `/w/${encodeURIComponent(workspace.workspaceId)}/graph?focus=${encodeURIComponent(itemId)}`,
              );
            },
          },
        ]
      : []),
    ...(visibility.enabled
      ? [
          {
            key: 'visibility',
            label: visibility.hiddenSet.has(itemId) ? 'Show for me' : 'Hide for me',
            onSelect: () => {
              if (visibility.hiddenSet.has(itemId)) visibility.show(itemId, title);
              else visibility.hide(itemId, title);
            },
          },
        ]
      : []),
    {
      key: 'move',
      label: 'Move item',
      onSelect: () => {
        openDialog('move');
      },
    },
    ...(openCommentsPane === undefined
      ? []
      : [{ key: 'comments', label: 'Comments', icon: MessageSquare, onSelect: openCommentsPane }]),
    {
      key: 'export',
      label: 'Export',
      icon: Download,
      onSelect: () => {
        openDialog('export');
      },
    },
    ...(sitesEnabled
      ? [
          {
            key: 'site',
            label: hasSite === false ? 'Publish as a site…' : 'Site',
            icon: Globe,
            onSelect: openSitePane,
          },
        ]
      : []),
    {
      key: 'import',
      label: 'Import',
      icon: Upload,
      onSelect: () => {
        openDialog('import');
      },
    },
    ...(canApplyTemplates
      ? [
          {
            key: 'apply-template',
            label: 'Apply template',
            icon: LayoutTemplate,
            onSelect: () => {
              void navigate(`/templates?target=${encodeURIComponent(itemId)}`);
            },
          },
        ]
      : []),
    ...(canManageTemplates
      ? [
          {
            key: 'save-template',
            label: 'Save as template',
            icon: Save,
            onSelect: () => {
              void navigate(`/templates/new?sourceItem=${encodeURIComponent(itemId)}`);
            },
          },
        ]
      : []),
    ...(lock.open
      ? [
          {
            key: 'history',
            label: historyOpen ? 'Close history' : 'History',
            icon: Clock,
            onSelect: () => {
              setHistoryOpen(!historyOpen);
            },
          },
          {
            key: 'lock',
            label:
              lock.unlockedUntil === null
                ? `Lock this ${lockNoun}`
                : `Lock settings, open until ${clockTime(lock.unlockedUntil)}`,
            icon: lock.locked ? LockOpen : Lock,
            onSelect: () => {
              openDialog('lock');
            },
          },
        ]
      : []),
    ...(onClose === undefined
      ? []
      : [{ key: 'close-pane', label: 'Close pane', icon: PanelRightClose, onSelect: onClose }]),
  ];
}
