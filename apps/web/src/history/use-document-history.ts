/**
 * `useDocumentHistory`: the paged revision list, the named versions, and the four actions a
 * history panel offers, for one document.
 *
 * Follows the shape `use-workspace-calendar.ts` and `file-viewer.tsx` already established for
 * per-item state: a controller for the in-flight load that a new load or an unmount aborts, and a
 * ref holding the item this hook is currently answering for, so a response that lands after the
 * caller moved on to a different `itemId` is dropped rather than shown against the wrong document.
 * `stateAt`, `restore`, `nameVersion` and `removeName` are one-off requests rather than the page
 * load; each gets its own controller, tracked in a set so an unmount mid-flight can abort every
 * one of them, not only the most recent.
 *
 * Restoring, naming and un-naming a version all change what the lists say, so each refreshes them
 * afterward - the panel never has to remember to ask again.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@nix/web-platform/auth/auth-provider';
import {
  deleteNamedVersion,
  fetchStateAt,
  listNamedVersions,
  listRevisions,
  nameVersion as nameVersionRequest,
  restoreRevision,
  type DocumentState,
  type HistoryRefusal,
  type HistoryRequestConfig,
  type HistoryResult,
  type NamedVersion,
  type Revision,
} from './history-api';

/** How many revisions one page holds; the contract caps `limit` at 100. */
const PAGE_SIZE = 50;

const UNAUTHENTICATED_REFUSAL: HistoryRefusal = {
  code: 'history.unauthenticated',
  detail: 'Sign in again to see this document’s history.',
};

export interface DocumentHistoryState {
  readonly revisions: readonly Revision[];
  readonly hasMore: boolean;
  readonly loadMore: () => Promise<void>;
  readonly namedVersions: readonly NamedVersion[];
  readonly headSeq: number | null;
  readonly loading: boolean;
  readonly refusal: HistoryRefusal | null;
  readonly stateAt: (seq: number) => Promise<HistoryResult<DocumentState | null>>;
  readonly restore: (seq: number) => Promise<HistoryResult<{ readonly headSeq: number }>>;
  readonly nameVersion: (seq: number, name: string) => Promise<HistoryResult<NamedVersion>>;
  readonly removeName: (seq: number) => Promise<HistoryResult<true>>;
  readonly refresh: () => Promise<void>;
}

export function useDocumentHistory(itemId: string): DocumentHistoryState {
  const { getAccessToken } = useAuth();

  const [revisions, setRevisions] = useState<readonly Revision[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [namedVersions, setNamedVersions] = useState<readonly NamedVersion[]>([]);
  const [headSeq, setHeadSeq] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refusal, setRefusal] = useState<HistoryRefusal | null>(null);

  // The item this hook is currently answering for. Read inside a pending request's `.then` so a
  // response for an `itemId` this hook has since moved past never lands in state meant for the one
  // it moved to.
  const itemIdRef = useRef(itemId);
  // The paged-load request in flight, if any; a new load or an unmount aborts it.
  const loadControllerRef = useRef<AbortController | null>(null);
  // Every one-off action (`stateAt`, `restore`, `nameVersion`, `removeName`) in flight; unmount
  // aborts all of them, not only the latest.
  const operationsRef = useRef(new Set<AbortController>());

  // A function, not an inline property read: TypeScript narrows `controller.signal.aborted` after
  // the first check in a scope and would flag a later re-check as impossible, though an abort (or
  // an `itemId` change) can arrive between any two awaits - see `import-run.ts`'s `cancelled()`
  // for the same shape of the same problem.
  const stale = useCallback(
    (controller: AbortController, requestItemId: string): boolean =>
      controller.signal.aborted || itemIdRef.current !== requestItemId,
    [],
  );

  /** Fetches the newest page from scratch, replacing whatever the lists currently hold. */
  const refresh = useCallback(async (): Promise<void> => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    const requestItemId = itemId;

    setLoading(true);
    setRefusal(null);

    try {
      const token = await getAccessToken();
      if (stale(controller, requestItemId)) {
        return;
      }
      if (token === null) {
        setRefusal(UNAUTHENTICATED_REFUSAL);
        setLoading(false);
        return;
      }

      const config: HistoryRequestConfig = {
        itemId: requestItemId,
        token,
        signal: controller.signal,
      };
      const [revisionsResult, namedVersionsResult] = await Promise.all([
        listRevisions(config, { limit: PAGE_SIZE }),
        listNamedVersions(config),
      ]);
      if (stale(controller, requestItemId)) {
        return;
      }

      if (!revisionsResult.ok) {
        setRefusal(revisionsResult.refusal);
        setLoading(false);
        return;
      }
      if (!namedVersionsResult.ok) {
        setRefusal(namedVersionsResult.refusal);
        setLoading(false);
        return;
      }

      setRevisions(revisionsResult.value.revisions);
      setHasMore(revisionsResult.value.hasMore);
      setHeadSeq(revisionsResult.value.headSeq);
      setNamedVersions(namedVersionsResult.value);
      setLoading(false);
    } catch (error) {
      if (stale(controller, requestItemId)) {
        return;
      }
      setRefusal(requestFailure(error));
      setLoading(false);
    }
  }, [getAccessToken, itemId, stale]);

  useEffect(() => {
    itemIdRef.current = itemId;
    let active = true;
    // Deferred rather than called here directly: an effect body should not call setState
    // synchronously (it cascades a render into the one React just committed), so the reset and
    // the load it precedes both wait for the microtask queue, same as `use-workspace-calendar.ts`.
    queueMicrotask(() => {
      if (!active) {
        return;
      }
      setRevisions([]);
      setHasMore(false);
      setNamedVersions([]);
      setHeadSeq(null);
      void refresh();
    });
    return () => {
      active = false;
      loadControllerRef.current?.abort();
    };
    // Justification: `refresh` is recreated every time `itemId` changes (it closes over it), so
    // listing it too would run this effect twice per change for no different effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  useEffect(
    () => () => {
      for (const controller of operationsRef.current) {
        controller.abort();
      }
      operationsRef.current.clear();
    },
    [],
  );

  const loadMore = useCallback(async (): Promise<void> => {
    const before = revisions.at(-1)?.seq;
    if (!hasMore || loading || before === undefined) {
      return;
    }

    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    const requestItemId = itemId;

    setLoading(true);
    setRefusal(null);

    try {
      const token = await getAccessToken();
      if (stale(controller, requestItemId)) {
        return;
      }
      if (token === null) {
        setRefusal(UNAUTHENTICATED_REFUSAL);
        setLoading(false);
        return;
      }

      const result = await listRevisions(
        { itemId: requestItemId, token, signal: controller.signal },
        { before, limit: PAGE_SIZE },
      );
      if (stale(controller, requestItemId)) {
        return;
      }

      if (!result.ok) {
        setRefusal(result.refusal);
        setLoading(false);
        return;
      }

      setRevisions((current) => [...current, ...result.value.revisions]);
      setHasMore(result.value.hasMore);
      setHeadSeq(result.value.headSeq);
      setLoading(false);
    } catch (error) {
      if (stale(controller, requestItemId)) {
        return;
      }
      setRefusal(requestFailure(error));
      setLoading(false);
    }
  }, [getAccessToken, hasMore, itemId, loading, revisions, stale]);

  /** Runs one authenticated one-off action, tracked so an unmount can abort it. */
  const runOperation = useCallback(
    async <T>(
      action: (config: HistoryRequestConfig) => Promise<HistoryResult<T>>,
    ): Promise<HistoryResult<T>> => {
      const controller = new AbortController();
      operationsRef.current.add(controller);
      try {
        const token = await getAccessToken();
        if (token === null) {
          return { ok: false, refusal: UNAUTHENTICATED_REFUSAL };
        }
        return await action({ itemId, token, signal: controller.signal });
      } finally {
        operationsRef.current.delete(controller);
      }
    },
    [getAccessToken, itemId],
  );

  const stateAt = useCallback(
    (seq: number) => runOperation((config) => fetchStateAt(config, seq)),
    [runOperation],
  );

  const restore = useCallback(
    async (seq: number): Promise<HistoryResult<{ readonly headSeq: number }>> => {
      const result = await runOperation((config) => restoreRevision(config, seq));
      if (result.ok) {
        await refresh();
      }
      return result;
    },
    [refresh, runOperation],
  );

  const nameVersion = useCallback(
    async (seq: number, name: string): Promise<HistoryResult<NamedVersion>> => {
      const result = await runOperation((config) => nameVersionRequest(config, seq, name));
      if (result.ok) {
        await refresh();
      }
      return result;
    },
    [refresh, runOperation],
  );

  const removeName = useCallback(
    async (seq: number): Promise<HistoryResult<true>> => {
      const result = await runOperation((config) => deleteNamedVersion(config, seq));
      if (result.ok) {
        await refresh();
      }
      return result;
    },
    [refresh, runOperation],
  );

  return {
    revisions,
    hasMore,
    loadMore,
    namedVersions,
    headSeq,
    loading,
    refusal,
    stateAt,
    restore,
    nameVersion,
    removeName,
    refresh,
  };
}

function requestFailure(error: unknown): HistoryRefusal {
  return {
    code: 'history.request_failed',
    detail: error instanceof Error ? error.message : 'The document history could not be loaded.',
  };
}
