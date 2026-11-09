import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import {
  STUB_WORKSPACE,
  stubCoreApi,
  type StubWorkspace,
} from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';

const SHARED: StubWorkspace = {
  ...STUB_WORKSPACE,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Shared team space',
  kind: 'shared',
};
const CLIENTS = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  signedIn();
});

function stubWithClients(): void {
  stubCoreApi({
    workspaces: [STUB_WORKSPACE, SHARED],
    workspaceArrangement: {
      revision: 1,
      groups: [{ id: CLIENTS, name: 'Clients', workspaceIds: [SHARED.id] }],
      pinnedWorkspaceIds: [],
    },
  });
}

describe('the workspace groups hub', () => {
  it('lists each group with its workspaces, and the rest under No group', async () => {
    stubWithClients();
    renderAt(<App />, '/workspaces/groups');
    const clients = await screen.findByRole('list', { name: 'Workspaces in Clients' });
    expect(within(clients).getByText(SHARED.name)).toBeVisible();
    expect(
      within(screen.getByRole('list', { name: 'Workspaces in No group' })).getByText(
        STUB_WORKSPACE.name,
      ),
    ).toBeVisible();
  });

  it('creates an empty group, says so, undoes it, and opens the group page', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    renderAt(<App />, '/workspaces/groups');
    await user.type(await screen.findByRole('textbox', { name: 'New group name' }), 'Research');
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    expect(await screen.findByText('Created group Research')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Research' })).not.toBeInTheDocument();
    });

    await user.type(screen.getByRole('textbox', { name: 'New group name' }), 'Research');
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.click(await screen.findByRole('link', { name: 'Research' }));
    expect(await screen.findByRole('heading', { name: 'Research', level: 1 })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Compare priorities' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Manage' }));
    expect(screen.getByRole('checkbox', { name: `Select ${SHARED.name}` })).toBeVisible();
  });

  it('files the ticked workspaces, names where, and undoes only that', async () => {
    const user = userEvent.setup();
    stubWithClients();
    renderAt(<App />, '/workspaces/groups');
    await user.click(
      await screen.findByRole('checkbox', { name: `Select ${STUB_WORKSPACE.name}` }),
    );
    expect(screen.getByText('1 selected')).toBeVisible();
    await user.click(
      within(screen.getByRole('group', { name: 'Move selected to' })).getByRole('button', {
        name: 'Clients',
      }),
    );
    expect(await screen.findByText(`Filed ${STUB_WORKSPACE.name} in Clients`)).toBeVisible();
    expect(
      within(await screen.findByRole('list', { name: 'Workspaces in Clients' })).getByText(
        STUB_WORKSPACE.name,
      ),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(
        within(screen.getByRole('list', { name: 'Workspaces in Clients' })).queryByText(
          STUB_WORKSPACE.name,
        ),
      ).not.toBeInTheDocument();
    });
    expect(
      within(screen.getByRole('list', { name: 'Workspaces in Clients' })).getByText(SHARED.name),
    ).toBeVisible();
  });

  it('pins several at once, and undoing the pin keeps an earlier filing', async () => {
    const user = userEvent.setup();
    stubWithClients();
    renderAt(<App />, '/workspaces/groups');
    await user.click(
      await screen.findByRole('checkbox', { name: `Select ${STUB_WORKSPACE.name}` }),
    );
    await user.click(screen.getByRole('checkbox', { name: `Select ${SHARED.name}` }));
    await user.click(screen.getByRole('button', { name: 'Pin' }));
    expect(await screen.findByText('Pinned 2 workspaces')).toBeVisible();
    expect(screen.getByRole('button', { name: `Unpin ${SHARED.name}` })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: `Pin ${SHARED.name}` })).toBeVisible();
  });

  it('renames a group and undoes it', async () => {
    const user = userEvent.setup();
    stubWithClients();
    renderAt(<App />, '/workspaces/groups');
    await user.click(await screen.findByRole('button', { name: 'Rename group Clients' }));
    const name = screen.getByRole('textbox', { name: 'Name of group Clients' });
    await user.clear(name);
    await user.type(name, 'Customers{Enter}');
    expect(await screen.findByText('Renamed Clients to Customers')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('link', { name: 'Clients' })).toBeVisible();
  });

  it('removes a group without a confirm and brings it back with its workspaces on undo', async () => {
    const user = userEvent.setup();
    stubWithClients();
    renderAt(<App />, '/workspaces/groups');
    await user.click(await screen.findByRole('button', { name: 'Remove group Clients' }));
    expect(await screen.findByText('Removed group Clients')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Clients' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(
      within(await screen.findByRole('list', { name: 'Workspaces in Clients' })).getByText(
        SHARED.name,
      ),
    ).toBeVisible();
  });

  it('reorders groups and undoes the move', async () => {
    const user = userEvent.setup();
    stubCoreApi({
      workspaces: [STUB_WORKSPACE, SHARED],
      workspaceArrangement: {
        revision: 1,
        groups: [
          { id: CLIENTS, name: 'Clients', workspaceIds: [] },
          { id: '55555555-5555-4555-8555-555555555555', name: 'Home', workspaceIds: [] },
        ],
        pinnedWorkspaceIds: [],
      },
    });
    renderAt(<App />, '/workspaces/groups');
    await user.click(await screen.findByRole('button', { name: 'Move Clients down' }));
    expect(await screen.findByText('Moved group Clients down')).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Move Clients up' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Move Clients up' })).toBeDisabled();
    });
  });

  it('shows a missing group without exposing the other group controls', async () => {
    stubCoreApi({
      workspaces: [STUB_WORKSPACE, SHARED],
      workspaceArrangement: { revision: 1, groups: [], pinnedWorkspaceIds: [] },
    });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/workspace-groups/missing`);
    expect(await screen.findByText('This workspace group no longer exists.')).toBeVisible();
    expect(
      screen.queryByRole('checkbox', { name: `Select ${SHARED.name}` }),
    ).not.toBeInTheDocument();
  });
});
