import { create } from 'zustand';

import { writeStored } from './stored-setting';
import { browserStorage } from './browser-storage';
import { registerSyncedSetting, settingChanged } from './ui-settings-sync';

/**
 * The two off switches for the model-free suggestions outside the note body: browser-local
 * preferences in the same shape as `editor/mention-preference.ts`.
 *
 * - **Suggestions in views** covers every hint a view draws on its own: the create suggestions,
 *   the board's stale-card note, the spreadsheet's fill-series offer, the calendar's free-slot
 *   hint and the form's usual-value hint.
 * - **Order choices by what I pick most** covers every list that reorders itself from this
 *   browser's pick history: the select property's "Recent" group, the slash menu and the
 *   reference picker.
 *
 * **Both on by default.** Neither writes anything until somebody acts on it - a hint is a line of
 * text and an order is an order - so the person who finds one noisy switches it off once. Only the
 * alternative is stored, so the default stays forward-compatible.
 *
 * Every call site checks its switch through `getState()` or the hook, never a cached copy, so
 * turning one off takes effect at the next render without a reload.
 */
const VIEW_SUGGESTIONS_KEY = 'nix.view-suggestions';
const CHOICE_ORDER_KEY = 'nix.choice-order';

export type SuggestionSetting = 'on' | 'off';

function read(storage: Storage | undefined, key: string): SuggestionSetting {
  try {
    return storage?.getItem(key) === 'off' ? 'off' : 'on';
  } catch {
    return 'on';
  }
}

export function readViewSuggestionSetting(storage: Storage | undefined): SuggestionSetting {
  return read(storage, VIEW_SUGGESTIONS_KEY);
}

export function readChoiceOrderSetting(storage: Storage | undefined): SuggestionSetting {
  return read(storage, CHOICE_ORDER_KEY);
}

interface SuggestionPreference {
  readonly setting: SuggestionSetting;
  readonly saved: boolean;
  setSetting: (value: SuggestionSetting) => void;
}

function store(key: string, syncKey: 'editor.viewSuggestions' | 'editor.choiceOrder') {
  return create<SuggestionPreference>((set) => ({
    setting: read(browserStorage(), key),
    saved: true,
    setSetting: (setting) => {
      // A blocked write still lets the choice hold for this session.
      const saved = writeStored(key, setting === 'off' ? 'off' : null);
      set({ setting, saved });
      settingChanged(syncKey, setting);
    },
  }));
}

/** Whether views draw their own suggestions (create, stale-card, fill-series, free-slot, usual value). */
export const useViewSuggestionPreference = store(VIEW_SUGGESTIONS_KEY, 'editor.viewSuggestions');

/** Whether pick lists reorder themselves from this browser's pick history. */
export const useChoiceOrderPreference = store(CHOICE_ORDER_KEY, 'editor.choiceOrder');

registerSyncedSetting('editor.viewSuggestions', {
  get: () => useViewSuggestionPreference.getState().setting,
  set: (setting) => {
    useViewSuggestionPreference.getState().setSetting(setting);
  },
  defaultValue: 'on',
});
registerSyncedSetting('editor.choiceOrder', {
  get: () => useChoiceOrderPreference.getState().setting,
  set: (setting) => {
    useChoiceOrderPreference.getState().setSetting(setting);
  },
  defaultValue: 'on',
});

/** Selector: true when pick-history ordering is on. */
export function choiceOrderOn(): boolean {
  return useChoiceOrderPreference.getState().setting === 'on';
}
