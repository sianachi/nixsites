import { providerResponseError, readBounded } from './provider-errors.ts';
import type { ModelInfo, ProviderUsage } from './types.ts';
import { isRecord, str } from './util.ts';

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ProviderToolResult {
  callId: string;
  text: string;
  isError: boolean;
  /** A picture the result carried, a JPEG data URL; each wire encodes it its own way. */
  image?: string | undefined;
}

export interface ProviderMessage {
  role: string;
  text?: string | undefined;
  toolCalls?: ProviderToolCall[] | undefined;
  /** Answers the previous assistant message's toolCalls, in order. */
  toolResults?: ProviderToolResult[] | undefined;
}

export interface HttpThread {
  id: string;
  model: string;
  system: string;
  tools: unknown[];
  messages: ProviderMessage[];
  /** The first user message, kept once trimming has dropped it: it carries the workspace map. */
  opening?: string | undefined;
  ephemeral: boolean;
  usage: ProviderUsage;
}

export const emptyUsage = (): ProviderUsage => ({
  input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 0,
});

export interface WireContext {
  fetch: typeof fetch;
  base: string;
  apiKey: string;
  signal: AbortSignal;
}

export interface ProviderWire {
  listModels(context: WireContext): Promise<ModelInfo[]>;
  stream(
    context: WireContext,
    thread: HttpThread,
    onDelta: (delta: string) => void,
  ): Promise<{ text: string; calls: ProviderToolCall[] }>;
}

/** Bounds one provider request; the 15-minute thinking expiry is the outer guard. */
export const PROVIDER_TIMEOUT_MS = 10 * 60 * 1000;
const LIST_TIMEOUT_MS = 20_000;

export class ResponseTooLongError extends Error {
  constructor() {
    super(
      "The reply reached the model's length limit before it finished, so nothing was changed. Ask for a smaller piece at a time",
    );
  }
}

/** Calls onData for each `data:` line of an event stream until it ends; `[DONE]` ends it early. */
async function readSse(
  signal: AbortSignal,
  response: Response,
  onData: (data: string) => void,
): Promise<void> {
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) return;
  const decoder = new TextDecoder();
  let buffer = '';
  const handle = (line: string): boolean => {
    if (line.startsWith('data:') && line.length > 5) {
      const data = line.slice(5).replace(/^[ \t]+|[ \t\r]+$/g, '');
      if (data === '[DONE]') return true;
      onData(data);
    }
    return false;
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (handle(line)) return;
      }
      if (buffer.length > 1 << 20) throw new Error('provider stream line too long');
    }
    buffer += decoder.decode();
    if (buffer !== '') handle(buffer);
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/** A tool call's arguments are a JSON object; text that is not one is replaced by an empty one. */
function argumentsOf(text: string): unknown {
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function splitDataUrl(url: string | undefined): { media: string; data: string } | undefined {
  if (!url?.startsWith('data:')) return undefined;
  const rest = url.slice(5);
  const cut = rest.indexOf(';base64,');
  if (cut === -1) return undefined;
  const media = rest.slice(0, cut);
  const data = rest.slice(cut + 8);
  return media !== '' && data !== '' ? { media, data } : undefined;
}

function declaredTools(
  tools: unknown[],
): { name: string; description: string; inputSchema: unknown }[] {
  const declared: { name: string; description: string; inputSchema: unknown }[] = [];
  for (const tool of tools) {
    if (isRecord(tool) && str(tool.name) !== '') {
      declared.push({
        name: str(tool.name),
        description: str(tool.description),
        inputSchema: tool.inputSchema,
      });
    }
  }
  return declared;
}

const EPHEMERAL = { type: 'ephemeral' } as const;

// ---- Anthropic ----

const ANTHROPIC_BASE = 'https://api.anthropic.com';
// Thinking counts against it and a whole structure draft arrives as one tool call; 32000 is the
// lowest cap among the models a key may list (Opus 4/4.1).
const ANTHROPIC_MAX_TOKENS = 32000;

const ANTHROPIC_MODELS: readonly ModelInfo[] = [
  {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    default: true,
    supportsTools: true,
    supportedEfforts: [],
    defaultEffort: '',
    textOnly: false,
  },
  {
    id: 'claude-opus-4-1',
    name: 'Claude Opus 4.1',
    default: false,
    supportsTools: true,
    supportedEfforts: [],
    defaultEffort: '',
    textOnly: false,
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    default: false,
    supportsTools: true,
    supportedEfforts: [],
    defaultEffort: '',
    textOnly: false,
  },
];

function anthropicInit(apiKey: string, signal: AbortSignal, body?: unknown): RequestInit {
  return {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    redirect: 'manual',
    signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

type Block = Record<string, unknown>;

function markLastBlockCached(messages: { role: string; content: string | Block[] }[]): void {
  const last = messages[messages.length - 1];
  if (last === undefined) return;
  if (typeof last.content === 'string') {
    if (last.content !== '')
      last.content = [{ type: 'text', text: last.content, cache_control: EPHEMERAL }];
  } else {
    const block = last.content[last.content.length - 1];
    if (block !== undefined) block.cache_control = EPHEMERAL;
  }
}

export const anthropicWire: ProviderWire = {
  async listModels({ fetch: doFetch, base, apiKey, signal }) {
    const timed = AbortSignal.any([signal, AbortSignal.timeout(LIST_TIMEOUT_MS)]);
    let response: Response;
    try {
      response = await doFetch(
        `${base === '' ? ANTHROPIC_BASE : base}/v1/models?limit=100`,
        anthropicInit(apiKey, timed),
      );
    } catch {
      throw new Error('Anthropic could not be reached');
    }
    if (response.status === 404) return ANTHROPIC_MODELS.map((m) => ({ ...m }));
    if (response.status !== 200) throw await providerResponseError('anthropic', response, true);
    let page: unknown;
    try {
      page = JSON.parse(await readBounded(response, 256 << 10));
    } catch {
      throw new Error('Anthropic returned an unreadable model list');
    }
    const data = isRecord(page) && Array.isArray(page.data) ? (page.data as unknown[]) : [];
    const models: ModelInfo[] = [];
    data.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      const id = str(entry.id);
      if (id === '' || Buffer.byteLength(id) > 160) return;
      models.push({
        id,
        name: str(entry.display_name) || id,
        default: index === 0,
        supportsTools: true,
        supportedEfforts: [],
        defaultEffort: '',
        textOnly: false,
      });
    });
    return models.length === 0 ? ANTHROPIC_MODELS.map((m) => ({ ...m })) : models;
  },

  async stream({ fetch: doFetch, base, apiKey, signal }, thread, onDelta) {
    const ctx = AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)]);
    const messages: { role: string; content: string | Block[] }[] = [];
    for (const message of thread.messages) {
      if (message.role === 'user' && (message.toolResults?.length ?? 0) > 0) {
        const content: Block[] = (message.toolResults ?? []).map((result) => {
          const picture = splitDataUrl(result.image);
          const body: string | Block[] =
            picture === undefined
              ? result.text
              : [
                  { type: 'text', text: result.text },
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: picture.media, data: picture.data },
                  },
                ];
          return {
            type: 'tool_result',
            tool_use_id: result.callId,
            content: body,
            is_error: result.isError,
          };
        });
        messages.push({ role: 'user', content });
      } else if (message.role === 'assistant') {
        const content: Block[] = [];
        if ((message.text ?? '') !== '') content.push({ type: 'text', text: message.text });
        for (const call of message.toolCalls ?? []) {
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.arguments ?? {},
          });
        }
        if (content.length > 0) messages.push({ role: 'assistant', content });
      } else {
        messages.push({ role: 'user', content: message.text ?? '' });
      }
    }
    const tools = declaredTools(thread.tools).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
    // Two cache breakpoints: the system prompt (with the tools ahead of it, the same on every
    // request in a thread) and the newest message, so each tool round rereads the turn from cache.
    markLastBlockCached(messages);
    const body: Record<string, unknown> = {
      model: thread.model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      messages,
      stream: true,
    };
    if (thread.system !== '')
      body.system = [{ type: 'text', text: thread.system, cache_control: EPHEMERAL }];
    if (tools.length > 0) body.tools = tools;
    let response: Response;
    try {
      response = await doFetch(
        `${base === '' ? ANTHROPIC_BASE : base}/v1/messages`,
        anthropicInit(apiKey, ctx, body),
      );
    } catch {
      if (ctx.aborted) throw ctx.reason instanceof Error ? ctx.reason : new Error('aborted');
      throw new Error('Anthropic could not be reached');
    }
    if (response.status !== 200) throw await providerResponseError('anthropic', response, false);
    let text = '';
    const calls: ProviderToolCall[] = [];
    const blocks = new Map<number, { kind: string; id: string; name: string; json: string }>();
    const end = { stopReason: '', stopped: false };
    await readSse(ctx, response, (data) => {
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        return;
      }
      if (!isRecord(event)) return;
      const index = typeof event.index === 'number' ? event.index : 0;
      const delta = isRecord(event.delta) ? event.delta : undefined;
      switch (event.type) {
        case 'error':
          if (isRecord(event.error))
            throw new Error('Anthropic reported an error during the response');
          break;
        case 'message_start': {
          const usage =
            isRecord(event.message) && isRecord(event.message.usage)
              ? event.message.usage
              : undefined;
          if (usage !== undefined) {
            thread.usage.input_tokens += Number(usage.input_tokens ?? 0) || 0;
            thread.usage.cache_read_input_tokens += Number(usage.cache_read_input_tokens ?? 0) || 0;
            thread.usage.cache_creation_input_tokens +=
              Number(usage.cache_creation_input_tokens ?? 0) || 0;
          }
          break;
        }
        case 'message_delta':
          if (delta !== undefined && str(delta.stop_reason) !== '')
            end.stopReason = str(delta.stop_reason);
          // message_delta carries the message's final output count; message_start's is a stub.
          if (isRecord(event.usage))
            thread.usage.output_tokens += Number(event.usage.output_tokens ?? 0) || 0;
          break;
        case 'message_stop':
          end.stopped = true;
          break;
        case 'content_block_start':
          if (isRecord(event.content_block)) {
            const block = event.content_block;
            blocks.set(index, {
              kind: str(block.type),
              id: str(block.id),
              name: str(block.name),
              json: '',
            });
          }
          break;
        case 'content_block_delta': {
          if (delta === undefined) break;
          if (delta.type === 'text_delta' && str(delta.text) !== '') {
            text += str(delta.text);
            onDelta(str(delta.text));
          }
          if (delta.type === 'input_json_delta') {
            const block = blocks.get(index);
            if (block !== undefined) block.json += str(delta.partial_json);
          }
          break;
        }
        case 'content_block_stop': {
          const block = blocks.get(index);
          if (block?.kind === 'tool_use')
            calls.push({ id: block.id, name: block.name, arguments: argumentsOf(block.json) });
          break;
        }
        default:
          break;
      }
    });
    // Only a stream that reached message_stop is a whole answer.
    if (end.stopReason === 'max_tokens') throw new ResponseTooLongError();
    if (end.stopReason === 'refusal')
      throw new Error('Claude declined this request. Rephrase it or pick another model');
    if (!end.stopped)
      throw new Error('Anthropic ended the response early, so nothing was changed. Try again');
    return { text, calls };
  },
};

// ---- OpenRouter ----

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

function openrouterInit(apiKey: string, signal: AbortSignal, body?: unknown): RequestInit {
  return {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'X-Title': 'Nix companion',
    },
    redirect: 'manual',
    signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

export const openrouterWire: ProviderWire = {
  async listModels({ fetch: doFetch, base, apiKey, signal }) {
    const timed = AbortSignal.any([signal, AbortSignal.timeout(LIST_TIMEOUT_MS)]);
    let response: Response;
    try {
      response = await doFetch(
        `${base === '' ? OPENROUTER_BASE : base}/models`,
        openrouterInit(apiKey, timed),
      );
    } catch {
      throw new Error('OpenRouter could not be reached');
    }
    if (response.status !== 200) throw await providerResponseError('openrouter', response, true);
    let page: unknown;
    try {
      page = JSON.parse(await readBounded(response, 4 << 20));
    } catch {
      throw new Error('OpenRouter returned an unreadable model list');
    }
    const data = isRecord(page) && Array.isArray(page.data) ? (page.data as unknown[]) : [];
    const models: ModelInfo[] = [];
    for (const entry of data) {
      if (!isRecord(entry)) continue;
      const id = str(entry.id);
      if (id === '' || Buffer.byteLength(id) > 160 || models.length === 100) continue;
      const parameters = Array.isArray(entry.supported_parameters)
        ? (entry.supported_parameters as unknown[])
        : [];
      const modalities =
        isRecord(entry.architecture) && Array.isArray(entry.architecture.input_modalities)
          ? (entry.architecture.input_modalities as unknown[])
          : [];
      let name = str(entry.name);
      if (name === '' || Buffer.byteLength(name) > 200) name = id;
      models.push({
        id,
        name,
        default: false,
        supportsTools: parameters.includes('tools'),
        supportedEfforts: [],
        defaultEffort: '',
        textOnly: !modalities.includes('image'),
      });
    }
    const first = models[0];
    if (first === undefined) throw new Error('OpenRouter listed no models for this key');
    first.default = true;
    return models;
  },

  async stream({ fetch: doFetch, base, apiKey, signal }, thread, onDelta) {
    const ctx = AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)]);
    const system: Block = { role: 'system', content: thread.system };
    // OpenRouter passes Anthropic's cache breakpoints through, and only Claude models need one.
    if (thread.model.startsWith('anthropic/') && thread.system !== '') {
      system.content = [{ type: 'text', text: thread.system, cache_control: EPHEMERAL }];
    }
    const messages: Block[] = [system];
    for (const message of thread.messages) {
      if (message.role === 'user' && (message.toolResults?.length ?? 0) > 0) {
        const images: Block[] = [];
        for (const result of message.toolResults ?? []) {
          messages.push({ role: 'tool', tool_call_id: result.callId, content: result.text });
          if ((result.image ?? '') !== '')
            images.push({ type: 'image_url', image_url: { url: result.image } });
        }
        // Chat completions take no pictures in a tool message, so they follow as a user message.
        if (images.length > 0) {
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: 'The picture the tool result above returned.' },
              ...images,
            ],
          });
        }
      } else if (message.role === 'assistant') {
        const entry: Block = { role: 'assistant', content: message.text ?? '' };
        if ((message.toolCalls?.length ?? 0) > 0) {
          entry.tool_calls = (message.toolCalls ?? []).map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
          }));
        }
        messages.push(entry);
      } else {
        messages.push({ role: 'user', content: message.text ?? '' });
      }
    }
    const tools = declaredTools(thread.tools).map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    const body: Record<string, unknown> = { model: thread.model, messages, stream: true };
    if (tools.length > 0) body.tools = tools;
    let response: Response;
    try {
      response = await doFetch(
        `${base === '' ? OPENROUTER_BASE : base}/chat/completions`,
        openrouterInit(apiKey, ctx, body),
      );
    } catch {
      if (ctx.aborted) throw ctx.reason instanceof Error ? ctx.reason : new Error('aborted');
      throw new Error('OpenRouter could not be reached');
    }
    if (response.status !== 200) throw await providerResponseError('openrouter', response, false);
    let text = '';
    const partials = new Map<number, { id: string; name: string; arguments: string }>();
    const order: number[] = [];
    await readSse(ctx, response, (data) => {
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        return;
      }
      if (!isRecord(chunk)) return;
      if (isRecord(chunk.error))
        throw new Error('OpenRouter reported an error during the response');
      for (const choice of Array.isArray(chunk.choices) ? (chunk.choices as unknown[]) : []) {
        if (!isRecord(choice)) continue;
        if (choice.finish_reason === 'length') throw new ResponseTooLongError();
        const delta = isRecord(choice.delta) ? choice.delta : {};
        if (str(delta.content) !== '') {
          text += str(delta.content);
          onDelta(str(delta.content));
        }
        for (const call of Array.isArray(delta.tool_calls) ? (delta.tool_calls as unknown[]) : []) {
          if (!isRecord(call)) continue;
          const index = typeof call.index === 'number' ? call.index : 0;
          let partial = partials.get(index);
          if (partial === undefined) {
            partial = { id: '', name: '', arguments: '' };
            partials.set(index, partial);
            order.push(index);
          }
          const fn = isRecord(call.function) ? call.function : {};
          if (str(call.id) !== '') partial.id = str(call.id);
          if (str(fn.name) !== '') partial.name = str(fn.name);
          partial.arguments += str(fn.arguments);
        }
      }
    });
    const calls: ProviderToolCall[] = [];
    for (const index of order) {
      const partial = partials.get(index);
      if (partial === undefined || partial.name === '') continue;
      calls.push({
        id: partial.id === '' ? `call-${partial.name.replaceAll(' ', '-')}` : partial.id,
        name: partial.name,
        arguments: argumentsOf(partial.arguments),
      });
    }
    return { text, calls };
  },
};
