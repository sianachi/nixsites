import type { PetRunResponse } from '@nix/api-client';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { PetActivityPage } from '../../pages/pet-activity-page';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const itemId = '22222222-2222-4222-8222-222222222222';
const proposalId = '33333333-3333-4333-8333-333333333333';
const questionId = '44444444-4444-4444-8444-444444444444';
const reviewRunId = '55555555-5555-4555-8555-555555555555';
const answerRunId = '66666666-6666-4666-8666-666666666666';
const runningRunId = '77777777-7777-4777-8777-777777777777';
const completedRunId = '88888888-8888-4888-8888-888888888888';
const staleRunId = '99999999-9999-4999-8999-999999999999';
const staleProposalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const client = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useOptionalApiClient: () => client,
}));
vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId }),
}));
vi.mock('../../panel/use-pet-plan-feed', () => ({
  usePetPlanFeed: () => ({
    feed: { status: 'ready', data: { enabled: true, runs: [] } },
    retry: vi.fn(),
  }),
}));

function run(
  id: string,
  brief: string,
  status: PetRunResponse['status'],
  details: Pick<PetRunResponse, 'question' | 'proposals'> = { proposals: [] },
): PetRunResponse {
  return {
    id,
    itemId,
    workspaceId,
    brief,
    status,
    abilities: [],
    sourceItemIds: [],
    workspaceScope: false,
    revision: 1,
    results: [],
    createdAt: '2026-11-17T12:00:00Z',
    updatedAt: '2026-11-17T12:00:00Z',
    ...details,
  };
}

function Destination() {
  return <output>{useLocation().search}</output>;
}

function openActivity() {
  render(
    <MemoryRouter initialEntries={[`/w/${workspaceId}/pet/activity`]}>
      <Routes>
        <Route path="/w/:workspaceId/pet/activity" element={<PetActivityPage />} />
        <Route path="/w/:workspaceId" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => vi.resetAllMocks());

it('lists jobs by status and opens the exact pending decision in the task', async () => {
  client.query.mockResolvedValue({
    enabled: true,
    abilities: [],
    runs: [
      run(reviewRunId, 'Draw the handoff flow\nDetailed job instructions', 'waiting_for_approval', {
        proposals: [
          {
            id: proposalId,
            capability: 'canvas.edit',
            status: 'pending',
            description: 'Preview of the planned diagram',
            preview: { text: 'Exact drawing content' },
          },
        ],
      }),
      run(answerRunId, 'Check the estimate', 'waiting_for_input', {
        question: { id: questionId, text: 'Which estimate should I open?' },
        proposals: [],
      }),
      run(staleRunId, 'Update the onboarding diagram', 'waiting_for_approval', {
        proposals: [
          {
            id: staleProposalId,
            capability: 'canvas.edit',
            status: 'stale',
            description: 'Preview of the changed diagram',
            preview: {},
          },
        ],
      }),
      run(runningRunId, 'Summarize the brief', 'running'),
      run(completedRunId, 'Prepare the next steps', 'completed'),
    ],
  });
  openActivity();

  const waiting = within(await screen.findByRole('region', { name: 'Needs attention' }));
  const review = waiting.getByRole('link', { name: 'Draw the handoff flow Needs review' });
  expect(review).toHaveAttribute(
    'href',
    `/w/${workspaceId}?item=${itemId}&petRun=${reviewRunId}&petDecision=${proposalId}`,
  );
  expect(waiting.getByRole('link', { name: 'Check the estimate Needs an answer' })).toHaveAttribute(
    'href',
    `/w/${workspaceId}?item=${itemId}&petRun=${answerRunId}&petDecision=${questionId}`,
  );
  expect(
    waiting.getByRole('link', { name: 'Update the onboarding diagram Draft needs refresh' }),
  ).toHaveAttribute(
    'href',
    `/w/${workspaceId}?item=${itemId}&petRun=${staleRunId}&petDecision=${staleProposalId}`,
  );
  expect(
    within(screen.getByRole('region', { name: 'In progress' })).getByRole('link'),
  ).toHaveAttribute('href', `/w/${workspaceId}?item=${itemId}&petRun=${runningRunId}`);
  expect(waiting.getByText('Needs an answer', { selector: 'span' })).toHaveAttribute(
    'data-tone',
    'accent',
  );
  expect(
    within(screen.getByRole('region', { name: 'In progress' })).getByText('Working'),
  ).toHaveAttribute('data-tone', 'neutral');
  expect(
    within(screen.getByRole('region', { name: 'Recent jobs' })).getByText('Completed'),
  ).toHaveAttribute('data-tone', 'muted');
  expect(
    within(screen.getByRole('region', { name: 'Recent jobs' })).getByRole('link'),
  ).toHaveAttribute('href', `/w/${workspaceId}?item=${itemId}&petRun=${completedRunId}`);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByText('Exact drawing content')).not.toBeInTheDocument();
  expect(screen.queryByText('Which estimate should I open?')).not.toBeInTheDocument();

  await userEvent.setup().click(review);
  expect(screen.getByRole('status')).toHaveTextContent(
    `?item=${itemId}&petRun=${reviewRunId}&petDecision=${proposalId}`,
  );
  expect(client.execute).not.toHaveBeenCalled();
});

it('keeps jobs hidden when the workspace feature is disabled', async () => {
  client.query.mockResolvedValue({
    enabled: false,
    abilities: [],
    runs: [run(completedRunId, 'Prepare the next steps', 'completed')],
  });
  openActivity();

  expect(await screen.findByText('Pet jobs are unavailable')).toBeVisible();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

it('labels a job with an unknown outcome apart from the section it sits in', async () => {
  client.query.mockResolvedValue({
    enabled: true,
    abilities: [],
    runs: [run(reviewRunId, 'File the invoices', 'review_required')],
  });
  openActivity();

  const section = await screen.findByRole('region', { name: 'Needs attention' });
  expect(
    within(section).getByRole('link', { name: 'File the invoices Check the outcome' }),
  ).toBeVisible();
  expect(within(section).queryByText('Needs attention', { selector: 'span' })).toBeNull();
});
