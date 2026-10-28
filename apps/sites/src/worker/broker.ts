import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';

import type {
  CommandReference,
  DeliveryAction,
  ResultPublisher,
  WorkerResult,
} from './dispatch.ts';

/**
 * The RabbitMQ side of the worker. The envelope is validated exactly as the Go
 * `broker.ParseEnvelope` and `Envelope.Command` do, so a message one role refuses is refused by
 * both: bounded size, depth and token count, no duplicate members, no unknown fields.
 */

export const SITES_QUEUE = 'nix.worker.sites.v1';
export const RESULTS_EXCHANGE = 'nix.results.v1';
export const RESULT_ROUTING_KEY = 'job.result';
export const COMMAND_MESSAGE_TYPE = 'worker.command.v1';
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_DEPTH = 12;
const MAX_TOKENS = 8192;
const MAX_TEXT_BYTES = 64 * 1024;

export class InvalidMessage extends Error {
  override readonly name = 'InvalidMessage';
}

export interface Envelope {
  readonly schemaVersion: 1;
  readonly messageId: string;
  readonly messageType: string;
  readonly occurredAt: string;
  readonly tenantId: string;
  readonly workspaceId: string | null;
  readonly itemId: string | null;
  readonly kind: string;
  readonly payload: unknown;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly causationDepth: number;
  readonly traceParent: string | null;
  readonly aggregateVersion: number | null;
}

const FIELDS = new Set([
  'schemaVersion',
  'messageId',
  'messageType',
  'occurredAt',
  'tenantId',
  'workspaceId',
  'itemId',
  'kind',
  'payload',
  'correlationId',
  'causationId',
  'causationDepth',
  'traceParent',
  'aggregateVersion',
]);

/**
 * Walks the JSON text once to enforce what `JSON.parse` cannot see: nesting depth, token count,
 * string size and duplicate object members (the last one would otherwise silently win).
 */
function validateShape(text: string): void {
  let tokens = 0;
  let depth = 0;
  const keys: (Set<string> | null)[] = [];
  const expectKey: boolean[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (
      char === ' ' ||
      char === '\n' ||
      char === '\r' ||
      char === '\t' ||
      char === ',' ||
      char === ':'
    ) {
      index += 1;
      continue;
    }
    tokens += 1;
    if (tokens > MAX_TOKENS) throw new InvalidMessage('JSON token limit exceeded');
    if (char === '{' || char === '[') {
      depth += 1;
      if (depth > MAX_DEPTH) throw new InvalidMessage('JSON depth limit exceeded');
      keys.push(char === '{' ? new Set() : null);
      expectKey.push(char === '{');
      index += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      keys.pop();
      expectKey.pop();
      if (expectKey.length > 0 && keys[keys.length - 1] !== null)
        expectKey[expectKey.length - 1] = true;
      index += 1;
    } else if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const literal = text.slice(index, end + 1);
      if (literal.length > MAX_TEXT_BYTES) throw new InvalidMessage('JSON string limit exceeded');
      const top = keys.length - 1;
      if (top >= 0 && keys[top] !== null && expectKey[top] === true) {
        const name = JSON.parse(literal) as string;
        if (keys[top]?.has(name) === true)
          throw new InvalidMessage(`duplicate JSON member ${name}`);
        keys[top]?.add(name);
        expectKey[top] = false;
      } else if (top >= 0 && keys[top] !== null) {
        expectKey[top] = true;
      }
      index = end + 1;
    } else {
      // A number, true, false or null: a scalar value.
      let end = index;
      while (end < text.length && !',:]} \n\r\t'.includes(text.charAt(end))) end += 1;
      const top = keys.length - 1;
      if (top >= 0 && keys[top] !== null && expectKey[top] === false) expectKey[top] = true;
      index = end;
    }
  }
}

function bounded(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' && value !== '' && value === value.trim() && value.length <= limit
  );
}

function optionalBounded(value: unknown, limit: number): boolean {
  return value === null || value === undefined || bounded(value, limit);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseEnvelope(body: Buffer | string, maxBytes = MAX_MESSAGE_BYTES): Envelope {
  const text = typeof body === 'string' ? body : body.toString('utf8');
  if (text.length === 0 || Buffer.byteLength(text) > maxBytes) throw new InvalidMessage('size');
  validateShape(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidMessage('not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidMessage('not an object');
  }
  const record = value as Record<string, unknown>;
  for (const name of Object.keys(record)) {
    if (!FIELDS.has(name)) throw new InvalidMessage(`unknown field ${name}`);
  }
  const causationDepth = record.causationDepth ?? 0;
  const aggregate = record.aggregateVersion;
  if (
    record.schemaVersion !== 1 ||
    !bounded(record.messageId, 128) ||
    !bounded(record.messageType, 128) ||
    !bounded(record.tenantId, 128) ||
    !bounded(record.kind, 128) ||
    !bounded(record.correlationId, 128) ||
    record.payload === undefined ||
    record.payload === null ||
    typeof record.occurredAt !== 'string' ||
    Number.isNaN(Date.parse(record.occurredAt)) ||
    !optionalBounded(record.workspaceId, 128) ||
    !optionalBounded(record.itemId, 128) ||
    !optionalBounded(record.causationId, 128) ||
    !optionalBounded(record.traceParent, 256) ||
    (aggregate !== undefined &&
      aggregate !== null &&
      !(Number.isInteger(aggregate) && (aggregate as number) > 0)) ||
    !Number.isInteger(causationDepth) ||
    (causationDepth as number) < 0 ||
    (causationDepth as number) > 4 ||
    (causationDepth === 0 && record.causationId != null) ||
    ((causationDepth as number) > 0 &&
      !(typeof record.causationId === 'string' && UUID.test(record.causationId)))
  ) {
    throw new InvalidMessage('envelope fields');
  }
  return {
    schemaVersion: 1,
    messageId: record.messageId,
    messageType: record.messageType,
    occurredAt: record.occurredAt,
    tenantId: record.tenantId,
    workspaceId: (record.workspaceId as string | null | undefined) ?? null,
    itemId: (record.itemId as string | null | undefined) ?? null,
    kind: record.kind,
    payload: record.payload,
    correlationId: record.correlationId,
    causationId: (record.causationId as string | null | undefined) ?? null,
    causationDepth: causationDepth as number,
    traceParent: (record.traceParent as string | null | undefined) ?? null,
    aggregateVersion: (aggregate as number | null | undefined) ?? null,
  };
}

/** The job a command envelope names, or throws when the envelope is not a coherent command. */
export function commandOf(envelope: Envelope): CommandReference {
  if (envelope.messageType !== COMMAND_MESSAGE_TYPE) throw new InvalidMessage('message type');
  const payload = envelope.payload as { jobId?: unknown; kind?: unknown };
  if (
    typeof payload !== 'object' ||
    typeof payload.jobId !== 'string' ||
    payload.jobId === '' ||
    typeof payload.kind !== 'string' ||
    payload.kind === '' ||
    payload.kind !== envelope.kind ||
    envelope.correlationId !== payload.jobId
  ) {
    throw new InvalidMessage('command reference');
  }
  return { jobId: payload.jobId, kind: payload.kind };
}

export type EnvelopeHandler = (envelope: Envelope) => Promise<DeliveryAction>;

const REQUEUE_BACKOFF_MS = 1000;

export class Broker implements ResultPublisher {
  private connection: ChannelModel | null = null;
  private publisher: ConfirmChannel | null = null;
  private consumers = 0;

  private readonly url: string;
  private readonly log: (message: string, fields?: Record<string, unknown>) => void;

  constructor(
    url: string,
    log: (message: string, fields?: Record<string, unknown>) => void = () => undefined,
  ) {
    this.url = url;
    this.log = log;
  }

  /** True while at least one server-accepted consumer is attached to the queue. */
  consumerReady(): boolean {
    return this.consumers > 0;
  }

  private async open(): Promise<ChannelModel> {
    if (this.connection !== null) return this.connection;
    const connection = await connect(
      `${this.url}${this.url.includes('?') ? '&' : '?'}heartbeat=30`,
    );
    connection.on('error', () => undefined);
    connection.on('close', () => {
      if (this.connection === connection) {
        this.connection = null;
        this.publisher = null;
      }
    });
    this.connection = connection;
    return connection;
  }

  /**
   * Consumes one slot until `signal` aborts or the channel dies (the caller restarts it). The
   * delivery is settled only after the handler answers, with the Go client's requeue backoff.
   */
  async consume(
    queue: string,
    name: string,
    handler: EnvelopeHandler,
    signal: AbortSignal,
  ): Promise<void> {
    const connection = await this.open();
    const channel = await connection.createChannel();
    await channel.prefetch(1);
    const finished = new Promise<void>((resolve) => {
      channel.on('close', () => {
        resolve();
      });
      channel.on('error', () => {
        resolve();
      });
      signal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
    });
    await channel.consume(
      queue,
      (message) => {
        if (message === null) return;
        void (async () => {
          let action: DeliveryAction;
          try {
            action = await handler(parseEnvelope(message.content));
          } catch (error) {
            this.log('broker message rejected', { error: String(error) });
            action = 'reject';
          }
          if (signal.aborted) return;
          if (action === 'requeue') {
            await new Promise((resolve) => setTimeout(resolve, REQUEUE_BACKOFF_MS));
          }
          try {
            if (action === 'ack') channel.ack(message);
            else if (action === 'requeue') channel.nack(message, false, true);
            else channel.reject(message, false);
          } catch {
            // The channel closed under us; the broker redelivers.
          }
        })();
      },
      { consumerTag: name },
    );
    this.consumers += 1;
    try {
      await finished;
    } finally {
      this.consumers -= 1;
      await channel.close().catch(() => undefined);
    }
  }

  async publishResult(result: WorkerResult): Promise<void> {
    const body = Buffer.from(JSON.stringify(result));
    if (body.length > MAX_MESSAGE_BYTES)
      throw new Error('worker result exceeds the broker message limit');
    const channel = await this.publisherChannel();
    const unrouted: { reason: string | null } = { reason: null };
    const onReturn = (message: { fields: { replyText: string } }): void => {
      unrouted.reason = message.fields.replyText;
    };
    channel.once('return', onReturn);
    try {
      await new Promise<void>((resolve, reject) => {
        channel.publish(
          RESULTS_EXCHANGE,
          RESULT_ROUTING_KEY,
          body,
          {
            mandatory: true,
            persistent: true,
            contentType: 'application/json',
            contentEncoding: 'utf-8',
            messageId: result.messageId,
            correlationId: result.jobId,
            type: result.messageType,
            timestamp: Math.floor(Date.parse(result.occurredAt) / 1000),
            appId: 'nix-sites-worker',
          },
          (error) => {
            if (error === null || error === undefined) resolve();
            else reject(new Error('broker message was not confirmed'));
          },
        );
      });
    } catch (error) {
      this.publisher = null;
      throw error;
    } finally {
      channel.off('return', onReturn);
    }
    // A mandatory unroutable publish is returned before its positive confirmation.
    if (unrouted.reason !== null) {
      this.publisher = null;
      throw new Error(`broker message was unroutable: ${unrouted.reason}`);
    }
  }

  private async publisherChannel(): Promise<ConfirmChannel> {
    if (this.publisher !== null) return this.publisher;
    const channel = await (await this.open()).createConfirmChannel();
    channel.on('error', () => {
      if (this.publisher === channel) this.publisher = null;
    });
    channel.on('close', () => {
      if (this.publisher === channel) this.publisher = null;
    });
    this.publisher = channel;
    return channel;
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.publisher = null;
    await connection?.close().catch(() => undefined);
  }
}
