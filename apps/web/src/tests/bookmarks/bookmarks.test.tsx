import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { App } from '../../app';
import { useBookmarksStore } from '@nix/web-collections/items/use-bookmarks';

/**
 * Bookmarks, driven through the whole application.
 *
 * The store is what makes this feature work and what could most easily break it: four places read
 * the same shelf at once, so the assertion that matters is not "the star filled in" but "the star
 * filled in *everywhere*". Rendering the real shell is the only way to check that.
 */

const NOTE = item({ id: '1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e', title: 'Acquisition memo' });
const OTHER = item({ id: '2e2e2e2e-2222-4222-8222-2e2e2e2e2e2e', title: 'Board pack' });

const KEPT = {
  itemId: NOTE.id,
  title: 'Acquisition memo',
  type: 'note',
  workspaceId: '00000000-0000-4000-8000-000000000001',
  keptAt: '2026-03-17T09:00:00+00:00',
};

beforeEach(() => {
  signedIn();
  stubViewport(true);

  // The store outlives a render, so a shelf left behind by one test would be the starting state of
  // the next. Reset explicitly rather than relying on module isolation.
  useBookmarksStore.setState({
    status: 'loading',
    items: [],
    keptIds: new Set<string>(),
    hidden: 0,
    error: null,
  });
});

describe('keeping an item', () => {
  it('offers a bookmark control on every row of the tree', async () => {
    stubCoreApi({ items: [NOTE, OTHER] });
    renderAt(<App />);

    expect(
      await within(await screen.findByRole('tree', { name: 'Items' })).findByRole('button', {
        name: 'Bookmark Acquisition memo',
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bookmark Board pack' })).toBeInTheDocument();
  });

  /**
   * A toggle button is a thing with a state, and a screen reader announces that state itself.
   * Swapping the accessible name between "Bookmark" and "Remove bookmark" would make one key press
   * sound like it did two different things.
   */
  it('says whether it is kept with aria-pressed rather than by changing its name', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    const star = await within(await screen.findByRole('tree', { name: 'Items' })).findByRole(
      'button',
      { name: 'Bookmark Acquisition memo' },
    );
    expect(star).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(star);

    await waitFor(() => {
      expect(star).toHaveAttribute('aria-pressed', 'true');
    });
  });

  it('starts pressed for something already kept', async () => {
    stubCoreApi({ items: [NOTE], bookmarks: [KEPT] });
    renderAt(<App />);
    const star = await within(await screen.findByRole('tree', { name: 'Items' })).findByRole(
      'button',
      { name: 'Bookmark Acquisition memo' },
    );

    await waitFor(() => {
      expect(star).toHaveAttribute('aria-pressed', 'true');
    });
  });

  it('lets go of something that was kept', async () => {
    stubCoreApi({ items: [NOTE], bookmarks: [KEPT] });
    renderAt(<App />);

    const star = await within(await screen.findByRole('tree', { name: 'Items' })).findByRole(
      'button',
      { name: 'Bookmark Acquisition memo' },
    );
    await waitFor(() => {
      expect(star).toHaveAttribute('aria-pressed', 'true');
    });

    await userEvent.click(star);

    await waitFor(() => {
      expect(star).toHaveAttribute('aria-pressed', 'false');
    });
  });

  /**
   * The reason the shelf is a store rather than a hook per caller. Keeping something in the tree
   * has to reach the shelf page, the editor's control and the palette at the same time - four
   * copies of the answer would mean three of them going stale.
   */
  it('reaches every control that shows the same item', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, '/bookmarks');

    await screen.findByRole('heading', { name: 'Bookmarks' });
    expect(await screen.findByText(/nothing kept yet/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Bookmark Acquisition memo' }));

    // The shelf page is showing the same store the tree's star just wrote to.
    await waitFor(() => {
      expect(screen.queryByText(/nothing kept yet/i)).not.toBeInTheDocument();
    });
  });
});

describe('the bookmarks destination', () => {
  it('offers bookmark actions from the row context menu', async () => {
    stubCoreApi({ items: [NOTE], bookmarks: [KEPT] });
    renderAt(<App />, '/bookmarks');

    const shelf = await screen.findByRole('list', { name: 'Bookmarks' });
    fireEvent.contextMenu(within(shelf).getByRole('listitem'));
    const menu = await screen.findByRole('menu', { name: 'Actions for Acquisition memo' });
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Remove bookmark' }));

    expect(await screen.findByText(/nothing kept yet/i)).toBeVisible();
  });

  it('lists what has been kept', async () => {
    stubCoreApi({ items: [NOTE], bookmarks: [KEPT] });
    renderAt(<App />, '/bookmarks');

    await screen.findByRole('heading', { name: 'Bookmarks' });

    const shelf = await screen.findByRole('list', { name: 'Bookmarks' });
    expect(within(shelf).getByText('Acquisition memo')).toBeInTheDocument();
  });

  it('opens the note a bookmark points at', async () => {
    stubCoreApi({ items: [NOTE], bookmarks: [KEPT] });
    renderAt(<App />, '/bookmarks');

    const shelf = await screen.findByRole('list', { name: 'Bookmarks' });
    await userEvent.click(within(shelf).getByRole('button', { name: 'Acquisition memo' }));

    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue(
      'Acquisition memo',
    );
  });

  it('says a shelf with nothing on it is empty, not broken', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, '/bookmarks');

    expect(await screen.findByText(/nothing kept yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /**
   * The honest state this feature exists to get right. A bookmark outlives access to what it points
   * at, so a shelf can hold items it cannot show - and a short list looks exactly like a short
   * shelf.
   */
  it('says how many bookmarks it is holding but cannot show', async () => {
    stubCoreApi({ items: [NOTE], bookmarks: [KEPT], bookmarksHidden: 2 });
    renderAt(<App />, '/bookmarks');

    await screen.findByRole('heading', { name: 'Bookmarks' });

    expect(await screen.findByText(/2 bookmarks are not shown/i)).toBeInTheDocument();
    expect(screen.getByText(/still kept/i)).toBeInTheDocument();
  });

  it('does not call a shelf empty when everything on it is unreachable', async () => {
    stubCoreApi({ items: [NOTE], bookmarks: [], bookmarksHidden: 1 });
    renderAt(<App />, '/bookmarks');

    await screen.findByRole('heading', { name: 'Bookmarks' });

    expect(screen.queryByText(/nothing kept yet/i)).not.toBeInTheDocument();
    expect(await screen.findByText(/1 bookmark is not shown/i)).toBeInTheDocument();
  });

  it('offers a way out when the shelf could not be read', async () => {
    stubCoreApi({ items: [NOTE], bookmarksFail: true });
    renderAt(<App />, '/bookmarks');

    const alert = await screen.findByRole('alert');

    expect(within(alert).getByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

describe('keeping from the command palette', () => {
  it('offers the command only when something is open', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Acquisition memo' });
    await userEvent.keyboard('{Control>}k{/Control}');

    // Nothing is open yet, so the command is left out rather than offered and inert.
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(screen.queryByRole('option', { name: /bookmark this note/i })).not.toBeInTheDocument();
  });

  it('names the direction it would go', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await screen.findByRole('button', { name: 'Acquisition memo' });
    await userEvent.keyboard('{Control>}k{/Control}');

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    expect(await screen.findByText(/bookmark this note/i)).toBeInTheDocument();
  });
});
