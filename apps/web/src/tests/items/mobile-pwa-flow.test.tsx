import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { App } from '../../app';
import { item, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { aView } from '../view-fixture';
import { stubViewport } from '../stub-viewport';
import { memoryStorage } from '../memory-storage';

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
beforeEach(() => {
  signedIn();
  stubViewport(false);
});
it('returns focus to the workspace control after importing from the mobile drawer', async () => {
  const user = userEvent.setup();
  stubCoreApi({ items: [root] });
  renderAt(<App />, `/?item=${root.id}`);
  await screen.findByRole('textbox', { name: 'Note title' });
  const workspace = screen.getByRole('button', { name: 'Show the workspace tree' });
  await user.click(workspace);
  await user.click(screen.getByRole('button', { name: /^Notes$/ }));
  const back = vi.spyOn(window.history, 'back');
  await user.click(screen.getByRole('menuitem', { name: 'Import' }));
  const dialog = await screen.findByRole('dialog', { name: /^Import$/ });
  expect(back).not.toHaveBeenCalled();
  back.mockRestore();
  await user.click(within(dialog).getByRole('button', { name: /^Close$/ }));
  await waitFor(() => {
    expect(workspace).toHaveFocus();
  });
});
it('chooses and retains a personal landmark from mobile item actions', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('localStorage', memoryStorage());
  stubCoreApi({ items: [root] });
  renderAt(<App />, `/?item=${root.id}`);
  await screen.findByRole('textbox', { name: 'Note title' });
  await user.click(screen.getByRole('button', { name: 'Workspace' }));
  await user.click(screen.getByRole('button', { name: 'Actions for Project' }));
  await user.click(screen.getByRole('menuitem', { name: 'Choose icon…' }));
  const dialog = screen.getByRole('dialog', { name: 'Icon for Project' });
  await user.click(within(dialog).getByRole('button', { name: 'Briefcase' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save icon' }));
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Actions for Project' })).toHaveFocus();
  });
  await user.click(screen.getByRole('button', { name: 'Actions for Project' }));
  await user.click(screen.getByRole('menuitem', { name: 'Choose icon…' }));
  expect(screen.getByRole('button', { name: 'Briefcase' })).toHaveAttribute('aria-pressed', 'true');
});
it('opens list items as pages, and the parent button returns to the parent', async () => {
  stubCoreApi({
    items: [root, child],
    views: { [root.id]: { views: [aView({ name: 'List' })], default: 'document' } },
  });
  renderAt(<App />, `/?item=${root.id}`);
  await screen.findByRole('textbox', { name: 'Note title' });
  await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'View' }), 'List');
  await userEvent.click(
    await within(await screen.findByRole('region', { name: 'Container' })).findByRole('button', {
      name: 'Plan',
    }),
  );
  expect(await screen.findByRole('textbox', { name: 'Note title' })).toHaveValue('Plan');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  // No Back button on a phone: history could lead out to the sign-in redirect. The parent's own
  // button is the way up, and it never leaves the workspace.
  expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Project' }));
  expect(await screen.findByRole('textbox', { name: 'Note title' })).toHaveValue('Project');
});
it('keeps a dismissed capture title and creates in the selected destination', async () => {
  stubCoreApi({
    items: [root, child],
    views: { [root.id]: { views: [aView({ name: 'List' })], default: 'document' } },
  });
  renderAt(<App />, `/?item=${root.id}`);
  await screen.findByRole('textbox', { name: 'Note title' });
  await userEvent.click(screen.getByRole('button', { name: 'New note' }));
  let dialog = screen.getByRole('dialog', { name: 'New note' });
  await userEvent.type(
    within(dialog).getByRole('textbox', { name: 'Note title' }),
    'Captured idea',
  );
  await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  await userEvent.click(screen.getByRole('button', { name: 'New note' }));
  dialog = screen.getByRole('dialog', { name: 'New note' });
  expect(within(dialog).getByRole('textbox', { name: 'Note title' })).toHaveValue('Captured idea');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create in: Workspace' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Project' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create note' }));
  await waitFor(() => {
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Captured idea');
  });
  await userEvent.click(screen.getByRole('button', { name: 'Project' }));
  await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'View' }), 'List');
  expect(
    await within(await screen.findByRole('region', { name: 'Container' })).findByRole('button', {
      name: 'Captured idea',
    }),
  ).toBeInTheDocument();
});
it('provides one-level browsing, without the desktop tree and its actions', async () => {
  stubCoreApi({
    items: [root, child],
    views: { [root.id]: { views: [aView({ name: 'List' })], default: 'document' } },
  });
  renderAt(<App />, `/?item=${root.id}`);
  await screen.findByRole('textbox', { name: 'Note title' });
  await userEvent.click(screen.getByRole('button', { name: 'Workspace' }));
  await userEvent.click(screen.getByRole('button', { name: 'Browse children of Project' }));
  expect(await screen.findByRole('button', { name: 'Plan' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Tree and actions' })).not.toBeInTheDocument();
  expect(screen.queryByRole('tree', { name: 'Items' })).not.toBeInTheDocument();
});

it('keeps Hide behind item actions and provides an explicit close control', async () => {
  const user = userEvent.setup();
  stubCoreApi({ items: [root, child] });
  renderAt(<App />, `/?item=${root.id}`);
  await screen.findByRole('textbox', { name: 'Note title' });
  await user.click(screen.getByRole('button', { name: 'Workspace' }));
  const browser = screen.getByRole('complementary', { name: 'Workspace' });
  expect(within(browser).queryByRole('button', { name: /Hide/ })).not.toBeInTheDocument();
  await user.click(within(browser).getByRole('button', { name: 'Actions for Project' }));
  await user.click(screen.getByRole('menuitem', { name: 'Hide for me' }));
  expect(within(browser).queryByRole('button', { name: 'Project' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(within(browser).getByRole('button', { name: 'Project' })).toBeVisible();
  await user.click(within(browser).getByRole('button', { name: 'Close workspace' }));
  expect(screen.queryByRole('complementary', { name: 'Workspace' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Show the workspace tree' })).toHaveFocus();
});

it('retains the capture title and reports a refused create without navigating', async () => {
  stubCoreApi({ items: [root], createRefusal: 'You cannot create here.' });
  renderAt(<App />, `/?item=${root.id}`);
  await screen.findByRole('textbox', { name: 'Note title' });
  await userEvent.click(screen.getByRole('button', { name: 'New note' }));
  const dialog = screen.getByRole('dialog', { name: 'New note' });
  await userEvent.type(
    within(dialog).getByRole('textbox', { name: 'Note title' }),
    'Keep this idea',
  );
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create note' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('You cannot create here.');
  expect(within(dialog).getByRole('textbox', { name: 'Note title' })).toHaveValue('Keep this idea');
});

it('moves an item through a destination sheet without dragging', async () => {
  const movable = { ...child };
  stubCoreApi({ items: [root, movable] });
  const fallback = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith(`/api/v1/items/${child.id}/move`) && init?.method === 'POST') {
      if (typeof init.body !== 'string') throw new Error('Expected a JSON move request.');
      expect(JSON.parse(init.body)).toEqual({ parentId: null, afterId: null });
      movable.parentId = null;
      return new Response(JSON.stringify(movable), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return fallback(input, init);
  });
  renderAt(<App />, `/?item=${child.id}`);
  await screen.findByRole('textbox', { name: 'Note title' });
  // A note's item actions live in its writing dock on a phone, not in a row under the title.
  await userEvent.click(await screen.findByRole('button', { name: 'Item' }));
  await userEvent.click(
    within(screen.getByRole('dialog', { name: 'Item actions' })).getByRole('button', {
      name: 'Move item',
    }),
  );
  const move = screen.getByRole('dialog', { name: 'Move item: choose a place' });
  await userEvent.click(within(move).getByRole('button', { name: 'Up one level' }));
  await userEvent.click(within(move).getByRole('button', { name: 'Choose position' }));
  await userEvent.click(
    within(screen.getByRole('dialog', { name: 'Move item: choose a position' })).getByRole(
      'button',
      { name: 'Move here' },
    ),
  );
  await waitFor(() => {
    expect(
      screen.queryByRole('dialog', { name: 'Move item: choose a position' }),
    ).not.toBeInTheDocument();
  });
  await userEvent.click(screen.getByRole('button', { name: 'Workspace' }));
  expect(await screen.findByRole('button', { name: 'Plan' })).toBeInTheDocument();
});

it("keeps a note's details and item actions in its writing dock, not under the title", async () => {
  stubCoreApi({ items: [root, child] });
  renderAt(<App />, `/?item=${child.id}`);
  await screen.findByRole('textbox', { name: 'Note title' });

  expect(screen.queryByRole('navigation', { name: 'Item sections' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Details' })).not.toBeInTheDocument();
  const item = await screen.findByRole('button', { name: 'Item' });
  await userEvent.click(item);
  const details = screen.getByRole('button', { name: 'Details' });
  expect(details).toHaveAttribute('aria-expanded', 'false');
  await userEvent.click(details);
  expect(screen.queryByRole('dialog', { name: 'Item actions' })).not.toBeInTheDocument();
  const dialog = screen.getByRole('dialog', { name: 'Item details' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(item).toHaveFocus();
});

it("puts an item's details and actions in its views strip, beside Body, with no row of their own", async () => {
  stubCoreApi({
    items: [root, child],
    views: { [root.id]: { views: [aView({ name: 'List' })], default: 'document' } },
  });
  renderAt(<App />, `/?item=${root.id}`);
  await screen.findByRole('textbox', { name: 'Note title' });

  expect(screen.queryByRole('navigation', { name: 'Item sections' })).not.toBeInTheDocument();
  // One place for all three: on a phone the strip's view picker offers Body first, and Details and the
  // actions sit at its end. The note's dock does not repeat them.
  const picker = await screen.findByRole('combobox', { name: 'View' });
  expect(within(picker).getByRole('option', { name: /^Body/ })).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Details' })).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Item actions' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Item' })).not.toBeInTheDocument();

  await userEvent.selectOptions(picker, 'List');
  expect(screen.getAllByRole('button', { name: 'Details' })).toHaveLength(1);
});
