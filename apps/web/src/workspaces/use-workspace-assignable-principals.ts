import {
  isCanceledError,
  isNixApiError,
  workspaces as coreWorkspaces,
  type WorkspacePrincipal,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspace } from './workspace-context';

export type AssignablePrincipalsStatus = 'loading' | 'ready' | 'error';

export interface WorkspaceAssignablePrincipalsState {
  readonly status: AssignablePrincipalsStatus;
  readonly principals: readonly WorkspacePrincipal[];
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loadMore: () => Promise<void>;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

/** Searches and pages active direct and group-derived principals through Core. */
export function useWorkspaceAssignablePrincipals(): WorkspaceAssignablePrincipalsState {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const activeLoad = useRef<AbortController | null>(null);
  const cursorRef = useRef<string | null>(null);
  const moreLoad = useRef(false);
  const [status, setStatus] = useState<AssignablePrincipalsStatus>('loading');
  const [principals, setPrincipals] = useState<readonly WorkspacePrincipal[]>([]);
  const [query, setQuery] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (search: string, cursor?: string): Promise<void> => {
      if (cursor === undefined) {
        activeLoad.current?.abort();
        cursorRef.current = null;
        setStatus('loading');
        setPrincipals([]);
        setHasMore(false);
        setError(null);
      } else {
        if (moreLoad.current || cursorRef.current !== cursor) return;
        moreLoad.current = true;
        setLoadingMore(true);
      }
      const controller = new AbortController();
      activeLoad.current = controller;
      try {
        const page = await client.query(
          coreWorkspaces.listAssignablePrincipalsPage(workspaceId, {
            query: search.trim() || undefined,
            cursor,
            limit: 100,
          }),
          { signal: controller.signal, forceRefresh: true },
        );
        if (controller.signal.aborted || activeLoad.current !== controller) return;
        cursorRef.current = page.nextCursor;
        setPrincipals((previous) =>
          cursor === undefined ? page.items : [...previous, ...page.items],
        );
        setHasMore(page.nextCursor !== null);
        setStatus('ready');
      } catch (reason) {
        if (
          controller.signal.aborted ||
          activeLoad.current !== controller ||
          isCanceledError(reason)
        )
          return;
        if (cursor === undefined) setPrincipals([]);
        setError(
          isNixApiError(reason)
            ? (reason.detail ?? 'Assignable principals could not be loaded.')
            : 'Core could not be reached.',
        );
        setStatus('error');
      } finally {
        if (activeLoad.current === controller) activeLoad.current = null;
        moreLoad.current = false;
        setLoadingMore(false);
      }
    },
    [client, workspaceId],
  );

  useEffect(() => {
    const timer = setTimeout(() => void load(query), query.length === 0 ? 0 : 250);
    return () => {
      clearTimeout(timer);
      activeLoad.current?.abort();
    };
  }, [load, query]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (cursorRef.current !== null) await load(query, cursorRef.current);
  }, [load, query]);
  const reload = useCallback(async (): Promise<void> => load(query), [load, query]);

  return {
    status,
    principals,
    query,
    setQuery,
    hasMore,
    loadingMore,
    loadMore,
    error,
    reload,
  };
}
