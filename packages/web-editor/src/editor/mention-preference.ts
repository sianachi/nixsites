import { create } from 'zustand';

import { browserStorage } from '@nix/web-foundation/lib/browser-storage';
import { registerSyncedSetting, settingChanged } from '@nix/web-foundation/lib/ui-settings-sync';
import { writeStored } from '@nix/web-foundation/lib/stored-setting';

/**
 * Whether the note editor underlines item titles written in the text but not linked: a
 * browser-local preference, like the page guides.
 *
 * **On by default.** An underline writes nothing: the note, the shared document and every
 * collaborator are untouched until somebody chooses "Link to ..." on one. What it costs is a
 * dotted line and a request after a pause in typing - and the person who finds that noisy can
 * switch it off once. Compare the phrase suggestions, which are off by default because their
 * accept key can write into the note by accident; nothing here can. Only the alternative is
 * stored, so the default stays forward-compatible.
 */
const KEY = 'nix.unlinked-mentions';

export type MentionSetting = 'on' | 'off';

export function readMentionSetting(storage: Storage | undefined): MentionSetting {
  try {
    return storage?.getItem(KEY) === 'off' ? 'off' : 'on';
  } catch {
    return 'on';
  }
}

export const useMentionPreference = create<{
  setting: MentionSetting;
  saved: boolean;
  setSetting: (value: MentionSetting) => void;
}>((set) => ({
  setting: readMentionSetting(browserStorage()),
  saved: true,
  setSetting: (setting) => {
    set({ setting, saved: writeStored(KEY, setting === 'off' ? setting : null) });
    settingChanged('editor.unlinkedMentionUnderline', setting === 'on');
  },
}));

registerSyncedSetting('editor.unlinkedMentionUnderline', {
  get: () => useMentionPreference.getState().setting === 'on',
  set: (on) => {
    useMentionPreference.getState().setSetting(on ? 'on' : 'off');
  },
  defaultValue: true,
});
