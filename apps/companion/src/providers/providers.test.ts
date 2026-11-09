import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Account } from '../core/account.ts';
import {
  HttpTransport,
  MAX_THREAD_BYTES,
  MAX_THREAD_TURNS,
  MAX_TOOL_ROUNDS_PER_TURN,
  trimThread,
} from '../server/http-transport.ts';
import { providerFailureMessage, providerResponseError } from './provider-errors.ts';
import {
  eventually,
  IDS,
  jsonResponse,
  keyOf,
  request,
  sse,
  startServer,
  tempDir,
  type FakeServer,
} from '../testing/testing.ts';
import type { Notify } from '../shared/types.ts';
import type { HttpThread, ProviderMessage } from '../server/wire.ts';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const track = async (server: Promise<FakeServer>): Promise<FakeServer> => {
  const s = await server;
  servers.push(s);
  return s;
};

const anthropicTurn = (text: string, extra: object[] = []): object[] => [
  {
    type: 'message_start',
    message: {
      usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  ...extra,
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
  { type: 'message_stop' },
];

const anthropicTool = (id: string, name: string, args: string, text = ''): object[] => [
  ...(text === ''
    ? []
    : [
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
      ]),
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name } },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: args.slice(0, 5) },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: args.slice(5) },
  },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  { type: 'message_stop' },
];

function keyAccount(
  kind: 'anthropic' | 'openrouter',
  server: FakeServer,
  home = tempDir(),
  apiKey = 'sk-test',
) {
  const events: { method: string; params: Record<string, unknown> }[] = [];
  const ref: { account?: Account } = {};
  const notify: Notify = (method, params) => {
    events.push({ method, params: params as Record<string, unknown> });
    ref.account?.notify(method, params);
  };
  const transport = new HttpTransport({ kind, apiKey, home, notify, baseUrl: server.url });
  const account = new Account({
    home,
    provider: kind,
    transport,
    chatEffort: 'low',
    logger: undefined,
    trace: false,
  });
  ref.account = account;
  const signal = new AbortController().signal;
  return {
    account,
    transport,
    events,
    home,
    signal,
    send: (o = {}) => account.handle(signal, request({ operation: 'send', ...o })),
  };
}

const key = keyOf(request());
/** The failure message the provider reported on the turn, which the account keeps out of the owner's view. */
const failure = (events: { method: string; params: Record<string, unknown> }[]): string =>
  (
    events.find((e) => e.method === 'turn/completed')?.params.turn as
      { error?: { message: string } } | undefined
  )?.error?.message ?? '';

describe('Anthropic', () => {
  it('streams text into Codex-shaped notifications, with cache breakpoints and counted usage', async () => {
    const server = await track(
      startServer((seen, res) => {
        if (seen.url.startsWith('/v1/models'))
          return jsonResponse(res, 200, { data: [{ id: 'claude-x', display_name: 'Claude X' }] });
        sse(res, anthropicTurn('Hello there'));
      }),
    );
    const k = keyAccount('anthropic', server);
    await k.send({ workspaceAccess: true });
    await eventually(() => k.account.snapshot(key).state === 'success');
    const snapshot = k.account.snapshot(key);
    expect(snapshot.messages.map((m) => m.text)).toEqual(['Help me write', 'Hello there']);
    expect(k.events.map((e) => e.method)).toEqual([
      'item/agentMessage/delta',
      'item/completed',
      'turn/completed',
    ]);
    expect(k.events[2]?.params.turn).toMatchObject({
      status: 'completed',
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
        output_tokens: 7,
      },
    });
    const post = server.seen.find((s) => s.method === 'POST');
    expect(post?.headers['x-api-key']).toBe('sk-test');
    expect(post?.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(post?.body ?? '{}') as {
      model: string;
      max_tokens: number;
      stream: boolean;
      system: { text: string; cache_control: unknown }[];
      messages: { role: string; content: { text: string; cache_control: unknown }[] }[];
      tools: { name: string; input_schema: unknown }[];
    };
    expect(body).toMatchObject({ model: 'claude-x', max_tokens: 32000, stream: true });
    expect(body.system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0]?.text).toContain('You are a Nix workspace companion');
    expect(body.messages.at(-1)?.content[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools.length).toBeGreaterThan(20);
    expect(body.tools[0]).toHaveProperty('input_schema');
  });

  it('connects by proving the key with one model listing, and uses the advertised default model', async () => {
    const server = await track(
      startServer((seen, res) => {
        if (seen.url.startsWith('/v1/models'))
          return jsonResponse(res, 200, {
            data: [{ id: 'claude-first' }, { id: 'claude-second' }],
          });
        sse(res, anthropicTurn('ok'));
      }),
    );
    const k = keyAccount('anthropic', server);
    const connected = await k.account.handle(k.signal, request({ operation: 'connect' }));
    expect(connected).toMatchObject({
      status: 'connected',
      reason: 'API key accepted.',
      provider: 'anthropic',
    });
    expect(connected.models.map((m) => m.id)).toEqual(['claude-first', 'claude-second']);
    await k.send();
    await eventually(() => server.seen.some((s) => s.method === 'POST'));
    expect(JSON.parse(server.seen.find((s) => s.method === 'POST')?.body ?? '{}')).toMatchObject({
      model: 'claude-first',
    });
  });

  it('falls back to the fixed catalog when models are not listed', async () => {
    const server = await track(
      startServer((_seen, res) => {
        jsonResponse(res, 404, {});
      }),
    );
    const k = keyAccount('anthropic', server);
    const models = await k.account.handle(k.signal, request({ operation: 'models' }));
    expect(models.models.map((m) => m.id)).toEqual([
      'claude-sonnet-4-5',
      'claude-opus-4-1',
      'claude-haiku-4-5',
    ]);
  });

  it('round-trips a tool call through the approval path', async () => {
    let round = 0;
    const server = await track(
      startServer((seen, res) => {
        if (seen.url.startsWith('/v1/models'))
          return jsonResponse(res, 200, { data: [{ id: 'claude-x' }] });
        round++;
        if (round === 1)
          return sse(
            res,
            anthropicTool(
              'toolu_1',
              'nix_read_note',
              `{"itemId":"${IDS.item}"}`,
              'Reading the note.',
            ),
          );
        sse(res, anthropicTurn('The note says hi.'));
      }),
    );
    const k = keyAccount('anthropic', server);
    await k.send({ workspaceAccess: true });
    await eventually(() => k.account.snapshot(key).tools.length === 1);
    expect(k.account.snapshot(key).messages.map((m) => m.text)).toContain('Reading the note.');
    await k.account.handle(
      k.signal,
      request({ operation: 'tool_claim', toolId: 'toolu_1', requestId: IDS.other }),
    );
    await k.account.handle(
      k.signal,
      request({
        operation: 'tool_result',
        toolId: 'toolu_1',
        requestId: IDS.other,
        toolResult: 'hi',
        toolSuccess: true,
      }),
    );
    await eventually(() => k.account.snapshot(key).state === 'success');
    expect(k.account.snapshot(key).messages.at(-1)?.text).toBe('The note says hi.');
    const second = JSON.parse(server.seen.filter((s) => s.method === 'POST')[1]?.body ?? '{}') as {
      messages: { role: string; content: unknown }[];
    };
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second.messages[2]?.content).toMatchObject([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'hi', is_error: false },
    ]);
    expect(second.messages[1]?.content).toMatchObject([
      { type: 'text' },
      { type: 'tool_use', id: 'toolu_1', name: 'nix_read_note', input: { itemId: IDS.item } },
    ]);
  });

  it('turns a refused tool into an error result the model sees, not a hang', async () => {
    let round = 0;
    const server = await track(
      startServer((seen, res) => {
        if (seen.url.startsWith('/v1/models'))
          return jsonResponse(res, 200, { data: [{ id: 'claude-x' }] });
        round++;
        sse(
          res,
          round === 1
            ? anthropicTool('toolu_1', 'nix_search', '{"query":"x"}')
            : anthropicTurn('done'),
        );
      }),
    );
    const k = keyAccount('anthropic', server);
    await k.send({ workspaceAccess: false });
    await eventually(() => k.account.snapshot(key).state === 'success');
    const second = JSON.parse(server.seen.filter((s) => s.method === 'POST')[1]?.body ?? '{}') as {
      messages: { content: unknown }[];
    };
    expect(JSON.stringify(second.messages.at(-1)?.content)).toContain(
      'That tool is not available in this conversation',
    );
  });

  it('ends an interrupted turn as interrupted, answering every pending call', async () => {
    let round = 0;
    const server = await track(
      startServer((seen, res) => {
        if (seen.url.startsWith('/v1/models'))
          return jsonResponse(res, 200, { data: [{ id: 'claude-x' }] });
        round++;
        sse(res, [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'a', name: 'nix_read_note' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: `{"itemId":"${IDS.item}"}` },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'b', name: 'nix_search' },
          },
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"query":"q"}' },
          },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
          { type: 'message_stop' },
        ]);
        void round;
      }),
    );
    const k = keyAccount('anthropic', server);
    await k.send({ workspaceAccess: true });
    await eventually(() => k.account.snapshot(key).tools.length === 1);
    await k.account.handle(k.signal, request({ operation: 'interrupt' }));
    await eventually(() => k.account.snapshot(key).state === 'idle');
    const saved = JSON.parse(
      readFileSync(join(k.home, 'threads', readdirSync(join(k.home, 'threads'))[0] ?? ''), 'utf8'),
    ) as { messages: { toolResults?: { callId: string; isError: boolean }[] }[] };
    expect(saved.messages.at(-1)?.toolResults?.map((r) => [r.callId, r.isError])).toEqual([
      ['a', true],
      ['b', true],
    ]);
  });

  it('fails an incomplete response and never runs its tool call', async () => {
    const server = await track(
      startServer((seen, res) => {
        if (seen.url.startsWith('/v1/models'))
          return jsonResponse(res, 200, { data: [{ id: 'claude-x' }] });
        sse(res, anthropicTool('a', 'nix_trash_item', `{"itemId":"${IDS.item}"}`).slice(0, -1));
      }),
    );
    const k = keyAccount('anthropic', server);
    await k.send({ workspaceAccess: true });
    await eventually(() => k.account.snapshot(key).state === 'error');
    expect(k.account.snapshot(key).tools).toEqual([]);
    expect(failure(k.events)).toContain('ended the response early');
  });

  it('refuses a truncated reply and a model refusal', async () => {
    for (const [stop, expected] of [
      ['max_tokens', 'length limit'],
      ['refusal', 'declined this request'],
    ] as const) {
      const server = await track(
        startServer((seen, res) => {
          if (seen.url.startsWith('/v1/models'))
            return jsonResponse(res, 200, { data: [{ id: 'claude-x' }] });
          sse(res, [
            { type: 'message_delta', delta: { stop_reason: stop } },
            { type: 'message_stop' },
          ]);
        }),
      );
      const k = keyAccount('anthropic', server);
      await k.send();
      await eventually(() => k.account.snapshot(key).state === 'error');
      expect(failure(k.events)).toContain(expected);
    }
  });

  it('fails a turn that ends with neither words nor tool calls', async () => {
    const server = await track(
      startServer((seen, res) => {
        if (seen.url.startsWith('/v1/models'))
          return jsonResponse(res, 200, { data: [{ id: 'claude-x' }] });
        sse(res, [
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          { type: 'message_stop' },
        ]);
      }),
    );
    const k = keyAccount('anthropic', server);
    await k.send();
    await eventually(() => k.account.snapshot(key).state === 'error');
    expect(failure(k.events)).toContain('finished without an answer');
  });

  it('explains a rejected key with a fixed message and no provider text', async () => {
    const server = await track(
      startServer((_seen, res) => {
        jsonResponse(res, 401, { error: { message: 'secret detail sk-test' } });
      }),
    );
    const k = keyAccount('anthropic', server);
    const connected = await k.account.handle(k.signal, request({ operation: 'connect' }));
    expect(connected.status).toBe('error');
    expect(connected.reason).toBe(
      'Claude rejected the API key. Update it in Settings > Pets. (HTTP 401)',
    );
    expect(JSON.stringify(connected)).not.toContain('secret detail');
    await expect(
      k.account.handle(k.signal, request({ operation: 'models' })),
    ).rejects.toMatchObject({ message: expect.stringContaining('rejected') as string });
  });

  it('never follows a redirect with the key or the prompt', async () => {
    const target = await track(
      startServer((_seen, res) => {
        jsonResponse(res, 200, {});
      }),
    );
    const server = await track(
      startServer((_seen, res) => {
        res.writeHead(302, { Location: `${target.url}/stolen` });
        res.end();
      }),
    );
    const k = keyAccount('anthropic', server);
    await k.account.handle(k.signal, request({ operation: 'connect' }));
    expect(target.seen).toEqual([]);
    expect(k.account.snapshot('').status).toBe('error');
    const failing = keyAccount('anthropic', server);
    await failing.send().catch(() => undefined);
    expect(target.seen).toEqual([]);
  });

  it('sends a tool result picture as an image block', async () => {
    let round = 0;
    const server = await track(
      startServer((seen, res) => {
        if (seen.url.startsWith('/v1/models'))
          return jsonResponse(res, 200, { data: [{ id: 'claude-x' }] });
        round++;
        sse(
          res,
          round === 1
            ? anthropicTool('a', 'nix_read_note', `{"itemId":"${IDS.item}"}`)
            : anthropicTurn('seen'),
        );
      }),
    );
    const k = keyAccount('anthropic', server);
    await k.send({ workspaceAccess: true });
    await eventually(() => k.account.snapshot(key).tools.length === 1);
    await k.account.handle(
      k.signal,
      request({ operation: 'tool_claim', toolId: 'a', requestId: IDS.other }),
    );
    await k.account.handle(
      k.signal,
      request({
        operation: 'tool_result',
        toolId: 'a',
        requestId: IDS.other,
        toolResult: 'a picture',
        toolSuccess: true,
        toolImage: 'data:image/jpeg;base64,/9j/AAAA',
      }),
    );
    await eventually(() => k.account.snapshot(key).state === 'success');
    const second = JSON.parse(server.seen.filter((s) => s.method === 'POST')[1]?.body ?? '{}') as {
      messages: { content: { content: unknown }[] }[];
    };
    expect(second.messages.at(-1)?.content[0]?.content).toEqual([
      { type: 'text', text: 'a picture' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/AAAA' } },
    ]);
  });

  it('survives a transport restart: a resumed thread keeps its history', async () => {
    const server = await track(
      startServer((seen, res) => {
        if (seen.url.startsWith('/v1/models'))
          return jsonResponse(res, 200, { data: [{ id: 'claude-x' }] });
        sse(res, anthropicTurn('first answer'));
      }),
    );
    const k = keyAccount('anthropic', server);
    await k.send();
    await eventually(() => k.account.snapshot(key).state === 'success');
    k.transport.close();
    expect(k.transport.alive()).toBe(false);
    const reborn = keyAccount('anthropic', server, k.home);
    reborn.account.load(key);
    await reborn.send({ requestId: IDS.other, text: 'second question' });
    await eventually(() => reborn.account.snapshot(key).messages.length === 4);
    const last = JSON.parse(
      server.seen.filter((s) => s.method === 'POST').at(-1)?.body ?? '{}',
    ) as { messages: { role: string; content: unknown }[] };
    expect(last.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('never saves an ephemeral thread and discards it on unsubscribe', async () => {
    const server = await track(
      startServer((_seen, res) => {
        sse(res, anthropicTurn('inline text'));
      }),
    );
    const k = keyAccount('anthropic', server);
    const started = (await k.transport.call('thread/start', {
      model: 'claude-x',
      baseInstructions: 'b',
      developerInstructions: '',
      ephemeral: true,
    })) as { thread: { id: string } };
    await k.transport.call('turn/start', {
      threadId: started.thread.id,
      input: [{ type: 'text', text: 'material' }],
    });
    await eventually(() => k.events.some((e) => e.method === 'turn/completed'));
    expect(existsSync(join(k.home, 'threads', `${started.thread.id}.json`))).toBe(false);
    await k.transport.call('thread/unsubscribe', { threadId: started.thread.id });
    await expect(
      k.transport.call('thread/resume', { threadId: started.thread.id }),
    ).rejects.toThrow('no longer available');
  });

  it('stops a model that keeps calling tools after 24 rounds', async () => {
    const server = await track(
      startServer((seen, res) => {
        if (seen.url.startsWith('/v1/models'))
          return jsonResponse(res, 200, { data: [{ id: 'claude-x' }] });
        sse(res, anthropicTool('a', 'nix_unknown', '{}'));
      }),
    );
    const k = keyAccount('anthropic', server);
    await k.send({ workspaceAccess: true });
    await eventually(() => k.account.snapshot(key).state === 'error');
    expect(server.seen.filter((s) => s.method === 'POST')).toHaveLength(MAX_TOOL_ROUNDS_PER_TURN);
    expect(failure(k.events)).toContain('kept calling tools');
  });

  it('keeps the key in memory only', async () => {
    const server = await track(
      startServer((seen, res) => {
        if (seen.url.startsWith('/v1/models'))
          return jsonResponse(res, 200, { data: [{ id: 'claude-x' }] });
        sse(res, anthropicTurn('ok'));
      }),
    );
    const k = keyAccount('anthropic', server, tempDir(), 'sk-very-secret');
    await k.send({ apiKey: 'sk-very-secret' });
    await eventually(() => k.account.snapshot(key).state === 'success');
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
      );
    for (const file of files(k.home))
      expect(readFileSync(file, 'utf8')).not.toContain('sk-very-secret');
  });
});

describe('OpenRouter', () => {
  const models = {
    data: [
      {
        id: 'anthropic/claude-x',
        name: 'Claude X',
        supported_parameters: ['tools'],
        architecture: { input_modalities: ['text', 'image'] },
      },
      {
        id: 'vendor/plain',
        name: 'Plain',
        supported_parameters: [],
        architecture: { input_modalities: ['text'] },
      },
      { id: 'vendor/tools', supported_parameters: ['tools', 'temperature'] },
    ],
  };
  const chunk = (delta: object, finish?: string): string =>
    JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] });

  it('lists models marking tool support, the first as default', async () => {
    const server = await track(
      startServer((_seen, res) => {
        jsonResponse(res, 200, models);
      }),
    );
    const k = keyAccount('openrouter', server);
    const listed = await k.account.handle(k.signal, request({ operation: 'models' }));
    expect(listed.models).toEqual([
      { id: 'anthropic/claude-x', name: 'Claude X', default: true, supportsTools: true },
      { id: 'vendor/plain', name: 'Plain', default: false, supportsTools: false },
      { id: 'vendor/tools', name: 'vendor/tools', default: false, supportsTools: true },
    ]);
    expect(server.seen[0]?.headers.authorization).toBe('Bearer sk-test');
  });

  it('streams text and tool calls in chat-completions shape, marking the system prompt cached only for Claude', async () => {
    let round = 0;
    const server = await track(
      startServer((seen, res) => {
        if (seen.url === '/models') return jsonResponse(res, 200, models);
        round++;
        if (round === 1) {
          return sse(res, [
            chunk({ content: 'Looking.' }),
            chunk({
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'nix_search', arguments: '{"que' } },
              ],
            }),
            chunk({ tool_calls: [{ index: 0, function: { arguments: 'ry":"plan"}' } }] }),
            chunk({}, 'tool_calls'),
            '[DONE]',
          ]);
        }
        sse(res, [chunk({ content: 'Found it.' }), chunk({}, 'stop'), '[DONE]']);
      }),
    );
    const k = keyAccount('openrouter', server);
    await k.send({ workspaceAccess: true });
    await eventually(() => k.account.snapshot(key).tools.length === 1);
    await k.account.handle(
      k.signal,
      request({ operation: 'tool_claim', toolId: 'call_1', requestId: IDS.other }),
    );
    await k.account.handle(
      k.signal,
      request({
        operation: 'tool_result',
        toolId: 'call_1',
        requestId: IDS.other,
        toolResult: 'one hit',
        toolSuccess: true,
      }),
    );
    await eventually(() => k.account.snapshot(key).state === 'success');
    const posts = server.seen
      .filter((s) => s.method === 'POST')
      .map(
        (s) =>
          JSON.parse(s.body) as {
            messages: {
              role: string;
              content: unknown;
              tool_calls?: unknown;
              tool_call_id?: string;
            }[];
            tools: { type: string; function: { name: string } }[];
          },
      );
    expect(posts[0]?.messages[0]?.content).toMatchObject([
      { type: 'text', cache_control: { type: 'ephemeral' } },
    ]);
    expect(posts[0]?.tools[0]).toMatchObject({
      type: 'function',
      function: { name: 'nix_list_items' },
    });
    expect(posts[1]?.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(posts[1]?.messages[2]?.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'nix_search', arguments: '{"query":"plan"}' },
      },
    ]);
    expect(posts[1]?.messages[3]).toMatchObject({ tool_call_id: 'call_1', content: 'one hit' });
    expect(k.account.snapshot(key).messages.at(-1)?.text).toBe('Found it.');
  });

  it('leaves the system prompt plain for a non-Claude model', async () => {
    const server = await track(
      startServer((seen, res) => {
        if (seen.url === '/models')
          return jsonResponse(res, 200, {
            data: [{ id: 'vendor/tools', supported_parameters: ['tools'] }],
          });
        sse(res, [chunk({ content: 'ok' }), '[DONE]']);
      }),
    );
    const k = keyAccount('openrouter', server);
    await k.send();
    await eventually(() => k.account.snapshot(key).state === 'success');
    const post = JSON.parse(server.seen.find((s) => s.method === 'POST')?.body ?? '{}') as {
      messages: { content: unknown }[];
    };
    expect(typeof post.messages[0]?.content).toBe('string');
  });

  it('refuses workspace access for a model that lists no tool support, and chats without it', async () => {
    const server = await track(
      startServer((seen, res) => {
        if (seen.url === '/models')
          return jsonResponse(res, 200, {
            data: [{ id: 'vendor/plain', supported_parameters: [] }],
          });
        sse(res, [chunk({ content: 'plain chat' }), '[DONE]']);
      }),
    );
    const k = keyAccount('openrouter', server);
    await expect(k.send({ workspaceAccess: true })).rejects.toThrow('model does not support tools');
    await k.send({ requestId: IDS.other, workspaceAccess: false });
    await eventually(() => k.account.snapshot(key).state === 'success');
    const post = JSON.parse(server.seen.find((s) => s.method === 'POST')?.body ?? '{}') as Record<
      string,
      unknown
    >;
    expect(post.tools).toBeUndefined();
  });

  it('puts a tool result picture in a user message, and drops it for a model that cannot see images', async () => {
    for (const [model, sees] of [
      ['anthropic/claude-x', true],
      ['vendor/plain', false],
    ] as const) {
      let round = 0;
      const server = await track(
        startServer((seen, res) => {
          if (seen.url === '/models') return jsonResponse(res, 200, models);
          round++;
          if (round === 1)
            return sse(res, [
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: 'c1',
                    function: { name: 'nix_read_note', arguments: `{"itemId":"${IDS.item}"}` },
                  },
                ],
              }),
              '[DONE]',
            ]);
          sse(res, [chunk({ content: 'ok' }), '[DONE]']);
        }),
      );
      const k = keyAccount('openrouter', server);
      // A model that cannot call tools is refused workspace access, so the picture case runs on tool-capable ones.
      const tools = model === 'vendor/plain' ? 'vendor/tools' : model;
      await k.send({ workspaceAccess: true, model: tools });
      await eventually(() => k.account.snapshot(key).tools.length === 1);
      await k.account.handle(
        k.signal,
        request({ operation: 'tool_claim', toolId: 'c1', requestId: IDS.other }),
      );
      await k.account.handle(
        k.signal,
        request({
          operation: 'tool_result',
          toolId: 'c1',
          requestId: IDS.other,
          toolResult: 'pic',
          toolSuccess: true,
          toolImage: 'data:image/jpeg;base64,AAAA',
        }),
      );
      await eventually(() => k.account.snapshot(key).state === 'success');
      const second = JSON.parse(
        server.seen.filter((s) => s.method === 'POST')[1]?.body ?? '{}',
      ) as { messages: { role: string; content: unknown }[] };
      const picture = second.messages.some((m) => JSON.stringify(m.content).includes('image_url'));
      expect(picture, tools).toBe(tools === 'anthropic/claude-x' ? sees : false);
      if (tools !== 'anthropic/claude-x')
        expect(JSON.stringify(second.messages)).toContain('cannot see images');
    }
  });
});

describe('provider failures', () => {
  const fake = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status });

  it('classify only bounded known failures without echoing text', async () => {
    expect((await providerResponseError('anthropic', fake(401, {}), false)).token()).toBe(
      'anthropic.authentication.401',
    );
    expect((await providerResponseError('anthropic', fake(403, {}), false)).token()).toBe(
      'anthropic.permission.403',
    );
    expect((await providerResponseError('openrouter', fake(402, {}), false)).token()).toBe(
      'openrouter.credit_balance.402',
    );
    expect((await providerResponseError('openrouter', fake(429, {}), false)).token()).toBe(
      'openrouter.rate_limited.429',
    );
    expect((await providerResponseError('openrouter', fake(400, {}), true)).token()).toBe('');
    const credit = {
      error: {
        type: 'invalid_request_error',
        message: 'Your credit balance is too low to access the API',
      },
    };
    expect((await providerResponseError('anthropic', fake(400, credit), false)).token()).toBe(
      'anthropic.credit_balance.400',
    );
    const other = { error: { type: 'invalid_request_error', message: 'prompt is too long' } };
    expect((await providerResponseError('anthropic', fake(400, other), true)).token()).toBe(
      'anthropic.models_rejected.400',
    );
    expect((await providerResponseError('anthropic', fake(400, other), false)).token()).toBe('');
    expect(
      (
        await providerResponseError('anthropic', new Response('not json', { status: 400 }), true)
      ).token(),
    ).toBe('');
    expect((await providerResponseError('anthropic', fake(500, {}), false)).message).toBe(
      'anthropic answered HTTP 500',
    );
  });

  it('trust only matching fixed codes', () => {
    expect(providerFailureMessage('anthropic', 'anthropic.authentication.401')).toContain(
      'Claude rejected the API key',
    );
    expect(providerFailureMessage('openrouter', 'openrouter.authentication.401')).toContain(
      'OpenRouter rejected the API key',
    );
    expect(providerFailureMessage('openrouter', 'anthropic.authentication.401')).toBe('');
    expect(providerFailureMessage('chatgpt', 'chatgpt.authentication.401')).toBe('');
    expect(providerFailureMessage('openrouter', 'openrouter.credit_balance.400')).toBe('');
    expect(providerFailureMessage('openrouter', 'openrouter.models_rejected.400')).toBe('');
    expect(providerFailureMessage('anthropic', 'anthropic.credit_balance.400')).toContain(
      'insufficient credit',
    );
    expect(providerFailureMessage('anthropic', 'anthropic.made_up.500')).toBe('');
  });

  it('carry the provider code into the turn failure message and nothing else', async () => {
    const server = await track(
      startServer((seen, res) => {
        if (seen.url.startsWith('/v1/models'))
          return jsonResponse(res, 200, { data: [{ id: 'claude-x' }] });
        jsonResponse(res, 429, { error: { message: 'private prompt echo' } });
      }),
    );
    const k = keyAccount('anthropic', server);
    await k.send();
    await eventually(() => k.account.snapshot(key).state === 'error');
    expect(k.account.snapshot(key).reason).toBe(
      'Claude is rate limiting this API key. Wait briefly, then try again.',
    );
    expect(JSON.stringify(k.events)).not.toContain('private prompt echo');
  });
});

describe('thread trimming', () => {
  const user = (text: string): ProviderMessage => ({ role: 'user', text });
  const assistant = (text: string): ProviderMessage => ({ role: 'assistant', text });
  const thread = (messages: ProviderMessage[], opening?: string): HttpThread => ({
    id: 't',
    model: 'm',
    system: '',
    tools: [],
    messages,
    ephemeral: false,
    usage: {
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
    },
    ...(opening === undefined ? {} : { opening }),
  });

  it('keeps the last 12 turns and repeats the opening message at the head', () => {
    const messages: ProviderMessage[] = [user('{"workspaceMap":[1]} first')];
    for (let i = 0; i < 14; i++) messages.push(assistant(`a${String(i)}`), user(`u${String(i)}`));
    const t = thread(messages);
    trimThread(t);
    expect(t.messages.filter((m) => m.role === 'user' && !m.toolResults).length).toBe(
      MAX_THREAD_TURNS,
    );
    expect(t.messages[0]?.role).toBe('user');
    expect(t.messages[0]?.text).toContain(
      'The conversation began with this message; its earlier turns were dropped to save space:\n{"workspaceMap":[1]} first',
    );
    expect(t.opening).toBe('{"workspaceMap":[1]} first');
  });

  it('never starts on a tool result', () => {
    const messages: ProviderMessage[] = [];
    for (let i = 0; i < 15; i++) {
      messages.push(
        user(`u${String(i)}`),
        { role: 'assistant', toolCalls: [{ id: `c${String(i)}`, name: 'n', arguments: {} }] },
        { role: 'user', toolResults: [{ callId: `c${String(i)}`, text: 'r', isError: false }] },
        assistant('done'),
      );
    }
    const t = thread(messages);
    trimThread(t);
    expect(t.messages[0]?.toolResults).toBeUndefined();
    expect(t.messages[0]?.role).toBe('user');
  });

  it('drops old turns past the byte bound but never the latest', () => {
    const big = 'x'.repeat(MAX_THREAD_BYTES / 3);
    const t = thread([
      user(big),
      assistant('a'),
      user(big),
      assistant('b'),
      user(big),
      assistant('c'),
      user(big),
    ]);
    trimThread(t);
    expect(t.messages.at(-1)?.text).toBe(big);
    expect(t.messages.length).toBeLessThan(7);
    const only = thread([user('x'.repeat(MAX_THREAD_BYTES * 2))]);
    trimThread(only);
    expect(only.messages).toHaveLength(1);
  });

  it('gives no stray opening to a thread cut before opening existed', () => {
    const messages: ProviderMessage[] = [];
    for (let i = 0; i < 14; i++) messages.push(user(`u${String(i)}`), assistant('a'));
    const t = thread(messages);
    trimThread(t);
    expect(t.opening).toBe('');
    expect(t.messages[0]?.text).toBe('u2');
  });

  it('is not pushed out by a busy turn: tool rounds count as one turn', () => {
    const messages: ProviderMessage[] = [];
    for (let i = 0; i < 12; i++) messages.push(user(`u${String(i)}`), assistant('a'));
    for (let i = 0; i < 20; i++)
      messages.push(
        { role: 'assistant', toolCalls: [{ id: `c${String(i)}`, name: 'n', arguments: {} }] },
        { role: 'user', toolResults: [{ callId: `c${String(i)}`, text: 'r', isError: false }] },
      );
    const t = thread(messages);
    trimThread(t);
    expect(t.messages[0]?.text).toBe('u0');
  });
});
