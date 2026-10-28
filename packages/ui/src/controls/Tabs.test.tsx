import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Tabs, type TabItem } from './Tabs';

const OPEN: readonly TabItem[] = [
  { id: 'a', label: 'Meeting notes', pinned: true },
  { id: 'b', label: 'Roadmap', pinned: false },
  { id: 'c', label: 'Design review', pinned: true },
];

describe('Tabs', () => {
  it('announces the strip and which document is showing', () => {
    render(<Tabs label="Open documents" items={OPEN} activeId="b" onActivate={vi.fn()} />);

    expect(screen.getByRole('tablist', { name: 'Open documents' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Roadmap' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Meeting notes' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('reports the tab that was clicked', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();

    render(<Tabs label="Open documents" items={OPEN} activeId="a" onActivate={onActivate} />);
    await user.click(screen.getByRole('tab', { name: 'Design review' }));

    expect(onActivate).toHaveBeenCalledWith('c');
  });

  it('moves focus with the arrow keys without activating', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();

    render(<Tabs label="Open documents" items={OPEN} activeId="a" onActivate={onActivate} />);
    screen.getByRole('tab', { name: 'Meeting notes' }).focus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Roadmap' })).toHaveFocus();

    // Arrow keys move the roving tab stop, not the selection - each tab carries a live
    // connection, so browsing the strip itself must not activate every tab passed on the way.
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('wraps from the last tab to the first', async () => {
    const user = userEvent.setup();

    render(<Tabs label="Open documents" items={OPEN} activeId="a" onActivate={vi.fn()} />);
    screen.getByRole('tab', { name: 'Design review' }).focus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Meeting notes' })).toHaveFocus();
  });

  it('activates the focused tab on Enter', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();

    render(<Tabs label="Open documents" items={OPEN} activeId="a" onActivate={onActivate} />);
    screen.getByRole('tab', { name: 'Roadmap' }).focus();

    await user.keyboard('{Enter}');
    expect(onActivate).toHaveBeenCalledWith('b');
  });

  it('only the active tab is in the tab order', () => {
    render(<Tabs label="Open documents" items={OPEN} activeId="b" onActivate={vi.fn()} />);

    expect(screen.getByRole('tab', { name: 'Roadmap' })).toHaveAttribute('tabIndex', '0');
    expect(screen.getByRole('tab', { name: 'Meeting notes' })).toHaveAttribute('tabIndex', '-1');
    expect(screen.getByRole('tab', { name: 'Design review' })).toHaveAttribute('tabIndex', '-1');
  });

  it('reports which tab was closed, separately from activating it', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onClose = vi.fn();

    render(
      <Tabs
        label="Open documents"
        items={OPEN}
        activeId="a"
        onActivate={onActivate}
        onClose={onClose}
      />,
    );
    // Queried by title rather than role because the affordance is pointer-only by design - it is
    // aria-hidden with no role, so the tab is not a nested interactive, and Delete on the tab is
    // the accessible route.
    await user.click(screen.getByTitle('Close Roadmap (Delete)'));

    expect(onClose).toHaveBeenCalledWith('b');
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('exposes no interactive control inside the tab, and says Delete is the keyboard route', () => {
    // A tablist may own nothing but tabs, and a tab may not contain another interactive control -
    // assistive technology flattens a tab to its name and never reaches a nested button. The
    // visible close affordance is therefore pointer-only, absent from the accessibility tree and
    // the tab order, and the tab itself announces the keyboard route in its place.
    render(
      <Tabs
        label="Open documents"
        items={OPEN}
        activeId="a"
        onActivate={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const tab = screen.getByRole('tab', { name: 'Roadmap' });
    expect(within(tab).queryByRole('button', { hidden: true })).not.toBeInTheDocument();
    expect(tab).toHaveAttribute('aria-keyshortcuts', 'Delete Backspace');

    // The pointer target still exists for mouse users, outside the accessibility tree - queried
    // by its title because having no role is exactly the property under test.
    const affordance = screen.getByTitle('Close Roadmap (Delete)');
    expect(affordance).toHaveAttribute('aria-hidden', 'true');
  });

  it('announces Backspace as well as Delete, because a Mac laptop Delete key sends Backspace', () => {
    render(
      <Tabs
        label="Open documents"
        items={OPEN}
        activeId="a"
        onActivate={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // The pair has to agree three ways: what the handler accepts, what `aria-keyshortcuts` says,
    // and what the key is physically labelled. Announcing only 'Delete' names a key a large share
    // of people do not have.
    expect(screen.getByRole('tab', { name: 'Roadmap' })).toHaveAttribute(
      'aria-keyshortcuts',
      'Delete Backspace',
    );
  });

  it('writes the shortcut where a sighted keyboard user can find it', () => {
    // `aria-keyshortcuts` reaches a screen reader and nobody else. Somebody who navigates by
    // keyboard and can see the strip has no other way to learn that Delete closes a tab.
    render(
      <Tabs
        label="Open documents"
        items={OPEN}
        activeId="a"
        onActivate={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Roadmap' })).toHaveAttribute(
      'title',
      'Roadmap (Delete to close)',
    );
    expect(screen.getByTitle('Close Roadmap (Delete)')).toBeInTheDocument();
  });

  it.each(['Backspace', 'Delete'])(
    'closes the focused tab from the keyboard with %s',
    async (key) => {
      const user = userEvent.setup();
      const onClose = vi.fn();

      render(
        <Tabs
          label="Open documents"
          items={OPEN}
          activeId="a"
          onActivate={vi.fn()}
          onClose={onClose}
        />,
      );
      screen.getByRole('tab', { name: 'Roadmap' }).focus();

      await user.keyboard(`{${key}}`);
      expect(onClose).toHaveBeenCalledWith('b');
    },
  );

  it('ignores Delete on a tab marked not closable', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const items: readonly TabItem[] = [
      { id: 'a', label: 'Meeting notes', pinned: true, closable: false },
    ];

    render(
      <Tabs
        label="Open documents"
        items={items}
        activeId="a"
        onActivate={vi.fn()}
        onClose={onClose}
      />,
    );
    screen.getByRole('tab', { name: 'Meeting notes' }).focus();

    await user.keyboard('{Delete}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers no close control for a tab marked not closable', () => {
    const items: readonly TabItem[] = [
      { id: 'a', label: 'Meeting notes', pinned: true, closable: false },
    ];

    render(
      <Tabs
        label="Open documents"
        items={items}
        activeId="a"
        onActivate={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByTitle('Close Meeting notes (Delete)')).not.toBeInTheDocument();
    const tab = screen.getByRole('tab', { name: 'Meeting notes' });
    expect(tab).not.toHaveAttribute('aria-keyshortcuts');
    // Nor the tooltip that promises the shortcut, which would be a lie on this tab.
    expect(tab).not.toHaveAttribute('title');
  });

  it('offers no close control at all when the caller does not accept one', () => {
    render(<Tabs label="Open documents" items={OPEN} activeId="a" onActivate={vi.fn()} />);

    expect(screen.queryByTitle(/^Close /)).not.toBeInTheDocument();
  });

  it('opts tabs into native dragging and reports the document that started it', () => {
    const onTabDragStart = vi.fn();
    const onTabDragEnd = vi.fn();
    const dataTransfer = { effectAllowed: 'all', setData: vi.fn() } as unknown as DataTransfer;
    render(
      <Tabs
        label="Open documents"
        items={OPEN}
        activeId="a"
        onActivate={vi.fn()}
        drag={{ onStart: onTabDragStart, onEnd: onTabDragEnd }}
      />,
    );

    const tab = screen.getByRole('tab', { name: 'Roadmap' });
    expect(tab).toHaveAttribute('draggable', 'true');
    expect(tab).toHaveAttribute('title', 'Roadmap (Drag to another pane)');

    fireEvent.dragStart(tab, { dataTransfer });
    fireEvent.dragEnd(tab, { dataTransfer });

    expect(onTabDragStart).toHaveBeenCalledWith('b', expect.any(Object));
    expect(onTabDragEnd).toHaveBeenCalledOnce();
  });

  it('does not make tabs draggable without an explicit transfer surface', () => {
    render(<Tabs label="Open documents" items={OPEN} activeId="a" onActivate={vi.fn()} />);

    expect(screen.getByRole('tab', { name: 'Roadmap' })).not.toHaveAttribute('draggable');
  });

  it('caps a long title to a fixed width, leaving truncation and the strip scroll to do the rest', () => {
    const long: readonly TabItem[] = [
      {
        id: 'a',
        label: 'Q3 planning notes for the whole team, cross-linked to every project this touches',
        pinned: true,
      },
      { id: 'b', label: 'Roadmap', pinned: true },
    ];
    render(
      <Tabs
        label="Open documents"
        items={long}
        activeId="a"
        onActivate={vi.fn()}
        className="flex-1"
      />,
    );

    const tab = screen.getByRole('tab', { name: /Q3 planning notes/ });
    // The class, not a measured width jsdom cannot lay out - a fixed cap is what leaves the tab
    // after it, and the strip's own scroll and close controls, on screen regardless of the string.
    expect(tab.className).toMatch(/\bmax-w-48\b/);
    expect(tab.className).toContain('any-pointer-coarse:min-h-(--control-lg)');
    expect(tab.querySelector('span')).toHaveClass('truncate');

    // The strip itself must be able to shrink below its content for `overflow-x-auto` to ever
    // engage, including when a caller also hands it `flex-1` (`document-tab-strip.tsx` does).
    expect(screen.getByRole('tablist').className).toMatch(/\bmin-w-0\b/);
  });
});

describe('a vertical strip', () => {
  it('says so, rather than leaving assistive technology to assume the default', () => {
    render(
      <Tabs
        label="Open documents"
        items={OPEN}
        activeId="a"
        onActivate={vi.fn()}
        orientation="vertical"
      />,
    );

    expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('does not say so for the horizontal default', () => {
    render(<Tabs label="Open documents" items={OPEN} activeId="a" onActivate={vi.fn()} />);

    expect(screen.getByRole('tablist')).not.toHaveAttribute('aria-orientation');
  });

  it('moves focus with Down and Up rather than Left and Right', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();

    render(
      <Tabs
        label="Open documents"
        items={OPEN}
        activeId="a"
        onActivate={onActivate}
        orientation="vertical"
      />,
    );
    screen.getByRole('tab', { name: 'Meeting notes' }).focus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('tab', { name: 'Roadmap' })).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('tab', { name: 'Meeting notes' })).toHaveFocus();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('does not answer to the horizontal strip’s own arrow keys', async () => {
    const user = userEvent.setup();

    render(
      <Tabs
        label="Open documents"
        items={OPEN}
        activeId="a"
        onActivate={vi.fn()}
        orientation="vertical"
      />,
    );
    screen.getByRole('tab', { name: 'Meeting notes' }).focus();

    await user.keyboard('{ArrowRight}');
    // A tablist that answered to both axes would be lying about `aria-orientation`.
    expect(screen.getByRole('tab', { name: 'Meeting notes' })).toHaveFocus();
  });

  it('offers the actions the caller builds for the tab that was secondary-clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const contextMenu = vi.fn((id: string) => [
      { kind: 'action' as const, label: `Close ${id}`, onSelect },
    ]);
    render(
      <Tabs
        label="Open documents"
        items={OPEN}
        activeId="a"
        onActivate={vi.fn()}
        contextMenu={contextMenu}
      />,
    );

    expect(fireEvent.contextMenu(screen.getByRole('tab', { name: 'Roadmap' }))).toBe(false);
    // Open, but not rendered inside the tablist, which may own nothing but tabs.
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(within(screen.getByRole('tablist')).queryByRole('menu')).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Close b' }));

    expect(contextMenu).toHaveBeenCalledWith('b');
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('leaves the browser menu alone without a context menu', () => {
    render(<Tabs label="Open documents" items={OPEN} activeId="a" onActivate={vi.fn()} />);

    expect(fireEvent.contextMenu(screen.getByRole('tab', { name: 'Roadmap' }))).toBe(true);
  });

  it('keeps its labels out of text selection while leaving fields inside selectable', () => {
    render(<Tabs label="Open documents" items={OPEN} activeId="a" onActivate={vi.fn()} />);

    expect(screen.getByRole('tablist')).toHaveClass(
      'select-none',
      '[&_:is(input,textarea,[contenteditable]:not([contenteditable=false]))]:select-text',
    );
  });
});
