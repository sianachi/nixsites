import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { eventually, harness, request } from '../testing/testing.ts';
import { serveWatchStream, textDelta } from './watch-stream.ts';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

const limits = { lifetimeMs: 600, keepAliveMs: 60 };

async function open(
  h: ReturnType<typeof harness>,
  lim = limits,
  account?: () => typeof h.account | undefined,
): Promise<Response> {
  const server = createServer((req, res) => {
    const abort = new AbortController();
    res.on('close', () => {
      abort.abort();
    });
    void serveWatchStream(
      () => Promise.resolve(account === undefined ? h.account : account()),
      res,
      request({ operation: 'watch_stream' }),
      abort.signal,
      lim,
    );
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`);
}

/** Reads events until `stop` matches the text so far. */
async function readUntil(r: Response, stop: (text: string) => boolean): Promise<string> {
  const reader = r.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (reader !== undefined && !stop(text)) {
    const chunk: { value?: Uint8Array; done: boolean } = await reader.read();
    const { value, done } = chunk;
    if (done) break;
    text += decoder.decode(value);
  }
  void reader?.cancel();
  return text;
}

const events = (text: string): string[] =>
  [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1] ?? '');

describe('watch stream', () => {
  it('sends a snapshot, then a delta for text growth and a snapshot for a tool change', async () => {
    const h = harness();
    await h.account.handle(h.signal, request());
    const response = await open(h);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    setTimeout(() => {
      h.notify('item/agentMessage/delta', {
        threadId: 'provider-thread',
        itemId: 'm1',
        delta: 'Hel',
      });
    }, 20);
    setTimeout(() => {
      h.notify('item/agentMessage/delta', {
        threadId: 'provider-thread',
        itemId: 'm1',
        delta: 'lo',
      });
    }, 220);
    setTimeout(() => {
      h.transport.toolCall(1, 'call-1', 'nix_search', { query: 'q' });
    }, 420);
    const text = await readUntil(response, (t) => t.includes('event: end'));
    const names = events(text);
    expect(names[0]).toBe('snapshot');
    expect(names).toContain('delta');
    expect(names.at(-1)).toBe('end');
    // The first draft event adds a message (snapshot); the second only appends text (delta).
    expect(text).toMatch(
      /event: delta\ndata: \{"revision":\d+,"base":\d+,"id":"[^"]+","append":"lo"\}/,
    );
    expect(text).toMatch(/^id: \d+$/m);
  });

  it('reconnecting always starts with a snapshot of the current conversation', async () => {
    const h = harness();
    await h.account.handle(h.signal, request());
    const text = await readUntil(await open(h), (t) => t.includes('\n\n'));
    expect(events(text)).toEqual(['snapshot']);
    expect(text).toContain('Help me write');
  });

  it('sends a keep-alive after silence and ends at the lifetime', async () => {
    const h = harness();
    await h.account.handle(h.signal, request());
    const text = await readUntil(await open(h), (t) => t.includes('event: end'));
    expect(text).toContain(': keep-alive');
  });

  it('releases the watcher when the client aborts', async () => {
    const h = harness();
    await h.account.handle(h.signal, request());
    const response = await open(h, { lifetimeMs: 60_000, keepAliveMs: 60 });
    await readUntil(response, (t) => t.includes('\n\n'));
    await eventually(() => h.account.watchers === 0);
  });

  it('ends early once its account is dead, so the client reopens on the current one', async () => {
    const h = harness();
    await h.account.handle(h.signal, request());
    const response = await open(h, { lifetimeMs: 60_000, keepAliveMs: 60 });
    setTimeout(() => {
      (h.transport as { alive?: () => boolean }).alive = () => false;
    }, 50);
    const text = await readUntil(response, (t) => t.includes('event: end'));
    expect(events(text).at(-1)).toBe('end');
  });

  it('answers 429 when the watcher cap is reached and 503 with no headers on a failed setup', async () => {
    const h = harness();
    await h.account.handle(h.signal, request());
    while (h.account.tryAcquireWatcher()) {
      // fill every slot
    }
    expect((await open(h)).status).toBe(429);
    const none = await open(h, limits, () => undefined);
    expect(none.status).toBe(503);
    expect(none.headers.get('content-type')).not.toContain('event-stream');
  });

  it('textDelta falls back to a snapshot unless only one text grew', () => {
    const base = (text: string, extra = '') =>
      ({
        revision: 1,
        state: 'thinking',
        title: extra,
        messages: [{ id: 'a', role: 'assistant', text }],
      }) as never;
    expect(textDelta(base('a'), base('ab'))).toMatchObject({ id: 'a', append: 'b' });
    expect(textDelta(base('ab'), base('a'))).toBeNull();
    expect(textDelta(base('a'), base('ab', 't'))).toBeNull();
  });
});
