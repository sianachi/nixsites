import { afterEach, describe, expect, it, vi } from 'vitest';

import { notifyItemChildrenChanged, onItemChildrenChanged } from '../../lib/item-children-changed';

afterEach(() => {
  vi.useRealTimers();
});

describe('item refresh subscriptions', () => {
  it('does not replay changes from an unmounted view into a later subscriber', async () => {
    vi.useFakeTimers();
    const stop = onItemChildrenChanged(vi.fn());
    notifyItemChildrenChanged('workspace', 'first-parent');
    stop();
    notifyItemChildrenChanged('workspace', 'second-parent');

    const changed = vi.fn();
    const stopNext = onItemChildrenChanged(changed);
    try {
      await vi.advanceTimersByTimeAsync(1_100);
      expect(changed).not.toHaveBeenCalled();
    } finally {
      stopNext();
    }
  });
});
