import { createNixClient, type NixClient, type Workspace } from '@nix/api-client';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { WorkspaceProvider } from '../workspaces/workspace-context';
import { DailyNotesSwitch } from '../settings/daily-notes/daily-notes-switch';
import { WorkspaceManagementSection } from '../workspaces/workspace-management-section';

export default { title: 'Nix/Workspaces/Settings', parameters: { layout: 'fullscreen' } };

const WORKSPACE = 'd5555555-5555-4555-8555-555555555555';
const noop = (): void => undefined;
const never = new Promise<never>(() => undefined);

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
  name: 'Shared research',
  versionRetentionDays: 90,
  storageQuotaBytes: 5368709120,
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

function Example(): ReactNode {
  return (
    <ApiClientOverrideProvider client={client}>
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
                <div className="p-4">
                  <WorkspaceManagementSection dailyNotesSwitch={<DailyNotesSwitch />} />
                </div>
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
