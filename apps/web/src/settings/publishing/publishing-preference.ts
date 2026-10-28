import { create } from 'zustand';

import { writeStored } from '../../editor/stored-setting';
import { browserStorage } from '../../lib/browser-storage';
import { registerSyncedSetting, settingChanged } from '../../lib/ui-settings-sync';
import { useCapabilities } from '../../session/capabilities-context';

/**
 * Whether the person wants site publishing shown for pages they own: synced to the account as
 * `sites.publishingEnabled`, off by default. A display choice only - Core's own gate decides
 * whether anything can be published, and this is never read as permission.
 */
const KEY = 'nix.sites-publishing';

function read(): boolean {
  try {
    return browserStorage()?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export const usePublishingPreference = create<{
  readonly enabled: boolean;
  readonly setEnabled: (enabled: boolean) => void;
}>((set) => ({
  enabled: read(),
  setEnabled: (enabled) => {
    writeStored(KEY, enabled ? '1' : null);
    set({ enabled });
    settingChanged('sites.publishingEnabled', enabled);
  },
}));

registerSyncedSetting('sites.publishingEnabled', {
  get: () => usePublishingPreference.getState().enabled,
  set: (enabled) => {
    usePublishingPreference.getState().setEnabled(enabled);
  },
  defaultValue: false,
});

/** Whether to draw any site entry point: the deployment offers sites and the person asked for them. */
export function useSitesVisible(): boolean {
  const offered = useCapabilities().sites;
  return usePublishingPreference((state) => state.enabled) && offered;
}
