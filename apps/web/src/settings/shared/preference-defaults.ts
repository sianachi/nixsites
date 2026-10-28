import {
  notifications,
  type NixClient,
  type PreferencesInput,
  type PrincipalPreferencesResponse,
} from '@nix/api-client';

/**
 * The saved preference the server reports for a principal who has never chosen a zone. A
 * different value, or `revision > 0`, means the person (or an earlier load of this page) already
 * has a real preference on file, and the browser's own guess must not overwrite it.
 */
export const NEVER_SAVED_TIME_ZONE = 'Etc/UTC';

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return NEVER_SAVED_TIME_ZONE;
  }
}

/**
 * The document to write back from a saved one. Every writer goes through this - the settings form
 * and the item menu's mute entry alike - so the first save anybody makes carries the browser's zone
 * (ADR-0051 section 3) rather than pinning the server's UTC placeholder in place for good.
 */
export function preferencesInputFrom(saved: PrincipalPreferencesResponse): PreferencesInput {
  // Auto-fill only on the very first load of a document nobody has saved yet - `revision === 0`
  // and still on the server default - never on a reload of a zone the person (or another device)
  // chose on purpose, even if that choice happens to also be UTC.
  const timeZone =
    saved.revision === 0 && saved.timeZone === NEVER_SAVED_TIME_ZONE
      ? browserTimeZone()
      : saved.timeZone;
  return {
    timeZone,
    quietStart: saved.quietStart,
    quietEnd: saved.quietEnd,
    dueReminderTime: saved.dueReminderTime,
    dueReminders: saved.dueReminders,
    habitReminders: saved.habitReminders,
    mutedContainerIds: saved.mutedContainerIds,
  };
}

const checkedClients = new WeakSet<object>();

/**
 * Saves the device's zone once per session when the person has never saved preferences, so
 * server-side days (reminders, quiet hours) follow the device rather than UTC. Resolves true only
 * when it wrote. Never overwrites a saved document; any failure is swallowed.
 */
export async function saveDeviceTimeZoneOnce(client: NixClient): Promise<boolean> {
  if (checkedClients.has(client)) return false;
  checkedClients.add(client);
  try {
    const saved = await client.query(notifications.preferences(), { forceRefresh: true });
    if (saved.revision !== 0 || saved.timeZone !== NEVER_SAVED_TIME_ZONE) return false;
    const input = preferencesInputFrom(saved);
    if (input.timeZone === NEVER_SAVED_TIME_ZONE) return false;
    await client.execute(notifications.savePreferences(saved.revision, input));
    return true;
  } catch {
    return false;
  }
}
