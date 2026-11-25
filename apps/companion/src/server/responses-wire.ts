import { z } from 'zod';

import { providerResponseError } from '../providers/provider-errors.ts';
import {
  PROVIDER_TIMEOUT_MS,
  readSse,
  type HttpThread,
  type ProviderStreamResult,
  type WireContext,
} from './wire.ts';

const responseModels = new Set(['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6-astra', 'gpt-6.1-sol']);

export const requiresResponses = (model: string): boolean => responseModels.has(model);

const status = z.enum(['in_progress', 'completed', 'incomplete']).optional();
const textPart = z.object({
  type: z.literal('output_text'),
  text: z.string(),
  annotations: z.array(z.unknown()).default([]),
  logprobs: z.array(z.unknown()).default([]),
});
const outputItem = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('reasoning'),
    id: z.string().min(1),
    summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string() })),
    encrypted_content: z.string().min(1),
    status,
  }),
  z.object({
    type: z.literal('message'),
    id: z.string().min(1),
    role: z.literal('assistant'),
    phase: z.enum(['commentary', 'final_answer']).nullable().optional(),
    content: z.array(
      z.union([textPart, z.object({ type: z.literal('refusal'), refusal: z.string() })]),
    ),
    status,
  }),
  z.object({
    type: z.literal('function_call'),
    id: z.string().min(1),
    call_id: z.string().min(1),
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    arguments: z.string(),
    status,
    async: z.literal(false).optional(),
    namespace: z.never().optional(),
    caller: z
      .object({ type: z.literal('direct') })
      .nullable()
      .optional(),
  }),
]);

export const responsesReplaySchema = z.object({
  model: z.string(),
  recipientRevision: z.string().optional(),
  items: z.array(outputItem),
});
export type ResponsesReplay = z.infer<typeof responsesReplaySchema>;
type OutputItem = z.infer<typeof outputItem>;

export function discardIncompatibleReasoning(thread: HttpThread, recipientRevision?: string): void {
  for (const message of thread.messages) {
    if (
      message.responses !== undefined &&
      (message.responses.model !== thread.model ||
        !recipientRevision ||
        message.responses.recipientRevision !== recipientRevision)
    )
      message.responses.items = message.responses.items.filter((item) => item.type !== 'reasoning');
  }
}

const toolSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
const eventSchema = z.object({
  type: z.string(),
  delta: z.string().optional(),
  item: z.unknown().optional(),
  item_id: z.string().optional(),
  arguments: z.string().optional(),
  response: z.unknown().optional(),
});
const count = z.number().int().nonnegative();
const completedSchema = z.object({
  status: z.literal('completed'),
  output: z.array(outputItem).max(512),
  usage: z
    .object({
      input_tokens: count,
      output_tokens: count,
      input_tokens_details: z
        .object({
          cached_tokens: count.optional(),
          cache_write_tokens: count.optional(),
        })
        .optional(),
    })
    .nullable()
    .optional(),
});

const invalidResponse = (): Error =>
  new Error('OpenAI returned an unusable response. Retry the message.');

function inputItems(thread: HttpThread): unknown[] {
  const input: unknown[] = [{ role: 'developer', content: thread.system }];
  for (const message of thread.messages) {
    if (message.role === 'assistant') {
      if (message.responses !== undefined) {
        const replay = responsesReplaySchema.safeParse(message.responses);
        if (!replay.success) throw invalidResponse();
        input.push(...replay.data.items);
      } else {
        if (message.text) input.push({ role: 'assistant', content: message.text });
        for (const call of message.toolCalls ?? [])
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments ?? {}),
          });
      }
    } else if ((message.toolResults?.length ?? 0) > 0) {
      for (const result of message.toolResults ?? [])
        input.push({
          type: 'function_call_output',
          call_id: result.callId,
          output: result.image
            ? [
                { type: 'input_text', text: result.text },
                { type: 'input_image', image_url: result.image, detail: 'auto' },
              ]
            : result.text,
        });
    } else {
      input.push({ role: 'user', content: message.text ?? '' });
    }
  }
  return input;
}

export async function streamResponses(
  context: WireContext,
  thread: HttpThread,
  onDelta: (delta: string) => void,
): Promise<ProviderStreamResult> {
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)]);
  signal.throwIfAborted();
  const declared = z.array(toolSchema).max(128).safeParse(thread.tools);
  if (!declared.success) throw invalidResponse();
  const names = new Set(declared.data.map((tool) => tool.name));
  if (names.size !== declared.data.length) throw invalidResponse();
  const body = {
    model: thread.model,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    input: inputItems(thread),
    ...(declared.data.length === 0
      ? {}
      : {
          tools: declared.data.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: false,
          })),
        }),
  };
  let response: Response;
  try {
    response = await context.fetch(`${context.base || 'https://api.openai.com/v1'}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${context.apiKey}`, 'content-type': 'application/json' },
      redirect: 'manual',
      signal,
      body: JSON.stringify(body),
    });
  } catch {
    signal.throwIfAborted();
    throw new Error('OpenAI could not be reached');
  }
  if (response.status !== 200) throw await providerResponseError('openai', response, false);
  const state: { completed?: z.infer<typeof completedSchema> } = {};
  const finished = new Map<string, OutputItem>();
  const argumentsByItem = new Map<string, string>();
  let receivedBytes = 0;
  await readSse(signal, response, (data) => {
    receivedBytes += Buffer.byteLength(data);
    if (receivedBytes > 4 << 20) throw invalidResponse();
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      throw invalidResponse();
    }
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) throw invalidResponse();
    const event = parsed.data;
    if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      if (event.delta === undefined) throw invalidResponse();
      onDelta(event.delta);
    } else if (event.type === 'response.function_call_arguments.delta') {
      if (!event.item_id || event.delta === undefined) throw invalidResponse();
      argumentsByItem.set(event.item_id, (argumentsByItem.get(event.item_id) ?? '') + event.delta);
    } else if (event.type === 'response.function_call_arguments.done') {
      if (!event.item_id || event.arguments === undefined) throw invalidResponse();
      argumentsByItem.set(event.item_id, event.arguments);
    } else if (event.type === 'response.output_item.done') {
      const item = outputItem.safeParse(event.item);
      if (!item.success || item.data.status === 'incomplete' || item.data.status === 'in_progress')
        throw invalidResponse();
      const previous = finished.get(item.data.id);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(item.data))
        throw invalidResponse();
      finished.set(item.data.id, item.data);
    } else if (event.type === 'error' || event.type === 'response.failed') {
      throw new Error('OpenAI reported an error during the response. Retry the message.');
    } else if (event.type === 'response.incomplete') {
      throw new Error(
        'OpenAI stopped before finishing this response. Review earlier tool results before retrying.',
      );
    } else if (event.type === 'response.completed') {
      const completed = completedSchema.safeParse(event.response);
      if (!completed.success) throw invalidResponse();
      state.completed = completed.data;
      return true;
    }
  });
  signal.throwIfAborted();
  const completed = state.completed;
  if (completed === undefined) throw invalidResponse();
  const items = completed.output.map((item) => {
    if (item.status === 'incomplete' || item.status === 'in_progress') throw invalidResponse();
    const done = finished.get(item.id);
    if (
      done !== undefined &&
      JSON.stringify({ ...done, status: done.status ?? 'completed' }) !==
        JSON.stringify({ ...item, status: item.status ?? 'completed' })
    )
      throw invalidResponse();
    if (
      done?.type === 'function_call' &&
      item.type === 'function_call' &&
      (done.call_id !== item.call_id ||
        done.name !== item.name ||
        done.arguments !== item.arguments)
    )
      throw invalidResponse();
    return done ?? item;
  });
  const calls: ProviderStreamResult['calls'] = [];
  const callIds = new Set<string>();
  const itemIds = new Set<string>();
  const text: string[] = [];
  for (const item of items) {
    if (itemIds.has(item.id) || item.status === 'incomplete' || item.status === 'in_progress')
      throw invalidResponse();
    itemIds.add(item.id);
    if (item.type === 'message')
      text.push(
        item.content
          .map((part) => (part.type === 'output_text' ? part.text : part.refusal))
          .join(''),
      );
    if (item.type !== 'function_call') continue;
    if (!names.has(item.name) || callIds.has(item.call_id)) throw invalidResponse();
    callIds.add(item.call_id);
    let args: unknown;
    try {
      args = JSON.parse(item.arguments);
    } catch {
      throw invalidResponse();
    }
    const parsed = z.record(z.string(), z.unknown()).safeParse(args);
    if (!parsed.success) throw invalidResponse();
    const finalArguments = argumentsByItem.get(item.id);
    if (finalArguments !== undefined && finalArguments !== item.arguments) throw invalidResponse();
    calls.push({ id: item.call_id, name: item.name, arguments: parsed.data });
  }
  const usage = completed.usage;
  if (usage) {
    thread.usage.input_tokens += usage.input_tokens;
    thread.usage.output_tokens += usage.output_tokens;
    thread.usage.cache_read_input_tokens += usage.input_tokens_details?.cached_tokens ?? 0;
    thread.usage.cache_creation_input_tokens += usage.input_tokens_details?.cache_write_tokens ?? 0;
  }
  return {
    text: text.join('\n\n'),
    calls,
    responses: {
      model: thread.model,
      ...(context.recipientRevision === undefined
        ? {}
        : { recipientRevision: context.recipientRevision }),
      items,
    },
  };
}
