import { createNixClient, type NixClient, type Workspace } from '@nix/api-client';
import { within } from '@testing-library/dom';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { WorkspaceProvider } from '@nix/web-workspaces/workspaces/workspace-context';
import { DailyNotesSwitch } from '@nix/web-settings/settings/daily-notes/daily-notes-switch';
import { WorkspaceManagementSection } from '@nix/web-workspaces/workspaces/workspace-management-section';
import { LinearConnectionsSection } from './linear-connections-section';
import { LinearRequestsSection } from '../panel/linear-requests-section';

export default { title: 'Nix/Workspaces/Settings', parameters: { layout: 'fullscreen' } };

const WORKSPACE = 'd5555555-5555-4555-8555-555555555555';
const noop = (): void => undefined;
const never = new Promise<never>(() => undefined);
const tokens = {
  getAccessToken: () => Promise.resolve(null),
  refreshAccessToken: () => Promise.resolve(null),
};

const baseClient = createNixClient({
  cache: { staleAfterMs: Infinity },
  baseUrl: 'http://nix.invalid',
  tokens,
});

const workspace: Workspace = {
  id: WORKSPACE,
  name: 'Shared research',
  versionRetentionDays: 90,
  storageQuotaBytes: 5368709120,
  storageUsedBytes: 0,
  createdAt: '2026-01-01T00:00:00Z',
  kind: 'shared',
  canRename: true,
  canManageMembers: true,
  canLeave: true,
  canUseDailyNotes: true,
  pendingInvitationId: null,
  lifecycleState: 'active',
  archivedAt: null,
  membershipLocked: false,
  collaboration: true,
};

const members = [
  ['Protected owner', 'owner', false],
  ['Working editor', 'editor', true],
  ['Ada Lovelace-Babbage with a rather long display name', 'viewer', true],
].map(([name, role, editable], index) => ({
  subjectType: 'principal',
  subjectId: `4444444${String(index)}-bbbb-4bbb-8bbb-444444444444`,
  subjectDisplayName: name,
  role,
  grantedAt: '2026-03-12T09:00:00+00:00',
  canChangeRole: editable,
  canRemove: editable,
  assignableRoles: editable ? ['editor', 'viewer'] : [],
}));

const invitations = [
  {
    id: '88888888-bbbb-4bbb-8bbb-888888888888',
    emailNormalized: 'new.person@example.test',
    targetPrincipalId: null,
    role: 'editor',
    status: 'pending',
    invitedByPrincipalId: '44444440-bbbb-4bbb-8bbb-444444444444',
    invitedAt: '2026-08-30T09:00:00.000Z',
    acceptedAt: null,
    acceptedByPrincipalId: null,
    revokedAt: null,
  },
];

const invitees = [
  {
    principalId: '66666666-bbbb-4bbb-8bbb-666666666666',
    displayName: 'Grace Hopper',
    email: 'grace@example.test',
    canInvite: true,
    cannotInviteReason: null,
  },
];

const client = {
  ...baseClient,
  query: () => never,
  // eslint-disable-next-line @typescript-eslint/require-await -- Justification: an async generator is the contract.
  async *paginate(endpoint: { readonly operation: string }) {
    const rows = endpoint.operation.includes('invitees')
      ? invitees
      : endpoint.operation.includes('invitations')
        ? invitations
        : members;
    yield* rows;
  },
} as unknown as NixClient;

function Example({
  client: activeClient = client,
  children = <WorkspaceManagementSection dailyNotesSwitch={<DailyNotesSwitch />} />,
}: {
  readonly client?: NixClient;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <ApiClientOverrideProvider client={activeClient}>
      <MemoryRouter initialEntries={[`/w/${WORKSPACE}/settings`]}>
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
                <div className="p-4">{children}</div>
              </WorkspaceProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    </ApiClientOverrideProvider>
  );
}

export const Owner = { render: (): ReactNode => <Example /> };
export const DarkOwner = { ...Owner, globals: { ground: 'dark' } };

const TASK = '8d83ad48-2963-465e-8ad9-1342556b09ce';
const linearClient = createNixClient({
  baseUrl: 'http://nix.invalid',
  tokens,
  fetch: (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/linear')) {
      return Promise.resolve(Response.json({ connected: false }));
    }
    if (url.endsWith('/linear-link')) {
      return Promise.resolve(Response.json({ link: null, connections: [] }));
    }

    return Promise.resolve(
      Response.json({
        requests: [
          {
            id: 'da47fc39-fd14-40c9-89cb-1e5a7b78f836',
            itemId: TASK,
            issueId: 'PAY-24',
            status: 'pending',
            requestedBy: 'Claude',
            createdAt: '2026-11-16T12:00:00Z',
            expiresAt: '2026-11-16T12:15:00Z',
            canDecide: true,
          },
        ],
      }),
    );
  },
});

export const LinearConnection = {
  render: (): ReactNode => (
    <Example client={linearClient}>
      <LinearConnectionsSection />
    </Example>
  ),
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    await within(canvasElement).findByRole('button', { name: 'Connect Linear' });
  },
};

export const LinearApproval = {
  render: (): ReactNode => (
    <ApiClientOverrideProvider client={linearClient}>
      <div className="w-full max-w-xs p-3">
        <LinearRequestsSection itemId={TASK} />
      </div>
    </ApiClientOverrideProvider>
  ),
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    await within(canvasElement).findByRole('button', { name: 'Approve once' });
  },
};

const PET_ID = '274887d2-b8d9-46d1-9aa4-25693270c936';
const handoffClient = createNixClient({
  baseUrl: 'http://nix.invalid',
  tokens,
  fetch: (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/pets/settings')) {
      return Promise.resolve(
        Response.json({
          revision: 1,
          settings: {
            enabled: true,
            activePetId: PET_ID,
            profiles: [{ id: PET_ID, name: 'Owl', appearance: 'owl', instructions: '' }],
          },
        }),
      );
    }
    if (url.endsWith('/linear-link')) {
      return Promise.resolve(Response.json({ link: null, connections: [] }));
    }
    return Promise.resolve(Response.json({ requests: [], canHandToPet: true }));
  },
});

export const HandToPet = {
  render: (): ReactNode => (
    <ApiClientOverrideProvider client={handoffClient}>
      <div className="w-full max-w-xs p-3">
        <LinearRequestsSection itemId={TASK} />
      </div>
    </ApiClientOverrideProvider>
  ),
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: 'Linear issue ID' });
    await canvas.findByRole('button', { name: 'Request Linear lookup' });
  },
};
