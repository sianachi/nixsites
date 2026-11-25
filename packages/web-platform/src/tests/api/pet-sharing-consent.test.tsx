import { createNixClient, type PetPlanSourceScope } from '@nix/api-client';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { useSharingConsent } from '../../api/use-pet-sharing-consent';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const petId = '22222222-2222-4222-8222-222222222222';
const source = '33333333-3333-4333-8333-333333333333';

function setup(
  unknown = false,
  {
    missingNonce = false,
    changedRecipient = false,
  }: { readonly missingNonce?: boolean; readonly changedRecipient?: boolean } = {},
) {
  const disclose = vi.fn();
  const decisions = vi.fn();
  let decisionCount = 0;
  const question = {
    decisionNonce: missingNonce ? null : '11111111-1111-4111-8111-111111111111',
    scopeDigest: 'scope-one',
    recipientRevision: 'recipient-one',
    sourceScope: { kind: 'workspace' },
    recipient: {
      provider: 'OpenAI',
      destination: 'https://api.openai.com',
      routingPolicy: 'Direct',
      connectionRevision: unknown ? 'unknown' : 'connection-one',
    },
    message: 'May I use this context?',
  };
  const client = createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
    fetch: async (input, init) => {
      const path = new URL(requestUrl(input)).pathname;
      const body: unknown =
        typeof init?.body === 'string' ? await new Response(init.body).json() : undefined;
      if (path.endsWith('/decision')) {
        decisions(body);
        decisionCount += 1;
        if (changedRecipient && decisionCount === 1)
          return Response.json({
            question: {
              ...question,
              recipientRevision: 'recipient-two',
              decisionNonce: '22222222-2222-4222-8222-222222222222',
              recipient: {
                ...question.recipient,
                provider: 'Anthropic',
                destination: 'https://api.anthropic.com',
                connectionRevision: 'connection-two',
              },
            },
          });
        return Response.json({ question: null });
      }
      return Response.json({ question });
    },
  });
  function Question({ scope }: { readonly scope: PetPlanSourceScope }) {
    const sharing = useSharingConsent({
      client,
      workspaceId,
      petId,
      selectionKey: JSON.stringify(scope),
    });
    return (
      <>
        <button
          onClick={() => {
            void sharing.ensure(scope).then((allowed) => {
              if (allowed) disclose();
            });
          }}
        >
          Ask with context
        </button>
        {sharing.panel}
      </>
    );
  }
  const view = render(<Question scope={{ kind: 'workspace' }} />);
  return {
    ...view,
    disclose,
    decisions,
    user: userEvent.setup(),
    changeScope: () => {
      view.rerender(<Question scope={{ kind: 'selected', itemIds: [source] }} />);
    },
  };
}

it('does not disclose until the dedicated owner action grants the prepared scope and recipient', async () => {
  const { disclose, decisions, user } = setup();
  await user.click(screen.getByRole('button', { name: 'Ask with context' }));
  expect(
    await screen.findByRole('region', { name: 'Share context with the companion' }),
  ).toBeVisible();
  expect(disclose).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => {
    expect(disclose).toHaveBeenCalledTimes(1);
  });
  expect(decisions.mock.calls[0]?.[0]).toMatchObject({
    petId,
    sourceScope: { kind: 'workspace' },
    scopeDigest: 'scope-one',
    recipientRevision: 'recipient-one',
    decisionNonce: '11111111-1111-4111-8111-111111111111',
    approve: true,
  });
});

it('cancels an outstanding disclosure when its source choice changes', async () => {
  const { disclose, decisions, user, changeScope } = setup();
  await user.click(screen.getByRole('button', { name: 'Ask with context' }));
  await screen.findByRole('button', { name: 'Continue' });
  changeScope();
  expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
  expect(disclose).not.toHaveBeenCalled();
  expect(decisions).not.toHaveBeenCalled();
});

it('holds sharing when the selected recipient identity is unknown', async () => {
  const { disclose, user } = setup(true);
  await user.click(screen.getByRole('button', { name: 'Ask with context' }));
  expect(await screen.findByRole('button', { name: 'Continue' })).toBeDisabled();
  expect(disclose).not.toHaveBeenCalled();
});

it('cannot grant a legacy or inert question without its server-issued challenge', async () => {
  const { disclose, decisions, user } = setup(false, { missingNonce: true });
  await user.click(screen.getByRole('button', { name: 'Ask with context' }));
  expect(await screen.findByRole('button', { name: 'Continue' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Keep context private' }));
  expect(decisions).not.toHaveBeenCalled();
  expect(disclose).not.toHaveBeenCalled();
});

it('requires another owner decision when the recipient and challenge change', async () => {
  const { disclose, decisions, user } = setup(false, { changedRecipient: true });
  await user.click(screen.getByRole('button', { name: 'Ask with context' }));
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  expect(screen.getByRole('textbox', { name: 'Provider' })).toHaveValue('Anthropic');
  expect(disclose).not.toHaveBeenCalled();
  expect(decisions).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => {
    expect(disclose).toHaveBeenCalledTimes(1);
  });
  expect(decisions.mock.calls[1]?.[0]).toMatchObject({
    recipientRevision: 'recipient-two',
    decisionNonce: '22222222-2222-4222-8222-222222222222',
  });
  const first = z.object({ requestId: z.uuid() }).parse(decisions.mock.calls[0]?.[0]);
  expect(decisions.mock.calls[1]?.[0]).not.toHaveProperty('requestId', first.requestId);
});
