import { createNixClient, type NixClient, type Workspace } from '@nix/api-client';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { WorkspaceProvider } from '@nix/web-workspaces/workspaces/workspace-context';
import { WorkspaceSwitcher } from '@nix/web-workspaces/workspaces/workspace-switcher';
import { NewChatNote } from '../pets/chat/new-chat-note';
import {
  WorkspaceGroupsPage,
  WorkspaceGroupPage,
} from '@nix/web-workspaces/workspaces/workspace-group-page';

export default { title: 'Nix/Workspaces/Groups', parameters: { layout: 'fullscreen' } };

const WORKSPACE = 'd5555555-5555-4555-8555-555555555555';
const noop = (): void => undefined;

/** A client that never reaches a server: the rail's own reads (the pet entry) answer nothing. */
const baseClient = createNixClient({
  cache: { staleAfterMs: Infinity },
  baseUrl: 'http://nix.invalid',
  tokens: {
    getAccessToken: () => Promise.resolve(null),
    refreshAccessToken: () => Promise.resolve(null),
  },
});

const workspace: Workspace = {
  id: WORKSPACE,
  name: 'Personal',
  versionRetentionDays: 90,
  storageQuotaBytes: 0,
  createdAt: '2026-01-01T00:00:00Z',
  kind: 'personal',
  canRename: true,
  canManageMembers: false,
  canLeave: false,
  canUseDailyNotes: true,
  pendingInvitationId: null,
  lifecycleState: 'active',
  archivedAt: null,
  membershipLocked: false,
  collaboration: true,
};

const GROUP = 'e5555555-5555-4555-8555-555555555555';
const client: NixClient = {
  ...baseClient,
  query: (endpoint) =>
    Promise.resolve(
      endpoint.schema.parse({
        revision: 1,
        groups: [{ id: GROUP, name: 'Personal projects', workspaceIds: [WORKSPACE] }],
        pinnedWorkspaceIds: [],
      }),
    ),
};

function Example({
  management = false,
  hub = false,
}: {
  readonly management?: boolean;
  readonly hub?: boolean;
}): ReactNode {
  return (
    <ApiClientOverrideProvider client={client}>
      <MemoryRouter
        initialEntries={[`/w/${WORKSPACE}${management ? `/workspace-groups/${GROUP}` : ''}`]}
      >
        <Routes>
          <Route
            path="/w/:workspaceId/*"
            element={
              <WorkspaceProvider
                state={{
                  status: 'ready',
                  workspaces: [workspace],
                  error: null,
                  reload: noop,
                  workspaceCreated: noop,
                  workspaceUpdated: noop,
                  workspaceRemoved: noop,
                }}
              >
                {hub ? (
                  <WorkspaceGroupsPage />
                ) : management ? (
                  <WorkspaceGroupPage NewChatNote={NewChatNote} />
                ) : (
                  <WorkspaceSwitcher />
                )}
              </WorkspaceProvider>
            }
          />
          <Route
            path="/w/:workspaceId/workspace-groups/:groupId"
            element={
              <WorkspaceProvider
                state={{
                  status: 'ready',
                  workspaces: [workspace],
                  error: null,
                  reload: noop,
                  workspaceCreated: noop,
                  workspaceUpdated: noop,
                  workspaceRemoved: noop,
                }}
              >
                <WorkspaceGroupPage NewChatNote={NewChatNote} />
              </WorkspaceProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    </ApiClientOverrideProvider>
  );
}

export const Menu = {
  render: (): ReactNode => <Example />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Workspace menu' }));
    const page = within(document.body);
    const group = await page.findByRole('button', { name: 'Personal projects' });
    await userEvent.click(group);
    if (group.getAttribute('aria-expanded') !== 'false') throw new Error('Group did not collapse.');
    await userEvent.click(group);
    await page.findByRole('link', { name: 'Personal' });
  },
};
export const Management = { render: (): ReactNode => <Example management /> };
export const DarkManagement = { ...Management, globals: { ground: 'dark' } };

export const Hub = { render: (): ReactNode => <Example hub /> };
export const DarkHub = { ...Hub, globals: { ground: 'dark' } };
