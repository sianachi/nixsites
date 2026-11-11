import { isNixApiError, views as coreViews } from '@nix/api-client';
import { useUndo, type MenuEntry } from '@nix/ui';
import { Eye, EyeOff, Pin, Trash2 } from 'lucide-react';
import { useCallback, useSyncExternalStore } from 'react';

import {
  ContainerViewsSchema,
  DOCUMENT_VIEW,
  toViewRequest,
  type ContainerViews,
  type View,
} from '@nix/web-collections/core/container-model';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { notifyItemChildrenChanged } from '@nix/web-foundation/lib/item-children-changed';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import {
  hiddenItemsKey,
  hiddenItemSet,
  readHiddenItems,
  subscribeHiddenItems,
  writeHiddenItems,
} from '@nix/web-foundation/lib/view-hidden-items';

const EMPTY: readonly string[] = [];

interface ViewActionOptions {
  readonly id: string;
  readonly view: View | undefined;
  readonly stored: ContainerViews | null;
  readonly canHide: boolean;
  readonly canWrite: boolean;
  readonly leave: () => void;
  readonly restoreViews: readonly { readonly id: string; readonly name: string }[];
}

export function useItemViewActions(
  itemId: string,
  workspaceId: string | undefined,
): {
  readonly hidden: ReadonlySet<string>;
  readonly entries: (options: ViewActionOptions) => MenuEntry[];
  readonly add: (view: View) => Promise<boolean>;
} {
  const subject = useSessionStore((state) => state.profile?.subject ?? null);
  const key =
    subject === null || workspaceId === undefined
      ? null
      : `${hiddenItemsKey(subject, workspaceId)}:views:${itemId}`;
  const snapshot = useCallback(() => (key === null ? EMPTY : readHiddenItems(key)), [key]);
  const hidden = hiddenItemSet(useSyncExternalStore(subscribeHiddenItems, snapshot, () => EMPTY));
  const client = useApiClient();
  const undo = useUndo();

  function notice(message: string): void {
    publishNotice({ key: `item-views:${itemId}`, message });
  }

  function setHidden(id: string, hide: boolean): boolean {
    if (key === null) return false;
    const current = readHiddenItems(key);
    const saved = writeHiddenItems(
      key,
      hide ? [...current, id] : current.filter((entry) => entry !== id),
    );
    if (!saved) notice('Your browser could not save the view visibility across reloads.');
    return true;
  }

  async function edit(
    update: (current: ContainerViews) => ContainerViews | null,
  ): Promise<boolean> {
    try {
      const current = ContainerViewsSchema.parse(
        await client.query(coreViews.containerViewConfigurations(itemId), { forceRefresh: true }),
      );
      const next = update(current);
      if (next === null) return false;
      await client.execute(
        coreViews.setContainerViews(itemId, {
          views: next.views.map(toViewRequest),
          default: next.default,
          hideDocument: next.hideDocument,
          expectedVersion: current.version ?? null,
        }),
      );
      if (workspaceId !== undefined) notifyItemChildrenChanged(workspaceId, itemId);
      return true;
    } catch (reason) {
      notice(
        isNixApiError(reason)
          ? (reason.detail ?? 'The views could not be saved.')
          : 'The views could not be saved.',
      );
      return false;
    }
  }

  async function setDefault(id: string, name: string): Promise<void> {
    let previous = DOCUMENT_VIEW;
    if (
      await edit((current) => {
        if (current.default === id) return null;
        previous = current.default;
        return { ...current, default: id };
      })
    ) {
      undo.push(`${name} opens by default`, async () => {
        await edit((current) =>
          current.default === id ? { ...current, default: previous } : null,
        );
      });
    }
  }

  async function remove(view: View, trackUndo = true): Promise<void> {
    let restore: ((current: ContainerViews) => ContainerViews | null) | undefined;
    if (
      (await edit((current) => {
        const index = current.views.findIndex((entry) => entry.id === view.id);
        const removed = current.views[index];
        if (removed === undefined) return null;
        const companions = new Map(
          current.views
            .filter((entry) => entry.companionViewId === view.id)
            .map((entry) => [entry.id, entry]),
        );
        const views = current.views
          .filter((entry) => entry.id !== view.id)
          .map((entry) =>
            companions.has(entry.id)
              ? { ...entry, companionViewId: null, companionPlacement: null }
              : entry,
          );
        const nextDefault =
          current.default === view.id
            ? current.hideDocument
              ? (views.find((entry) => !current.unrenderable.includes(entry.id))?.id ??
                views[0]?.id ??
                DOCUMENT_VIEW)
              : DOCUMENT_VIEW
            : current.default;
        const hideDocument = current.hideDocument && views.length > 0;
        restore = (latest) => {
          if (latest.views.some((entry) => entry.id === view.id)) return null;
          const restored = latest.views.map((entry) => {
            const reference = companions.get(entry.id);
            return reference !== undefined && entry.companionViewId == null
              ? {
                  ...entry,
                  companionViewId: view.id,
                  companionPlacement: reference.companionPlacement ?? null,
                }
              : entry;
          });
          const target = removed.companionViewId;
          restored.splice(
            index,
            0,
            target != null && !latest.views.some((entry) => entry.id === target)
              ? { ...removed, companionViewId: null, companionPlacement: null }
              : removed,
          );
          return {
            ...latest,
            views: restored,
            default: latest.default === nextDefault ? current.default : latest.default,
            hideDocument:
              latest.hideDocument === hideDocument ? current.hideDocument : latest.hideDocument,
          };
        };
        return { ...current, views, default: nextDefault, hideDocument };
      })) &&
      trackUndo
    ) {
      undo.push(`Removed ${view.name}`, async () => {
        if (restore) await edit(restore);
      });
    }
  }

  function entries({
    id,
    view,
    stored,
    canHide,
    canWrite,
    leave,
    restoreViews,
  }: ViewActionOptions): MenuEntry[] {
    const name = view?.name ?? 'Document';
    const actions: MenuEntry[] = [];
    if (key !== null && (view !== undefined || id === DOCUMENT_VIEW) && !hidden.has(id)) {
      actions.push({
        label: 'Hide from tabs',
        icon: EyeOff,
        disabled: !canHide,
        onSelect: () => {
          if (!setHidden(id, true)) return;
          leave();
          undo.push(`Hidden ${name}`, () => {
            setHidden(id, false);
          });
        },
      });
    }
    if (
      canWrite &&
      stored !== null &&
      (view !== undefined || id === DOCUMENT_VIEW) &&
      id !== stored.default &&
      !(id === DOCUMENT_VIEW && stored.hideDocument)
    ) {
      actions.push({
        label: 'Set as default',
        icon: Pin,
        onSelect: () => {
          void setDefault(id, name);
        },
      });
    }
    if (canWrite && view !== undefined) {
      actions.push({
        label: 'Remove view',
        icon: Trash2,
        destructive: true,
        onSelect: () => {
          void remove(view);
        },
      });
    }
    if (restoreViews.length > 0) {
      if (actions.length > 0) actions.push({ kind: 'separator' });
      for (const entry of restoreViews)
        actions.push({
          key: entry.id,
          label: `Show ${entry.name}`,
          icon: Eye,
          onSelect: () => {
            if (hidden.has(entry.id) && setHidden(entry.id, false)) {
              undo.push(`Showing ${entry.name}`, () => {
                setHidden(entry.id, true);
              });
            } else if (entry.id === DOCUMENT_VIEW && canWrite) {
              void edit((current) => ({ ...current, hideDocument: false })).then((saved) => {
                if (saved)
                  undo.push('Showing Document', async () => {
                    await edit((current) =>
                      current.views.length ? { ...current, hideDocument: true } : null,
                    );
                  });
              });
            }
          },
        });
    }
    return actions;
  }

  return {
    hidden,
    entries,
    add: async (view: View) => {
      const saved = await edit((current) =>
        current.views.some((entry) => entry.id === view.id)
          ? current
          : {
              ...current,
              views: [...current.views, view],
              default: current.views.length === 0 ? view.id : current.default,
            },
      );
      if (saved) undo.push(`Added ${view.name}`, () => remove(view, false));
      return saved;
    },
  };
}
