import {
  isCanceledError,
  workspaces as coreWorkspaces,
  type DailyNoteSettings,
} from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';

export type DailyNoteSettingsState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly retry: () => void }
  | { readonly status: 'ready'; readonly settings: DailyNoteSettings };

/**
 * The workspace's daily-note settings, read through the cached client.
 *
 * `enabled` false leaves the request unmade, for callers that only sometimes need the answer: the
 * daily page needs it to name "today", the bar needs it only to tell whether a note is today's.
 */
export function useDailyNoteSettings(
  workspaceId: string,
  enabled: boolean,
): DailyNoteSettingsState {
  const client = useApiClient();
  const [loaded, setLoaded] = useState<{
    readonly workspaceId: string;
    readonly settings: DailyNoteSettings | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void client
      .query(coreWorkspaces.dailyNoteSettings(workspaceId), { signal: controller.signal })
      .then((settings) => {
        if (!controller.signal.aborted) setLoaded({ workspaceId, settings });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isCanceledError(reason)) return;
        setLoaded({ workspaceId, settings: null });
      });
    return () => {
      controller.abort();
    };
  }, [attempt, client, enabled, workspaceId]);

  const retry = useCallback(() => {
    setLoaded(null);
    setAttempt((value) => value + 1);
  }, []);

  if (!enabled) return { status: 'idle' };
  if (loaded?.workspaceId !== workspaceId) return { status: 'loading' };
  if (loaded.settings === null) return { status: 'error', retry };
  return { status: 'ready', settings: loaded.settings };
}
