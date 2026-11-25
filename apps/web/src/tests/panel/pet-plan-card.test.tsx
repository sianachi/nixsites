import { createNixClient, type PetPlanResponse } from '@nix/api-client';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { z } from 'zod';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { expect, it, vi } from 'vitest';
import { PetPlanCard } from '../../panel/pet-plan-card';

const run: PetPlanResponse = {
  id: '49b80577-9ad4-46aa-ad2c-5988fda36abf',
  workspaceId: '8d849a57-bd08-487d-af5b-e0f69ac836a4',
  anchorItemId: null,
  petId: '77fa1d13-ce45-47d4-bd7c-51a4dd47e4ab',
  brief: 'Rename the brief and add the launch checklist.',
  sourceScope: { kind: 'workspace' },
  status: 'waiting_for_approval',
  revision: 3,
  sharingQuestion: null,
  question: null,
  plan: {
    id: '8eadd6a1-e91a-4be5-b3c4-a37d341b6d51',
    version: 1,
    summary: 'Rename Project brief and add a checklist to Daily plan.',
    reviewDigest: 'a'.repeat(64),
    scopeDigest: 'b'.repeat(64),
    recipientRevision: 'recipient-one',
    status: 'awaiting_review',
    steps: [
      {
        id: '9eadd6a1-e91a-4be5-b3c4-a37d341b6d51',
        capability: 'task.rename',
        arguments: { title: 'Release brief' },
        effect: {
          description: 'Rename Project brief',
          parameters: {
            itemId: '4dffbc88-ea17-4299-96dc-8bac562dd9d0',
            from: 'Project brief',
            to: 'Release brief',
            revision: 1,
          },
        },
        executor: 'server',
        status: 'pending',
        fields: [
          {
            id: 'title',
            label: 'Title',
            kind: 'text',
            value: 'Release brief',
            currentValue: 'Project brief',
            required: true,
          },
        ],
      },
      {
        id: 'aeadd6a1-e91a-4be5-b3c4-a37d341b6d51',
        capability: 'workspace.append_note',
        arguments: { operation: 'append_note', markdown: '- [ ] Ship the release' },
        effect: {
          description: 'Add checklist to Daily plan',
          parameters: {
            kind: 'workspace',
            preview: {
              headline: 'Add checklist to Daily plan',
              destination: { title: 'Daily plan', path: ['Product team', 'Daily plan'] },
              counts: { items: 0, fields: 0, views: 0, entries: 0, writes: 1 },
              tree: [],
              notes: [],
              warnings: [],
              problems: [],
              neverDoes: [],
            },
            values: {
              itemId: '5dffbc88-ea17-4299-96dc-8bac562dd9d0',
              markdown: '- [ ] Ship the release',
            },
          },
        },
        executor: 'server',
        status: 'pending',
        fields: [
          {
            id: 'markdown',
            label: 'Checklist',
            kind: 'multiline',
            value: '- [ ] Ship the release',
            currentValue: 'Today',
            required: true,
          },
        ],
      },
    ],
  },
  results: [],
  createdAt: '2026-11-25T12:00:00Z',
  updatedAt: '2026-11-25T12:00:00Z',
};

function nonce(value: unknown): string {
  return z.object({ requestId: z.uuid() }).parse(value).requestId;
}

function setup(initial = run, { refuse = false }: { readonly refuse?: boolean } = {}) {
  const requests = vi.fn<(path: string, body: unknown) => void>();
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
      requests(path, body);
      if (refuse)
        return Response.json(
          { code: 'pet_plans.stale', title: 'The plan changed. Review the latest version.' },
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        );
      if (path.endsWith('/drafts') && initial.plan != null)
        return Response.json({
          ...initial,
          revision: 4,
          plan: {
            ...initial.plan,
            version: 2,
            reviewDigest: 'c'.repeat(64),
            steps: initial.plan.steps.map((step, index) =>
              index === 0
                ? {
                    ...step,
                    effect: {
                      ...step.effect,
                      parameters: {
                        itemId: '4dffbc88-ea17-4299-96dc-8bac562dd9d0',
                        from: 'Project brief',
                        to: 'Launch brief',
                        revision: 1,
                      },
                    },
                    fields: step.fields.map((field) => ({ ...field, value: 'Launch brief' })),
                  }
                : step,
            ),
          },
        });
      return Response.json({
        ...initial,
        revision: initial.revision + 1,
        status: 'completed',
        plan:
          initial.plan == null
            ? null
            : {
                ...initial.plan,
                status: 'completed',
                steps: initial.plan.steps.map((step, index) =>
                  step.status === 'cancelled'
                    ? step
                    : {
                        ...step,
                        status: 'applied',
                        receipt:
                          index === 0
                            ? 'Renamed Project brief to Release brief.'
                            : 'Added checklist to Daily plan.',
                      },
                ),
              },
      });
    },
  });
  function Review() {
    const [current, setCurrent] = useState(initial);
    return <PetPlanCard client={client} run={current} onUpdate={setCurrent} />;
  }
  const rendered = render(<Review />);
  return { ...rendered, requests, user: userEvent.setup() };
}

it('reviews two prepared changes with one Continue and reports both observed receipts', async () => {
  const { requests, user } = setup();
  expect(screen.getByRole('group', { name: 'Rename Project brief' })).toBeVisible();
  expect(screen.getByRole('group', { name: 'Add checklist to Daily plan' })).toBeVisible();
  expect(screen.getAllByRole('button', { name: 'Continue' })).toHaveLength(1);
  expect(
    within(screen.getByRole('group', { name: 'Title values' })).getByRole('textbox', {
      name: 'Current Title',
    }),
  ).toHaveValue('Project brief');
  expect(screen.getByRole('textbox', { name: 'Proposed Title' })).toHaveValue('Release brief');
  expect(requests).not.toHaveBeenCalled();
  expect(
    screen
      .getAllByRole('link', { name: 'Inspect target item' })
      .map((link) => link.getAttribute('href')),
  ).toEqual([
    `/w/${run.workspaceId}?item=4dffbc88-ea17-4299-96dc-8bac562dd9d0`,
    `/w/${run.workspaceId}?item=5dffbc88-ea17-4299-96dc-8bac562dd9d0`,
  ]);
  expect(screen.getAllByRole('textbox', { name: 'Checklist' })).toHaveLength(1);

  await user.click(screen.getByRole('button', { name: 'Continue' }));

  expect(requests).toHaveBeenCalledTimes(1);
  expect(requests).toHaveBeenCalledWith(
    `/api/v1/workspaces/${run.workspaceId}/pet-plans/${run.id}/plans/${String(run.plan?.id)}/decision`,
    {
      expectedRunRevision: 3,
      planVersion: 1,
      reviewDigest: 'a'.repeat(64),
      approve: true,
      requestId: nonce(requests.mock.calls.at(-1)?.[1]),
    },
  );
  expect(await screen.findByText('Renamed Project brief to Release brief.')).toBeVisible();
  expect(screen.getByText('Added checklist to Daily plan.')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('2 of 2 changes completed');
});

it('holds approval while supported field edits are prepared as a fresh version', async () => {
  const { requests, user } = setup();
  const step = within(screen.getByRole('group', { name: 'Rename Project brief' }));
  await user.click(step.getByRole('button', { name: 'Edit values' }));
  expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  const field = within(step.getByRole('form', { name: 'Edit Rename Project brief' })).getByRole(
    'textbox',
    { name: 'Title' },
  );
  await user.clear(field);
  await user.type(field, 'Launch brief');
  await user.click(step.getByRole('button', { name: 'Preview these values' }));

  await waitFor(() => {
    expect(requests).toHaveBeenCalledTimes(1);
  });
  expect(requests).toHaveBeenCalledWith(
    `/api/v1/workspaces/${run.workspaceId}/pet-plans/${run.id}/drafts`,
    {
      expectedRunRevision: 3,
      planVersion: 1,
      fieldEdits: [{ stepId: run.plan?.steps[0]?.id, fieldId: 'title', value: 'Launch brief' }],
      requestId: nonce(requests.mock.calls.at(-1)?.[1]),
    },
  );
  expect(await screen.findByRole('textbox', { name: 'Proposed Title' })).toHaveValue(
    'Launch brief',
  );
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  expect(requests.mock.calls[1]?.[1]).toMatchObject({
    planVersion: 2,
    reviewDigest: 'c'.repeat(64),
    approve: true,
  });
});

it('cancels remaining work with the observed run revision', async () => {
  const { requests, user } = setup();
  await user.click(screen.getByRole('button', { name: 'Cancel plan' }));
  expect(requests).toHaveBeenCalledWith(
    `/api/v1/workspaces/${run.workspaceId}/pet-plans/${run.id}/cancel`,
    { expectedRunRevision: 3, requestId: nonce(requests.mock.calls[0]?.[1]) },
  );
});

it('shows partial and uncertain work without offering another execution decision', () => {
  const plan = run.plan;
  if (plan == null) throw new Error('Fixture requires a plan');
  const { requests } = setup({
    ...run,
    status: 'review_required',
    plan: {
      ...plan,
      status: 'review_required',
      steps: plan.steps.map((step, index) => ({
        ...step,
        status: index === 0 ? 'applied' : 'unknown',
        receipt: index === 0 ? 'Renamed the brief.' : 'The request reached its dispatch boundary.',
      })),
    },
  });
  expect(screen.getByText('Renamed the brief.')).toBeVisible();
  expect(screen.getByText(/Nix will not repeat it automatically/u)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
  expect(requests).not.toHaveBeenCalled();
});

it('offers supported Undo against the exact applied step', async () => {
  const plan = run.plan;
  if (plan == null) throw new Error('Fixture requires a plan');
  const { requests, user } = setup({
    ...run,
    status: 'completed',
    plan: {
      ...plan,
      status: 'completed',
      steps: plan.steps.map((step, index) => ({
        ...step,
        status: 'applied',
        undoId: index === 0 ? step.id : null,
        receipt: 'Completed the reviewed change.',
      })),
    },
  });
  await user.click(screen.getByRole('button', { name: 'Undo Rename Project brief' }));
  const step = plan.steps[0];
  if (step === undefined) throw new Error('Fixture requires its first step');
  expect(requests).toHaveBeenCalledWith(
    `/api/v1/workspaces/${run.workspaceId}/pet-plans/${run.id}/plans/${plan.id}/steps/${step.id}/undo`,
    { expectedRunRevision: 3, requestId: nonce(requests.mock.calls[0]?.[1]) },
  );
});

it('retains the exact review and stops approval after a stale decision response', async () => {
  const { requests, user } = setup(run, { refuse: true });
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The plan changed. Review the latest version.',
  );
  expect(screen.getByRole('textbox', { name: 'Proposed Title' })).toHaveValue('Release brief');
  expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  expect(requests).toHaveBeenCalledTimes(1);
});

it('keeps unknown preview values complete and read only', () => {
  const longText = `literal {"keep":true}\n${'Complete content. '.repeat(150)}\nLast line`;
  const plan = run.plan;
  if (plan == null) throw new Error('Fixture requires a plan');
  setup({
    ...run,
    plan: {
      ...plan,
      steps: [
        {
          ...plan.steps[0],
          id: '9eadd6a1-e91a-4be5-b3c4-a37d341b6d51',
          capability: 'unknown.preview',
          arguments: {},
          effect: {
            description: 'Review unfamiliar values',
            parameters: {
              literalText: longText,
              enabled: false,
              count: 0,
              missing: null,
              nested: { 'exact key': [] },
            },
          },
          executor: 'server',
          status: 'pending',
          fields: [],
        },
      ],
    },
  });
  const group = within(screen.getByRole('group', { name: 'Review unfamiliar values' }));
  expect(group.getByRole('textbox', { name: 'Literal Text' })).toHaveValue(longText);
  for (const field of group.getAllByRole('textbox')) expect(field).toHaveAttribute('readonly');
  expect(group.getByRole('textbox', { name: 'Enabled' })).toHaveValue('No');
  expect(group.getByRole('textbox', { name: 'Count' })).toHaveValue('0');
});

it('accepts a fractional number when preparing corrected values', async () => {
  if (run.plan == null) throw new Error('Fixture requires a plan');
  const { requests, user } = setup({
    ...run,
    plan: {
      ...run.plan,
      steps: run.plan.steps.map((step, index) =>
        index === 0
          ? {
              ...step,
              fields: [
                { id: 'estimate', label: 'Estimate', kind: 'number', value: 1, required: true },
              ],
            }
          : step,
      ),
    },
  });
  const step = within(screen.getByRole('group', { name: 'Rename Project brief' }));
  await user.click(step.getByRole('button', { name: 'Edit values' }));
  const input = step.getByRole('spinbutton', { name: 'Estimate' });
  expect(input).toHaveAttribute('step', 'any');
  await user.clear(input);
  await user.type(input, '1.5');
  await user.click(step.getByRole('button', { name: 'Preview these values' }));
  expect(requests).toHaveBeenCalledTimes(1);
  expect(requests.mock.calls[0]?.[1]).toMatchObject({
    fieldEdits: [{ stepId: run.plan.steps[0]?.id, fieldId: 'estimate', value: 1.5 }],
  });
});

it('renders the complete typed partial receipt while retaining literal result text', () => {
  if (run.plan == null) throw new Error('Fixture requires a plan');
  setup({
    ...run,
    status: 'review_required',
    plan: {
      ...run.plan,
      status: 'review_required',
      steps: run.plan.steps.map((step, index) =>
        index === 0
          ? {
              ...step,
              status: 'partial',
              receipt: '{"internalLedger":"transport only"}',
              receiptView: {
                summary: 'Created one of the two prepared entries.',
                details: { completed: 1, skipped: false, note: '', missing: null },
                text: '{"literal":"keep this exact result text"}',
              },
            }
          : step,
      ),
    },
  });
  expect(screen.getByText('Partly completed. Remaining work stopped.')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Completed' })).toHaveValue('1');
  expect(screen.getByRole('textbox', { name: 'Skipped' })).toHaveValue('No');
  expect(screen.getByText('{"literal":"keep this exact result text"}')).toBeVisible();
  expect(document.body.textContent).not.toContain('internalLedger');
  expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
});

it('shows complete read-only discovery values before an ordinary clarification answer', () => {
  const fullText = 'Read-only discovery content. '.repeat(300);
  const { requests } = setup({
    ...run,
    plan: null,
    status: 'waiting_for_input',
    question: { id: run.id, text: 'Which value should the new title use?' },
    observations: [
      {
        id: run.id,
        capability: 'workspace.read_note',
        description: 'Read Project brief',
        receiptView: {
          summary: 'Read the selected note',
          details: { title: 'Project brief', content: fullText, ready: false },
        },
      },
    ],
  });
  const group = within(screen.getByRole('group', { name: 'Read Project brief' }));
  expect(group.getByRole('textbox', { name: 'Content' })).toHaveValue(fullText);
  expect(group.getByRole('textbox', { name: 'Ready' })).toHaveValue('No');
  expect(
    screen.getByRole('textbox', { name: 'Which value should the new title use?' }),
  ).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
  expect(requests).not.toHaveBeenCalled();
});

it.each(['task.rename', 'canvas.edit'])(
  'approves only the frozen read phase while keeping deferred %s uneditable',
  async (deferredCapability) => {
    if (run.plan == null) throw new Error('Fixture requires a plan');
    const deferred = run.plan.steps[0];
    const source = run.plan.steps[1];
    if (deferred === undefined || source === undefined)
      throw new Error('Fixture requires two steps');
    const { requests, user } = setup({
      ...run,
      plan: {
        ...run.plan,
        summary: 'Read the shared sources before preparing changes',
        steps: [
          {
            ...source,
            capability: 'workspace.read_note',
            fields: [
              {
                id: 'query',
                label: 'Read query',
                kind: 'text',
                value: 'Launch checklist',
                required: false,
              },
            ],
            effect: {
              description: 'Read Daily plan',
              parameters: {
                kind: 'workspace',
                preview: {
                  headline: 'Read Daily plan',
                  destination: { title: 'Daily plan', path: ['Daily plan'] },
                  counts: { items: 0, fields: 0, views: 0, entries: 0, writes: 0 },
                  tree: [],
                  notes: [],
                  warnings: [],
                  problems: [],
                  neverDoes: [],
                },
                values: { itemId: '5dffbc88-ea17-4299-96dc-8bac562dd9d0' },
              },
            },
          },
          {
            ...deferred,
            capability: deferredCapability,
            status: 'cancelled',
            receipt: 'Not dispatched; discovery must finish before preparing this change.',
            undoId: run.id,
          },
        ],
      },
    });
    expect(screen.getByRole('button', { name: 'Read shared sources' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit values' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change plan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Undo /u })).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Plan progress' })).toHaveAttribute('max', '1');
    expect(requests).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Read shared sources' }));
    expect(requests).toHaveBeenCalledExactlyOnceWith(
      `/api/v1/workspaces/${run.workspaceId}/pet-plans/${run.id}/plans/${run.plan.id}/decision`,
      expect.objectContaining({
        expectedRunRevision: 3,
        planVersion: 1,
        reviewDigest: run.plan.reviewDigest,
        approve: true,
      }),
    );
    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Plan progress summary' })).toHaveTextContent(
        '1 of 1 reads completed',
      );
    });
  },
);

it.each([false, true])(
  'recovers focus after explicit sharing refresh without overriding an outside move: outside=%s',
  async (outside) => {
    const question: NonNullable<PetPlanResponse['sharingQuestion']> = {
      scopeDigest: 'scope-one',
      recipientRevision: 'recipient-one',
      decisionNonce: null,
      sourceScope: { kind: 'workspace' },
      recipient: {
        provider: 'Old provider',
        destination: 'https://old.invalid',
        routingPolicy: 'Direct',
        connectionRevision: 'connection-one',
      },
      message: 'May I use this context?',
    };
    let finishRefresh: (response: Response) => void = () => {
      throw new Error('The explicit refresh has not started.');
    };
    let challengeRequests = 0;
    const client = createNixClient({
      baseUrl: 'http://nix.invalid',
      tokens: {
        getAccessToken: () => Promise.resolve(null),
        refreshAccessToken: () => Promise.resolve(null),
      },
      fetch: (input) => {
        expect(new URL(requestUrl(input)).pathname).toBe(
          `/api/v1/workspaces/${run.workspaceId}/pet-sharing/question`,
        );
        challengeRequests += 1;
        if (challengeRequests === 1) return Promise.resolve(Response.json({ question: null }));
        return new Promise<Response>((resolve) => {
          finishRefresh = resolve;
        });
      },
    });
    render(
      <>
        <button>Outside the plan</button>
        <PetPlanCard
          client={client}
          run={{ ...run, status: 'waiting_for_input', plan: null, sharingQuestion: question }}
          onUpdate={vi.fn()}
        />
      </>,
    );
    const refresh = await screen.findByRole('button', { name: 'Refresh sharing choice' });
    await userEvent.click(refresh);
    await waitFor(() => {
      expect(challengeRequests).toBe(2);
    });
    if (outside) await userEvent.click(screen.getByRole('button', { name: 'Outside the plan' }));
    finishRefresh(
      Response.json({
        question: {
          ...question,
          recipientRevision: 'recipient-two',
          decisionNonce: '11111111-1111-4111-8111-111111111111',
          recipient: { ...question.recipient, provider: 'Current provider' },
        },
      }),
    );
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Provider' })).toHaveValue('Current provider');
      expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    });
    if (outside) expect(screen.getByRole('button', { name: 'Outside the plan' })).toHaveFocus();
    else expect(screen.getByRole('region', { name: 'Companion plan' })).toHaveFocus();
    expect(challengeRequests).toBe(2);
  },
);

it.each([false, true])(
  'refreshes an inert or stale question through the BFF and requires review again: stale=%s',
  async (stale) => {
    const decisionNonce = '11111111-1111-4111-8111-111111111111';
    const sourceId = '22222222-2222-4222-8222-222222222222';
    const question: NonNullable<PetPlanResponse['sharingQuestion']> = {
      scopeDigest: 'old-scope',
      recipientRevision: 'old-recipient',
      decisionNonce: stale ? '33333333-3333-4333-8333-333333333333' : null,
      sourceScope: { kind: 'workspace' },
      recipient: {
        provider: 'Old provider',
        destination: 'https://old.invalid',
        routingPolicy: 'Direct',
        connectionRevision: 'old-key',
      },
      message: 'May I use this context?',
    };
    const requests = vi.fn<(path: string, body: unknown) => void>();
    let refused = false;
    const held: PetPlanResponse = {
      ...run,
      status: 'waiting_for_input',
      sourceScope: { kind: 'selected', itemIds: [sourceId] },
      plan: null,
      sharingQuestion: question,
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
        requests(path, body);
        if (path.endsWith('/pet-sharing/question'))
          return Response.json({
            question: {
              ...question,
              decisionNonce,
              scopeDigest: 'current-scope',
              recipientRevision: 'current-recipient',
              sourceScope: held.sourceScope,
              recipient: {
                ...question.recipient,
                provider: 'Current provider',
                destination: 'https://current.invalid',
                connectionRevision: 'current-key',
              },
            },
          });
        if (path.endsWith('/sharing/decision') && stale && !refused) {
          refused = true;
          return Response.json(
            { code: 'pet_plans.sharing_stale', title: 'The sharing choice changed.' },
            { status: 409, headers: { 'content-type': 'application/problem+json' } },
          );
        }
        if (path.endsWith('/sharing/decision'))
          return Response.json({ ...held, revision: held.revision + 1, sharingQuestion: null });
        throw new Error('Unexpected synthetic request');
      },
    });
    function Review() {
      const [current, setCurrent] = useState(held);
      return <PetPlanCard client={client} run={current} onUpdate={setCurrent} />;
    }
    render(<Review />);
    if (stale) await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Provider' })).toHaveValue('Current provider');
      expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    });
    expect(screen.getByRole('textbox', { name: 'Provider' })).toHaveValue('Current provider');
    expect(requests).toHaveBeenCalledWith(
      `/api/v1/workspaces/${run.workspaceId}/pet-sharing/question`,
      { petId: run.petId, sourceScope: held.sourceScope, forDecision: true },
    );
    expect(requests).toHaveBeenCalledTimes(stale ? 2 : 1);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => {
      expect(requests).toHaveBeenCalledTimes(stale ? 3 : 2);
    });
    expect(requests.mock.calls.at(-1)?.[1]).toMatchObject({
      expectedRunRevision: run.revision,
      decisionNonce,
      recipientRevision: 'current-recipient',
      scopeDigest: 'current-scope',
      approve: true,
    });
    if (stale) {
      const first = z.object({ requestId: z.uuid() }).parse(requests.mock.calls[0]?.[1]);
      expect(requests.mock.calls.at(-1)?.[1]).not.toHaveProperty('requestId', first.requestId);
    }
    expect(document.body.textContent).not.toContain(decisionNonce);
  },
);
