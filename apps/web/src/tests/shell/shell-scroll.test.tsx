import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { App } from '../../app';

/**
 * The shell's scroll model, as a structural contract.
 *
 * **What these cannot do.** jsdom performs no layout: every element is zero by
 * zero, nothing overflows anything, and no scrollbar exists to count. So none
 * of this proves the page does not scroll sideways. That is checked by opening
 * the app at 1280x720 on a container wide enough to overflow and confirming
 * `document.documentElement.scrollWidth === clientWidth` while the sidebar
 * stays put.
 *
 * **What they do.** The model is a few structural claims - one height owner,
 * panes that clip, one scroller per pane on one axis - and each is checkable.
 * They are anchored on landmarks found by role and then read off the class
 * contract, because a class list is where this particular design lives.
 *
 * **Every test here mounts a container view on purpose.** The pane scroller
 * only exists on that branch: at `/` with no item selected the editor renders a
 * one-line placeholder and there is no scroller in the tree at all, so an
 * assertion about it passes against the code this goal replaced just as well as
 * against the fix. An earlier draft of this file did exactly that and certified
 * nothing.
 */
beforeEach(() => {
  signedIn();
});

const CONTAINER = item({
  id: '2a2a2a2a-2222-4222-8222-2a2a2a2a2a2a',
  title: 'Roadmap',
  hasChildren: true,
});

const CHILD = item({
  id: '2b2b2b2b-2222-4222-8222-2b2b2b2b2b2b',
  title: 'Q1',
  parentId: CONTAINER.id,
});

const LIST_VIEW = {
  id: 'everything',
  name: 'Everything',
  kind: 'list',
  columns: [],
  groupBy: null,
  groupOrder: [],
  dateProperty: null,
  sortBy: null,
  sortDescending: false,
  mode: null,
  coverProperty: null,
  endDateProperty: null,
  cardSize: null,
  layout: null,
};

/** Opens the container on its list view, and waits until the rows are really there. */
async function openContainer(): Promise<void> {
  stubCoreApi({
    items: [CONTAINER, CHILD],
    views: { [CONTAINER.id]: { views: [LIST_VIEW], default: 'everything' } },
  });
  renderAt(<App />, `/?item=${CONTAINER.id}`);

  await screen.findByRole('rowheader', { name: 'Q1' });
}

describe('the shell scroll model', () => {
  it('makes one element as tall as the viewport, and that element clips', async () => {
    await openContainer();

    // Anchored on the main landmark rather than counted across the document: a
    // full-height overlay elsewhere would break a global count without anything
    // being wrong, and the count would not say which element or why.
    const owner = screen.getByRole('main').closest('.h-dvh');

    expect(owner).not.toBeNull();
    expect(owner).toHaveClass('overflow-hidden');

    // And it is the only one on the path, so nothing between it and the panes
    // gets to disagree about how tall the shell is.
    expect(owner?.parentElement?.closest('.h-dvh')).toBeNull();
  });

  it('gives the workspace tree a scroller inside itself rather than making the pane one', async () => {
    await openContainer();

    const sidebar = screen.getByRole('complementary', { name: /explorer/i });

    // The landmark clips and the list within it scrolls. The other way round
    // would scroll the "Explorer" heading and the New button away with the
    // tree.
    expect(sidebar).toHaveClass('overflow-hidden');
    expect(sidebar.querySelectorAll('.overflow-y-auto')).toHaveLength(1);
  });

  it('gives the container pane one scroller, and the view inside it owns the wide axis', async () => {
    await openContainer();

    const pane = screen.getByRole('region', { name: 'Container' });

    // One scroller in the pane, not two stacked ones.
    expect(pane.querySelectorAll('.overflow-y-auto')).toHaveLength(1);

    // The load-bearing half. A wide view must bring its own horizontal
    // scroller, because the pane's cannot be restricted to one axis: CSS
    // Overflow 3 computes the other axis to `auto` as soon as one leaves
    // `visible`, so `overflow-y-auto` and `overflow-auto` are the same scroll
    // container. What keeps the pane's horizontal axis dormant is that this
    // inner scroller constrains the table to the pane's width, leaving the
    // pane's own nothing to scroll.
    expect(within(pane).getByRole('table').closest('.overflow-x-auto')).not.toBeNull();
  });

  it('clips every pane between the height owner and the view', async () => {
    await openContainer();

    // A pane that shrinks but does not clip still lets a wide descendant paint
    // over its neighbour: `min-w-0` and `overflow-hidden` answer different
    // questions and the model needs both.
    for (const pane of [
      screen.getByRole('main'),
      screen.getByRole('article'),
      screen.getByRole('region', { name: 'Container' }),
    ]) {
      expect(pane).toHaveClass('overflow-hidden', 'min-w-0', 'min-h-0');
    }
  });
});
