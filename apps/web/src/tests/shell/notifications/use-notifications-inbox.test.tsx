import { createNixClient, type NixClient } from '@nix/api-client';
import { act, renderHook } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { useNotificationsInbox } from '../../../shell/notifications/use-notifications-inbox';

/**
 * `@testing-library/react`'s `waitFor` polls with its own real timer under the hood, which never
 * fires once `vi.useFakeTimers()` is active. Every assertion in this file instead advances the
 * fake clock through `act`, which also flushes the promise microtasks a fetch mock resolves
 * through, then asserts directly rather than polling.
 */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function wrapper(client: NixClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }): ReactElement {
    return <ApiClientOverrideProvider client={client}>{children}</ApiClientOverrideProvider>;
  };
}

function testClient(fetchMock: ReturnType<typeof vi.fn>): NixClient {
  vi.stubGlobal('fetch', fetchMock);
  return createNixClient({
    baseUrl: 'https://nix.test',
    tokens: {
      getAccessToken: () => Promise.resolve('token'),
      refreshAccessToken: () => Promise.resolve('token'),
    },
  });
}

function page(overrides: Partial<Record<string, unknown>> = {}): Response {
  return new Response(
    JSON.stringify({ items: [], nextCursor: null, unread: 0, revision: 0, ...overrides }),
    { status: 200 },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the notifications inbox long-poll', () => {
  it('loads the initial list, then keeps watch at the last known revision', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/notifications/watch')) {
        return Promise.resolve(page({ revision: 5 }));
      }
      return Promise.resolve(page({ revision: 0 }));
    });
    const client = testClient(fetchMock);

    const { result } = renderHook(() => useNotificationsInbox(), { wrapper: wrapper(client) });

    await tick(0);
    expect(result.current.loading).toBe(false);

    await tick(300);

    const watchCall = fetchMock.mock.calls.find(([url]) => url.includes('/notifications/watch'));
    expect(watchCall).toBeDefined();
    expect(watchCall?.[0]).toContain('after=0');
  });

  it('backs off on a 429 and calls onArrived only for genuinely new notifications', async () => {
    let watchCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/notifications/watch')) {
        watchCalls += 1;
        if (watchCalls === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ code: 'notifications.too_many_watches' }), {
              status: 429,
              headers: { 'content-type': 'application/problem+json' },
            }),
          );
        }
        return Promise.resolve(
          page({
            revision: 10,
            unread: 1,
            items: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                kind: 'system',
                title: 'New notice',
                body: '',
                itemId: null,
                workspaceId: null,
                createdAt: '2026-09-29T09:00:00.000Z',
                readAt: null,
              },
            ],
          }),
        );
      }
      return Promise.resolve(page());
    });
    const client = testClient(fetchMock);

    const { result } = renderHook(() => useNotificationsInbox(), { wrapper: wrapper(client) });
    await tick(0);
    expect(result.current.loading).toBe(false);

    const arrived = vi.fn();
    act(() => {
      result.current.onArrived(arrived);
    });

    // First watch tick (250ms gap) answers 429; the retry only happens after the 1s backoff, not
    // immediately.
    await tick(300);
    expect(watchCalls).toBe(1);
    await tick(500);
    expect(watchCalls).toBe(1);
    await tick(600);
    expect(watchCalls).toBe(2);

    expect(arrived).toHaveBeenCalledWith([
      expect.objectContaining({ id: '11111111-1111-4111-8111-111111111111' }),
    ]);
    expect(result.current.unread).toBe(1);
  });

  it('pauses polling while the document is hidden', async () => {
    let watchCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/notifications/watch')) watchCalls += 1;
      return Promise.resolve(page());
    });
    const client = testClient(fetchMock);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const { result } = renderHook(() => useNotificationsInbox(), { wrapper: wrapper(client) });
    await tick(0);
    expect(result.current.loading).toBe(false);

    await tick(2000);
    expect(watchCalls).toBe(0);

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await tick(300);

    expect(watchCalls).toBeGreaterThan(0);
  });
});
