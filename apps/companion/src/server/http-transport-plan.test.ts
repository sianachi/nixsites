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

  it('runs a run of read-only calls together, a write after them alone, and replays results in order', async () => {
    const call = (index: number, id: string, name: string, json: string): object[] => [
      {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id, name },
      },
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: json },
      },
      { type: 'content_block_stop', index },
    ];
    const round = [
      ...call(0, 'r1', 'nix_read_item', '{"itemId":"one"}'),
      ...call(1, 'r2', 'nix_read_item', '{"itemId":"two"}'),
      ...call(2, 'w1', 'nix_append_note', '{"itemId":"one","markdown":"x"}'),
      ...call(3, 'r3', 'nix_read_item', '{"itemId":"three"}'),
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ];
    const bodies: string[] = [];
    let completed = false;
    const transport = new HttpTransport({
      kind: 'anthropic',
      apiKey: 'synthetic-key',
      home: tempDir(),
      notify: (method) => {
        if (method === 'turn/completed') completed = true;
      },
      fetch: (_url, init) => {
        bodies.push(typeof init?.body === 'string' ? init.body : '');
        return Promise.resolve(events(bodies.length === 1 ? round : answer));
      },
    });
    const asked: string[] = [];
    const held = new Map<string, unknown>();
    transport.setRequestHandler((id, _method, params) => {
      const callId = (params as { callId: string }).callId;
      asked.push(callId);
      held.set(callId, id);
      return true;
    });
    const answerCall = (callId: string): void => {
      transport.reply(held.get(callId), {
        success: true,
        contentItems: [{ type: 'inputText', text: `result ${callId}` }],
      });
    };
    try {
      const started = (await transport.call('thread/start', { model: 'synthetic-model' })) as {
        thread: { id: string };
      };
      await transport.call('turn/start', {
        threadId: started.thread.id,
        input: [{ type: 'text', text: 'Read and write' }],
      });
      // Both leading reads are asked at once; the write and the read after it are not.
      await eventually(() => asked.length === 2);
      expect(asked).toEqual(['r1', 'r2']);
      answerCall('r2');
      answerCall('r1');
      await eventually(() => asked.length === 3);
      expect(asked).toEqual(['r1', 'r2', 'w1']);
      answerCall('w1');
      await eventually(() => asked.length === 4);
      answerCall('r3');
      await eventually(() => completed);
      const results = (
        JSON.parse(bodies[1] ?? '{}') as { messages: { content: unknown }[] }
      ).messages.at(-1)?.content as { tool_use_id: string }[];
      expect(results.map((r) => r.tool_use_id)).toEqual(['r1', 'r2', 'w1', 'r3']);
    } finally {
      transport.close();
    }
  });

  it('passes reasoning out as it arrives and never keeps it in the thread', async () => {
    const reasoning: string[] = [];
    const bodies: string[] = [];
    let completed = false;
    const transport = new HttpTransport({
      kind: 'anthropic',
      apiKey: 'synthetic-key',
      home: tempDir(),
      notify: (method, payload) => {
        if (method === 'item/reasoning/summaryTextDelta')
          reasoning.push((payload as { delta: string }).delta);
        if (method === 'turn/completed') completed = true;
      },
      fetch: (_url, init) => {
        bodies.push(typeof init?.body === 'string' ? init.body : '');
        return Promise.resolve(
          events([
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: 'Weighing options' },
            },
            { type: 'content_block_stop', index: 0 },
            ...answer.map((e) => ({ ...e, index: 1 })),
          ]),
        );
      },
    });
    try {
      const started = (await transport.call('thread/start', { model: 'synthetic-model' })) as {
        thread: { id: string };
      };
      const send = async (text: string): Promise<void> => {
        completed = false;
        await transport.call('turn/start', {
          threadId: started.thread.id,
          input: [{ type: 'text', text }],
        });
        await eventually(() => completed);
      };
      await send('First');
      await send('Second');
      expect(reasoning).toEqual(['Weighing options', 'Weighing options']);
      expect(bodies[1]).not.toContain('Weighing');
    } finally {
      transport.close();
    }
  });
});
