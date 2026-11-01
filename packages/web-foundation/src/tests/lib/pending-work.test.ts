import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushPendingWork, registerPendingWork } from '../../lib/pending-work';

const unregister: (() => void)[] = [];
const register = (flush: () => Promise<void>) => {
  const off = registerPendingWork(flush);
  unregister.push(off);
  return off;
};

afterEach(() => {
  unregister.splice(0).forEach((off) => {
    off();
  });
});

describe('pending work', () => {
  it('flushes every registered callback', async () => {
    const a = vi.fn(() => Promise.resolve());
    const b = vi.fn(() => Promise.resolve());
    register(a);
    register(b);

    await flushPendingWork();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('skips a callback that was unregistered', async () => {
    const kept = vi.fn(() => Promise.resolve());
    const dropped = vi.fn(() => Promise.resolve());
    register(kept);
    register(dropped)();

    await flushPendingWork();

    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it('rejects when a callback rejects', async () => {
    register(() => Promise.resolve());
    register(() => Promise.reject(new Error('write failed')));

    await expect(flushPendingWork()).rejects.toThrow('write failed');
  });
});
