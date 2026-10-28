import { isCanceledError, items } from '@nix/api-client';
import { useEffect, useState } from 'react';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';

export interface MutedContainer {
  readonly id: string;
  /** Null when the item could no longer be read - trashed, purged, or no longer visible. Shown
   * as "Unknown item" rather than dropped, since it still counts toward the muted list and
   * removing it is still the honest action to offer. */
  readonly title: string | null;
}

/** Resolves the titles behind a preferences document's `mutedContainerIds`, one item read per id.
 * There is no batch-by-ids endpoint in this contract, and a muted list is short by construction
 * (<= 200, and realistically a handful), so one request per id is the straightforward read rather
 * than a new server capability this lane has no mandate to add. */
export function useMutedContainerTitles(ids: readonly string[]): {
  readonly containers: readonly MutedContainer[];
  readonly loading: boolean;
} {
  const client = useApiClient();
  const [containers, setContainers] = useState<readonly MutedContainer[]>(
    ids.map((id) => ({ id, title: null })),
  );
  const [loading, setLoading] = useState(ids.length > 0);
  const key = ids.join(',');

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      if (ids.length === 0) {
        setContainers([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      void Promise.all(
        ids.map(async (id) => {
          try {
            const item = await client.query(items.itemById(id), {
              signal: controller.signal,
              forceRefresh: true,
            });
            return { id, title: item.title };
          } catch (cause) {
            if (isCanceledError(cause)) return null;
            return { id, title: null };
          }
        }),
      ).then((resolved) => {
        if (controller.signal.aborted) return;
        setContainers(resolved.filter((entry): entry is MutedContainer => entry !== null));
        setLoading(false);
      });
    });
    return () => {
      controller.abort();
    };
    // `key` is `ids` flattened to a stable primitive so this only re-runs when the set of ids
    // actually changes, not on every render of a caller that passes a fresh array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);

  return { containers, loading };
}
