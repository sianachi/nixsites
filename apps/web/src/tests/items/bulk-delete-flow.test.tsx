import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';

import { App } from '../../app';
import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';

beforeEach(() => {
  signedIn();
});

const FIRST = item({ id: '5a5a5a5a-1111-4111-8111-5a5a5a5a5a5a', title: 'Alpha' });
const SECOND = item({ id: '5b5b5b5b-1111-4111-8111-5b5b5b5b5b5b', title: 'Beta' });
const THIRD = item({ id: '5c5c5c5c-1111-4111-8111-5c5c5c5c5c5c', title: 'Gamma' });

async function selectAll(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await screen.findByRole('button', { name: 'Alpha' });
  screen.getByRole('button', { name: 'Alpha' }).focus();
  await user.keyboard('{Control>}a{/Control}');
  expect(await screen.findByText('3 selected')).toBeVisible();
  return screen.getByRole('toolbar', { name: 'Selected items' });
}

function requests(method: string): string[] {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.map(([input, init]) => [input, init] as const)
    .filter(([, init]) => init?.method === method)
    .map(([input]) => (input instanceof Request ? input.url : String(input)));
}

it('deletes a whole selection behind one confirm and brings it all back with one Undo', async () => {
  const user = userEvent.setup();
  stubCoreApi({ items: [FIRST, SECOND, THIRD] });
  renderAt(<App />);

  const tray = await selectAll(user);
  await user.click(within(tray).getByRole('button', { name: 'Delete' }));

  const dialog = await screen.findByRole('dialog', { name: 'Delete 3 items?' });
  await user.click(within(dialog).getByRole('button', { name: 'Delete 3 items' }));

  const toast = await screen.findByRole('status');
  expect(toast).toHaveTextContent('Deleted 3 items');
  expect(screen.queryByRole('button', { name: 'Alpha' })).not.toBeInTheDocument();
  expect(screen.queryByRole('toolbar', { name: 'Selected items' })).not.toBeInTheDocument();
  expect(requests('DELETE')).toHaveLength(3);

  await user.click(within(toast).getByRole('button', { name: 'Undo' }));
  expect(await screen.findByRole('button', { name: 'Alpha' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Beta' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Gamma' })).toBeInTheDocument();
  await waitFor(() => {
    expect(requests('POST').filter((url) => url.endsWith('/restore'))).toHaveLength(3);
  });
});

it('keeps the selection and deletes nothing when the confirm is cancelled', async () => {
  const user = userEvent.setup();
  stubCoreApi({ items: [FIRST, SECOND, THIRD] });
  renderAt(<App />);

  const tray = await selectAll(user);
  await user.click(within(tray).getByRole('button', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete 3 items?' });
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  expect(screen.getByText('3 selected')).toBeVisible();
  expect(requests('DELETE')).toHaveLength(0);
});

it('names the first failure and its reason when part of a selection is refused', async () => {
  const user = userEvent.setup();
  stubCoreApi({ items: [FIRST, SECOND, THIRD], removeFails: true });
  renderAt(<App />);

  const tray = await selectAll(user);
  await user.click(within(tray).getByRole('button', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete 3 items?' });
  await user.click(within(dialog).getByRole('button', { name: 'Delete 3 items' }));

  expect(await screen.findByRole('status')).toHaveTextContent(
    'Deleted 0 of 3 items. "Alpha" could not be deleted: The item could not be deleted.',
  );
  expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
});
