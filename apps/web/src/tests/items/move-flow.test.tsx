import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { expect, it, vi } from 'vitest';

import { ApiClientProvider } from '@nix/web-platform/api/api-client-provider';
import { executeBulkDelete } from '../../items/bulk-delete';
import { ItemCommandsProvider } from '../../items/item-commands-context';
import { useWorkspaceTree } from '../../items/use-workspace-tree';
import { ContainerView } from '../../views/core/container-view';
import { useContainer } from '../../views/core/use-container';
import { WorkspaceProvider } from '@nix/web-workspaces/workspaces/workspace-context';
import { item, STUB_WORKSPACE, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { aView } from '../view-fixture';

vi.mock('@nix/web-platform/auth/auth-provider', () => ({
  useAuth: () => ({ getAccessToken: () => Promise.resolve('token') }),
}));

const FOLDER = item({ id: '5f5f5f5f-1111-4111-8111-5f5f5f5f5f5f', title: 'Folder' });
const MOVING = item({
  id: '5a5a5a5a-1111-4111-8111-5a5a5a5a5a5a',
  title: 'Alpha',
  parentId: FOLDER.id,
});
const STAYING = item({
  id: '5b5b5b5b-1111-4111-8111-5b5b5b5b5b5b',
  title: 'Beta',
  parentId: FOLDER.id,
});
const DESTINATION = item({ id: '5c5c5c5c-1111-4111-8111-5c5c5c5c5c5c', title: 'Gamma' });

/** The shell's wiring in miniature: one real tree feeding the commands, one real container list. */
function Harness(): ReactNode {
  const tree = useWorkspaceTree();
  const container = useContainer(FOLDER.id);
  return (
    <ItemCommandsProvider
      tree={tree}
      onDeleteItem={vi.fn()}
      onDeleteItems={async (items) => {
        const outcome = await executeBulkDelete(tree, items);
        return outcome.deleted.map((item) => item.id);
      }}
    >
      <ContainerView container={container} view={aView({ kind: 'list' })} onOpen={vi.fn()} />
    </ItemCommandsProvider>
  );
}

function renderHarness(): void {
  render(
    <MemoryRouter initialEntries={[`/w/${STUB_WORKSPACE.id}`]}>
      <ApiClientProvider>
        <Routes>
          <Route
            path="/w/:workspaceId"
            element={
              <WorkspaceProvider
                state={{
                  status: 'ready',
                  workspaces: [STUB_WORKSPACE],
                  error: null,
                  reload: () => undefined,
                  workspaceCreated: () => undefined,
                  workspaceUpdated: () => undefined,
                  workspaceRemoved: () => undefined,
                }}
              >
                <Harness />
              </WorkspaceProvider>
            }
          />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

it('drops a row from the list it left when Move to... finishes, without a reload', async () => {
  const user = userEvent.setup();
  stubCoreApi({ items: [FOLDER, MOVING, STAYING, DESTINATION] });
  renderHarness();

  await user.click(await screen.findByRole('checkbox', { name: 'Select Alpha' }));
  await user.click(
    within(await screen.findByRole('toolbar', { name: 'Selected items' })).getByRole('button', {
      name: 'Move to…',
    }),
  );
  const dialog = await screen.findByRole('dialog', { name: 'Move item' });
  await user.click(within(dialog).getByRole('button', { name: 'Gamma' }));
  await user.click(within(dialog).getByRole('button', { name: 'Move here' }));

  await waitFor(() => {
    expect(screen.queryByRole('checkbox', { name: 'Select Alpha' })).not.toBeInTheDocument();
  });
  expect(screen.getByRole('checkbox', { name: 'Select Beta' })).toBeInTheDocument();
});

it('deletes a selected container child without loading its collapsed sidebar branch', async () => {
  const user = userEvent.setup();
  stubCoreApi({ items: [FOLDER, MOVING, STAYING, DESTINATION] });
  renderHarness();

  await user.click(await screen.findByRole('checkbox', { name: 'Select Alpha' }));
  await user.click(
    within(screen.getByRole('toolbar', { name: 'Selected items' })).getByRole('button', {
      name: 'Delete',
    }),
  );
  const dialog = await screen.findByRole('dialog', { name: 'Delete 1 item?' });
  await user.click(within(dialog).getByRole('button', { name: 'Delete 1 item' }));

  await waitFor(() => {
    const deleted = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([, init]) => init?.method === 'DELETE')
      .map(([input]) => (input instanceof Request ? input.url : String(input)));
    expect(deleted).toEqual([expect.stringContaining(`/api/v1/items/${MOVING.id}`)]);
  });
  expect(screen.getByRole('checkbox', { name: 'Select Beta' })).toBeInTheDocument();
  expect(screen.queryByRole('dialog', { name: 'Delete 1 item?' })).not.toBeInTheDocument();
  expect(screen.queryByRole('toolbar', { name: 'Selected items' })).not.toBeInTheDocument();
});
