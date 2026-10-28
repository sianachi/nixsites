import { createNixClient, type NixClient } from '@nix/api-client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { z } from 'zod';
import { Button } from '@nix/ui';
import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import {
  AccessibleWorkspacesProvider,
  WorkspaceProvider,
} from '@nix/web-workspaces/workspaces/workspace-context';
import { NewChatNote } from '../../../views/chat/new-chat-note';
import { item, STUB_WORKSPACE } from '../../api-stub';

const id = '11111111-1111-4111-8111-111111111111';
const groupId = '22222222-2222-4222-8222-222222222222';
const parentId = '33333333-3333-4333-8333-333333333333';
const other = { ...STUB_WORKSPACE, id: '44444444-4444-4444-8444-444444444444', name: 'Projects' };
const noop = () => undefined;

function setup({
  currentId = STUB_WORKSPACE.id,
  sources = [STUB_WORKSPACE.id],
  initialPrompt = '',
  firstPromptFails = false,
  existingItemId,
  rememberedParent = false,
  unavailableParent = false,
}: {
  currentId?: string | null;
  sources?: string[];
  initialPrompt?: string;
  firstPromptFails?: boolean;
  existingItemId?: string;
  rememberedParent?: boolean;
  unavailableParent?: boolean;
} = {}) {
  const user = userEvent.setup();
  const calls: { operation: string; path: string; body: unknown }[] = [];
  const requests: string[] = [];
  const closed = vi.fn();
  const base = createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
  const client: NixClient = {
    ...base,
    query: (endpoint) => {
      if (endpoint.path.includes(`/items/${parentId}`)) {
        return unavailableParent
          ? Promise.reject(new Error('Not accessible'))
          : Promise.resolve(
              endpoint.schema.parse(
                item({ id: parentId, title: 'Research notes', workspaceId: other.id }),
              ),
            );
      }
      return Promise.resolve(
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
            : {
                revision: 0,
                groups: rememberedParent
                  ? [
                      {
                        id: groupId,
                        name: 'Research',
                        workspaceIds: sources,
                        lastDestinationWorkspaceId: other.id,
                        lastDestinationParentId: parentId,
                      },
                    ]
                  : [],
                pinnedWorkspaceIds: [],
              },
        ),
      );
    },
    paginate: async function* (endpoint) {
      if (endpoint.operation === 'workspaces.list') {
        for (const workspace of [STUB_WORKSPACE, other])
          yield await Promise.resolve(endpoint.itemSchema.parse(workspace));
      } else if (endpoint.path.includes(other.id)) {
        yield await Promise.resolve(
          endpoint.itemSchema.parse(
            item({ id: parentId, title: 'Research notes', workspaceId: other.id }),
          ),
        );
      }
    },
    execute: (endpoint) => {
      calls.push({ operation: endpoint.operation, path: endpoint.path, body: endpoint.body });
      const chat = {
        itemId: id,
        workspaceId: endpoint.path.includes(other.id) ? other.id : STUB_WORKSPACE.id,
        title: 'New chat',
        sourceWorkspaceIds: sources,
        petId: id,
        revision: 1,
        canSend: true,
        canEdit: true,
        turn: null,
      };
      if (endpoint.operation === 'conversations.send') {
        requests.push(z.object({ requestId: z.uuid() }).parse(endpoint.body).requestId);
        if (firstPromptFails && requests.length === 1)
          return Promise.reject(new Error('Response lost'));
      }
      return Promise.resolve(endpoint.schema.parse(chat));
    },
  };
  function Launcher() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button
          onClick={() => {
            setOpen(true);
          }}
        >
          Add chat
        </Button>
        {open ? (
          <NewChatNote
            sourceWorkspaceIds={sources}
            {...(rememberedParent ? { groupId } : {})}
            initialPrompt={initialPrompt}
            {...(existingItemId ? { existingItemId } : {})}
            onClose={() => {
              closed();
              setOpen(false);
            }}
          />
        ) : null}
      </>
    );
  }
  render(
    <ApiClientOverrideProvider client={client}>
      <MemoryRouter initialEntries={[currentId ? `/w/${currentId}` : '/workspaces/groups']}>
        <Routes>
          {currentId ? (
            <Route
              path="/w/:workspaceId"
              element={
                <WorkspaceProvider
                  state={{
                    status: 'ready',
                    workspaces: [STUB_WORKSPACE, other],
                    error: null,
                    reload: noop,
                    workspaceCreated: noop,
                    workspaceUpdated: noop,
                    workspaceRemoved: noop,
                  }}
                >
                  <Launcher />
                </WorkspaceProvider>
              }
            />
          ) : (
            <Route element={<AccessibleWorkspacesProvider />}>
              <Route path="*" element={<Launcher />} />
            </Route>
          )}
        </Routes>
      </MemoryRouter>
    </ApiClientOverrideProvider>,
  );
  return {
    user,
    calls,
    requests,
    closed,
    open: async () => {
      await user.click(screen.getByRole('button', { name: 'Add chat' }));
      await screen.findByRole('option', { name: 'Owl' });
    },
  };
}

async function confirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole('checkbox', { name: 'I confirm this destination and its sharing' }),
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('new chat notes', () => {
  it('opens a dialog and defaults to the current workspace independently of the sources', async () => {
    const { user, calls, open } = setup({ currentId: other.id });
    await open();
    expect(screen.getByRole('dialog', { name: 'New chat' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Chat title' })).toHaveFocus();
    expect(screen.getByText('Projects (this workspace)')).toBeVisible();
    expect(
      screen.queryByRole('combobox', { name: 'Destination workspace' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: STUB_WORKSPACE.name })).not.toBeInTheDocument();
    await confirm(user);
    await user.click(screen.getByRole('button', { name: 'Create chat note' }));
    expect(calls[0]).toMatchObject({
      operation: 'conversations.create',
      path: `/api/v1/workspaces/${other.id}/conversations`,
      body: { parentId: null, sourceWorkspaceIds: [STUB_WORKSPACE.id] },
    });
  });

  it('lets the user choose another workspace and parent note', async () => {
    const { user, calls, open } = setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'Somewhere else…' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Destination workspace' }),
      other.id,
    );
    await screen.findByRole('option', { name: 'Research notes' });
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Destination parent note' }),
      parentId,
    );
    await screen.findByText('Research notes · Projects');
    await confirm(user);
    await user.click(screen.getByRole('button', { name: 'Create chat note' }));
    expect(calls[0]).toMatchObject({
      path: `/api/v1/workspaces/${other.id}/conversations`,
      body: { parentId },
    });
  });

  it('collapses sources into a summary, supports searching and rechecks consent after changes', async () => {
    const { user, open } = setup({ sources: [STUB_WORKSPACE.id, other.id] });
    await open();
    await confirm(user);
    await user.click(screen.getByRole('button', { name: 'Sources: 2 workspaces' }));
    await user.type(screen.getByRole('searchbox', { name: 'Find a source workspace' }), 'Projects');
    expect(screen.queryByRole('checkbox', { name: STUB_WORKSPACE.name })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Projects' }));
    expect(screen.getByRole('button', { name: `Sources: ${STUB_WORKSPACE.name}` })).toBeVisible();
    expect(
      screen.getByRole('checkbox', { name: 'I confirm this destination and its sharing' }),
    ).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Create chat note' })).toBeDisabled();
    await user.clear(screen.getByRole('searchbox', { name: 'Find a source workspace' }));
    expect(screen.getByRole('checkbox', { name: STUB_WORKSPACE.name })).toBeChecked();
  });

  it('returns focus to the launcher when the dialog is dismissed', async () => {
    const { closed, open } = setup();
    await open();
    fireEvent(
      screen.getByRole('dialog', { name: 'New chat' }),
      new Event('cancel', { cancelable: true }),
    );
    expect(closed).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add chat' })).toHaveFocus());
  });

  it('requires explicit removal of an unavailable source', async () => {
    const { user, calls, open } = setup({ sources: [STUB_WORKSPACE.id, parentId] });
    await open();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'source workspaces are no longer available',
    );
    await confirm(user);
    expect(screen.getByRole('button', { name: 'Create chat note' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Remove unavailable sources' }));
    await confirm(user);
    await user.click(screen.getByRole('button', { name: 'Create chat note' }));
    expect(calls[0]?.body).toMatchObject({ sourceWorkspaceIds: [STUB_WORKSPACE.id] });
  });

  it('revalidates a remembered group parent when there is no current workspace', async () => {
    const { user, calls, open } = setup({ currentId: null, rememberedParent: true });
    await open();
    await screen.findByText('Research notes · Projects');
    await confirm(user);
    await user.click(screen.getByRole('button', { name: 'Create chat note' }));
    expect(calls[0]).toMatchObject({
      path: `/api/v1/workspaces/${other.id}/conversations`,
      body: { parentId },
    });
  });

  it('keeps an inaccessible remembered parent from creating a chat', async () => {
    const { user, calls, open } = setup({
      currentId: null,
      rememberedParent: true,
      unavailableParent: true,
    });
    await open();
    expect(await screen.findByRole('alert')).toHaveTextContent('destination note is unavailable');
    await confirm(user);
    expect(screen.getByRole('button', { name: 'Create chat note' })).toBeDisabled();
    expect(calls).toEqual([]);
  });

  it('retries the first prompt in the saved conversation with the same request identity', async () => {
    const { user, calls, requests, open } = setup({
      initialPrompt: 'Compare priorities',
      firstPromptFails: true,
    });
    await open();
    await confirm(user);
    await user.click(screen.getByRole('button', { name: 'Create chat note' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The chat was saved');
    await user.click(screen.getByRole('button', { name: 'Retry first message' }));
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(calls.filter((call) => call.operation === 'conversations.create')).toHaveLength(1);
    expect(requests[0]).toBe(requests[1]);
  });

  it('configures an existing note without offering a replacement destination', async () => {
    const { user, calls, open } = setup({ existingItemId: id });
    await open();
    expect(screen.getByRole('dialog', { name: 'Set up this chat view' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Somewhere else…' })).not.toBeInTheDocument();
    await confirm(user);
    await user.click(screen.getByRole('button', { name: 'Set up chat' }));
    expect(calls.map((call) => call.operation)).toEqual(['conversations.configure']);
    expect(calls[0]?.path).toBe(`/api/v1/conversations/${id}/configure`);
  });
});
