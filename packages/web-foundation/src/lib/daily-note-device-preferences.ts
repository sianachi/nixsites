import { browserStorage } from './browser-storage';
import { registerSyncedSetting, settingChanged } from './ui-settings-sync';

/**
 * Whether Nix opens today's daily note on start.
 *
 * A personal preference rather than a workspace setting, synced to the account
 * (`dailyNotes.openTodayOnStart`); the workspace's settings are shared by everyone in it. It is stored
 * as `'1'` or absent, so turning it off removes the key instead of leaving a `'0'` to be parsed.
 * Storage that is missing or throws reads as off, the quiet default.
 */
const OPEN_ON_LAUNCH_KEY = 'nix.daily.open-on-launch';

export function readOpenDailyOnLaunch(): boolean {
  const storage = browserStorage();
  if (storage === undefined) {
    return false;
  }
  try {
    return storage.getItem(OPEN_ON_LAUNCH_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeOpenDailyOnLaunch(value: boolean): void {
  const storage = browserStorage();
  if (storage === undefined) {
    return;
  }
  try {
    if (value) {
      storage.setItem(OPEN_ON_LAUNCH_KEY, '1');
    } else {
      storage.removeItem(OPEN_ON_LAUNCH_KEY);
    }
  } catch {
    // Quota or policy. The preference then lasts only until the page reloads, which is
    // acceptable for a convenience that has no data behind it.
  }
  settingChanged('dailyNotes.openTodayOnStart', value);
}

registerSyncedSetting('dailyNotes.openTodayOnStart', {
  get: readOpenDailyOnLaunch,
  set: writeOpenDailyOnLaunch,
  defaultValue: false,
});
