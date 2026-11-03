import { create } from 'zustand';

import { browserStorage } from './browser-storage';
import { writeStored } from './stored-setting';
import { registerSyncedSetting, settingChanged } from './ui-settings-sync';

/**
 * Whether the icon strip (destinations, Search, the bell, the profile) shows down the left on a
 * wide screen: synced to the account as `shell.iconStrip`, on by default. Only the "off" choice is
 * stored, so a person who never touched it follows the default.
 */
const KEY = 'nix.icon-strip';

function read(): boolean {
  try {
    return browserStorage()?.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export const useIconStripPreference = create<{
  readonly enabled: boolean;
  readonly setEnabled: (enabled: boolean) => void;
}>((set) => ({
  enabled: read(),
  setEnabled: (enabled) => {
    writeStored(KEY, enabled ? null : '0');
    set({ enabled });
    settingChanged('shell.iconStrip', enabled);
  },
}));

registerSyncedSetting('shell.iconStrip', {
  get: () => useIconStripPreference.getState().enabled,
  set: (enabled) => {
    useIconStripPreference.getState().setEnabled(enabled);
  },
  defaultValue: true,
});
