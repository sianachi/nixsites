import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDocumentHistory } from '../../history/use-document-history';
import { json } from '@nix/web-foundation/testing/json-response';

/**
 * `useDocumentHistory` against a hand-rolled `fetch`: the initial page, paging further back,
 * restoring and the refresh it triggers, and - the one failure mode unique to a hook, not to the
 * plain fetch wrappers underneath it - a response for an item this hook has since moved on from.
 */

const getAccessToken = (): Promise<string> => Promise.resolve('token');

vi.mock('@nix/web-platform/auth/auth-provider', () => ({
  useAuth: () => ({ getAccessToken }),
}));

const ITEM_A = '11111111-1111-4111-8111-111111111111';
const ITEM_B = '22222222-2222-4222-8222-222222222222';

function revision(seq: number, name: string | null = null): Record<string, unknown> {
  return {
    seq,
    fromSeq: seq,
    actorId: 'user-1',
    startedAt: '2026-09-20T10:00:00Z',
    endedAt: '2026-09-20T10:05:00Z',
    updateCount: 1,
    name,
  };
}

interface StubOptions {
  readonly pages?: Record<string, Record<string, unknown>>;
  /** Resolves only once released, to test what happens while a request for a stale item is in flight. */
  readonly gate?: { release: () => void };
}

function stubFetch(options: StubOptions = {}): {
  readonly requests: string[];
  readonly restorePosts: string[];
} {
  const requests: string[] = [];
  const restorePosts: string[] = [];
  let gateReleased = options.gate === undefined;
  const waiters: (() => void)[] = [];
  if (options.gate !== undefined) {
    options.gate.release = () => {
      gateReleased = true;
      for (const resolve of waiters.splice(0)) resolve();
    };
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(url);

      if (!gateReleased) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }

      const pathname = new URL(url, 'http://localhost').pathname;

      if (init?.method === 'POST' && pathname.endsWith('/restore')) {
        restorePosts.push(url);
        return json({ headSeq: 999 });
      }

      if (pathname.endsWith('/versions') && (init?.method ?? 'GET') === 'GET') {
        return json({ versions: [] });
      }

      const page = options.pages?.[pathname];
      if (page !== undefined) {
        return json(page);
      }

      return json({ revisions: [], hasMore: false, headSeq: 0 });
    }),
  );

  return { requests, restorePosts };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useDocumentHistory', () => {
  it('loads the first page of revisions and the named versions on mount', async () => {
    stubFetch({
      pages: {
        [`/collab/documents/${ITEM_A}/history`]: {
          revisions: [revision(2), revision(1)],
          hasMore: true,
          headSeq: 2,
        },
      },
    });

    const { result } = renderHook(() => useDocumentHistory(ITEM_A));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.revisions).toHaveLength(2);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.headSeq).toBe(2);
    expect(result.current.refusal).toBeNull();
  });

  it('appends an older page on loadMore rather than replacing the list', async () => {
    let firstCall = true;
    vi.stubGlobal(
      'fetch',
      vi.fn((rawUrl: string) => {
        const url = new URL(rawUrl, 'http://localhost');
        if (url.pathname === `/collab/documents/${ITEM_A}/versions`) {
          return json({ versions: [] });
        }
        if (firstCall) {
          firstCall = false;
          return json({ revisions: [revision(2), revision(1)], hasMore: true, headSeq: 2 });
        }
        expect(url.searchParams.get('before')).toBe('1');
        return json({ revisions: [revision(0)], hasMore: false, headSeq: 2 });
      }),
    );

    const { result } = renderHook(() => useDocumentHistory(ITEM_A));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.revisions.map((r) => r.seq)).toEqual([2, 1]);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.revisions.map((r) => r.seq)).toEqual([2, 1, 0]);
    expect(result.current.hasMore).toBe(false);
  });

  it('refreshes the lists after a successful restore', async () => {
    let historyRequests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((rawUrl: string, init?: RequestInit) => {
        const url = new URL(rawUrl, 'http://localhost');
        if (init?.method === 'POST' && url.pathname.endsWith('/restore')) {
          return json({ headSeq: 3 });
        }
        if (url.pathname === `/collab/documents/${ITEM_A}/versions`) {
          return json({ versions: [] });
        }
        historyRequests += 1;
        return json({
          revisions: [revision(historyRequests === 1 ? 2 : 3)],
          hasMore: false,
          headSeq: historyRequests === 1 ? 2 : 3,
        });
      }),
    );

    const { result } = renderHook(() => useDocumentHistory(ITEM_A));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.headSeq).toBe(2);

    let outcome: Awaited<ReturnType<typeof result.current.restore>> | undefined;
    await act(async () => {
      outcome = await result.current.restore(2);
    });

    expect(outcome).toEqual({ ok: true, value: { headSeq: 3 } });
    await waitFor(() => {
      expect(result.current.headSeq).toBe(3);
    });
  });

  it('drops a response that arrives after the itemId has already changed', async () => {
    const gate = { release: () => undefined };
    stubFetch({
      pages: {
        [`/collab/documents/${ITEM_A}/history`]: {
          revisions: [revision(1)],
          hasMore: false,
          headSeq: 1,
        },
        [`/collab/documents/${ITEM_B}/history`]: {
          revisions: [revision(9)],
          hasMore: false,
          headSeq: 9,
        },
      },
      gate,
    });

    const { result, rerender } = renderHook(({ itemId }) => useDocumentHistory(itemId), {
      initialProps: { itemId: ITEM_A },
    });

    // The mount's request for ITEM_A is now blocked behind the gate.
    rerender({ itemId: ITEM_B });

    await act(async () => {
      gate.release();
      // Let both the stale ITEM_A response and the fresh ITEM_B response settle.
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Only ITEM_B's revision made it into state; the late ITEM_A answer was discarded.
    expect(result.current.revisions.map((r) => r.seq)).toEqual([9]);
    expect(result.current.headSeq).toBe(9);
  });
});
