import { browserStorage } from './browser-storage';

// Earlier builds kept generated thumbnails in Cache Storage under this name, indexed in browser
// storage; nothing writes them now, but a sign-out still clears what an old install left behind.
const CACHE_NAME = 'nix-thumbnails-v1';
const INDEX_KEY = 'nix.thumbnails.index';

const THUMBNAIL_CACHE_MAX_ENTRIES = 300;
const THUMBNAIL_CACHE_MAX_BYTES = 30 * 1024 * 1024;

/**
 * Thumbnail bytes Core has already authorised once in this tab, by the object they came from.
 *
 * **Memory only, and never an answer on its own.** A stored thumbnail is body data, so nothing
 * here is written to disk - that would keep the picture of a file later put under a lock - and
 * the only caller asks Core for the capability first, every time, and comes here with the object
 * that capability names. What this saves is the second trip, to object storage, for bytes this
 * tab is already holding; what it never does is decide that somebody may see them.
 *
 * Keyed by the object's address without its signature, which names one file version: a replaced
 * file is a different object and so a different key. Least-recently-used against the same two
 * caps as the store above, in a `Map` whose insertion order is the order of use.
 */
const authorisedBytes = new Map<string, Blob>();
let authorisedTotal = 0;
// Counts the times the bytes were forgotten. A download that began before a sign-out carries the
// number it started under, and is not kept if it finishes after one.
let authorisedGeneration = 0;

/** Taken before a download begins and handed back with its bytes. */
export function authorisedBytesGeneration(): number {
  return authorisedGeneration;
}

export function recallAuthorisedBytes(objectAddress: string): Blob | null {
  const blob = authorisedBytes.get(objectAddress);
  if (blob === undefined) return null;
  authorisedBytes.delete(objectAddress);
  authorisedBytes.set(objectAddress, blob);
  return blob;
}

export function rememberAuthorisedBytes(
  objectAddress: string,
  blob: Blob,
  generation: number,
): void {
  if (generation !== authorisedGeneration) return;
  const previous = authorisedBytes.get(objectAddress);
  if (previous !== undefined) {
    authorisedBytes.delete(objectAddress);
    authorisedTotal -= previous.size;
  }
  if (blob.size > THUMBNAIL_CACHE_MAX_BYTES) return;
  authorisedBytes.set(objectAddress, blob);
  authorisedTotal += blob.size;
  for (const [address, oldest] of authorisedBytes) {
    if (
      authorisedBytes.size <= THUMBNAIL_CACHE_MAX_ENTRIES &&
      authorisedTotal <= THUMBNAIL_CACHE_MAX_BYTES
    )
      break;
    authorisedBytes.delete(address);
    authorisedTotal -= oldest.size;
  }
}

/** For a sign-out or a "clear local data": every thumbnail, on every backend. */
export async function forgetThumbnails(): Promise<void> {
  authorisedBytes.clear();
  authorisedTotal = 0;
  authorisedGeneration += 1;
  try {
    browserStorage()?.removeItem(INDEX_KEY);
  } catch {
    // Nothing to clear if storage refuses.
  }
  try {
    if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME);
  } catch {
    // Same: not clearable is not a failure the caller can act on.
  }
}
