import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';

/**
 * Exporting, from the application rather than from a module nobody reaches.
 *
 * The dialog and the request module existed for a long time with nothing mounting them, which meant
 * the feature was complete in every sense except being usable. This is the test that would have
 * failed then, and the one that fails again if the control is ever removed.
 */

beforeEach(() => {
  signedIn();
});

const NOTE = item({
  id: '3c3c3c3c-3333-4333-8333-3c3c3c3c3c3c',
  title: 'Quarterly Review',
});

describe('exporting the document being read', () => {
  it('offers Export through the item actions menu', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    expect(screen.queryByRole('menuitem', { name: 'Export' })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Item actions' }));
    expect(screen.getByRole('menuitem', { name: 'Export' })).toBeVisible();
  });

  it('opens the dialog, which asks for a format before anything else', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await userEvent.click(await screen.findByRole('button', { name: 'Item actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Export' }));

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Format' })).toBeInTheDocument();
    });
  });

  it('does not ask what to include for an item with nothing inside it', async () => {
    // One honest answer, so it is not offered as a question.
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await userEvent.click(await screen.findByRole('button', { name: 'Item actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Export' }));

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Format' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('group', { name: 'What to export' })).not.toBeInTheDocument();
  });
  it('supports keyboard discovery and restores focus after cancelling export', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);
    const actions = await screen.findByRole('button', { name: 'Item actions' });
    actions.focus();
    await user.keyboard('{ArrowDown}');
    const menu = screen.getByRole('menu', { name: 'Item actions' });
    expect(within(menu).getAllByRole('menuitem')[0]).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(actions).toHaveFocus();
    await user.click(actions);
    await user.click(screen.getByRole('menuitem', { name: 'Export' }));
    const dialog = await screen.findByRole('dialog', { name: /export/i });
    const close = within(dialog).getAllByRole('button', { name: 'Close' })[0];
    if (!close) throw new Error('The export dialog must offer a close control');
    await user.click(close);
    await waitFor(() => {
      expect(actions).toHaveFocus();
    });
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Quarterly Review');
  });
});
