import { files as fileResources, isNixApiError, type FileRecord } from '@nix/api-client';
import { useEffect, useRef, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import {
  cacheKeysOverlap,
  useCacheInvalidation,
} from '@nix/web-platform/api/use-cache-invalidation';

/** What this hook knows about one file item's record, or why it does not know yet. */
export type DriveFileInfo =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly record: FileRecord }
  | { readonly status: 'error' };

/**
 * File facts - size, media type, the current version's name - for the file rows a drive is
 * drawing right now.
 *
 * `Item` carries none of this: size and media type live on the file record, not on the item, so a
 * list of children is never enough to draw a Size column. This fetches `fileByItem` once per file
 * item, lazily - only for the ids it is handed, which is how a caller limits it to the rows that
 * are actually on screen - and caches the answer by id for as long as the hook stays mounted, so
 * a re-render with the same ids costs nothing more.
 *
 * Every in-flight request is aborted: on unmount, and also the moment an id drops out of the list
 * this hook was handed (a row scrolled away, or the container reloaded without it), so a slow
 * response for a row nobody is looking at any more cannot land on top of a newer one. An id that
 * comes back later is fetched again rather than trusted stale, since dropping it also drops it
 * from the cache.
 */
export function useDriveFileInfo(
  fileItemIds: readonly string[],
): ReadonlyMap<string, DriveFileInfo> {
  const client = useApiClient();
  const [info, setInfo] = useState<ReadonlyMap<string, DriveFileInfo>>(new Map());
  const fetched = useRef(new Set<string>());
  const controllers = useRef(new Map<string, AbortController>());
  const [revision, setRevision] = useState(0);

  // A stable key rather than the array itself: a caller typically passes a freshly filtered array
  // every render, and depending on that would refetch nothing every render into an infinite loop
  // of the abort/refetch cleanup below.
  const key = fileItemIds.join('\u0000');

  useCacheInvalidation(
    (prefix) => fileItemIds.some((id) => cacheKeysOverlap(prefix, ['files', id])),
    (prefixes) => {
      for (const id of fileItemIds) {
        if (!prefixes.some((prefix) => cacheKeysOverlap(prefix, ['files', id]))) continue;
        controllers.current.get(id)?.abort();
        fetched.current.delete(id);
      }
      setRevision((current) => current + 1);
    },
  );

  useEffect(() => {
    const ids = key.length === 0 ? [] : key.split('\u0000');
    const wanted = new Set(ids);

    for (const [itemId, controller] of controllers.current) {
      if (!wanted.has(itemId)) {
        controller.abort();
        controllers.current.delete(itemId);
        fetched.current.delete(itemId);
      }
    }

    for (const itemId of ids) {
      if (fetched.current.has(itemId)) continue;
      fetched.current.add(itemId);

      const controller = new AbortController();
      controllers.current.set(itemId, controller);
      setInfo((current) =>
        current.get(itemId)?.status === 'ready'
          ? current
          : new Map(current).set(itemId, { status: 'loading' }),
      );

      client
        .query(fileResources.fileByItem(itemId), {
          signal: controller.signal,
          forceRefresh: true,
        })
        .then((record) => {
          if (controller.signal.aborted) return;
          setInfo((current) => new Map(current).set(itemId, { status: 'ready', record }));
        })
        .catch((reason: unknown) => {
          if (controller.signal.aborted) return;
          const refused =
            isNixApiError(reason) &&
            (reason.status === 403 || reason.status === 404 || reason.status === 423);
          setInfo((current) =>
            !refused && current.get(itemId)?.status === 'ready'
              ? current
              : new Map(current).set(itemId, { status: 'error' }),
          );
        });
    }
  }, [client, key, revision]);

  useEffect(() => {
    // Unmount only: every request still open at that point belongs to a row nobody can see again.
    const inFlight = controllers.current;
    return () => {
      for (const controller of inFlight.values()) controller.abort();
    };
  }, []);

  return info;
}
