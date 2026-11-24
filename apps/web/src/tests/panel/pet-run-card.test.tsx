import { createNixClient, type NixClient, type PetRunResponse } from '@nix/api-client';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { PetRunCard } from '../../panel/pet-run-card';

const run: PetRunResponse = {
  id: '49b80577-9ad4-46aa-ad2c-5988fda36abf',
  itemId: '4dffbc88-ea17-4299-96dc-8bac562dd9d0',
  workspaceId: '8d849a57-bd08-487d-af5b-e0f69ac836a4',
  brief: 'Update the release flow drawing.',
  sourceItemIds: [],
  abilities: ['canvas.edit'],
  workspaceScope: false,
  status: 'waiting_for_approval',
  revision: 3,
  question: null,
  proposals: [
    {
      id: '8eadd6a1-e91a-4be5-b3c4-a37d341b6d51',
      capability: 'canvas.edit',
      description: 'Edit canvas Release flow',
      preview: {},
      status: 'pending',
    },
  ],
  results: [],
  createdAt: '2026-11-17T12:00:00Z',
  updatedAt: '2026-11-17T12:00:00Z',
};

function setup(initial: PetRunResponse = run) {
  let release: (value: PetRunResponse) => void = () => undefined;
  let refuse: (reason: Error) => void = () => undefined;
  const response = new Promise<PetRunResponse>((resolve, reject) => {
    release = resolve;
    refuse = reject;
  });
  const requests = vi.fn();
  const client: NixClient = {
    ...createNixClient({
      baseUrl: 'http://nix.invalid',
      tokens: {
        getAccessToken: () => Promise.resolve(null),
        refreshAccessToken: () => Promise.resolve(null),
      },
    }),
    execute: async (endpoint) => {
      requests(endpoint);
      return endpoint.schema.parse(await response);
    },
  };
  const onUpdate = vi.fn();
  render(<PetRunCard client={client} run={initial} onUpdate={onUpdate} />);
  return { user: userEvent.setup(), requests, release, refuse, onUpdate, response };
}

it.each([
  ['Refresh draft', 'Refreshing draft…', 'Decline request'],
  ['Decline request', 'Declining request…', 'Refresh draft'],
])(
  'names the pressed drawing action while %s waits for confirmation',
  async (action, pending, other) => {
    const { user, requests, refuse, onUpdate, response } = setup();
    await user.click(screen.getByRole('button', { name: action }));
    expect(screen.getByRole('button', { name: pending })).toBeDisabled();
    expect(screen.getByRole('button', { name: other })).toBeDisabled();
    expect(requests).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();
    await act(() => {
      refuse(new Error('Request refused'));
      return response.catch(() => undefined);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('This request could not be confirmed.');
    expect(screen.getByRole('button', { name: action })).toBeEnabled();
    expect(screen.queryByRole('button', { name: pending })).toBeNull();
    expect(screen.getByRole('button', { name: other })).toBeEnabled();
    expect(onUpdate).not.toHaveBeenCalled();
  },
);

it('keeps the approval pending until the drawing decision is confirmed', async () => {
  const { user, release, onUpdate, response } = setup();
  await user.click(screen.getByRole('button', { name: 'Decline request' }));
  expect(screen.getByRole('button', { name: 'Declining request…' })).toBeDisabled();
  expect(onUpdate).not.toHaveBeenCalled();
  await act(() => {
    release({
      ...run,
      status: 'running',
      proposals: run.proposals.map((proposal) => ({ ...proposal, status: 'declined' })),
    });
    return response;
  });
  expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }));
  expect(screen.queryByRole('button', { name: 'Declining request…' })).toBeNull();
});

it('does not label a drawing action as pending while the job is being cancelled', async () => {
  const { user, refuse, response } = setup();
  await user.click(screen.getByRole('button', { name: 'Cancel job' }));
  expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Refresh draft' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Decline request' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Refreshing draft…' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Declining request…' })).toBeNull();
  await act(() => {
    refuse(new Error('Request refused'));
    return response.catch(() => undefined);
  });
});

it('shows refresh progress for a stale drawing without offering approval or decline', async () => {
  const { user, refuse, response } = setup({
    ...run,
    proposals: run.proposals.map((proposal) => ({ ...proposal, status: 'stale' })),
  });
  expect(screen.queryByRole('button', { name: 'Decline request' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Apply drawing' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Refresh draft' }));
  expect(screen.getByRole('button', { name: 'Refreshing draft…' })).toBeDisabled();
  expect(screen.getByText('The canvas changed.')).toBeTruthy();
  await act(() => {
    refuse(new Error('Request refused'));
    return response.catch(() => undefined);
  });
  expect(screen.getByRole('button', { name: 'Refresh draft' })).toBeEnabled();
});
