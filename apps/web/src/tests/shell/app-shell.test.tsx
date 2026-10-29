import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { item, stubCoreApi, STUB_WORKSPACE_ID } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { App } from '../../app';
import { recordInterruptedImport } from '@nix/web-foundation/lib/import-interrupted-notice';

/**
 * The shell's information architecture.
 *
 * These are the assertions that keep the product's shape from drifting back towards the design
 * file's five example screens: no tab strip, no board page, no search page, and an administrative
 * entry that appears only because the server said so.
 */
beforeEach(() => {
  signedIn();
});

const NOTE = item({
  id: '1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e',
  title: 'Acquisition memo',
});

describe('the shell', () => {
  it('has no tab strip, because a board and a search page are not destinations', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Acquisition memo' });

    // The old strip was Editor / Board / Search / Admin. None of them is a place any more.
    expect(screen.queryByRole('navigation', { name: /sections/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^board$/i })).not.toBeInTheDocument();
  });

  it('offers a skip link as the first thing a keyboard reaches', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Acquisition memo' });
    await user.tab();

    // It used to live on a layout element the route tree had stopped rendering,
    // so the app shipped with no skip link at all and nothing said so. Reaching
    // it by tabbing is the assertion; querying for the anchor would have passed
    // in the broken state too, had the element still been mounted anywhere.
    const skip = screen.getByRole('link', { name: /skip to content/i });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute('href', '#main');

    // And it must land somewhere: an anchor pointing at no such id is a skip
    // link that silently does nothing.
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
  });

  it('gives pane content its own stacking context, so nothing inside a pane can paint over the header', async () => {
    // A regression for the bug where the narrow-viewport drawer (`sidebar-drawer.tsx`) painted
    // over the profile menu: neither established a stacking context of its own, so both resolved
    // into the root context at the same z-index and the tie broke on DOM order. `isolate` here
    // means everything a pane renders - `sheet-grid.tsx`'s own layered overlays included - stays
    // contained below the header's popovers regardless of any z-index it picks for itself.
    //
    // This checks the class is present, not the paint order it produces: jsdom does not compile
    // Tailwind for this suite (`vite.config.ts`), so there is no stylesheet for a stacking context
    // to exist against here. See `sidebar-drawer.test.tsx`'s own comment on the same limit.
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Acquisition memo' });
    expect(screen.getByRole('main')).toHaveClass('isolate');
  });

  it('keeps the workspace tree on screen rather than inside one page', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    expect(await screen.findByRole('button', { name: 'Acquisition memo' })).toBeVisible();
    expect(screen.getByRole('complementary', { name: /explorer/i })).toBeInTheDocument();
  });

  it('keeps the workspace and search controls shrinkable on a narrow screen', async () => {
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: /show the explorer/i });
    expect(screen.getByRole('banner')).toHaveClass('min-w-0', 'px-2');
    expect(screen.getByRole('button', { name: /, workspace menu$/ })).toHaveClass('min-w-0');
    expect(screen.getByRole('button', { name: 'Search' })).toHaveClass('shrink-0', 'px-2');
  });

  it('opens search over whatever is on screen, from a control that is always there', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /^search/i }));

    expect(screen.getByRole('dialog', { name: /search/i })).toBeInTheDocument();
  });

  it('opens search from the keyboard, wherever the caret is', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: /^search/i });
    await user.keyboard('{Control>}k{/Control}');

    expect(screen.getByRole('dialog', { name: /search/i })).toBeInTheDocument();
  });

  it('does not open search when the focused control already handled the shortcut', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);
    const innerControl = await screen.findByRole('button', { name: /^search/i });
    innerControl.addEventListener(
      'keydown',
      (event) => {
        event.preventDefault();
      },
      { once: true },
    );
    innerControl.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    innerControl.dispatchEvent(event);

    expect(innerControl).toHaveFocus();
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole('dialog', { name: /search/i })).not.toBeInTheDocument();
  });

  it('closes search on Escape without navigating anywhere', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /^search/i }));
    // jsdom does not translate Escape into a native dialog cancel.
    fireEvent(
      screen.getByRole('dialog', { name: /search/i }),
      new Event('cancel', { cancelable: true }),
    );

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /search/i })).not.toBeInTheDocument();
    });
  });

  it('finds a note by title and opens it from any workspace destination', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, '/calendar');

    await screen.findByRole('button', { name: 'Acquisition memo' });
    await user.click(screen.getByRole('button', { name: /^search/i }));
    await user.type(screen.getByRole('combobox', { name: /search items/i }), 'acquisition');

    // Awaited rather than read straight away: the search is debounced and answered by the server,
    // so a synchronous assertion here would be asserting on the empty list that precedes it.
    const dialog = screen.getByRole('dialog', { name: /search/i });
    const result = await within(dialog).findByRole('option', { name: /Acquisition memo/ });

    // And it opens: the palette closes and the note is what the pane now shows.
    await user.click(result);

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /search/i })).not.toBeInTheDocument();
    });
    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue(
      'Acquisition memo',
    );
  });

  it('says a search failed rather than reporting an empty workspace', async () => {
    // The caveat this replaces - "matches titles of the notes loaded" - described a limitation
    // that no longer exists: the palette asks the server, which searches titles and document text
    // across every workspace the caller may read. What still has to be said out loud is the
    // failure, because a palette that reports nothing found when the request never succeeded sends
    // somebody off to recreate a document they already have.
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE], searchFails: true });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /^search/i }));
    await user.type(screen.getByRole('combobox', { name: /search items/i }), 'acquisition');

    expect(await screen.findByText(/could not be run/i)).toBeVisible();
  });

  it('offers commands beside the items it found', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /^search/i }));
    await user.type(screen.getByRole('combobox', { name: /search items/i }), 'note');

    // One list, ordered commands then items, so a single run of arrow keys walks the whole answer.
    expect(await screen.findByRole('option', { name: /New note/ })).toBeVisible();
  });

  it('creates a command-palette note at the workspace root even when another note is open', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await user.click(await screen.findByRole('button', { name: /^search/i }));
    await user.type(screen.getByRole('combobox', { name: /search items/i }), 'note');
    await user.click(await screen.findByRole('option', { name: /New note/ }));

    const created = await screen.findByRole('button', { name: 'Untitled note' });
    expect(created.closest('ul')).toHaveAttribute('role', 'tree');
  });
});

describe('the interrupted-import notice', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('shows a torn-down import summary once, on arrival in the workspace it names', async () => {
    recordInterruptedImport({
      subject: 'test-subject',
      workspaceId: STUB_WORKSPACE_ID,
      createdCount: 12,
      totalCount: 40,
    });
    stubCoreApi({ items: [NOTE] });

    renderAt(<App />);

    expect(await screen.findByText('Import interrupted: 12 of 40 created.')).toBeVisible();
    // Read once: a notice that survived being shown would say the same thing again on a second
    // visit to this workspace, which is not what "torn down while working" happened twice.
    expect(sessionStorage.getItem('nix:import-interrupted')).toBeNull();
  });

  it('drops, unshown, a notice another person left behind in this browser', async () => {
    recordInterruptedImport({
      subject: 'someone-else',
      workspaceId: STUB_WORKSPACE_ID,
      createdCount: 3,
      totalCount: 9,
    });
    stubCoreApi({ items: [NOTE] });

    renderAt(<App />);

    expect(await screen.findByRole('button', { name: NOTE.title })).toBeInTheDocument();
    expect(screen.queryByText(/Import interrupted/)).toBeNull();
    expect(sessionStorage.getItem('nix:import-interrupted')).toBeNull();
  });

  it('says nothing when there is no pending notice for this workspace', async () => {
    stubCoreApi({ items: [NOTE] });

    renderAt(<App />);

    await screen.findByRole('button', { name: 'Acquisition memo' });
    expect(screen.queryByText(/import interrupted/i)).not.toBeInTheDocument();
  });
});

describe('the profile menu', () => {
  it('shows who is signed in', async () => {
    const user = userEvent.setup();
    stubCoreApi({ displayName: 'Ada Lovelace', email: 'ada@example.test' });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /ada lovelace/i }));

    expect(screen.getByRole('dialog', { name: /account/i })).toBeInTheDocument();
    expect(screen.getByText('ada@example.test')).toBeVisible();
  });

  it('always offers a way out', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: 'Test Person' }));

    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('says so when the profile could not be loaded instead of pretending it has one', async () => {
    const user = userEvent.setup();
    stubCoreApi({ profileFails: true });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /loading|profile/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/profile could not be loaded/i);
  });
});
