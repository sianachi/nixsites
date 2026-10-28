import { z } from 'zod';

import { browserSessionStorage } from './browser-storage';

/**
 * A short record of an import torn down mid-run, so the person who caused it - not necessarily the
 * one who is looking - can be told what happened once they are back in the workspace it ran
 * against.
 *
 * **Counts only, and only for the person who ran it.** No item title, path, or body ever crosses
 * into storage here, and the record carries the issuer's subject: a session expiring mid-import is
 * exactly the moment identity is uncertain, and someone else signing in next on a shared machine -
 * even a co-member of the same workspace - must not be shown another person's import. A deliberate
 * sign-out clears it outright (see `clearInterruptedImport`).
 */

const STORAGE_KEY = 'nix:import-interrupted';

const interruptedImportSchema = z.object({
  subject: z.string().min(1),
  workspaceId: z.string().min(1),
  createdCount: z.number().int().nonnegative(),
  totalCount: z.number().int().positive(),
});

export type InterruptedImportNotice = z.infer<typeof interruptedImportSchema>;

/**
 * Records that an import was torn down while items were still being created, rather than closed
 * by the person who started it. Overwrites any earlier pending notice: there is one slot, because
 * there is one import dialog and it cannot run two imports at once.
 */
export function recordInterruptedImport(notice: InterruptedImportNotice): void {
  const storage = browserSessionStorage();
  if (storage === undefined) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(notice));
  } catch {
    // Storage that throws on write is exactly as unavailable as storage that is not there; the
    // notice is simply lost, which is better than the alternative of surfacing a write error for
    // a courtesy message nobody asked for.
  }
}

/**
 * Reads a pending notice for `workspaceId` and, when found, clears it - a notice is shown once.
 * A notice recorded against a different workspace is left in place, unread, for whichever
 * workspace it actually names; this call reports nothing for the caller's own workspace in that
 * case, which is the honest answer to "is there anything for me". A notice recorded by a different
 * person is dropped unread: it was never this reader's to see.
 */
export function consumeInterruptedImportForWorkspace(
  workspaceId: string,
  subject: string,
): string | null {
  const storage = browserSessionStorage();
  if (storage === undefined) {
    return null;
  }

  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }

  const parsed = parseInterruptedImportNotice(raw);
  if (parsed === null) {
    // Corrupt or foreign data under our key; drop it rather than let it sit there forever unread.
    removeInterruptedImport(storage);
    return null;
  }

  if (parsed.subject !== subject) {
    removeInterruptedImport(storage);
    return null;
  }

  if (parsed.workspaceId !== workspaceId) {
    return null;
  }

  removeInterruptedImport(storage);
  return `Import interrupted: ${String(parsed.createdCount)} of ${String(parsed.totalCount)} created.`;
}

/** Drops any pending notice; called on a deliberate sign-out so nothing crosses to the next person. */
export function clearInterruptedImport(): void {
  const storage = browserSessionStorage();
  if (storage !== undefined) {
    removeInterruptedImport(storage);
  }
}

function parseInterruptedImportNotice(raw: string): InterruptedImportNotice | null {
  try {
    const result = interruptedImportSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function removeInterruptedImport(storage: Storage): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing further to do if removal itself is refused.
  }
}
