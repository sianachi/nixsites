import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setZenMode } from '@nix/web-foundation/lib/zen-mode';
import { item, stubCoreApi, STUB_WORKSPACE_ID } from '@nix/web-foundation/testing/api-stub';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { App } from '../../app';

const parent = item({ id: '24b870ac-ed75-479d-b790-bbd7f5452b2a', title: 'Trip plan' });
const route = `/w/${STUB_WORKSPACE_ID}?item=${parent.id}`;
const storageKey = 'nix.layout.test-subject';
const settingsPath = '/api/v1/me/ui-settings';

function layoutWrites(): unknown[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(
      ([input, init]) => requestUrl(input).endsWith(settingsPath) && init?.method === 'PATCH',
    )
    .flatMap(([, init]): unknown[] =>
      typeof init?.body === 'string' && init.body.includes('"shell.layout"')
        ? [JSON.parse(init.body)]
        : [],
    );
}

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
  it('previews without saving and undoes an applied layout in the account', async () => {
    const user = userEvent.setup();
    renderAt(<App />, route);
    const title = await screen.findByRole('textbox', { name: 'Note title' }, { timeout: 5000 });
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
    expect(layoutWrites()).toEqual([]);
    expect(screen.getByRole('navigation', { name: 'Views' })).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test Person' })).toHaveFocus());

    preferences = within(await openPreferences(user));
    await user.click(preferences.getByRole('button', { name: 'Essentials' }));
    await user.click(preferences.getByRole('button', { name: 'Customize' }));
    await user.selectOptions(preferences.getByLabelText('Advanced note tools'), 'show');
    await user.click(preferences.getByRole('button', { name: 'Apply layout' }));
    await screen.findByText('Applied Essentials layout');
    const layout = { preset: 'essentials', overrides: { advanced: true } };
    const write = { settings: { 'shell.layout': layout } };
    expect(layoutWrites()).toEqual([write]);
    await user.click(screen.getByRole('button', { name: /^Undo$/ }));
    await screen.findByRole('navigation', { name: 'Views' });
    await waitFor(() => {
      expect(localStorage.getItem(storageKey)).toBeNull();
    });
    expect(layoutWrites()).toEqual([write, { settings: { 'shell.layout': null } }]);
  });

  it('loads the account layout without browser storage and keeps Preferences reachable in focus mode', async () => {
    const user = userEvent.setup();
    await fetch(settingsPath, {
      method: 'PATCH',
      body: JSON.stringify({
        settings: { 'shell.layout': { preset: 'essentials', overrides: { advanced: true } } },
      }),
    });
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
    await user.click(preferences.getByRole('button', { name: 'Customize' }));
    expect(preferences.getByLabelText('Advanced note tools')).toHaveValue('show');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Preferences' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exit Zen mode' })).toBeVisible();
  });

  it('keeps the draft open if Core refuses to save it', async () => {
    const coreFetch = fetch;
    let failed = false;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (!failed && requestUrl(input).endsWith(settingsPath) && init?.method === 'PATCH') {
        failed = true;
        return Promise.resolve(Response.json({ detail: 'Unavailable' }, { status: 503 }));
      }
      return coreFetch(input, init);
    });
    const user = userEvent.setup();
    renderAt(<App />, route);
    const preferences = within(await openPreferences(user));
    await user.click(preferences.getByRole('button', { name: 'Essentials' }));
    await user.click(preferences.getByRole('button', { name: 'Apply layout' }));
    expect(await preferences.findByRole('alert')).toHaveTextContent('Could not save your layout');
    expect(preferences.getByRole('button', { name: 'Essentials' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(screen.queryByText('Applied Essentials layout')).toBeNull();
    await user.click(preferences.getByRole('button', { name: 'Apply layout' }));
    await screen.findByText('Applied Essentials layout');
    expect(screen.queryByRole('dialog', { name: 'Preferences' })).toBeNull();
  });

  it('leaves a layout applied from another device in place when undoing', async () => {
    const user = userEvent.setup();
    renderAt(<App />, route);
    const preferences = within(await openPreferences(user));
    await user.click(preferences.getByRole('button', { name: 'Essentials' }));
    await user.click(preferences.getByRole('button', { name: 'Apply layout' }));
    await screen.findByText('Applied Essentials layout');
    await fetch(settingsPath, {
      method: 'PATCH',
      body: JSON.stringify({
        settings: { 'shell.layout': { preset: 'workspace', overrides: {} } },
      }),
    });
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(
        screen
          .getAllByRole('status')
          .some((status) => status.textContent.includes('Your saved layout has already changed.')),
      ).toBe(true);
    });
    expect(layoutWrites()).toHaveLength(2);
    expect(
      within(await openPreferences(user)).getByRole('button', { name: 'Workspace' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });
});
