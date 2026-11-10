import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setZenMode } from '@nix/web-foundation/lib/zen-mode';
import { item, stubCoreApi, STUB_WORKSPACE_ID } from '@nix/web-foundation/testing/api-stub';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { App } from '../../app';

const parent = item({ id: '24b870ac-ed75-479d-b790-bbd7f5452b2a', title: 'Trip plan' });
const route = `/w/${STUB_WORKSPACE_ID}?item=${parent.id}`;
const storageKey = 'nix.layout.test-subject';

beforeEach(() => {
  signedIn();
  stubViewport(1280);
  localStorage.removeItem(storageKey);
  stubCoreApi({
    items: [parent],
    views: {
      [parent.id]: {
        views: [
          { id: 'plan', name: 'Plan', kind: 'list', columns: [] },
          { id: 'gallery', name: 'Gallery', kind: 'gallery', columns: [] },
        ],
        default: 'plan',
      },
    },
  });
});

afterEach(() => {
  setZenMode(false);
  localStorage.removeItem(storageKey);
});

async function openPreferences(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Test Person' }));
  await user.click(screen.getByText('Preferences', { exact: true }));
  return screen.findByRole('dialog', { name: 'Preferences' });
}

describe('workspace layout preferences', () => {
  it('previews the layout in place, restores it on cancel and undoes a saved choice', async () => {
    const user = userEvent.setup();
    renderAt(<App />, route);
    const title = await screen.findByRole('textbox', { name: 'Note title' });
    await screen.findByRole('navigation', { name: 'Views' });

    let preferences = within(await openPreferences(user));
    expect(preferences.getByRole('button', { name: 'Full toolkit' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(preferences.getByRole('button', { name: 'Essentials' }));
    expect(screen.getByRole('combobox', { name: 'View' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show the Explorer' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Note title' })).toBe(title);
    expect(localStorage.getItem(storageKey)).toBeNull();

    await user.click(preferences.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('navigation', { name: 'Views' })).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test Person' })).toHaveFocus());

    preferences = within(await openPreferences(user));
    await user.click(preferences.getByRole('button', { name: 'Essentials' }));
    await user.click(preferences.getByRole('button', { name: 'Apply layout' }));
    expect(localStorage.getItem(storageKey)).toContain('"preset":"essentials"');
    expect(screen.getByText('Applied Essentials layout')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /^Undo$/ }));
    await screen.findByRole('navigation', { name: 'Views' });
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it('restores a saved preset and keeps Preferences reachable in focus mode', async () => {
    const user = userEvent.setup();
    localStorage.setItem(storageKey, JSON.stringify({ preset: 'essentials', overrides: {} }));
    renderAt(<App />, route);
    await screen.findByRole('combobox', { name: 'View' });
    act(() => {
      setZenMode(true);
    });

    expect(screen.getByRole('button', { name: 'Exit Zen mode' })).toBeVisible();
    const preferences = within(await openPreferences(user));
    expect(preferences.getByRole('button', { name: 'Essentials' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Preferences' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exit Zen mode' })).toBeVisible();
  });
});
