import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ResponsesReplay } from './responses-wire.ts';
import { emptyUsage, openrouterWire, type HttpThread, type WireContext } from './wire.ts';

const models = ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6-astra', 'gpt-6.1-sol'];
const thread = (model: string): HttpThread => ({
  id: 'fixture',
  model,
  system: 'Synthetic instructions.',
  tools: [
    {
      name: 'nix_list_items',
      description: 'List items.',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  ],
  messages: [{ role: 'user', text: 'Synthetic question.' }],
  ephemeral: true,
  usage: emptyUsage(),
});

const message = (
  text = 'Done.',
): Extract<ResponsesReplay['items'][number], { type: 'message' }> => ({
  type: 'message',
  id: 'msg_fixture',
  role: 'assistant',
  phase: 'final_answer',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
});
const reasoning = {
  type: 'reasoning',
  id: 'rs_fixture',
  summary: [],
  encrypted_content: 'enc_SYNTHETIC_FINAL',
  status: 'completed',
} satisfies ResponsesReplay['items'][number];
const call = {
  type: 'function_call',
  id: 'fc_fixture',
  call_id: 'call_fixture',
  name: 'nix_list_items',
  arguments: '{"parentId":"root"}',
  status: 'completed',
} satisfies ResponsesReplay['items'][number];
const complete = (output: unknown[] = [message()]) => ({
  type: 'response.completed',
  response: {
    status: 'completed',
    output,
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 3 },
      output_tokens: 40,
      output_tokens_details: { reasoning_tokens: 10 },
    },
  },
});
const sseBody = (events: unknown[]): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
const pathOf = (url: Parameters<typeof globalThis.fetch>[0]): string =>
  new URL(url instanceof Request ? url.url : url).pathname;
function fixture(events: unknown[] = [complete()]) {
  const requests: { path: string; body: Record<string, unknown>; init: RequestInit | undefined }[] =
    [];
  const context: WireContext = {
    kind: 'openai',
    base: 'https://fixture.invalid/v1',
    apiKey: 'synthetic',
    recipientRevision: 'synthetic-recipient',
    signal: new AbortController().signal,
    fetch: (url, init) => {
      requests.push({
        path: pathOf(url),
        body: z.record(z.string(), z.unknown()).parse(JSON.parse(z.string().parse(init?.body))),
        init,
      });
      return Promise.resolve(
        new Response(sseBody(events), { headers: { 'content-type': 'text/event-stream' } }),
      );
    },
  };
  return { context, requests };
}

describe('native OpenAI Responses', () => {
  it.each(models)('uses the supported tool endpoint for %s', async (model) => {
    let requestedPath = '';
    const fetch: typeof globalThis.fetch = (url) => {
      requestedPath = pathOf(url);
      return Promise.resolve(
        new Response(
          `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [], logprobs: [] }] }] } })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    };
    const result = await openrouterWire.stream(
      {
        kind: 'openai',
        fetch,
        base: 'https://fixture.invalid/v1',
        apiKey: 'synthetic',
        signal: new AbortController().signal,
      },
      thread(model),
      () => undefined,
    );
    expect(requestedPath).toBe('/v1/responses');
    expect(result.text).toBe('Done.');
  });

  it('uses stateless non-strict functions without changing optional parameters', async () => {
    const f = fixture();
    const t = thread(models[0] ?? '');
    const parameters = {
      type: 'object',
      properties: { parentId: { type: 'string' } },
      required: [],
      additionalProperties: false,
    };
    t.tools = [{ name: 'nix_list_items', description: 'List items.', inputSchema: parameters }];
    await openrouterWire.stream(f.context, t, () => undefined);
    expect(f.requests[0]?.init).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: 'Bearer synthetic' },
    });
    expect(f.requests[0]?.body).toEqual({
      model: t.model,
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      input: [
        { role: 'developer', content: t.system },
        { role: 'user', content: 'Synthetic question.' },
      ],
      tools: [
        {
          type: 'function',
          name: 'nix_list_items',
          description: 'List items.',
          parameters,
          strict: false,
        },
      ],
    });
    expect(t.usage).toEqual({
      input_tokens: 100,
      output_tokens: 40,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 3,
    });
  });

  it('keeps tool-free native model turns on Responses', async () => {
    const f = fixture();
    const t = thread('gpt-6.2-sol');
    t.tools = [];
    await openrouterWire.stream(f.context, t, () => undefined);
    expect(f.requests[0]?.path).toBe('/v1/responses');
    expect(f.requests[0]?.body.tools).toBeUndefined();
  });

  it('replays completed reasoning, phases and calls in order with native image outputs', async () => {
    const output = [reasoning, { ...message('Reading.'), phase: 'commentary' }, call];
    const f = fixture([
      {
        type: 'response.output_item.added',
        item: { ...reasoning, encrypted_content: 'enc_SYNTHETIC_PARTIAL', status: 'in_progress' },
      },
      { type: 'response.output_item.done', item: reasoning },
      { type: 'response.output_text.delta', delta: 'Reading.' },
      { type: 'response.function_call_arguments.delta', item_id: call.id, delta: '{"parentId":' },
      { type: 'response.function_call_arguments.delta', item_id: call.id, delta: '"root"}' },
      {
        type: 'response.function_call_arguments.done',
        item_id: call.id,
        arguments: call.arguments,
      },
      { type: 'response.output_item.done', item: call },
      complete(output),
    ]);
    const t = thread('gpt-6.2-sol');
    const deltas: string[] = [];
    const result = await openrouterWire.stream(f.context, t, (delta) => deltas.push(delta));
    expect(deltas).toEqual(['Reading.']);
    expect(result.calls).toEqual([
      { id: call.call_id, name: call.name, arguments: { parentId: 'root' } },
    ]);
    t.messages.push({
      role: 'assistant',
      text: result.text,
      toolCalls: result.calls,
      responses: result.responses,
    });
    t.messages.push({
      role: 'user',
      toolResults: [
        {
          callId: call.call_id,
          text: 'Synthetic picture.',
          image: 'data:image/jpeg;base64,/9j/2Q==',
          isError: false,
        },
      ],
    });
    const next = fixture();
    await openrouterWire.stream(next.context, t, () => undefined);
    expect(next.requests[0]?.body.input).toEqual([
      { role: 'developer', content: t.system },
      { role: 'user', content: 'Synthetic question.' },
      ...output,
      {
        type: 'function_call_output',
        call_id: call.call_id,
        output: [
          { type: 'input_text', text: 'Synthetic picture.' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/2Q==', detail: 'auto' },
        ],
      },
    ]);
  });

  it('keeps calls ordered when their argument events arrive in another order', async () => {
    const second = { ...call, id: 'fc_second', call_id: 'call_second', arguments: '{}' };
    const f = fixture([
      { type: 'response.function_call_arguments.done', item_id: second.id, arguments: '{}' },
      {
        type: 'response.function_call_arguments.done',
        item_id: call.id,
        arguments: call.arguments,
      },
      complete([reasoning, call, second]),
    ]);
    const result = await openrouterWire.stream(f.context, thread('gpt-6.2-sol'), () => undefined);
    expect(result.calls.map((item) => item.id)).toEqual(['call_fixture', 'call_second']);
  });

  it.each(
    [
      [{ type: 'error', message: 'private upstream body' }],
      [{ type: 'response.failed', response: { error: { message: 'private upstream body' } } }],
      [
        {
          type: 'response.incomplete',
          response: { incomplete_details: { reason: 'max_output_tokens' } },
        },
      ],
      [],
    ].map((end) => ({ end })),
  )('refuses partial calls without a successful terminal event %j', async ({ end }) => {
    const f = fixture([{ type: 'response.output_item.done', item: call }, ...end]);
    const failure = await openrouterWire
      .stream(f.context, thread('gpt-6.2-sol'), () => undefined)
      .then(
        () => undefined,
        (error: unknown) => String(error),
      );
    expect(failure).toMatch(/OpenAI (reported|stopped|returned)/);
    expect(failure).not.toContain('private upstream body');
    expect(failure).not.toContain('nothing was changed');
  });

  it.each(
    [
      [{ ...call, arguments: '[]' }],
      [{ ...call, arguments: '{broken' }],
      [{ ...call, call_id: '' }],
      [{ ...call, name: 'unknown_tool' }],
      [{ ...call, namespace: 'unregistered' }],
      [{ ...call, async: true }],
      [{ ...call, caller: { type: 'program', caller_id: 'unregistered' } }],
      [call, { ...call, id: 'fc_duplicate' }],
      [{ ...call, type: 'shell_call' }],
    ].map((output) => ({ output })),
  )('refuses malformed or unexpected executable output %j', async ({ output }) => {
    const f = fixture([complete(output)]);
    await expect(
      openrouterWire.stream(f.context, thread('gpt-6.2-sol'), () => undefined),
    ).rejects.toThrow('unusable response');
  });

  it('decodes split UTF-8 and emits text only once despite final copies', async () => {
    const f = fixture();
    const events = [
      { type: 'response.output_text.delta', delta: 'café' },
      { type: 'response.output_text.done', text: 'café' },
      { type: 'response.output_item.done', item: message('café') },
      complete([message('café')]),
    ];
    const bytes = new TextEncoder().encode(sseBody(events));
    f.context.fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
              controller.close();
            },
          }),
        ),
      );
    const deltas: string[] = [];
    const result = await openrouterWire.stream(f.context, thread('gpt-6.2-sol'), (delta) =>
      deltas.push(delta),
    );
    expect(deltas).toEqual(['café']);
    expect(result.text).toBe('café');
  });

  it('cancels a waiting response reader on abort', async () => {
    const f = fixture();
    const abort = new AbortController();
    f.context.signal = abort.signal;
    let cancelled = false;
    f.context.fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
      );
    const pending = openrouterWire.stream(f.context, thread('gpt-6.2-sol'), () => undefined);
    abort.abort();
    await expect(pending).rejects.toThrow();
    expect(cancelled).toBe(true);
  });

  it('converts closed legacy history and invalidates opaque reasoning across model switches', async () => {
    const t = thread('gpt-6.2-sol');
    t.messages.push(
      {
        role: 'assistant',
        text: 'Earlier.',
        toolCalls: [{ id: 'legacy_call', name: 'nix_list_items', arguments: {} }],
      },
      { role: 'user', toolResults: [{ callId: 'legacy_call', text: 'Declined.', isError: true }] },
    );
    const first = fixture();
    const result = await openrouterWire.stream(first.context, t, () => undefined);
    expect(first.requests[0]?.body.input).toContainEqual({
      type: 'function_call',
      call_id: 'legacy_call',
      name: 'nix_list_items',
      arguments: '{}',
    });
    t.messages.push({
      role: 'assistant',
      text: result.text,
      responses: { model: t.model, items: [reasoning] },
    });
    t.model = 'gpt-4.1';
    const old = fixture();
    old.context.fetch = () => Promise.resolve(new Response('data: [DONE]\n\n'));
    await openrouterWire.stream(old.context, t, () => undefined);
    t.model = 'gpt-6.2-sol';
    const next = fixture();
    await openrouterWire.stream(next.context, t, () => undefined);
    expect(JSON.stringify(next.requests[0]?.body)).not.toContain('enc_SYNTHETIC_FINAL');
  });

  it('preserves existing other-provider and older native OpenAI routing', async () => {
    for (const kind of ['openrouter', 'openai']) {
      const f = fixture();
      f.context.kind = kind;
      const t = thread(kind === 'openrouter' ? 'gpt-6.2-sol' : 'gpt-4.1');
      await openrouterWire.stream(f.context, t, () => undefined);
      expect(f.requests[0]?.path).toBe('/v1/chat/completions');
    }
  });
});

describe('terminal response consistency and recipient replay', () => {
  it.each(['in_progress', 'incomplete'])(
    'rejects final %s even after output_item.done completed',
    async (terminalStatus) => {
      const f = fixture([
        { type: 'response.output_item.done', item: call },
        complete([{ ...call, status: terminalStatus }]),
      ]);
      await expect(
        openrouterWire.stream(f.context, thread('gpt-6.2-sol'), () => undefined),
      ).rejects.toThrow('unusable response');
    },
  );

  it('rejects contradictory final text after a completed item', async () => {
    const f = fixture([
      { type: 'response.output_item.done', item: message('First') },
      complete([message('Changed')]),
    ]);
    await expect(
      openrouterWire.stream(f.context, thread('gpt-6.2-sol'), () => undefined),
    ).rejects.toThrow('unusable response');
  });

  it('removes opaque reasoning after recipient change while retaining ordered semantic history', async () => {
    const t = thread('gpt-6.2-sol');
    t.messages.push({
      role: 'assistant',
      text: 'Earlier answer',
      responses: {
        model: t.model,
        recipientRevision: 'old-recipient',
        items: [reasoning, message('Earlier answer')],
      },
    });
    const f = fixture();
    await openrouterWire.stream(f.context, t, () => undefined);
    expect(JSON.stringify(f.requests[0]?.body)).not.toContain('enc_SYNTHETIC_FINAL');
    expect(JSON.stringify(f.requests[0]?.body)).toContain('Earlier answer');
  });
});
