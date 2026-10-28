import { z } from 'zod';

import { browserStorage } from './browser-storage';

/**
 * The items somebody opened most recently, per workspace and per browser, for Homebase.
 *
 * The server keeps no view history, so this is the browser's own. Titles are stored so a row can
 * be named before the tree has loaded that far, which makes this workspace content: it is cleared
 * whenever the signed-in subject changes, beside frecency. Every storage failure degrades to
 * "nothing remembered".
 */

const STORAGE_KEY = 'nix.recent-items';

/** How many each workspace lists. */
export const RECENT_ITEMS_PER_WORKSPACE = 8;

/** The most kept across every workspace; the oldest are dropped past it. */
const MAXIMUM_ENTRIES = 64;

const entrySchema = z.object({
  workspaceId: z.string().min(1).max(64),
  itemId: z.string().min(1).max(64),
  title: z.string().max(500),
});
const storeSchema = z.array(entrySchema).max(MAXIMUM_ENTRIES);

export type RecentItem = z.infer<typeof entrySchema>;

/** Most recent first. */
function read(): RecentItem[] {
  try {
    const raw = browserStorage()?.getItem(STORAGE_KEY);
    if (raw == null) return [];
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** The workspace's recent items, most recent first. */
export function recentItems(workspaceId: string): RecentItem[] {
  return read()
    .filter((entry) => entry.workspaceId === workspaceId)
    .slice(0, RECENT_ITEMS_PER_WORKSPACE);
}

/** Makes an item the most recently viewed in its workspace. Best-effort. */
export function recordRecentItem(workspaceId: string, itemId: string, title: string): void {
  const entry = { workspaceId, itemId, title: title.slice(0, 500) };
  if (!entrySchema.safeParse(entry).success) return;
  const others = read().filter(
    (other) => other.workspaceId !== workspaceId || other.itemId !== itemId,
  );
  try {
    browserStorage()?.setItem(
      STORAGE_KEY,
      JSON.stringify([entry, ...others].slice(0, MAXIMUM_ENTRIES)),
    );
  } catch {
    // Quota or a policy that blocks writes; the list is a convenience.
  }
}

/** Forgets every workspace's recent items when the account leaves this device. */
export function clearRecentItems(): void {
  try {
    browserStorage()?.removeItem(STORAGE_KEY);
  } catch {
    // Refused storage must not prevent sign-out.
  }
}
