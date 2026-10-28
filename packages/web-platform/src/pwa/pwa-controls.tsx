import { Button, Text } from '@nix/ui';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushPendingWork } from '@nix/web-foundation/lib/pending-work';
import { getWaitingWorker, subscribeToWorker } from './register-service-worker';

export function PwaControls(): ReactNode {
  const waiting = useSyncExternalStore(subscribeToWorker, getWaitingWorker, () => null);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const online = (): void => {
      setOffline(false);
    };
    const offlineNow = (): void => {
      setOffline(true);
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offlineNow);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offlineNow);
    };
  }, []);
  useEffect(() => {
    const updateTheme = (): void => {
      const app = document.querySelector('#root > div');
      const meta = document.querySelector('meta[name="theme-color"]');
      if (app && meta) meta.setAttribute('content', getComputedStyle(app).backgroundColor);
    };
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', updateTheme);
    updateTheme();
    return () => {
      observer.disconnect();
      media.removeEventListener('change', updateTheme);
    };
  }, []);
  async function update(): Promise<void> {
    if (!waiting || updating) return;
    setUpdating(true);
    setError(null);
    try {
      await flushPendingWork();
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => {
          window.location.reload();
        },
        { once: true },
      );
      waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
    } catch {
      setError('Finish syncing your edits before updating. Your current app is still open.');
      setUpdating(false);
    }
  }
  if (!offline && !waiting) return null;
  return (
    <aside
      aria-label="App status"
      className="flex min-h-(--control-lg) shrink-0 flex-wrap items-center justify-between gap-x-2 border-t border-divider bg-background px-3"
    >
      {offline ? (
        <Text variant="caption" role="status">
          Offline. Open notes saved on this device. Changes sync when you reconnect.
        </Text>
      ) : (
        <Text variant="caption" tone="muted">
          An update is ready.
        </Text>
      )}
      {waiting ? (
        <Button
          variant="ghost"
          disabled={updating || offline}
          onClick={() => {
            void update();
          }}
        >
          {updating ? 'Preparing update…' : 'Update Nix'}
        </Button>
      ) : null}
      {error ? (
        <Text variant="caption" role="alert">
          {error}
        </Text>
      ) : null}
    </aside>
  );
}
