import { NixApiError, NixErrorKind, type NixClient } from '@nix/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { coCitationSource, REFRESH_MS, withinWait } from '../../editor/related-items';

function related(entries: readonly [string, number | string][]) {
  return {
    related: entries.map(([id, sharedSources]) => ({
      item: {
        id,
        workspaceId: 'w',
        type: 'note',
        title: id,
        parentId: null,
        updatedAt: '2026-09-01T00:00:00Z',
      },
      sharedSources,
    })),
    limit: 25,
    truncated: false,
  };
}

function clientAnswering(query: ReturnType<typeof vi.fn>): NixClient {
  return { query } as unknown as NixClient;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the co-citation source', () => {
  it('asks once and serves every search in the note from that answer', async () => {
    const query = vi.fn().mockResolvedValue(related([['a', 3]]));
    const source = coCitationSource(clientAnswering(query), 'note');

    expect((await source.get())?.get('a')).toBe(3);
    await source.get();

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('asks again, past the cache, once the answer is old', async () => {
    let now = 0;
    const query = vi.fn().mockResolvedValue(related([['a', 1]]));
    const source = coCitationSource(clientAnswering(query), 'note', () => now);
    await source.get();

    now = REFRESH_MS + 1;
    await source.get();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[1]).toMatchObject({ forceRefresh: true });
  });

  it('reads a count sent as a numeric string and ignores one that is not a positive count', async () => {
    const query = vi.fn().mockResolvedValue(
      related([
        ['a', '4'],
        ['b', 'many'],
        ['c', 0],
      ]),
    );
    const source = coCitationSource(clientAnswering(query), 'note');

    const answer = await source.get();

    expect([...(answer ?? new Map()).entries()]).toEqual([['a', 4]]);
  });

  it('answers nothing, without throwing, when the lookup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const query = vi.fn().mockRejectedValue(
      new NixApiError({
        kind: NixErrorKind.Http,
        code: 'http.500',
        message: 'boom',
        status: 500,
      }),
    );
    const source = coCitationSource(clientAnswering(query), 'note');

    await expect(source.get()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('abandons the request in flight when disposed', () => {
    const query = vi.fn().mockReturnValue(new Promise(() => undefined));
    const source = coCitationSource(clientAnswering(query), 'note');
    void source.get();

    source.dispose();

    const options = query.mock.calls[0]?.[1] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(true);
  });
});

describe('waiting a little for an answer', () => {
  it('gives up after the wait', async () => {
    const pending = withinWait(new Promise<number | undefined>(() => undefined), 300);

    await vi.advanceTimersByTimeAsync(300);

    await expect(pending).resolves.toBeUndefined();
  });

  it('leaves no timer behind when the answer arrives first', async () => {
    await expect(withinWait(Promise.resolve(7), 300)).resolves.toBe(7);

    expect(vi.getTimerCount()).toBe(0);
  });
});
