import { createNixClient, type PetPlanResponse } from '@nix/api-client';
import { within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { PetPlanCard } from '../panel/pet-plan-card';

export default {
  title: 'Nix/Companion/Prepared plans',
  excludeStories: ['preparedPlanFixture', 'preparedReadPlanFixture'],
};

export const preparedPlanFixture: PetPlanResponse = {
  id: '49b80577-9ad4-46aa-ad2c-5988fda36abf',
  workspaceId: '8d849a57-bd08-487d-af5b-e0f69ac836a4',
  anchorItemId: null,
  petId: '77fa1d13-ce45-47d4-bd7c-51a4dd47e4ab',
  brief: 'Rename the project brief and add the release checklist.',
  sourceScope: { kind: 'workspace' },
  status: 'waiting_for_approval',
  revision: 3,
  question: null,
  plan: {
    id: '8eadd6a1-e91a-4be5-b3c4-a37d341b6d51',
    version: 1,
    summary: 'Rename Project brief to Release brief and add the checklist to Daily plan.',
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
        arguments: {
          operation: 'append_note',
          markdown:
            '- [ ] Review release notes\n- [ ] Check the rollout\n- [ ] Publish the announcement',
        },
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
              markdown:
                '- [ ] Review release notes\n- [ ] Check the rollout\n- [ ] Publish the announcement',
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
            value:
              '- [ ] Review release notes\n- [ ] Check the rollout\n- [ ] Publish the announcement',
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

function Review({
  uncertain = false,
  initial = preparedPlanFixture,
}: {
  readonly uncertain?: boolean;
  readonly initial?: PetPlanResponse;
}): ReactElement {
  const [run, setRun] = useState<PetPlanResponse>(() =>
    uncertain && preparedPlanFixture.plan != null
      ? {
          ...preparedPlanFixture,
          status: 'review_required',
          plan: {
            ...preparedPlanFixture.plan,
            status: 'review_required',
            steps: preparedPlanFixture.plan.steps.map((step, index) => ({
              ...step,
              status: index === 0 ? 'applied' : 'unknown',
              receipt:
                index === 0
                  ? 'Renamed Project brief to Release brief.'
                  : 'The request was dispatched, but its outcome could not be confirmed.',
            })),
          },
        }
      : initial,
  );
  const client = createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
    fetch: () =>
      Promise.resolve(
        Response.json({
          ...run,
          revision: run.revision + 1,
          status: 'completed',
          plan:
            run.plan == null
              ? null
              : {
                  ...run.plan,
                  status: 'completed',
                  steps: run.plan.steps.map((step, index) =>
                    step.status === 'cancelled'
                      ? step
                      : {
                          ...step,
                          status: 'applied',
                          receipt:
                            step.capability === 'workspace.read_note'
                              ? 'Read Daily plan.'
                              : index === 0
                                ? 'Renamed Project brief to Release brief.'
                                : 'Added the release checklist to Daily plan.',
                        },
                  ),
                },
        }),
      ),
  });
  return (
    <div className="@container mx-auto w-full max-w-6xl p-3">
      <PetPlanCard client={client} run={run} onUpdate={setRun} />
    </div>
  );
}

export const TwoChanges = {
  render: (): ReactElement => <Review />,
  play: ({ canvasElement }: { readonly canvasElement: HTMLElement }): void => {
    const canvas = within(canvasElement);
    if (canvas.getAllByRole('button', { name: 'Continue' }).length !== 1)
      throw new Error('A plan has one Continue control.');
    canvas.getByRole('group', { name: 'Rename Project brief' });
    canvas.getByRole('group', { name: 'Add checklist to Daily plan' });
  },
};
export const CompletedPlan = {
  render: (): ReactElement => <Review />,
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Continue' }));
    await canvas.findByText('Added the release checklist to Daily plan.');
  },
};
export const UncertainSecondChange = { render: (): ReactElement => <Review uncertain /> };

function readFixture(): PetPlanResponse {
  const plan = preparedPlanFixture.plan;
  const write = plan?.steps[0];
  const read = plan?.steps[1];
  if (plan == null || write === undefined || read === undefined)
    throw new Error('Fixture requires two prepared steps');
  return {
    ...preparedPlanFixture,
    plan: {
      ...plan,
      summary: 'Read Daily plan before preparing changes',
      steps: [
        {
          ...read,
          capability: 'workspace.read_note',
          arguments: { operation: 'read_note', itemId: '5dffbc88-ea17-4299-96dc-8bac562dd9d0' },
          fields: [],
          effect: {
            description: 'Read Daily plan',
            parameters: {
              kind: 'workspace',
              preview: {
                headline: 'Read Daily plan',
                destination: { title: 'Daily plan', path: ['Product team', 'Daily plan'] },
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
          ...write,
          status: 'cancelled',
          receipt: 'Not dispatched; discovery must finish before preparing this change.',
        },
      ],
    },
  };
}
export const preparedReadPlanFixture = readFixture();
export const ReadSharedSources = {
  render: (): ReactElement => <Review initial={preparedReadPlanFixture} />,
};
