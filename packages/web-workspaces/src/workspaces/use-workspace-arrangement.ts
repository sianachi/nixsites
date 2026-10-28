import {
  isCanceledError,
  isNixApiError,
  workspaceArrangement as arrangementResource,
  type WorkspaceArrangementInput,
  type WorkspaceArrangementResponse,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { isAborted } from '@nix/web-foundation/lib/guards';
import { EMPTY_ARRANGEMENT } from './arrangement';

export interface WorkspaceArrangementState {
  /** The saved document, or the empty arrangement until the first read answers. */
  readonly arrangement: WorkspaceArrangementInput;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  /** Saves at the revision last read; a 409 reloads the other device's copy instead of overwriting it. */
  readonly save: (value: WorkspaceArrangementInput) => Promise<boolean>;
}

/**
 * The caller's own workspace groups and pins, following the compare-and-set pattern the
 * notification preferences use: one revisioned document, a conflict reloaded rather than forced.
 */
export function useWorkspaceArrangement(): WorkspaceArrangementState {
  const client = useApiClient();
  const [saved, setSaved] = useState<WorkspaceArrangementResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const lifetime = useRef<AbortController | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const response = await client.query(arrangementResource.arrangement(), {
          signal,
          forceRefresh: true,
        });
        if (!isAborted(signal)) setSaved(response);
      } catch (cause) {
        if (isAborted(signal) || isCanceledError(cause)) return;
        setError('Your workspace groups could not be loaded.');
      } finally {
        if (!isAborted(signal)) setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    queueMicrotask(() => {
      if (!isAborted(controller.signal)) void load(controller.signal);
    });
    const unsubscribe = client.cache.subscribeInvalidation((prefix) => {
      if (prefix[0] === 'me' && prefix[1] === 'workspace-arrangement') void load(controller.signal);
    });
    return () => {
      unsubscribe();
      controller.abort();
    };
  }, [client, load]);

  async function save(value: WorkspaceArrangementInput): Promise<boolean> {
    const controller = lifetime.current;
    if (saved === null || savingRef.current || !controller || isAborted(controller.signal)) {
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const response = await client.execute(
        arrangementResource.saveArrangement(saved.revision, value),
        { signal: controller.signal },
      );
      if (!isAborted(controller.signal)) setSaved(response);
      return true;
    } catch (cause) {
      if (isAborted(controller.signal) || isCanceledError(cause)) return false;
      if (isNixApiError(cause) && cause.status === 409) {
        setError('Your workspace groups changed on another device. Showing the saved copy.');
        try {
          const fresh = await client.query(arrangementResource.arrangement(), {
            signal: controller.signal,
            forceRefresh: true,
          });
          if (!isAborted(controller.signal)) setSaved(fresh);
        } catch {
          // The conflict message stays if even the reload fails.
        }
        return false;
      }
      setError(
        isNixApiError(cause) && cause.detail !== undefined
          ? cause.detail
          : 'The change could not be saved.',
      );
      return false;
    } finally {
      savingRef.current = false;
      if (!isAborted(controller.signal)) setSaving(false);
    }
  }

  return {
    arrangement:
      saved === null
        ? EMPTY_ARRANGEMENT
        : { groups: saved.groups, pinnedWorkspaceIds: saved.pinnedWorkspaceIds },
    loading,
    saving,
    error,
    save,
  };
}
