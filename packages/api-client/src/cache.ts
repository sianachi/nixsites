/**
 * A deliberately small server-state layer. Three jobs, no framework:
 *
 *   1. Request deduplication. N concurrent identical GETs share one in-flight
 *      promise and therefore one network call. Opening the same document in
 *      two panes must not double Core's load.
 *   2. Stale-while-revalidate. A cached entry is served immediately; if it is
 *      past its staleness budget the caller also gets a `revalidation` promise
 *      for the refresh happening behind it, so a view can honestly render
 *      "showing cached, refreshing" instead of either lying or flashing a
 *      spinner over data it already has.
 *   3. Explicit invalidation. `invalidate` / `invalidatePrefix` / `evict` are
 *      the entry points the server's invalidation channel is wired to in a
 *      later goal: a message marks keys stale and subscribers refetch.
 *
 * Storage is behind `CacheStore`, a five-method synchronous interface with no
 * framework in it. The in-memory implementation here is the default; a Zustand
 * `serverCacheSlice` adapts to the same interface later without this file
 * learning what Zustand is. Change notification lives on the cache rather than
 * the store, so an adapter only has to be a map.
 *
 * Cancellation is refcounted, which is the subtle part. Callers that share a
 * de-duplicated request each hold their own AbortSignal. One view unmounting
 * detaches that caller and rejects its promise with a cancellation error, but
 * the shared request keeps running for everyone else; only when the last
 * interested caller leaves is the underlying request actually aborted.
 */

import { isNixApiError, NixApiError } from './errors.js';
import { report, type NixTelemetry } from './telemetry.js';

export type CacheKey = readonly string[];

/** ASCII unit separator: legal in no key segment we will ever mint. */
const SEPARATOR = '\u001f';

export function cacheKeyToString(key: CacheKey): string {
  return key.join(SEPARATOR);
}

export interface CacheEntry<TData> {
  readonly data: TData;
  /** Clock reading when the entry was written, for staleness arithmetic. */
  readonly storedAt: number;
  /** Set by explicit invalidation, independent of the staleness budget. */
  readonly stale: boolean;
}

/** The storage contract a Zustand slice can implement verbatim. */
interface CacheStore {
  read(key: string): CacheEntry<unknown> | undefined;
  write(key: string, entry: CacheEntry<unknown>): void;
  remove(key: string): void;
  keys(): readonly string[];
  clear(): void;
}

function createMemoryCacheStore(): CacheStore {
  const entries = new Map<string, CacheEntry<unknown>>();
  return {
    read: (key) => entries.get(key),
    write: (key, entry) => {
      entries.set(key, entry);
    },
    remove: (key) => {
      entries.delete(key);
    },
    keys: () => [...entries.keys()],
    clear: () => {
      entries.clear();
    },
  };
}

interface CacheReadOptions {
  readonly signal?: AbortSignal | undefined;
  /** Skip the cached value and go to the network, still de-duplicated. */
  readonly forceRefresh?: boolean | undefined;
  readonly staleAfterMs?: number | undefined;
}

interface CacheReadResult<TData> {
  readonly data: TData;
  readonly servedFromCache: boolean;
  /** Present only when a stale entry was served and a refresh is behind it. */
  readonly revalidation: Promise<void> | null;
}

export type CacheLoader<TData> = (signal: AbortSignal) => Promise<TData>;

export interface ServerCache {
  read<TData>(
    key: CacheKey,
    load: CacheLoader<TData>,
    options?: CacheReadOptions,
  ): Promise<CacheReadResult<TData>>;
  peek<TData>(key: CacheKey): CacheEntry<TData> | undefined;
  /** Marks an entry stale; the next read serves it and refreshes behind it. */
  invalidate(key: CacheKey): void;
  /** Marks every entry whose key starts with `prefix` stale. */
  invalidatePrefix(prefix: CacheKey): void;
  evict(key: CacheKey): void;
  clear(): void;
  subscribe(listener: (key: CacheKey) => void): () => void;
  /** One notification per explicit invalidation, including prefixes without cached entries. */
  subscribeInvalidation(listener: (prefix: CacheKey) => void): () => void;
}

export interface ServerCacheOptions {
  readonly store?: CacheStore | undefined;
  /** Injectable clock so staleness is testable without waiting. */
  readonly now?: (() => number) | undefined;
  /** Default staleness budget. 30 seconds unless a resource says otherwise. */
  readonly staleAfterMs?: number | undefined;
  readonly telemetry?: NixTelemetry | undefined;
}

interface Flight {
  readonly promise: Promise<unknown>;
  readonly controller: AbortController;
  waiters: number;
  state: 'fresh' | 'stale' | 'removed';
}

const DEFAULT_STALE_AFTER_MS = 30_000;

export function createServerCache(options: ServerCacheOptions = {}): ServerCache {
  const store = options.store ?? createMemoryCacheStore();
  const now = options.now ?? Date.now;
  const defaultStaleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const telemetry = options.telemetry;
  const flights = new Map<string, Flight>();
  const listeners = new Set<(key: CacheKey) => void>();
  const invalidationListeners = new Set<(prefix: CacheKey) => void>();

  function invalidateFlights(head: string, state: 'stale' | 'removed', exact = false): void {
    for (const [id, flight] of flights) {
      if (id !== head && (exact || (head !== '' && !id.startsWith(head + SEPARATOR)))) continue;
      if (flight.state !== 'removed') flight.state = state;
    }
  }

  function notifyInvalidation(prefix: CacheKey): void {
    for (const listener of invalidationListeners) listener(prefix);
  }

  function notify(id: string): void {
    const key = id.split(SEPARATOR);
    for (const listener of listeners) listener(key);
  }

  function start<TData>(id: string, load: CacheLoader<TData>): Flight {
    const controller = new AbortController();
    const promise = load(controller.signal).then(
      (data) => {
        if (flights.get(id) === flight) flights.delete(id);
        if (flight.state !== 'removed') {
          store.write(id, { data, storedAt: now(), stale: flight.state === 'stale' });
          notify(id);
        }
        return data;
      },
      (error: unknown) => {
        if (flights.get(id) === flight) {
          flights.delete(id);
          if (
            flight.state !== 'removed' &&
            isNixApiError(error) &&
            (error.status === 403 || error.status === 404 || error.status === 423) &&
            store.read(id) !== undefined
          ) {
            store.remove(id);
            notify(id);
          }
        }
        throw error;
      },
    );
    // The shared promise outlives individual callers; keep an abandoned
    // rejection from surfacing as an unhandled rejection.
    promise.catch(() => undefined);
    const flight: Flight = { promise, controller, waiters: 0, state: 'fresh' };
    flights.set(id, flight);
    return flight;
  }

  function release(id: string, flight: Flight): void {
    flight.waiters -= 1;
    if (flight.waiters > 0) return;
    if (flights.get(id) === flight) flights.delete(id);
    flight.state = 'removed';
    flight.controller.abort();
  }

  function share<TData>(
    id: string,
    load: CacheLoader<TData>,
    signal: AbortSignal | undefined,
  ): Promise<TData> {
    const existing = flights.get(id);
    // A post-write read must not join the response that began before that write.
    if (existing !== undefined && existing.state !== 'fresh') existing.state = 'removed';
    const flight = existing?.state === 'fresh' ? existing : start(id, load);
    flight.waiters += 1;
    const shared = flight.promise as Promise<TData>;
    if (signal === undefined) return shared;
    if (signal.aborted) {
      release(id, flight);
      return Promise.reject(NixApiError.canceled());
    }
    return new Promise<TData>((resolve, reject) => {
      // `detached` makes this caller's departure idempotent: it leaves the
      // flight exactly once, whether by cancellation or by settlement.
      let detached = false;
      const detach = (): boolean => {
        if (detached) return false;
        detached = true;
        signal.removeEventListener('abort', onAbort);
        return true;
      };
      function onAbort(): void {
        if (!detach()) return;
        release(id, flight);
        reject(NixApiError.canceled());
      }
      signal.addEventListener('abort', onAbort, { once: true });
      shared.then(
        (data) => {
          if (!detach()) return;
          flight.waiters -= 1;
          resolve(data);
        },
        (error: unknown) => {
          if (!detach()) return;
          flight.waiters -= 1;
          reject(error instanceof Error ? error : NixApiError.network(error));
        },
      );
    });
  }

  function revalidate<TData>(id: string, key: CacheKey, load: CacheLoader<TData>): Promise<void> {
    return share(id, load, undefined).then(
      () => undefined,
      (error: unknown) => {
        // Temporary failures retain cached data; refusals remove it in start.
        report(telemetry?.onCacheRevalidateError, { key, error });
      },
    );
  }

  return {
    async read<TData>(
      key: CacheKey,
      load: CacheLoader<TData>,
      readOptions: CacheReadOptions = {},
    ): Promise<CacheReadResult<TData>> {
      const id = cacheKeyToString(key);
      const entry = store.read(id) as CacheEntry<TData> | undefined;
      const staleAfterMs = readOptions.staleAfterMs ?? defaultStaleAfterMs;

      if (entry !== undefined && readOptions.forceRefresh !== true) {
        const expired = entry.stale || now() - entry.storedAt >= staleAfterMs;
        return {
          data: entry.data,
          servedFromCache: true,
          revalidation: expired ? revalidate(id, key, load) : null,
        };
      }

      return {
        data: await share(id, load, readOptions.signal),
        servedFromCache: false,
        revalidation: null,
      };
    },

    peek<TData>(key: CacheKey): CacheEntry<TData> | undefined {
      // Values were parsed once at the boundary; the cache does not re-parse.
      return store.read(cacheKeyToString(key)) as CacheEntry<TData> | undefined;
    },

    invalidate(key: CacheKey): void {
      const id = cacheKeyToString(key);
      invalidateFlights(id, 'stale', true);
      const entry = store.read(id);
      if (entry !== undefined) {
        store.write(id, { ...entry, stale: true });
        notify(id);
      }
      notifyInvalidation(key);
    },

    invalidatePrefix(prefix: CacheKey): void {
      const head = cacheKeyToString(prefix);
      invalidateFlights(head, 'stale');
      for (const id of store.keys()) {
        if (head !== '' && id !== head && !id.startsWith(head + SEPARATOR)) continue;
        const entry = store.read(id);
        if (entry === undefined) continue;
        store.write(id, { ...entry, stale: true });
        notify(id);
      }
      notifyInvalidation(prefix);
    },

    evict(key: CacheKey): void {
      const id = cacheKeyToString(key);
      invalidateFlights(id, 'removed', true);
      store.remove(id);
      notify(id);
      notifyInvalidation(key);
    },

    clear(): void {
      const ids = store.keys();
      invalidateFlights('', 'removed');
      store.clear();
      for (const id of ids) notify(id);
      notifyInvalidation([]);
    },

    subscribe(listener: (key: CacheKey) => void): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },

    subscribeInvalidation(listener: (prefix: CacheKey) => void): () => void {
      invalidationListeners.add(listener);
      return (): void => {
        invalidationListeners.delete(listener);
      };
    },
  };
}
