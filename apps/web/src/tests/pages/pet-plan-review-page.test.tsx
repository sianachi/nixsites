import { createNixClient, type NixClient } from '@nix/api-client';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { expect, it, vi } from 'vitest';
import { preparedPlanFixture } from '../../pages/pet-plan-card.stories';
import { PetPlanReviewPage } from '../../pages/pet-plan-review-page';

let client: NixClient;
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));
vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: preparedPlanFixture.workspaceId }),
}));

const handoffId = 'beadd6a1-e91a-4be5-b3c4-a37d341b6d51';
const granteeCredentialId = 'ceadd6a1-e91a-4be5-b3c4-a37d341b6d51';
const plan = preparedPlanFixture.plan;
if (plan == null) throw new Error('Fixture requires a plan');
const handoff = {
  handoffId,
  granteeCredentialId,
  clientName: 'Local planning CLI',
  planId: plan.id,
  planVersion: plan.version,
  reviewDigest: plan.reviewDigest,
  approve: true,
  status: 'pending',
  expiresAt: '2099-11-25T12:00:00Z',
};
const root = `/api/v1/workspaces/${preparedPlanFixture.workspaceId}/pet-plans/${preparedPlanFixture.id}`;

function setup(
  stale = false,
  {
    held,
    progress = false,
    failHandoffPoll = false,
  }: {
    readonly held?: Promise<void>;
    readonly progress?: boolean;
    readonly failHandoffPoll?: boolean;
  } = {},
) {
  const writes = vi.fn<(path: string, method: string, body: unknown) => void>();
  let handoffReads = 0;
  client = createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
    fetch: async (input, init) => {
      const path = new URL(requestUrl(input)).pathname;
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        const body: unknown =
          typeof init?.body === 'string' ? await new Response(init.body).json() : undefined;
        writes(path, method, body);
        await held;
        return Response.json({
          ...handoff,
          status: method === 'DELETE' ? 'revoked' : 'authorized',
        });
      }
      if (path.includes('/decision-handoffs/') && ++handoffReads > 1 && failHandoffPoll)
        return Response.json({ detail: 'Synthetic status refresh failure' }, { status: 503 });
      if (progress && !path.includes('/decision-handoffs/'))
        return Response.json({
          ...preparedPlanFixture,
          revision: path.endsWith('/watch') ? 5 : 4,
          status: path.endsWith('/watch') ? 'completed' : 'running',
          plan:
            preparedPlanFixture.plan == null
              ? null
              : {
                  ...preparedPlanFixture.plan,
                  status: path.endsWith('/watch') ? 'completed' : 'approved',
                  steps: preparedPlanFixture.plan.steps.map((step, index) => ({
                    ...step,
                    status: path.endsWith('/watch') ? 'applied' : 'applying',
                    receipt: path.endsWith('/watch')
                      ? `Observed completed change ${String(index + 1)}`
                      : null,
                  })),
                },
        });
      return Response.json(
        path.includes('/decision-handoffs/')
          ? { ...handoff, reviewDigest: stale ? 'old-digest' : handoff.reviewDigest }
          : preparedPlanFixture,
      );
    },
  });
  render(
    <MemoryRouter
      initialEntries={[
        `/w/${preparedPlanFixture.workspaceId}/pet/plans/${preparedPlanFixture.id}/review?handoffId=${handoffId}`,
      ]}
    >
      <Routes>
        <Route path="/w/:workspaceId/pet/plans/:runId/review" element={<PetPlanReviewPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return { writes, user: userEvent.setup() };
}

it('authorizes one named client for the exact displayed plan without exposing a context secret', async () => {
  const { writes, user } = setup();
  expect(
    await screen.findByRole('heading', { name: 'Local planning CLI requests your decision' }),
  ).toBeVisible();
  expect(screen.getByRole('group', { name: 'Rename Project brief' })).toBeVisible();
  expect(writes).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  expect(writes).toHaveBeenCalledWith(`${root}/decision-contexts`, 'POST', {
    handoffId,
    planId: handoff.planId,
    planVersion: 1,
    reviewDigest: handoff.reviewDigest,
    granteeCredentialId,
    clientName: handoff.clientName,
    approve: true,
  });
  expect(await screen.findByText(/Request status: authorized/u)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  expect(screen.queryByText(/This request is no longer current/u)).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain('decisionContext');
});

it('holds an outdated client request before any decision is posted', async () => {
  const { writes } = setup(true);
  expect(await screen.findByRole('alert')).toHaveTextContent('This request is no longer current.');
  expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  expect(writes).not.toHaveBeenCalled();
});

it('declines a client handoff without cancelling the companion plan', async () => {
  const { writes, user } = setup();
  await user.click(await screen.findByRole('button', { name: 'Decline client request' }));
  expect(writes).toHaveBeenCalledTimes(1);
  expect(writes).toHaveBeenCalledWith(
    `${root}/decision-handoffs/${handoffId}`,
    'DELETE',
    undefined,
  );
  expect(await screen.findByText(/Request status: revoked/u)).toBeVisible();
  expect(screen.queryByText(/This request is no longer current/u)).not.toBeInTheDocument();
  expect(screen.getByRole('status', { name: 'Client request status' })).toHaveFocus();
});

it.each(['authorize', 'decline'])(
  'holds both client decision directions while %s is pending',
  async (direction) => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { writes, user } = setup(false, { held });
    const approve = await screen.findByRole('button', { name: 'Continue' });
    const decline = screen.getByRole('button', { name: 'Decline client request' });
    await user.click(direction === 'authorize' ? approve : decline);
    expect(approve).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving decision…' })).toBeDisabled();
    await user.click(direction === 'authorize' ? decline : approve);
    expect(writes).toHaveBeenCalledTimes(1);
    await act(async () => {
      release?.();
      await held;
    });
  },
);

it('watches a running plan until both observed receipts arrive', async () => {
  setup(false, { progress: true });
  expect(await screen.findByText('Observed completed change 1')).toBeVisible();
  expect(screen.getByText('Observed completed change 2')).toBeVisible();
  expect(screen.getByRole('status', { name: 'Plan progress summary' })).toHaveTextContent(
    '2 of 2 changes completed',
  );
});

it('keeps a confirmed client authorization when an older pending status arrives later', async () => {
  const { user } = setup();
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  expect(await screen.findByRole('status', { name: 'Client request status' })).toHaveTextContent(
    'Request status: authorized',
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 2_100)));
  expect(screen.getByRole('status', { name: 'Client request status' })).toHaveTextContent(
    'Request status: authorized',
  );
  expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Decline client request' })).not.toBeInTheDocument();
});

it('keeps the client decision held after a handoff refresh failure even when plan progress refreshes', async () => {
  setup(false, { failHandoffPoll: true });
  expect(await screen.findByRole('button', { name: 'Continue' })).toBeEnabled();
  await act(() => new Promise((resolve) => setTimeout(resolve, 2_800)));
  expect(screen.getByText('The client request status could not be refreshed.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
});

it('preserves an intentional outside focus move while the client refusal is pending', async () => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { user } = setup(false, { held });
  render(<button>Read another item</button>);
  await user.click(await screen.findByRole('button', { name: 'Decline client request' }));
  const outside = screen.getByRole('button', { name: 'Read another item' });
  await user.click(outside);
  await act(async () => {
    release?.();
    await held;
  });
  expect(await screen.findByText(/Request status: revoked/u)).toBeVisible();
  expect(outside).toHaveFocus();
});
