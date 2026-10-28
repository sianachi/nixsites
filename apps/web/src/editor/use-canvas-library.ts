import { canvasLibrary, isCanceledError } from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';

/**
 * A principal's own set of reusable native canvas shapes, from `GET`/`PUT /api/v1/me/canvas-library`.
 *
 * **Per user, not per item or per workspace.** The library is a personal drawing tool - the shapes
 * somebody has curated follow them into every canvas they open, the same
 * way a physical stencil is not left behind in one notebook. That is why this hook takes no
 * `itemId`: it asks Core for the caller's own library, the same request wherever a canvas mounts.
 *
 * **`items` is a seed, not live state.** It changes exactly once, when the mount-time read
 * resolves, and `save` deliberately does not mirror what it was handed back into it. The editor
 * owns the live library; mirroring it here gave every save a state change, and a state change
 * re-armed the editor's seeding effect, whose `updateLibrary` echoed back through
 * `onLibraryChange` into another save - a feedback loop that hammered Core with identical PUTs
 * and hung the tab.
 *
 * Uses the configured `NixClient` so the personal library shares the application's authentication,
 * cancellation, error mapping and response parsing path.
 */
export type CanvasLibraryStatus = 'loading' | 'ready' | 'error';

export interface CanvasLibraryState {
  readonly status: CanvasLibraryStatus;
  /** What Core held at mount. Empty while loading or on a failed read. */
  readonly items: readonly unknown[];
  /** Replaces the library wholesale with the complete native library contents. */
  readonly save: (items: readonly unknown[]) => void;
}

const NONE: readonly unknown[] = [];

interface PendingCanvasLibrarySave {
  readonly body: string;
  readonly items: readonly unknown[];
}

export function useCanvasLibrary(): CanvasLibraryState {
  const client = useApiClient();
  const [status, setStatus] = useState<CanvasLibraryStatus>('loading');
  const [items, setItems] = useState<readonly unknown[]>(NONE);

  // Guards saves until the mount-time read lands: the editor can announce its initial library with
  // whatever it booted with, and saving that before the fetch resolves would overwrite a library
  // that has not been read yet with an empty one. Stays false forever when the read fails, which
  // makes saving impossible for the mount - overwriting state we could not read is worse than
  // dropping one session's additions.
  const loadedRef = useRef(false);

  // The request body Core is known to hold, or null when that is unknown (before the read, or
  // after a failed save). A save whose body matches is dropped without a request - which is what
  // breaks the echo: initial library setup can re-announce the seeded library,
  // and without this comparison that announcement was a PUT of content Core already had, forever.
  const knownRef = useRef<string | null>(null);
  const pendingSaveRef = useRef<PendingCanvasLibrarySave | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const live = { current: true };

    void (async () => {
      try {
        const parsed = await client.query(canvasLibrary.canvasLibrary(), {
          signal: controller.signal,
        });
        if (!live.current) {
          return;
        }

        loadedRef.current = true;
        knownRef.current = JSON.stringify({ items: parsed.items });
        setItems(parsed.items);
        setStatus('ready');
      } catch (cause) {
        if (controller.signal.aborted || !live.current || isCanceledError(cause)) {
          return;
        }

        console.warn('The canvas library read failed.', cause);
        setStatus('error');
      }
    })();

    return () => {
      live.current = false;
      controller.abort();
    };
  }, [client]);

  const flushSaves = useCallback((): void => {
    if (savingRef.current) return;
    savingRef.current = true;

    void (async () => {
      try {
        while (pendingSaveRef.current !== null) {
          const pending = pendingSaveRef.current;
          pendingSaveRef.current = null;
          if (pending.body === knownRef.current) continue;

          try {
            await client.execute(canvasLibrary.saveCanvasLibrary(pending.items));
            // A body becomes known only once Core confirms it. Serial execution means an older
            // request can never finish after and overwrite a newer library.
            knownRef.current = pending.body;
          } catch (cause) {
            knownRef.current = null;
            console.warn('The canvas library save failed.', cause);
          }
        }
      } finally {
        savingRef.current = false;
      }
    })();
  }, [client]);

  const save = useCallback(
    (nextItems: readonly unknown[]) => {
      if (!loadedRef.current) return;

      const body = JSON.stringify({ items: nextItems });
      if (!savingRef.current && pendingSaveRef.current === null && body === knownRef.current) {
        return;
      }

      // Keep only the newest desired whole-library state while a request is running. The clone
      // prevents subsequent editor mutation from changing the queued payload behind its hash.
      pendingSaveRef.current = { body, items: structuredClone(nextItems) };
      flushSaves();
    },
    [flushSaves],
  );

  return { status, items, save };
}
