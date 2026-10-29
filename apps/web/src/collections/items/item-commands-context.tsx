import { createContext, useContext, useState, type ReactNode } from 'react';

import { announce } from '@nix/web-foundation/a11y/announcer';
import { planBulkDelete, type BulkDeletePlan } from './bulk-delete';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { describeBulkMove, dropRefusal, executeBulkMove, planBulkMove } from './bulk-move';
import { DeleteItemsDialog } from './delete-items-dialog';
import { MoveItemsDialog } from './move-items-dialog';
import { RenameItemDialog } from './rename-item-dialog';
import type { TreeItem, WorkspaceTree } from './use-workspace-tree';

/**
 * The item commands every view shares (requirement 12): move, rename and delete, run through the
 * shell's one workspace tree so a view does not have to own a second copy of it. Provided by the
 * shell; a view drawn outside it (a story, a dialog preview) sees null and offers none of them.
 */
export interface ItemCommands {
  readonly tree: WorkspaceTree;
  /** Opens the destination picker for these ids and moves them; refusals are reported, not hidden. */
  readonly moveItems: (ids: readonly string[]) => void;
  /**
   * Moves these ids into `targetId` after a drag and says what happened in a notice. Settles with
   * the ids that moved (or were carried along), so the view they left can reload.
   */
  readonly dropItems: (ids: readonly string[], targetId: string) => Promise<readonly string[]>;
  readonly renameItem: (itemId: string) => void;
  /** Deletes with the shell's undo window. */
  readonly deleteItem: (item: Pick<TreeItem, 'id' | 'title' | 'hasChildren'>) => void;
  /**
   * Confirms once, then deletes the top-level selected items with one summary toast. Settles with
   * the ids that were deleted (empty when cancelled or refused), so a selection can drop them.
   */
  readonly deleteItems: (items: readonly TreeItem[]) => Promise<readonly string[]>;
}

const ItemCommandsContext = createContext<ItemCommands | null>(null);

export function useOptionalItemCommands(): ItemCommands | null {
  return useContext(ItemCommandsContext);
}

export function ItemCommandsProvider({
  tree,
  onDeleteItem,
  onDeleteItems,
  onMoved,
  children,
}: {
  readonly tree: WorkspaceTree;
  readonly onDeleteItem: (item: Pick<TreeItem, 'id' | 'title' | 'hasChildren'>) => void;
  /** Deletes these items (already planned and confirmed) and answers with the ids that went. */
  readonly onDeleteItems: (items: BulkDeletePlan['items']) => Promise<readonly string[]>;
  /** Told which ids moved, so a selection can drop them. */
  readonly onMoved?: ((ids: readonly string[]) => void) | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const [moving, setMoving] = useState<readonly string[] | null>(null);
  const [deleting, setDeleting] = useState<{
    readonly plan: BulkDeletePlan;
    readonly settle: (deleted: readonly string[]) => void;
  } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const renamed = renaming === null ? null : tree.find(renaming);

  const commands: ItemCommands = {
    tree,
    moveItems: (ids) => {
      if (ids.length > 0) setMoving(ids);
    },
    dropItems: async (ids, targetId) => {
      const name = (tree.find(targetId)?.title ?? '') || 'Untitled';
      const refusal = dropRefusal(ids, targetId, tree.find);
      if (refusal !== null) {
        publishNotice({ key: 'move-refused', message: refusal });
        return [];
      }
      const plan = planBulkMove(ids, tree.find);
      const outcome = await executeBulkMove(tree, plan.ids, targetId);
      const total = outcome.moved.length + outcome.refused.length;
      // A clean move names where the items went, so a row leaving the list is not a mystery.
      publishNotice({
        key: 'move-done',
        message:
          outcome.refused.length === 0
            ? `${String(total)} ${total === 1 ? 'item' : 'items'} moved into ${name}.`
            : describeBulkMove(outcome, plan.carried.length),
      });
      const moved = [...outcome.moved, ...plan.carried];
      onMoved?.(moved);
      return moved;
    },
    renameItem: setRenaming,
    deleteItem: onDeleteItem,
    deleteItems: (selected) =>
      new Promise((settle) => {
        const byId = new Map(selected.map((item) => [item.id, item]));
        const plan = planBulkDelete(
          selected.map((item) => item.id),
          {
            ...tree,
            find: (id) => tree.find(id) ?? byId.get(id) ?? null,
          },
        );
        if (plan.items.length === 0 && plan.blocked.length === 0) settle([]);
        else setDeleting({ plan, settle });
      }),
  };

  return (
    <ItemCommandsContext value={commands}>
      {children}
      {moving === null ? null : (
        <MoveItemsDialog
          ids={moving}
          tree={tree}
          onClose={() => {
            setMoving(null);
          }}
          onMove={async (targetParentId) => {
            const plan = planBulkMove(moving, tree.find);
            const outcome = await executeBulkMove(tree, plan.ids, targetParentId);
            const sentence = describeBulkMove(outcome, plan.carried.length);
            announce(sentence);
            onMoved?.([...outcome.moved, ...plan.carried]);
            // A clean single move closes quietly; anything else is said in the dialog.
            return outcome.refused.length === 0 && plan.carried.length === 0 && moving.length === 1
              ? null
              : sentence;
          }}
        />
      )}
      {deleting === null ? null : (
        <DeleteItemsDialog
          plan={deleting.plan}
          onClose={() => {
            deleting.settle([]);
            setDeleting(null);
          }}
          onConfirm={async () => {
            deleting.settle(await onDeleteItems(deleting.plan.items));
          }}
        />
      )}
      {renamed === null ? null : (
        <RenameItemDialog
          title={renamed.title}
          onClose={() => {
            setRenaming(null);
          }}
          onRename={async (title) => {
            // `tree.rename` never throws: a refusal lands in `tree.error`, which the sidebar's
            // foot reports, so the dialog closes and the tree says what did not change.
            await tree.rename(renamed.id, title);
            return null;
          }}
        />
      )}
    </ItemCommandsContext>
  );
}
