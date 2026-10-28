import { z } from 'zod';

/**
 * Where somebody was in each book, on this device.
 *
 * The chapter and the text size, per file, in one record in browser storage. The position inside a
 * chapter is not kept: the chapter is shown in a sandboxed frame, and nothing outside such a frame
 * can read how far it has scrolled - so the promise is the chapter, and that is all this keeps.
 *
 * Per device, not per account, because it is a reading convenience and not data: losing it costs
 * one tap on Contents. Capped so a library of hundreds of books cannot grow the record without
 * limit; the most recently read are the ones kept.
 */

const STORAGE_KEY = 'nix.epub.progress';
export const EPUB_PROGRESS_LIMIT = 200;

const entrySchema = z.object({
  id: z.string().min(1),
  chapter: z.number().int().min(0),
  size: z.number().int().min(0),
});
const recordSchema = z.array(entrySchema);

export interface EpubProgress {
  readonly chapter: number;
  readonly size: number;
}

/** Most recent last, so appending is recording and trimming the front is forgetting the oldest. */
function readAll(storage: Storage | undefined): z.infer<typeof recordSchema> {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return [];
    const parsed = recordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function readEpubProgress(storage: Storage | undefined, id: string): EpubProgress | null {
  const found = readAll(storage).find((entry) => entry.id === id);
  return found === undefined ? null : { chapter: found.chapter, size: found.size };
}

export function writeEpubProgress(
  storage: Storage | undefined,
  id: string,
  progress: EpubProgress,
): void {
  const others = readAll(storage).filter((entry) => entry.id !== id);
  const next = [...others, { id, ...progress }].slice(-EPUB_PROGRESS_LIMIT);
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Full or refused. Not remembering a chapter is not worth interrupting a reader for.
  }
}
