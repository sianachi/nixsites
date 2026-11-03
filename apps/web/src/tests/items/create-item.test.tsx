import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';

/**
 * Making an item, and the two things that used to go wrong when it failed.
 *
 * There is one create path in the application, deliberately. It belongs to the tree, because the
 * tree is the only thing that knows how to put a new item into the store the sidebar reads and to
 * expand its parent so a child made inside a collapsed item is not invisible. A second
 * implementation living beside a view would have to get both right again.
 */

beforeEach(() => {
  signedIn();
});

const PARENT = item({
  id: '4a4a4a4a-4444-4444-8444-4a4a4a4a4a4a',
  title: 'Engineering',
  hasChildren: true,
});

const CHILD = item({
  id: '4b4b4b4b-4444-4444-8444-4b4b4b4b4b4b',
  title: 'Roadmap',
  parentId: PARENT.id,
});

/** Opens New, picks an entry, and returns the dialog it opened. */
async function openNew(
  user: ReturnType<typeof userEvent.setup>,
  entry: string,
  dialogName: string,
): Promise<HTMLElement> {
  // Canvas and sheet are chosen inside New view's dialog; the rest have buttons of their own.
  const viaView = { 'New canvas': /^Canvas/, 'New sheet': /^Sheet/ }[entry];
  if (viaView === undefined) {
    await user.click(screen.getByRole('button', { name: entry }));
  } else {
    await user.click(screen.getByRole('button', { name: 'New view' }));
    const view = await screen.findByRole('dialog', { name: 'New structured item' });
    await user.click(within(view).getByRole('button', { name: viaView }));
  }
  return screen.findByRole('dialog', { name: dialogName });
}

/** Makes an untitled note at the top of the workspace, in one press. */
async function createNote(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'New note' }));
}

describe('creating an item', () => {
  it('puts it in the tree without collapsing what was open', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT, CHILD] });
    renderAt(<App />);

    await user.click(await screen.findByRole('button', { name: /expand engineering/i }));
    expect(await screen.findByRole('button', { name: 'Roadmap' })).toBeVisible();

    await createNote(user);

    // `tree.reload()` re-fetches roots and empties the expanded set, so calling it after a create
    // would close every folder somebody had opened to get here. `tree.create` puts the item into
    // the store itself, which is why it must not be followed by a reload.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Roadmap' })).toBeVisible();
    });
  });

  it('opens a new note in one press', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });
    await createNote(user);

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Untitled note');
    });
  });

  it('puts a new child inside its parent without expanding it in the sidebar', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT, CHILD] });
    renderAt(<App />, `/?item=${PARENT.id}`);

    // Open the parent without expanding it, so the new child lands somewhere closed.
    await screen.findByRole('button', { name: 'Engineering' });
    const dialog = await openNew(user, 'New canvas', 'New canvas');
    await user.click(within(dialog).getByRole('button', { name: 'Inside Engineering' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'Sketch{Enter}');

    expect(await screen.findByRole('button', { name: /expand engineering/i })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /expand engineering/i }));
    expect((await screen.findByRole('button', { name: 'Sketch' })).closest('ul')).toHaveAttribute(
      'role',
      'group',
    );
  });

  it('says what the server said when it refuses', async () => {
    const user = userEvent.setup();
    stubCoreApi({
      items: [PARENT],
      createRefusal: 'Status must be one of Todo, Doing, Done.',
    });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });
    await createNote(user);

    // The server's own sentence, beside the control that was pressed. It used to report the status
    // code alone - "(422)" in place of a sentence naming the property at fault - and it used to put
    // it in the tree-wide error, which renders at the foot of the sidebar.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Status must be one of Todo, Doing, Done.',
    );

    expect(screen.queryByText(/\(422\)/)).not.toBeInTheDocument();
  });

  it('clears a previous refusal when the next attempt is made', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT], createRefusal: 'Status must be one of Todo, Doing, Done.' });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });

    await createNote(user);
    expect(await screen.findByRole('alert')).toBeVisible();

    // A refusal left on screen through the next attempt describes a request that is no longer
    // happening, and somebody reads it as the new one having failed too.
    await createNote(user);
    await waitFor(() => {
      expect(screen.getAllByRole('alert')).toHaveLength(1);
    });
  });
});

describe('the new-item menu', () => {
  it('offers chat and every kind of item as buttons, the note last', async () => {
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />, `/?item=${PARENT.id}`);

    await screen.findByRole('button', { name: 'Engineering' });
    const row = screen.getByRole('button', { name: 'New note' }).parentElement;
    expect(
      Array.from(row?.querySelectorAll('button') ?? []).map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual(['New chat', 'Upload files', 'New view', 'New note']);
  });

  it('names a new item in a dialog before creating it, and closes the menu', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });
    const dialog = await openNew(user, 'New canvas', 'New canvas');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    // Nothing is selected, so there is no "inside" choice to offer.
    expect(within(dialog).getByText(/top of the workspace/i)).toBeVisible();

    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    expect(title).toHaveFocus();
    await user.type(title, 'Moodboard{Enter}');

    expect(await screen.findByRole('button', { name: 'Moodboard' })).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('defaults to the top of the workspace every time it opens', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />, `/?item=${PARENT.id}`);

    await screen.findByRole('button', { name: 'Engineering' });
    let dialog = await openNew(user, 'New canvas', 'New canvas');
    expect(within(dialog).getByRole('button', { name: 'Top of workspace' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Inside Engineering' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    dialog = await openNew(user, 'New canvas', 'New canvas');
    expect(within(dialog).getByRole('button', { name: 'Top of workspace' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('lists every structured item with what it is, and starts the chosen one', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });
    const dialog = await openNew(user, 'New view', 'New structured item');
    // Every recipe, under the headings the registry declares, rather than the old subset.
    const organise = within(dialog).getByRole('list', { name: 'Organise' });
    expect(within(organise).getAllByRole('button').length).toBeGreaterThan(3);
    expect(within(organise).getByText(/columns defined by a select field/i)).toBeVisible();
    expect(within(dialog).getByRole('list', { name: 'Analyse' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: /^chart/i })).toBeVisible();
    expect(within(dialog).getAllByRole('button', { name: /^calendar/i })[0]).toBeVisible();
  });

  it('creates from a library template through a reviewable wizard', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });
    const dialog = await openNew(user, 'New view', 'New structured item');
    const templates = within(dialog).getByRole('list', { name: 'From a template' });
    await user.click(await within(templates).findByRole('button', { name: /^kanban/i }));

    expect(await screen.findByRole('heading', { name: /create from kanban/i })).toBeVisible();
    expect(screen.getByText(/destination: workspace root/i)).toBeVisible();
    expect(screen.getByRole('navigation', { name: /template steps/i })).toBeVisible();
    expect(screen.getByRole('textbox', { name: /name/i })).toHaveValue('Kanban');

    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByRole('heading', { name: /what this template adds/i })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByRole('heading', { name: /review/i })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /create item/i }));

    expect(await screen.findByDisplayValue('Kanban')).toBeVisible();
  });

  it('closes without creating anything', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT] });
    renderAt(<App />);

    await screen.findByRole('button', { name: 'Engineering' });
    // jsdom does not turn Escape into the native dialog's cancel event, so the visible way out
    // stands in for it here; `Dialog`'s own tests cover Escape.
    const dialog = await openNew(user, 'New canvas', 'New canvas');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Untitled canvas' })).not.toBeInTheDocument();
  });
});
