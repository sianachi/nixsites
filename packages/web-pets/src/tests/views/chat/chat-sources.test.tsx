import { createNixClient, type NixClient } from '@nix/api-client';
import { UndoProvider } from '@nix/ui';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { ChatView } from '../../../pets/chat/chat-view';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const secondWorkspace = '22222222-2222-4222-8222-222222222222';
const petId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
let client: NixClient;
vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => client,
  useOptionalApiClient: () => client,
}));
vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useAccessibleWorkspaces: () => ({
    workspaces: [
      { id: workspaceId, name: 'Research', lifecycleState: 'active' },
      { id: secondWorkspace, name: 'Planning', lifecycleState: 'active' },
    ],
  }),
}));

function setup() {
  let chat = {
    itemId,
    workspaceId,
    title: 'Workspace comparison',
    sourceWorkspaceIds: [workspaceId, secondWorkspace],
    petId,
    revision: 1,
    canSend: true,
    canEdit: true,
    turn: null,
  };
  const calls: { path: string; body: unknown }[] = [];
  client = createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
    fetch: async (input, init) => {
      const path = new URL(requestUrl(input)).pathname;
      if (init?.method === 'POST' || init?.method === 'PUT') {
        const body: unknown =
          typeof init.body === 'string' ? await new Response(init.body).json() : undefined;
        calls.push({ path, body });
        if (
          path.endsWith('/sources') &&
          typeof body === 'object' &&
          body !== null &&
          'sourceWorkspaceIds' in body &&
          Array.isArray(body.sourceWorkspaceIds)
        )
          chat = {
            ...chat,
            revision: chat.revision + 1,
            sourceWorkspaceIds: body.sourceWorkspaceIds.filter(
              (id): id is string => typeof id === 'string',
            ),
          };
        return Response.json(chat);
      }
      if (path.endsWith('/messages'))
        return Response.json({
          items: [
            {
              id: '55555555-5555-4555-8555-555555555555',
              role: 'assistant',
              text: 'Keep this existing analysis.',
              seq: '1',
              createdAt: '2026-11-25T12:00:00Z',
              authorId: null,
            },
          ],
          nextCursor: null,
        });
      return Response.json(chat);
    },
  });
  render(
    <MemoryRouter>
      <UndoProvider>
        <ChatView itemId={itemId} workspaceId={workspaceId} />
      </UndoProvider>
    </MemoryRouter>,
  );
  return { calls, user: userEvent.setup() };
}

it('sends a saved read-only analysis turn without a sharing prompt, also after the sources change', async () => {
  const { calls, user } = setup();
  const draft = await screen.findByRole('textbox', { name: 'Message' });
  await user.type(draft, 'First question');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => {
    expect(calls.filter((call) => call.path.endsWith('/turns'))).toHaveLength(1);
  });
  expect(screen.queryByRole('region', { name: 'Share context with the companion' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Change sources' }));
  await user.click(screen.getByRole('checkbox', { name: 'Planning' }));
  await user.click(screen.getByRole('button', { name: 'Apply sources' }));
  await user.type(draft, 'Question from Research only');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => {
    expect(calls.filter((call) => call.path.endsWith('/turns'))).toHaveLength(2);
  });
});
