import type { NixClient } from '@nix/api-client';
import { z } from 'zod';

const messageSchema = z.object({
  subject: z.string(),
  epoch: z.string(),
  prefix: z.array(z.string().max(512)).max(16),
});

/** Share only invalidation keys; each reader still obtains authorized data from Core. */
export function connectCacheInvalidationChannel(
  client: NixClient,
  subject: string,
  epoch: string,
  isCurrentAccount: () => boolean,
): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel('nix-cache-invalidations');
  } catch {
    return () => undefined;
  }
  let receiving = false;
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const parsed = messageSchema.safeParse(event.data);
    if (
      !parsed.success ||
      !isCurrentAccount() ||
      parsed.data.subject !== subject ||
      parsed.data.epoch !== epoch
    )
      return;
    receiving = true;
    try {
      client.invalidate(parsed.data.prefix);
    } finally {
      receiving = false;
    }
  };
  const unsubscribe = client.cache.subscribeInvalidation((prefix) => {
    if (receiving || !isCurrentAccount()) return;
    channel.postMessage({ subject, epoch, prefix });
  });
  return () => {
    unsubscribe();
    channel.close();
  };
}
