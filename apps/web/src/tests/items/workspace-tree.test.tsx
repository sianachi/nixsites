import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';

/**
 * The tree, driven the way a person drives it.
 *
 * The shape it renders is the shape Core returns - parent, sibling position, lifecycle - and the
 * assertions here are about what that shape buys: folders that open, children that arrive when
 * they are asked for, and a breadcrumb that says where you are.
 */
beforeEach(() => {
  signedIn();
});

// A note that holds another note. It used to be typed 'folder', which is what earned it an expand
// control; the control now comes from whether it actually has children, which is the fact the
// server reports and the only one that cannot be wrong.
const PARENT = item({
  id: '1a1a1a1a-1111-4111-8111-1a1a1a1a1a1a',
  title: 'Engineering',
  hasChildren: true,
});

const CHILD = item({
  id: '1b1b1b1b-1111-4111-8111-1b1b1b1b1b1b',
  title: 'Roadmap',
  parentId: PARENT.id,
});

const ROOT_NOTE = item({
  id: '1c1c1c1c-1111-4111-8111-1c1c1c1c1c1c',
  title: 'Acquisition memo',
  seq: 2000,
});

describe('the workspace tree', () => {
  it('shows the roots and nothing below them until a folder is opened', async () => {
    stubCoreApi({ items: [PARENT, CHILD, ROOT_NOTE] });
    renderAt(<App />);

    expect(await screen.findByRole('button', { name: 'Engineering' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Acquisition memo' })).toBeVisible();

    // A workspace of ten thousand items must not be a ten-thousand-row download to render twelve.
    expect(screen.queryByRole('button', { name: 'Roadmap' })).not.toBeInTheDocument();
  });

  it('fetches a folder s children when it is expanded', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT, CHILD, ROOT_NOTE] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /expand engineering/i }));

    expect(await screen.findByRole('button', { name: 'Roadmap' })).toBeVisible();
  });

  it('collapses again without losing what was loaded', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT, CHILD, ROOT_NOTE] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /expand engineering/i }));
    await screen.findByRole('button', { name: 'Roadmap' });

    await user.click(screen.getByRole('button', { name: /collapse engineering/i }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Roadmap' })).not.toBeInTheDocument();
    });
  });

  it('reports the expanded state to assistive technology', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT, CHILD] });
    renderAt(<App />);

    const treeItem = await screen.findByRole('treeitem', { name: /engineering/i });
    expect(treeItem).toHaveAttribute('aria-expanded', 'false');

    await user.click(screen.getByRole('button', { name: /expand engineering/i }));

    expect(treeItem).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens a note into the editor and puts it in the URL', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [ROOT_NOTE] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: 'Acquisition memo' }));

    // The title is editable in the header, which is how you know the note is open rather than
    // merely highlighted in the tree.
    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue(
      'Acquisition memo',
    );
  });

  it('shows where a nested note sits', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT, CHILD] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /expand engineering/i }));
    await user.click(await screen.findByRole('button', { name: 'Roadmap' }));

    const trail = await screen.findByRole('navigation', { name: /breadcrumb/i });
    expect(within(trail).getByText(/engineering/i)).toBeVisible();
  });

  it('says the workspace is empty rather than showing an empty list', async () => {
    stubCoreApi({ items: [] });
    renderAt(<App />);

    expect(await screen.findByText(/nothing here yet/i)).toBeVisible();
  });

  it('says a load failed and offers a retry, rather than reading as an empty workspace', async () => {
    stubCoreApi({ treeFails: true });
    renderAt(<App />);

    // Loading, empty and failed are three different situations. Collapsing them is how a person
    // ends up staring at "no items" when the request returned a 500.
    expect(
      await within(await screen.findByRole('complementary', { name: 'Explorer' })).findByRole(
        'button',
        {
          name: /try again/i,
        },
      ),
    ).toBeVisible();
    expect(screen.queryByText(/nothing here yet/i)).not.toBeInTheDocument();
  });
});
