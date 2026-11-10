import type { ServerResponse } from 'node:http';

import type { Account } from '../core/account.ts';
import { conversationKey } from '../shared/diagnostics.ts';
import type { Request, Response } from '../shared/types.ts';
import { aborted } from '../shared/util.ts';
import { sendError } from './inline.ts';

export const WATCH_STREAM_LIFETIME_MS = 120_000;
export const WATCH_STREAM_KEEP_ALIVE_MS = 15_000;
const SETUP_TIMEOUT_MS = 25_000;

/**
 * The one message whose text grew while everything else stayed equal, as a delta payload; null when
 * the change is anything else (the caller then sends a whole snapshot).
 */
export function textDelta(
  last: Response,
  next: Response,
): { revision: number; base: number; id: string; append: string } | null {
  if (next.messages.length !== last.messages.length) return null;
  const changed = next.messages.flatMap((m, i) => (m.text === last.messages[i]?.text ? [] : [i]));
  const i = changed[0];
  const before = i === undefined ? undefined : last.messages[i];
  const after = i === undefined ? undefined : next.messages[i];
  if (changed.length !== 1 || before === undefined || after === undefined) return null;
  if (after.id !== before.id || !after.text.startsWith(before.text)) return null;
  // Everything but the revision and that one text must match, or the client would miss a change.
  const rest = (r: Response, m: typeof before): string =>
    JSON.stringify({
      ...r,
      revision: 0,
      messages: r.messages.map((x) => (x === m ? { ...x, text: '' } : x)),
    });
  if (rest(last, before) !== rest(next, after)) return null;
  return {
    revision: next.revision,
    base: last.revision,
    id: after.id,
    append: after.text.slice(before.text.length),
  };
}

/**
 * Handles operation "watch_stream": a server-sent event stream of one conversation. It sends a
 * snapshot first, then a delta for pure text growth or a snapshot for any other change, and ends
 * itself at the lifetime so the client reopens to a fresh snapshot. It holds one watcher slot and
 * never the operation lock, so it cannot block or be blocked by a send.
 */
export async function serveWatchStream(
  account: (signal: AbortSignal) => Promise<Account | undefined>,
  res: ServerResponse,
  request: Request,
  client: AbortSignal,
  limits = { lifetimeMs: WATCH_STREAM_LIFETIME_MS, keepAliveMs: WATCH_STREAM_KEEP_ALIVE_MS },
): Promise<void> {
  const setup = AbortSignal.any([client, AbortSignal.timeout(SETUP_TIMEOUT_MS)]);
  const a = await account(setup);
  if (a === undefined) {
    sendError(res, 503, 'Companion runtime unavailable');
    return;
  }
  const key = conversationKey(request);
  if (!a.tryAcquireWatcher()) {
    a.diag.record(key, 'warn', 'watch.refused', { reason: 'too many open watches' });
    sendError(res, 429, 'Too many open watches');
    return;
  }
  try {
    a.last = Date.now();
    let last: Response;
    try {
      // "read" loads the conversation and runs the stale-turn check.
      last = await a.handle(setup, { ...request, operation: 'read' });
    } catch {
      sendError(res, 503, 'Companion runtime unavailable');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    let lastWrite = Date.now();
    const send = (event: string, id: number | undefined, payload: unknown): void => {
      if (res.destroyed || res.writableEnded) return;
      res.write(
        `${id === undefined ? '' : `id: ${String(id)}\n`}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
      );
      lastWrite = Date.now();
    };
    send('snapshot', last.revision, last);
    const until = Date.now() + limits.lifetimeMs;
    while (!aborted(client) && !res.destroyed && Date.now() < until) {
      await a.awaitChange(
        client,
        key,
        last.revision,
        Math.min(limits.keepAliveMs, until - Date.now()),
      );
      if (aborted(client)) break;
      // This account is no longer the one requests reach (its child died, or it was replaced):
      // end so the client reopens on the current one instead of going silent until the lifetime.
      if (a.transport.alive?.() === false) break;
      const c = a.conversations.get(key);
      if (c !== undefined) await a.expireStaleThinking(client, key, c);
      const next = a.snapshot(key);
      if (next.revision > last.revision) {
        const delta = textDelta(last, next);
        if (delta === null) send('snapshot', next.revision, next);
        else send('delta', next.revision, delta);
        last = next;
      } else if (Date.now() - lastWrite >= limits.keepAliveMs) {
        res.write(': keep-alive\n\n');
        lastWrite = Date.now();
      }
      a.last = Date.now();
    }
    if (!aborted(client)) send('end', undefined, { revision: last.revision });
  } finally {
    a.releaseWatcher();
    if (!res.writableEnded) res.end();
  }
}
