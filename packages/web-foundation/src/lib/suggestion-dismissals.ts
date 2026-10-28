import { z } from 'zod';

import { browserStorage } from './browser-storage';

/**
 * Suggestions somebody waved away, remembered per browser so they do not come straight back.
 *
 * **The key carries what the dismissal was about.** A caller builds it from the facts the hint was
 * drawn from - the board's stale-card note uses workspace, item and the item's `updatedAt` - so a
 * dismissal lapses by itself the moment those facts change: a card that is edited and then goes
 * stale again is a new situation, and its note returns. Nothing here needs to expire entries for
 * that to hold.
 *
 * **Keys built from identifiers, and cleared whenever the subject changes**
 * (`clearSuggestionDismissals`, called beside `clearFrecency` at sign-out, on another tab's
 * sign-out and when the body cache finds a different subject). A key holds workspace, item and
 * view identifiers and timestamps; a caller must not put document text or option labels in one.
 * The next person on the browser inherits nothing. Bounded to {@link MAXIMUM_DISMISSALS}, oldest
 * dropped first.
 *
 * Every storage failure degrades to "nothing dismissed" - a hint that reappears is a far smaller
 * fault than a board that throws.
 */

const STORAGE_KEY = 'nix.suggestion-dismissals';

/** The most dismissals kept; past this the oldest are forgotten. */
export const MAXIMUM_DISMISSALS = 500;

const storeSchema = z.array(z.string().min(1).max(512)).max(MAXIMUM_DISMISSALS);

function read(): string[] {
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

/** Every remembered dismissal, as a set for lookups. */
export function readDismissals(): ReadonlySet<string> {
  return new Set(read());
}

/** Remembers that the hint `key` describes was dismissed. Best-effort. */
export function rememberDismissal(key: string): void {
  if (key.length === 0 || key.length > 512) {
    return;
  }
  const storage = browserStorage();
  if (storage === undefined) {
    return;
  }
  try {
    const next = [...read().filter((entry) => entry !== key), key].slice(-MAXIMUM_DISMISSALS);
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota or policy: the hint may come back next visit, which is all that is lost.
  }
}

/** Forgets every dismissal; reports whether browser storage accepted the removal. */
export function clearSuggestionDismissals(): boolean {
  const storage = browserStorage();
  if (storage === undefined) return false;
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
