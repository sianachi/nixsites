import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { petConnectionSchema } from '@nix/api-client';
import { PetHistory } from '../../pets/pet-history';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const PET = '22222222-2222-4222-8222-222222222222';
const PLAN = '33333333-3333-4333-8333-333333333333';
const BOOKS = '44444444-4444-4444-8444-444444444444';

const response = petConnectionSchema.parse({
  provider: 'chatgpt',
  status: 'connected',
  reason: '',
  canConnect: false,
  history: [
    { id: PLAN, title: 'Plan', createdAt: '2026-09-06T12:00:00Z' },
    { id: BOOKS, title: 'Reading list', createdAt: '2026-09-05T12:00:00Z' },
  ],
  messages: [{ id: 'one', role: 'user', text: 'Keep this plan' }],
});

function setup(props: { running?: boolean; onResumed?: (value: unknown) => void } = {}) {
  const execute = vi.fn().mockResolvedValue(response);
  render(
    <PetHistory client={{ execute }} workspaceId={WORKSPACE} petId={PET} name="Pip" {...props} />,
  );
  return { execute, user: userEvent.setup() };
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('list', { name: 'Saved conversations' });
  return user;
}

it('deletes from the row without opening it, after a second explicit confirmation', async () => {
  const { execute, user } = setup();
  await open(user);
  await user.click(screen.getByRole('button', { name: 'Remove Plan' }));
  expect(execute).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Keep conversation' }));
  expect(execute).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Remove Plan' }));
  await user.click(screen.getByRole('button', { name: 'Delete saved conversation permanently' }));
  await waitFor(() => {
    expect(execute).toHaveBeenCalledTimes(2);
  });
  expect(execute.mock.calls[1]?.[0]).toMatchObject({
    body: { operation: 'delete_history', historyId: PLAN },
  });
});

it('filters the saved conversations by title', async () => {
  const { user } = setup();
  await open(user);
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  await user.type(screen.getByRole('searchbox', { name: 'Search saved conversations' }), 'READ');
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByRole('button', { name: /^Reading list/ })).toBeTruthy();
  await user.type(screen.getByRole('searchbox', { name: 'Search saved conversations' }), 'zzz');
  expect(screen.getByText('No conversation matches that title.')).toBeTruthy();
});

it('renames from the row: Enter saves and Escape cancels', async () => {
  const { execute, user } = setup();
  await open(user);
  await user.click(screen.getByRole('button', { name: 'Rename Plan' }));
  const field = screen.getByRole('textbox', { name: 'Conversation title' });
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('textbox', { name: 'Conversation title' })).toBeNull();
  expect(execute).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Rename Plan' }));
  const again = screen.getByRole('textbox', { name: 'Conversation title' });
  expect(field).not.toBe(again);
  await user.clear(again);
  await user.type(again, '  Sprint review{Enter}');
  await waitFor(() => {
    expect(execute).toHaveBeenCalledTimes(2);
  });
  expect(execute.mock.calls[1]?.[0]).toMatchObject({
    body: { operation: 'rename', historyId: PLAN, text: 'Sprint review' },
  });
});

it('continues an archived conversation and hands the worker answer to the caller', async () => {
  const onResumed = vi.fn();
  const { execute, user } = setup({ onResumed });
  await open(user);
  await user.click(screen.getByRole('button', { name: /^Plan/ }));
  await screen.findByText('You: Keep this plan');
  expect(screen.getByText('Your current conversation is saved to history.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Continue this conversation' }));
  await waitFor(() => {
    expect(onResumed).toHaveBeenCalledTimes(1);
  });
  expect(execute.mock.calls[2]?.[0]).toMatchObject({
    body: { operation: 'resume_history', historyId: PLAN },
  });
  expect(onResumed.mock.calls[0]?.[0]).toMatchObject({ status: 'connected' });
});

it('cannot continue another conversation while a turn is running', async () => {
  const { user } = setup({ running: true });
  await open(user);
  await user.click(screen.getByRole('button', { name: /^Plan/ }));
  await screen.findByText('You: Keep this plan');
  const resume = screen.getByRole('button', { name: 'Continue this conversation' });
  expect((resume as HTMLButtonElement).disabled).toBe(true);
});
