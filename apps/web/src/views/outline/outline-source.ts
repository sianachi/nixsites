import { isNixApiError, items as coreItems, structure as coreStructure } from '@nix/api-client';
import { useMemo } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { notifyItemChildrenChanged } from '@nix/web-foundation/lib/item-children-changed';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import type { Item } from '../../collections/core/container-model';

/**
 * What the outline reads and writes through: one level of children at a time, a create, and the
 * same move endpoint the sidebar tree and the graph use.
 *
 * **No new endpoint.** The outline is the one view that edits structure, and it does so with
 * exactly the calls the rest of the application already makes, so everything a move refuses - a
 * lock, an item that accepts no children, a move into its own subtree - is refused here by the
 * same server code rather than by a second set of rules the outline would have to keep in step.
 *
 * An interface rather than calls inline in the view so the view can be driven by a test or a story
 * without a network behind it.
 */
export interface OutlineSource {
  /** The children of one item, in sibling order. Rejects with Core's error, lock included. */
  readonly list: (parentId: string | null) => Promise<readonly Item[]>;

  /** Makes a child at the end of `parentId`'s children. */
  readonly create: (parentId: string | null, title: string) => Promise<Item>;

  /** Renames an item: the title is a property like any other, written through the same call. */
  readonly rename: (itemId: string, parentId: string | null, title: string) => Promise<void>;

  /** Moves an item under `parentId`, after `afterId` or first when it is null. */
  readonly move: (
    itemId: string,
    fromParentId: string | null,
    parentId: string | null,
    afterId: string | null,
  ) => Promise<void>;
}

/** The outline's source over the real client, telling the sidebar about every change it makes. */
export function useOutlineSource(): OutlineSource {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();

  return useMemo<OutlineSource>(
    () => ({
      list: async (parentId) => {
        const children: Item[] = [];
        for await (const child of client.paginate(
          coreItems.listItems(workspaceId, {
            ...(parentId === null ? {} : { parentId }),
            pageSize: 200,
          }),
        )) {
          children.push(child);
        }
        return children;
      },
      create: async (parentId, title) => {
        const created = await client.execute(
          coreItems.createItem(workspaceId, { type: 'note', title, parentId }),
        );
        notifyItemChildrenChanged(workspaceId, parentId);
        return created;
      },
      rename: async (itemId, parentId, title) => {
        await client.execute(coreStructure.setItemProperties(itemId, { title }));
        notifyItemChildrenChanged(workspaceId, parentId);
      },
      move: async (itemId, fromParentId, parentId, afterId) => {
        await client.execute(coreItems.moveItem(workspaceId, itemId, { parentId, afterId }));
        notifyItemChildrenChanged(workspaceId, parentId);
        if (fromParentId !== parentId) notifyItemChildrenChanged(workspaceId, fromParentId);
      },
    }),
    [client, workspaceId],
  );
}

/**
 * Why a structural edit was refused, in the words the sidebar and the graph already use for the
 * same refusals, so one refusal does not read three different ways depending on where it happened.
 */
export function describeOutlineRefusal(reason: unknown): string {
  if (isNixApiError(reason)) {
    switch (reason.code) {
      case 'items.move_would_create_cycle':
        return 'An item cannot be moved inside itself.';
      case 'items.locked':
        return 'Unlock the locked item first. Nothing can be moved into or out of it while it is locked.';
      case 'items.children_protected':
        return reason.detail ?? 'That item does not accept new children.';
      default:
        if (reason.status === 403 || reason.status === 404) {
          return 'You cannot change that item here.';
        }
        return (
          reason.detail ?? 'The change could not be confirmed. Check the outline before retrying.'
        );
    }
  }
  return 'The change could not be confirmed. Check the outline before retrying.';
}

/** Whether a children read was refused because a lock covers the parent. */
export function isLockedRead(reason: unknown): boolean {
  return isNixApiError(reason) && reason.code === 'items.locked';
}
