import { z } from 'zod';
import { create } from 'zustand';

import { browserStorage } from '@nix/web-foundation/lib/browser-storage';
import { registerSyncedSetting, settingChanged } from '@nix/web-foundation/lib/ui-settings-sync';

export const KeyboardModeSchema = z.enum(['standard', 'vim', 'emacs']);
export type KeyboardMode = z.infer<typeof KeyboardModeSchema>;

export const DEFAULT_KEYBOARD_MODE: KeyboardMode = 'standard';
export const KEYBOARD_MODE_STORAGE_KEY = 'nix.editor-keyboard-mode';

export interface LoadedKeyboardMode {
  readonly mode: KeyboardMode;
  readonly persistence: 'stored' | 'session-only';
}

/** Loads the preference and whether this browser actually made storage available. */
export function loadKeyboardMode(storage: Storage | undefined): LoadedKeyboardMode {
  if (storage === undefined) {
    return { mode: DEFAULT_KEYBOARD_MODE, persistence: 'session-only' };
  }
  try {
    const raw = storage.getItem(KEYBOARD_MODE_STORAGE_KEY);
    if (raw === null) {
      return { mode: DEFAULT_KEYBOARD_MODE, persistence: 'stored' };
    }
    const parsed = KeyboardModeSchema.safeParse(raw);
    if (parsed.success) {
      return { mode: parsed.data, persistence: 'stored' };
    }
    console.warn('Ignoring an unrecognised editor keyboard mode:', raw);
    return { mode: DEFAULT_KEYBOARD_MODE, persistence: 'stored' };
  } catch {
    return { mode: DEFAULT_KEYBOARD_MODE, persistence: 'session-only' };
  }
}

/** Reads only the mode when the caller does not need persistence state. */
export function readKeyboardMode(storage: Storage | undefined): KeyboardMode {
  return loadKeyboardMode(storage).mode;
}

/** Stores only an explicit alternative; absence keeps the default forward-compatible. */
export function storeKeyboardMode(storage: Storage | undefined, mode: KeyboardMode): boolean {
  try {
    if (storage === undefined) {
      return false;
    }
    if (mode === DEFAULT_KEYBOARD_MODE) {
      storage.removeItem(KEYBOARD_MODE_STORAGE_KEY);
      return true;
    }
    storage.setItem(KEYBOARD_MODE_STORAGE_KEY, mode);
    return true;
  } catch {
    // A browser that refuses local storage still gets a working session-local preference.
    return false;
  }
}

interface KeyboardModeState {
  readonly mode: KeyboardMode;
  readonly persistence: 'stored' | 'session-only';
  readonly keyboardModeSelected: (mode: KeyboardMode) => void;
}

export const useKeyboardModeStore = create<KeyboardModeState>((set) => {
  const loaded = loadKeyboardMode(browserStorage());
  return {
    ...loaded,
    keyboardModeSelected: (mode) => {
      const stored = storeKeyboardMode(browserStorage(), mode);
      set({ mode, persistence: stored ? 'stored' : 'session-only' });
      settingChanged('editor.keyboardMode', mode);
    },
  };
});

registerSyncedSetting('editor.keyboardMode', {
  get: () => useKeyboardModeStore.getState().mode,
  set: (mode) => {
    useKeyboardModeStore.getState().keyboardModeSelected(mode);
  },
  defaultValue: DEFAULT_KEYBOARD_MODE,
});
