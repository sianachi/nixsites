import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { expect, it, vi } from 'vitest';
import { petConnectionSchema } from '@nix/api-client';
import { PetHistory } from '../../pets/pet-history';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const PET = '22222222-2222-4222-8222-222222222222';
const PLAN = '33333333-3333-4333-8333-333333333333';
const BOOKS = '44444444-4444-4444-8444-444444444444';

const response = petConnectionSchema.parse({
  provider: 'anthropic',
  status: 'connected',
  reason: '',
  canConnect: false,
  history: [
    { id: PLAN, title: 'Plan', createdAt: '2026-09-06T12:00:00Z' },
    { id: BOOKS, title: 'Reading list', createdAt: '2026-09-05T12:00:00Z' },
  ],
  messages: [{ id: 'one', role: 'user', text: 'Keep this plan' }],
});

function setup(
  props: { running?: boolean; onResumed?: (value: unknown) => void } = {},
  initial: typeof response = response,
) {
  const execute = vi.fn().mockResolvedValue(initial);
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

function heldReply() {
  let resolve: (value: typeof response) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<typeof response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it('shows saving title until the rename reply arrives, then focuses its surviving control', async () => {
  const { execute, user } = setup();
  await open(user);
  const held = heldReply();
  execute.mockReturnValueOnce(held.promise);
  await user.click(screen.getByRole('button', { name: 'Rename Plan' }));
  await user.clear(screen.getByRole('textbox', { name: 'Conversation title' }));
  await user.type(screen.getByRole('textbox', { name: 'Conversation title' }), 'Sprint review');
  await user.click(screen.getByRole('button', { name: 'Save title' }));
  expect(screen.getByRole('button', { name: 'Saving title…' })).toBeDisabled();
  expect(screen.queryByText('Loading messages…')).toBeNull();
  await act(() => {
    held.resolve({
      ...response,
      history: (response.history ?? []).map((entry) =>
        entry.id === PLAN ? { ...entry, title: 'Sprint review' } : entry,
      ),
    });
    return held.promise;
  });
  expect(screen.queryByRole('textbox', { name: 'Conversation title' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Rename Sprint review' })).toHaveFocus();
});

it('shows deleting only after explicit confirmation and focuses the next row after its reply', async () => {
  const { execute, user } = setup();
  await open(user);
  const held = heldReply();
  execute.mockReturnValueOnce(held.promise);
  await user.click(screen.getByRole('button', { name: 'Remove Plan' }));
  expect(execute).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Delete saved conversation permanently' }));
  const remove = screen.getByRole('button', { name: 'Delete saved conversation permanently' });
  expect(remove).toHaveTextContent('Deleting…');
  expect(remove).toBeDisabled();
  expect(screen.getByRole('button', { name: /^Plan/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Keep conversation' })).toBeDisabled();
  await act(() => {
    held.resolve({
      ...response,
      history: (response.history ?? []).filter((entry) => entry.id !== PLAN),
    });
    return held.promise;
  });
  expect(screen.queryByRole('button', { name: /^Plan/ })).toBeNull();
  expect(screen.getByRole('button', { name: /^Reading list/ })).toHaveFocus();
});

it('shows continuing while the archive is being resumed without claiming messages are loading', async () => {
  const onResumed = vi.fn();
  const { execute, user } = setup({ onResumed });
  await open(user);
  await user.click(screen.getByRole('button', { name: /^Plan/ }));
  await screen.findByText('You: Keep this plan');
  const held = heldReply();
  execute.mockReturnValueOnce(held.promise);
  await user.click(screen.getByRole('button', { name: 'Continue this conversation' }));
  expect(screen.getByRole('button', { name: 'Continue this conversation' })).toHaveTextContent(
    'Continuing…',
  );
  expect(onResumed).not.toHaveBeenCalled();
  expect(screen.queryByText('Loading messages…')).toBeNull();
  await act(() => {
    held.resolve(response);
    return held.promise;
  });
  expect(onResumed).toHaveBeenCalledWith(response);
});

it('keeps a refused rename editable and restores its action label', async () => {
  const { execute, user } = setup();
  await open(user);
  const held = heldReply();
  execute.mockReturnValueOnce(held.promise);
  await user.click(screen.getByRole('button', { name: 'Rename Plan' }));
  await user.clear(screen.getByRole('textbox', { name: 'Conversation title' }));
  await user.type(screen.getByRole('textbox', { name: 'Conversation title' }), 'Sprint review');
  await user.click(screen.getByRole('button', { name: 'Save title' }));
  expect(screen.getByRole('button', { name: 'Saving title…' })).toBeDisabled();
  await act(() => {
    held.reject(new Error('Request refused'));
    return held.promise.catch(() => undefined);
  });
  expect(screen.getByRole('alert')).toHaveTextContent('Try again');
  expect(screen.getByRole('textbox', { name: 'Conversation title' })).toHaveValue('Sprint review');
  expect(screen.getByRole('button', { name: 'Save title' })).toBeEnabled();
});

it.each(['Escape', 'Cancel'])(
  'returns focus to Rename after cancelling with %s',
  async (action) => {
    const { user } = setup();
    await open(user);
    await user.click(screen.getByRole('button', { name: 'Rename Plan' }));
    if (action === 'Escape') await user.keyboard('{Escape}');
    else await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Conversation title' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Rename Plan' })).toHaveFocus();
  },
);

it('returns focus to Remove when the person keeps a saved conversation', async () => {
  const { execute, user } = setup();
  await open(user);
  await user.click(screen.getByRole('button', { name: 'Remove Plan' }));
  await user.click(screen.getByRole('button', { name: 'Keep conversation' }));
  expect(execute).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Remove Plan' })).toHaveFocus();
});

it('keeps focus in history after the last saved conversation is deleted', async () => {
  const { execute, user } = setup(
    {},
    {
      ...response,
      history: (response.history ?? []).filter((entry) => entry.id === PLAN),
    },
  );
  await open(user);
  execute.mockResolvedValueOnce({ ...response, history: [] });
  await user.click(screen.getByRole('button', { name: 'Remove Plan' }));
  await user.click(screen.getByRole('button', { name: 'Delete saved conversation permanently' }));
  await waitFor(() => {
    expect(screen.getByRole('region', { name: 'Companion history' })).toHaveFocus();
  });
});

it('focuses search when deleting the last conversation matching its current filter', async () => {
  const { execute, user } = setup();
  await open(user);
  const search = screen.getByRole('searchbox', { name: 'Search saved conversations' });
  await user.type(search, 'Plan');
  execute.mockResolvedValueOnce({
    ...response,
    history: (response.history ?? []).filter((entry) => entry.id !== PLAN),
  });
  await user.click(screen.getByRole('button', { name: 'Remove Plan' }));
  await user.click(screen.getByRole('button', { name: 'Delete saved conversation permanently' }));
  await waitFor(() => {
    expect(search).toHaveFocus();
  });
  expect(screen.getByText('No conversation matches that title.')).toBeInTheDocument();
});

it('loads history after StrictMode effect replay with an abort-aware client', async () => {
  const execute = vi.fn(
    (_endpoint: unknown, options?: { readonly signal?: AbortSignal | undefined }) => {
      const signal = options?.signal;
      return new Promise<typeof response>((resolve, reject) => {
        const abort = () => {
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
        queueMicrotask(() => {
          signal?.removeEventListener('abort', abort);
          if (!signal?.aborted) resolve(response);
        });
      });
    },
  );
  render(
    <StrictMode>
      <PetHistory
        client={{
          execute: async (endpoint, options) =>
            endpoint.schema.parse(await execute(endpoint, options)),
        }}
        workspaceId={WORKSPACE}
        petId={PET}
        name="Pip"
      />
    </StrictMode>,
  );
  await screen.findByRole('list', { name: 'Saved conversations' });
  const plan = screen.getByRole('button', { name: /^Plan/ });
  expect(plan).toBeEnabled();
  await userEvent.setup().click(plan);
  await screen.findByText('You: Keep this plan');
  expect(screen.getByRole('button', { name: 'Continue this conversation' })).toBeEnabled();
});
