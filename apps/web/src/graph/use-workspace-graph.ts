import {
  isCanceledError,
  isNixApiError,
  workspaceGraph as coreWorkspaceGraph,
  type WorkspaceGraph,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import {
  itemSubtreeIds,
  onItemChildrenChanged,
} from '@nix/web-foundation/lib/item-children-changed';

export type GraphStatus = 'loading' | 'ready' | 'error';

export interface WorkspaceGraphState {
  readonly status: GraphStatus;
  readonly graph: WorkspaceGraph | null;
  readonly error: string | null;
  readonly reload: () => Promise<void>;

  /**
   * Reads the graph again without leaving the one on screen.
   *
   * `reload` is the way out of a failure and shows the loading state, which is right there. After
   * a change made from the graph itself that would unmount the drawing the reader is working in
   * and lose their place, so this keeps it up and swaps the payload in when it arrives.
   */
  readonly refresh: () => Promise<void>;
}

function graphError(reason: unknown): string {
  if (isNixApiError(reason) && reason.code === 'workspaces.not_found') {
    return 'This workspace could not be found.';
  }
  if (isNixApiError(reason) && reason.status === 404) {
    return 'This version of the application asked for a graph the server does not offer. The server may be running an older build.';
  }
  return 'The graph could not be loaded.';
}

export function useWorkspaceGraph(): WorkspaceGraphState {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const activeLoad = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<GraphStatus>('loading');
  const [graph, setGraph] = useState<WorkspaceGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(
    async (keepShowing: boolean): Promise<void> => {
      activeLoad.current?.abort();
      const controller = new AbortController();
      activeLoad.current = controller;
      if (!keepShowing) {
        setStatus('loading');
      }
      setError(null);

      try {
        const next = await client.query(coreWorkspaceGraph.workspaceGraph(workspaceId), {
          signal: controller.signal,
          forceRefresh: true,
        });
        if (controller.signal.aborted || activeLoad.current !== controller) return;
        setGraph(next);
        setStatus('ready');
      } catch (reason) {
        if (
          controller.signal.aborted ||
          activeLoad.current !== controller ||
          isCanceledError(reason)
        )
          return;
        setGraph(null);
        setError(graphError(reason));
        setStatus('error');
      } finally {
        if (activeLoad.current === controller) activeLoad.current = null;
      }
    },
    [client, workspaceId],
  );
  const load = useCallback(() => read(false), [read]);
  const refresh = useCallback(() => read(true), [read]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void load();
    });
    return () => {
      active = false;
      activeLoad.current?.abort();
    };
  }, [load]);

  useEffect(
    () =>
      onItemChildrenChanged((detail) => {
        if (
          detail.workspaceId !== workspaceId ||
          (detail.removedItemIds.length === 0 && detail.restoredItemIds.length === 0)
        )
          return;
        if (detail.removedItemIds.length > 0)
          setGraph((current) => {
            if (current === null) return null;
            const removed = itemSubtreeIds(current.nodes, detail.removedItemIds);
            return {
              ...current,
              nodes: current.nodes.filter((node) => !removed.has(node.id)),
              links: current.links.filter(
                (link) => !removed.has(link.sourceId) && !removed.has(link.targetId),
              ),
            };
          });
        void refresh();
      }),
    [refresh, workspaceId],
  );

  return { status, graph, error, reload: load, refresh };
}
