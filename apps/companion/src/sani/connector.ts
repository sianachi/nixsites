import { createHash } from 'node:crypto';
import { z } from 'zod';

import { assertScreened } from './vendor/screen.ts';

export interface ConnectorInput {
  readonly executionId: string;
  readonly resourceId: string;
  readonly accessToken: string;
  readonly args: unknown;
  readonly fetch: typeof fetch;
  readonly transfer?: typeof fetch;
  readonly signal: AbortSignal;
}

export interface ConnectorAction {
  readonly id: string;
  readonly kind: 'read' | 'write';
  readonly resourceKind: string;
  readonly description: string;
  readonly args: z.ZodType;
  readonly execute: (input: ConnectorInput) => Promise<unknown>;
}

const providers = {
  gmail: ['google', ['https://gmail.googleapis.com', 'https://www.googleapis.com']],
  'google-drive': ['google', ['https://www.googleapis.com', 'https://drive.googleapis.com']],
  'google-calendar': ['google', ['https://www.googleapis.com', 'https://calendar.googleapis.com']],
  'outlook-mail': ['microsoft', ['https://graph.microsoft.com']],
  onedrive: ['microsoft', ['https://graph.microsoft.com']],
  'outlook-calendar': ['microsoft', ['https://graph.microsoft.com']],
  teams: ['microsoft', ['https://graph.microsoft.com']],
  slack: ['slack', ['https://slack.com']],
  github: ['github', ['https://api.github.com']],
  linear: ['linear', ['https://api.linear.app']],
} satisfies Record<string, [string, string[]]>;

function describe(action: ConnectorAction) {
  const prefix = action.id.split('.')[0];
  const provider = Object.entries(providers).find(([id]) => id === prefix)?.[1];
  if (provider === undefined) throw new Error('Unrecognized Sani connector.');
  const schema = z.toJSONSchema(action.args, { io: 'input', unrepresentable: 'any' });
  const schemaHash = createHash('sha256')
    .update(JSON.stringify([action.id, action.kind, action.resourceKind, schema]))
    .digest('hex');
  const { id, kind, resourceKind, description } = action;
  return {
    definition: { id, kind, resourceKind, description, schema, schemaHash, provider: provider[0] },
    origins: provider[1],
  };
}

const actionId = z
  .string()
  .regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9_-]*$/)
  .max(96);
const resourceId = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_.@+!~:/=,%$-]+$/);
const fields = { action: actionId, resourceId, args: z.record(z.string(), z.unknown()) };
const request = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('catalog') }),
  z.strictObject({ operation: z.literal('prepare'), ...fields }),
  z.strictObject({
    operation: z.literal('execute'),
    ...fields,
    executionId: z.uuid(),
    accessToken: z
      .string()
      .min(1)
      .max(8192)
      .regex(/^[!-~]+$/),
    schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);

const MAX_RESPONSE = 2 * 1024 * 1024;

export function oneDriveTransferAllowed(target: URL): boolean {
  const host = target.hostname;
  return (
    target.protocol === 'https:' &&
    !target.port &&
    !target.username &&
    !target.password &&
    !target.hash &&
    target.href.length <= 4096 &&
    (host.endsWith('.1drv.com') ||
      host.endsWith('.sharepoint.com') ||
      host.endsWith('.sharepointonline.com') ||
      host === 'onedrive.com' ||
      host === 'onedrive.live.com')
  );
}

function scopedFetch(
  origins: readonly string[],
  fetchImpl: typeof fetch,
  deadline: AbortSignal,
  mode?: 'onedrive-graph' | 'onedrive-transfer',
): typeof fetch {
  return async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const transfer = mode === 'onedrive-transfer';
    if (transfer) {
      const headers = new Headers(init?.headers);
      if (
        input instanceof Request ||
        !oneDriveTransferAllowed(target) ||
        (method !== 'GET' && method !== 'PUT') ||
        headers.has('authorization') ||
        headers.has('proxy-authorization') ||
        headers.has('cookie')
      ) {
        throw new Error('OneDrive refused an out-of-scope capability transfer.');
      }
    } else if (
      !origins.includes(target.origin) ||
      target.username ||
      target.password ||
      target.hash
    ) {
      throw new Error('Provider request left its registered origin.');
    }
    const requested = init?.signal ?? (input instanceof Request ? input.signal : null);
    const signal = requested == null ? deadline : AbortSignal.any([deadline, requested]);
    // Graph returns the signed OneDrive URL as a 302. The adapter validates and uses it without a bearer.
    const manual =
      mode === 'onedrive-graph' &&
      method === 'GET' &&
      target.pathname.endsWith('/content') &&
      init?.redirect === 'manual';
    const response = await fetchImpl(input, {
      ...init,
      ...(transfer && { credentials: 'omit', referrerPolicy: 'no-referrer' }),
      redirect: manual ? 'manual' : 'error',
      signal,
    });
    if (response.body === null) return response;
    const reader = response.body.getReader();
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        const value: unknown = part.value;
        if (!(value instanceof Uint8Array)) throw new Error('Invalid provider response body.');
        size += value.length;
        if (size > MAX_RESPONSE) throw new Error('Provider response exceeded the body limit.');
        parts.push(new Uint8Array(value));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return new Response(new Blob(parts), { status: response.status, headers: response.headers });
  };
}

export function createConnectorRouter(
  actions: readonly ConnectorAction[],
  fetchImpl = globalThis.fetch,
) {
  const entries = new Map(
    actions.map((action) => [action.id, { action, descriptor: describe(action) }]),
  );
  if (entries.size !== actions.length) throw new Error('Duplicate Sani connector action.');
  return async function runConnector(value: unknown): Promise<unknown> {
    const parsed = request.safeParse(value);
    if (!parsed.success) return undefined;
    const input = parsed.data;
    if (input.operation === 'catalog') {
      return {
        actions: [...entries.values()].map(({ descriptor }) => descriptor.definition),
      };
    }
    const entry = entries.get(input.action);
    if (entry === undefined) return { failure: 'unknown_action' };
    const args = entry.action.args.safeParse(input.args);
    if (!args.success) return { failure: 'invalid_args' };
    if (input.operation === 'prepare') {
      return { arguments: args.data, schemaHash: entry.descriptor.definition.schemaHash };
    }
    if (input.schemaHash !== entry.descriptor.definition.schemaHash)
      return { failure: 'schema_changed' };
    try {
      assertScreened(args.data, [input.accessToken]);
      const signal = AbortSignal.timeout(20_000);
      const oneDrive = input.action.startsWith('onedrive.');
      const result = await entry.action.execute({
        executionId: input.executionId,
        resourceId: input.resourceId,
        accessToken: input.accessToken,
        args: args.data,
        fetch: scopedFetch(
          entry.descriptor.origins,
          fetchImpl,
          signal,
          oneDrive ? 'onedrive-graph' : undefined,
        ),
        ...(oneDrive && { transfer: scopedFetch([], fetchImpl, signal, 'onedrive-transfer') }),
        signal,
      });
      assertScreened(result, [input.accessToken]);
      return { result };
    } catch {
      // A response may have been lost after a provider applied a write.
      return {
        failure: entry.action.kind === 'write' ? 'unknown_outcome' : 'provider_unavailable',
      };
    }
  };
}
