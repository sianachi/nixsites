import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { NixApiError } from '@nix/api-client';
import { WorkspaceItemTransfer } from '../../items/workspace-item-transfer';

const client = vi.hoisted(() => ({ paginate: vi.fn(), execute: vi.fn() }));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));
const SOURCE = '11111111-1111-4111-8111-111111111111';
const DESTINATION = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';

function renderTransfer(): void {
  render(
    <MemoryRouter>
      <WorkspaceItemTransfer
        itemId={ITEM}
        sourceWorkspaceId={SOURCE}
        onClose={vi.fn()}
        onBusyChange={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('moving an item to another workspace', () => {
  it('offers every destination yielded across pages and moves to the selected root', async () => {
    const user = userEvent.setup();
    client.paginate.mockImplementation(async function* () {
      await Promise.resolve();
      yield { id: SOURCE, name: 'An earlier page' };
      yield { id: DESTINATION, name: 'Shared research' };
    });
    client.execute.mockResolvedValue({ id: ITEM, workspaceId: DESTINATION });
    renderTransfer();
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Destination workspace' }),
      DESTINATION,
    );
    await user.click(screen.getByRole('button', { name: 'Move to workspace' }));
    expect(client.execute.mock.calls.at(-1)?.[0]).toMatchObject({
      path: `/api/v1/items/${ITEM}/move`,
      body: { workspaceId: DESTINATION, parentId: null, afterId: null },
    });
  });

  it('shows an honest empty state when no other workspace is writable', async () => {
    client.paginate.mockImplementation(async function* () {
      /* no eligible destinations */
    });
    renderTransfer();
    expect(
      await screen.findByText('There are no other workspaces you can move this item into.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Move to workspace' })).toBeDisabled();
  });

  it('keeps destinations from successful pages and explains a partial list', async () => {
    client.paginate.mockImplementation(async function* () {
      await Promise.resolve();
      yield { id: DESTINATION, name: 'Shared research' };
      throw new Error('A later page failed');
    });
    renderTransfer();
    expect(await screen.findByRole('alert')).toHaveTextContent('could not all be loaded');
    expect(screen.getByRole('option', { name: 'Shared research' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry workspaces' })).toBeEnabled();
  });

  it('reports a Core refusal without claiming the item moved', async () => {
    const user = userEvent.setup();
    client.paginate.mockImplementation(async function* () {
      await Promise.resolve();
      yield { id: DESTINATION, name: 'Shared research' };
    });
    client.execute.mockRejectedValue(
      new NixApiError({
        kind: 'problem',
        code: 'items.transfer_conflict',
        message: 'Storage is full',
        detail: 'The destination workspace does not have enough storage.',
      }),
    );
    renderTransfer();
    await user.selectOptions(await screen.findByRole('combobox'), DESTINATION);
    await user.click(screen.getByRole('button', { name: 'Move to workspace' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('does not have enough storage');
    expect(screen.getByRole('button', { name: 'Move to workspace' })).toBeEnabled();
  });
});
