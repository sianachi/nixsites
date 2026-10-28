import type { NixClient } from '@nix/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_GRAPH_OPEN_MODE, useGraphOpenPreference } from '../../graph/graph-open-preference';
import { hydrateUiSettings, resetUiSettingsSync } from '../../lib/ui-settings-sync';
import { memoryStorage } from '../memory-storage';

const ME = '11111111-1111-4111-8111-111111111111';

function fakeClient(settings: Record<string, unknown>) {
  const query = vi.fn(() => Promise.resolve({ settings, revision: 1 }));
  const execute = vi.fn((endpoint: { body: unknown }) => Promise.resolve(endpoint.body));
  return { client: { query, execute } as unknown as NixClient, execute };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.useFakeTimers();
  useGraphOpenPreference.setState({ mode: DEFAULT_GRAPH_OPEN_MODE });
});

afterEach(() => {
  resetUiSettingsSync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the graph open preference', () => {
  it('defaults to the dialog the graph always used', () => {
    expect(useGraphOpenPreference.getState().mode).toBe('dialog');
  });

  it('stores only an alternative on this device', () => {
    useGraphOpenPreference.getState().setMode('tab');
    expect(localStorage.getItem('nix.graph-open-mode')).toBe('tab');

    useGraphOpenPreference.getState().setMode('dialog');
    expect(localStorage.getItem('nix.graph-open-mode')).toBeNull();
  });

  it('syncs a change to the account as graph.openMode, once, after the pause', async () => {
    const { client, execute } = fakeClient({});
    await hydrateUiSettings(client, ME);

    useGraphOpenPreference.getState().setMode('page');
    useGraphOpenPreference.getState().setMode('tab');
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].body).toEqual({ settings: { 'graph.openMode': 'tab' } });
  });

  it('applies the account value on sign-in without sending it back', async () => {
    const { client, execute } = fakeClient({ 'graph.openMode': 'tab' });

    await hydrateUiSettings(client, ME);
    await vi.advanceTimersByTimeAsync(1000);

    expect(useGraphOpenPreference.getState().mode).toBe('tab');
    expect(execute).not.toHaveBeenCalled();
  });

  it('reads a beside from the account as a dialog', async () => {
    const { client } = fakeClient({ 'graph.openMode': 'beside' });

    await hydrateUiSettings(client, ME);

    expect(useGraphOpenPreference.getState().mode).toBe('dialog');
  });

  it('uploads a non-default local value the account has never seen', async () => {
    useGraphOpenPreference.getState().setMode('page');
    await vi.advanceTimersByTimeAsync(1000);
    resetUiSettingsSync();
    const { client, execute } = fakeClient({});

    await hydrateUiSettings(client, ME);

    expect(execute.mock.calls[0]?.[0].body).toEqual({ settings: { 'graph.openMode': 'page' } });
  });
});
