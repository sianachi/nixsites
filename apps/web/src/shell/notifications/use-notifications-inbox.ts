import {
  isCanceledError,
  notifications,
  type NotificationDto,
  type NotificationsPageResponse,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiClient } from '../../api/api-client-provider';
import { isAborted } from '@nix/web-foundation/lib/guards';

/** Never poll more often than this, even when the server answers `watch` instantly. */
const MIN_POLL_GAP_MS = 250;
/** Backoff ladder for a failed or throttled (429) watch, per ADR-0051 section 5. */
const BACKOFF_STEPS_MS = [1000, 2000, 4000, 10_000];

// Cancellation and disposal can change while a request is awaiting I/O; reading them through a
// function keeps TypeScript from narrowing the flag to a stale literal across the `await`.
function isDisposed(lifecycle: { disposed: boolean }): boolean {
  return lifecycle.disposed;
}

export interface NotificationsInboxState {
  readonly items: readonly NotificationDto[];
  readonly unread: number;
  readonly loading: boolean;
  readonly error: string | null;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loadMore: () => void;
  readonly markRead: (id: string) => void;
  readonly markAllRead: () => void;
  readonly reload: () => void;
  /** Registers a listener called with newly-arrived notifications (never ones merely re-read as
   * read elsewhere). Returns the unsubscribe function. */
  readonly onArrived: (listener: (arrived: readonly NotificationDto[]) => void) => () => void;
}

/**
 * Backs both the bell's unread badge and the inbox panel: one initial list read, then a
 * `notifications.watch` long-poll kept alive at `after = ` the last known revision, paced at least
 * `MIN_POLL_GAP_MS` apart, backed off on any error or a 429, and paused while the tab is hidden -
 * a background tab holding one of the two concurrent watch slots a principal is allowed is a watch
 * some other, visible tab needs.
 */
export function useNotificationsInbox(): NotificationsInboxState {
  const client = useApiClient();
  const [items, setItems] = useState<readonly NotificationDto[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const revisionRef = useRef(0);
  const lifetime = useRef<AbortController | null>(null);
  const listeners = useRef(new Set<(arrived: readonly NotificationDto[]) => void>());

  const mergeArrivals = useCallback((page: NotificationsPageResponse): void => {
    revisionRef.current = page.revision;
    setUnread(page.unread);
    if (page.items.length === 0) return;
    setItems((current) => {
      const knownIds = new Set(current.map((entry) => entry.id));
      const arrivals = page.items.filter((entry) => !knownIds.has(entry.id));
      const byId = new Map(page.items.map((entry) => [entry.id, entry]));
      const reconciled = current.map((entry) => byId.get(entry.id) ?? entry);
      if (arrivals.length === 0) return reconciled;
      for (const listener of listeners.current) listener(arrivals);
      return [...arrivals, ...reconciled];
    });
  }, []);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const page = await client.query(notifications.list(), { signal, forceRefresh: true });
        if (isAborted(signal)) return;
        setItems(page.items);
        setUnread(page.unread);
        setNextCursor(page.nextCursor);
        revisionRef.current = page.revision;
      } catch (cause) {
        if (isAborted(signal) || isCanceledError(cause)) return;
        setError('The inbox could not be loaded. Check your connection and try again.');
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

  useEffect(() => {
    const lifecycle = { disposed: false };
    let inFlight: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backoffIndex = -1;

    const scheduleNext = (delayMs: number): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        void tick();
      }, delayMs);
    };

    const tick = async (): Promise<void> => {
      if (lifecycle.disposed) return;
      if (document.visibilityState === 'hidden') {
        scheduleNext(1000);
        return;
      }
      const controller = new AbortController();
      inFlight = controller;
      const started = Date.now();
      try {
        const page = await client.query(notifications.watch({ after: revisionRef.current }), {
          signal: controller.signal,
          forceRefresh: true,
        });
        if (isDisposed(lifecycle)) return;
        backoffIndex = -1;
        mergeArrivals(page);
        scheduleNext(Math.max(MIN_POLL_GAP_MS - (Date.now() - started), MIN_POLL_GAP_MS));
      } catch (cause) {
        if (isDisposed(lifecycle) || isCanceledError(cause)) return;
        backoffIndex = Math.min(backoffIndex + 1, BACKOFF_STEPS_MS.length - 1);
        scheduleNext(BACKOFF_STEPS_MS[backoffIndex] ?? 10_000);
      } finally {
        inFlight = null;
      }
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible' && timer === null && inFlight === null) {
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    scheduleNext(MIN_POLL_GAP_MS);

    return () => {
      lifecycle.disposed = true;
      if (timer !== null) clearTimeout(timer);
      inFlight?.abort();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [client, mergeArrivals]);

  function markRead(id: string): void {
    const wasUnread = items.some((entry) => entry.id === id && entry.readAt === null);
    if (wasUnread) {
      setItems((current) =>
        current.map((entry) =>
          entry.id === id && entry.readAt === null
            ? { ...entry, readAt: new Date().toISOString() }
            : entry,
        ),
      );
      setUnread((current) => Math.max(0, current - 1));
    }
    const controller = lifetime.current;
    client
      .execute(notifications.markRead(id), controller ? { signal: controller.signal } : undefined)
      .then((response) => {
        setUnread(response.unread);
      })
      .catch((cause: unknown) => {
        // Not fatal to the panel - the next watch tick reconciles the true state.
        if (!isCanceledError(cause)) return;
      });
  }

  function markAllRead(): void {
    setItems((current) =>
      current.map((entry) =>
        entry.readAt === null ? { ...entry, readAt: new Date().toISOString() } : entry,
      ),
    );
    setUnread(0);
    const controller = lifetime.current;
    client
      .execute(notifications.markAllRead(), controller ? { signal: controller.signal } : undefined)
      .then((response) => {
        setUnread(response.unread);
      })
      .catch((cause: unknown) => {
        if (!isCanceledError(cause)) return;
      });
  }

  function loadMore(): void {
    const controller = lifetime.current;
    if (nextCursor === null || loadingMore || !controller || controller.signal.aborted) return;
    setLoadingMore(true);
    client
      .query(notifications.list({ cursor: nextCursor }), {
        signal: controller.signal,
        forceRefresh: true,
      })
      .then((page) => {
        setItems((current) => [...current, ...page.items]);
        setNextCursor(page.nextCursor);
        setUnread(page.unread);
      })
      .catch((cause: unknown) => {
        if (isCanceledError(cause)) return;
        setError('More notifications could not be loaded.');
      })
      .finally(() => {
        setLoadingMore(false);
      });
  }

  return {
    items,
    unread,
    loading,
    error,
    hasMore: nextCursor !== null,
    loadingMore,
    loadMore,
    markRead,
    markAllRead,
    reload: () => {
      if (lifetime.current && !lifetime.current.signal.aborted) void load(lifetime.current.signal);
    },
    onArrived: (listener) => {
      listeners.current.add(listener);
      return () => {
        listeners.current.delete(listener);
      };
    },
  };
}
