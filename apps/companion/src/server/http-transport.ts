import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { providerFailureToken } from '../providers/provider-errors.ts';
import type { ModelInfo, Notify, RequestHandler, Transport } from '../shared/types.ts';
import { errorMessage, isRecord, str } from '../shared/util.ts';
import {
  anthropicWire,
  emptyUsage,
  openrouterWire,
  type HttpThread,
  type ProviderMessage,
  type ProviderToolResult,
  type ProviderWire,
  type WireContext,
} from './wire.ts';

/**
 * Serves the Codex app-server vocabulary the account already speaks over a provider's HTTPS API:
 * Anthropic's Messages API or OpenRouter's chat completions. The API key lives in memory for the
 * account's life and is never written to disk or logs. Thread history is kept per thread under
 * the account home so a resumed thread survives a restart; it is bounded like the conversation.
 */

// A thread keeps its last MAX_THREAD_TURNS turns, and drops more while its text passes
// MAX_THREAD_BYTES. Counting turns, not messages, matters: one turn with ten tool calls adds
// twenty messages.
export const MAX_THREAD_TURNS = 12;
export const MAX_THREAD_BYTES = 600_000;
export const MAX_TOOL_ROUNDS_PER_TURN = 24;

export interface HttpTransportOptions {
  kind: string;
  apiKey: string;
  home: string;
  notify: Notify;
  /** Overrides the provider's origin; tests point it at a local server. */
  baseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
}

interface ToolReply {
  text: string;
  image: string;
  success: boolean;
}

const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;

function messageBytes(message: ProviderMessage): number {
  let size = Buffer.byteLength(message.text ?? '');
  for (const call of message.toolCalls ?? [])
    size += Buffer.byteLength(JSON.stringify(call.arguments ?? {}));
  for (const result of message.toolResults ?? [])
    size += Buffer.byteLength(result.text) + Buffer.byteLength(result.image ?? '');
  return size;
}

/**
 * Drops a thread's oldest turns past MAX_THREAD_TURNS, and more while it is over MAX_THREAD_BYTES,
 * always cutting at a turn's opening user message: a cut between a tool call and its results
 * leaves an orphan every provider rejects. The latest turn is never dropped. The first message is
 * kept as `opening` and repeated at the head of what remains.
 */
export function trimThread(thread: HttpThread): void {
  const starts: number[] = [];
  let size = 0;
  thread.messages.forEach((message, i) => {
    if (message.role === 'user' && (message.toolResults?.length ?? 0) === 0) starts.push(i);
    size += messageBytes(message);
  });
  let opening = thread.opening ?? '';
  // A thread cut before `opening` existed may no longer start with its first message; only a
  // message that carries the workspace map is worth repeating.
  const first = thread.messages[0];
  if (opening === '' && first !== undefined && (first.text ?? '').includes('"workspaceMap"'))
    opening = first.text ?? '';
  let cut = starts.length > MAX_THREAD_TURNS ? starts.length - MAX_THREAD_TURNS : 0;
  while (cut < starts.length) {
    let dropped = 0;
    for (const message of thread.messages.slice(0, starts[cut])) dropped += messageBytes(message);
    if (
      size - dropped + Buffer.byteLength(opening) <= MAX_THREAD_BYTES ||
      cut === starts.length - 1
    )
      break;
    cut++;
  }
  if (cut === 0 || cut >= starts.length) return;
  thread.opening = opening;
  const kept = thread.messages.slice(starts[cut]);
  const head = kept[0];
  if (opening !== '' && head !== undefined) {
    head.text = `The conversation began with this message; its earlier turns were dropped to save space:\n${opening}\n\nThe message now:\n${head.text ?? ''}`;
  }
  thread.messages = kept;
}

export class HttpTransport implements Transport {
  readonly kind: string;
  private apiKey: string;
  private readonly home: string;
  private readonly baseUrl: string;
  private readonly notify: Notify;
  private readonly doFetch: typeof fetch;
  private readonly wire: ProviderWire;
  private readonly threads = new Map<string, HttpThread>();
  private readonly turns = new Map<string, AbortController>();
  private readonly replies = new Map<string, (reply: ToolReply) => void>();
  private nextId = 0;
  private handler: RequestHandler | undefined;
  private closed = false;
  /** The listed models that take image input; undefined until a list is read. */
  private seesImages: Map<string, boolean> | undefined;

  constructor(options: HttpTransportOptions) {
    const wire =
      options.kind === 'anthropic'
        ? anthropicWire
        : options.kind === 'openrouter'
          ? openrouterWire
          : undefined;
    if (wire === undefined) throw new Error(`unknown provider "${options.kind}"`);
    this.wire = wire;
    this.kind = options.kind;
    this.apiKey = options.apiKey;
    this.home = options.home;
    this.baseUrl = options.baseUrl ?? '';
    this.notify = options.notify;
    // Redirects are never followed: a provider 3xx must not carry the key or the prompt elsewhere.
    this.doFetch = options.fetch ?? fetch;
    mkdirSync(join(this.home, 'threads'), { recursive: true, mode: 0o700 });
  }

  alive(): boolean {
    return !this.closed;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  setRequestHandler(handler: RequestHandler): void {
    this.handler = handler;
  }

  private context(signal: AbortSignal | undefined): WireContext {
    return {
      fetch: this.doFetch,
      base: this.baseUrl,
      apiKey: this.apiKey,
      signal: signal ?? new AbortController().signal,
    };
  }

  /** Delivers a tool result (the account's toolOutput shape) to the turn waiting for it. */
  reply(id: unknown, result: unknown): void {
    const resolve = this.replies.get(JSON.stringify(id));
    if (resolve === undefined) throw new Error('no pending tool call for that id');
    const out = isRecord(result) ? result : {};
    const items = Array.isArray(out.contentItems) ? (out.contentItems as unknown[]) : [];
    let text = '';
    let image = '';
    items.forEach((item, i) => {
      if (!isRecord(item)) return;
      if (i === 0) text = str(item.text);
      if (item.type === 'inputImage') image = str(item.imageUrl);
    });
    resolve({ text, image, success: out.success === true });
  }

  close(): void {
    this.closed = true;
    for (const [id, controller] of this.turns) {
      controller.abort();
      this.turns.delete(id);
    }
  }

  async call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const p = isRecord(params) ? params : {};
    switch (method) {
      case 'initialize':
      case 'initialized':
      case 'account/logout':
      case 'account/login/cancel':
        return {};
      case 'thread/unsubscribe': {
        const thread = this.threads.get(str(p.threadId));
        if (thread?.ephemeral === true) this.threads.delete(thread.id);
        return {};
      }
      case 'account/read':
        return this.apiKey === '' ? { account: null } : { account: { type: 'apiKey' } };
      case 'account/login/start':
        throw new Error(
          'this provider signs in with an API key saved in Pet settings, not a device code',
        );
      case 'model/list':
        return this.encodeModelList(await this.listModels(signal));
      case 'thread/start':
        return this.startThread(p, signal);
      case 'thread/resume': {
        const id = str(p.threadId);
        if (id === '') throw new Error('thread id required');
        this.thread(id);
        return { thread: { id } };
      }
      case 'turn/start':
        return this.startTurn(p);
      case 'turn/interrupt':
        this.turns.get(str(p.turnId))?.abort();
        return {};
      default:
        throw new Error(`provider refused ${method}`);
    }
  }

  /** The page shape the account's model parser reads, plus supportsTools. */
  private encodeModelList(models: ModelInfo[]): unknown {
    return {
      data: models.map((m) => ({
        model: m.id,
        displayName: m.name,
        isDefault: m.default,
        supportsTools: m.supportsTools,
      })),
    };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const models = await this.wire.listModels(this.context(signal));
    this.seesImages = new Map(models.map((m) => [m.id, !m.textOnly]));
    return models;
  }

  private async startThread(
    p: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    let model = str(p.model);
    if (model === '') {
      const models = await this.listModels(signal);
      const chosen = models.find((m) => m.default) ?? models[0];
      if (chosen === undefined) throw new Error('provider listed no models');
      model = chosen.id;
    }
    const id = randomBytes(16).toString('hex');
    this.threads.set(id, {
      id,
      model,
      system: `${str(p.baseInstructions)}\n\n${str(p.developerInstructions)}`,
      tools: Array.isArray(p.dynamicTools) ? (p.dynamicTools as unknown[]) : [],
      messages: [],
      ephemeral: p.ephemeral === true,
      usage: emptyUsage(),
    });
    return { thread: { id } };
  }

  private threadPath(id: string): string {
    return join(this.home, 'threads', `${id}.json`);
  }

  private thread(id: string): HttpThread {
    const known = this.threads.get(id);
    if (known !== undefined) return known;
    let raw: string;
    try {
      if (!THREAD_ID.test(id)) throw new Error('bad id');
      raw = readFileSync(this.threadPath(id), 'utf8');
    } catch {
      throw new Error("that conversation's thread is no longer available; start a new one");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (!isRecord(parsed) || parsed.id !== id)
      throw new Error("that conversation's thread could not be read");
    const loaded: HttpThread = {
      id,
      model: str(parsed.model),
      system: str(parsed.system),
      tools: Array.isArray(parsed.tools) ? (parsed.tools as unknown[]) : [],
      messages: Array.isArray(parsed.messages) ? (parsed.messages as ProviderMessage[]) : [],
      ...(typeof parsed.opening === 'string' ? { opening: parsed.opening } : {}),
      ephemeral: false,
      usage: emptyUsage(),
    };
    this.threads.set(id, loaded);
    return loaded;
  }

  private save(thread: HttpThread): void {
    if (thread.ephemeral) return;
    trimThread(thread);
    try {
      const persisted = {
        id: thread.id,
        model: thread.model,
        system: thread.system,
        tools: thread.tools,
        messages: thread.messages,
        ...(thread.opening === undefined ? {} : { opening: thread.opening }),
      };
      writeFileSync(this.threadPath(thread.id), JSON.stringify(persisted), { mode: 0o600 });
    } catch {
      // a thread that could not be saved is simply not resumable after a restart
    }
  }

  private startTurn(p: Record<string, unknown>): unknown {
    const input = Array.isArray(p.input) ? (p.input as unknown[]) : [];
    const first = input[0];
    if (str(p.threadId) === '' || !isRecord(first)) throw new Error('thread id and input required');
    const thread = this.thread(str(p.threadId));
    if (this.apiKey === '')
      throw new Error('no API key for this provider; add one in Pet settings');
    const turnId = randomBytes(16).toString('hex');
    thread.messages.push({ role: 'user', text: str(first.text) });
    const controller = new AbortController();
    this.turns.set(turnId, controller);
    // Started after the caller has the turn id, so no notification can precede it.
    setImmediate(() => void this.runTurn(controller.signal, thread, turnId));
    return { turn: { id: turnId } };
  }

  /**
   * The agent loop for one turn: stream the assistant message, hand each tool call to the
   * account's handler (the same claim/approve/result path the browser drives), feed the results
   * back, and repeat until the model answers without tools. Every outcome ends in turn/completed.
   */
  private async runTurn(signal: AbortSignal, thread: HttpThread, turnId: string): Promise<void> {
    thread.usage = emptyUsage();
    const finish = (status: string, failure?: unknown): void => {
      const turn: Record<string, unknown> = { status };
      // Only the Anthropic wire reports counts; zeros from the others would read as free turns.
      if (Object.values(thread.usage).some((n) => n !== 0)) turn.usage = thread.usage;
      if (failure !== undefined)
        turn.error = {
          message: errorMessage(failure),
          nixProviderError: providerFailureToken(failure),
        };
      this.notify('turn/completed', { threadId: thread.id, turn });
    };
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS_PER_TURN; round++) {
        const itemId = `${turnId}-${String(round)}`;
        let result: Awaited<ReturnType<ProviderWire['stream']>>;
        try {
          result = await this.wire.stream(this.context(signal), thread, (delta) => {
            this.notify('item/agentMessage/delta', { threadId: thread.id, itemId, delta });
          });
        } catch (error) {
          // An interrupted turn can surface as a cancelled signal or as the provider closing the
          // stream early; either way the owner asked for it to stop.
          finish(signal.aborted ? 'interrupted' : 'failed', signal.aborted ? undefined : error);
          return;
        }
        const { text, calls } = result;
        // A reply with neither words nor tool calls would show as a blank bubble and read as success.
        if (calls.length === 0 && text.trim() === '') {
          finish('failed', new Error('The model finished without an answer. Try again'));
          return;
        }
        thread.messages.push({ role: 'assistant', text, toolCalls: calls });
        if (calls.length === 0) {
          this.save(thread);
          this.notify('item/completed', {
            threadId: thread.id,
            item: { id: itemId, type: 'agentMessage', text, phase: 'final_answer' },
          });
          finish('completed');
          return;
        }
        if (text !== '') {
          this.notify('item/completed', {
            threadId: thread.id,
            item: { id: `${itemId}-commentary`, type: 'agentMessage', text, phase: 'commentary' },
          });
        }
        const results: ProviderToolResult[] = [];
        for (const [i, call] of calls.entries()) {
          const reply = await this.askTool(signal, thread.id, call.id, call.name, call.arguments);
          if (reply === undefined) {
            // Every call still gets an answer: an assistant tool call with no result after it
            // makes the provider refuse the thread's next message.
            for (const unanswered of calls.slice(i)) {
              results.push({
                callId: unanswered.id,
                text: 'The owner stopped the turn before this tool ran.',
                isError: true,
              });
            }
            thread.messages.push({ role: 'user', toolResults: results });
            this.save(thread);
            finish('interrupted');
            return;
          }
          if (reply.image !== '' && !(await this.acceptsImages(signal, thread.model))) {
            // A picture a text-only model is sent fails this request and every later one in the
            // thread, since the history keeps it.
            reply.text +=
              '\nThis result is a picture, but the selected model cannot see images. Tell the owner to choose a model that accepts images in Settings > Pets.';
            reply.image = '';
          }
          results.push({
            callId: call.id,
            text: reply.text,
            ...(reply.image === '' ? {} : { image: reply.image }),
            isError: !reply.success,
          });
        }
        thread.messages.push({ role: 'user', toolResults: results });
        this.save(thread);
      }
      finish(
        'failed',
        new Error('The model kept calling tools without answering; the turn was stopped.'),
      );
    } finally {
      if (thread.ephemeral) this.threads.delete(thread.id);
      this.turns.get(turnId)?.abort();
      this.turns.delete(turnId);
    }
  }

  /**
   * Routes one model tool call through the account's handler and waits for the owner's decision.
   * A refusal from the handler becomes an error result the model sees at once. Undefined when the
   * turn was cancelled.
   */
  private async askTool(
    signal: AbortSignal,
    threadId: string,
    callId: string,
    name: string,
    args: unknown,
  ): Promise<ToolReply | undefined> {
    this.nextId++;
    const id = this.nextId;
    const key = JSON.stringify(id);
    const waiting = new Promise<ToolReply>((resolve) => this.replies.set(key, resolve));
    try {
      const params = { threadId, tool: name, callId, arguments: args };
      const handled =
        this.handler?.(id, 'item/tool/call', params, Buffer.byteLength(JSON.stringify(params))) ??
        false;
      if (!handled)
        return {
          text: 'That tool is not available in this conversation (workspace access may be off).',
          image: '',
          success: false,
        };
      return await Promise.race([
        waiting,
        new Promise<undefined>((resolve) => {
          if (signal.aborted) resolve(undefined);
          else
            signal.addEventListener(
              'abort',
              () => {
                resolve(undefined);
              },
              { once: true },
            );
        }),
      ]);
    } finally {
      this.replies.delete(key);
    }
  }

  /**
   * Whether `model` takes image input. Every Claude model does. For OpenRouter the model list
   * says, read once if no list has been read yet; a model the list does not name, or a list that
   * cannot be read, counts as no.
   */
  private async acceptsImages(signal: AbortSignal, model: string): Promise<boolean> {
    if (this.kind !== 'openrouter') return true;
    if (this.seesImages === undefined) {
      try {
        await this.listModels(signal);
      } catch {
        return false;
      }
    }
    return this.seesImages?.get(model) ?? false;
  }
}
