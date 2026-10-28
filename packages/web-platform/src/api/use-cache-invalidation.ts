import { cacheKeyToString, type CacheKey } from '@nix/api-client';
import { useEffect, useEffectEvent } from 'react';

import { useApiClient } from './api-client-provider';

/** Both a collection invalidation and an invalidation beneath it affect its reader. */
export function cacheKeysOverlap(left: CacheKey, right: CacheKey): boolean {
  return (
    left.every((part, index) => right[index] === part) ||
    right.every((part, index) => left[index] === part)
  );
}

/** Collapse a write burst while keeping mounted readers at most one second behind. */
export function useCacheInvalidation(
  matches: (prefix: CacheKey) => boolean,
  refresh: (prefixes: readonly CacheKey[]) => void,
): void {
  const client = useApiClient();
  const accepts = useEffectEvent(matches);
  const reload = useEffectEvent(refresh);
  useEffect(() => {
    const pending = new Map<string, CacheKey>();
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => {
      clearTimeout(quiet);
      clearTimeout(deadline);
      quiet = undefined;
      deadline = undefined;
      const prefixes = [...pending.values()];
      pending.clear();
      reload(prefixes);
    };
    const unsubscribe = client.cache.subscribeInvalidation((prefix) => {
      if (!accepts(prefix)) return;
      pending.set(cacheKeyToString(prefix), prefix);
      clearTimeout(quiet);
      quiet = setTimeout(flush, 150);
      deadline ??= setTimeout(flush, 1_000);
    });
    return () => {
      unsubscribe();
      clearTimeout(quiet);
      clearTimeout(deadline);
    };
  }, [client]);
}
