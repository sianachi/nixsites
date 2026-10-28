import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import { item, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { stubViewport } from '../stub-viewport';
import { paneElementId } from '@nix/web-platform/panes/pane-params';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAXIMUM_WIDTH,
  SIDEBAR_MINIMUM_WIDTH,
} from '@nix/web-foundation/layout/regions';
import {
  readCollapsed,
  readWidth,
  storeCollapsed,
  storeWidth,
  STORAGE_KEY,
  WIDTH_STORAGE_KEY,
} from '@nix/web-foundation/layout/use-sidebar';

/**
 * Collapsing the workspace tree.
 *
 * The part worth testing is not that it disappears - it is that it disappears *properly*. A tree
 * moved off-screen with a width of zero is still in the tab order and still in the accessibility
 * tree, so a keyboard walks through a sidebar nobody can see and a screen reader reads out a
 * workspace that is not on screen.
 */

let stored: Map<string, string>;

beforeEach(() => {
  signedIn();
  stored = new Map();

  // jsdom's own localStorage is inert here, so persistence assertions would pass vacuously.
  Object.defineProperty(globalThis.window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
      clear: () => {
        stored.clear();
      },
      key: (index: number) => [...stored.keys()][index] ?? null,
      get length() {
        return stored.size;
      },
    },
  });
});

const NOTE = item({ id: '3a3a3a3a-3333-4333-8333-3a3a3a3a3a3a', title: 'Roadmap' });

/**
 * jsdom does not lay a page out, so there is no real viewport width to narrow. What can be
 * exercised is the code path `viewport.ts`'s `useNarrowViewport` takes when the window query it asks does not
 * match - the same technique `pane-state.test.tsx` uses for its own, wider breakpoint, and both
 * share `stubViewport`. The suite's own default (`tests/setup.ts`) answers wide for anything, which
 * is why every test above this line renders the desktop arrangement without asking.
 */

describe('the workspace tree', () => {
  it('is on screen until somebody hides it', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    expect(await screen.findByRole('complementary', { name: /explorer/i })).toBeVisible();
  });

  it('leaves the page entirely when hidden, not merely the view', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Roadmap' });
    await user.click(screen.getByRole('button', { name: /hide the explorer/i }));

    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: /explorer/i })).not.toBeInTheDocument();
    });

    // The rows go with it. Hidden with a width of zero they would still be tabbable.
    expect(screen.queryByRole('button', { name: 'Roadmap' })).not.toBeInTheDocument();
  });

  it('can be brought back, because the control is not inside it', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Roadmap' });
    await user.click(screen.getByRole('button', { name: /hide the explorer/i }));
    await user.click(await screen.findByRole('button', { name: /show the explorer/i }));

    expect(await screen.findByRole('button', { name: 'Roadmap' })).toBeVisible();
  });

  it('says which state it is in, for a screen reader', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    const toggle = await screen.findByRole('button', { name: /hide the explorer/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /show the explorer/i })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    });
  });

  it('remembers being hidden', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Roadmap' });
    await user.click(screen.getByRole('button', { name: /hide the explorer/i }));

    // Somebody who collapses the tree has decided they want the width. Finding it back on the next
    // visit would make the control feel like it had not worked.
    await waitFor(() => {
      expect(stored.get(STORAGE_KEY)).toBe('collapsed');
    });
  });
});

describe('resizing the workspace tree', () => {
  it('offers a handle that reports the width it moves', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    const handle = await screen.findByRole('separator', { name: /resize the explorer/i });
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDEBAR_DEFAULT_WIDTH));
    expect(handle).toHaveAttribute('aria-valuemin', String(SIDEBAR_MINIMUM_WIDTH));
    expect(handle).toHaveAttribute('aria-valuemax', String(SIDEBAR_MAXIMUM_WIDTH));
  });

  it('widens from the keyboard and remembers the choice', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    const handle = await screen.findByRole('separator', { name: /resize the explorer/i });
    handle.focus();
    await user.keyboard('{ArrowRight}');

    // A drag has to survive a reload for the same reason collapsing does: somebody who moved the
    // edge has decided how much room the tree gets.
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDEBAR_DEFAULT_WIDTH + 8));
    await waitFor(() => {
      expect(stored.get(WIDTH_STORAGE_KEY)).toBe(String(SIDEBAR_DEFAULT_WIDTH + 8));
    });
  });

  it('stops at the bounds rather than letting the tree vanish', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    const handle = await screen.findByRole('separator', { name: /resize the explorer/i });
    handle.focus();

    await user.keyboard('{Home}');
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDEBAR_MINIMUM_WIDTH));

    await user.keyboard('{End}');
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDEBAR_MAXIMUM_WIDTH));
  });

  it('returns to the default width on Enter, and back again on the next press', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    const handle = await screen.findByRole('separator', { name: /resize the explorer/i });
    handle.focus();
    await user.keyboard('{End}');

    // The one position a drag cannot aim at, so it has a key - and the same key undoes it,
    // because a reset that cannot be unreset is a trap.
    await user.keyboard('{Enter}');
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDEBAR_DEFAULT_WIDTH));

    await user.keyboard('{Enter}');
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDEBAR_MAXIMUM_WIDTH));
  });

  it('goes with the tree when the tree is hidden', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('separator', { name: /resize the explorer/i });
    await user.click(screen.getByRole('button', { name: /hide the explorer/i }));

    // A handle that resizes something not on screen would be a focusable control that visibly
    // does nothing.
    await waitFor(() => {
      expect(
        screen.queryByRole('separator', { name: /resize the explorer/i }),
      ).not.toBeInTheDocument();
    });
  });
});

describe('remembering the width', () => {
  function mapStorage(): Storage {
    return {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    } as unknown as Storage;
  }

  it('defaults when nothing has been chosen, or the stored value is not a number', () => {
    expect(readWidth(undefined)).toBe(SIDEBAR_DEFAULT_WIDTH);

    stored.set(WIDTH_STORAGE_KEY, 'wide');
    expect(readWidth(mapStorage())).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('clamps a stored width to the bounds, since storage is writable by anything', () => {
    stored.set(WIDTH_STORAGE_KEY, '10000');
    expect(readWidth(mapStorage())).toBe(SIDEBAR_MAXIMUM_WIDTH);

    stored.set(WIDTH_STORAGE_KEY, '1');
    expect(readWidth(mapStorage())).toBe(SIDEBAR_MINIMUM_WIDTH);
  });

  it('stores the default as absence rather than as a second spelling', () => {
    storeWidth(mapStorage(), 300);
    expect(stored.get(WIDTH_STORAGE_KEY)).toBe('300');

    storeWidth(mapStorage(), SIDEBAR_DEFAULT_WIDTH);
    expect(stored.has(WIDTH_STORAGE_KEY)).toBe(false);
  });

  it('survives a browser that refuses storage', () => {
    const refusing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;

    expect(readWidth(refusing)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(() => {
      storeWidth(refusing, 300);
    }).not.toThrow();
  });
});

describe('remembering the choice', () => {
  it('defaults to open when nothing has been chosen', () => {
    expect(readCollapsed(undefined)).toBe(false);
  });

  it('stores open as absence rather than as a second spelling', () => {
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    } as unknown as Storage;

    storeCollapsed(storage, true);
    expect(stored.get(STORAGE_KEY)).toBe('collapsed');

    storeCollapsed(storage, false);
    expect(stored.has(STORAGE_KEY)).toBe(false);
  });

  it('survives a browser that refuses storage', () => {
    const refusing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;

    expect(readCollapsed(refusing)).toBe(false);
    expect(() => {
      storeCollapsed(refusing, true);
    }).not.toThrow();
  });
});

/**
 * The workspace tree on a screen too narrow to share with anything.
 *
 * Below Tailwind's own `sm` breakpoint the tree is an off-canvas drawer rather than the fixed
 * panel above it - `SidebarDrawer` itself is covered in isolation in `sidebar-drawer.test.tsx`.
 * What belongs here is the decision this shell makes with it: that a narrow window gets a drawer
 * instead of a squeeze panel, closed by default; that the resize handle does not come along; that
 * opening or closing it never touches the storage the wide preference uses; and that each of its
 * three ways out - Escape, a scrim tap, picking an item - sends focus somewhere deliberate rather
 * than to whatever the browser would have chosen on its own.
 *
 * There is no `role="dialog"` to query here any more - see `sidebar-drawer.tsx`'s own comment on
 * why - so a drawer being open is read the way any other panel is, through the tree's own
 * `complementary` landmark, and a drawer being *closed* is read the same way `sidebar.collapsed`
 * already was above: the landmark, and its rows, gone from the document rather than merely hidden.
 */
describe('the workspace tree, as a drawer on a narrow screen', () => {
  it('starts closed on a narrow screen, even though the wide preference is open', async () => {
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    // A fresh visit on a phone must not inherit the desktop panel's open-by-default preference -
    // otherwise a shared deep link would open behind a drawer covering the very document it named.
    await screen.findByRole('button', { name: /show the explorer/i });
    expect(screen.queryByRole('complementary', { name: /explorer/i })).not.toBeInTheDocument();
  });

  it('shows the tree landmark over the pane content once opened, with the pane content made inert', async () => {
    const user = userEvent.setup();
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /show the explorer/i }));

    expect(await screen.findByRole('complementary', { name: /explorer/i })).toBeVisible();
    // The pane content this overlays, unreachable without a hand-rolled trap - see
    // `app-shell.tsx`'s own comment on the `<main>` element.
    expect(document.getElementById('main')).toHaveAttribute('inert');
  });

  it('leaves the pane content reachable while the drawer is closed', async () => {
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await screen.findByRole('button', { name: /show the explorer/i });
    expect(document.getElementById('main')).not.toHaveAttribute('inert');
  });

  it('offers no resize handle, since nothing shares the screen with it to resize against', async () => {
    const user = userEvent.setup();
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /show the explorer/i }));
    await screen.findByRole('complementary', { name: /explorer/i });

    expect(
      screen.queryByRole('separator', { name: /resize the explorer/i }),
    ).not.toBeInTheDocument();
  });

  it('never writes to the desktop preference when the drawer opens or closes', async () => {
    const user = userEvent.setup();
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /show the explorer/i }));
    await screen.findByRole('complementary', { name: /explorer/i });
    await user.click(screen.getByRole('button', { name: /hide the explorer/i }));

    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: /explorer/i })).not.toBeInTheDocument();
    });

    // Dismissing the drawer on a phone must not silently leave a later, wider visit collapsed.
    expect(stored.has(STORAGE_KEY)).toBe(false);
  });

  it('closes when the scrim behind it is tapped, and sends focus back to the toggle', async () => {
    const user = userEvent.setup();
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    const toggle = await screen.findByRole('button', { name: /show the explorer/i });
    await user.click(toggle);
    await screen.findByRole('complementary', { name: /explorer/i });

    await user.click(screen.getByRole('button', { name: /close the Explorer/i }));

    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: /explorer/i })).not.toBeInTheDocument();
    });
    expect(toggle).toHaveFocus();
  });

  it('closes on Escape, and sends focus back to the toggle', async () => {
    const user = userEvent.setup();
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    const toggle = await screen.findByRole('button', { name: /show the explorer/i });
    await user.click(toggle);
    await screen.findByRole('complementary', { name: /explorer/i });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: /explorer/i })).not.toBeInTheDocument();
    });
    expect(toggle).toHaveFocus();
  });

  it('closes the profile menu on Escape without closing the drawer around it', async () => {
    // The same bug as the "New" menu above, for the other document-level Escape handler that stays
    // reachable while the drawer is open - the header never becomes inert, by design, so the
    // profile menu (`profile-menu.tsx`) is operable throughout and has to stop propagation the same
    // way `CreateMenu` does.
    const user = userEvent.setup();
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /show the explorer/i }));
    await user.click(await screen.findByRole('button', { name: /test person/i }));
    expect(screen.getByRole('dialog', { name: /account/i })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: /account/i })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: /explorer/i })).toBeInTheDocument();
  });

  it('closes search on Escape without closing the drawer around it', async () => {
    // Same bug, same fix, for the third document-level Escape handler reachable from behind the
    // drawer: search (`command-palette.tsx`) opens from the header's own control, which also stays
    // interactive while the drawer is open.
    const user = userEvent.setup();
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /show the explorer/i }));
    await user.click(await screen.findByRole('button', { name: /^search/i }));
    expect(screen.getByRole('dialog', { name: /search/i })).toBeInTheDocument();

    fireEvent(
      screen.getByRole('dialog', { name: /search/i }),
      new Event('cancel', { cancelable: true }),
    );

    expect(screen.queryByRole('dialog', { name: /search/i })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: /explorer/i })).toBeInTheDocument();
  });

  it('closes once an item is selected, moving focus to the pane rather than the toggle', async () => {
    const user = userEvent.setup();
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    const toggle = await screen.findByRole('button', { name: /show the explorer/i });
    await user.click(toggle);
    await user.click(await screen.findByRole('button', { name: 'Roadmap' }));

    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: /explorer/i })).not.toBeInTheDocument();
    });

    // Picking an item is "there, that one", not "never mind" - so unlike Escape and the scrim
    // above, focus does not return to the control that opened the drawer.
    expect(toggle).not.toHaveFocus();
    await waitFor(() => {
      expect(document.getElementById(paneElementId(0))).toHaveFocus();
    });
  });

  it('reopens from the same toggle that closed it - no second control exists for it', async () => {
    const user = userEvent.setup();
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /show the explorer/i }));
    await screen.findByRole('complementary', { name: /explorer/i });
    await user.click(screen.getByRole('button', { name: /hide the explorer/i }));

    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: /explorer/i })).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /show the explorer/i }));

    expect(await screen.findByRole('complementary', { name: /explorer/i })).toBeVisible();
  });

  it('leaves the page entirely once closed, not merely out of view', async () => {
    const user = userEvent.setup();
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /show the explorer/i }));
    await screen.findByRole('button', { name: 'Roadmap' });
    await user.click(screen.getByRole('button', { name: /hide the explorer/i }));

    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: /explorer/i })).not.toBeInTheDocument();
    });
    // The rows go with it, the same guarantee the wide panel makes above.
    expect(screen.queryByRole('button', { name: 'Roadmap' })).not.toBeInTheDocument();
  });

  it('sends the skip link to the pane instead of the inert main it would otherwise jump to', async () => {
    // `#main` is `inert` while the drawer covers it, so the plain anchor jump this link used to
    // rely on landed focus nowhere - the one thing "skip to content" exists to do. Activating it
    // now closes the drawer first, the same reading `closeDrawerAfter` gives a row selection.
    //
    // The note is preselected via the address rather than picked from the tree, the way a shared
    // link opened on a phone would arrive - the case below covers the other route to pane zero,
    // where nothing is open at all.
    const user = userEvent.setup();
    stubViewport(false);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await user.click(await screen.findByRole('button', { name: /show the explorer/i }));
    await screen.findByRole('complementary', { name: /explorer/i });

    await user.click(screen.getByRole('link', { name: /skip to content/i }));

    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: /explorer/i })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(document.getElementById(paneElementId(0))).toHaveFocus();
    });
  });

  it('sends the skip link to the empty-workspace message when there is no pane to land on', async () => {
    // With no items and nothing open, `editor-page.tsx` renders a plain message rather than a
    // pane - but the skip link still has to land somewhere once it closes the drawer, or
    // activating it on a phone would leave focus stranded on the link itself while the content it
    // "skipped to" tells the reader to open the very drawer that was just closed. The message
    // carries `paneElementId(0)`, the same id `focusPane(0)` always targets, precisely so this
    // has an answer.
    const user = userEvent.setup();
    stubViewport(false);
    stubCoreApi();
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /show the explorer/i }));
    await screen.findByRole('complementary', { name: /explorer/i });

    await user.click(screen.getByRole('link', { name: /skip to content/i }));

    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: /explorer/i })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(document.getElementById(paneElementId(0))).toHaveFocus();
    });
    expect(
      screen.getByRole('heading', { level: 1, name: /good (morning|afternoon|evening)/i }),
    ).toBeVisible();
  });

  it('leaves the fixed panel and its handle alone on a wide screen', async () => {
    // The suite's own default (`tests/setup.ts`) is asserted here explicitly rather than only
    // relied on, so a change to that default fails this test - which says what it depends on -
    // rather than one several files away that merely stops finding a role.
    stubViewport(true);
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    expect(await screen.findByRole('complementary', { name: /explorer/i })).toBeVisible();
    expect(screen.getByRole('separator', { name: /resize the explorer/i })).toBeInTheDocument();
    expect(document.getElementById('main')).not.toHaveAttribute('inert');
  });
});
