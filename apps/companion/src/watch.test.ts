import { describe, expect, it } from 'vitest';

import { MAX_CONCURRENT_WATCHERS, MIN_WATCH_DWELL_MS } from './account.ts';
import { harness, keyOf, request } from './testing.ts';

const key = keyOf(request());

async function started() {
  const h = harness();
  await h.account.handle(h.signal, request());
  const revision = h.account.snapshot(key).revision;
  return { h, revision };
}

describe('watch', () => {
  it('returns at once when the revision is already past after', async () => {
    const { h, revision } = await started();
    const t0 = Date.now();
    const r = await h.account.handle(
      h.signal,
      request({ operation: 'watch', after: revision - 1 }),
    );
    expect(Date.now() - t0).toBeLessThan(MIN_WATCH_DWELL_MS * 3);
    expect(r.revision).toBeGreaterThan(revision - 1);
  });

  it('wakes on a change and no sooner than the dwell after it started', async () => {
    const { h, revision } = await started();
    const t0 = Date.now();
    const pending = h.account.handle(h.signal, request({ operation: 'watch', after: revision }));
    setTimeout(() => {
      h.notify('item/agentMessage/delta', {
        threadId: 'provider-thread',
        itemId: 'i',
        delta: 'Hi',
      });
    }, 10);
    const r = await pending;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(MIN_WATCH_DWELL_MS - 5);
    expect(r.revision).toBeGreaterThan(revision);
    expect(r.messages.at(-1)?.text).toBe('Hi');
  });

  it('returns immediately when after is zero', async () => {
    const { h } = await started();
    const t0 = Date.now();
    await h.account.awaitChange(h.signal, key, 0, 5000);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('returns when its signal ends, with the same revision', async () => {
    const { h, revision } = await started();
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 30);
    const t0 = Date.now();
    await h.account.awaitChange(controller.signal, key, revision, 5000);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(h.account.snapshot(key).revision).toBe(revision);
  });

  it('returns at its own deadline without a change', async () => {
    const { h, revision } = await started();
    const t0 = Date.now();
    await h.account.awaitChange(h.signal, key, revision, 60);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
  });

  it('expires a stuck turn when the watch returns, like a read', async () => {
    const { h, revision } = await started();
    const c = h.account.conversations.get(key);
    if (c === undefined) throw new Error('missing');
    c.timing.started = Date.now() - 16 * 60 * 1000;
    const r = await h.account.handle(
      h.signal,
      request({ operation: 'watch', after: revision - 1 }),
    );
    expect(r.state).toBe('error');
  });

  it('is not blocked while a send holds the operation lock', async () => {
    const { h, revision } = await started();
    h.account.opBusy = true;
    const r = await h.account.handle(
      h.signal,
      request({ operation: 'watch', after: revision - 1 }),
    );
    expect(r.state).toBe('thinking');
    // Expiry is skipped rather than waited for while the lock is held.
    const c = h.account.conversations.get(key);
    if (c === undefined) throw new Error('missing');
    c.timing.started = Date.now() - 16 * 60 * 1000;
    const again = await h.account.handle(h.signal, request({ operation: 'read' }));
    expect(again.state).toBe('thinking');
  });

  it('caps concurrent watchers per account', () => {
    const { account } = harness();
    for (let i = 0; i < MAX_CONCURRENT_WATCHERS; i++)
      expect(account.tryAcquireWatcher()).toBe(true);
    expect(account.tryAcquireWatcher()).toBe(false);
    account.releaseWatcher();
    expect(account.tryAcquireWatcher()).toBe(true);
  });

  it('bumps the revision on every persisted mutation, monotonically', async () => {
    const { h, revision } = await started();
    const seen = [revision];
    for (let i = 0; i < 3; i++) {
      h.notify('item/agentMessage/delta', { threadId: 'provider-thread', itemId: 'i', delta: 'x' });
      seen.push(h.account.snapshot(key).revision);
    }
    expect(seen.every((n, i) => i === 0 || n > (seen[i - 1] ?? 0))).toBe(true);
  });
});
