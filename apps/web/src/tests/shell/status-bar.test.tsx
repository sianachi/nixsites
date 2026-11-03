import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NixClient } from '@nix/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import { useStatusBarPreference } from '@nix/web-foundation/lib/status-bar-preference';
import { hydrateUiSettings, resetUiSettingsSync } from '@nix/web-foundation/lib/ui-settings-sync';
import { item, stubCoreApi, STUB_WORKSPACE_ID } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';

const ME = '11111111-1111-4111-8111-111111111111';
const FOLDER = item({
  id: '3a3a3a3a-3333-4333-8333-3a3a3a3a3a3a',
  title: 'Projects',
  hasChildren: true,
});
const CHILD = item({
  id: '3b3b3b3b-3333-4333-8333-3b3b3b3b3b3b',
  title: 'Roadmap',
  parentId: FOLDER.id,
});

beforeEach(() => {
  signedIn();
  useStatusBarPreference.setState({ enabled: true });
});

afterEach(() => {
  resetUiSettingsSync();
  localStorage.removeItem('nix.status-bar');
});

describe('the status bar setting', () => {
  it('is on by default and stores only the "off" choice', () => {
    expect(useStatusBarPreference.getState().enabled).toBe(true);
    useStatusBarPreference.getState().setEnabled(false);
    expect(localStorage.getItem('nix.status-bar')).toBe('0');
    useStatusBarPreference.getState().setEnabled(true);
    expect(localStorage.getItem('nix.status-bar')).toBeNull();
  });

  it('syncs to the account as shell.statusBar', async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn((endpoint: { body: Record<string, unknown> }) =>
        Promise.resolve(endpoint.body),
      );
      const client = {
        query: vi.fn(() => Promise.resolve({ settings: {}, revision: 1 })),
        execute,
      } as unknown as NixClient;
      await hydrateUiSettings(client, ME);
      useStatusBarPreference.getState().setEnabled(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[0].body).toEqual({ settings: { 'shell.statusBar': false } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the account value over the device value on hydrate', async () => {
    const client = {
      query: vi.fn(() => Promise.resolve({ settings: { 'shell.statusBar': false }, revision: 1 })),
      execute: vi.fn(),
    } as unknown as NixClient;
    await hydrateUiSettings(client, ME);
    expect(useStatusBarPreference.getState().enabled).toBe(false);
  });
});

describe('the status bar', () => {
  it('shows the item count of a collection, backlinks and where it stands', async () => {
    stubCoreApi({
      items: [FOLDER, CHILD],
      views: {
        [FOLDER.id]: {
          views: [{ id: 'plan', name: 'Plan', kind: 'list', columns: [] }],
          default: 'plan',
        },
      },
    });
    renderAt(<App />, `/?item=${FOLDER.id}`);

    const bar = await screen.findByRole('group', { name: 'Status bar' });
    // Counts the children the explorer has loaded, so expand the collection there.
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Expand Projects' }));
    await waitFor(() => {
      expect(within(bar).getByText('1 item')).toBeInTheDocument();
    });
    expect(within(bar).getByText(/backlinks?$/)).toBeInTheDocument();
    expect(within(bar).getByText('Online')).toBeInTheDocument();
  });

  it('says Offline when the browser is', async () => {
    stubCoreApi({ items: [FOLDER, CHILD] });
    renderAt(<App />, `/?item=${FOLDER.id}`);
    const bar = await screen.findByRole('group', { name: 'Status bar' });

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(within(bar).getByText('Offline')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('is gone when the setting is off, and the settings page switches it', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [FOLDER] });
    renderAt(<App />, `/w/${STUB_WORKSPACE_ID}/settings?tab=preferences`);

    await screen.findByRole('group', { name: 'Status bar' });
    await user.click(await screen.findByRole('checkbox', { name: 'Show status bar' }));

    expect(useStatusBarPreference.getState().enabled).toBe(false);
    expect(screen.queryByRole('group', { name: 'Status bar' })).not.toBeInTheDocument();
  });
});
