import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ItemCommandsProvider } from '@nix/web-collections/items/item-commands-context';
import type { TreeItem, WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';
import { onNotice, type Notice } from '@nix/web-foundation/lib/notices';
import { ContainerView } from '../../../core/container-view';
import { aContainer } from '@nix/web-collections/testing/container-fixture';
import { item } from '@nix/web-foundation/testing/api-stub';
import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { aView } from '@nix/web-collections/testing/view-fixture';

const ROADMAP = item({ id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', title: 'Roadmap' });
const LEDGER = item({ id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', title: 'Ledger' });
const ARCHIVE = item({ id: 'cccccccc-3333-4333-8333-cccccccccccc', title: 'Archive' });
const FROZEN = item({ id: 'dddddddd-4444-4444-8444-dddddddddddd', title: 'Frozen' });

function treeItem(id: string, title: string, extra: Partial<TreeItem> = {}): TreeItem {
  return {
    id,
    title,
    type: 'note',
    parentId: null,
    hasChildren: false,
    seq: 0,
    lifecycleState: 'active',
    ...extra,
  };
}

const notices: Notice[] = [];
let stopListening = (): void => undefined;
beforeEach(() => {
  notices.length = 0;
  stopListening = onNotice((notice) => notices.push(notice));
});
afterEach(() => {
  stopListening();
});

function renderList() {
  const move = vi.fn(() => Promise.resolve({ refusal: null }));
  const reload = vi.fn(() => Promise.resolve());
  const items = [
    treeItem(ROADMAP.id, 'Roadmap'),
    treeItem(LEDGER.id, 'Ledger'),
    treeItem(ARCHIVE.id, 'Archive'),
    treeItem(FROZEN.id, 'Frozen', { noChildren: true }),
  ];
  const tree = {
    status: 'ready',
    error: null,
    items,
    find: (id: string) => items.find((entry) => entry.id === id) ?? null,
    childrenOf: (parentId: string | null) => items.filter((entry) => entry.parentId === parentId),
    move,
  } as unknown as WorkspaceTree;
  renderAt(
    <ItemCommandsProvider
      tree={tree}
      onDeleteItem={vi.fn()}
      onDeleteItems={() => Promise.resolve([])}
    >
      <ContainerView
        container={{
          ...aContainer({ children: [ROADMAP, LEDGER, ARCHIVE, FROZEN] }),
          reload,
        }}
        view={aView({ kind: 'list' })}
        onOpen={vi.fn()}
      />
    </ItemCommandsProvider>,
  );
  return { move, reload };
}

const row = (name: string): HTMLElement => screen.getByRole('row', { name: new RegExp(name, 'i') });
const dataTransfer = { setData: vi.fn(), effectAllowed: '' };

function drag(from: string, to: string): void {
  fireEvent.dragStart(row(from), { dataTransfer });
  fireEvent.dragOver(row(to), { dataTransfer });
  fireEvent.drop(row(to), { dataTransfer });
}

it('says what a drop does, and puts a dragged row inside the row it lands on', async () => {
  const { move, reload } = renderList();
  expect(screen.getByText('Drag a row onto another to put it inside.')).toBeVisible();

  fireEvent.dragStart(row('roadmap'), { dataTransfer });
  fireEvent.dragOver(row('ledger'), { dataTransfer });
  expect(row('ledger')).toHaveClass('outline-accent');
  fireEvent.drop(row('ledger'), { dataTransfer });

  await waitFor(() => {
    expect(move).toHaveBeenCalledWith(ROADMAP.id, LEDGER.id, null);
  });
  expect(move).toHaveBeenCalledTimes(1);
  await waitFor(() => {
    expect(reload).toHaveBeenCalled();
  });
  expect(notices.at(-1)?.message).toBe('1 item moved into Ledger.');
});

it('drags the whole selection when the dragged row is selected', async () => {
  const user = userEvent.setup();
  const { move } = renderList();
  await user.click(screen.getByRole('checkbox', { name: 'Select Roadmap' }));
  await user.click(screen.getByRole('checkbox', { name: 'Select Ledger' }));

  drag('roadmap', 'archive');

  await waitFor(() => {
    expect(move).toHaveBeenCalledTimes(2);
  });
  expect(move).toHaveBeenCalledWith(ROADMAP.id, ARCHIVE.id, null);
  expect(move).toHaveBeenCalledWith(LEDGER.id, ARCHIVE.id, null);
  await waitFor(() => {
    expect(notices.at(-1)?.message).toBe('2 items moved into Archive.');
  });
});

it('refuses a drop into a row that is part of the dragged selection, writing nothing', async () => {
  const user = userEvent.setup();
  const { move } = renderList();
  await user.click(screen.getByRole('checkbox', { name: 'Select Roadmap' }));
  await user.click(screen.getByRole('checkbox', { name: 'Select Ledger' }));

  fireEvent.dragStart(row('roadmap'), { dataTransfer });
  fireEvent.dragOver(row('ledger'), { dataTransfer });
  expect(row('ledger')).not.toHaveClass('outline-accent');
  fireEvent.drop(row('ledger'), { dataTransfer });

  await waitFor(() => {
    expect(notices.at(-1)?.message).toBe('An item cannot be moved inside itself.');
  });
  expect(move).not.toHaveBeenCalled();
});

it('refuses a target that takes no new children, and says why', async () => {
  const { move } = renderList();
  drag('archive', 'frozen');
  await waitFor(() => {
    expect(notices.at(-1)?.message).toBe('Frozen does not accept new children.');
  });
  expect(move).not.toHaveBeenCalled();
});
