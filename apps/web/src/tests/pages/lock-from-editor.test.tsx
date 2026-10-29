import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';

/**
 * A locked note, from the application: the prompt stands where the body would be, the controls that
 * reach the body are withheld, and the right password brings them back.
 */

beforeEach(() => {
  signedIn();
});

const NOTE = item({
  id: '5e5e5e5e-5555-4555-8555-5e5e5e5e5e5e',
  title: 'Diary',
});

describe('a locked note, from the page', () => {
  it('shows the password prompt instead of the body, and no history', async () => {
    stubCoreApi({ items: [NOTE], lockedItems: [NOTE.id] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    expect(await screen.findByRole('heading', { name: 'Diary is locked' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Lock/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Item actions' }));
    expect(screen.queryByRole('menuitem', { name: /^History$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Lock/ })).not.toBeInTheDocument();
  });

  it('opens with the right password and offers the lock controls again', async () => {
    stubCoreApi({ items: [NOTE], lockedItems: [NOTE.id] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await userEvent.type(await screen.findByLabelText('Password'), 'hunter22');
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Diary is locked' })).not.toBeInTheDocument();
    });
    const actions = screen.getByRole('button', { name: 'Item actions' });
    // Unlock restores focus to the persistent control containing the lock action.
    await waitFor(() => {
      expect(actions).toHaveFocus();
    });
    await userEvent.click(actions);
    expect(await screen.findByRole('menuitem', { name: /^History$/ })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /^Lock settings, open until / })).toBeVisible();
  });

  it('offers to lock a note that has no lock', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await userEvent.click(await screen.findByRole('button', { name: 'Item actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Lock this note' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Diary is locked' })).not.toBeInTheDocument();
  });
});

const FOLDER = item({
  id: '6f6f6f6f-6666-4666-8666-6f6f6f6f6f6f',
  title: 'Journal',
  hasChildren: true,
});

const ENTRY = item({
  id: '7a7a7a7a-7777-4777-8777-7a7a7a7a7a7a',
  title: 'Monday entry',
  parentId: FOLDER.id,
});

describe('a lock covers what is inside the locked item', () => {
  it("keeps a locked folder's contents off the page and out of the sidebar", async () => {
    stubCoreApi({ items: [FOLDER, ENTRY], lockedItems: [FOLDER.id] });
    renderAt(<App />, `/?item=${FOLDER.id}`);

    expect(await screen.findByRole('heading', { name: 'Journal is locked' })).toBeInTheDocument();
    expect(screen.queryByText('Monday entry')).not.toBeInTheDocument();
  });

  it('says a locked folder is locked in the sidebar instead of showing it empty', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [FOLDER, ENTRY], lockedItems: [FOLDER.id] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /expand journal/i }));

    // Said rather than reported: a lock is not a failure to load, and not an empty folder.
    expect(await screen.findByText('Locked. Open it to unlock.')).toBeInTheDocument();
    expect(screen.queryByText('Empty')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Monday entry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("asks for the folder's password on a note inside it, and opens with it", async () => {
    stubCoreApi({ items: [FOLDER, ENTRY], lockedItems: [FOLDER.id] });
    renderAt(<App />, `/?item=${ENTRY.id}`);

    expect(
      await screen.findByRole('heading', { name: 'Monday entry is locked' }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/It is inside Journal, which is locked/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Password'), 'hunter22');
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: 'Monday entry is locked' }),
      ).not.toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Item actions' }));
    expect(await screen.findByRole('menuitem', { name: /^History$/ })).toBeVisible();
  });
});
