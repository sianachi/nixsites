import { isCanceledError, sites, type SiteApprovalEntry } from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { refusalMessage } from '../../sites/site-copy';

export type SiteApprovalsStatus = 'loading' | 'ready' | 'error';

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
        setError(refusalMessage(cause));
        setStatus('error');
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
