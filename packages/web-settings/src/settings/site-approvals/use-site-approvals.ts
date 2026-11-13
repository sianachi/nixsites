import {
  isCanceledError,
  isNixApiError,
  sites,
  workspaces as coreWorkspaces,
  type SiteApprovalEntry,
} from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { refusalMessage } from '@nix/web-sites/sites/site-copy';

export type SiteApprovalsStatus = 'loading' | 'ready' | 'not-configured' | 'error';

/** Sites waiting for a first-publish decision. Core refuses anyone who is not an approver. */
export interface SiteApprovalsState {
  readonly status: SiteApprovalsStatus;
  readonly approvals: readonly SiteApprovalEntry[];
  readonly error: string | null;
  readonly busySiteId: string | null;
  readonly reload: () => Promise<void>;
  /** Approves (no note) or rejects. Resolves to Core's refusal, or null once done and refreshed. */
  readonly decide: (
    siteId: string,
    decision: 'approve' | 'reject',
    note?: string,
  ) => Promise<string | null>;
}

export function useSiteApprovals(): SiteApprovalsState {
  const client = useApiClient();
  const [status, setStatus] = useState<SiteApprovalsStatus>('loading');
  const [approvals, setApprovals] = useState<readonly SiteApprovalEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busySiteId, setBusySiteId] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setError(null);
      try {
        const loaded = await client.query(sites.listSiteApprovals(), {
          signal,
          forceRefresh: true,
        });
        setApprovals(loaded.approvals);
        setStatus('ready');
      } catch (cause) {
        if (signal?.aborted === true || isCanceledError(cause)) return;
        if (isNixApiError(cause) && cause.code === 'sites.not_configured') {
          setStatus('not-configured');
        } else {
          setError(refusalMessage(cause));
          setStatus('error');
        }
      }
    },
    [client],
  );

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      void load(controller.signal);
    });
    return () => {
      controller.abort();
    };
  }, [load]);

  const reload = useCallback(async (): Promise<void> => {
    setStatus('loading');
    await load();
  }, [load]);

  const decide = useCallback(
    async (
      siteId: string,
      decision: 'approve' | 'reject',
      note?: string,
    ): Promise<string | null> => {
      setBusySiteId(siteId);
      try {
        await client.execute(
          decision === 'approve'
            ? sites.approveSitePublish(siteId)
            : sites.rejectSitePublish(siteId, note),
        );
      } catch (cause) {
        setBusySiteId(null);
        return refusalMessage(cause);
      }
      await load();
      setBusySiteId(null);
      return null;
    },
    [client, load],
  );

  return { status, approvals, error, busySiteId, reload, decide };
}

/**
 * Display names for the people who asked, keyed by principal id. Read from each waiting site's
 * workspace member list; a workspace the approver cannot read just leaves its people unnamed, and
 * the caller falls back to the short id.
 */
export function useRequesterNames(
  approvals: readonly SiteApprovalEntry[],
): ReadonlyMap<string, string> {
  const client = useApiClient();
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const workspaceKey = [...new Set(approvals.map((entry) => entry.workspaceId))].sort().join(',');

  useEffect(() => {
    if (workspaceKey === '') return;
    const controller = new AbortController();
    void (async () => {
      const found = new Map<string, string>();
      for (const workspaceId of workspaceKey.split(',')) {
        try {
          for await (const member of client.paginate(coreWorkspaces.listMembers(workspaceId), {
            signal: controller.signal,
          })) {
            found.set(member.subjectId, member.subjectDisplayName);
          }
        } catch {
          // Names are a convenience; an unreadable workspace keeps the short id.
        }
      }
      if (!controller.signal.aborted) setNames(found);
    })();
    return () => {
      controller.abort();
    };
  }, [client, workspaceKey]);

  return names;
}
