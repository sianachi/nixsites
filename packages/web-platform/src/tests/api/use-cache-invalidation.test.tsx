import { createNixClient } from '@nix/api-client';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientOverrideProvider } from '../../api/api-client-provider';
import { cacheKeysOverlap, useCacheInvalidation } from '../../api/use-cache-invalidation';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
function setup(refresh: (prefixes: readonly (readonly string[])[]) => void) {
  const client = createNixClient({
    baseUrl: 'http://localhost',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <ApiClientOverrideProvider client={client}>{children}</ApiClientOverrideProvider>;
  }
  const hook = renderHook(
    ({ reload }) => {
      useCacheInvalidation(
        (prefix) => cacheKeysOverlap(prefix, ['workspaces', 'ours', 'items']),
        reload,
      );
    },
    { wrapper: Wrapper, initialProps: { reload: refresh } },
  );
  return { client, ...hook };
}

describe('mounted cache readers', () => {
  it('coalesces an uncached write burst, scopes keys and uses the latest callback after render', async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { client, rerender } = setup(first);
    act(() => {
      client.invalidate(['workspaces', 'other', 'items']);
      client.invalidate(['workspaces', 'ours', 'items']);
      client.invalidate(['workspaces', 'ours', 'items']);
    });
    rerender({ reload: latest });
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledExactlyOnceWith([['workspaces', 'ours', 'items']]);
  });

  it('refreshes during sustained writes within one second and cancels scheduled work on unmount', async () => {
    const refresh = vi.fn();
    const { client, unmount } = setup(refresh);
    for (let index = 0; index < 10; index += 1) {
      act(() => {
        client.invalidate(['workspaces', 'ours', 'items']);
      });
      await act(() => vi.advanceTimersByTimeAsync(100));
    }
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => {
      client.invalidate(['workspaces', 'ours', 'items']);
    });
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
