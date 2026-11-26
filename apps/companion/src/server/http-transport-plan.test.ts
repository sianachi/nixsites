import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

  describe('parallel reads', () => {
    const readCall = (index: number, id: string): object[] => [
      {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id, name: 'nix_read_item' },
      },
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: '{"itemId":"x"}' },
      },
      { type: 'content_block_stop', index },
    ];
    const round = [
      ...readCall(0, 'r1'),
      ...readCall(1, 'r2'),
      ...readCall(2, 'r3'),
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ];
    interface Result {
      tool_use_id: string;
      is_error: boolean;
      content: string;
    }
    const lastResults = (body: string): Result[] =>
      (JSON.parse(body) as { messages: { role: string; content: unknown }[] }).messages
        .filter((m) => JSON.stringify(m.content).includes('tool_result'))
        .at(-1)?.content as Result[];

    it('answers every outstanding read with a stopped result, in order, when the turn is interrupted', async () => {
      const bodies: string[] = [];
      let completed: unknown;
      const transport = new HttpTransport({
        kind: 'anthropic',
        apiKey: 'synthetic-key',
        home: tempDir(),
        notify: (method, payload) => {
          if (method === 'turn/completed') completed = payload;
        },
        fetch: (_url, init) => {
          bodies.push(typeof init?.body === 'string' ? init.body : '');
          return Promise.resolve(events(bodies.length === 1 ? round : answer));
        },
      });
      const asked: string[] = [];
      transport.setRequestHandler((_id, _method, params) => {
        asked.push((params as { callId: string }).callId);
        return true;
      });
      try {
        const started = (await transport.call('thread/start', { model: 'synthetic-model' })) as {
          thread: { id: string };
        };
        const turn = (await transport.call('turn/start', {
          threadId: started.thread.id,
          input: [{ type: 'text', text: 'Read three' }],
        })) as { turn: { id: string } };
        await eventually(() => asked.length === 3);
        await transport.call('turn/interrupt', { turnId: turn.turn.id });
        await eventually(() => completed !== undefined);
        expect(completed).toMatchObject({ turn: { status: 'interrupted' } });
        completed = undefined;
        await transport.call('turn/start', {
          threadId: started.thread.id,
          input: [{ type: 'text', text: 'Again' }],
        });
        await eventually(() => completed !== undefined);
        const results = lastResults(bodies[1] ?? '{}');
        expect(results.map((r) => r.tool_use_id)).toEqual(['r1', 'r2', 'r3']);
        for (const r of results) {
          expect(r.is_error).toBe(true);
          expect(r.content).toContain('stopped');
        }
      } finally {
        transport.close();
      }
    });

    it('turns one refused and one failing read into error results without disturbing the others', async () => {
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
      // r1 succeeds, r2 is refused by the handler, r3 fails.
      transport.setRequestHandler((id, _method, params) => {
        const callId = (params as { callId: string }).callId;
        if (callId === 'r2') return false;
        transport.reply(id, {
          success: callId === 'r1',
          contentItems: [{ type: 'inputText', text: `result ${callId}` }],
        });
        return true;
      });
      try {
        const started = (await transport.call('thread/start', { model: 'synthetic-model' })) as {
          thread: { id: string };
        };
        await transport.call('turn/start', {
          threadId: started.thread.id,
          input: [{ type: 'text', text: 'Read three' }],
        });
        await eventually(() => completed);
        const results = lastResults(bodies[1] ?? '{}');
        expect(results.map((r) => [r.tool_use_id, r.is_error])).toEqual([
          ['r1', false],
          ['r2', true],
          ['r3', true],
        ]);
        expect(results[1]?.content).toContain('not available');
        expect(results[2]?.content).toContain('result r3');
      } finally {
        transport.close();
      }
    });
  });

  describe('Anthropic thinking', () => {
    const thoughtRound = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Plan A' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig-1' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'redacted_thinking', data: 'blob' },
      },
      { type: 'content_block_stop', index: 1 },
      ...tool.map((e) => ('index' in e ? { ...e, index: 2 } : e)),
    ];

    const run = async (model: string) => {
      const home = tempDir();
      const bodies: Record<string, unknown>[] = [];
      let completed = false;
      const transport = new HttpTransport({
        kind: 'anthropic',
        apiKey: 'synthetic-key',
        home,
        notify: (method) => {
          if (method === 'turn/completed') completed = true;
        },
        fetch: (_url, init) => {
          bodies.push(
            JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
              string,
              unknown
            >,
          );
          // The first turn: a thinking tool round then the answer; later turns answer at once.
          return Promise.resolve(events(bodies.length === 1 ? thoughtRound : answer));
        },
      });
      transport.setRequestHandler((id) => {
        transport.reply(id, { success: true, contentItems: [{ type: 'inputText', text: 'ok' }] });
        return true;
      });
      const started = (await transport.call('thread/start', { model })) as {
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
      return {
        bodies,
        home,
        send,
        id: started.thread.id,
        close: () => {
          transport.close();
        },
      };
    };

    it('thinks on Sonnet, replays the blocks inside the turn only, and never saves them', async () => {
      const t = await run('claude-sonnet-5-5');
      try {
        await t.send('First');
        expect(t.bodies[0]?.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        const replayed = (
          t.bodies[1]?.messages as { role: string; content: { type: string }[] }[]
        ).find((m) => m.role === 'assistant')?.content;
        expect(replayed?.slice(0, 3)).toEqual([
          { type: 'thinking', thinking: 'Plan A', signature: 'sig-1' },
          { type: 'redacted_thinking', data: 'blob' },
          expect.objectContaining({ type: 'tool_use' }),
        ]);
        await t.send('Second');
        expect(JSON.stringify(t.bodies[2])).not.toContain('sig-1');
        expect(readFileSync(join(t.home, 'threads', `${t.id}.json`), 'utf8')).not.toContain(
          'sig-1',
        );
      } finally {
        t.close();
      }
    });

    it('keeps the thinking of a tool round the owner interrupted, for the next turn', async () => {
      const bodies: Record<string, unknown>[] = [];
      let completed = false;
      let asked = false;
      const transport = new HttpTransport({
        kind: 'anthropic',
        apiKey: 'synthetic-key',
        home: tempDir(),
        notify: (method) => {
          if (method === 'turn/completed') completed = true;
        },
        fetch: (_url, init) => {
          bodies.push(
            JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
              string,
              unknown
            >,
          );
          return Promise.resolve(events(bodies.length === 1 ? thoughtRound : answer));
        },
      });
      transport.setRequestHandler(() => {
        asked = true;
        return true;
      });
      try {
        const started = (await transport.call('thread/start', { model: 'claude-sonnet-5-5' })) as {
          thread: { id: string };
        };
        const turn = (await transport.call('turn/start', {
          threadId: started.thread.id,
          input: [{ type: 'text', text: 'First' }],
        })) as { turn: { id: string } };
        await eventually(() => asked);
        await transport.call('turn/interrupt', { turnId: turn.turn.id });
        await eventually(() => completed);
        completed = false;
        await transport.call('turn/start', {
          threadId: started.thread.id,
          input: [{ type: 'text', text: 'Again' }],
        });
        await eventually(() => completed);
        expect(JSON.stringify(bodies[1])).toContain('sig-1');
      } finally {
        transport.close();
      }
    });

    it('keeps thinking off for Haiku chat', async () => {
      const t = await run('claude-haiku-5-5');
      try {
        await t.send('First');
        expect(t.bodies[0]?.thinking).toEqual({ type: 'disabled' });
      } finally {
        t.close();
      }
    });
  });
});
