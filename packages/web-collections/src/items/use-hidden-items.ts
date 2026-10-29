import { useCallback, useState, useSyncExternalStore } from 'react';

import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import {
  hiddenItemsKey,
  hiddenItemsRevision,
  hiddenItemSet,
  readHiddenItems,
  subscribeHiddenItems,
  writeHiddenItems,
} from '@nix/web-foundation/lib/view-hidden-items';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { useOptionalWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';

const EMPTY: readonly string[] = [];

/** Personal workspace display preferences. Core still decides which items can be read. */
export interface HiddenItemsPreference {
  readonly enabled: boolean;
  readonly scope: string | null;
  readonly hiddenIds: readonly string[];
  readonly hiddenSet: ReadonlySet<string>;
  readonly saveFailed: boolean;
  readonly hide: (itemId: string, title: string) => void;
  readonly show: (itemId: string, title: string) => void;
  readonly showItems: (itemIds: readonly string[]) => void;
  readonly showAll: () => void;
}

export function useHiddenItems(target: 'items' | 'tree-children' = 'items'): HiddenItemsPreference {
  const subject = useSessionStore((state) => state.profile?.subject ?? null);
  const workspace = useOptionalWorkspace();
  const scope =
    subject === null || workspace === null
      ? null
      : hiddenItemsKey(subject, workspace.workspaceId) +
        (target === 'items' ? '' : ':tree-children');
  const snapshot = useCallback(() => (scope === null ? EMPTY : readHiddenItems(scope)), [scope]);
  const hiddenIds = useSyncExternalStore(subscribeHiddenItems, snapshot, () => EMPTY);
  const [failedScope, setFailedScope] = useState<string | null>(null);

  function store(ids: readonly string[]): boolean {
    if (scope === null) return false;
    const retained = writeHiddenItems(scope, ids);
    setFailedScope(retained ? null : scope);
    return retained;
  }

  return {
    enabled: scope !== null,
    scope,
    hiddenIds,
    hiddenSet: hiddenItemSet(hiddenIds),
    saveFailed: scope !== null && failedScope === scope,
    hide: (itemId: string, title: string) => {
      if (scope === null) return;
      const ids = readHiddenItems(scope);
      if (ids.length >= 4000 && !ids.includes(itemId)) {
        publishNotice({
          key: 'item-visibility',
          message:
            'This browser already has 4,000 hidden items in this workspace. Show some before hiding more.',
        });
        return;
      }
      const retained = store([...ids, itemId]);
      publishNotice({
        key: 'item-visibility',
        message: `${title || 'Untitled'}${target === 'items' ? ' hidden' : ': children hidden from tree'}.${retained ? '' : ' Your browser could not save this preference; it lasts until this page reloads.'}`,
        action: {
          label: 'Undo',
          onAction: () => {
            const saved = store(readHiddenItems(scope).filter((id) => id !== itemId));
            publishNotice({
              key: 'item-visibility',
              message: `${title || 'Item'}${target === 'items' ? ' shown again' : ': children shown in tree'}.${saved ? '' : ' Your browser could not save this preference; it lasts until this page reloads.'}`,
            });
          },
        },
      });
    },
    show: (itemId: string, title: string) => {
      if (scope === null) return;
      const retained = store(readHiddenItems(scope).filter((id) => id !== itemId));
      publishNotice({
        key: 'item-visibility',
        message: `${title || 'Item'}${target === 'items' ? ' is no longer hidden for you' : ': children shown in tree'}.${retained ? '' : ' Your browser could not save this preference; it lasts until this page reloads.'}`,
      });
    },
    showItems: (itemIds: readonly string[]) => {
      if (scope === null) return;
      const selected = new Set(itemIds);
      const ids = readHiddenItems(scope);
      const remaining = ids.filter((id) => !selected.has(id));
      const shown = ids.length - remaining.length;
      if (shown === 0) return;
      const retained = store(remaining);
      publishNotice({
        key: 'item-visibility',
        message: `${String(shown)} ${shown === 1 ? 'item' : 'items'} shown again.${retained ? '' : ' Your browser could not save this preference; it lasts until this page reloads.'}`,
      });
    },
    showAll: () => {
      const retained = store([]);
      publishNotice({
        key: 'item-visibility',
        message: `All hidden items shown again.${retained ? '' : ' Your browser could not save this preference; it lasts until this page reloads.'}`,
      });
    },
  };
}

/** Global search and bookmark shelves can contain hits from several workspaces. */
export function useHiddenItemPredicate(): (itemId: string, workspaceId: string) => boolean {
  const subject = useSessionStore((state) => state.profile?.subject ?? null);
  useSyncExternalStore(subscribeHiddenItems, hiddenItemsRevision, () => 0);
  return (itemId, workspaceId) =>
    subject !== null &&
    hiddenItemSet(readHiddenItems(hiddenItemsKey(subject, workspaceId))).has(itemId);
}
