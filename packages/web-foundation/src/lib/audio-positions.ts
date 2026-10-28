import { z } from 'zod';

import { browserStorage } from './browser-storage';

/**
 * Where each audio file was left, remembered per browser so a long recording resumes instead of
 * starting over.
 *
 * Keyed by item, not by version or by address: the address is a capability URL that changes on
 * every open, and a replaced file is the same item whose position is simply a little stale - a
 * resume point that lands somewhere near is better than none. Holds identifiers and seconds only,
 * never a title or a URL. Bounded to {@link MAXIMUM_AUDIO_POSITIONS}, least recently played
 * dropped first. Every storage failure degrades to "nothing remembered": a recording that starts
 * from the top is a far smaller fault than a player that throws.
 */

const STORAGE_KEY = 'nix.audio-positions';

/** The most files remembered; past this the least recently played are forgotten. */
export const MAXIMUM_AUDIO_POSITIONS = 200;

const entrySchema = z.object({
  itemId: z.string().min(1).max(64),
  seconds: z.number().nonnegative(),
});
const storeSchema = z.array(entrySchema).max(MAXIMUM_AUDIO_POSITIONS);

type Entry = z.infer<typeof entrySchema>;

/** Most recent first. */
function read(): Entry[] {
  const storage = browserStorage();
  if (storage === undefined) {
    return [];
  }
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function write(entries: readonly Entry[]): void {
  try {
    browserStorage()?.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota or a policy that blocks writes; the position is a convenience.
  }
}

/** The remembered position of an item in seconds, or `null` when there is none. */
export function readAudioPosition(itemId: string): number | null {
  return read().find((entry) => entry.itemId === itemId)?.seconds ?? null;
}

/** Remembers where an item was left, making it the most recently played. Best-effort. */
export function rememberAudioPosition(itemId: string, seconds: number): void {
  if (itemId.length === 0 || itemId.length > 64 || !Number.isFinite(seconds) || seconds < 0) {
    return;
  }
  const others = read().filter((entry) => entry.itemId !== itemId);
  write([{ itemId, seconds }, ...others].slice(0, MAXIMUM_AUDIO_POSITIONS));
}

/** Forgets an item's position, as when the recording has been played to its end. */
export function forgetAudioPosition(itemId: string): void {
  const entries = read();
  if (entries.some((entry) => entry.itemId === itemId)) {
    write(entries.filter((entry) => entry.itemId !== itemId));
  }
}

/** Forget private listening history when the account leaves this device. */
export function clearAudioPositions(): void {
  try {
    browserStorage()?.removeItem(STORAGE_KEY);
  } catch {
    // Refused storage must not prevent sign-out.
  }
}
