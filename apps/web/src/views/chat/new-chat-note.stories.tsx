import { createNixClient, type NixClient, type Workspace } from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { waitFor, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ApiClientOverrideProvider } from '../../api/api-client-provider';
import { WorkspaceProvider } from '../../workspaces/workspace-context';
import { NewChatNote } from './new-chat-note';

export default { title: 'Nix/Views/New chat note', parameters: { layout: 'fullscreen' } };

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
const workspaces = [
  workspace,
  ...Array.from({ length: 19 }, (_, index) => ({
    ...workspace,
    id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
    name: `Project ${String(index + 1)}`,
  })),
];
const noop = (): void => undefined;
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
        endpoint.operation === 'pets.settings'
          ? {
              revision: 1,
              settings: {
                enabled: true,
                activePetId: id,
                motion: 'system',
                profiles: [
                  {
                    id,
                    name: 'Owl',
                    appearance: 'owl',
                    personality: 'calm',
                    responseLength: 'balanced',
                    instructions: '',
                  },
                ],
              },
            }
          : { revision: 0, groups: [], pinnedWorkspaceIds: [] },
      ),
    ),
  paginate: async function* (endpoint) {
    if (endpoint.operation === 'workspaces.list')
      for (const entry of workspaces) yield await Promise.resolve(endpoint.itemSchema.parse(entry));
  },
  execute: (endpoint) =>
    Promise.resolve(
      endpoint.schema.parse({
        itemId: id,
        workspaceId: id,
        title: 'New chat',
        sourceWorkspaceIds: [id],
        petId: id,
        revision: 1,
        canSend: true,
        canEdit: true,
        turn: null,
      }),
    ),
};

function Launcher({ multiple = false }: { readonly multiple?: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <main className="p-4">
      <Text as="h1" variant="h1">
        Research notes
      </Text>
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        New chat
      </Button>
      {open ? (
        <NewChatNote
          sourceWorkspaceIds={multiple ? workspaces.map((entry) => entry.id) : [id]}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </main>
  );
}

function Example({ multiple = false }: { readonly multiple?: boolean }): ReactNode {
  return (
    <ApiClientOverrideProvider client={client}>
      <MemoryRouter initialEntries={[`/w/${id}`]}>
        <Routes>
          <Route
            path="/w/:workspaceId"
            element={
              <WorkspaceProvider
                state={{
                  status: 'ready',
                  workspaces,
                  error: null,
                  reload: noop,
                  workspaceCreated: noop,
                  workspaceUpdated: noop,
                  workspaceRemoved: noop,
                }}
              >
                <Launcher multiple={multiple} />
              </WorkspaceProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    </ApiClientOverrideProvider>
  );
}

async function openDialog(): Promise<void> {
  await userEvent.click(within(document.body).getByRole('button', { name: 'New chat' }));
  await within(document.body).findByRole('option', { name: 'Owl' });
}

export const CurrentWorkspace = {
  render: (): ReactNode => <Example />,
  play: openDialog,
};
export const Dark = { ...CurrentWorkspace, globals: { ground: 'dark' } };
export const Phone = {
  ...CurrentWorkspace,
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
export const Sources = {
  render: (): ReactNode => <Example multiple />,
  play: async (): Promise<void> => {
    await openDialog();
    const body = within(document.body);
    await userEvent.click(body.getByRole('button', { name: 'Sources: 20 workspaces' }));
    await userEvent.type(body.getByRole('searchbox'), 'Project 19');
    if (!body.getByRole<HTMLInputElement>('checkbox', { name: 'Project 19' }).checked)
      throw new Error('Searching must preserve selected sources.');
    if (body.queryByRole('checkbox', { name: 'Research' }))
      throw new Error('Only matching source workspaces should be shown.');
  },
};
export const SomewhereElse = {
  ...CurrentWorkspace,
  play: async (): Promise<void> => {
    await openDialog();
    await userEvent.click(within(document.body).getByRole('button', { name: 'Somewhere else…' }));
    await within(document.body).findByRole('combobox', { name: 'Destination parent note' });
  },
};
export const Keyboard = {
  ...CurrentWorkspace,
  play: async (): Promise<void> => {
    await openDialog();
    const body = within(document.body);
    if (document.activeElement !== body.getByRole('textbox', { name: 'Chat title' }))
      throw new Error('The title must receive initial focus.');
    // Synthetic key events cannot invoke the browser's native dialog cancellation.
    body.getByRole('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
    await waitFor(() => {
      if (document.activeElement !== body.getByRole('button', { name: 'New chat' }))
        throw new Error('Closing must restore focus to the trigger.');
    });
    await openDialog();
    await userEvent.click(
      body.getByRole('checkbox', { name: 'I confirm this destination and its sharing' }),
    );
    await userEvent.click(body.getByRole('button', { name: 'Create chat note' }));
    await waitFor(() => {
      if (body.queryByRole('dialog')) throw new Error('Saving must close the dialog.');
    });
  },
};
