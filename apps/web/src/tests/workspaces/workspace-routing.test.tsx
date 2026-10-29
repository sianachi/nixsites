import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import {
  item,
  STUB_WORKSPACE,
  stubCoreApi,
  type StubWorkspace,
} from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { setZenMode } from '@nix/web-foundation/lib/zen-mode';
import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';
import { requestUrl } from '@nix/web-foundation/testing/request-url';

const SHARED_ID = '00000000-0000-4000-8000-000000000002';
const INACCESSIBLE_ID = '00000000-0000-4000-8000-000000000099';
const NOTE = item({
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Scoped note',
});

const SHARED: StubWorkspace = {
  ...STUB_WORKSPACE,
  id: SHARED_ID,
  name: 'Shared research',
  kind: 'shared',
  canLeave: true,
};

const ARCHIVED: StubWorkspace = {
  ...STUB_WORKSPACE,
  lifecycleState: 'archived',
  archivedAt: '2026-09-06T12:00:00Z',
};

beforeEach(() => {
  setZenMode(false);
  signedIn();
  vi.stubGlobal('localStorage', memoryStorage());
});

describe('workspace-scoped routing', () => {
  it('lists each accessible workspace with direct open and management routes', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /, workspace menu$/ }));

    const menu = screen.getByRole('region', { name: 'Workspaces' });
    expect(within(menu).getByRole('link', { name: SHARED.name })).toHaveAttribute(
      'href',
      `/w/${SHARED.id}`,
    );
    expect(within(menu).getByRole('link', { name: `Manage ${SHARED.name}` })).toHaveAttribute(
      'href',
      `/w/${SHARED.id}/settings`,
    );
    expect(within(menu).getByRole('button', { name: 'New workspace…' })).toBeVisible();
    expect(within(menu).getByRole('button', { name: 'Arrange workspaces…' })).toBeVisible();
  });

  it('searches workspaces by name and opens the first match on Enter', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /, workspace menu$/ }));
    const search = screen.getByRole('searchbox', { name: 'Search workspaces' });
    expect(search).toHaveFocus();

    await user.type(search, 'RESEARCH');
    const menu = screen.getByRole('region', { name: 'Workspaces' });
    const matches = within(menu).getByRole('list', { name: 'Matching workspaces' });
    expect(within(matches).getAllByRole('link', { name: SHARED.name })).toHaveLength(1);
    expect(within(menu).queryByRole('link', { name: STUB_WORKSPACE.name })).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'nothing like it');
    expect(within(menu).getByRole('status')).toHaveTextContent(/no workspace matches/i);

    await user.clear(search);
    await user.type(search, 'shared{Enter}');
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Workspaces' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /, workspace menu$/ })).toHaveTextContent(
      SHARED.name,
    );
  });

  it('opens the personal workspace from a legacy route when no accessible workspace was remembered', async () => {
    stubCoreApi({ workspaces: [SHARED, STUB_WORKSPACE] });
    renderAt(<App />, '/graph');

    expect(await screen.findByRole('heading', { name: 'Graph' })).toBeVisible();
    expect(screen.getByRole('button', { name: /, workspace menu$/ })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Graph' })).toHaveAttribute(
      'href',
      `/w/${STUB_WORKSPACE.id}/graph`,
    );
    expect(workspaceListRequests()).toHaveLength(1);
  });

  it('uses an accessible remembered workspace but ignores an opaque id the caller cannot reach', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'nix.last-workspace-id': SHARED_ID }));
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    const first = renderAt(<App />, '/calendar');
    expect(await screen.findByRole('heading', { name: 'Calendar' })).toBeVisible();
    expect(screen.getByRole('button', { name: /, workspace menu$/ })).toBeVisible();
    first.unmount();

    vi.stubGlobal('localStorage', memoryStorage({ 'nix.last-workspace-id': INACCESSIBLE_ID }));
    renderAt(<App />, '/calendar');
    expect(await screen.findByRole('heading', { name: 'Calendar' })).toBeVisible();
    expect(screen.getByRole('button', { name: /, workspace menu$/ })).toBeVisible();
  });

  it('opens an accessible deep link without passing through the legacy resolver', async () => {
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    renderAt(<App />, `/w/${SHARED_ID}/graph`);

    expect(await screen.findByRole('heading', { name: 'Graph' })).toBeVisible();
    expect(screen.getByRole('button', { name: /, workspace menu$/ })).toBeVisible();
  });

  it('routes an account with no active workspace to recover or replace archived work', async () => {
    stubCoreApi({ workspaces: [ARCHIVED] });
    renderAt(<App />);

    expect(await screen.findByRole('heading', { name: 'Archived workspaces' })).toBeVisible();
    expect(screen.getByText(ARCHIVED.name)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Restore workspace' })).toBeVisible();
  });

  it('keeps archived workspace actions available in Zen and offers an exit', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [ARCHIVED] });
    renderAt(<App />, '/workspaces/archived');

    await user.click(await screen.findByRole('button', { name: 'Enter Zen' }));
    expect(screen.queryByRole('link', { name: 'Back to workspaces' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore workspace' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Exit Zen' }));
    expect(screen.getByRole('link', { name: 'Back to workspaces' })).toBeVisible();
  });

  it('requires an archived workspace before offering permanent deletion', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [ARCHIVED] });
    renderAt(<App />, '/workspaces/archived');

    await user.click(await screen.findByRole('button', { name: 'Delete permanently' }));
    expect(screen.getByText(/cannot be undone/i)).toBeVisible();
    const confirmationButton = screen.getAllByRole('button', { name: 'Delete permanently' })[1];
    if (confirmationButton === undefined)
      throw new Error('Permanent deletion confirmation was not shown.');
    await user.click(confirmationButton);

    await waitFor(() => {
      expect(screen.getByText('No archived workspaces.')).toBeVisible();
    });
  });

  it('does not confirm whether an inaccessible workspace exists', async () => {
    stubCoreApi({ workspaces: [STUB_WORKSPACE] });
    renderAt(<App />, `/w/${INACCESSIBLE_ID}`);

    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeVisible();
    expect(screen.getByText(/unavailable or you do not have access/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Switch workspace' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /, workspace menu$/ })).not.toBeInTheDocument();
  });

  it('does not call a workspace missing when the accessible list is partial', async () => {
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED], workspacesPartial: true });
    renderAt(<App />, `/w/${SHARED.id}`);

    expect(
      await screen.findByRole('heading', { name: 'Workspace access could not be checked' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Workspace not found' })).not.toBeInTheDocument();
  });

  it('clears item and pane state when switching and reloads against the target workspace', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED], items: [NOTE] });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}?item=${NOTE.id}&view=board&item2=${NOTE.id}`);

    const selected = await screen.findByRole('treeitem', { name: 'Scoped note' });
    expect(selected).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('button', { name: /, workspace menu$/ }));
    await user.click(
      within(screen.getByRole('region', { name: 'Workspaces' })).getByRole('link', {
        name: SHARED.name,
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /, workspace menu$/ })).toBeVisible();
      expect(screen.getByRole('treeitem', { name: 'Scoped note' })).toHaveAttribute(
        'aria-selected',
        'false',
      );
    });
    expect(screen.getByRole('link', { name: 'Homebase' })).toHaveAttribute(
      'href',
      `/w/${SHARED_ID}`,
    );
  });

  it('renders honest empty and error states before mounting workspace resources', async () => {
    stubCoreApi({ workspaces: [] });
    const empty = renderAt(<App />);
    expect(await screen.findByRole('heading', { name: 'No workspace is available' })).toBeVisible();
    empty.unmount();

    stubCoreApi({ workspacesFail: true });
    renderAt(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Your workspaces could not be loaded' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

function workspaceListRequests(): readonly unknown[] {
  return (
    fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } }
  ).mock.calls.filter(([input, init]) => {
    const url = requestUrl(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    return method === 'GET' && new URL(url, location.origin).pathname === '/api/v1/workspaces';
  });
}
