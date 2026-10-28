import { create } from 'zustand';

import { browserStorage } from '@nix/web-foundation/lib/browser-storage';
import { registerSyncedSetting, settingChanged } from '@nix/web-foundation/lib/ui-settings-sync';
import { writeStored } from '@nix/web-foundation/lib/stored-setting';

export const TEXT_WIDTH_STORAGE_KEY = 'nix.text-width';
export type TextWidth = 'reading' | 'full';

export function loadTextWidth(storage: Storage | undefined): {
  readonly width: TextWidth;
  readonly saved: boolean;
} {
  try {
    return {
      width: storage?.getItem(TEXT_WIDTH_STORAGE_KEY) === 'full' ? 'full' : 'reading',
      saved: storage !== undefined,
    };
  } catch {
    return { width: 'reading', saved: false };
  }
}

export const useTextWidthPreference = create<{
  readonly width: TextWidth;
  readonly saved: boolean;
  readonly setWidth: (width: TextWidth) => void;
}>((set) => ({
  ...loadTextWidth(browserStorage()),
  setWidth: (width) => {
    set({ width, saved: writeStored(TEXT_WIDTH_STORAGE_KEY, width === 'reading' ? null : width) });
    settingChanged('editor.textWidth', width);
  },
}));

registerSyncedSetting('editor.textWidth', {
  get: () => useTextWidthPreference.getState().width,
  set: (width) => {
    useTextWidthPreference.getState().setWidth(width);
  },
  defaultValue: 'reading',
});
