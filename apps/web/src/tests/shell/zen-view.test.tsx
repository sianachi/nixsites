import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import { setZenMode } from '@nix/web-foundation/lib/zen-mode';
import { item, stubCoreApi, STUB_WORKSPACE_ID } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { stubViewport } from '../stub-viewport';

beforeEach(() => {
  signedIn();
});

afterEach(() => {
  setZenMode(false);
});

describe('Zen on workspace pages', () => {
  it.each([
    '',
    '/calendar',
    '/settings',
    '/pet',
    '/graph',
    '/bookmarks',
    '/trash',
    '/templates',
    '/automations',
  ])('focuses content and restores navigation on %s', async (path) => {
    const user = userEvent.setup();
    renderAt(<App />, `/w/${STUB_WORKSPACE_ID}${path}`);

    const enter = await screen.findByRole('button', { name: 'Enter Zen mode' });
    const main = screen.getByRole('main');
    await user.click(enter);

    expect(screen.queryByRole('banner', { name: 'Workspace controls' })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: /explorer/i })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(main.contains(document.activeElement)).toBe(true);
    });
    const exit = screen.getByRole('button', { name: 'Exit Zen mode' });
    expect(exit).toBeVisible();
    expect(exit).not.toHaveClass('opacity-0', 'pointer-events-none');
    await user.click(exit);

    expect(screen.getByRole('banner', { name: 'Workspace controls' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enter Zen mode' })).toBeVisible();
  });

  it('leaves the selected container view mounted while its controls step aside', async () => {
    const user = userEvent.setup();
    const parent = item({
      id: '2a2a2a2a-2222-4222-8222-2a2a2a2a2a2a',
      title: 'Life plan',
      hasChildren: true,
    });
    const child = item({
      id: '2b2b2b2b-2222-4222-8222-2b2b2b2b2b2b',
      title: 'Spend time outdoors',
      parentId: parent.id,
    });
    stubCoreApi({
      items: [parent, child],
      views: {
        [parent.id]: {
          views: [{ id: 'plan', name: 'Plan', kind: 'list', columns: [] }],
          default: 'plan',
        },
      },
    });
    renderAt(<App />, `/?item=${parent.id}`);
    const row = await screen.findByRole('rowheader', { name: child.title });
    const title = screen.getByRole('textbox', { name: 'Note title' });
    expect(title).toHaveClass('text-lg');
    await user.click(
      within(screen.getByRole('banner', { name: 'Workspace controls' })).getByRole('button', {
        name: 'Enter Zen mode',
      }),
    );

    expect(screen.getByRole('rowheader', { name: child.title })).toBe(row);
    expect(title).toHaveValue(parent.title);
    expect(screen.queryByRole('navigation', { name: 'Views' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Exit Zen mode' }));
    expect(screen.getByRole('rowheader', { name: child.title })).toBe(row);
  });

  it('offers enter and exit controls on a small screen', async () => {
    const user = userEvent.setup();
    stubViewport(240);
    renderAt(<App />, `/w/${STUB_WORKSPACE_ID}/calendar`);
    await user.click(await screen.findByRole('button', { name: 'Enter Zen mode' }));

    expect(screen.queryByRole('navigation', { name: 'Mobile navigation' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Exit Zen mode' }));
    expect(screen.getByRole('navigation', { name: 'Mobile navigation' })).toBeInTheDocument();
  });

  it('lets the mobile skip link leave the drawer for a page without an item pane', async () => {
    const user = userEvent.setup();
    stubViewport(320);
    renderAt(<App />, `/w/${STUB_WORKSPACE_ID}/settings`);
    await user.click(await screen.findByRole('button', { name: 'Show the Explorer' }));
    await user.click(screen.getByRole('link', { name: 'Skip to content' }));
    await waitFor(() => {
      expect(screen.getByRole('main')).toHaveFocus();
    });
    expect(screen.getByRole('button', { name: 'Show the Explorer' })).toBeInTheDocument();
  });

  it('lets Escape close a search dialog before it leaves Zen', async () => {
    const user = userEvent.setup();
    renderAt(<App />, `/w/${STUB_WORKSPACE_ID}/calendar`);
    await user.click(await screen.findByRole('button', { name: 'Enter Zen mode' }));
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('dialog', { name: /Search/ })).toBeInTheDocument();
    // jsdom does not translate Escape into a native dialog cancel.
    fireEvent(
      screen.getByRole('dialog', { name: /Search/ }),
      new Event('cancel', { cancelable: true }),
    );
    expect(screen.queryByRole('dialog', { name: /Search/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exit Zen mode' })).toBeInTheDocument();
    screen.getByRole('main').focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Exit Zen mode' })).not.toBeInTheDocument();
  });
});
