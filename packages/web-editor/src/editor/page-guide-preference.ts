import { create } from 'zustand';

import { browserStorage } from '@nix/web-foundation/lib/browser-storage';
import { registerSyncedSetting, settingChanged } from '@nix/web-foundation/lib/ui-settings-sync';
import { writeStored } from '@nix/web-foundation/lib/stored-setting';

/**
 * Whether the page guides are drawn: a browser-local preference, like the mobile toolbar's.
 *
 * Shown by default. The guides exist for the person writing to a page count, and that person
 * has no way to know the feature exists if it starts hidden; the person who never exports can
 * switch them off once and never see them again. Only the alternative is stored, so the default
 * stays forward-compatible.
 */
const KEY = 'nix.page-guides';

export type PageGuideVisibility = 'shown' | 'hidden';

export function readPageGuideVisibility(storage: Storage | undefined): PageGuideVisibility {
  try {
    return storage?.getItem(KEY) === 'hidden' ? 'hidden' : 'shown';
  } catch {
    return 'shown';
  }
}

export const usePageGuidePreference = create<{
  visibility: PageGuideVisibility;
  saved: boolean;
  setVisibility: (value: PageGuideVisibility) => void;
}>((set) => ({
  visibility: readPageGuideVisibility(browserStorage()),
  saved: true,
  setVisibility: (visibility) => {
    set({ visibility, saved: writeStored(KEY, visibility === 'hidden' ? visibility : null) });
    settingChanged('editor.pageGuides', visibility === 'shown');
  },
}));

registerSyncedSetting('editor.pageGuides', {
  get: () => usePageGuidePreference.getState().visibility === 'shown',
  set: (shown) => {
    usePageGuidePreference.getState().setVisibility(shown ? 'shown' : 'hidden');
  },
  defaultValue: true,
});
