import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as importRun from '@nix/web-workspaces/import/import-run';
import {
  item,
  STUB_WORKSPACE,
  stubCoreApi,
  type StubWorkspace,
} from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { App } from '../../app';

/**
 * The navigation rail: the workspace-level destinations, Notes among them.
 *
 * Driven through the whole application rather than the component in isolation, because half of
 * what the rail promises is only true in a router - which link the URL makes current, and what
 * following one does to the address. The rail's own keyboard contract is asserted here too, on
 * the real controls, since a roving tabindex is a claim about the document's tab order and
 * nothing short of tabbing through it checks that.
 */
beforeEach(() => {
  signedIn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NOTE = item({
  id: '1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e',
  title: 'Acquisition memo',
});

function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: /destinations/i });
}

describe('the navigation rail', () => {
  it('keeps destinations scrollable when the window is short', async () => {
    stubCoreApi();
    renderAt(<App />);
    expect(await screen.findByRole('navigation', { name: /destinations/i })).toHaveClass(
      'min-h-0',
      'overflow-y-auto',
    );
  });
  it('names every control, so an icon is never the only thing it says', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Acquisition memo' });

    const items = within(rail()).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Homebase',
      'Daily notes',
      'Calendar',
      'Graph',
      'Bookmarks',
      'Templates',
      'Smart lists',
      'Automations',
      'Trash',
      'Import',
      'Settings',
    ]);
    expect(within(rail()).getByRole('link', { name: 'Homebase' })).toHaveAttribute(
      'href',
      '/w/00000000-0000-4000-8000-000000000001',
    );
    expect(within(rail()).getByRole('link', { name: 'Calendar' })).toHaveAttribute(
      'href',
      '/w/00000000-0000-4000-8000-000000000001/calendar',
    );
    expect(within(rail()).getByRole('link', { name: 'Automations' })).toHaveAttribute(
      'href',
      '/w/00000000-0000-4000-8000-000000000001/automations',
    );
    expect(within(rail()).getByRole('link', { name: 'Trash' })).toHaveAttribute(
      'href',
      '/w/00000000-0000-4000-8000-000000000001/trash',
    );
    expect(within(rail()).getByRole('button', { name: 'Import' })).toBeInTheDocument();
    expect(within(rail()).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/w/00000000-0000-4000-8000-000000000001/settings',
    );
  });

  it('does not expose Daily notes in a workspace the user does not personally own', async () => {
    const shared: StubWorkspace = {
      ...STUB_WORKSPACE,
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Shared research',
      kind: 'shared',
      canUseDailyNotes: false,
    };
    stubCoreApi({ workspaces: [STUB_WORKSPACE, shared], items: [NOTE] });
    renderAt(<App />, `/w/${shared.id}`);

    await screen.findByRole('button', { name: 'Acquisition memo' });
    expect(within(rail()).queryByRole('link', { name: 'Daily notes' })).not.toBeInTheDocument();
  });

  it('keeps Calendar current and roves through the filtered rail without Daily notes', async () => {
    const user = userEvent.setup();
    const shared: StubWorkspace = {
      ...STUB_WORKSPACE,
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Shared research',
      kind: 'shared',
      canUseDailyNotes: false,
    };
    stubCoreApi({ workspaces: [STUB_WORKSPACE, shared], items: [NOTE] });
    renderAt(<App />, `/w/${shared.id}/calendar`);

    await screen.findByRole('heading', { name: 'Calendar' });

    const calendar = within(rail()).getByRole('link', { name: 'Calendar' });
    const graph = within(rail()).getByRole('link', { name: 'Graph' });
    expect(calendar).toHaveAttribute('aria-current', 'page');
    expect(calendar).toHaveAttribute('tabindex', '0');
    expect(graph).not.toHaveAttribute('aria-current');

    calendar.focus();
    await user.keyboard('{ArrowDown}');
    expect(graph).toHaveFocus();
  });

  it('costs one Tab press to enter and one to leave, however many destinations it holds', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });

    const notes = within(rail()).getByRole('link', { name: 'Homebase' });
    const calendar = within(rail()).getByRole('link', { name: 'Calendar' });
    const graph = within(rail()).getByRole('link', { name: 'Graph' });
    const bookmarks = within(rail()).getByRole('link', { name: 'Bookmarks' });
    const templates = within(rail()).getByRole('link', { name: 'Templates' });
    const queries = within(rail()).getByRole('button', { name: 'Smart lists' });
    const automations = within(rail()).getByRole('link', { name: 'Automations' });
    const trash = within(rail()).getByRole('link', { name: 'Trash' });
    const importControl = within(rail()).getByRole('button', { name: 'Import' });
    const settings = within(rail()).getByRole('link', { name: 'Settings' });

    // Only the entry point is in the tab order; the others are reachable by arrow key alone.
    expect(notes).toHaveAttribute('tabindex', '-1');
    expect(calendar).toHaveAttribute('tabindex', '0');
    expect(graph).toHaveAttribute('tabindex', '-1');
    expect(bookmarks).toHaveAttribute('tabindex', '-1');
    expect(templates).toHaveAttribute('tabindex', '-1');
    expect(queries).toHaveAttribute('tabindex', '-1');
    expect(automations).toHaveAttribute('tabindex', '-1');
    expect(trash).toHaveAttribute('tabindex', '-1');
    expect(importControl).toHaveAttribute('tabindex', '-1');
    expect(settings).toHaveAttribute('tabindex', '-1');

    // Tab reaches the skip link, then the rail, then leaves it - every destination, one stop.
    await user.tab();
    await user.tab();
    expect(calendar).toHaveFocus();

    await user.tab();
    expect(rail()).not.toContainElement(document.activeElement as HTMLElement | null);
  });

  it('moves between destinations with the arrow keys, and stops at the ends', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });

    const notes = within(rail()).getByRole('link', { name: 'Homebase' });
    const daily = within(rail()).getByRole('link', { name: 'Daily notes' });
    const calendar = within(rail()).getByRole('link', { name: 'Calendar' });
    const graph = within(rail()).getByRole('link', { name: 'Graph' });
    const templates = within(rail()).getByRole('link', { name: 'Templates' });
    const queries = within(rail()).getByRole('button', { name: 'Smart lists' });
    const automations = within(rail()).getByRole('link', { name: 'Automations' });
    const trash = within(rail()).getByRole('link', { name: 'Trash' });
    const importControl = within(rail()).getByRole('button', { name: 'Import' });
    const settings = within(rail()).getByRole('link', { name: 'Settings' });

    calendar.focus();

    await user.keyboard('{ArrowUp}');
    expect(daily).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(notes).toHaveFocus();

    // Nothing wraps: the ends of the rail are meant to be findable by feel.
    await user.keyboard('{ArrowUp}');
    expect(notes).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(daily).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(calendar).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(graph).toHaveFocus();

    templates.focus();
    await user.keyboard('{ArrowDown}');
    expect(queries).toHaveFocus();

    // The Smart lists menu's trigger is one of the rail's stops, not a trap: the arrows pass it by.
    await user.keyboard('{ArrowDown}');
    expect(automations).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(trash).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(importControl).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(settings).toHaveFocus();

    await user.keyboard('{End}');
    expect(settings).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(settings).toHaveFocus();

    await user.keyboard('{Home}');
    expect(notes).toHaveFocus();
  });

  it('leaves the tab stop where focus last was, so tabbing out and back returns there', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, '/calendar');

    await screen.findByRole('heading', { name: 'Calendar' });

    const graph = within(rail()).getByRole('link', { name: 'Graph' });
    within(rail()).getByRole('link', { name: 'Calendar' }).focus();
    await user.keyboard('{ArrowDown}');

    expect(graph).toHaveAttribute('tabindex', '0');
    expect(within(rail()).getByRole('link', { name: 'Calendar' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });

  it('marks where you are with aria-current rather than with colour alone', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, '/graph');

    await screen.findByRole('heading', { name: 'Graph' });

    expect(within(rail()).getByRole('link', { name: 'Graph' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(rail()).getByRole('link', { name: 'Calendar' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('uses Templates as the current roving entry throughout its nested routes', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, '/templates/import');

    await screen.findByRole('heading', { name: 'Import template' });

    const notes = within(rail()).getByRole('link', { name: 'Homebase' });
    const templates = within(rail()).getByRole('link', { name: 'Templates' });
    expect(templates).toHaveAttribute('aria-current', 'page');
    expect(templates).toHaveAttribute('tabindex', '0');
    expect(notes).toHaveAttribute('tabindex', '-1');
  });

  it('marks Notes as current while a document is open, because that is what it now is', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Acquisition memo' });

    expect(within(rail()).getByRole('link', { name: 'Homebase' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const label of [
      'Calendar',
      'Graph',
      'Bookmarks',
      'Templates',
      'Automations',
      'Trash',
      'Settings',
    ]) {
      expect(within(rail()).getByRole('link', { name: label })).not.toHaveAttribute('aria-current');
    }
    expect(within(rail()).getByRole('button', { name: 'Import' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('opens a workspace-level import without requiring a note to be open', async () => {
    const user = userEvent.setup();
    const run = vi.spyOn(importRun, 'runImportPlan').mockResolvedValue({
      rootItemId: null,
      created: [],
      failed: [],
      notAttempted: [],
      stoppedEarly: false,
      couldNotStart: 'Stopped after the request was captured.',
    });
    stubCoreApi();
    renderAt(<App />);

    await screen.findByRole('navigation', { name: /destinations/i });
    await user.click(within(rail()).getByRole('button', { name: 'Import' }));
    const dialog = screen.getByRole('dialog', { name: 'Import' });
    expect(within(dialog).getByText(/Obsidian vault/i)).toBeVisible();

    await user.upload(
      within(dialog).getByLabelText('Markdown files to import'),
      new File(['Body.'], 'note.md', { type: 'text/markdown' }),
    );
    await user.click(await within(dialog).findByRole('button', { name: 'Import 2 items' }));

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ parentId: null }));
  });

  it('changes the address when a destination is followed', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Acquisition memo' });
    await user.click(within(rail()).getByRole('link', { name: 'Bookmarks' }));

    expect(await screen.findByRole('heading', { name: 'Bookmarks' })).toBeInTheDocument();
    expect(within(rail()).getByRole('link', { name: 'Bookmarks' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  /*
   * The deliberate-stub test that lived here is gone, and its absence is the point: every
   * destination the rail offers is now built, so there is no placeholder left to assert on. The
   * rule it guarded - a destination the product cannot yet fill says so rather than drawing an
   * empty one that looks finished - still stands, and `status-panels.tsx`'s `EmptyPanel` is still
   * how it would be honoured. Reinstate a test here the next time a route lands ahead of its view.
   */
});

/**
 * jsdom lays nothing out, so what a narrow viewport means here is the code path
 * `viewport.ts`'s `useNarrowViewport` takes when its window query does not match - the same technique, and
 * the same helper, `sidebar.test.tsx` uses for the drawer.
 */
describe('the navigation rail on a narrow screen', () => {
  it('reclaims the rail space until workspace navigation is opened', async () => {
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    expect(screen.queryByRole('navigation', { name: /destinations/i })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /show the explorer/i }));
    expect(within(rail()).queryByRole('link')).not.toBeInTheDocument();
    await userEvent.click(within(rail()).getByRole('button', { name: 'Homebase' }));
    // Nine destinations and "New smart list", which the Smart lists section folds into this one menu.
    expect(
      screen.getByRole('menu', { name: 'Workspace pages' }).querySelectorAll('a'),
    ).toHaveLength(10);
    expect(screen.getByRole('menuitem', { name: 'New smart list' })).toHaveAttribute(
      'href',
      '/w/00000000-0000-4000-8000-000000000001/new/query',
    );
    expect(screen.getByRole('menuitem', { name: 'Homebase' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('menuitem', { name: 'Graph' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('menuitem', { name: 'Import' })).toBeVisible();
  });

  it('dismisses the tree drawer on the way to a destination, rather than leaving it over the top', async () => {
    const user = userEvent.setup();
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /show the explorer/i }));
    expect(await screen.findByRole('complementary', { name: /explorer/i })).toBeVisible();

    await user.click(within(rail()).getByRole('button', { name: 'Homebase' }));
    await user.click(screen.getByRole('menuitem', { name: 'Graph' }));

    expect(await screen.findByRole('heading', { name: 'Graph' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: /explorer/i })).not.toBeInTheDocument();
  });

  it('dismisses the tree drawer before opening the import dialog', async () => {
    const user = userEvent.setup();
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /show the explorer/i }));
    expect(await screen.findByRole('complementary', { name: /explorer/i })).toBeVisible();

    await user.click(within(rail()).getByRole('button', { name: 'Homebase' }));
    await user.click(screen.getByRole('menuitem', { name: 'Import' }));

    expect(screen.getByRole('dialog', { name: 'Import' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: /explorer/i })).not.toBeInTheDocument();
  });
});
