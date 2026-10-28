import { createNixClient, type NixClient, type Workspace } from '@nix/api-client';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactNode } from 'react';
import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { AccessibleWorkspacesProvider } from '@nix/web-workspaces/workspaces/workspace-context';
import { ChatView } from './chat-view';

export default { title: 'Nix/Views/Chat', parameters: { layout: 'fullscreen' } };
const id = '11111111-1111-4111-8111-111111111111';
const workspace: Workspace = {
  id,
  name: 'Research',
  versionRetentionDays: 90,
  storageQuotaBytes: 0,
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
function Example({
  reader = false,
  streaming = false,
  message = 'Research and planning share a priority: test the next release with a small group before rollout.',
}: {
  readonly reader?: boolean;
  /** A reply still being written, beside the saved messages. */
  readonly streaming?: boolean;
  readonly message?: string;
}): ReactNode {
  const base = createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
  const client: NixClient = {
    ...base,
    query: (endpoint) =>
      Promise.resolve(
        endpoint.schema.parse(
          endpoint.operation === 'conversations.messages'
            ? {
                items: [
                  {
                    id,
                    role: 'assistant',
                    text: message,
                    seq: '1',
                    createdAt: '2026-01-01T00:00:00Z',
                    authorId: null,
                  },
                ],
                nextCursor: null,
              }
            : {
                itemId: id,
                workspaceId: id,
                title: 'Shared priorities',
                sourceWorkspaceIds: [id],
                petId: id,
                revision: 1,
                canSend: !reader,
                canEdit: !reader,
                turn: streaming
                  ? { id, requestId: id, status: 'running', error: null, text: 'Drafting the plan' }
                  : null,
              },
        ),
      ),
    paginate: async function* (endpoint) {
      yield await Promise.resolve(endpoint.itemSchema.parse(workspace));
    },
  };
  return (
    <ApiClientOverrideProvider client={client}>
      <MemoryRouter>
        <Routes>
          <Route element={<AccessibleWorkspacesProvider />}>
            <Route
              path="*"
              element={
                <main className="flex h-dvh flex-col p-4">
                  <h1 className="sr-only">Shared priorities</h1>
                  <ChatView itemId={id} workspaceId={id} />
                </main>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </ApiClientOverrideProvider>
  );
}
export const Editor = { render: (): ReactNode => <Example /> };
export const Reader = { render: (): ReactNode => <Example reader /> };
export const Streaming = { render: (): ReactNode => <Example streaming /> };
export const Dark = { ...Editor, globals: { ground: 'dark' } };

export const LongReply = {
  render: (): ReactNode => <Example message={'a'.repeat(6000) + ' Final conclusion.'} />,
};
