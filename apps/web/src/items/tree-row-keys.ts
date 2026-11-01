import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { announce } from '@nix/web-foundation/a11y/announcer';
import type { TreeItem, WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';
import { OPEN_BESIDE_REFUSAL_COPY, type OpenBesideRefusal } from '../tabs/use-open-item';
import { siblingMoveTarget } from './sibling-move-target';

interface RowKeyArgs {
  readonly item: TreeItem;
  readonly tree: WorkspaceTree;
  readonly siblings: readonly TreeItem[];
  readonly index: number;
  readonly canOpenBeside: boolean;
  readonly besideRefusal: OpenBesideRefusal | null;
  readonly onOpenBeside: (itemId: string) => void;
}

/**
 * The same three moves, from the keyboard.
 *
 * A drop zone that exists only for a pointer is not a move affordance, it is a move affordance
 * for some people. These are the outliner bindings - the ones anybody who has used a list of
 * nested things already has in their fingers - and they map onto exactly the three landings a
 * drag can produce.
 */
export function handleRowMoveKey(event: ReactKeyboardEvent<HTMLElement>, args: RowKeyArgs): void {
  const { item, tree, siblings, index, canOpenBeside, besideRefusal, onOpenBeside } = args;
  const previous = index > 0 ? siblings[index - 1] : undefined;
  const next = index >= 0 ? siblings[index + 1] : undefined;

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
