import { describe, expect, it } from 'vitest';

import { eventually, tempDir } from '../testing/testing.ts';
import { HttpTransport } from './http-transport.ts';

const events = (values: object[]) =>
  new Response(values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });

const tool = [
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'call-one', name: 'nix_read_item' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"itemId":"one"}' },
  },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  { type: 'message_stop' },
];

const answer = [
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
];

describe('plan recipient credential pinning', () => {
  it('ends before provider fetch with a fixed recovery marker when sharing cannot be confirmed', async () => {
    let calls = 0;
    let finished: unknown;
    const transport = new HttpTransport({
      kind: 'anthropic',
      apiKey: 'synthetic-key',
      home: tempDir(),
      notify: (method, payload) => {
        if (method === 'turn/completed') finished = payload;
      },
      fetch: () => {
        calls += 1;
        return Promise.resolve(events(answer));
      },
    });
    try {
      const started = await transport.call('thread/start', { model: 'synthetic-model' });
      if (
        typeof started !== 'object' ||
        started === null ||
        !('thread' in started) ||
        typeof started.thread !== 'object' ||
        started.thread === null ||
        !('id' in started.thread) ||
        typeof started.thread.id !== 'string'
      )
        throw new Error('Missing synthetic thread');
      transport.setDisclosureGuard(started.thread.id, () => Promise.resolve(false));
      await transport.call('turn/start', {
        threadId: started.thread.id,
        input: [{ type: 'text', text: 'New request' }],
      });
      await eventually(() => finished !== undefined);
      expect(calls).toBe(0);
      expect(finished).toMatchObject({
        turn: {
          status: 'failed',
          error: {
            nixProviderError: 'nix.sharing_blocked',
          },
        },
      });
      expect(JSON.stringify(finished)).toContain('new conversation');
    } finally {
      transport.close();
    }
  });
  it('keeps a turn on its original key across tool-result continuations', async () => {
    const sentKeys: (string | null)[] = [];
    let completed = false;
    const transport = new HttpTransport({
      kind: 'anthropic',
      apiKey: 'synthetic-key-before',
      home: tempDir(),
      notify: (method) => {
        if (method === 'turn/completed') completed = true;
      },
      fetch: async (_url, init) => {
        await Promise.resolve();
        sentKeys.push(new Headers(init?.headers).get('x-api-key'));
        return events(sentKeys.length === 1 ? tool : answer);
      },
    });
    transport.setRequestHandler((id) => {
      transport.setApiKey('synthetic-key-after');
      transport.reply(id, {
        success: true,
        contentItems: [{ type: 'inputText', text: 'Synthetic item' }],
      });
      return true;
    });
    try {
      const started = await transport.call('thread/start', { model: 'synthetic-model' });
      const threadId =
        typeof started === 'object' && started !== null && 'thread' in started
          ? started.thread
          : undefined;
      await transport.call('turn/start', {
        threadId:
          typeof threadId === 'object' && threadId !== null && 'id' in threadId ? threadId.id : '',
        input: [{ type: 'text', text: 'Read one synthetic item' }],
      });
      await eventually(() => completed);
      expect(sentKeys).toEqual(['synthetic-key-before', 'synthetic-key-before']);
    } finally {
      transport.close();
    }
  });
});
