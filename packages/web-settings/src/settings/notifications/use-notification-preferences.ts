import {
  isCanceledError,
  isNixApiError,
  notifications,
  type PreferencesInput,
  type PrincipalPreferencesResponse,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { isAborted } from '@nix/web-foundation/lib/guards';

export interface NotificationPreferencesState {
  readonly saved: PrincipalPreferencesResponse | null;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly save: (value: PreferencesInput) => Promise<boolean>;
  readonly reload: () => void;
}

// Cancellation can change while a request is awaiting I/O.
/**
 * Loads and saves the caller's own reminder and notification preferences, following the
 * compare-and-set pattern `pets/use-pet-settings.ts` established for personal, revisioned
 * settings: a request in flight is tracked on a ref rather than state, and a 409 means the
 * document changed elsewhere and the saved copy is reloaded rather than silently overwritten.
 */
export function useNotificationPreferences(): NotificationPreferencesState {
  const client = useApiClient();
  const [saved, setSaved] = useState<PrincipalPreferencesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const lifetime = useRef<AbortController | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await client.query(notifications.preferences(), {
          signal,
          forceRefresh: true,
        });
        if (isAborted(signal)) return;
        setSaved(response);
      } catch (cause) {
        if (isAborted(signal) || isCanceledError(cause)) return;
        setError('Notification settings could not be loaded. Check your connection and try again.');
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
    return () => {
      controller.abort();
    };
  }, [load]);

  async function save(value: PreferencesInput): Promise<boolean> {
    const controller = lifetime.current;
    if (saved === null || savingRef.current || !controller || isAborted(controller.signal)) {
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const response = await client.execute(notifications.savePreferences(saved.revision, value), {
        signal: controller.signal,
      });
      if (isAborted(controller.signal)) return false;
      setSaved(response);
      return true;
    } catch (cause) {
      if (isAborted(controller.signal) || isCanceledError(cause)) return false;
      if (isNixApiError(cause) && cause.status === 409) {
        // Reload the fresh document directly rather than through `load` above: that helper clears
        // `error` as its first step, which would wipe the very conflict message this branch exists
        // to show the instant the fresh read lands.
        setError(
          'Your notification settings changed on another device. Reloading the saved settings.',
        );
        try {
          const fresh = await client.query(notifications.preferences(), {
            signal: controller.signal,
            forceRefresh: true,
          });
          if (!isAborted(controller.signal)) setSaved(fresh);
        } catch {
          // Keep the conflict message on screen if even the reload fails.
        }
        return false;
      }
      setError(
        isNixApiError(cause) && cause.detail !== undefined
          ? cause.detail
          : 'The save could not be confirmed. Reload saved settings before trying again.',
      );
      return false;
    } finally {
      savingRef.current = false;
      if (!isAborted(controller.signal)) setSaving(false);
    }
  }

  return {
    saved,
    loading,
    saving,
    error,
    save,
    reload: () => {
      if (lifetime.current && !isAborted(lifetime.current.signal))
        void load(lifetime.current.signal);
    },
  };
}
