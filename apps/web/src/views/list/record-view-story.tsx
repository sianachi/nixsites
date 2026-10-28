import {
  createNixClient,
  type NixClient,
  type QueryEndpoint,
  type Workspace,
} from '@nix/api-client';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';

import { ApiClientOverrideProvider } from '../../api/api-client-provider';
import { WorkspaceProvider } from '../../workspaces/workspace-context';
import type { View } from '../core/container-model';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
export const STORY_FILE = '22222222-2222-4222-8222-222222222222';
const version = {
  id: '33333333-3333-4333-8333-333333333333',
  version: 1,
  fileName: 'Reading list.txt',
  mediaType: 'text/plain',
  byteLength: 4096,
  sha256: '1'.repeat(64),
  previewable: false,
  pixelWidth: null,
  pixelHeight: null,
  thumbnail: null,
  createdAt: '2026-01-01T00:00:00Z',
  current: true,
};
const client = {
  ...createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  }),
  query<T>(endpoint: QueryEndpoint<T>): Promise<T> {
    if (endpoint.operation === 'files.get') {
      return Promise.resolve(
        endpoint.schema.parse({
          itemId: STORY_FILE,
          workspaceId: WORKSPACE,
          current: version,
          versions: [version],
        }),
      );
    }
    return Promise.reject(new Error(`No story data for ${endpoint.operation}`));
  },
  async *paginate<T>(): AsyncGenerator<T, void, undefined> {
    await Promise.resolve();
    yield* [];
  },
} satisfies NixClient;
const workspace: Workspace = {
  id: WORKSPACE,
  name: 'Personal',
  versionRetentionDays: 90,
  storageQuotaBytes: '10737418240',
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

export function RecordViewStory({ children }: { readonly children: ReactNode }): ReactNode {
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
                  reload: () => undefined,
                  workspaceCreated: () => undefined,
                  workspaceUpdated: () => undefined,
                  workspaceRemoved: () => undefined,
                }}
              >
                {children}
              </WorkspaceProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    </ApiClientOverrideProvider>
  );
}

export function recordStoryView(kind: string, overrides: Partial<View> = {}): View {
  return {
    id: kind,
    name: 'Plans',
    kind,
    columns: [],
    groupBy: null,
    groupOrder: [],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    endDateProperty: null,
    cardSize: null,
    layout: null,
    filters: [],
    ...overrides,
  };
}
