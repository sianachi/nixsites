import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MobileItemMove } from '../../items/mobile-item-move';
import type { TreeItem, WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';

/**
 * Moving an item on a phone: choosing a destination is not choosing a position, and reordering
 * among siblings needs its own path that never leaves a refusal unreported.
 */

const PARENT: TreeItem = {
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  title: 'Project',
  type: 'note',
  parentId: null,
  hasChildren: true,
  seq: 1000,
  lifecycleState: 'active',
};

const FIRST: TreeItem = {
  id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
  title: 'First',
  type: 'note',
  parentId: PARENT.id,
  hasChildren: false,
  seq: 1000,
  lifecycleState: 'active',
};

const MOVING: TreeItem = {
  ...FIRST,
  id: 'cccccccc-1111-4111-8111-cccccccccccc',
  title: 'Moving',
  seq: 2000,
};

const THIRD: TreeItem = {
  ...FIRST,
  id: 'dddddddd-1111-4111-8111-dddddddddddd',
  title: 'Third',
  seq: 3000,
};

function treeOf(
  move: WorkspaceTree['move'],
  items: readonly TreeItem[] = [PARENT, FIRST, MOVING, THIRD],
): WorkspaceTree {
  return {
    status: 'ready',
    error: null,
    items,
    isCreating: false,
    find: (id: string) => items.find((item) => item.id === id) ?? null,
    childrenOf: (parentId: string | null) => items.filter((item) => item.parentId === parentId),
    breadcrumbs: () => [],
    isExpanded: () => false,
    isLoadingChildren: () => false,
    isLocked: () => false,
    toggle: () => Promise.resolve(),
    reveal: () => Promise.resolve(),
    expand: () => Promise.resolve(),
    create: () => Promise.resolve(null),
    rename: () => Promise.resolve(),
    move,
    remove: () => Promise.resolve(),
    restore: () => Promise.resolve(),
    reload: () => Promise.resolve(),
  } as unknown as WorkspaceTree;
}

describe('moving an item to a position among its new siblings', () => {
  it('passes the sibling it should land after', async () => {
    const user = userEvent.setup();
    const move = vi.fn(() => Promise.resolve({ refusal: null }));
    render(<MobileItemMove itemId={MOVING.id} tree={treeOf(move)} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Choose position' }));
    await user.click(screen.getByRole('button', { name: 'Place after Third' }));
    await user.click(screen.getByRole('button', { name: 'Move here' }));

    await waitFor(() => {
      expect(move).toHaveBeenCalledWith(MOVING.id, PARENT.id, THIRD.id);
    });
  });

  it('places at the top when a different destination was chosen', async () => {
    const user = userEvent.setup();
    const move = vi.fn(() => Promise.resolve({ refusal: null }));
    render(<MobileItemMove itemId={MOVING.id} tree={treeOf(move)} onClose={vi.fn()} />);

    // Leave the item's current parent so the destination step lands somewhere new.
    await user.click(screen.getByRole('button', { name: 'Up one level' }));
    await user.click(screen.getByRole('button', { name: 'Choose position' }));
    await user.click(screen.getByRole('button', { name: 'Move here' }));

    await waitFor(() => {
      expect(move).toHaveBeenCalledWith(MOVING.id, null, null);
    });
  });

  it('disables the confirm action when the chosen slot is where the item already sits', async () => {
    const user = userEvent.setup();
    const move = vi.fn(() => Promise.resolve({ refusal: null }));
    render(<MobileItemMove itemId={MOVING.id} tree={treeOf(move)} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Choose position' }));
    await user.click(screen.getByRole('button', { name: 'Place after First' }));

    expect(screen.getByRole('button', { name: 'Move here' })).toBeDisabled();
    expect(move).not.toHaveBeenCalled();
  });

  it('preselects the item current position when the destination has not changed, on entry from Choose position', async () => {
    const user = userEvent.setup();
    const move = vi.fn(() => Promise.resolve({ refusal: null }));
    render(<MobileItemMove itemId={MOVING.id} tree={treeOf(move)} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Choose position' }));

    // The destination was never changed, so the position step should already sit on the item's
    // real current slot (after First), not silently default to the top.
    expect(screen.getByRole('button', { name: 'Place after First' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Move here' })).toBeDisabled();
    expect(move).not.toHaveBeenCalled();
  });

  it('preselects the item current position when the destination picker is returned to its own parent', async () => {
    const user = userEvent.setup();
    const move = vi.fn(() => Promise.resolve({ refusal: null }));
    render(<MobileItemMove itemId={MOVING.id} tree={treeOf(move)} onClose={vi.fn()} />);

    // Wander away from the current parent and back to it before choosing a position.
    await user.click(screen.getByRole('button', { name: 'Up one level' }));
    await user.click(screen.getByRole('button', { name: 'Project' }));
    await user.click(screen.getByRole('button', { name: 'Choose position' }));

    expect(screen.getByRole('button', { name: 'Place after First' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Move here' })).toBeDisabled();
    expect(move).not.toHaveBeenCalled();
  });
});

describe('moving an item within its current siblings', () => {
  it('moves up one step', async () => {
    const user = userEvent.setup();
    const move = vi.fn(() => Promise.resolve({ refusal: null }));
    render(<MobileItemMove itemId={MOVING.id} tree={treeOf(move)} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Move up' }));

    await waitFor(() => {
      expect(move).toHaveBeenCalledWith(MOVING.id, PARENT.id, null);
    });
  });

  it('moves down one step', async () => {
    const user = userEvent.setup();
    const move = vi.fn(() => Promise.resolve({ refusal: null }));
    render(<MobileItemMove itemId={MOVING.id} tree={treeOf(move)} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Move down' }));

    await waitFor(() => {
      expect(move).toHaveBeenCalledWith(MOVING.id, PARENT.id, THIRD.id);
    });
  });

  it('has nothing to move up when already first', () => {
    const move = vi.fn(() => Promise.resolve({ refusal: null }));
    render(<MobileItemMove itemId={FIRST.id} tree={treeOf(move)} onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Move up' })).toBeDisabled();
  });

  it('has nothing to move down when already last', () => {
    const move = vi.fn(() => Promise.resolve({ refusal: null }));
    render(<MobileItemMove itemId={THIRD.id} tree={treeOf(move)} onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Move down' })).toBeDisabled();
  });
});

describe('a refused move', () => {
  it('is shown rather than swallowed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const move = vi.fn(() =>
      Promise.resolve({ refusal: 'An item cannot be moved inside itself.' }),
    );
    render(<MobileItemMove itemId={MOVING.id} tree={treeOf(move)} onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Move down' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An item cannot be moved inside itself.',
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
