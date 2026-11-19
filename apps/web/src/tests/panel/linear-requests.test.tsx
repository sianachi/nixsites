import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LinearRequestResponse } from '@nix/api-client';
import { beforeEach, expect, it, vi } from 'vitest';

import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { json } from '@nix/web-foundation/testing/json-response';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { App } from '../../app';

const TASK = item({
  id: '8d83ad48-2963-465e-8ad9-1342556b09ce',
  title: 'Check the invoice',
  settings: {
    comments: true,
    suggesting: false,
    reviewStates: false,
    fullWidth: false,
    withholdFromPets: false,
  },
});
const ID = 'da47fc39-fd14-40c9-89cb-1e5a7b78f836';
const PET_ID = '274887d2-b8d9-46d1-9aa4-25693270c936';
const THREAD_ID = 'c0b6e140-5bce-4b13-af45-284b29191dbf';
const NEXT_STEP = 'Confirm the delivery with the requester.';
const ROUTE = `/api/v1/items/${TASK.id}/linear-requests`;
const REQUEST = {
  id: ID,
  itemId: TASK.id,
  issueId: 'PAY-24',
  status: 'pending',
  requestedBy: 'Claude',
  createdAt: '2026-11-16T12:00:00Z',
  expiresAt: '2026-11-16T12:15:00Z',
  canDecide: true,
  result: null,
  petId: null,
  commentId: null,
} satisfies LinearRequestResponse;

beforeEach(() => {
  signedIn();
});

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  if (typeof init?.body === 'string') return JSON.parse(init.body);
  return input instanceof Request ? input.clone().json() : undefined;
}

function taskWithLinear(
  initial: LinearRequestResponse | null,
  canHandToPet = false,
  decisionGate?: Promise<void>,
) {
  stubCoreApi({ items: [TASK] });
  const inner = globalThis.fetch;
  const decisions: { readonly method: string | undefined; readonly body: unknown }[] = [];
  const handoffs: unknown[] = [];
  let request = initial;
  let initialRead = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(requestUrl(input), globalThis.location.origin);
    if (pathname === `/api/v1/items/${TASK.id}/linear-link`) {
      return json({ link: null, connections: [] });
    }
    if (pathname === ROUTE) {
      initialRead = true;
      return json({ requests: request === null ? [] : [request], canHandToPet });
    }
    if (pathname === `/api/v1/items/${TASK.id}/pet-runs`) {
      return json({ enabled: false, abilities: [], runs: [] });
    }
    if (pathname === '/api/v1/me/pets/settings') {
      return json({
        revision: 1,
        settings: {
          enabled: true,
          activePetId: PET_ID,
          profiles: [{ id: PET_ID, name: 'Owl', appearance: 'owl', instructions: '' }],
        },
      });
    }
    if (pathname === `${ROUTE}/hand-to-pet` && canHandToPet) {
      handoffs.push(await readBody(input, init));
      request = { ...REQUEST, requestedBy: 'Owl', petId: PET_ID };
      return json(request);
    }
    if (pathname === `${ROUTE}/${ID}/decision` && request !== null) {
      const pending = request;
      decisions.push({
        method: init?.method ?? (input instanceof Request ? input.method : undefined),
        body: await readBody(input, init),
      });
      await decisionGate;
      request = {
        ...pending,
        status: 'succeeded',
        canDecide: false,
        commentId: pending.petId === null ? null : THREAD_ID,
        result: {
          id: 'PAY-24',
          title: 'Confirm billing address',
          status: 'Done',
          url: 'https://linear.app/demo/issue/PAY-24',
        },
      };
      return json(request);
    }
    if (
      request?.commentId === THREAD_ID &&
      (pathname === `/api/v1/items/${TASK.id}/comments` ||
        pathname === `/api/v1/items/${TASK.id}/comments/watch`)
    ) {
      return json({
        revision: 1,
        canComment: true,
        threads: [
          {
            id: THREAD_ID,
            anchorStart: null,
            anchorEnd: null,
            quote: null,
            resolvedAt: null,
            resolvedBy: null,
            resolvedByName: null,
            comments: [
              {
                id: THREAD_ID,
                authorId: '7712a587-429b-43bc-96ea-1d2b1759e52d',
                authorName: 'Test owner',
                importedAuthor: null,
                body: `Owl (pet)\n\nNext step\n${NEXT_STEP}`,
                mentionIds: [],
                createdAt: '2026-11-17T12:00:00Z',
                editedAt: null,
                deleted: false,
              },
            ],
          },
        ],
      });
    }
    return inner(input, init);
  });
  renderAt(<App />, `/?item=${TASK.id}`);
  return {
    decisions,
    handoffs,
    hasRead: () => initialRead,
    queue: (entry: LinearRequestResponse) => {
      request = entry;
    },
  };
}

async function openPetDialog(): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: 'Ask pet' }));
  await screen.findByRole('dialog', { name: 'Chat about this note' });
}

it('shows a newly queued lookup on the open task and sends approval for that exact request', async () => {
  const { decisions, hasRead, queue } = taskWithLinear(null);
  await userEvent.click(await screen.findByRole('button', { name: 'Item settings' }));
  expect(screen.queryByRole('region', { name: 'Linear requests' })).not.toBeInTheDocument();
  expect(hasRead()).toBe(false);
  await openPetDialog();
  await waitFor(() => {
    expect(hasRead()).toBe(true);
  });
  expect(screen.queryByRole('region', { name: 'Linear requests' })).not.toBeInTheDocument();
  queue(REQUEST);
  const requests = within(
    await screen.findByRole('region', { name: 'Linear requests' }, { timeout: 6_000 }),
  );

  expect(requests.getByText('Read PAY-24 in Linear')).toBeVisible();
  expect(requests.getByText('Requested by Claude')).toBeVisible();
  expect(requests.getByRole('status')).toHaveTextContent('Awaiting approval');
  await userEvent.click(requests.getByRole('button', { name: 'Approve once' }));

  expect(await requests.findByRole('link', { name: 'Confirm billing address' })).toHaveAttribute(
    'href',
    'https://linear.app/demo/issue/PAY-24',
  );
  expect(decisions).toEqual([{ method: 'POST', body: { approve: true } }]);
  expect(requests.getByRole('status')).toHaveTextContent('Lookup complete');
  expect(requests.queryByRole('button')).not.toBeInTheDocument();
});

it("doesn't offer a decision when Core says the viewer cannot approve the request", async () => {
  taskWithLinear({ ...REQUEST, canDecide: false });
  await openPetDialog();
  const requests = within(await screen.findByRole('region', { name: 'Linear requests' }));

  expect(requests.getByRole('status')).toHaveTextContent('Awaiting approval');
  expect(requests.queryByRole('button')).not.toBeInTheDocument();
});

it('hands the lookup to the active pet and opens its task comment after approval', async () => {
  let finishDecision = (): void => undefined;
  const decisionGate = new Promise<void>((resolve) => {
    finishDecision = resolve;
  });
  const { decisions, handoffs } = taskWithLinear(null, true, decisionGate);
  const user = userEvent.setup();
  await openPetDialog();
  const issue = await screen.findByRole('textbox', { name: 'Linear issue ID' });
  expect(screen.getByRole('button', { name: 'Request Linear lookup' })).toBeDisabled();

  await user.type(issue, 'PAY-24{Enter}');

  const approve = await screen.findByRole('button', { name: 'Approve once' });
  expect(handoffs).toEqual([{ petId: PET_ID, issueId: 'PAY-24' }]);
  expect(decisions).toEqual([]);
  expect(screen.getByText('Requested by Owl')).toBeVisible();
  expect(screen.getByText('Waiting for approval')).toBeVisible();
  expect(issue).toHaveValue('');
  expect(issue).toHaveFocus();
  await user.click(approve);
  expect(screen.getByText('Waiting for the pet’s next step…')).toBeVisible();
  finishDecision();
  expect(await screen.findByText('Next step posted')).toBeVisible();
  expect(decisions).toEqual([{ method: 'POST', body: { approve: true } }]);

  await user.click(screen.getByRole('button', { name: 'View comment' }));
  const comment = await screen.findByRole('article', { name: 'Comment thread' });
  expect(within(comment).getByText(`Owl (pet) Next step ${NEXT_STEP}`)).toBeVisible();
  expect(comment).toHaveFocus();
});
