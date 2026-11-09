import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Item } from '@nix/api-client';
import { UndoProvider } from '@nix/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TrashPage } from '../../pages/trash-page';

/** The Trash page: multi-select, search, bulk restore with undo, and counted permanent deletes. */

const calls = vi.hoisted(() => ({ ops: [] as string[], titles: [] as string[] }));

vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => ({
    paginate: () =>
      // eslint-disable-next-line @typescript-eslint/require-await -- an async generator stands in for the paged API
      (async function* () {
        for (const title of calls.titles)
          yield { id: `id-${title}`, title, parentId: null } as unknown as Item;
      })(),
    execute: (endpoint: { operation: string; path: string }) => {
      calls.ops.push(`${endpoint.operation}:${endpoint.path.split('/')[4] ?? ''}`);
      return Promise.resolve({ parentId: null });
    },
    query: () => Promise.resolve({}),
  }),
}));
vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'w1' }),
}));

function renderPage(): void {
  render(
    <UndoProvider>
      <TrashPage />
    </UndoProvider>,
  );
}

beforeEach(() => {
  calls.ops = [];
  calls.titles = ['Alpha', 'Beta', 'Gamma'];
});

describe('the trash page', () => {
  it('searches, selects the visible rows and restores them in one action', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('list', { name: 'Trash' });

    await user.type(screen.getByRole('searchbox', { name: 'Search Trash' }), 'a');
    // "Beta" has an a, all three match; narrow to Gamma.
    await user.clear(screen.getByRole('searchbox', { name: 'Search Trash' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search Trash' }), 'gam');
    await user.click(screen.getByRole('checkbox', { name: /select all \(1\)/i }));
    await user.click(screen.getByRole('button', { name: 'Restore 1' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/Restored “Gamma”/);
    });
    expect(calls.ops).toEqual(['items.restore:id-Gamma']);
  });

  it('puts restored rows back in Trash on undo, in their old place', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('list', { name: 'Trash' });

    await user.click(screen.getByRole('button', { name: 'Restore Beta' }));
    await waitFor(() => {
      expect(screen.queryByText('Beta')).not.toBeInTheDocument();
    });
    await user.keyboard('{Control>}z{/Control}');

    const rows = await within(screen.getByRole('list', { name: 'Trash' })).findAllByRole(
      'listitem',
    );
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Alpha'),
      expect.stringContaining('Beta'),
      expect.stringContaining('Gamma'),
    ]);
    expect(calls.ops).toEqual(['items.restore:id-Beta', 'items.delete:id-Beta']);
  });

  it('names what Empty Trash will destroy and how many, and deletes nothing until confirmed', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('list', { name: 'Trash' });

    await user.click(screen.getByRole('button', { name: 'Empty Trash (3)' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete 3 items permanently?')).toBeVisible();
    expect(within(dialog).getByText('Gamma')).toBeVisible();
    expect(calls.ops).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => {
      expect(screen.getByText('Trash is empty')).toBeVisible();
    });
    expect(calls.ops).toHaveLength(3);
  });
});
