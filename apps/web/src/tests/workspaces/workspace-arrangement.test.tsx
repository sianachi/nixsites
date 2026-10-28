import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import { STUB_WORKSPACE, stubCoreApi, type StubWorkspace } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import {
  arrangeWorkspaces,
  assignToGroup,
  removeGroup,
  togglePin,
} from '../../workspaces/arrangement';

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
        groups: [...arrangement.groups, { id: 'g2', name: 'Home', workspaceIds: [] }],
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

    await user.click(await screen.findByRole('button', { name: 'Workspace menu' }));
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
    await user.click(await screen.findByRole('button', { name: 'Workspace menu' }));
    const toggle = await screen.findByRole('button', { name: 'Clients' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: SHARED.name })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Workspace menu' }));
    expect(screen.getByRole('button', { name: 'Clients' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await user.click(screen.getByRole('link', { name: 'Manage group Clients' }));
    expect(await screen.findByRole('heading', { name: 'Clients', level: 1 })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Manage' }));
    const name = await screen.findByRole('textbox', { name: 'Name of group Clients' });
    await user.clear(name);
    await user.type(name, 'Customers');
    await user.tab();
    expect(await screen.findByRole('heading', { name: 'Customers', level: 1 })).toBeVisible();
    await user.selectOptions(
      screen.getByRole('combobox', { name: `Group for ${STUB_WORKSPACE.name}` }),
      groupId,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: `Group for ${STUB_WORKSPACE.name}` }),
      ).toHaveDisplayValue('Customers'),
    );
    await user.click(screen.getByRole('button', { name: 'Remove group Customers' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'This workspace group no longer exists.',
    );
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

    await user.click(await screen.findByRole('button', { name: 'Workspace menu' }));
    const menu = screen.getByRole('region', { name: 'Workspaces' });
    const clients = await within(menu).findByRole('list', { name: 'Clients' });
    expect(within(clients).getByRole('link', { name: SHARED.name })).toBeVisible();
    const other = within(menu).getByRole('list', { name: 'Other workspaces' });
    expect(within(other).getByRole('link', { name: STUB_WORKSPACE.name })).toBeVisible();
    expect(within(menu).queryByText(GONE)).not.toBeInTheDocument();
  });
});

async function openArrange(user: UserEvent): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Workspace menu' }));
  await user.click(screen.getByRole('button', { name: 'Arrange workspaces…' }));
  return screen.findByRole('region', { name: 'Workspace groups and pins' });
}

describe('workspace groups in the workspace menu', () => {
  it('creates a group from a workspace row, renames it and removes it without losing the workspace', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    renderAt(<App />, '/settings');

    const section = await openArrange(user);
    // No groups yet: nothing to manage.
    expect(within(section).queryByText('Manage groups')).not.toBeInTheDocument();

    await user.selectOptions(
      await within(section).findByRole('combobox', { name: `Group for ${SHARED.name}` }),
      'New group…',
    );
    await user.type(
      await within(section).findByRole('textbox', { name: `New group for ${SHARED.name}` }),
      'Clients',
    );
    await user.click(within(section).getByRole('button', { name: 'Add' }));

    // The new group is created and already holds the workspace it was made from.
    const select = await within(section).findByRole('combobox', {
      name: `Group for ${SHARED.name}`,
    });
    await waitFor(() => {
      expect(select).toHaveDisplayValue('Clients');
    });

    await user.click(within(section).getByText('Manage groups'));
    const name = within(section).getByRole('textbox', { name: 'Name of group Clients' });
    await user.clear(name);
    await user.type(name, 'Customers');
    await user.tab();
    await waitFor(() => {
      expect(select).toHaveDisplayValue('Customers');
    });

    await user.click(within(section).getByRole('button', { name: 'Remove group Customers' }));
    await waitFor(() => {
      expect(within(section).queryByText('Manage groups')).not.toBeInTheDocument();
    });
    // Still here, now ungrouped: a removed group takes nothing with it.
    expect(select).toHaveDisplayValue('No group');
    expect(within(section).getByText(SHARED.name)).toBeVisible();
  });

  it('shows a missing group without exposing the other group controls', async () => {
    stubCoreApi({
      workspaces: [STUB_WORKSPACE, SHARED],
      workspaceArrangement: { revision: 1, groups: [], pinnedWorkspaceIds: [] },
    });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/workspace-groups/missing`);
    expect(await screen.findByText('This workspace group no longer exists.')).toBeVisible();
    expect(
      screen.queryByRole('combobox', { name: `Group for ${SHARED.name}` }),
    ).not.toBeInTheDocument();
  });

  it('creates an empty group in the global hub and opens its analysis page', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    renderAt(<App />, '/workspaces/groups');
    await user.type(await screen.findByRole('textbox', { name: 'New group name' }), 'Research');
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.click(await screen.findByRole('link', { name: 'Research' }));
    expect(await screen.findByRole('heading', { name: 'Research', level: 1 })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Compare priorities' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Manage' }));
    expect(screen.getByRole('combobox', { name: `Group for ${SHARED.name}` })).toBeVisible();
  });

  it('cancels a pending new group with Escape', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    renderAt(<App />, '/settings');

    const section = await openArrange(user);
    await user.selectOptions(
      await within(section).findByRole('combobox', { name: `Group for ${SHARED.name}` }),
      'New group…',
    );
    await user.type(
      within(section).getByRole('textbox', { name: `New group for ${SHARED.name}` }),
      '{Escape}',
    );
    expect(
      within(section).getByRole('combobox', { name: `Group for ${SHARED.name}` }),
    ).toHaveDisplayValue('No group');
  });
});
