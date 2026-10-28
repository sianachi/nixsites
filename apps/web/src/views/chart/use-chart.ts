import {
  isCanceledError,
  isNixApiError,
  itemChart as coreItemChart,
  type ItemChart,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '../../api/api-client-provider';
import { cacheKeysOverlap, useCacheInvalidation } from '../../api/use-cache-invalidation';
import { useOptionalWorkspace } from '../../workspaces/workspace-context';

/**
 * One chart view's buckets, refreshed on demand and whenever its configuration changes.
 *
 * Uses the configured API client so authentication, cancellation, caching, error mapping, and
 * response parsing stay on the same path as the other server-owned views.
 *
 * **The client names the view and never sends the grouping.** The stored view is the whole
 * configuration, exactly as it is for a smart list, and the buckets are computed over every child
 * rather than over the page the container happens to have loaded - which is what a chart tallied in
 * the browser could not honestly claim.
 *
 * **A saved change redraws.** The caller passes a fingerprint of the view's stored configuration;
 * when it changes - somebody saved a new type, period or split - the chart is read again past the
 * cache, so the drawing never stays on the configuration it was opened with.
 */

/** Why a failed read failed, and whether trying again could help. */
type ChartFailure = 'configuration' | 'locked' | 'missing' | 'unavailable';

/**
 * Why a failed read failed, in words a reader can act on.
 *
 * Keyed on the problem's `code` rather than on the status alone: a bodyless 404 is this build
 * asking a server that does not offer the endpoint, not a refusal.
 */
function refusal(reason: unknown): { readonly kind: ChartFailure; readonly message: string } {
  const code = isNixApiError(reason) ? reason.code : null;

  if (code === 'items.not_found') {
    return { kind: 'missing', message: 'This item could not be found.' };
  }

  if (code === 'items.locked') {
    return { kind: 'locked', message: 'This item is locked. Unlock it to see its chart.' };
  }

  if (code === 'chart.view_not_found') {
    return {
      kind: 'configuration',
      message: 'This item has no chart view to draw. Add one in the settings for this view.',
    };
  }

  if (code === 'chart.not_configured') {
    return {
      kind: 'configuration',
      message:
        'This chart is not finished: it needs a property to group by, and a property to total if it totals one. Finish it in the settings for this view.',
    };
  }

  if (isNixApiError(reason) && reason.status === 404) {
    return {
      kind: 'unavailable',
      message:
        'This version of the application asked for a chart the server does not offer. The server may be running an older build.',
    };
  }

  return { kind: 'unavailable', message: 'The chart could not be loaded.' };
}

type ChartStatus = 'loading' | 'ready' | 'error';

export interface ChartState {
  readonly status: ChartStatus;

  /** The payload, or null while loading and after a failure. Never a half-built stand-in. */
  readonly chart: ItemChart | null;
  readonly error: string | null;
  /** What kind of failure, so the view offers a retry only where one could help. */
  readonly failure: ChartFailure | null;
  readonly reload: () => Promise<void>;
}

export function useChart(itemId: string, viewId: string, fingerprint = ''): ChartState {
  const client = useApiClient();
  const workspace = useOptionalWorkspace();

  const [status, setStatus] = useState<ChartStatus>('loading');
  const [chart, setChart] = useState<ItemChart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<ChartFailure | null>(null);
  const activeLoad = useRef<AbortController | null>(null);

  const load = useCallback(
    async (forceRefresh = true): Promise<void> => {
      activeLoad.current?.abort();
      const controller = new AbortController();
      activeLoad.current = controller;
      setStatus((current) => (current === 'ready' ? current : 'loading'));
      setError(null);
      setFailure(null);

      try {
        const loaded = await client.query(coreItemChart.itemChart(itemId, viewId), {
          forceRefresh,
          signal: controller.signal,
        });
        if (controller.signal.aborted || activeLoad.current !== controller) return;
        setChart(loaded);
        setStatus('ready');
      } catch (reason) {
        if (
          controller.signal.aborted ||
          activeLoad.current !== controller ||
          isCanceledError(reason)
        )
          return;
        const why = isNixApiError(reason)
          ? refusal(reason)
          : { kind: 'unavailable' as const, message: 'Core could not be reached.' };
        setError(why.message);
        setFailure(why.kind);
        setStatus('error');
      }
    },
    [client, itemId, viewId],
  );

  useCacheInvalidation(
    (prefix) =>
      prefix[0] === 'items' ||
      (workspace !== null &&
        cacheKeysOverlap(prefix, ['workspaces', workspace.workspaceId, 'items'])),
    () => {
      void load(true);
    },
  );

  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) void load(true);
    });
    return () => {
      disposed = true;
      activeLoad.current?.abort();
    };
  }, [load, fingerprint]);

  const reload = useCallback(() => load(true), [load]);

  return { status, chart, error, failure, reload };
}
