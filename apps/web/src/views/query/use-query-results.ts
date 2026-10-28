import {
  isCanceledError,
  isNixApiError,
  itemQuery as coreItemQuery,
  type ItemQueryResults,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspace } from '../../workspaces/workspace-context';
import { onItemChildrenChanged } from '@nix/web-foundation/lib/item-children-changed';
import { useStaleWhileRevalidate } from '@nix/web-foundation/lib/use-stale-while-revalidate';
import { readerToday } from '../core/timestamps';

/**
 * One run of a saved query, refreshed on demand.
 *
 * Uses the configured `NixClient`, so the saved-query read shares the application's authentication,
 * cancellation, error mapping and response parsing path.
 *
 * **The client never sends rules.** It names the item, the view and its own day; the stored view
 * is the whole query. `today` is computed in the reader's zone on every load, because only the
 * reader's zone decides which day it is - an Overdue list read across midnight refetches as the
 * new day the moment it reloads.
 */

/** Moved beside the zone it reads; re-exported because callers and tests import it from here. */
/**
 * Why a failed run failed, in words a reader can act on - keyed on the problem's `code`, not the
 * status alone, for the reason `use-workspace-graph.ts` records: a bodyless 404 is this build
 * asking a server that does not offer the endpoint, not a refusal.
 */
function refusal(reason: unknown): string {
  const code = isNixApiError(reason) ? reason.code : null;

  if (code === 'items.not_found') {
    return 'This smart list could not be found.';
  }

  if (code === 'query.view_not_found') {
    return 'This item has no query view to run. Configure one under Views.';
  }

  if (code === 'query.invalid_rules') {
    return 'A stored filter no longer validates, so the query was not run. Edit the filters and save them again.';
  }

  if (code === 'query.invalid_today') {
    // Not a reader's mistake - the day is computed, not typed. On screen, this is a bug.
    return 'This version of the application sent a day the server refused.';
  }

  if (isNixApiError(reason) && reason.status === 404) {
    return 'This version of the application asked for a query the server does not offer. The server may be running an older build.';
  }

  return 'The smart list could not be loaded.';
}

type QueryResultsStatus = 'loading' | 'ready' | 'error';

export interface QueryResultsState {
  readonly status: QueryResultsStatus;

  /** The payload, or null while loading and after a failure. Never a half-built stand-in. */
  readonly results: ItemQueryResults | null;
  readonly error: string | null;

  /**
   * Whether a re-run is under way while the previous results are still on screen.
   *
   * `status` only becomes `'loading'` for the very first run - a later re-run (a filter that
   * changed, the periodic refresh, a deliberate reload) keeps the previous rows mounted instead of
   * swapping in a full-panel loading state, which used to reset the list's scroll position on every
   * refresh.
   */
  readonly refreshing: boolean;

  /**
   * Why the most recent background re-run failed, or null when the last one that finished
   * succeeded. Only ever set once there are results on screen to protect - see the equivalent
   * field on `ContainerData`.
   */
  readonly refreshError: string | null;

  readonly reload: () => Promise<void>;
}

export function useQueryResults(itemId: string, viewId: string): QueryResultsState {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();

  const { status, error, refreshing, refreshError, beginLoad, reportLoaded, reportFailed } =
    useStaleWhileRevalidate<QueryResultsStatus>('loading');
  const [results, setResults] = useState<ItemQueryResults | null>(null);
  const activeLoad = useRef<AbortController | null>(null);

  const load = useCallback(async (): Promise<void> => {
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;

    beginLoad();

    try {
      const today = readerToday();
      const loaded = await client.query(coreItemQuery.itemQuery(itemId, viewId, today), {
        forceRefresh: true,
        signal: controller.signal,
      });
      if (controller.signal.aborted || activeLoad.current !== controller) return;
      setResults(loaded);
      reportLoaded('ready');
    } catch (reason) {
      if (controller.signal.aborted || activeLoad.current !== controller || isCanceledError(reason))
        return;
      const message = isNixApiError(reason) ? refusal(reason) : 'Core could not be reached.';
      const refused =
        isNixApiError(reason) &&
        (reason.status === 403 || reason.status === 404 || reason.status === 423);
      if (refused) setResults(null);
      reportFailed(message, 'error', { blocking: refused });
    }
  }, [client, itemId, viewId, beginLoad, reportLoaded, reportFailed]);

  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) void load();
    });
    return () => {
      disposed = true;
      activeLoad.current?.abort();
    };
  }, [load]);

  useEffect(
    () =>
      onItemChildrenChanged((detail) => {
        if (detail.workspaceId !== workspaceId) return;
        if (detail.removedItemIds.length > 0) {
          const removed = new Set(detail.removedItemIds);
          setResults((current) =>
            current === null
              ? null
              : { ...current, results: current.results.filter((item) => !removed.has(item.id)) },
          );
        }
        void load();
      }),
    [load, workspaceId],
  );

  return { status, results, error, refreshing, refreshError, reload: load };
}
