import {
  isNixApiError,
  notifications,
  type NixClient,
  type PrincipalPreferencesResponse,
} from '@nix/api-client';
import type { MenuEntry } from '@nix/ui';
import { Bell, BellOff } from 'lucide-react';

import { useOptionalApiClient } from '@nix/web-platform/api/api-client-provider';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { preferencesInputFrom } from '../shared/preference-defaults';

/**
 * "Mute reminders" on an item's menu: adds the item to the caller's muted containers (ADR-0051
 * section 3), which silences reminders from it and everything inside it. Settings > Notifications
 * lists what is muted and is where to find it again.
 *
 * **The label reads the cached preferences; the write reads fresh ones.** A menu is built when it
 * opens and must not wait on the network, so the label uses whatever preferences document is
 * already cached. The write then reads the current document and saves at its revision, so a menu
 * built from a stale cache still cannot overwrite a change made on another device.
 */

const PREFERENCES_KEY = ['me', 'preferences'] as const;
const MAX_MUTED = 200;

type MuteChange = 'mute' | 'unmute';

async function changeMute(
  client: NixClient,
  itemId: string,
  title: string,
  change: MuteChange,
): Promise<void> {
  const name = title.trim() === '' ? 'Untitled' : title;
  try {
    const fresh = await client.query(notifications.preferences(), { forceRefresh: true });
    const muted = fresh.mutedContainerIds.includes(itemId);
    if (muted === (change === 'mute')) {
      publishNotice({
        key: 'mute-reminders',
        message:
          change === 'mute'
            ? `Reminders from ${name} were already muted.`
            : `Reminders from ${name} were not muted.`,
      });
      return;
    }
    if (change === 'mute' && fresh.mutedContainerIds.length >= MAX_MUTED) {
      publishNotice({
        key: 'mute-reminders',
        message: `You can mute at most ${String(MAX_MUTED)} items. Unmute one in Settings, Notifications first.`,
      });
      return;
    }

    const input = preferencesInputFrom(fresh);
    const saved = await client.execute(
      notifications.savePreferences(fresh.revision, {
        ...input,
        mutedContainerIds:
          change === 'mute'
            ? [...input.mutedContainerIds, itemId]
            : input.mutedContainerIds.filter((id) => id !== itemId),
      }),
    );
    // Write the saved document through, so the next menu to open names the new state.
    await client.cache.read(PREFERENCES_KEY, () => Promise.resolve(saved), { forceRefresh: true });
    publishNotice({
      key: 'mute-reminders',
      message:
        change === 'mute'
          ? `Reminders from ${name} and everything inside it are muted.`
          : `Reminders from ${name} are back on.`,
    });
  } catch (cause) {
    publishNotice({
      key: 'mute-reminders',
      message:
        isNixApiError(cause) && cause.status === 409
          ? 'Your notification settings changed on another device. Try again.'
          : 'Reminders could not be changed. Check your connection and try again.',
    });
  }
}

/**
 * Builds the menu entry for one item, reading the cached preferences as the menu opens. Null where
 * there is no client to write with - a view rendered on its own, outside the application.
 */
export function useMuteRemindersEntry(): ((itemId: string, title: string) => MenuEntry) | null {
  const client = useOptionalApiClient();
  if (client === null) return null;
  return (itemId, title) => {
    const cached = client.cache.peek<PrincipalPreferencesResponse>(PREFERENCES_KEY)?.data;
    const muted = cached?.mutedContainerIds.includes(itemId) ?? false;
    return {
      kind: 'action',
      label: muted ? 'Unmute reminders' : 'Mute reminders',
      icon: muted ? Bell : BellOff,
      onSelect: () => {
        void changeMute(client, itemId, title, muted ? 'unmute' : 'mute');
      },
    };
  };
}
