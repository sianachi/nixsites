import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STUB_WORKSPACE_ID, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { App } from '../../app';

/**
 * Workspaces, trash and settings open as dialogs over the work on desktop, and as
 * pages on phones and tablets. Driven through the whole app, because the claim is about routing:
 * the address changes, and on desktop what was on screen stays there underneath.
 */
beforeEach(() => {
  signedIn();
  stubCoreApi();
});

afterEach(() => {
  stubViewport(true);
  vi.restoreAllMocks();
});

const WORKSPACE = `/w/${STUB_WORKSPACE_ID}`;

function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: /destinations/i });
}

describe('workspace screens as dialogs', () => {
  it.each([
    ['Settings', 'settings'],
    ['Trash', 'trash'],
    ['Workspaces', 'workspaces'],
  ])('opens %s over the page on desktop, and closing returns to it', async (name, path) => {
    const user = userEvent.setup();
    renderAt(<App />, `${WORKSPACE}/calendar`);

    await user.click(
      await within(await screen.findByRole('navigation', { name: /destinations/i })).findByRole(
        'link',
        { name },
      ),
    );

    const dialog = await screen.findByRole('dialog', { name });
    expect(dialog).toBeVisible();
    // The page underneath is still the calendar, not the screen's own page.
    expect(within(rail()).getByRole('link', { name: 'Calendar' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(rail()).getByRole('link', { name })).toHaveAttribute(
      'href',
      `${WORKSPACE}/${path}`,
    );

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name })).not.toBeInTheDocument();
    });
    expect(within(rail()).getByRole('link', { name: 'Calendar' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('redirects a legacy automation link to the companion', async () => {
    function CurrentPath() {
      return <output>{useLocation().pathname}</output>;
    }
    renderAt(
      <>
        <App />
        <CurrentPath />
      </>,
      `${WORKSPACE}/automations?new=1`,
    );

    expect(await screen.findByText(`${WORKSPACE}/pet`)).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Automations' })).not.toBeInTheDocument();
  });

  it('opens a deep link as a dialog over the workspace home on desktop', async () => {
    renderAt(<App />, `${WORKSPACE}/trash`);

    expect(await screen.findByRole('dialog', { name: 'Trash' })).toBeVisible();
    expect(within(rail()).getByRole('link', { name: 'Homebase' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('keeps the dialog open while its own address changes', async () => {
    const user = userEvent.setup();
    renderAt(<App />, `${WORKSPACE}/settings`);

    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    const sections = within(dialog).getAllByRole('link');
    const other = sections.find((link) => link.getAttribute('aria-current') !== 'page');
    if (other === undefined) throw new Error('expected a second settings section');
    await user.click(other);

    await waitFor(() => {
      expect(other).toHaveAttribute('aria-current', 'page');
    });
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBe(dialog);
  });

  it('is a page on a phone', async () => {
    stubViewport(false);
    renderAt(<App />, `${WORKSPACE}/settings`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('is a page on a tablet', async () => {
    stubViewport(true, { touch: true });
    renderAt(<App />, `${WORKSPACE}/trash`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Trash' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Trash' })).not.toBeInTheDocument();
  });
});
