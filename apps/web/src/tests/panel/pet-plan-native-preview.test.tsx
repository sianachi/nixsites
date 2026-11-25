import { createNixClient, type PetPlanResponse } from '@nix/api-client';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { preparedPlanFixture } from '../../pages/pet-plan-card.stories';
import { PetPlanCard } from '../../panel/pet-plan-card';
import type * as CanvasReviewModule from '../../panel/pet-canvas-review-scene';

const scene = vi.hoisted(() => ({ load: vi.fn() }));
const getToken = () => Promise.resolve('synthetic-owner-session');
vi.mock('@nix/web-platform/auth/auth-provider', () => ({
  useAuth: () => ({ getAccessToken: getToken }),
}));
vi.mock('../../panel/pet-canvas-review-scene', async (original) => ({
  ...(await original<typeof CanvasReviewModule>()),
  loadCanvasReviewScene: scene.load,
  checkCanvasReviewRevision: () => Promise.resolve('current'),
}));
vi.mock('@nix/web-editor/editor/nix-canvas', async () => {
  const { useEffect } = await import('react');
  return {
    NixCanvas: ({ onReady }: { readonly onReady: (ready: boolean) => void }) => {
      useEffect(() => {
        onReady(true);
      }, [onReady]);
      return <div>Prepared drawing scene</div>;
    },
  };
});

function setup(kind: 'canvas' | 'sheet') {
  if (preparedPlanFixture.plan == null) throw new Error('Fixture requires a plan');
  const step = preparedPlanFixture.plan.steps[0];
  if (step === undefined) throw new Error('Fixture requires a step');
  const itemId = '4dffbc88-ea17-4299-96dc-8bac562dd9d0';
  const preview =
    kind === 'canvas'
      ? {
          kind,
          itemId,
          preview: {
            revision: { docId: itemId, headSeq: '1' },
            changes: [
              {
                before: null,
                after: {
                  id: 'new-shape',
                  type: 'rectangle',
                  version: 1,
                  versionNonce: 1,
                  x: 0,
                  y: 0,
                  width: 120,
                  height: 60,
                  index: null,
                },
              },
            ],
          },
        }
      : {
          kind,
          itemId,
          preview: { changes: [{ kind: 'cell', cell: 'A1', before: 'Before', after: 'After' }] },
        };
  const run: PetPlanResponse = {
    ...preparedPlanFixture,
    plan: {
      ...preparedPlanFixture.plan,
      steps: [
        {
          ...step,
          capability: `${kind}.edit`,
          effect: { description: `Review ${kind} changes`, parameters: preview },
          arguments: { itemId },
          fields: [],
        },
      ],
    },
  };
  const requests = vi.fn(() => Promise.resolve(Response.json(run)));
  const client = createNixClient({
    baseUrl: 'http://nix.invalid',
    fetch: requests,
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
  render(<PetPlanCard client={client} run={run} onUpdate={() => undefined} />);
  return { requests };
}

it('holds the whole-plan Continue until its native drawing scene is ready without a second approval', async () => {
  let release: ((value: unknown) => void) | undefined;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  scene.load.mockReturnValueOnce(held);
  const { requests } = setup('canvas');
  expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Apply drawing' })).not.toBeInTheDocument();
  await act(async () => {
    release?.({
      kind: 'ready',
      elements: [],
      focusIds: [],
      counts: { added: 1, updated: 0, removed: 0 },
    });
    await held;
  });
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });
  expect(screen.getByText('Prepared drawing scene')).toBeVisible();
  expect(requests).not.toHaveBeenCalled();
});

it('keeps a stale drawing held under the common plan decision', async () => {
  scene.load.mockResolvedValueOnce({ kind: 'stale' });
  setup('canvas');
  expect(await screen.findByRole('button', { name: 'Refresh draft' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
});

it('uses the existing native sheet before-and-after table inside the whole-plan review', () => {
  const { requests } = setup('sheet');
  const table = within(screen.getByRole('table', { name: 'Sheet changes' }));
  expect(table.getByRole('rowheader', { name: 'A1' })).toBeVisible();
  expect(table.getByRole('cell', { name: 'Before' })).toBeVisible();
  expect(table.getByRole('cell', { name: 'After' })).toBeVisible();
  expect(screen.getAllByRole('button', { name: 'Continue' })).toHaveLength(1);
  expect(requests).not.toHaveBeenCalled();
});
