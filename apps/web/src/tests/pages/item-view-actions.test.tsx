import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { aView } from '@nix/web-collections/testing/view-fixture';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { App } from '../../app';

const parent = item({
  id: '319fe4e9-5de4-4561-842c-0c4f76f7f5d4',
  title: 'Product launch',
  hasChildren: true,
});
const child = item({
  id: '419fe4e9-5de4-4561-842c-0c4f76f7f5d4',
  parentId: parent.id,
  title: 'Landing page',
  properties: { status: 'Doing' },
});
const status = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['Doing', 'Done'],
  required: false,
};
const list = aView({ id: 'list', name: 'List' });
const board = aView({ id: 'board', name: 'Board', kind: 'board', groupBy: status.key });

function setup(views = [list, board]) {
  return stubCoreApi({
    items: [parent, child],
    views: { [parent.id]: { views, default: views.length > 0 ? 'list' : 'document' } },
    schemas: { [parent.id]: { properties: [status], declared: [status], inherit: true } },
  });
}

beforeEach(() => {
  signedIn();
  stubViewport(true);
});

it('opens the existing guided setup from the view bar of a plain note', async () => {
  setup([]);
  const user = userEvent.setup();
  renderAt(<App />, `/?item=${parent.id}`);
  await user.click(await screen.findByRole('button', { name: 'Add view' }));
  await user.click(await screen.findByRole('menuitem', { name: 'List' }));
  expect(await screen.findByRole('textbox', { name: 'Name' })).toBeVisible();
});

it('hides, restores and removes a different view without leaving the selected view', async () => {
  setup();
  const user = userEvent.setup();
  renderAt(<App />, `/?item=${parent.id}`);
  const tabs = within(await screen.findByRole('navigation', { name: 'Views' }));
  await user.click(await tabs.findByRole('button', { name: 'Board options' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Hide from tabs' }));
  expect(tabs.queryByRole('button', { name: 'Board' })).not.toBeInTheDocument();
  expect(tabs.getByRole('button', { name: 'List' })).toHaveAttribute('aria-current', 'page');
  await user.click(tabs.getByRole('button', { name: 'List options' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Show Board' }));
  await user.click(tabs.getByRole('button', { name: 'Board options' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Remove view' }));
  await waitFor(() =>
    expect(tabs.queryByRole('button', { name: 'Board' })).not.toBeInTheDocument(),
  );
  const notice = (await screen.findByText('Removed Board')).closest('[role="status"]');
  if (!(notice instanceof HTMLElement)) throw new Error('Missing Undo notice');
  await user.click(within(notice).getByRole('button', { name: /^Undo/ }));
  expect(await tabs.findByRole('button', { name: 'Board' })).toBeVisible();
  expect(tabs.getByRole('button', { name: 'List' })).toHaveAttribute('aria-current', 'page');
});

it('can open the hidden Document from Item actions and restore its tab', async () => {
  setup();
  const user = userEvent.setup();
  renderAt(<App />, `/?item=${parent.id}`);
  const tabs = within(await screen.findByRole('navigation', { name: 'Views' }));
  await user.click(await tabs.findByRole('button', { name: 'Document options' }));
  expect(screen.queryByRole('menuitem', { name: 'Remove view' })).not.toBeInTheDocument();
  await user.click(await screen.findByRole('menuitem', { name: 'Hide from tabs' }));
  expect(tabs.queryByRole('button', { name: 'Document' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Item actions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Open document' }));
  expect(await screen.findByRole('button', { name: 'Bold' })).toBeVisible();
  await user.click(tabs.getByRole('button', { name: 'List options' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Show Document' }));
  expect(tabs.getByRole('button', { name: 'Document' })).toHaveAttribute('aria-current', 'page');
});

it('requests suggestions with field definitions and saves only a suggestion the user previews and adds', async () => {
  setup();
  const fetch = globalThis.fetch;
  const writes: unknown[] = [];
  const requests: unknown[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/pets/inline')) {
      requests.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      const text = JSON.stringify([
        {
          name: 'In progress',
          reason: 'Focus on tasks under way.',
          kind: 'list',
          filter: { key: 'status', values: ['Doing'] },
        },
        { name: 'Invalid', reason: 'Unknown field.', kind: 'board', groupBy: 'unknown' },
      ]);
      return Promise.resolve(
        new Response(`event: done\ndata: ${JSON.stringify({ text })}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    }
    if (url.endsWith('/views') && init?.method === 'PUT') {
      writes.push(JSON.parse(typeof init.body === 'string' ? init.body : '{}'));
    }
    return fetch(input, init);
  });
  const user = userEvent.setup();
  renderAt(<App />, `/?item=${parent.id}`);
  await user.click(await screen.findByRole('button', { name: 'Add view' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Suggest views' }));
  const suggestions = within(await screen.findByRole('dialog', { name: 'Suggested views' }));
  await user.click(await suggestions.findByRole('button', { name: /In progress/ }));
  const preview = within(await screen.findByRole('region', { name: 'Suggested view preview' }));
  expect(preview.getByText('Landing page')).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests[0])).toContain('status');
  expect(JSON.stringify(requests[0])).not.toContain('Landing page');
  expect(writes).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'Add suggested view' }));
  const tab = await screen.findByRole('button', { name: 'In progress' });
  await waitFor(() => expect(tab).toHaveAttribute('aria-current', 'page'));
  expect(writes).toHaveLength(1);
  expect(writes[0]).toHaveProperty('default', 'list');
  expect(writes[0]).toHaveProperty('views.2.name', 'In progress');
  expect(writes[0]).toHaveProperty('views.2.kind', 'list');
});
