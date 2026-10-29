import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { View } from '@nix/web-collections/core/container-model';
import { ViewSwitcher } from '../../../core/view-switcher';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { aView } from '@nix/web-collections/testing/view-fixture';

/**
 * The per-container switcher.
 *
 * What it protects is the shape of the product rather than any behaviour: a board is a way of
 * looking at a folder, so the control that chooses it belongs above that folder's contents and
 * moves with you. The assertions worth having are about what it refuses to hide.
 */

function viewOf(overrides: Partial<View> & { id: string; name: string }): View {
  return aView(overrides);
}

const VIEWS: View[] = [
  viewOf({ id: 'all', name: 'All' }),
  viewOf({ id: 'by-status', name: 'By status', kind: 'board', groupBy: 'status' }),
  viewOf({ id: 'schedule', name: 'Schedule', kind: 'calendar', dateProperty: 'due' }),
];

describe('the view switcher', () => {
  it('offers every view the container defines', () => {
    render(<ViewSwitcher views={VIEWS} unrenderable={[]} activeViewId="all" onSelect={vi.fn()} />);

    expect(screen.getByRole('button', { name: /^all$/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /by status/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /schedule/i })).toBeVisible();
  });

  it('marks the active view as the current one', () => {
    render(
      <ViewSwitcher views={VIEWS} unrenderable={[]} activeViewId="by-status" onSelect={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: /by status/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('button', { name: /^all$/i })).not.toHaveAttribute('aria-current');
  });

  it('brings the current view into the scrolled strip when it changes', () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');

    try {
      const { rerender } = render(
        <ViewSwitcher views={VIEWS} unrenderable={[]} activeViewId="all" onSelect={vi.fn()} />,
      );
      scrolled.mockClear();

      rerender(
        <ViewSwitcher views={VIEWS} unrenderable={[]} activeViewId="schedule" onSelect={vi.fn()} />,
      );

      expect(scrolled).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
      expect(scrolled.mock.contexts[0]).toBe(screen.getByRole('button', { name: /schedule/i }));
    } finally {
      scrolled.mockRestore();
    }
  });

  it('reports which view was chosen', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(<ViewSwitcher views={VIEWS} unrenderable={[]} activeViewId="all" onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: /schedule/i }));

    expect(onSelect).toHaveBeenCalledWith('schedule');
  });

  it('still offers a view that cannot currently render, and marks it', () => {
    render(
      <ViewSwitcher
        views={VIEWS}
        unrenderable={['by-status']}
        activeViewId="all"
        onSelect={vi.fn()}
      />,
    );

    // Hiding it would leave somebody who deleted the property their board groups by with no way
    // back to their own configuration.
    expect(screen.getByRole('button', { name: /by status.*needs attention/i })).toBeVisible();
  });

  it('carries the warning in the name rather than in colour alone', () => {
    render(
      <ViewSwitcher
        views={VIEWS}
        unrenderable={['by-status']}
        activeViewId="all"
        onSelect={vi.fn()}
      />,
    );

    // A mark a screen reader cannot hear is a mark half the people who need it will not get.
    const broken = screen.getByRole('button', { name: /by status/i });
    const healthy = screen.getByRole('button', { name: /^all$/i });

    expect(broken.textContent).toContain('needs attention');
    expect(healthy.textContent).not.toContain('needs attention');
  });

  it('renders nothing at all when the container defines no views', () => {
    const { container } = render(
      <ViewSwitcher views={[]} unrenderable={[]} activeViewId={null} onSelect={vi.fn()} />,
    );

    // A switcher with one implicit option is chrome that explains nothing. Most containers have
    // no views configured, and they should not carry an empty bar saying so.
    expect(container).toBeEmptyDOMElement();
  });

  it('still offers a view whose kind this build does not know', () => {
    render(
      <ViewSwitcher
        views={[viewOf({ id: 'sketch', name: 'Sketch', kind: 'canvas' })]}
        unrenderable={[]}
        activeViewId="sketch"
        onSelect={vi.fn()}
      />,
    );

    // A newer build's view is somebody's configuration. Dropping it from the switcher would make
    // an older client look like it had deleted their work.
    expect(screen.getByRole('button', { name: /sketch/i })).toBeVisible();
  });

  it('marks the default entry with a description and leaves its name plain', () => {
    render(
      <ViewSwitcher
        views={VIEWS}
        unrenderable={[]}
        activeViewId="all"
        onSelect={vi.fn()}
        documentLabel="Body"
        defaultViewId="document"
      />,
    );

    // The state rides on the description, not the name: a name that grows "(default)" breaks
    // voice control ("click Body") and every exact-name lookup.
    const body = screen.getByRole('button', { name: 'Body' });
    expect(body).toHaveAccessibleDescription('Opens by default');
    expect(screen.getByRole('button', { name: /^all$/i })).not.toHaveAccessibleDescription();
  });

  it('drops the Document entry, not the views, when the item hides it', () => {
    render(
      <ViewSwitcher
        views={VIEWS}
        unrenderable={[]}
        activeViewId="all"
        onSelect={vi.fn()}
        documentLabel="Body"
        documentHidden
      />,
    );

    expect(screen.queryByRole('button', { name: 'Body' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^all$/i })).toBeVisible();
  });

  it('is one native picker on a phone, marking the default and broken views', async () => {
    stubViewport(false);
    const onSelect = vi.fn();
    try {
      render(
        <ViewSwitcher
          views={VIEWS}
          unrenderable={['by-status']}
          activeViewId="all"
          defaultViewId="all"
          documentLabel="Body"
          onSelect={onSelect}
        />,
      );
      const picker = screen.getByRole('combobox', { name: 'View' });
      expect(picker).toHaveValue('all');
      expect(screen.getByRole('option', { name: 'All (default)' })).toBeInTheDocument();
      expect(
        screen.getByRole('option', { name: 'By status (needs attention)' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^all$/i })).not.toBeInTheDocument();
      await userEvent.selectOptions(picker, 'schedule');
      expect(onSelect).toHaveBeenCalledWith('schedule');
    } finally {
      stubViewport(true);
    }
  });

  it('holds tools and item controls in its own row, after the views', () => {
    render(
      <ViewSwitcher
        views={VIEWS}
        unrenderable={[]}
        activeViewId="all"
        onSelect={vi.fn()}
        tools={<button type="button">Search titles</button>}
        trailing={<button type="button">Details</button>}
      />,
    );

    const names = screen.getAllByRole('button').map((button) => button.textContent);
    expect(names.slice(-2)).toEqual(['Search titles', 'Details']);
  });
});
