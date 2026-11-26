import { createNixClient } from '@nix/api-client';
import { Button } from '@nix/ui';
import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { usePetDialogJobs } from '../../panel/pet-runs-section';

const workspaceId = '8d849a57-bd08-487d-af5b-e0f69ac836a4';
const petId = '77fa1d13-ce45-47d4-bd7c-51a4dd47e4ab';
const planRoute = `/api/v1/workspaces/${workspaceId}/pet-plans`;
const brief = 'Rename the brief and add the launch checklist.';

function setup({
  refuse = false,
  sharing = false,
  adoptionRoot = null,
  currentItemId = null,
  readOnly = false,
  adoptionReadOnly = false,
  planAnchorItemId,
}: {
  readonly refuse?: boolean;
  readonly sharing?: boolean;
  readonly adoptionRoot?: string | null;
  readonly currentItemId?: string | null;
  readonly readOnly?: boolean;
  readonly adoptionReadOnly?: boolean;
  readonly planAnchorItemId?: string | null;
} = {}) {
  const calls: { readonly path: string; readonly body: unknown }[] = [];
  const onStarted = vi.fn();
  const focusComposer = vi.fn();
  const client = createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
    fetch: async (input, init) => {
      const path = new URL(requestUrl(input)).pathname;
      if (init?.method === 'POST') {
        const body: unknown =
          typeof init.body === 'string' ? await new Response(init.body).json() : undefined;
        calls.push({ path, body });
        if (refuse)
          return Response.json(
            { code: 'pet_plans.invalid', title: 'Plan could not start' },
            { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
          );
        return Response.json({
          id: '49b80577-9ad4-46aa-ad2c-5988fda36abf',
          workspaceId,
          anchorItemId: null,
          petId,
          brief,
          sourceScope: { kind: 'workspace' },
          status: 'waiting_for_input',
          revision: 1,
          sharingQuestion:
            sharing && !path.endsWith('/sharing/decision')
              ? {
                  decisionNonce: '11111111-1111-4111-8111-111111111111',
                  scopeDigest: 'scope-one',
                  recipientRevision: 'recipient-one',
                  sourceScope: { kind: 'workspace' },
                  recipient: {
                    provider: 'Claude',
                    destination: 'https://api.anthropic.com',
                    routingPolicy: 'Direct',
                    connectionRevision: 'connection-one',
                  },
                  message: 'May I share the current readable workspace with Claude?',
                }
              : null,
          question: null,
          plan: null,
          results: [],
          afterMessageId: 'confirmed-message',
          createdAt: '2026-11-25T12:00:00Z',
          updatedAt: '2026-11-25T12:00:00Z',
        });
      }
      return Response.json({ enabled: true, abilities: [], runs: [] });
    },
  });

  function Conversation() {
    const input = {
      workspaceId,
      petId,
      itemId: currentItemId,
      readOnly,
      ...(planAnchorItemId === undefined ? {} : { planAnchorItemId }),
    };
    const jobs = usePetDialogJobs(input);
    const message = {
      text: brief,
      afterMessageId: 'confirmed-message',
      onStarted,
      focusComposer,
    };
    return (
      <>
        <Button disabled={!jobs.ready} onClick={() => jobs.submit(message, true)}>
          Prepare plan
        </Button>
        <Button
          disabled={!jobs.ready}
          onClick={() =>
            jobs.adoptTools?.({
              conversationId: 'stored-conversation',
              turnId: '7d849a57-bd08-487d-af5b-e0f69ac836a4',
              toolIds: ['stored-first', 'stored-second'],
              sourceScope: { kind: 'workspace' },
              brief,
              rootItemId: adoptionRoot,
              readOnly: adoptionReadOnly,
            })
          }
        >
          Review stored batch
        </Button>
        {jobs.panel(message)}
        {jobs.timeline.map((entry) => (
          <div key={entry.id}>{entry.content}</div>
        ))}
      </>
    );
  }

  render(
    <ApiClientOverrideProvider client={client}>
      <Conversation />
    </ApiClientOverrideProvider>,
  );
  return { calls, onStarted, focusComposer, user: userEvent.setup() };
}

it('prepares a workspace plan without choosing an unrelated item and preserves the timeline anchor', async () => {
  const { calls, onStarted, user } = setup();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare plan' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Prepare plan' }));

  await waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  expect(calls[0]).toMatchObject({
    path: planRoute,
    body: {
      petId,
      brief,
      anchorItemId: null,
      sourceScope: { kind: 'workspace' },
      afterMessageId: 'confirmed-message',
      requestId: z.object({ requestId: z.uuid() }).parse(calls[0]?.body).requestId,
    },
  });
  expect(screen.queryByRole('searchbox', { name: 'Find a target' })).not.toBeInTheDocument();
  await waitFor(() => {
    expect(onStarted).toHaveBeenCalledTimes(1);
  });
});

it.each([null, '5d849a57-bd08-487d-af5b-e0f69ac836a4'])(
  'anchors adoption to the stored turn root %s instead of the current pane',
  async (adoptionRoot) => {
    const { calls, user } = setup({
      adoptionRoot,
      currentItemId: '6d849a57-bd08-487d-af5b-e0f69ac836a4',
    });
    const action = screen.getByRole('button', { name: 'Review stored batch' });
    await waitFor(() => {
      expect(action).toBeEnabled();
    });
    await user.click(action);
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.body).toMatchObject({
      anchorItemId: adoptionRoot,
      chatSource: {
        conversationId: 'stored-conversation',
        turnId: '7d849a57-bd08-487d-af5b-e0f69ac836a4',
        toolCallIds: ['stored-first', 'stored-second'],
      },
    });
  },
);

it.each([false, true])(
  'keeps a read-only note adoption limited to its stored read-only scope: %s',
  async (adoptionReadOnly) => {
    const { calls, user } = setup({
      readOnly: true,
      adoptionReadOnly,
      adoptionRoot: '5d849a57-bd08-487d-af5b-e0f69ac836a4',
    });
    const action = screen.getByRole('button', { name: 'Review stored batch' });
    await waitFor(() => {
      expect(action).toBeEnabled();
    });
    await user.click(action);
    if (adoptionReadOnly)
      await waitFor(() => {
        expect(calls).toHaveLength(1);
      });
    else expect(calls).toHaveLength(0);
  },
);

it('retains the original message when workspace plan creation is refused', async () => {
  const { calls, onStarted, user } = setup({ refuse: true });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare plan' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Prepare plan' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Plan could not start');
  expect(calls).toHaveLength(1);
  expect(onStarted).not.toHaveBeenCalled();
});

it('keeps a workspace plan visible with a null anchor while another pane item remains selected', async () => {
  const { calls, user } = setup({
    currentItemId: '6d849a57-bd08-487d-af5b-e0f69ac836a4',
    planAnchorItemId: null,
  });
  const action = screen.getByRole('button', { name: 'Prepare plan' });
  await waitFor(() => {
    expect(action).toBeEnabled();
  });
  await user.click(action);
  await waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  expect(calls[0]?.body).toMatchObject({ anchorItemId: null, sourceScope: { kind: 'workspace' } });
  expect(await screen.findByRole('region', { name: 'Companion plan' })).toBeVisible();
});

it('holds the original message until the first sharing choice is confirmed', async () => {
  const { calls, onStarted, user } = setup({ sharing: true });
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Prepare plan' })).toBeEnabled();
  });
  await user.click(screen.getByRole('button', { name: 'Prepare plan' }));
  expect(
    await screen.findByRole('region', { name: 'Share context with the companion' }),
  ).toBeVisible();
  expect(onStarted).not.toHaveBeenCalled();
  expect(calls).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => {
    expect(onStarted).toHaveBeenCalledTimes(1);
  });
  expect(calls[1]).toMatchObject({
    path: `${planRoute}/49b80577-9ad4-46aa-ad2c-5988fda36abf/sharing/decision`,
    body: { recipientRevision: 'recipient-one', scopeDigest: 'scope-one', approve: true },
  });
});
