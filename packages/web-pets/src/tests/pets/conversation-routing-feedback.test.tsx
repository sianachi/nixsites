import {
  createNixClient,
  petConnectionSchema,
  petSettingsSchema,
  type PetProfile,
} from '@nix/api-client';
import { clearPetDrafts } from '@nix/web-foundation/lib/pet-drafts';
import { writeWorkspaceAccess } from '@nix/web-foundation/lib/device-preferences';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { Conversation } from '../../pets/conversation/conversation';
import type { ConversationJobs } from '../../pets/conversation/conversation-jobs';
import type { UsePetRuntimeResult } from '../../pets/use-pet-runtime';

const client = createNixClient({
  baseUrl: 'http://nix.invalid',
  tokens: {
    getAccessToken: () => Promise.resolve(null),
    refreshAccessToken: () => Promise.resolve(null),
  },
});
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));

const workspaceId = '11111111-1111-4111-8111-111111111111';
const pet: PetProfile = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Pip',
  appearance: 'cat',
  instructions: '',
  provider: 'openai',
  applyWithoutAsking: false,
};
const settings = petSettingsSchema.parse({
  enabled: true,
  activePetId: pet.id,
  profiles: [pet],
});

beforeEach(() => {
  clearPetDrafts();
  localStorage.clear();
  writeWorkspaceAccess(workspaceId, pet.id, false);
});

function setup({ autoJob = false, accepted = true, sendResult = Promise.resolve(true) } = {}) {
  const send = vi.fn(() => sendResult);
  const submit = vi.fn(() => accepted);
  const runtimeApi: UsePetRuntimeResult = {
    runtime: petConnectionSchema.parse({
      provider: 'openai',
      status: 'connected',
      reason: '',
      canConnect: false,
      messages: [],
    }),
    models: [],
    error: '',
    errorKind: null,
    busy: false,
    setRuntime: vi.fn(),
    regenerateRequestId: vi.fn(),
    send,
    interrupt: () => Promise.resolve(),
    reset: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    retryWatch: vi.fn(),
  };
  const jobs: ConversationJobs = {
    ready: true,
    busy: false,
    canSubmit: () => autoJob,
    submit,
    panel: () => null,
    timeline: [],
  };
  const show = (ready = true, connected = true) => (
    <MemoryRouter>
      <Conversation
        workspaceId={workspaceId}
        pet={pet}
        settings={settings}
        layout="floating"
        runtimeApi={{
          ...runtimeApi,
          runtime: petConnectionSchema.parse({
            ...runtimeApi.runtime,
            status: connected ? 'connected' : 'disconnected',
          }),
        }}
        jobs={{ ...jobs, ready, canSubmit: () => ready && autoJob }}
        onNeedsDecisionChange={vi.fn()}
      />
    </MemoryRouter>
  );
  const view = render(show());
  return {
    send,
    submit,
    user: userEvent.setup(),
    rerender: (ready: boolean, connected = true) => {
      view.rerender(show(ready, connected));
    },
  };
}

it('keeps a chosen job blocked when jobs become unavailable, with an explicit switch to chat', async () => {
  const { user, rerender, send, submit } = setup();
  await user.type(screen.getByRole('textbox', { name: 'Message Pip' }), 'Help with this');
  await user.click(screen.getByRole('button', { name: 'Switch to job' }));
  rerender(false);

  expect(screen.getByRole('button', { name: 'Start job' })).toBeDisabled();
  expect(screen.getByRole('status', { name: 'Message route' })).toHaveTextContent(
    'Jobs are unavailable',
  );
  expect(screen.getByRole('textbox', { name: 'Message Pip' })).toHaveValue('Help with this');
  expect(send).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Switch to chat' }));
  await user.click(screen.getByRole('button', { name: 'Send' }));
  expect(send).toHaveBeenCalledOnce();
  expect(submit).not.toHaveBeenCalled();
});

it('keeps a chosen chat blocked when chat disconnects, with an explicit switch to a job', async () => {
  const { user, rerender, send, submit } = setup({ autoJob: true });
  await user.type(screen.getByRole('textbox', { name: 'Message Pip' }), 'Make a plan');
  await user.click(screen.getByRole('button', { name: 'Switch to chat' }));
  rerender(true, false);

  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(screen.getByRole('status', { name: 'Message route' })).toHaveTextContent(
    'Chat is disconnected',
  );
  await user.click(screen.getByRole('button', { name: 'Switch to job' }));
  await user.click(screen.getByRole('button', { name: 'Start job' }));
  expect(submit).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
});

it('keeps the chosen route and draft visible while both routes are unavailable', async () => {
  const { user, rerender } = setup();
  await user.type(screen.getByRole('textbox', { name: 'Message Pip' }), 'Keep this draft');
  await user.click(screen.getByRole('button', { name: 'Switch to job' }));
  rerender(false, false);

  expect(screen.getByRole('textbox', { name: 'Message Pip' })).toHaveValue('Keep this draft');
  expect(screen.getByRole('button', { name: 'Start job' })).toBeDisabled();
  expect(screen.getByRole('status', { name: 'Message route' })).toHaveTextContent(
    'Jobs are unavailable',
  );
  rerender(true);
  expect(screen.getByRole('button', { name: 'Start job' })).toBeEnabled();
});

it('does not send a selected job to chat if the job submission refuses it', async () => {
  const { user, send, submit } = setup({ accepted: false });
  await user.type(screen.getByRole('textbox', { name: 'Message Pip' }), 'Help with this');
  await user.click(screen.getByRole('button', { name: 'Switch to job' }));
  await user.click(screen.getByRole('button', { name: 'Start job' }));

  expect(submit).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Message Pip' })).toHaveValue('Help with this');
});

it('keeps a newer draft when an earlier message is confirmed', async () => {
  let confirm: ((sent: boolean) => void) | undefined;
  const sendResult = new Promise<boolean>((resolve) => {
    confirm = resolve;
  });
  const { user } = setup({ sendResult });
  const field = screen.getByRole('textbox', { name: 'Message Pip' });
  await user.type(field, 'First message');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await user.clear(field);
  await user.type(field, 'Next message');
  await act(async () => {
    confirm?.(true);
    await sendResult;
  });
  expect(field).toHaveValue('Next message');
});
