import { create } from 'zustand';

import { browserStorage } from './browser-storage';
import { writeStored } from './stored-setting';
import { registerSyncedSetting, settingChanged } from './ui-settings-sync';

/**
 * Whether the status bar (backlinks, words or items, sync) shows in the bottom corner on a wide
 * screen: synced to the account as `shell.statusBar`, on by default. Only the "off" choice is
 * stored, so a person who never touched it follows the default.
 */
const KEY = 'nix.status-bar';

function read(): boolean {
  try {
    return browserStorage()?.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export const useStatusBarPreference = create<{
  readonly enabled: boolean;
  readonly setEnabled: (enabled: boolean) => void;
}>((set) => ({
  enabled: read(),
  setEnabled: (enabled) => {
    writeStored(KEY, enabled ? null : '0');
    set({ enabled });
    settingChanged('shell.statusBar', enabled);
  },
}));

registerSyncedSetting('shell.statusBar', {
  get: () => useStatusBarPreference.getState().enabled,
  set: (enabled) => {
    useStatusBarPreference.getState().setEnabled(enabled);
  },
  defaultValue: true,
});
