import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NixClient } from '@nix/api-client';

import { useKeyboardModeStore } from '@nix/web-editor/editor/keyboard-mode-store';
import { useTextWidthPreference } from '@nix/web-editor/editor/text-width-preference';
import { memoryStorage } from '../memory-storage';
import { hydrateUiSettings, resetUiSettingsSync } from '@nix/web-foundation/lib/ui-settings-sync';

const ME = '11111111-1111-4111-8111-111111111111';
const SOMEONE_ELSE = '22222222-2222-4222-8222-222222222222';
const OWNER_KEY = 'nix.ui-settings-owner';

function fakeClient(settings: Record<string, unknown>, patchFails = false) {
  const query = vi.fn(() => Promise.resolve({ settings, revision: 1 }));
  const execute = vi.fn((endpoint: { body: unknown }) =>
    patchFails ? Promise.reject(new Error('offline')) : Promise.resolve(endpoint.body),
  );
  return { client: { query, execute } as unknown as NixClient, query, execute };
}

const patchesSent = (execute: ReturnType<typeof fakeClient>['execute']) =>
  execute.mock.calls.map(([endpoint]) => (endpoint.body as { settings: unknown }).settings);

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.useFakeTimers();
  useKeyboardModeStore.setState({ mode: 'standard', persistence: 'stored' });
  useTextWidthPreference.setState({ width: 'reading', saved: true });
});

afterEach(() => {
  resetUiSettingsSync();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('synced UI settings', () => {
  it('applies the server value over the local one without sending it back', async () => {
    const { client, execute } = fakeClient({ 'editor.keyboardMode': 'vim' });

    await hydrateUiSettings(client, ME);
    await vi.advanceTimersByTimeAsync(1000);

    expect(useKeyboardModeStore.getState().mode).toBe('vim');
    expect(execute).not.toHaveBeenCalled();
  });

  it('uploads a non-default local value the server has never seen, in one patch', async () => {
    useKeyboardModeStore.getState().keyboardModeSelected('emacs');
    const { client, execute } = fakeClient({});

    await hydrateUiSettings(client, ME);

    expect(patchesSent(execute)).toEqual([{ 'editor.keyboardMode': 'emacs' }]);
  });

  it('records the owner on a first run and uploads', async () => {
    useKeyboardModeStore.getState().keyboardModeSelected('emacs');
    const { client, execute } = fakeClient({});

    await hydrateUiSettings(client, ME);

    expect(localStorage.getItem(OWNER_KEY)).toBe(ME);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('uploads for the same owner as last time', async () => {
    localStorage.setItem(OWNER_KEY, ME);
    useKeyboardModeStore.getState().keyboardModeSelected('emacs');
    const { client, execute } = fakeClient({});

    await hydrateUiSettings(client, ME);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not upload another account's leftovers, but still applies server values", async () => {
    localStorage.setItem(OWNER_KEY, SOMEONE_ELSE);
    useKeyboardModeStore.setState({ mode: 'emacs' });
    useTextWidthPreference.setState({ width: 'full' });
    const { client, execute } = fakeClient({ 'editor.textWidth': 'reading' });

    await hydrateUiSettings(client, ME);

    expect(useTextWidthPreference.getState().width).toBe('reading');
    expect(useKeyboardModeStore.getState().mode).toBe('emacs');
    expect(localStorage.getItem(OWNER_KEY)).toBe(ME);
    await vi.advanceTimersByTimeAsync(1000);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not upload a default local value', async () => {
    const { client, execute } = fakeClient({});

    await hydrateUiSettings(client, ME);

    expect(execute).not.toHaveBeenCalled();
  });

  it('sends only the changed key, once, after the debounce', async () => {
    const { client, execute } = fakeClient({});
    await hydrateUiSettings(client, ME);

    useTextWidthPreference.getState().setWidth('full');
    useTextWidthPreference.getState().setWidth('reading');
    useTextWidthPreference.getState().setWidth('full');
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);

    expect(patchesSent(execute)).toEqual([{ 'editor.textWidth': 'full' }]);
  });

  it('keeps a change made while the first read was in flight', async () => {
    const { client } = fakeClient({ 'editor.keyboardMode': 'vim' });
    const pending = hydrateUiSettings(client, ME);
    useKeyboardModeStore.getState().keyboardModeSelected('emacs');
    await pending;

    expect(useKeyboardModeStore.getState().mode).toBe('emacs');
  });

  it('warns and keeps the local value when the server cannot be reached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = fakeClient({}, true);
    failing.query.mockRejectedValueOnce(new Error('down'));

    await expect(hydrateUiSettings(failing.client, ME)).resolves.toBeUndefined();
    useKeyboardModeStore.getState().keyboardModeSelected('vim');
    await vi.advanceTimersByTimeAsync(1000);

    expect(useKeyboardModeStore.getState().mode).toBe('vim');
    expect(failing.execute).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
