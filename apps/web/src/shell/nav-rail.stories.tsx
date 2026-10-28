import { createNixClient, type NixClient, type Workspace } from '@nix/api-client';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';

import { ApiClientOverrideProvider } from '../api/api-client-provider';
import { useKnownSmartListsStore } from '../views/query/known-smart-lists';
import { WorkspaceProvider } from '../workspaces/workspace-context';
import { NavRail } from './nav-rail';

export default { title: 'Nix/Shell/Navigation rail', parameters: { layout: 'fullscreen' } };

const WORKSPACE = 'd5555555-5555-4555-8555-555555555555';
const noop = (): void => undefined;

/** A client that never reaches a server: the rail's own reads (the pet entry) answer nothing. */
const client: NixClient = createNixClient({
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

/**
 * The rail with its Smart lists section: one pinned smart list beside the Queries control, and the
 * menu (open it from the Smart lists glyph) listing every smart list this browser has opened.
 */
function Example({
  compact = false,
  empty = false,
}: {
  readonly compact?: boolean;
  readonly empty?: boolean;
}): ReactNode {
  useKnownSmartListsStore.setState({
    known: empty
      ? {}
      : {
          [WORKSPACE]: [
            { id: 'shopping', title: 'Shopping', pinned: true },
            { id: 'overdue', title: 'Overdue', pinned: false },
          ],
        },
  });
  return (
    <ApiClientOverrideProvider client={client}>
      <MemoryRouter initialEntries={[`/w/${WORKSPACE}`]}>
        <Routes>
          <Route
            path="/w/:workspaceId"
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
                <div className="flex h-dvh">
                  <NavRail onImport={noop} compact={compact} />
                </div>
              </WorkspaceProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    </ApiClientOverrideProvider>
  );
}

export const WithQueries = { render: (): ReactNode => <Example /> };
export const CompactWithQueries = { render: (): ReactNode => <Example compact /> };
export const NoSmartListsYet = { render: (): ReactNode => <Example empty /> };
export const DarkNoSmartListsYet = { ...NoSmartListsYet, globals: { ground: 'dark' } };
export const DarkWithQueries = { ...WithQueries, globals: { ground: 'dark' } };
export const DarkCompactWithQueries = { ...CompactWithQueries, globals: { ground: 'dark' } };
