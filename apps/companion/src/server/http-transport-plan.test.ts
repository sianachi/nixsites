import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { eventually, tempDir } from '../testing/testing.ts';
import { HttpTransport, MAX_THREAD_BYTES, trimThread } from './http-transport.ts';
import type { HttpThread } from './wire.ts';
import { responsesReplaySchema } from './responses-wire.ts';

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

describe('Responses replay retention', () => {
  it('counts encrypted replay bytes when trimming whole old turns', () => {
    const replay = responsesReplaySchema.parse({
      model: 'gpt-6.2-sol',
      items: [
        {
          type: 'reasoning',
          id: 'reasoning-one',
          summary: [],
          encrypted_content: 'x'.repeat(MAX_THREAD_BYTES),
        },
      ],
    });
    const thread: HttpThread = {
      id: 'thread',
      model: 'gpt-6.2-sol',
      system: '',
      tools: [],
      ephemeral: false,
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
      },
      messages: [
        { role: 'user', text: 'Old turn' },
        { role: 'assistant', text: 'Old answer', responses: replay },
        { role: 'user', text: 'Current turn' },
        { role: 'assistant', text: 'Current answer' },
      ],
    };
    trimThread(thread);
    expect(thread.messages).toEqual([
      { role: 'user', text: 'Current turn' },
      { role: 'assistant', text: 'Current answer' },
    ]);
  });
});

const nativeReasoning = (size = 24) => ({
  type: 'reasoning',
  id: 'reason-one',
  status: 'completed',
  summary: [],
  encrypted_content: 'r'.repeat(size),
});
const nativeCall = {
  type: 'function_call',
  id: 'function-one',
  call_id: 'call-one',
  name: 'nix_read_item',
  arguments: '{"itemId":"one"}',
  status: 'completed',
};
const nativeMessage = {
  type: 'message',
  id: 'message-one',
  role: 'assistant',
  status: 'completed',
  phase: 'final_answer',
  content: [{ type: 'output_text', text: 'Done', annotations: [], logprobs: [] }],
};
const nativeDone = (output: object[]) => ({
  type: 'response.completed',
  response: { status: 'completed', output },
});

it('pins the old key through a held native tool round and discards opaque replay after a new recipient and restart', async () => {
  const home = tempDir();
  const keys: (string | null)[] = [];
  const bodies: string[] = [];
  let pending: unknown;
  let waiting = false;
  let done = false;
  const transport = new HttpTransport({
    kind: 'openai',
    apiKey: 'old-synthetic-key',
    home,
    notify: (method) => {
      if (method === 'turn/completed') done = true;
    },
    fetch: async (_url, init) => {
      await Promise.resolve();
      keys.push(new Headers(init?.headers).get('authorization'));
      bodies.push(typeof init?.body === 'string' ? init.body : '');
      return events([
        nativeDone(keys.length === 1 ? [nativeReasoning(), nativeCall] : [nativeMessage]),
      ]);
    },
  });
  transport.setRequestHandler((id) => {
    pending = id;
    waiting = true;
    return true;
  });
  let threadId = '';
  const started = await transport.call('thread/start', {
    model: 'gpt-6.2-sol',
    dynamicTools: [
      {
        name: 'nix_read_item',
        description: 'Read a synthetic item',
        inputSchema: { type: 'object', properties: { itemId: { type: 'string' } } },
      },
    ],
  });
  if (
    typeof started === 'object' &&
    started !== null &&
    'thread' in started &&
    typeof started.thread === 'object' &&
    started.thread !== null &&
    'id' in started.thread &&
    typeof started.thread.id === 'string'
  )
    threadId = started.thread.id;
  await transport.call('turn/start', {
    threadId,
    recipientRevision: 'recipient-one',
    input: [{ type: 'text', text: 'Read synthetic item' }],
  });
  await eventually(() => waiting);
  transport.setApiKey('new-synthetic-key');
  transport.reply(pending, {
    success: true,
    contentItems: [{ type: 'inputText', text: 'Read result' }],
  });
  await eventually(() => done);
  expect(keys).toEqual(['Bearer old-synthetic-key', 'Bearer old-synthetic-key']);
  expect(bodies[1]).toContain('r'.repeat(24));
  transport.close();
  let resumedBody = '';
  done = false;
  const resumed = new HttpTransport({
    kind: 'openai',
    apiKey: 'new-synthetic-key',
    home,
    notify: (method) => {
      if (method === 'turn/completed') done = true;
    },
    fetch: async (_url, init) => {
      await Promise.resolve();
      resumedBody = typeof init?.body === 'string' ? init.body : '';
      return events([nativeDone([nativeMessage])]);
    },
  });
  try {
    await resumed.call('thread/resume', { threadId, model: 'gpt-6.2-sol' });
    await resumed.call('turn/start', {
      threadId,
      recipientRevision: 'recipient-two',
      input: [{ type: 'text', text: 'Next turn' }],
    });
    await eventually(() => done);
    expect(resumedBody).not.toContain('r'.repeat(24));
    expect(resumedBody).toContain('Read result');
  } finally {
    resumed.close();
  }
});

it('refuses an oversized active native batch before releasing any executable call', async () => {
  let calls = 0;
  let done = false;
  const transport = new HttpTransport({
    kind: 'openai',
    apiKey: 'synthetic',
    home: tempDir(),
    notify: (method) => {
      if (method === 'turn/completed') done = true;
    },
    fetch: async () => {
      await Promise.resolve();
      return events([nativeDone([nativeReasoning(MAX_THREAD_BYTES + 1), nativeCall])]);
    },
  });
  transport.setRequestHandler(() => {
    calls += 1;
    return true;
  });
  const started = await transport.call('thread/start', {
    model: 'gpt-6.2-sol',
    dynamicTools: [
      {
        name: 'nix_read_item',
        description: 'Read a synthetic item',
        inputSchema: { type: 'object', properties: { itemId: { type: 'string' } } },
      },
    ],
  });
  let threadId = '';
  if (
    typeof started === 'object' &&
    started !== null &&
    'thread' in started &&
    typeof started.thread === 'object' &&
    started.thread !== null &&
    'id' in started.thread &&
    typeof started.thread.id === 'string'
  )
    threadId = started.thread.id;
  try {
    await transport.call('turn/start', {
      threadId,
      recipientRevision: 'recipient-one',
      input: [{ type: 'text', text: 'Small task' }],
    });
    await eventually(() => done);
    expect(calls).toBe(0);
  } finally {
    transport.close();
  }
});

it('bounds accumulated native tool results before the next provider fetch', async () => {
  let requests = 0;
  let done = false;
  const transport = new HttpTransport({
    kind: 'openai',
    apiKey: 'synthetic',
    home: tempDir(),
    notify: (method) => {
      if (method === 'turn/completed') done = true;
    },
    fetch: async () => {
      await Promise.resolve();
      requests += 1;
      return events([
        nativeDone(
          requests === 1 ? [nativeReasoning(MAX_THREAD_BYTES - 8000), nativeCall] : [nativeMessage],
        ),
      ]);
    },
  });
  transport.setRequestHandler((id) => {
    transport.reply(id, {
      success: true,
      contentItems: [{ type: 'inputText', text: 'x'.repeat(32_000) }],
    });
    return true;
  });
  const started = await transport.call('thread/start', {
    model: 'gpt-6.2-sol',
    dynamicTools: [
      {
        name: 'nix_read_item',
        description: 'Read synthetic data',
        inputSchema: { type: 'object' },
      },
    ],
  });
  let threadId = '';
  if (
    typeof started === 'object' &&
    started !== null &&
    'thread' in started &&
    typeof started.thread === 'object' &&
    started.thread !== null &&
    'id' in started.thread &&
    typeof started.thread.id === 'string'
  )
    threadId = started.thread.id;
  try {
    await transport.call('turn/start', {
      threadId,
      recipientRevision: 'recipient-one',
      input: [{ type: 'text', text: 'Read one item' }],
    });
    await eventually(() => done);
    expect(requests).toBe(1);
  } finally {
    transport.close();
  }
});

it('invalidates retained opaque reasoning when a closed prefix is removed', () => {
  const replay = responsesReplaySchema.parse({
    model: 'gpt-6.2-sol',
    recipientRevision: 'recipient-one',
    items: [nativeReasoning()],
  });
  const thread: HttpThread = {
    id: 'thread',
    model: 'gpt-6.2-sol',
    system: '',
    tools: [],
    ephemeral: false,
    usage: {
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
    },
    messages: [
      { role: 'user', text: 'x'.repeat(MAX_THREAD_BYTES) },
      { role: 'assistant', text: 'Old answer' },
      { role: 'user', text: 'Retained question' },
      { role: 'assistant', text: 'Retained answer', responses: replay },
      { role: 'user', text: 'Current question' },
    ],
  };
  trimThread(thread);
  expect(JSON.stringify(thread.messages)).toContain('Retained answer');
  expect(JSON.stringify(thread.messages)).not.toContain('encrypted_content');
});

it('keeps a held native turn prefix until its tool continuation has finished', async () => {
  const home = tempDir();
  let requests = 0;
  let done = false;
  let second = '';
  const transport = new HttpTransport({
    kind: 'openai',
    apiKey: 'synthetic',
    home,
    notify: (method) => {
      if (method === 'turn/completed') done = true;
    },
    fetch: async (_url, init) => {
      await Promise.resolve();
      requests += 1;
      if (requests === 2) second = typeof init?.body === 'string' ? init.body : '';
      return events([
        nativeDone(requests === 1 ? [nativeReasoning(1500), nativeCall] : [nativeMessage]),
      ]);
    },
  });
  const tools = [
    { name: 'nix_read_item', description: 'Read synthetic data', inputSchema: { type: 'object' } },
  ];
  writeFileSync(
    join(home, 'threads', 'held-fixture.json'),
    JSON.stringify({
      id: 'held-fixture',
      model: 'gpt-6.2-sol',
      system: '',
      tools,
      messages: [
        { role: 'user', text: 'KEEP_ACTIVE_PREFIX' + 'x'.repeat(MAX_THREAD_BYTES - 800) },
        { role: 'assistant', text: 'Earlier answer' },
      ],
    }),
  );
  transport.setRequestHandler((id) => {
    transport.reply(id, {
      success: true,
      contentItems: [{ type: 'inputText', text: 'Synthetic result' }],
    });
    return true;
  });
  try {
    await transport.call('thread/resume', { threadId: 'held-fixture' });
    await transport.call('turn/start', {
      threadId: 'held-fixture',
      recipientRevision: 'recipient-one',
      input: [{ type: 'text', text: 'Read item' }],
    });
    await eventually(() => done);
    expect(requests).toBe(2);
    expect(second).toContain('KEEP_ACTIVE_PREFIX');
    expect(second).toContain('r'.repeat(1500));
  } finally {
    transport.close();
  }
});
