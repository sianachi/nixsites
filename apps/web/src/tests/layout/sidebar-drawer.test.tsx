import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SidebarDrawer } from '@nix/web-foundation/layout/sidebar-drawer';

/**
 * The workspace tree's off-canvas drawer, in isolation from the shell that mounts and unmounts it.
 *
 * `app-shell.tsx` decides *when* this is on screen and what focus does around each of the three
 * ways out - `sidebar.test.tsx` covers that decision, including the `inert` pane content and the
 * regression between this drawer's Escape and `workspace-sidebar.tsx`'s own "New" menu. What
 * belongs here is only what this component itself guarantees: a scrim that dismisses on tap and
 * is not a tab stop, and an Escape that asks the caller to close. There is no focus management
 * left to test - see the module's own doc comment for why a trap was never reintroduced.
 */

describe('the sidebar drawer', () => {
  it('renders its children without wrapping them in a dialog role of its own', () => {
    render(
      <SidebarDrawer onClose={vi.fn()}>
        <button>First row</button>
      </SidebarDrawer>,
    );

    // See the module comment: a `showModal()` dialog would cover the header this component exists
    // to leave on screen, so nothing here claims the role or the modal semantics that come with it.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'First row' })).toBeInTheDocument();
  });

  it('asks the caller to close on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SidebarDrawer onClose={onClose}>
        <button>First row</button>
      </SidebarDrawer>,
    );

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('asks the caller to close when the scrim behind it is tapped', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SidebarDrawer onClose={onClose}>
        <button>First row</button>
      </SidebarDrawer>,
    );

    await user.click(screen.getByRole('button', { name: /close the Explorer/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reads as a clickable dismiss control rather than an inert overlay', () => {
    render(
      <SidebarDrawer onClose={vi.fn()}>
        <button>First row</button>
      </SidebarDrawer>,
    );

    expect(screen.getByRole('button', { name: /close the Explorer/i })).toHaveClass(
      'cursor-pointer',
    );
  });

  it('keeps the scrim out of the tab order, since Escape is its keyboard equivalent', () => {
    render(
      <SidebarDrawer onClose={vi.fn()}>
        <button>First row</button>
      </SidebarDrawer>,
    );

    expect(screen.getByRole('button', { name: /close the Explorer/i })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });

  it("orders the scrim behind the panel, both below the header's own popovers", () => {
    // The literal ladder this component is responsible for: the scrim (`z-0`) has to sit behind
    // its own panel (`z-10`), and both have to leave room below the profile menu's `z-20` and
    // search's `z-30` - see `app-shell.tsx`'s skip-link comment for the full ladder and why
    // `<main>` carries `isolate` to keep pane content from re-entering this same contest.
    //
    // This asserts the classes actually emitted, not the paint order that results from them:
    // vitest's config turns CSS compilation off for this suite (see `vite.config.ts`), so jsdom
    // never has Tailwind's stylesheet to resolve `getComputedStyle` against here, and a value read
    // from an unstyled document would not mean what it looks like it means. Real stacking and
    // paint order - like the touch-target sizing above - belongs in a browser-based pass
    // (Storybook + axe, U10); this is the closest a jsdom test can come; the compiled-CSS
    // inspection that stands in for the rest is manual, and done as part of this change.
    render(
      <SidebarDrawer onClose={vi.fn()}>
        <button>First row</button>
      </SidebarDrawer>,
    );

    expect(screen.getByRole('button', { name: /close the Explorer/i })).toHaveClass('z-0');

    const panel = screen.getByRole('button', { name: 'First row' }).closest('div');
    expect(panel).toHaveClass('z-10');
  });

  // Real touch-target verification - that the scrim's hit area and the tree's own controls clear
  // WCAG 2.5.8's 24px floor - belongs in a browser-based pass (Storybook + axe, U10). jsdom cannot
  // compute box sizes, so there is deliberately no test here standing in for that.
});
