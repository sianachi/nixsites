import { useUndo, type UndoApi } from '@nix/ui';
import type {
  MutationOutcome,
  TreeItem,
  WorkspaceTree,
} from '@nix/web-collections/items/use-workspace-tree';
import { publishNotice } from '@nix/web-foundation/lib/notices';

type MoveTree = Pick<WorkspaceTree, 'find' | 'childrenOf' | 'move'>;

/**
 * Moves an item and records how to put it back. The one path every move takes (drag, keyboard,
 * "Move to...", "Move to top level"), so each is undoable from the shared history and a refusal is
 * always said. Undo re-issues the inverse move from the current tree, never a snapshot.
 */
export async function moveWithUndo(
  tree: MoveTree,
  undo: Pick<UndoApi, 'push'>,
  itemId: string,
  parentId: string | null,
  afterId: string | null,
  onMoved?: (itemId: string) => void,
): Promise<MutationOutcome> {
  const item: TreeItem | null = tree.find(itemId);
  const fromParent = item?.parentId ?? null;
  const siblings = tree.childrenOf(fromParent);
  const at = siblings.findIndex((sibling) => sibling.id === itemId);
  const fromAfter = at > 0 ? (siblings[at - 1]?.id ?? null) : null;

  const outcome = await tree.move(itemId, parentId, afterId);
  if (outcome.refusal !== null) {
    publishNotice({ key: 'move-refused', message: outcome.refusal });
    return outcome;
  }

  const nameOf = (value: string | undefined): string =>
    value === undefined || value === '' ? 'Untitled' : value;
  const title = `"${nameOf(item?.title)}"`;
  const where =
    parentId === fromParent
      ? ''
      : parentId === null
        ? ' to the top level'
        : ` to "${nameOf(tree.find(parentId)?.title)}"`;
  undo.push(`Moved ${title}${where}`, async () => {
    const back = await tree.move(itemId, fromParent, fromAfter);
    if (back.refusal !== null) publishNotice({ key: 'move-refused', message: back.refusal });
    else onMoved?.(itemId);
  });
  onMoved?.(itemId);
  return outcome;
}

/** `moveWithUndo` bound to the shell's undo history. `onMoved` is told which row to flash. */
export function useUndoableMove(
  tree: MoveTree,
  onMoved?: (itemId: string) => void,
): (itemId: string, parentId: string | null, afterId: string | null) => Promise<MutationOutcome> {
  const undo = useUndo();
  return (itemId, parentId, afterId) =>
    moveWithUndo(tree, undo, itemId, parentId, afterId, onMoved);
}
