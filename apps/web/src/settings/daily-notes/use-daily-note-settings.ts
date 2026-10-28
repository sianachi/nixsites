import {
  isCanceledError,
  isNixApiError,
  workspaces,
  type DailyNoteSettings,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspace } from '../../workspaces/workspace-context';
import { isAborted } from '@nix/web-foundation/lib/guards';

export interface DailyNoteSettingsState {
  readonly saved: DailyNoteSettings | null;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  /** The server refused a save as not-found, which for this resource means no permission. */
  readonly forbidden: boolean;
  readonly save: (value: DailyNoteSettings) => Promise<boolean>;
}

// Cancellation can change while a request is awaiting I/O.
/**
 * Loads and saves one workspace's daily-note settings, following the shape of
 * `use-notification-preferences.ts`. Unlike that document these settings are not revisioned, so
 * there is no conflict branch; the failures worth telling apart are a refused save (the server
 * answers 404 to anyone who may read but not change) and a rejected value (422 with a detail).
 */
export function useDailyNoteSettings(workspaceId: string): DailyNoteSettingsState {
  const client = useApiClient();
  const { workspaces: accessible, workspaceUpdated, reload } = useWorkspace();
  const [saved, setSaved] = useState<DailyNoteSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const savingRef = useRef(false);
  const lifetime = useRef<AbortController | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await client.query(workspaces.dailyNoteSettings(workspaceId), {
          signal,
          forceRefresh: true,
        });
        if (isAborted(signal)) return;
        setSaved(response);
      } catch (cause) {
        if (isAborted(signal) || isCanceledError(cause)) return;
        setError('Daily note settings could not be loaded. Check your connection and try again.');
      } finally {
        if (!isAborted(signal)) setLoading(false);
      }
    },
    [client, workspaceId],
  );

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    // Another workspace's settings must not linger on screen while this one loads.
    queueMicrotask(() => {
      if (isAborted(controller.signal)) return;
      setSaved(null);
      setForbidden(false);
      void load(controller.signal);
    });
    return () => {
      controller.abort();
    };
  }, [load]);

  /**
   * The switch is also what `canUseDailyNotes` on the accessible workspace list reports, and the
   * rail, the palette and the daily bar read that flag. The list is loaded once, so a save that
   * flips the switch updates it here. Switching off is known to clear the flag and is applied at
   * once; switching on clears only one of the conditions the server weighs (the caller's role, a
   * personal workspace's owner), so the list is reloaded for the server's answer, which also
   * replaces the optimistic copy.
   */
  function refreshWorkspace(enabled: boolean): void {
    const current = accessible.find((entry) => entry.id === workspaceId);
    if (current !== undefined && !enabled && current.canUseDailyNotes) {
      workspaceUpdated({ ...current, canUseDailyNotes: false });
    }
    reload();
  }

  async function save(value: DailyNoteSettings): Promise<boolean> {
    const controller = lifetime.current;
    if (saved === null || savingRef.current || !controller || isAborted(controller.signal)) {
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const response = await client.execute(workspaces.saveDailyNoteSettings(workspaceId, value), {
        signal: controller.signal,
      });
      if (isAborted(controller.signal)) return false;
      if (response.enabled !== saved.enabled) refreshWorkspace(response.enabled);
      setSaved(response);
      return true;
    } catch (cause) {
      if (isAborted(controller.signal) || isCanceledError(cause)) return false;
      if (isNixApiError(cause) && cause.status === 404) {
        setForbidden(true);
        setError('You do not have permission to change this workspace’s daily notes.');
        return false;
      }
      setError(
        isNixApiError(cause) && cause.status === 422 && cause.detail !== undefined
          ? cause.detail
          : 'The save could not be confirmed. Reload the page before trying again.',
      );
      return false;
    } finally {
      savingRef.current = false;
      if (!isAborted(controller.signal)) setSaving(false);
    }
  }

  return { saved, loading, saving, error, forbidden, save };
}
