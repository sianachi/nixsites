import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

import { ItemCommandsProvider } from '@nix/web-collections/items/item-commands-context';
import type { TreeItem, WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';
import { ContainerView } from '../../../views/core/container-view';
import { aContainer } from '@nix/web-collections/testing/container-fixture';
import { item } from '@nix/web-foundation/testing/api-stub';
import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { aView } from '@nix/web-collections/testing/view-fixture';

const NOTE = item({ id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', title: 'Roadmap' });
const PROTECTED = item({ id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', title: 'Ledger' });

function treeItem(id: string, title: string, noDelete = false): TreeItem {
  return {
    id,
    title,
    type: 'note',
    parentId: null,
    hasChildren: false,
    seq: 0,
    lifecycleState: 'active',
    noDelete,
  };
}

function fakeTree(move = vi.fn()): WorkspaceTree {
  const items = [treeItem(NOTE.id, 'Roadmap'), treeItem(PROTECTED.id, 'Ledger', true)];
  return {
    status: 'ready',
    error: null,
    items,
    find: (id: string) => items.find((entry) => entry.id === id) ?? null,
    childrenOf: (parentId: string | null) => items.filter((entry) => entry.parentId === parentId),
    isLoadingChildren: () => false,
    expand: () => Promise.resolve(),
    rename: vi.fn(() => Promise.resolve()),
    move,
    remove: () => Promise.resolve({ refusal: null }),
  } as unknown as WorkspaceTree;
}

it('offers rename, move and delete on a list row, and runs them through the shell', async () => {
  const user = userEvent.setup();
  const onDelete = vi.fn();
  const move = vi.fn(() => Promise.resolve({ refusal: null }));
  const tree = fakeTree(move);
  renderAt(
    <ItemCommandsProvider
      tree={tree}
      onDeleteItem={onDelete}
      onDeleteItems={() => Promise.resolve([])}
    >
      <ContainerView
        container={aContainer({ children: [NOTE, PROTECTED] })}
        view={aView({ kind: 'list' })}
        onOpen={vi.fn()}
      />
    </ItemCommandsProvider>,
  );

  await user.pointer({
    keys: '[MouseRight]',
    target: screen.getByRole('row', { name: /roadmap/i }),
  });
  expect(await screen.findByRole('menuitem', { name: 'Rename…' })).toBeVisible();
  expect(screen.getByRole('menuitem', { name: 'Move to…' })).toBeVisible();
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  expect(onDelete).toHaveBeenCalledWith({ id: NOTE.id, title: 'Roadmap', hasChildren: false });

  // A protected item says so instead of offering a delete that Core would refuse.
  await user.pointer({
    keys: '[MouseRight]',
    target: screen.getByRole('row', { name: /ledger/i }),
  });
  expect(await screen.findByRole('menuitem', { name: 'Delete (protected)' })).toBeDisabled();
  await user.keyboard('{Escape}');

  // Move to… opens the picker; the root is a valid destination and the move runs through the tree.
  await user.pointer({
    keys: '[MouseRight]',
    target: screen.getByRole('row', { name: /roadmap/i }),
  });
  await user.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Move item' });
  await user.click(screen.getByRole('button', { name: 'Move here' }));
  expect(move).toHaveBeenCalledWith(NOTE.id, null, null);
  expect(dialog).not.toBeInTheDocument();

  // Rename opens its own dialog and saves through the tree.
  await user.pointer({
    keys: '[MouseRight]',
    target: screen.getByRole('row', { name: /roadmap/i }),
  });
  await user.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
  const title = await screen.findByRole('textbox', { name: 'Title' });
  await user.clear(title);
  await user.type(title, 'Roadmap 2027{Enter}');
  expect(tree.rename).toHaveBeenCalledWith(NOTE.id, 'Roadmap 2027');
});
