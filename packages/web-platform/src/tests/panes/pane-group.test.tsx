import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PaneGroup } from '../../panes/pane-group';
import { paneElementId } from '../../panes/pane-params';
import type { PaneState } from '../../panes/pane-state';

/**
 * The arrangement on screen, and how the group wires the handles between the panes.
 *
 * The handle itself - its keys, its drag arithmetic, its announced value - is `@nix/ui`'s
 * `PaneDivider`, tested in that package. What is worth testing here is what only the group can
 * get wrong: how many handles there are, what each is named, and that a handle's commit lands on
 * the right pair of shares in the group's own list.
 */

const panes: PaneState[] = [
  { index: 0, itemId: '00000000-0000-4000-8000-000000000001' },
  { index: 1, itemId: '00000000-0000-4000-8000-000000000002' },
];

function renderGroup(overrides: Partial<Parameters<typeof PaneGroup>[0]> = {}) {
  const onSizes = vi.fn();

  render(
    <PaneGroup
      panes={panes}
      split="vertical"
      sizes={null}
      onSizes={onSizes}
      describePane={(pane) => (pane.index === 0 ? 'Spec' : 'Notes')}
      // The id the real page puts on each pane's `<article>` (`editor-page.tsx`), carried here
      // because a handle's `aria-controls` points at it: a harness that rendered a bare paragraph
      // would leave every reference in this file dangling and nothing would say so.
      renderPane={(pane) => <p id={paneElementId(pane.index)}>Pane {pane.index}</p>}
      {...overrides}
    />,
  );

  return { onSizes };
}

describe('the pane group', () => {
  it('draws every pane', () => {
    renderGroup();

    expect(screen.getByText('Pane 0')).toBeInTheDocument();
    expect(screen.getByText('Pane 1')).toBeInTheDocument();
  });

  it('puts one handle between two panes, and none before the first', () => {
    renderGroup();

    expect(screen.getAllByRole('separator')).toHaveLength(1);
  });

  it('puts a handle between each pair of three', () => {
    renderGroup({
      panes: [...panes, { index: 2, itemId: '00000000-0000-4000-8000-000000000003' }],
    });

    expect(screen.getAllByRole('separator')).toHaveLength(2);
  });

  it('draws no handle for a single pane', () => {
    renderGroup({ panes: panes.slice(0, 1) });

    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });

  it('names each handle after the two panes it moves', () => {
    renderGroup();

    expect(screen.getByRole('separator', { name: 'Resize Spec and Notes' })).toBeInTheDocument();
  });

  it('turns the handle to match the way the panes are arranged', () => {
    // The divider's own axis, not the arrangement's: two panes side by side are separated by a
    // vertical line. The split-to-orientation mapping is the group's job, so it is pinned here.
    renderGroup();
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical');

    cleanup();
    renderGroup({ split: 'horizontal' });
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal');
  });

  it('points each handle at a pane that is actually on the page', () => {
    // An `aria-controls` naming an id nothing carries is reported as a broken relationship, which
    // is a worse answer than having said nothing at all - so the reference is followed rather
    // than compared to a string this test also computes.
    renderGroup({
      panes: [...panes, { index: 2, itemId: '00000000-0000-4000-8000-000000000003' }],
      describePane: (pane) => `pane ${String(pane.index + 1)}`,
    });

    const handles = screen.getAllByRole('separator');
    expect(handles).toHaveLength(2);

    for (const [offset, handle] of handles.entries()) {
      const controls = handle.getAttribute('aria-controls') ?? '';
      expect(controls).not.toBe('');

      // The pane *before* the handle: the announced share is a share of that one.
      expect(document.getElementById(controls)).toHaveTextContent(`Pane ${String(offset)}`);
    }
  });

  it('gives an evenly divided group even shares for the handle to report', () => {
    renderGroup();

    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '50');
  });
});

describe('committing a resize into the group', () => {
  it("lands a handle's commit on the whole ratio, not only the pair it moved", async () => {
    const user = userEvent.setup();
    const { onSizes } = renderGroup();

    screen.getByRole('separator').focus();
    await user.keyboard('{ArrowRight}');

    expect(onSizes).toHaveBeenCalledWith([51, 49]);
  });

  it('moves the right pair when the middle handle of three is used', async () => {
    // The one mistake only the group can make: the divider drawn before pane n trades between
    // shares n-1 and n, and an off-by-one here resizes a pane nobody touched.
    const user = userEvent.setup();
    const { onSizes } = renderGroup({
      panes: [...panes, { index: 2, itemId: '00000000-0000-4000-8000-000000000003' }],
      sizes: [20, 40, 40],
      describePane: (pane) => `pane ${String(pane.index + 1)}`,
    });

    screen.getByRole('separator', { name: 'Resize pane 2 and pane 3' }).focus();
    await user.keyboard('{ArrowRight}');

    expect(onSizes).toHaveBeenCalledWith([20, 40.8, 39.2]);
  });
});

describe('previewing a resize through the group', () => {
  /**
   * The drag path, with the geometry stubbed: jsdom lays nothing out, so the rects the divider
   * measures are supplied here. What is worth checking at this level is not the arithmetic - that
   * is `@nix/ui`'s - but that the group turns a preview into a write on the *right two* custom
   * properties, without a React render. That is the whole reason the property exists: a
   * `setState` per pointer event would re-render every open editor sixty times a second.
   */
  it('writes only the dragged pair of shares straight to the group, leaving the third alone', () => {
    const { onSizes } = renderGroup({
      panes: [...panes, { index: 2, itemId: '00000000-0000-4000-8000-000000000003' }],
      sizes: [20, 40, 40],
      describePane: (pane) => `pane ${String(pane.index + 1)}`,
    });

    const handle = screen.getByRole('separator', { name: 'Resize pane 2 and pane 3' });
    handle.setPointerCapture = vi.fn();

    const group = handle.parentElement;
    expect(group).toBeInstanceOf(HTMLElement);
    const before = group?.style.getPropertyValue('--pane-share-0');

    // The pair either side of this handle spans 0-1000; a pointer at 700 is 70% of the way
    // across it, so the pair's 80 is split 56/24.
    const first = handle.previousElementSibling as HTMLElement;
    const second = handle.nextElementSibling as HTMLElement;
    first.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 800 }) as DOMRect;
    second.getBoundingClientRect = () =>
      ({ left: 500, top: 0, right: 1000, bottom: 800 }) as DOMRect;

    handle.dispatchEvent(
      new PointerEvent('pointerdown', { clientX: 500, clientY: 400, button: 0, bubbles: true }),
    );
    handle.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 700, clientY: 400, button: 0, bubbles: true }),
    );

    expect(group?.style.getPropertyValue('--pane-share-1')).toBe('56');
    expect(group?.style.getPropertyValue('--pane-share-2')).toBe('24');

    // The pane nobody touched keeps the share it had, and nothing settled: a preview is not a
    // commit, so the address is not written until the pointer comes up.
    expect(group?.style.getPropertyValue('--pane-share-0')).toBe(before);
    expect(onSizes).not.toHaveBeenCalled();
  });
});
