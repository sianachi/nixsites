import { describe, expect, it, vi } from 'vitest';
import { createServerCache, type CacheLoader, type ServerCache } from './cache.js';
import { NixApiError, NixErrorKind } from './errors.js';
import { captureFailure } from './testing/failure.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A cache with a hand-cranked clock so staleness needs no real waiting. */
function cacheWithClock(staleAfterMs = 1_000): {
  cache: ServerCache;
  advance: (ms: number) => void;
} {
  let clock = 0;
  const cache = createServerCache({ now: () => clock, staleAfterMs });
  return {
    cache,
    advance: (ms: number): void => {
      clock += ms;
    },
  };
}

describe('request deduplication', () => {
  it('shares one in-flight load between concurrent readers of the same key', async () => {
    const cache = createServerCache();
    const gate = deferred<string>();
    const load = vi.fn<CacheLoader<string>>(() => gate.promise);

    const readers = [1, 2, 3, 4].map(() => cache.read(['items', 'a'], load));
    gate.resolve('loaded once');
    const results = await Promise.all(readers);

    expect(load).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.data)).toEqual([
      'loaded once',
      'loaded once',
      'loaded once',
      'loaded once',
    ]);
  });

  it('does not share loads across different keys', async () => {
    const cache = createServerCache();
    const load = vi.fn<CacheLoader<string>>(() => Promise.resolve('value'));

    await Promise.all([cache.read(['items', 'a'], load), cache.read(['items', 'b'], load)]);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('starts a new load once the shared one has settled', async () => {
    const cache = createServerCache({ staleAfterMs: 0 });
    const load = vi.fn<CacheLoader<string>>(() => Promise.resolve('value'));

    await cache.read(['items', 'a'], load);
    const second = await cache.read(['items', 'a'], load, { forceRefresh: true });

    expect(load).toHaveBeenCalledTimes(2);
    expect(second.data).toBe('value');
  });
});

describe('reads that are not retained', () => {
  it('keeps none of many distinct keys, and still shares one load between overlapping callers', async () => {
    const cache = createServerCache();
    for (let term = 0; term < 500; term++)
      await cache.read(['search', String(term)], () => Promise.resolve(term), { retain: false });
    for (let term = 0; term < 500; term++)
      expect(cache.peek(['search', String(term)])).toBeUndefined();

    const pending = deferred<string>();
    const load = vi.fn<CacheLoader<string>>(() => pending.promise);
    const first = cache.read(['search', 'same'], load, { retain: false });
    const second = cache.read(['search', 'same'], load, { retain: false });
    pending.resolve('hits');
    expect((await first).data).toBe('hits');
    expect((await second).data).toBe('hits');
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.peek(['search', 'same'])).toBeUndefined();

    await cache.read(['search', 'same'], load, { retain: false });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('cancels the request when its only caller leaves', async () => {
    const cache = createServerCache();
    const controller = new AbortController();
    let aborted = false;
    const reading = cache.read(
      ['watch', '7'],
      (signal) =>
        new Promise<never>(() => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
      { retain: false, signal: controller.signal },
    );
    controller.abort();
    await expect(reading).rejects.toMatchObject({ kind: NixErrorKind.Canceled });
    expect(aborted).toBe(true);
  });
});

describe('stale while revalidate', () => {
  it('serves a fresh cached value without going back to the loader', async () => {
    const { cache, advance } = cacheWithClock(1_000);
    const load = vi.fn<CacheLoader<number>>(() => Promise.resolve(1));

    await cache.read(['items'], load);
    advance(500);
    const result = await cache.read(['items'], load);

    expect(load).toHaveBeenCalledTimes(1);
    expect(result.servedFromCache).toBe(true);
    expect(result.revalidation).toBeNull();
  });

  it('serves the stale value immediately and refreshes it behind the caller', async () => {
    const { cache, advance } = cacheWithClock(1_000);
    let version = 1;
    const load = vi.fn<CacheLoader<number>>(() => Promise.resolve(version));

    await cache.read(['items'], load);
    advance(1_500);
    version = 2;
    const result = await cache.read(['items'], load);

    expect(result.data).toBe(1);
    expect(result.servedFromCache).toBe(true);
    expect(result.revalidation).not.toBeNull();

    await result.revalidation;

    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.peek<number>(['items'])?.data).toBe(2);
  });

  it('keeps serving the cached value and reports a failed background refresh as telemetry', async () => {
    let clock = 0;
    const onCacheRevalidateError = vi.fn();
    const cache = createServerCache({
      now: () => clock,
      staleAfterMs: 1_000,
      telemetry: { onCacheRevalidateError },
    });
    let attempt = 0;
    const load: CacheLoader<string> = () => {
      attempt += 1;
      return attempt === 1 ? Promise.resolve('cached') : Promise.reject(new Error('core is down'));
    };

    await cache.read(['items'], load);
    clock = 5_000;
    const result = await cache.read(['items'], load);
    await result.revalidation;

    expect(result.data).toBe('cached');
    expect(onCacheRevalidateError).toHaveBeenCalledTimes(1);
    expect(cache.peek<string>(['items'])?.data).toBe('cached');
  });
});

describe('refused refreshes', () => {
  it.each([403, 404, 423])('discards cached data after a current %i response', async (status) => {
    const cache = createServerCache();
    await cache.read(['items', 'a'], () => Promise.resolve('previously visible'));
    await cache.read(['items', 'b'], () => Promise.resolve('still visible'));
    const changed = vi.fn();
    const invalidated = vi.fn();
    cache.subscribe(changed);
    cache.subscribeInvalidation(invalidated);
    const refusal = NixApiError.fromStatus(status);
    const load = vi.fn<CacheLoader<string>>(() => Promise.reject(refusal));

    expect(await captureFailure(cache.read(['items', 'a'], load, { forceRefresh: true }))).toBe(
      refusal,
    );

    expect(cache.peek(['items', 'a'])).toBeUndefined();
    expect(cache.peek(['items', 'b'])?.data).toBe('still visible');
    expect(changed.mock.calls).toEqual([[['items', 'a']]]);
    expect(invalidated).not.toHaveBeenCalled();
    expect(await captureFailure(cache.read(['items', 'a'], load))).toBe(refusal);
    expect(load).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404, 423])(
    'discards cached data when background revalidation receives a %i problem',
    async (status) => {
      const onCacheRevalidateError = vi.fn();
      const cache = createServerCache({
        staleAfterMs: 0,
        telemetry: { onCacheRevalidateError },
      });
      await cache.read(['items', 'a'], () => Promise.resolve('previously visible'));
      const changed = vi.fn();
      const invalidated = vi.fn();
      cache.subscribe(changed);
      cache.subscribeInvalidation(invalidated);
      const refusal = NixApiError.fromProblemDetails(status, { code: 'items.refused', status });
      const stale = await cache.read(['items', 'a'], () => Promise.reject(refusal));
      await stale.revalidation;

      expect(stale.servedFromCache).toBe(true);
      expect(cache.peek(['items', 'a'])).toBeUndefined();
      expect(changed.mock.calls).toEqual([[['items', 'a']]]);
      expect(invalidated).not.toHaveBeenCalled();
      expect(onCacheRevalidateError.mock.calls).toEqual([
        [{ key: ['items', 'a'], error: refusal }],
      ]);
    },
  );

  it('retains cached data after a temporary server failure', async () => {
    const cache = createServerCache();
    await cache.read(['items', 'a'], () => Promise.resolve('available offline'));
    const changed = vi.fn();
    const invalidated = vi.fn();
    cache.subscribe(changed);
    cache.subscribeInvalidation(invalidated);
    const unavailable = NixApiError.fromStatus(503);
    const load = vi.fn<CacheLoader<string>>(() => Promise.reject(unavailable));

    expect(await captureFailure(cache.read(['items', 'a'], load, { forceRefresh: true }))).toBe(
      unavailable,
    );
    const remounted = await cache.read(['items', 'a'], load);

    expect(remounted.data).toBe('available offline');
    expect(remounted.servedFromCache).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
    expect(invalidated).not.toHaveBeenCalled();
  });

  it.each([403, 404, 423])(
    'keeps newer cached data when an older request returns %i',
    async (status) => {
      const cache = createServerCache();
      await cache.read(['items', 'a'], () => Promise.resolve('original'));
      const gate = deferred<string>();
      const original = captureFailure(
        cache.read(['items', 'a'], () => gate.promise, { forceRefresh: true }),
      );
      cache.invalidate(['items', 'a']);
      await cache.read(['items', 'a'], () => Promise.resolve('latest'), { forceRefresh: true });
      const changed = vi.fn();
      const invalidated = vi.fn();
      cache.subscribe(changed);
      cache.subscribeInvalidation(invalidated);
      const refusal = NixApiError.fromStatus(status);
      gate.reject(refusal);

      expect(await original).toBe(refusal);
      const load = vi.fn<CacheLoader<string>>(() => Promise.resolve('unexpected reload'));
      const remounted = await cache.read(['items', 'a'], load);

      expect(remounted.data).toBe('latest');
      expect(remounted.servedFromCache).toBe(true);
      expect(cache.peek(['items', 'a'])).toMatchObject({ data: 'latest', stale: false });
      expect(load).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      expect(invalidated).not.toHaveBeenCalled();
    },
  );
});

describe('invalidation', () => {
  it('notifies uncached scopes once and ignores ordinary reads on the invalidation channel', async () => {
    const cache = createServerCache();
    const seen: string[][] = [];
    const unsubscribe = cache.subscribeInvalidation((prefix) => seen.push([...prefix]));

    cache.invalidate(['items', 'uncached']);
    cache.invalidatePrefix(['workspaces', 'new', 'items']);
    cache.evict(['files', 'uncached']);
    cache.clear();
    await cache.read(['items', 'a'], () => Promise.resolve('value'));
    unsubscribe();
    cache.invalidate(['items', 'a']);

    expect(seen).toEqual([
      ['items', 'uncached'],
      ['workspaces', 'new', 'items'],
      ['files', 'uncached'],
      [],
    ]);
  });

  it('notifies a prefix once even when several cached entries match', async () => {
    const cache = createServerCache();
    const seen: string[][] = [];
    cache.subscribeInvalidation((prefix) => seen.push([...prefix]));
    await cache.read(['items', 'a'], () => Promise.resolve('a'));
    await cache.read(['items', 'b'], () => Promise.resolve('b'));
    cache.invalidatePrefix(['items']);

    expect(seen).toEqual([['items']]);
    expect(cache.peek(['items', 'a'])?.stale).toBe(true);
    expect(cache.peek(['items', 'b'])?.stale).toBe(true);
  });

  it.each(['key', 'prefix'] as const)(
    'keeps a response stale when its %s was invalidated while loading',
    async (scope) => {
      const cache = createServerCache({ staleAfterMs: 60_000 });
      const gate = deferred<string>();
      const pending = cache.read(['items', 'a'], () => gate.promise);
      if (scope === 'key') cache.invalidate(['items', 'a']);
      else cache.invalidatePrefix(['items']);
      gate.resolve('before write');

      expect((await pending).data).toBe('before write');
      expect(cache.peek(['items', 'a'])?.stale).toBe(true);
      const refreshed = await cache.read(['items', 'a'], () => Promise.resolve('after write'));
      await refreshed.revalidation;
      expect(cache.peek(['items', 'a'])).toMatchObject({ data: 'after write', stale: false });
    },
  );

  it('starts a post-write read immediately and prevents the old response overwriting it', async () => {
    const cache = createServerCache({ staleAfterMs: 60_000 });
    const oldGate = deferred<string>();
    const newGate = deferred<string>();
    const load = vi
      .fn<CacheLoader<string>>()
      .mockImplementationOnce(() => oldGate.promise)
      .mockImplementationOnce(() => newGate.promise);
    const original = cache.read(['items', 'a'], load);
    cache.invalidatePrefix(['items']);
    const refreshed = cache.read(['items', 'a'], load, { forceRefresh: true });
    const sharedRefresh = cache.read(['items', 'a'], load, { forceRefresh: true });
    newGate.resolve('after write');

    expect((await refreshed).data).toBe('after write');
    expect((await sharedRefresh).data).toBe('after write');
    oldGate.resolve('before write');
    expect((await original).data).toBe('before write');
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.peek(['items', 'a'])).toMatchObject({ data: 'after write', stale: false });
  });

  it('keeps the new request shared when an older invalidated request finishes first', async () => {
    const cache = createServerCache();
    const oldGate = deferred<string>();
    const newGate = deferred<string>();
    const load = vi
      .fn<CacheLoader<string>>()
      .mockImplementationOnce(() => oldGate.promise)
      .mockImplementationOnce(() => newGate.promise);
    const original = cache.read(['items', 'a'], load);
    cache.invalidate(['items', 'a']);
    const refreshed = cache.read(['items', 'a'], load, { forceRefresh: true });
    oldGate.resolve('before write');
    expect((await original).data).toBe('before write');
    const sharedRefresh = cache.read(['items', 'a'], load, { forceRefresh: true });
    newGate.resolve('after write');

    expect((await refreshed).data).toBe('after write');
    expect((await sharedRefresh).data).toBe('after write');
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.peek(['items', 'a'])).toMatchObject({ data: 'after write', stale: false });
  });

  it.each(['evict', 'clear'] as const)(
    'does not restore a pending response to the cache after %s',
    async (operation) => {
      const cache = createServerCache();
      const gate = deferred<string>();
      const pending = cache.read(['items', 'a'], () => gate.promise);
      if (operation === 'evict') cache.evict(['items', 'a']);
      else cache.clear();
      gate.resolve('removed');

      expect((await pending).data).toBe('removed');
      expect(cache.peek(['items', 'a'])).toBeUndefined();
    },
  );

  it('marks an entry stale so the next read refreshes it behind the caller', async () => {
    const cache = createServerCache({ staleAfterMs: 60_000 });
    let version = 1;
    const load: CacheLoader<number> = () => Promise.resolve(version);

    await cache.read(['items', 'a'], load);
    cache.invalidate(['items', 'a']);
    version = 2;
    const result = await cache.read(['items', 'a'], load);
    await result.revalidation;

    expect(result.data).toBe(1);
    expect(cache.peek<number>(['items', 'a'])?.data).toBe(2);
  });

  it('marks every key under a prefix stale and leaves unrelated keys alone', async () => {
    const cache = createServerCache({ staleAfterMs: 60_000 });
    const load: CacheLoader<string> = () => Promise.resolve('value');

    await cache.read(['items', 'a'], load);
    await cache.read(['items', 'b'], load);
    await cache.read(['search', 'q'], load);
    cache.invalidatePrefix(['items']);

    expect(cache.peek(['items', 'a'])?.stale).toBe(true);
    expect(cache.peek(['items', 'b'])?.stale).toBe(true);
    expect(cache.peek(['search', 'q'])?.stale).toBe(false);
  });

  it('drops an evicted entry so the next read has to load it again', async () => {
    const cache = createServerCache();
    const load = vi.fn<CacheLoader<string>>(() => Promise.resolve('value'));

    await cache.read(['items', 'a'], load);
    cache.evict(['items', 'a']);
    await cache.read(['items', 'a'], load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('tells subscribers which key changed and stops telling them once unsubscribed', async () => {
    const cache = createServerCache();
    const seen: string[][] = [];
    const unsubscribe = cache.subscribe((key) => seen.push([...key]));
    const load: CacheLoader<string> = () => Promise.resolve('value');

    await cache.read(['items', 'a'], load);
    cache.invalidate(['items', 'a']);
    unsubscribe();
    cache.evict(['items', 'a']);

    expect(seen).toEqual([
      ['items', 'a'],
      ['items', 'a'],
    ]);
  });
});

describe('cancellation', () => {
  it('rejects the cancelling reader with a cancellation error', async () => {
    const cache = createServerCache();
    const gate = deferred<string>();
    const controller = new AbortController();

    const pending = captureFailure(
      cache.read(['items', 'a'], () => gate.promise, { signal: controller.signal }),
    );
    controller.abort();
    const error = await pending;

    expect(error.kind).toBe(NixErrorKind.Canceled);
  });

  it('keeps the shared load running for the readers that did not cancel', async () => {
    const cache = createServerCache();
    const gate = deferred<string>();
    let loaderSignal: AbortSignal | undefined;
    const load: CacheLoader<string> = (signal) => {
      loaderSignal = signal;
      return gate.promise;
    };
    const leaving = new AbortController();
    const staying = new AbortController();

    const cancelled = captureFailure(cache.read(['items', 'a'], load, { signal: leaving.signal }));
    const kept = cache.read(['items', 'a'], load, { signal: staying.signal });
    leaving.abort();
    await cancelled;
    gate.resolve('arrived');

    expect((await kept).data).toBe('arrived');
    expect(loaderSignal?.aborted).toBe(false);
  });

  it('aborts the underlying request when the last interested reader cancels', async () => {
    const cache = createServerCache();
    let loaderSignal: AbortSignal | undefined;
    const load: CacheLoader<string> = (signal) => {
      loaderSignal = signal;
      return new Promise<string>(() => undefined);
    };
    const first = new AbortController();
    const second = new AbortController();

    const a = captureFailure(cache.read(['items', 'a'], load, { signal: first.signal }));
    const b = captureFailure(cache.read(['items', 'a'], load, { signal: second.signal }));
    first.abort();
    await a;
    expect(loaderSignal?.aborted).toBe(false);
    second.abort();
    await b;

    expect(loaderSignal?.aborted).toBe(true);
  });
});
