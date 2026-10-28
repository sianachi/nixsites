import { publishNotice } from '@nix/web-foundation/lib/notices';
import { flushPendingWork } from '@nix/web-foundation/lib/pending-work';

let registration: ServiceWorkerRegistration | undefined;
const listeners = new Set<() => void>();
export function getWaitingWorker(): ServiceWorker | null {
  return registration?.waiting ?? null;
}
/** The current registration, once `registerServiceWorker` has resolved one - what push
 * subscribe/unsubscribe operate on rather than each re-deriving their own `navigator.serviceWorker`
 * lookup. */
export function getServiceWorkerRegistration(): ServiceWorkerRegistration | undefined {
  return registration;
}
export function subscribeToWorker(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function changed(): void {
  for (const listener of listeners) listener();
}

/** Register without forcing an update into an editor that may have unsynced work. */
export function registerServiceWorker(): () => void {
  if (!('serviceWorker' in navigator)) return () => undefined;
  let disposed = false;
  let cleanupRegistration = (): void => undefined;
  const register = (): void => {
    void navigator.serviceWorker
      .register('/service-worker.js')
      .then((value) => {
        if (disposed) return;
        registration = value;
        changed();
        const found = (): void => {
          const worker = value.installing;
          worker?.addEventListener('statechange', changed);
        };
        value.addEventListener('updatefound', found);
        const check = (): void => {
          if (document.visibilityState === 'visible' && navigator.onLine)
            void value.update().catch(() => undefined);
        };
        document.addEventListener('visibilitychange', check);
        // The installed shell keeps serving its own build until the person accepts an update, so a
        // chunk it never cached may be gone from a newer deploy. That failure is the clearest sign
        // one exists: look for it now, and the update prompt appears instead of a dead feature.
        const stale = (): void => {
          void value.update().catch(() => undefined);
          // The part that failed to load stays failed until the page runs the newer build, so
          // say so and offer the one fix, rather than leaving a dead screen to explain itself.
          publishNotice({
            key: 'build-updated',
            message: 'Nix has been updated. Reload to open this.',
            action: {
              label: 'Reload',
              onAction: () => {
                void flushPendingWork()
                  .catch(() => undefined)
                  .then(() => {
                    globalThis.location.reload();
                  });
              },
            },
          });
        };
        window.addEventListener('vite:preloadError', stale);
        cleanupRegistration = () => {
          value.removeEventListener('updatefound', found);
          document.removeEventListener('visibilitychange', check);
          window.removeEventListener('vite:preloadError', stale);
        };
      })
      .catch((error: unknown) => {
        console.warn('The Nix app installer could not be registered.', error);
      });
  };
  if (document.readyState === 'complete') register();
  else globalThis.addEventListener('load', register, { once: true });
  return () => {
    disposed = true;
    cleanupRegistration();
    globalThis.removeEventListener('load', register);
  };
}
