import { createNixClient, petConnectionSchema } from '@nix/api-client';
import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useTurns } from '../../../pets/conversation/state/use-turns';
import type { UsePetRuntimeResult } from '../../../pets/use-pet-runtime';

function setup({ sent = true } = {}) {
  const reads = vi.fn(() => Promise.resolve(Response.json({ items: [], nextCursor: null })));
  const send = vi.fn(() => Promise.resolve(sent));
  const setDraft = vi.fn();
  const onSent = vi.fn();
  const client = createNixClient({
    baseUrl: 'http://nix.invalid',
    fetch: reads,
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
  const runtimeApi: UsePetRuntimeResult = {
    runtime: petConnectionSchema.parse({
      status: 'connected',
      reason: '',
      canConnect: false,
      messages: [],
    }),
    models: [],
    error: '',
    errorKind: null,
    busy: false,
    sending: '',
    setRuntime: vi.fn(),
    regenerateRequestId: vi.fn(),
    send,
    interrupt: () => Promise.resolve(),
    reset: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    retryWatch: vi.fn(),
  };
  const input = {
    client,
    workspaceId: '8d849a57-bd08-487d-af5b-e0f69ac836a4',
    runtimeApi,
    petName: 'Owl',
    draft: 'Read the release notes.',
    setDraft,
    model: '',
    workspaceAccess: true,
    hasNoteScope: false,
    messages: [],
    contextFields: () => ({}),
    onSent,
  };
  const { result } = renderHook(() => useTurns(input));
  return { result, reads, send, setDraft, onSent };
}

it('keeps the edited message open when replacement is not accepted', async () => {
  const { result, send, onSent } = setup({ sent: false });
  await act(() => result.current.resendTurn('Preserve this edited message.', 'previous-message'));
  expect(onSent).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
});

it('does not consume an external creation request until the message starts successfully', async () => {
  const { result, send } = setup({ sent: false });
  const onStarted = vi.fn();
  await act(() => result.current.submit('Create the launch tracker.', onStarted));
  expect(send).toHaveBeenCalledTimes(1);
  expect(onStarted).not.toHaveBeenCalled();
});
