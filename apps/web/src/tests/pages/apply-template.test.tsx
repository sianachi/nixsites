import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import { item, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { memoryStorage } from '../memory-storage';

beforeEach(() => {
  signedIn();

  vi.stubGlobal('localStorage', memoryStorage());
});

const PARENT = item({
  id: '6a6a6a6a-6666-4666-8666-6a6a6a6a6a6a',
  title: 'Roadmap',
  hasChildren: true,
});

const CHILD = item({
  id: '6b6b6b6b-6666-4666-8666-6b6b6b6b6b6b',
  title: 'Q1 planning',
  parentId: PARENT.id,
});

describe('adding a view by hand', () => {
  it('opens the item on the first view it is given', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [PARENT, CHILD] });
    renderAt(<App />, `/?item=${PARENT.id}`);

    await user.click(await screen.findByRole('button', { name: /settings/i }));
    const panel = await screen.findByRole('complementary', { name: /item settings/i });
    await user.click(within(panel).getByRole('button', { name: 'Views' }));

    await user.click(await within(panel).findByRole('button', { name: /add a view/i }));
    await user.selectOptions(within(panel).getByRole('combobox', { name: 'View type' }), 'list');

    expect(await screen.findByRole('heading', { name: /add list view/i })).toBeVisible();
    // The studio adds from its first step; Options is optional.
    await user.click(screen.getByRole('button', { name: /add list/i }));

    // Building your first view and having the screen not change is the whole of the bug this
    // covers. At the moment it is made, "the document" was never a choice - it was the only option
    // - so the first view an item is given is what it opens on.
    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: /views/i })).toBeInTheDocument();
    });

    const switcher = screen.getByRole('navigation', { name: /views/i });
    expect(within(switcher).getByRole('button', { name: /document/i })).not.toHaveAttribute(
      'aria-current',
    );
  });
});
