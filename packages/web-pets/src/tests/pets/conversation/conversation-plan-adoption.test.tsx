import { createNixClient, petConnectionSchema, petSettingsSchema } from '@nix/api-client';
import { clearPetDrafts } from '@nix/web-foundation/lib/pet-drafts';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { Conversation } from '../../../pets/conversation/conversation';
import type { UsePetRuntimeResult } from '../../../pets/use-pet-runtime';

const client = createNixClient({
  baseUrl: 'http://nix.invalid',
  tokens: {
    getAccessToken: () => Promise.resolve(null),
    refreshAccessToken: () => Promise.resolve(null),
  },
});
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));
vi.mock('../../../pets/conversation/messages/message-list', () => ({ MessageList: () => null }));
const workspaceId = '11111111-1111-4111-8111-111111111111';
const sourceId = '44444444-4444-4444-8444-444444444444';
const petId = '22222222-2222-4222-8222-222222222222';
const turnId = '33333333-3333-4333-8333-333333333333';
const settings = petSettingsSchema.parse({
  enabled: true,
  activePetId: petId,
  profiles: [
    { id: petId, name: 'Pip', appearance: 'cat', instructions: '', provider: 'anthropic' },
  ],
});
const pet = settings.profiles[0];
if (pet === undefined) throw new Error('Fixture requires a companion');
beforeEach(() => {
  clearPetDrafts();
  localStorage.clear();
});

const cases: readonly {
  readonly label: string;
  readonly ready: boolean;
  readonly requiresReadDecision: boolean | undefined;
  readonly scope: { readonly rootItemId: string | null; readonly readOnly: boolean } | null;
  readonly adopts: boolean;
  readonly currentReadOnly?: boolean;
}[] = [
  {
    label: 'incomplete note batch',
    ready: false,
    requiresReadDecision: false,
    scope: { rootItemId: sourceId, readOnly: false },
    adopts: false,
  },
  {
    label: 'complete note batch',
    ready: true,
    requiresReadDecision: false,
    scope: { rootItemId: sourceId, readOnly: false },
    adopts: true,
  },
  {
    label: 'complete workspace batch',
    ready: true,
    requiresReadDecision: false,
    scope: { rootItemId: null, readOnly: false },
    adopts: true,
  },
  {
    label: 'missing stored scope',
    ready: true,
    requiresReadDecision: false,
    scope: null,
    adopts: false,
  },
  {
    label: 'stored read-only scope',
    ready: true,
    requiresReadDecision: false,
    scope: { rootItemId: sourceId, readOnly: true },
    adopts: true,
  },
  {
    label: 'missing read decision descriptor',
    ready: true,
    requiresReadDecision: undefined,
    scope: { rootItemId: sourceId, readOnly: false },
    adopts: false,
  },
  {
    label: 'read batch awaiting a durable read decision',
    ready: true,
    requiresReadDecision: true,
    scope: { rootItemId: sourceId, readOnly: false },
    adopts: true,
  },
  {
    label: 'discovery-only read-only note conversation',
    ready: true,
    requiresReadDecision: true,
    scope: { rootItemId: sourceId, readOnly: true },
    currentReadOnly: true,
    adopts: true,
  },
  {
    label: 'writable original scope in a current read-only pane',
    ready: true,
    requiresReadDecision: false,
    scope: { rootItemId: sourceId, readOnly: false },
    currentReadOnly: true,
    adopts: false,
  },
];
it.each(cases)(
  'adopts only a complete stored tool batch with the authoritative scope after reload: $label',
  async ({ ready, scope, adopts, requiresReadDecision, currentReadOnly }) => {
    const adoptTools = vi.fn();
    const send = vi.fn(() => Promise.resolve(true));
    const runtimeApi: UsePetRuntimeResult = {
      runtime: {
        ...petConnectionSchema.parse({
          status: 'connected',
          reason: '',
          canConnect: false,
          provider: 'anthropic',
          messages: [{ id: 'confirmed-message', role: 'user', text: 'Prepare the two changes.' }],
        }),
        conversationId: 'server-scoped-conversation',
        turnId,
        plannedBatch: {
          turnId,
          conversationId: 'server-scoped-conversation',
          toolIds: ['stored-call-one', 'stored-call-two'],
          ready,
          requiresReadDecision,
          sourceScope: { kind: 'selected', itemIds: [sourceId] },
          scope,
        },
      },
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
    render(
      <MemoryRouter>
        <Conversation
          workspaceId={workspaceId}
          pet={pet}
          settings={settings}
          runtimeApi={runtimeApi}
          layout="floating"
          onNeedsDecisionChange={vi.fn()}
          {...(currentReadOnly
            ? {
                noteScope: {
                  rootItemId: sourceId,
                  title: 'Source note',
                  readOnly: true,
                  onReadOnlyChange: vi.fn(),
                },
              }
            : {})}
          jobs={{
            ready: true,
            busy: false,
            consentMode: 'plan',
            canSubmit: () => false,
            submit: () => false,
            panel: () => null,
            timeline: [],
            adoptTools,
          }}
        />
      </MemoryRouter>,
    );
    if (adopts) {
      await waitFor(() => {
        expect(adoptTools).toHaveBeenCalledTimes(1);
      });
      expect(adoptTools).toHaveBeenCalledWith({
        conversationId: 'server-scoped-conversation',
        turnId,
        toolIds: ['stored-call-one', 'stored-call-two'],
        sourceScope: { kind: 'selected', itemIds: [sourceId] },
        brief: 'Prepare the two changes.',
        afterMessageId: 'confirmed-message',
        rootItemId: scope?.rootItemId,
        readOnly: scope?.readOnly,
      });
    } else expect(adoptTools).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  },
);
