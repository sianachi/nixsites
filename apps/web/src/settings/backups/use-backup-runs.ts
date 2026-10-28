import { backups, isCanceledError, isNixApiError, type BackupRun } from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';

export type BackupRunsStatus = 'loading' | 'ready' | 'error';

export interface BackupRunsState {
  readonly status: BackupRunsStatus;
  readonly runs: readonly BackupRun[];
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

/** The recent nightly backup results, newest first. Core refuses anyone who is not an operator. */
export function useBackupRuns(): BackupRunsState {
  const client = useApiClient();
  const [status, setStatus] = useState<BackupRunsStatus>('loading');
  const [runs, setRuns] = useState<readonly BackupRun[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal, forceRefresh = false): Promise<void> => {
      setStatus('loading');
      setError(null);
      try {
        const loaded = await client.query(backups.listBackupRuns(), { signal, forceRefresh });
        setRuns(loaded.runs);
        setStatus('ready');
      } catch (cause) {
        if (signal?.aborted === true || isCanceledError(cause)) return;
        console.warn('The backup status read failed.', cause);
        setError(
          isNixApiError(cause) && cause.status === 403
            ? 'Only an operator of this deployment may read backup status.'
            : isNixApiError(cause) && cause.status !== undefined
              ? `Backup status could not be loaded (${String(cause.status)}).`
              : 'Core could not be reached.',
        );
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
    await load(undefined, true);
  }, [load]);

  return { status, runs, error, reload };
}
