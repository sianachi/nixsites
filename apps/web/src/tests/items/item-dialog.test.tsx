import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { App } from '../../app';
import { item, stubCoreApi, STUB_WORKSPACE_ID } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { aView } from '@nix/web-collections/testing/view-fixture';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';

beforeEach(() => {
  signedIn();
  stubViewport(true);
});

it('opens a child over its parent and closes back to the same view', async () => {
  const root = item({
    id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    title: 'Project',
    hasChildren: true,
  });
  const child = item({
    id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    title: 'Plan',
    parentId: root.id,
  });
  stubCoreApi({
    items: [root, child],
    views: { [root.id]: { views: [aView({ name: 'List' })], default: 'document' } },
  });
  const user = userEvent.setup();
  renderAt(<App />, `/?item=${root.id}&view=view-1`);
  await screen.findByRole('textbox', { name: 'Note title' });
  await user.click(
    await within(await screen.findByRole('region', { name: 'Container' })).findByRole('button', {
      name: 'Plan',
    }),
  );
  const dialog = await screen.findByRole('dialog', { name: 'Plan' });
  expect(within(dialog).getByRole('textbox', { name: 'Note title' })).toHaveValue('Plan');
  expect(within(dialog).getByRole('button', { name: 'Open as page' })).toBeInTheDocument();
  expect(
    within(screen.getByRole('tree', { name: 'Items' })).queryByRole('button', { name: 'Plan' }),
  ).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Item actions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Bookmark' }));
  expect(
    await within(screen.getByRole('tree', { name: 'Items' })).findByRole('button', {
      name: 'Plan',
    }),
  ).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Close item' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Project');
  expect(
    within(screen.getByRole('region', { name: 'Container' })).getByRole('button', { name: 'Plan' }),
  ).toBeInTheDocument();
});

it('opens a board note on Comments inside the item dialog and can switch to Document', async () => {
  const board = item({
    id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    title: 'Project',
    hasChildren: true,
  });
  const card = item({
    id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    title: 'Plan',
    parentId: board.id,
    properties: { stage: 'Doing' },
  });
  const stage = {
    key: 'stage',
    label: 'Stage',
    type: 'select',
    options: ['Doing'],
    required: false,
  };
  stubCoreApi({
    items: [board, card],
    views: {
      [board.id]: {
        views: [aView({ name: 'Board', kind: 'board', groupBy: stage.key })],
        default: 'view-1',
      },
      [card.id]: { views: [aView({ name: 'List' })], default: 'view-1' },
    },
    schemas: { [board.id]: { properties: [stage], declared: [stage], inherit: true } },
  });
  const fetch = globalThis.fetch;
  const posted = 'The plan is ready.';
  const id = 'cccccccc-3333-4333-8333-cccccccccccc';
  const thread = {
    id,
    anchorStart: null,
    anchorEnd: null,
    quote: null,
    resolvedAt: null,
    resolvedBy: null,
    resolvedByName: null,
    comments: [
      {
        id,
        authorId: id,
        authorName: 'Ada',
        body: posted,
        mentionIds: [],
        createdAt: '2026-11-11T12:00:00Z',
        editedAt: null,
        importedAuthor: null,
        deleted: false,
      },
    ],
  };
  let sent = false;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith(`/items/${card.id}/comments`)) {
      if (init?.method === 'POST') {
        expect(init.body).toBe(JSON.stringify({ body: posted, mentionIds: [] }));
        sent = true;
        return Promise.resolve(Response.json(thread));
      }
      if (sent)
        return Promise.resolve(Response.json({ revision: 1, threads: [thread], canComment: true }));
    }
    return fetch(input, init);
  });
  const user = userEvent.setup();
  renderAt(<App />, `/?item=${board.id}&view=view-1`);
  await user.click(
    await within(await screen.findByRole('region', { name: 'Container' })).findByRole('button', {
      name: 'Plan',
    }),
  );
  const dialog = within(await screen.findByRole('dialog', { name: 'Plan' }));
  expect(await dialog.findByRole('textbox', { name: 'Write a comment' })).toBeVisible();
  expect(dialog.getByRole('button', { name: 'Comments' })).toHaveAttribute('aria-current', 'page');
  await user.type(dialog.getByRole('textbox', { name: 'Write a comment' }), posted);
  await user.click(dialog.getByRole('button', { name: 'Post' }));
  expect(await dialog.findByText(posted)).toBeVisible();
  await user.click(dialog.getByRole('button', { name: 'Document' }));
  expect(dialog.queryByRole('region', { name: 'Comments' })).not.toBeInTheDocument();
  expect(dialog.getByRole('button', { name: 'Document' })).toHaveAttribute('aria-current', 'page');
  await user.click(dialog.getByRole('button', { name: 'Close item' }));
  expect(screen.getByRole('region', { name: 'Container' })).toBeVisible();
});

it('closes an item dialog when focusing the graph at the same address', async () => {
  const note = item({ id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', title: 'Plan' });
  stubCoreApi({ items: [note] });
  const user = userEvent.setup();
  renderAt(<App />, `/w/${STUB_WORKSPACE_ID}/graph?focus=${note.id}`);
  await user.click(await screen.findByRole('button', { name: 'Browse connections' }));
  await user.click(
    within(screen.getByRole('region', { name: 'Graph connections' })).getByRole('button', {
      name: /^Plan$/,
    }),
  );
  const dialog = await screen.findByRole('dialog', { name: 'Plan' });
  await user.click(within(dialog).getByRole('button', { name: 'Item actions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Focus in graph' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Graph connections' })).toBeVisible();
});
