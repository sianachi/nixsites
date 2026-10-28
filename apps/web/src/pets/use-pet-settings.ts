import {
  isCanceledError,
  isNixApiError,
  pets,
  type PetConnection,
  type PetSettings,
  type PetSettingsResponse,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiClient } from '../api/api-client-provider';
import { isAborted } from '../lib/guards';

interface PetSettingsState {
  readonly saved: PetSettingsResponse | null;
  readonly connection: PetConnection | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly save: (settings: PetSettings) => Promise<boolean>;
  readonly reload: () => void;
}

// Cancellation can change while a request is awaiting I/O.
export function usePetSettings(): PetSettingsState {
  const client = useApiClient();
  const [saved, setSaved] = useState<PetSettingsResponse | null>(null);
  const [connection, setConnection] = useState<PetConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const savingRef = useRef(false);
  const lifetime = useRef<AbortController | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const settings = await client.query(pets.settings(), { signal, forceRefresh: true });
        if (signal.aborted) return;
        setSaved((current) =>
          current === null || settings.revision >= current.revision ? settings : current,
        );
        setConnection(null);
      } catch (cause) {
        if (signal.aborted || isCanceledError(cause)) return;
        setError('Pet settings could not be loaded. Check your connection and try again.');
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const changed = () => {
      if (!controller.signal.aborted) void load(controller.signal);
    };
    window.addEventListener('nix-pet-settings-changed', changed);
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load(controller.signal);
    });
    return () => {
      controller.abort();
      window.removeEventListener('nix-pet-settings-changed', changed);
    };
  }, [load]);

  async function save(settings: PetSettings): Promise<boolean> {
    const controller = lifetime.current;
    if (saved === null || savingRef.current || !controller || isAborted(controller.signal))
      return false;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const response = await client.execute(pets.saveSettings(saved.revision, settings), {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return false;
      setSaved(response);
      window.dispatchEvent(new Event('nix-pet-settings-changed'));
      return true;
    } catch (cause) {
      if (controller.signal.aborted || isCanceledError(cause)) return false;
      setError(
        isNixApiError(cause) && cause.status === 409
          ? 'Your pets changed on another device. Reload saved settings before saving again.'
          : 'The save could not be confirmed. Reload saved settings before trying again.',
      );
      return false;
    } finally {
      savingRef.current = false;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return {
    saved,
    connection,
    error,
    loading,
    saving,
    save,
    reload: () => {
      if (lifetime.current && !lifetime.current.signal.aborted) void load(lifetime.current.signal);
    },
  };
}
