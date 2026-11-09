import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { UndoBar, UndoProvider } from '@nix/ui';
import { MobileItemMove } from '../../items/mobile-item-move';
import type { TreeItem, WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';

/** Every move is recorded in the shared undo history, and Undo moves only that item back. */

function note(id: string, title: string, parentId: string | null): TreeItem {
  return {
    id,
    title,
    type: 'note',
    parentId,
    hasChildren: false,
    seq: 1,
    lifecycleState: 'active',
  };
}

const A = note('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'Alpha', null);
const B = note('bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', 'Bravo', null);
const C = note('cccccccc-1111-4111-8111-cccccccccccc', 'Charlie', null);

function treeOf(move: WorkspaceTree['move']): WorkspaceTree {
  const items = [A, B, C];
  return {
    status: 'ready',
    error: null,
    items,
    isCreating: false,
    find: (id: string) => items.find((item) => item.id === id) ?? null,
    childrenOf: (parentId: string | null) => items.filter((item) => item.parentId === parentId),
    isLoadingChildren: () => false,
    move,
  } as unknown as WorkspaceTree;
}

describe('Move to…', () => {
  it('names the move in the undo bar and Undo puts the item back after its old neighbour', async () => {
    const user = userEvent.setup();
    const move = vi.fn(() => Promise.resolve({ refusal: null }));
    render(
      <UndoProvider>
        <MobileItemMove itemId={C.id} tree={treeOf(move)} onClose={vi.fn()} />
        <UndoBar />
      </UndoProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Choose position' }));
    await user.click(screen.getByRole('button', { name: 'Place after Alpha' }));
    await user.click(screen.getByRole('button', { name: 'Move here' }));

    expect(move).toHaveBeenLastCalledWith(C.id, null, A.id);
    expect(await screen.findByRole('status')).toHaveTextContent('Moved "Charlie"');

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    // Back to where it was: after Bravo, at the top level.
    expect(move).toHaveBeenLastCalledWith(C.id, null, B.id);
  });
});
