import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_KEYBOARD_MODE,
  KEYBOARD_MODE_STORAGE_KEY,
  loadKeyboardMode,
  readKeyboardMode,
  storeKeyboardMode,
  useKeyboardModeStore,
} from '@nix/web-editor/editor/keyboard-mode-store';
import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the stored editor keyboard mode', () => {
  it.each(['standard', 'vim', 'emacs'] as const)('reads %s', (mode) => {
    expect(readKeyboardMode(memoryStorage({ [KEYBOARD_MODE_STORAGE_KEY]: mode }))).toBe(mode);
  });

  it('uses Standard when no preference exists', () => {
    expect(readKeyboardMode(memoryStorage())).toBe(DEFAULT_KEYBOARD_MODE);
  });

  it('reports an unrecognised value and falls back safely', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(readKeyboardMode(memoryStorage({ [KEYBOARD_MODE_STORAGE_KEY]: 'future-mode' }))).toBe(
      DEFAULT_KEYBOARD_MODE,
    );
    expect(warning).toHaveBeenCalledOnce();
  });

  it('stores alternatives and removes the default', () => {
    const storage = memoryStorage();
    expect(storeKeyboardMode(storage, 'emacs')).toBe(true);
    expect(storage.getItem(KEYBOARD_MODE_STORAGE_KEY)).toBe('emacs');

    expect(storeKeyboardMode(storage, 'standard')).toBe(true);
    expect(storage.getItem(KEYBOARD_MODE_STORAGE_KEY)).toBeNull();
  });

  it('survives unavailable storage', () => {
    expect(readKeyboardMode(undefined)).toBe(DEFAULT_KEYBOARD_MODE);
    expect(storeKeyboardMode(undefined, 'emacs')).toBe(false);
  });

  it('reports session-only persistence when the browser refuses the initial read', () => {
    const refusing = {
      getItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;

    expect(loadKeyboardMode(refusing)).toEqual({
      mode: DEFAULT_KEYBOARD_MODE,
      persistence: 'session-only',
    });
  });
});

describe('changing the live preference', () => {
  beforeEach(() => {
    useKeyboardModeStore.setState({ mode: DEFAULT_KEYBOARD_MODE, persistence: 'stored' });
  });

  it('updates every subscriber through one event', () => {
    useKeyboardModeStore.getState().keyboardModeSelected('emacs');
    expect(useKeyboardModeStore.getState().mode).toBe('emacs');
  });

  it('keeps the live choice and reports session-only persistence when storage refuses it', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });

    useKeyboardModeStore.getState().keyboardModeSelected('emacs');

    expect(useKeyboardModeStore.getState()).toMatchObject({
      mode: 'emacs',
      persistence: 'session-only',
    });
  });
});
