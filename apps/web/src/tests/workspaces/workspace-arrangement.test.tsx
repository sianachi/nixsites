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
import {
  arrangeWorkspaces,
  assignToGroup,
  removeGroup,
  togglePin,
} from '@nix/web-workspaces/workspaces/arrangement';
import { openWorkspacePanel } from './workspace-menu';

const SHARED: StubWorkspace = {
  ...STUB_WORKSPACE,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Shared team space',
  kind: 'shared',
};
const GONE = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  signedIn();
});

describe('arrangeWorkspaces', () => {
  it('lays groups and pins over the visible workspaces, dropping ids the person cannot see', () => {
    const arrangement = {
      groups: [{ id: 'g1', name: 'Work', workspaceIds: [SHARED.id, GONE] }],
      pinnedWorkspaceIds: [GONE, STUB_WORKSPACE.id],
    };
    const arranged = arrangeWorkspaces([STUB_WORKSPACE, SHARED], arrangement);
    expect(arranged.pinned.map((entry) => entry.id)).toEqual([STUB_WORKSPACE.id]);
    expect(arranged.groups[0]?.workspaces.map((entry) => entry.id)).toEqual([SHARED.id]);
    expect(arranged.ungrouped.map((entry) => entry.id)).toEqual([STUB_WORKSPACE.id]);
    // Removing the group keeps the workspace; it only becomes ungrouped.
    expect(
      arrangeWorkspaces([STUB_WORKSPACE, SHARED], removeGroup(arrangement, 'g1')).ungrouped,
    ).toHaveLength(2);
    // A workspace sits in one group at most.
    const moved = assignToGroup(
      {
        ...arrangement,
        groups: [...arrangement.groups, { id: 'g2', name: 'Homebase', workspaceIds: [] }],
      },
      SHARED.id,
      'g2',
    );
    expect(moved.groups.map((group) => group.workspaceIds)).toEqual([[GONE], [SHARED.id]]);
    expect(togglePin(togglePin(arrangement, SHARED.id), SHARED.id).pinnedWorkspaceIds).toEqual(
      arrangement.pinnedWorkspaceIds,
    );
  });
});

describe('the workspace menu', () => {
  it('pins a workspace from the menu and shows a Pinned section that persists through the stub', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    renderAt(<App />);

    await openWorkspacePanel(user);
    const menu = screen.getByRole('region', { name: 'Workspaces' });
    expect(within(menu).queryByRole('heading', { name: 'Pinned' })).not.toBeInTheDocument();
    await user.click(within(menu).getByRole('button', { name: `Pin ${SHARED.name}` }));
    expect(await within(menu).findByRole('heading', { name: 'Pinned' })).toBeVisible();
    const pinned = within(menu).getByRole('list', { name: 'Pinned' });
    expect(within(pinned).getByRole('link', { name: SHARED.name })).toHaveAttribute(
      'href',
      `/w/${SHARED.id}`,
    );
    // Pinned is quick access: the workspace keeps its place in its own list as well.
    expect(within(pinned).getByRole('button', { name: `Unpin ${SHARED.name}` })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(menu).getAllByRole('link', { name: SHARED.name })).toHaveLength(2);
  });

  it('collapses a group, keeps it collapsed when reopening the menu, and opens its management page', async () => {
    const user = userEvent.setup();
    const groupId = '44444444-4444-4444-8444-444444444444';
    stubCoreApi({
      workspaces: [STUB_WORKSPACE, SHARED],
      workspaceArrangement: {
        revision: 3,
        groups: [{ id: groupId, name: 'Clients', workspaceIds: [SHARED.id] }],
        pinnedWorkspaceIds: [],
      },
    });
    renderAt(<App />);
    await openWorkspacePanel(user);
    const toggle = await screen.findByRole('button', { name: 'Clients' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: SHARED.name })).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Manage group Clients' }));
    expect(await screen.findByRole('heading', { name: 'Clients', level: 1 })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Manage' }));
    await user.click(await screen.findByRole('button', { name: 'Rename group Clients' }));
    const name = await screen.findByRole('textbox', { name: 'Name of group Clients' });
    await user.clear(name);
    await user.type(name, 'Customers{Enter}');
    expect(await screen.findByRole('heading', { name: 'Customers', level: 1 })).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: `Select ${STUB_WORKSPACE.name}` }));
    await user.click(screen.getByRole('button', { name: 'Customers' }));
    expect(
      within(await screen.findByRole('list', { name: 'Workspaces in Customers' })).getByText(
        STUB_WORKSPACE.name,
      ),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove group Customers' }));
    expect(await screen.findByText('This workspace group no longer exists.')).toBeVisible();
  });

  it('lists saved groups with their workspaces and the rest under Other workspaces', async () => {
    const user = userEvent.setup();
    stubCoreApi({
      workspaces: [STUB_WORKSPACE, SHARED],
      workspaceArrangement: {
        revision: 3,
        groups: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            name: 'Clients',
            workspaceIds: [SHARED.id, GONE],
          },
        ],
        pinnedWorkspaceIds: [],
      },
    });
    renderAt(<App />);

    await openWorkspacePanel(user);
    const menu = screen.getByRole('region', { name: 'Workspaces' });
    const clients = await within(menu).findByRole('list', { name: 'Clients' });
    expect(within(clients).getByRole('link', { name: SHARED.name })).toBeVisible();
    const other = within(menu).getByRole('list', { name: 'Other workspaces' });
    expect(within(other).getByRole('link', { name: STUB_WORKSPACE.name })).toBeVisible();
    expect(within(menu).queryByText(GONE)).not.toBeInTheDocument();
  });
});

describe('the workspaces page', () => {
  it('pins and files a workspace, says so, and undoes each from the Undo button', async () => {
    const user = userEvent.setup();
    const groupId = '44444444-4444-4444-8444-444444444444';
    stubCoreApi({
      workspaces: [STUB_WORKSPACE, SHARED],
      workspaceArrangement: {
        revision: 1,
        groups: [{ id: groupId, name: 'Clients', workspaceIds: [] }],
        pinnedWorkspaceIds: [],
      },
    });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/workspaces`);

    const page = await screen.findByRole('region', { name: 'Workspaces' });
    await user.click(await within(page).findByRole('button', { name: `Pin ${SHARED.name}` }));
    expect(await screen.findByText(`Pinned ${SHARED.name}`)).toBeVisible();
    const picker = within(page).getAllByRole('combobox', { name: `Group for ${SHARED.name}` })[0];
    if (picker === undefined) throw new Error('Expected a group picker.');
    await user.selectOptions(picker, groupId);
    expect(await screen.findByText(`Filed ${SHARED.name} in Clients`)).toBeVisible();
    expect(within(page).getByRole('button', { name: 'Clients' })).toHaveTextContent('1');

    // Newest first: filing is undone and the pin made before it survives.
    await user.click(screen.getByRole('button', { name: 'Undo (2)' }));
    await waitFor(() => {
      expect(within(page).getByRole('button', { name: 'Clients' })).toHaveTextContent('0');
    });
    expect(within(page).getAllByRole('button', { name: `Unpin ${SHARED.name}` })).not.toHaveLength(
      0,
    );

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(within(page).queryByRole('heading', { name: 'Pinned' })).not.toBeInTheDocument();
    });
  });

  it('opens group management from the workspaces page', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/workspaces`);
    const page = await screen.findByRole('region', { name: 'Workspaces' });
    await user.click(within(page).getByRole('link', { name: /^Manage workspace groups/ }));

    expect(
      await screen.findByRole('heading', { name: 'Workspace groups', level: 1 }),
    ).toBeVisible();
    expect(await screen.findByRole('textbox', { name: 'New group name' })).toBeVisible();
  });
});
