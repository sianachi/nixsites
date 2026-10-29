import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
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
  await user.click(within(dialog).getByRole('button', { name: 'Bookmark Plan' }));
  expect(
    await within(screen.getByRole('region', { name: 'Pinned items' })).findByRole('button', {
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
