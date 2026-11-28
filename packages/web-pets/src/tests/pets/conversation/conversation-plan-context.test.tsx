import { createNixClient, petConnectionSchema, petSettingsSchema } from '@nix/api-client';
import { clearPetDrafts } from '@nix/web-foundation/lib/pet-drafts';
import {
  readWorkspaceAccess,
  writeWorkspaceAccess,
} from '@nix/web-foundation/lib/device-preferences';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { item } from '@nix/web-foundation/testing/api-stub';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { Conversation } from '../../../pets/conversation/conversation';
import type { UsePetRuntimeResult } from '../../../pets/use-pet-runtime';

let client: ReturnType<typeof createNixClient>;
const contextReads = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));
vi.mock('../../../pets/turn-context', () => ({ buildWorkspaceMap: contextReads }));
vi.mock('../../../pets/conversation/messages/message-list', () => ({ MessageList: () => null }));
const workspaceId = '11111111-1111-4111-8111-111111111111';
const petId = '22222222-2222-4222-8222-222222222222';
const settings = petSettingsSchema.parse({
  enabled: true,
  activePetId: petId,
  profiles: [
    { id: petId, name: 'Pip', appearance: 'cat', instructions: '', provider: 'anthropic' },
  ],
});
const profile = settings.profiles[0];
if (profile === undefined) throw new Error('Fixture requires a companion');
const pet = profile;
beforeEach(() => {
  clearPetDrafts();
  localStorage.clear();
  contextReads.mockClear();
  writeWorkspaceAccess(workspaceId, petId, false);
});

function setup(initialPlanMode = true, currentItemId?: string) {
  const requests = vi.fn<(path: string, body: unknown) => void>();
  const send = vi.fn(() => Promise.resolve(true));
  client = createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
    fetch: async (input, init) => {
      const path = new URL(requestUrl(input)).pathname;
      if (currentItemId !== undefined && path === `/api/v1/items/${currentItemId}/lock`)
        return Response.json({
          locked: false,
          unlockedUntil: null,
          lockItemId: null,
          selfLocked: false,
        });
      if (currentItemId !== undefined && path === `/api/v1/items/${currentItemId}`)
        return Response.json(
          item({ id: currentItemId, workspaceId, title: 'Unrelated open note' }),
        );
      const body: unknown =
        typeof init?.body === 'string' ? await new Response(init.body).json() : undefined;
      requests(path, body);
      throw new Error('Unexpected synthetic request');
    },
  });
  const runtimeApi: UsePetRuntimeResult = {
    runtime: petConnectionSchema.parse({
      status: 'connected',
      reason: '',
      canConnect: false,
      provider: 'anthropic',
      messages: [],
    }),
    models: [],
    busy: false,
    sending: '',
    error: '',
    errorKind: null,
    send,
    setRuntime: vi.fn(),
    regenerateRequestId: vi.fn(),
    interrupt: () => Promise.resolve(),
    reset: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    retryWatch: vi.fn(),
  };
  const show = (planMode: boolean) => (
    <MemoryRouter
      initialEntries={
        currentItemId === undefined ? ['/'] : [`/?item=${currentItemId}&chat=workspace`]
      }
    >
      <Conversation
        workspaceId={workspaceId}
        pet={pet}
        settings={settings}
        runtimeApi={runtimeApi}
        layout="floating"
        onNeedsDecisionChange={vi.fn()}
        jobs={{
          ready: true,
          busy: false,
          ...(planMode ? { consentMode: 'plan' } : {}),
          canSubmit: () => false,
          submit: () => false,
          panel: () => null,
          timeline: [],
        }}
      />
    </MemoryRouter>
  );
  const view = render(show(initialPlanMode));
  return {
    send,
    requests,
    user: userEvent.setup(),
    rerenderMode: (planMode: boolean) => {
      view.rerender(show(planMode));
    },
  };
}

it('defaults new-plan chat to current-workspace context after availability resolves, despite the old device preference', async () => {
  const { user, send, requests, rerenderMode } = setup(false);
  const input = screen.getByRole('textbox', { name: 'Message Pip' });
  await user.type(input, 'Help me prepare the next steps.');
  rerenderMode(true);
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => {
    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceAccess: true, consentMode: 'plan' }),
    );
  });
  expect(requests).not.toHaveBeenCalled();
  expect(contextReads).toHaveBeenCalledTimes(1);
  expect(readWorkspaceAccess(workspaceId, petId)).toBe(false);
});

it('preserves an explicit message-only choice when new-plan availability changes', async () => {
  const { user, send, requests, rerenderMode } = setup();
  await user.click(screen.getByRole('button', { name: 'Remove Workspace' }));
  rerenderMode(false);
  rerenderMode(true);
  const input = screen.getByRole('textbox', { name: 'Message Pip' });
  await user.type(input, 'Only this message.');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => {
    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceAccess: false, consentMode: 'plan' }),
    );
  });
  expect(requests).not.toHaveBeenCalled();
  expect(contextReads).not.toHaveBeenCalled();
});

it('keeps the workspace default when an unrelated item is open in the same pane', async () => {
  const { user, send } = setup(true, '44444444-4444-4444-8444-444444444444');
  await user.type(
    screen.getByRole('textbox', { name: 'Message Pip' }),
    'Plan changes across this workspace.',
  );
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => {
    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceAccess: true, consentMode: 'plan' }),
    );
  });
});

it('sends with workspace context when a page is attached with workspace context on', async () => {
  const sourceId = '44444444-4444-4444-8444-444444444444';
  const { user, send } = setup(true, sourceId);
  await user.click(screen.getByRole('button', { name: 'Add to message' }));
  await user.click(screen.getByRole('menuitem', { name: 'Add this page' }));
  await user.type(screen.getByRole('textbox', { name: 'Message Pip' }), 'Use this selected page.');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => {
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ workspaceAccess: true }));
  });
});
