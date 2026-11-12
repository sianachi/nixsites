import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';

/**
 * The settings panel.
 *
 * Two ghost buttons opening two modals became one control opening one panel with three panes. The
 * rename inside it is the substantive part: "Properties" named both the values on an item and the
 * schema it gives its children, which are different questions that happened to share a word.
 */

let stored: Map<string, string>;

beforeEach(() => {
  signedIn();
  stored = new Map();

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

const NOTE = item({ id: '5a5a5a5a-5555-4555-8555-5a5a5a5a5a5a', title: 'Roadmap' });

describe('the settings panel', () => {
  it('is closed until asked for, because most visits are reading', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    expect(await screen.findByRole('button', { name: /settings/i })).toBeVisible();
    expect(screen.queryByRole('complementary', { name: /item settings/i })).not.toBeInTheDocument();
  });

  it('offers the three panes, and says which is current', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await user.click(await screen.findByRole('button', { name: /settings/i }));
    const panel = await screen.findByRole('complementary', { name: /item settings/i });

    // Details is this item's own values; Fields is what the things inside it may carry. Both were
    // called Properties, which is the collision this settles.
    expect(within(panel).getByRole('button', { name: 'Details' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(within(panel).getByRole('button', { name: 'Fields' })).toBeVisible();
    expect(within(panel).getByRole('button', { name: 'Views' })).toBeVisible();
  });

  it('switches pane without closing', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await user.click(await screen.findByRole('button', { name: /settings/i }));
    const panel = await screen.findByRole('complementary', { name: /item settings/i });

    await user.click(within(panel).getByRole('button', { name: 'Views' }));

    expect(await within(panel).findByRole('button', { name: /save views/i })).toBeVisible();
    expect(within(panel).queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
  });

  it('switches to the Backlinks and Outline tabs', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await user.click(await screen.findByRole('button', { name: /settings/i }));
    const panel = await screen.findByRole('complementary', { name: /item settings/i });

    await user.click(within(panel).getByRole('button', { name: 'Backlinks' }));
    expect(await within(panel).findByText(/nothing links here yet/i)).toBeVisible();

    await user.click(within(panel).getByRole('button', { name: 'Outline' }));
    expect(within(panel).getByRole('button', { name: 'Outline' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(await within(panel).findByText(/no headings yet|open a note/i)).toBeVisible();
  });

  it('offers no Site entry or pane on a deployment without sites', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await user.click(await screen.findByRole('button', { name: /item actions/i }));
    expect(await screen.findByRole('menuitem', { name: 'Export' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: /site/i })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: /settings/i }));
    const panel = await screen.findByRole('complementary', { name: /item settings/i });
    expect(within(panel).queryByRole('button', { name: 'Site' })).not.toBeInTheDocument();
  });

  it('hides the Site entry when the deployment has sites but the person has not turned publishing on', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE], siteFeature: true });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await user.click(await screen.findByRole('button', { name: /item actions/i }));
    expect(await screen.findByRole('menuitem', { name: 'Export' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: /site/i })).not.toBeInTheDocument();
  });

  it('opens on the Site pane from the item actions', async () => {
    const user = userEvent.setup();
    stubCoreApi({
      items: [NOTE],
      siteFeature: true,
      uiSettings: { 'sites.publishingEnabled': true },
    });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await user.click(await screen.findByRole('button', { name: /item actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Site' }));
    const panel = await screen.findByRole('complementary', { name: /item settings/i });

    expect(within(panel).getByRole('button', { name: 'Site' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('keeps template suggestions out of the Views pane', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await user.click(await screen.findByRole('button', { name: /settings/i }));
    const panel = await screen.findByRole('complementary', { name: /item settings/i });
    await user.click(within(panel).getByRole('button', { name: 'Views' }));

    expect(await within(panel).findByText(/no child-item views yet/i)).toBeVisible();
    expect(within(panel).queryByText(/start from a template/i)).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /kanban board/i })).not.toBeInTheDocument();
  });

  it('opens beside the note on a wide desktop and starts closed on the next note', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    const first = renderAt(<App />, `/?item=${NOTE.id}`);

    await user.click(await screen.findByRole('button', { name: /settings/i }));
    const sidebar = await screen.findByRole('complementary', { name: /item settings/i });
    expect(sidebar).toBeVisible();
    expect(sidebar.closest('dialog')).toBeNull();

    first.unmount();
    renderAt(<App />, `/?item=${NOTE.id}`);
    await screen.findByRole('button', { name: /settings/i });
    expect(screen.queryByRole('complementary', { name: /item settings/i })).not.toBeInTheDocument();
  });
});
