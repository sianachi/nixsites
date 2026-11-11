import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';

/**
 * The flows, rather than the pixels.
 *
 * Each of these was a hole somebody would fall into rather than a thing that looked wrong: an item
 * that could only ever be created at the workspace root, a trail that showed where you were and
 * refused to take you there, a delete button revealed on hover with nothing between it and the
 * deletion, and a new item left called "Untitled note" for you to go and find.
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

describe('creating an item', () => {
  it('puts it in the workspace when nothing is selected', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });

    await user.click(screen.getByRole('button', { name: 'Add note' }));
    const capture = await screen.findByRole('dialog', { name: 'New note' });
    await user.click(within(capture).getByRole('button', { name: 'Structured item' }));
    const view = await screen.findByRole('dialog', { name: 'New structured item' });
    await user.click(within(view).getByRole('button', { name: /^Canvas/ }));
    const dialog = await screen.findByRole('dialog', { name: 'New canvas' });
    expect(within(dialog).queryByRole('group', { name: 'Where' })).not.toBeInTheDocument();
  });

  it('offers an explicit way to put it inside the item you are looking at', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT, CHILD] });
    renderAt(<App />, `/?item=${PARENT.id}`);

    await screen.findByRole('button', { name: 'Engineering' });

    // Root is the stable default; one choice in the dialog moves the destination, for every kind.
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    const capture = await screen.findByRole('dialog', { name: 'New note' });
    await user.click(within(capture).getByRole('button', { name: 'Structured item' }));
    const dialog = await screen.findByRole('dialog', { name: 'New structured item' });
    const where = within(dialog).getByRole('group', { name: 'Where' });
    expect(within(where).getByRole('button', { name: 'Inside Engineering' })).toBeVisible();
  });

  it('puts it inside a nested item too, rather than beside it', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT, CHILD] });
    renderAt(<App />, `/?item=${CHILD.id}`);

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Roadmap');
    });

    await user.click(screen.getByRole('button', { name: 'Add note' }));
    const capture = await screen.findByRole('dialog', { name: 'New note' });
    await user.click(within(capture).getByRole('button', { name: 'Structured item' }));
    const view = await screen.findByRole('dialog', { name: 'New structured item' });
    await user.click(within(view).getByRole('button', { name: /^Canvas/ }));
    const dialog = await screen.findByRole('dialog', { name: 'New canvas' });
    expect(within(dialog).getByRole('button', { name: 'Inside Roadmap' })).toBeVisible();
  });
});

describe('naming a new item', () => {
  it('selects the placeholder name so it can be typed over', async () => {
    stubCoreApi({
      items: [item({ id: '1c1c1c1c-1111-4111-8111-1c1c1c1c1c1c', title: 'Untitled note' })],
    });
    renderAt(<App />, '/?item=1c1c1c1c-1111-4111-8111-1c1c1c1c1c1c');

    const title = await screen.findByRole('textbox', { name: /note title/i });

    // Selected rather than cleared: renaming is one keystroke, and somebody who came to read
    // instead loses nothing by clicking away.
    await waitFor(() => {
      expect(title).toHaveFocus();
    });
  });

  it('leaves a named item alone', async () => {
    stubCoreApi({ items: [CHILD] });
    renderAt(<App />, `/?item=${CHILD.id}`);

    const title = await screen.findByRole('textbox', { name: /note title/i });

    // Stealing focus every time somebody opened a note would fight anyone trying to read one.
    await waitFor(() => {
      expect(title).not.toHaveFocus();
    });
  });
});

describe('the breadcrumb trail', () => {
  it('takes you to an ancestor', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT, CHILD] });
    renderAt(<App />, `/?item=${CHILD.id}`);

    const trail = await screen.findByRole('navigation', { name: /breadcrumb/i });
    const up = await within(trail).findByRole('button', { name: 'Engineering' });

    await user.click(up);

    // A trail that shows where you are and cannot take you there is a label pretending to be a
    // control, and everybody tries to click it.
    //
    // Asserted on the title field, which is the item that is open. This used to assert on a
    // container region instead, because a folder opened into its views and a note did not - a
    // distinction that no longer exists, and the assertion went with it. The trail itself is the
    // second half: the ancestor is now the last crumb rather than a clickable one, so the screen
    // agrees about where it is.
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /note title/i })).toHaveValue('Engineering');
    });

    expect(within(trail).queryByRole('button', { name: 'Engineering' })).not.toBeInTheDocument();
  });
});

describe('opening an item beside another', () => {
  it('does not render the control at all on a narrow screen, since a phone never has room for a second pane', async () => {
    const user = userEvent.setup();
    stubViewport(false);
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /show the explorer/i }));
    await screen.findByRole('button', { name: 'Engineering' });

    // `'narrow'` is a fact about this viewport, true of every row at once - unlike the pane limit
    // below, it is never going to stop being true without the window itself changing size, so a
    // disabled control here would be permanently visible and permanently useless, and a screen
    // reader would hear its refusal read out on every row in the tree.
    expect(
      screen.queryByRole('button', { name: /open engineering beside/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /cannot open engineering beside/i }),
    ).not.toBeInTheDocument();

    // Nor does the phone offer the full tree's other row actions: its drawer browses and opens.
    expect(screen.queryByRole('button', { name: /delete engineering/i })).not.toBeInTheDocument();
  });

  it('keeps the control visible and disabled at the pane limit, since that refusal is transient', async () => {
    const A = item({ id: '2a2a2a2a-2222-4222-8222-2a2a2a2a2a2a', title: 'Alpha' });
    const B = item({ id: '2b2b2b2b-2222-4222-8222-2b2b2b2b2b2b', title: 'Bravo' });
    const C = item({ id: '2c2c2c2c-2222-4222-8222-2c2c2c2c2c2c', title: 'Charlie' });
    const D = item({ id: '2d2d2d2d-2222-4222-8222-2d2d2d2d2d2d', title: 'Delta' });
    stubCoreApi({ items: [A, B, C, D] });
    renderAt(<App />, `/?item=${A.id}&item2=${B.id}&item3=${C.id}`);

    await screen.findByRole('button', { name: 'Delta' });

    // Unlike the narrow case above, three panes already open is a state of this arrangement, not
    // of this window - closing one changes the answer - so the control stays put, disabled, and
    // says why.
    expect(screen.getByRole('button', { name: /cannot open delta beside/i })).toBeDisabled();
  });
});

describe('deleting an item', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function deleteUser() {
    return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  }

  it('removes the item right away, without asking first', async () => {
    const user = deleteUser();
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });
    await user.click(screen.getByRole('button', { name: /delete engineering/i }));

    // Immediate, in the row's own established grammar: the control is revealed on hover and sits
    // a few pixels from the one that opens the item, which is exactly the situation an undo -
    // rather than a native `confirm()` - is meant to answer.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Engineering' })).not.toBeInTheDocument();
    });
  });

  it('names what it deleted in the undo bar', async () => {
    const user = deleteUser();
    const LEAF = item({ id: '4a4a4a4a-4444-4444-8444-4a4a4a4a4a4a', title: 'Notes' });
    stubCoreApi({ items: [LEAF] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Notes' });
    await user.click(screen.getByRole('button', { name: /delete notes/i }));

    expect(await screen.findByRole('status')).toHaveTextContent('Deleted "Notes"');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('says everything inside it went too, even when the folder was never expanded', async () => {
    const user = deleteUser();
    // PARENT reports `hasChildren: true` from the server; CHILD is never loaded into the client
    // store here because nothing expands PARENT before it is deleted. The wording used to come
    // from `childrenOf(item.id).length`, which is zero until a folder has been opened at least
    // once - so a collapsed folder full of items used to report deleting nothing but itself. The
    // server's own flag does not have that gap.
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });
    await user.click(screen.getByRole('button', { name: /delete engineering/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Deleted "Engineering" and everything inside it',
    );
  });

  it('does not claim a deletion succeeded when the request is refused', async () => {
    const user = deleteUser();
    stubCoreApi({ items: [PARENT], removeFails: true });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });
    await user.click(screen.getByRole('button', { name: /delete engineering/i }));

    // A refused delete leaves the tree exactly as it was, and no toast asserts a deletion that
    // never happened - only the tree's own foot-of-sidebar error does, which the tree already
    // renders for every other kind of failure.
    expect(await screen.findByText('The item could not be deleted.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Engineering' })).toBeInTheDocument();
    expect(screen.queryByText(/Deleted "Engineering"/)).not.toBeInTheDocument();
  });

  it('says an undo could not be completed, rather than letting the toast disappear as if it had worked', async () => {
    const user = deleteUser();
    stubCoreApi({ items: [PARENT], restoreFails: true });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });
    await user.click(screen.getByRole('button', { name: /delete engineering/i }));
    await screen.findByRole('status');
    await user.click(screen.getByRole('button', { name: 'Undo' }));

    // The undo bar says "Undid: ..." the instant Undo is pressed, before the restore could
    // possibly have failed - so a fresh notice, in the item's own name, is what says the attempt
    // did not work.
    expect(await screen.findByText('"Engineering" could not be restored.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Engineering' })).not.toBeInTheDocument();
  });

  it('does not move focus when the failed-undo notice appears, since the reader has already moved on', async () => {
    const user = deleteUser();
    stubCoreApi({ items: [PARENT], restoreFails: true });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });
    await user.click(screen.getByRole('button', { name: /delete engineering/i }));
    await screen.findByRole('status');
    await user.click(screen.getByRole('button', { name: 'Undo' }));

    // Undo's own toast dismisses the instant it is pressed and correctly returns focus to the
    // tree - the same "focus, in both directions" contract every other toast here relies on. What
    // must not happen is the notice that appears moments later, once the restore actually fails,
    // reaching back in and taking focus again - the exact bug already fixed once for the primary
    // deletion toast, reproduced one step later if this one also auto-focused on mount.
    const focusedOnceUndoSettled = document.activeElement;
    expect(await screen.findByText('"Engineering" could not be restored.')).toBeInTheDocument();
    expect(document.activeElement).toBe(focusedOnceUndoSettled);
    expect(screen.getByRole('button', { name: 'Dismiss' })).not.toHaveFocus();
  });

  it('brings the item back when Undo is pressed', async () => {
    const user = deleteUser();
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });
    await user.click(screen.getByRole('button', { name: /delete engineering/i }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Engineering' })).not.toBeInTheDocument();
    });

    await user.click(
      within(await screen.findByRole('status')).getByRole('button', { name: 'Undo' }),
    );

    expect(await screen.findByRole('button', { name: 'Engineering' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('keeps keyboard Undo available after the message and button fade', async () => {
    const user = deleteUser();
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });
    await user.click(screen.getByRole('button', { name: /delete engineering/i }));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeVisible();

    // `act` rather than a bare `await`: the state update the timeout produces is not inside any
    // React-tracked event, so nothing else here forces React to flush it before the assertion.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });

    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Engineering' })).not.toBeInTheDocument();
    await user.keyboard('{Control>}z{/Control}');
    expect(await screen.findByRole('button', { name: 'Engineering' })).toBeInTheDocument();
  });

  it('undoes two deletions in a row, newest first, from one Undo button or Ctrl+Z', async () => {
    const ALPHA = item({ id: '3a3a3a3a-3333-4333-8333-3a3a3a3a3a3a', title: 'Alpha' });
    const BRAVO = item({ id: '3b3b3b3b-3333-4333-8333-3b3b3b3b3b3b', title: 'Bravo' });
    const user = deleteUser();
    stubCoreApi({ items: [ALPHA, BRAVO] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Alpha' });
    await user.click(screen.getByRole('button', { name: /delete alpha/i }));
    await screen.findByText('Deleted "Alpha"');
    await user.click(screen.getByRole('button', { name: /delete bravo/i }));
    await screen.findByText('Deleted "Bravo"');

    await user.click(screen.getByRole('button', { name: 'Undo (2)' }));
    expect(await screen.findByRole('button', { name: 'Bravo' })).toBeInTheDocument();
    // One entry left (the stub's listing hands every item back, so presence of Alpha proves nothing).
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument();

    await user.keyboard('{Control>}z{/Control}');
    expect(await screen.findByRole('button', { name: 'Alpha' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument();
    });
  });
});
