import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import { item, stubCoreApi, STUB_WORKSPACE_ID } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { hiddenItemsKey, writeHiddenItems } from '@nix/web-foundation/lib/view-hidden-items';

const NOTE = item({ id: '1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e', title: 'Meeting notes' });

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  signedIn();
  stubViewport(true);
  writeHiddenItems(hiddenItemsKey('test-subject', STUB_WORKSPACE_ID), []);
  writeHiddenItems(hiddenItemsKey('test-subject', STUB_WORKSPACE_ID) + ':tree-children', []);
});

describe('hiding saved notes for yourself', () => {
  it('removes a note from everyday navigation while keeping it open and recoverable', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);
    expect(await screen.findByRole('textbox', { name: 'Note title' })).toHaveValue('Meeting notes');
    await user.click(screen.getByRole('button', { name: 'Item actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Hide for me' }));
    await waitFor(() => {
      expect(screen.queryByRole('tree', { name: 'Items' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Meeting notes');
    await user.click(screen.getByRole('button', { name: 'Item actions' }));
    expect(screen.getByRole('menuitem', { name: 'Show for me' })).toBeVisible();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Workspace options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Hidden items (1)' }));
    const manager = await screen.findByRole('region', { name: 'Hidden items' });
    await user.click(
      await within(manager).findByRole('button', { name: 'Show Meeting notes again' }),
    );
    expect(await screen.findByRole('tree', { name: 'Items' })).toHaveTextContent('Meeting notes');
  });

  it('keeps direct routes working for a hidden note after reopening the application', async () => {
    writeHiddenItems(hiddenItemsKey('test-subject', STUB_WORKSPACE_ID), [NOTE.id]);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);
    expect(await screen.findByRole('textbox', { name: 'Note title' })).toHaveValue('Meeting notes');
    await userEvent.click(screen.getByRole('button', { name: 'Item actions' }));
    expect(screen.getByRole('menuitem', { name: 'Show for me' })).toBeVisible();
  });
});

describe('children hidden only from the workspace tree', () => {
  const child = item({
    id: '2e2e2e2e-1111-4111-8111-2e2e2e2e2e2e',
    title: 'Agenda',
    parentId: NOTE.id,
  });
  it('removes already expanded children, keeps the parent, and restores them from item actions', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [{ ...NOTE, hasChildren: true }, child] });
    renderAt(<App />, `/?item=${NOTE.id}`);
    await screen.findByRole('textbox', { name: 'Note title' });
    await user.click(await screen.findByRole('button', { name: 'Expand Meeting notes' }));
    const tree = screen.getByRole('tree', { name: 'Items' });
    expect(await within(tree).findByRole('button', { name: 'Agenda' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Item actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Hide children from tree' }));
    expect(within(tree).getByRole('button', { name: 'Meeting notes' })).toBeVisible();
    expect(within(tree).queryByRole('button', { name: 'Agenda' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand Meeting notes' })).not.toBeInTheDocument();
    expect(within(tree).getByRole('treeitem')).not.toHaveAttribute('aria-expanded');
    await user.click(screen.getByRole('button', { name: 'Item actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Show children in tree' }));
    expect(await within(tree).findByRole('button', { name: 'Agenda' })).toBeVisible();
  });

  it('retains the setting on reopening while keeping child links accessible', async () => {
    writeHiddenItems(hiddenItemsKey('test-subject', STUB_WORKSPACE_ID) + ':tree-children', [
      NOTE.id,
    ]);
    stubCoreApi({ items: [{ ...NOTE, hasChildren: true }, child] });
    renderAt(<App />, `/?item=${child.id}`);
    expect(await screen.findByRole('textbox', { name: 'Note title' })).toHaveValue('Agenda');
    const tree = await screen.findByRole('tree', { name: 'Items' });
    expect(within(tree).getByRole('button', { name: 'Meeting notes' })).toBeVisible();
    expect(within(tree).queryByRole('button', { name: 'Agenda' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand Meeting notes' })).not.toBeInTheDocument();
  });
});
