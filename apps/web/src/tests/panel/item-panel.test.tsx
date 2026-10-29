import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { STORAGE_KEY, readPanelOpen, storePanelOpen } from '../../panel/panel-state';

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

  it('opens beside what it configures rather than over it', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await user.click(await screen.findByRole('button', { name: /settings/i }));

    // A dialog is the wrong shape for configuring a view: it covers the view, so every change
    // means closing it to look and reopening it to carry on.
    const panel = await screen.findByRole('complementary', { name: /item settings/i });

    expect(panel).toBeVisible();
    expect(panel).toHaveClass('w-[340px]', 'max-w-full');
    expect(screen.getByRole('textbox', { name: /note title/i })).toBeVisible();
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

  it('remembers being open', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    await user.click(await screen.findByRole('button', { name: /settings/i }));

    await waitFor(() => {
      expect(stored.get(STORAGE_KEY)).toBe('open');
    });
  });
});

describe('remembering the choice', () => {
  it('defaults to closed', () => {
    expect(readPanelOpen(undefined)).toBe(false);
  });

  it('stores closed as absence rather than as a second spelling', () => {
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    } as unknown as Storage;

    storePanelOpen(storage, true);
    expect(stored.get(STORAGE_KEY)).toBe('open');

    storePanelOpen(storage, false);
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

    expect(readPanelOpen(refusing)).toBe(false);
    expect(() => {
      storePanelOpen(refusing, true);
    }).not.toThrow();
  });
});
