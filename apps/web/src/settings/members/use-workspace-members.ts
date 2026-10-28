import {
  isCanceledError,
  isNixApiError,
  workspaces as coreWorkspaces,
  type WorkspaceMember,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspace } from '../../workspaces/workspace-context';

export type { WorkspaceMember };
export type WorkspaceMembersStatus = 'loading' | 'ready' | 'error';

export interface WorkspaceMembersState {
  readonly status: WorkspaceMembersStatus;
  readonly members: readonly WorkspaceMember[];
  readonly truncated: boolean;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

const MAX_MEMBERS = 1000;

export function useWorkspaceMembers(): WorkspaceMembersState {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const activeLoad = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<WorkspaceMembersStatus>('loading');
  const [members, setMembers] = useState<readonly WorkspaceMember[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;
    setStatus('loading');
    setError(null);

    const collected: WorkspaceMember[] = [];
    try {
      for await (const member of client.paginate(coreWorkspaces.listMembers(workspaceId), {
        signal: controller.signal,
      })) {
        if (controller.signal.aborted || activeLoad.current !== controller) return;
        collected.push(member);
        if (collected.length >= MAX_MEMBERS) break;
      }
      if (controller.signal.aborted || activeLoad.current !== controller) return;
      setMembers(collected);
      setTruncated(collected.length >= MAX_MEMBERS);
      setStatus('ready');
    } catch (reason) {
      if (controller.signal.aborted || activeLoad.current !== controller || isCanceledError(reason))
        return;
      setMembers([]);
      setTruncated(false);
      setError(
        isNixApiError(reason)
          ? (reason.detail ?? 'The members could not be loaded.')
          : 'Core could not be reached.',
      );
      setStatus('error');
    } finally {
      if (activeLoad.current === controller) activeLoad.current = null;
    }
  }, [client, workspaceId]);

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

  return { status, members, truncated, error, reload: load };
}
