import { createNixClient } from '@nix/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectCacheInvalidationChannel } from '../../api/cache-invalidation-channel';

const channels = new Set<TestChannel>();
class TestChannel {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly postMessage = vi.fn((value: unknown): void => {
    for (const other of channels) {
      if (other !== this) other.onmessage?.(new MessageEvent('message', { data: value }));
    }
  });
  constructor() {
    channels.add(this);
  }
  close(): void {
    channels.delete(this);
  }
}
function client() {
  return createNixClient({
    baseUrl: 'http://localhost',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
}
beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', TestChannel);
});
afterEach(() => {
  channels.clear();
  vi.unstubAllGlobals();
});

describe('browser cache invalidations', () => {
  it('refreshes another provider once without forwarding credentials or rebroadcasting', () => {
    const sender = client();
    const reader = client();
    const changed = vi.fn();
    reader.cache.subscribeInvalidation(changed);
    const stopSender = connectCacheInvalidationChannel(sender, 'person', 'epoch', () => true);
    const stopReader = connectCacheInvalidationChannel(reader, 'person', 'epoch', () => true);

    sender.invalidate(['workspaces', 'workspace', 'items']);

    expect(changed).toHaveBeenCalledExactlyOnceWith(['workspaces', 'workspace', 'items']);
    expect([...channels].map((channel) => channel.postMessage.mock.calls.length)).toEqual([1, 0]);
    expect([...channels][0]?.postMessage).toHaveBeenCalledWith({
      subject: 'person',
      epoch: 'epoch',
      prefix: ['workspaces', 'workspace', 'items'],
    });
    stopSender();
    stopReader();
    expect(channels.size).toBe(0);
  });

  it('ignores another account, an old account epoch, a sealed session and malformed keys', () => {
    const reader = client();
    const changed = vi.fn();
    reader.cache.subscribeInvalidation(changed);
    let current = true;
    const stop = connectCacheInvalidationChannel(reader, 'person', 'current-epoch', () => current);
    const sender = new TestChannel();
    sender.postMessage({ subject: 'other', epoch: 'current-epoch', prefix: ['items'] });
    sender.postMessage({ subject: 'person', epoch: 'old-epoch', prefix: ['items'] });
    sender.postMessage({ subject: 'person', epoch: 'current-epoch', prefix: [42] });
    current = false;
    sender.postMessage({ subject: 'person', epoch: 'current-epoch', prefix: ['items'] });
    reader.invalidate(['files']);
    expect(changed).toHaveBeenCalledExactlyOnceWith(['files']);
    expect([...channels][0]?.postMessage).not.toHaveBeenCalled();
    stop();
    sender.close();
  });
});
