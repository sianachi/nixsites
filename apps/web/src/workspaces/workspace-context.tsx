import { isCanceledError, workspaces as coreWorkspaces, type Workspace } from '@nix/api-client';
import { createContext, use, useEffect, useRef, useState, type ReactNode } from 'react';
import { Outlet, useParams } from 'react-router';

import { useApiClient } from '../api/api-client-provider';
import { cacheKeysOverlap } from '../api/use-cache-invalidation';
import {
  cancelItemChildrenRefresh,
  notifyItemChildrenChanged,
} from '@nix/web-foundation/lib/item-children-changed';
import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { pruneBodyCache } from '@nix/web-foundation/lib/body-cache';
import { useTabStore } from '@nix/web-foundation/lib/tab-store';
import { rememberLastWorkspaceId } from './last-workspace';

export type WorkspaceListStatus = 'loading' | 'ready' | 'partial' | 'empty' | 'error';

export interface WorkspaceContextValue {
  readonly workspaceId: string;
  readonly workspace: Workspace;
  readonly workspaces: readonly Workspace[];
  readonly listStatus: 'ready' | 'partial';
  readonly listWarning: string | null;
  readonly reload: () => void;
  readonly workspaceCreated: (workspace: Workspace) => void;
  readonly workspaceUpdated: (workspace: Workspace) => void;
  readonly workspaceRemoved: (workspaceId: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const value = use(WorkspaceContext);
  if (value === null) throw new Error('useWorkspace was called outside WorkspaceProvider.');
  return value;
}

/**
 * The current workspace, or null when there is none - a public form link, say, which renders
 * property controls outside `/w/:workspaceId` entirely. A control that only *sometimes* needs a
 * workspace (an image property's upload capability) calls this instead of {@link useWorkspace},
 * so it can turn that capability off rather than crash a page that has no workspace to offer.
 */
export function useOptionalWorkspace(): WorkspaceContextValue | null {
  return use(WorkspaceContext);
}

export interface WorkspaceLoadState {
  readonly status: WorkspaceListStatus;
  readonly workspaces: readonly Workspace[];
  readonly error: string | null;
}

type AccessibleWorkspaceState = WorkspaceLoadState & {
  readonly reload: () => void;
  readonly workspaceCreated: (workspace: Workspace) => void;
  readonly workspaceUpdated: (workspace: Workspace) => void;
  readonly workspaceRemoved: (workspaceId: string) => void;
};

const AccessibleWorkspacesContext = createContext<AccessibleWorkspaceState | null>(null);

interface OptimisticWorkspace {
  readonly workspace: Workspace;
  /**
   * A list request that was already in flight cannot know about this write. Only a later complete
   * list may replace it with Core's authoritative name and capabilities, or remove it after leave.
   */
  readonly reconcileAtGeneration: number;
}

function useAccessibleWorkspaceLoader(): AccessibleWorkspaceState {
  const client = useApiClient();
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<WorkspaceLoadState>({
    status: 'loading',
    workspaces: [],
    error: null,
  });
  const localWorkspaces = useRef(new Map<string, OptimisticWorkspace>());
  const removedWorkspaces = useRef(new Map<string, number>());
  const activeLoadGeneration = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const generation = activeLoadGeneration.current + 1;
    activeLoadGeneration.current = generation;
    const collected: Workspace[] = [];
    queueMicrotask(() => {
      setState((current) =>
        current.workspaces.length === 0
          ? { status: 'loading', workspaces: [], error: null }
          : current,
      );
    });

    void (async () => {
      try {
        for await (const workspace of client.paginate(coreWorkspaces.listWorkspaces(), {
          signal: controller.signal,
        })) {
          collected.push(workspace);
        }
        const optimistic = localWorkspaces.current;
        const merged = collected.flatMap((workspace) => {
          const removedAt = removedWorkspaces.current.get(workspace.id);
          if (removedAt !== undefined) {
            if (removedAt > generation) return [];
            removedWorkspaces.current.delete(workspace.id);
          }
          const local = optimistic.get(workspace.id);
          if (local === undefined || local.reconcileAtGeneration <= generation) {
            optimistic.delete(workspace.id);
            return [workspace];
          }
          return [local.workspace];
        });
        for (const [workspaceId, local] of optimistic) {
          if (local.reconcileAtGeneration <= generation) {
            // A complete, later list is authoritative: this is the expected path after leave.
            optimistic.delete(workspaceId);
          } else if (!merged.some((entry) => entry.id === workspaceId)) {
            merged.unshift(local.workspace);
          }
        }
        for (const [workspaceId, reconcileAtGeneration] of removedWorkspaces.current) {
          if (reconcileAtGeneration <= generation) {
            removedWorkspaces.current.delete(workspaceId);
          }
        }
        setState({
          status: merged.length === 0 ? 'empty' : 'ready',
          workspaces: merged,
          error: null,
        });
      } catch (error) {
        if (isCanceledError(error) || controller.signal.aborted) return;
        setState((current) => {
          const byId = new Map<string, Workspace>();
          for (const workspace of current.workspaces) byId.set(workspace.id, workspace);
          for (const workspace of collected) byId.set(workspace.id, workspace);
          for (const [workspaceId, local] of localWorkspaces.current) {
            byId.set(workspaceId, local.workspace);
          }
          for (const [workspaceId, reconcileAtGeneration] of removedWorkspaces.current) {
            if (reconcileAtGeneration > generation) byId.delete(workspaceId);
          }
          const workspaces = [...byId.values()];
          return {
            status: workspaces.length === 0 ? 'error' : 'partial',
            workspaces,
            error:
              workspaces.length === 0
                ? 'Your workspaces could not be loaded. Check the connection and try again.'
                : 'Some workspaces could not be loaded. The workspaces shown are accessible, but the list may be incomplete.',
          };
        });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [client, reloadKey]);

  return {
    ...state,
    reload: () => {
      setReloadKey((value) => value + 1);
    },
    workspaceCreated: (workspace) => {
      localWorkspaces.current.set(workspace.id, {
        workspace,
        reconcileAtGeneration: activeLoadGeneration.current + 1,
      });
      setState((current) => ({
        status: current.status === 'partial' ? 'partial' : 'ready',
        workspaces: [workspace, ...current.workspaces.filter((entry) => entry.id !== workspace.id)],
        error: current.status === 'partial' ? current.error : null,
      }));
    },
    workspaceUpdated: (workspace) => {
      localWorkspaces.current.set(workspace.id, {
        workspace,
        reconcileAtGeneration: activeLoadGeneration.current + 1,
      });
      setState((current) => ({
        ...current,
        workspaces: current.workspaces.map((entry) =>
          entry.id === workspace.id ? workspace : entry,
        ),
      }));
    },
    workspaceRemoved: (workspaceId) => {
      localWorkspaces.current.delete(workspaceId);
      removedWorkspaces.current.set(workspaceId, activeLoadGeneration.current + 1);
      setState((current) => ({
        ...current,
        status:
          current.workspaces.length === 1 && current.workspaces[0]?.id === workspaceId
            ? 'empty'
            : current.status,
        workspaces: current.workspaces.filter((workspace) => workspace.id !== workspaceId),
      }));
    },
  };
}

export function AccessibleWorkspacesProvider(): ReactNode {
  const state = useAccessibleWorkspaceLoader();
  const subject = useSessionStore((session) => session.profile?.subject);
  // Once the complete list is known, local copies of bodies in any other workspace are copies of
  // something this person can no longer reach. A partial list proves nothing, so it prunes nothing.
  const reachable =
    state.status === 'ready' || state.status === 'empty'
      ? state.workspaces.map((workspace) => workspace.id).join(' ')
      : null;
  useEffect(() => {
    if (subject === undefined || reachable === null || typeof indexedDB === 'undefined') return;
    void pruneBodyCache(subject, reachable === '' ? [] : reachable.split(' ')).catch(
      () => undefined,
    );
  }, [reachable, subject]);
  return (
    <AccessibleWorkspacesContext value={state}>
      <Outlet />
    </AccessibleWorkspacesContext>
  );
}

export function useAccessibleWorkspaces(): AccessibleWorkspaceState {
  const state = use(AccessibleWorkspacesContext);
  if (state === null) {
    throw new Error('useAccessibleWorkspaces was called outside AccessibleWorkspacesProvider.');
  }
  return state;
}

export function WorkspaceProvider({
  state,
  children,
}: {
  readonly state: WorkspaceLoadState & {
    readonly reload: () => void;
    readonly workspaceCreated: (workspace: Workspace) => void;
    readonly workspaceUpdated: (workspace: Workspace) => void;
    readonly workspaceRemoved: (workspaceId: string) => void;
  };
  readonly children: ReactNode;
}): ReactNode {
  const { workspaceId = '' } = useParams();
  const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
  if (workspace === undefined || (state.status !== 'ready' && state.status !== 'partial')) {
    throw new Error('WorkspaceProvider requires a resolved accessible workspace.');
  }

  useEffect(() => {
    useTabStore.getState().workspaceChanged(workspace.id);
    rememberLastWorkspaceId(workspace.id);
  }, [workspace.id]);

  const client = useApiClient();
  useEffect(() => {
    const unsubscribe = client.cache.subscribeInvalidation((prefix) => {
      if (prefix[0] === 'items' || cacheKeysOverlap(prefix, ['workspaces', workspace.id, 'items']))
        notifyItemChildrenChanged(workspace.id, null);
    });
    return () => {
      unsubscribe();
      cancelItemChildrenRefresh(workspace.id);
    };
  }, [client, workspace.id]);

  return (
    <AccessibleWorkspacesContext value={state}>
      <WorkspaceContext
        value={{
          workspaceId: workspace.id,
          workspace,
          workspaces: state.workspaces,
          listStatus: state.status,
          listWarning: state.error,
          reload: state.reload,
          workspaceCreated: state.workspaceCreated,
          workspaceUpdated: state.workspaceUpdated,
          workspaceRemoved: state.workspaceRemoved,
        }}
      >
        {children}
      </WorkspaceContext>
    </AccessibleWorkspacesContext>
  );
}
