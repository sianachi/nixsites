import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';

import { PetSiteSessionForm } from '../../pages/pet-site-session-form';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const client = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => client,
}));

function setup(disabled = false) {
  const onRegistered = vi.fn();
  render(
    <PetSiteSessionForm
      workspaceId={workspaceId}
      disabled={disabled}
      onRegistered={onRegistered}
    />,
  );
  return { user: userEvent.setup(), onRegistered };
}

function cookie(index: number) {
  return within(screen.getByRole('group', { name: `Session cookie ${String(index)}` }));
}

async function fillCookie(
  user: ReturnType<typeof userEvent.setup>,
  index: number,
  name: string,
  value: string,
  path = '/',
) {
  const fields = cookie(index);
  await user.type(fields.getByRole('textbox', { name: 'Name' }), name);
  await user.type(fields.getByLabelText(/^Value/), value);
  await user.clear(fields.getByRole('textbox', { name: 'Path' }));
  await user.type(fields.getByRole('textbox', { name: 'Path' }), path);
}

beforeEach(() => {
  vi.resetAllMocks();
  client.execute.mockResolvedValue({ id: 'session-connection' });
});

it('uses labelled cookie fields with concealed values instead of a JSON input', () => {
  setup();
  expect(cookie(1).getByRole('textbox', { name: 'Name' })).toBeRequired();
  expect(cookie(1).getByLabelText(/^Value/)).toHaveAttribute('type', 'password');
  expect(cookie(1).getByLabelText(/^Value/)).toHaveAttribute('autocomplete', 'off');
  expect(cookie(1).getByRole('textbox', { name: 'Path' })).toHaveValue('/');
  expect(screen.queryByText(/JSON/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Session cookies')).not.toBeInTheDocument();
});

it('sends the existing typed payload from two cookie rows and clears only after success', async () => {
  const { user, onRegistered } = setup();
  await user.type(screen.getByRole('textbox', { name: 'HTTPS origin' }), 'https://example.com');
  await fillCookie(user, 1, 'session', 'synthetic-value-one');
  await user.click(screen.getByRole('button', { name: 'Add cookie' }));
  expect(cookie(2).getByRole('textbox', { name: 'Name' })).toHaveFocus();
  await fillCookie(user, 2, 'account', ' synthetic value two ', '/account');
  await user.click(screen.getByLabelText('Allow reviewed form submissions'));
  await user.click(screen.getByRole('button', { name: 'Connect website session' }));

  expect(client.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      method: 'POST',
      path: `/api/v1/workspaces/${workspaceId}/pet-connections/browser-site`,
      body: {
        origin: 'https://example.com',
        cookies: [
          { name: 'session', value: 'synthetic-value-one', path: '/' },
          { name: 'account', value: ' synthetic value two ', path: '/account' },
        ],
        allowSubmissions: true,
      },
    }),
  );
  expect(await screen.findByRole('status')).toHaveTextContent('Website session connected.');
  expect(onRegistered).toHaveBeenCalledOnce();
  expect(screen.getAllByRole('group', { name: /Session cookie/ })).toHaveLength(1);
  expect(cookie(1).getByRole('textbox', { name: 'Name' })).toHaveValue('');
  expect(cookie(1).getByLabelText(/^Value/)).toHaveValue('');
  expect(screen.queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument();
});

it('keeps the draft and submission choice when a held connection fails, then retries the same data', async () => {
  let reject: ((reason: Error) => void) | undefined;
  const response = new Promise<{ id: string }>((_resolve, refuse) => {
    reject = refuse;
  });
  client.execute.mockReturnValueOnce(response);
  const { user, onRegistered } = setup();
  await user.type(screen.getByRole('textbox', { name: 'HTTPS origin' }), 'https://example.com');
  await fillCookie(user, 1, 'session', 'synthetic-secret-value', '/private');
  await user.click(screen.getByLabelText('Allow reviewed form submissions'));
  await user.click(screen.getByRole('button', { name: 'Connect website session' }));

  expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled();
  expect(cookie(1).getByLabelText(/^Value/)).toBeDisabled();
  expect(screen.getByLabelText('Allow reviewed form submissions')).toBeChecked();
  expect(screen.getByRole('button', { name: 'Add cookie' })).toBeDisabled();
  expect(onRegistered).not.toHaveBeenCalled();

  await act(() => {
    reject?.(new Error('Synthetic connection failure'));
    return response.catch(() => undefined);
  });
  expect(screen.getByRole('alert')).not.toHaveTextContent('synthetic-secret-value');
  expect(screen.getByRole('textbox', { name: 'HTTPS origin' })).toHaveValue('https://example.com');
  expect(cookie(1).getByRole('textbox', { name: 'Name' })).toHaveValue('session');
  expect(cookie(1).getByLabelText(/^Value/)).toHaveValue('synthetic-secret-value');
  expect(cookie(1).getByLabelText(/^Value/)).toHaveAttribute('type', 'password');
  expect(cookie(1).getByRole('textbox', { name: 'Path' })).toHaveValue('/private');
  expect(screen.getByLabelText('Allow reviewed form submissions')).toBeChecked();

  await user.click(screen.getByRole('button', { name: 'Connect website session' }));
  expect(client.execute).toHaveBeenCalledTimes(2);
  expect(client.execute.mock.calls[1]?.[0]).toEqual(client.execute.mock.calls[0]?.[0]);
  expect(onRegistered).toHaveBeenCalledOnce();
});

it('restores a removed row in place without losing later edits or exposing its value in the notice', async () => {
  const { user } = setup();
  await fillCookie(user, 1, 'first', 'synthetic-first-secret', '/first');
  await user.click(screen.getByRole('button', { name: 'Add cookie' }));
  await fillCookie(user, 2, 'second', 'synthetic-second-secret', '/second');
  await user.click(cookie(1).getByRole('button', { name: 'Remove cookie' }));
  expect(screen.getByRole('button', { name: 'Add cookie' })).toHaveFocus();
  expect(screen.getByRole('status')).not.toHaveTextContent('synthetic-first-secret');
  await user.clear(cookie(1).getByRole('textbox', { name: 'Name' }));
  await user.type(cookie(1).getByRole('textbox', { name: 'Name' }), 'second edited');
  await user.click(screen.getByRole('button', { name: /^Undo/ }));

  expect(cookie(1).getByRole('textbox', { name: 'Name' })).toHaveValue('first');
  expect(cookie(1).getByRole('textbox', { name: 'Name' })).toHaveFocus();
  expect(cookie(1).getByLabelText(/^Value/)).toHaveValue('synthetic-first-secret');
  expect(cookie(1).getByRole('textbox', { name: 'Path' })).toHaveValue('/first');
  expect(cookie(2).getByRole('textbox', { name: 'Name' })).toHaveValue('second edited');
  expect(cookie(2).getByLabelText(/^Value/)).toHaveValue('synthetic-second-secret');
});

it('shows field validation without sending or clearing invalid values', async () => {
  const { user } = setup();
  await user.type(
    screen.getByRole('textbox', { name: 'HTTPS origin' }),
    'https://example.com/a/path',
  );
  await user.type(cookie(1).getByLabelText(/^Value/), 'short');
  await user.clear(cookie(1).getByRole('textbox', { name: 'Path' }));
  await user.type(cookie(1).getByRole('textbox', { name: 'Path' }), 'private');
  fireEvent.submit(screen.getByRole('form', { name: 'Website session' }));

  expect(screen.getByRole('textbox', { name: 'HTTPS origin' })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  expect(cookie(1).getByRole('textbox', { name: 'Name' })).toHaveAttribute('aria-invalid', 'true');
  expect(cookie(1).getByLabelText(/^Value/)).toHaveAttribute('aria-invalid', 'true');
  expect(cookie(1).getByRole('textbox', { name: 'Path' })).toHaveAttribute('aria-invalid', 'true');
  expect(cookie(1).getByLabelText(/^Value/)).toHaveValue('short');
  expect(client.execute).not.toHaveBeenCalled();
  expect(
    screen
      .getAllByRole('alert')
      .map((alert) => alert.textContent)
      .join(' '),
  ).not.toMatch(/JSON|short/);
});

it('undoes several row changes from the form keyboard path without intercepting text editing', async () => {
  const { user } = setup();
  await fillCookie(user, 1, 'first', 'synthetic-first-secret');
  await user.click(screen.getByRole('button', { name: 'Add cookie' }));
  await fillCookie(user, 2, 'second', 'synthetic-second-secret');
  await user.click(cookie(1).getByRole('button', { name: 'Remove cookie' }));
  await user.keyboard('{Control>}z{/Control}');
  expect(cookie(1).getByRole('textbox', { name: 'Name' })).toHaveValue('first');
  expect(cookie(2).getByRole('textbox', { name: 'Name' })).toHaveValue('second');

  screen.getByRole('button', { name: 'Add cookie' }).focus();
  await user.keyboard('{Control>}z{/Control}');
  expect(screen.getAllByRole('group', { name: /Session cookie/ })).toHaveLength(1);
  expect(cookie(1).getByRole('textbox', { name: 'Name' })).toHaveValue('first');
  cookie(1).getByRole('textbox', { name: 'Name' }).focus();
  await user.keyboard('{Control>}z{/Control}');
  expect(screen.getAllByRole('group', { name: /Session cookie/ })).toHaveLength(1);
});

it('preserves the existing aggregate cookie-size limit', async () => {
  const { user } = setup();
  await user.type(screen.getByRole('textbox', { name: 'HTTPS origin' }), 'https://example.com');
  for (let index = 1; index <= 9; index++) {
    if (index > 1) await user.click(screen.getByRole('button', { name: 'Add cookie' }));
    fireEvent.change(cookie(index).getByRole('textbox', { name: 'Name' }), {
      target: { value: `cookie${String(index)}` },
    });
    fireEvent.change(cookie(index).getByLabelText(/^Value/), {
      target: { value: 'x'.repeat(4000) },
    });
  }
  fireEvent.submit(screen.getByRole('form', { name: 'Website session' }));
  expect(screen.getByRole('alert')).toHaveTextContent(/fewer|shorter/i);
  expect(client.execute).not.toHaveBeenCalled();
  expect(cookie(9).getByLabelText(/^Value/)).toHaveValue('x'.repeat(4000));
});

it('limits the number of cookie rows to 32', async () => {
  const { user } = setup();
  for (let index = 1; index < 32; index++) {
    await user.click(screen.getByRole('button', { name: 'Add cookie' }));
  }
  expect(screen.getAllByRole('group', { name: /Session cookie/ })).toHaveLength(32);
  expect(screen.getByRole('button', { name: 'Add cookie' })).toBeDisabled();
});
