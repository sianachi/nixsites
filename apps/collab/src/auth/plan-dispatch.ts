import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface PlanDispatchRequest {
  token: string;
  requestId: string;
  dispatchPermit?: string;
  method: string;
  target: string;
  body: string | null;
  headers: Record<string, string>;
}
export interface PlanDispatchResult {
  token: string;
  requestId: string;
  dispatchPermit?: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}
export type PlanDispatchSettler = (result: PlanDispatchResult) => Promise<boolean>;
export type PlanDispatchAuthorizer = (request: PlanDispatchRequest) => Promise<boolean>;

function markedToken(token: string): boolean {
  const payload = token.split('.')[1];
  if (payload === undefined || payload.length > 16_384) return false;
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && 'nix_pet_plan_request' in value;
  } catch {
    return false;
  }
}
const tokenOf = (request: FastifyRequest) => {
  const header = request.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
};
const planned = (request: FastifyRequest) =>
  request.headers['x-nix-pet-plan-request'] !== undefined || markedToken(tokenOf(request));

function dispatchIdentity(
  header: unknown,
): { requestId: string; dispatchPermit?: string } | undefined {
  if (typeof header !== 'string') return undefined;
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(header))
    return { requestId: header };
  if (!/^[a-f0-9]{32}\.[a-f0-9]{32}$/i.test(header)) return undefined;
  const id = header.slice(33).toLowerCase();
  return {
    requestId: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`,
    dispatchPermit: header,
  };
}

/** Core consumes the exact saved request before Collab starts the cross-service effect. */
export function registerPlanDispatch(
  app: FastifyInstance,
  authorize?: PlanDispatchAuthorizer,
  settle?: PlanDispatchSettler,
): void {
  const bodies = new WeakMap<FastifyRequest, string>();
  const dispatched = new WeakMap<
    FastifyRequest,
    Pick<PlanDispatchRequest, 'token' | 'requestId' | 'dispatchPermit'>
  >();
  app.addHook('preParsing', async (request, reply, payload) => {
    if (!planned(request)) return payload;
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of payload) {
      const data = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk)
          : undefined;
      if (data === undefined || (bytes += data.byteLength) > 128 * 1024) {
        void reply.code(413).send({
          code: 'plan_dispatch_too_large',
          detail: 'The saved plan request exceeds its limit.',
        });
        return Readable.from([]);
      }
      chunks.push(data);
    }
    const body = Buffer.concat(chunks, bytes);
    bodies.set(request, body.toString('utf8'));
    return Object.assign(Readable.from([body]), { receivedEncodedLength: bytes });
  });
  app.addHook('preHandler', async (request, reply) => {
    if (!planned(request)) return;
    const identity = dispatchIdentity(request.headers['x-nix-pet-plan-request']);
    const token = tokenOf(request);
    if (identity === undefined || token === '' || authorize === undefined || settle === undefined) {
      void reply.code(403).send({
        code: 'plan_dispatch_refused',
        detail: 'The reviewed plan request could not be confirmed.',
      });
      return;
    }
    const headers: Record<string, string> = {};
    for (const name of ['content-type', 'x-nix-pet-item-revisions']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const allowed = await authorize({
      token,
      ...identity,
      method: request.method,
      target: request.raw.url ?? request.url,
      body: bodies.get(request) ?? null,
      headers,
    }).catch(() => false);
    if (allowed) dispatched.set(request, { token, ...identity });
    if (!allowed)
      void reply.code(403).send({
        code: 'plan_dispatch_refused',
        detail: 'The reviewed plan request expired, changed, or was cancelled.',
      });
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const dispatch = dispatched.get(request);
    if (dispatch === undefined || settle === undefined) return payload;
    const body =
      typeof payload === 'string'
        ? payload
        : Buffer.isBuffer(payload)
          ? payload.toString('utf8')
          : undefined;
    const headers: Record<string, string> = {};
    const contentType = reply.getHeader('content-type');
    if (typeof contentType === 'string') headers['content-type'] = contentType;
    const settled =
      body !== undefined &&
      Buffer.byteLength(body) <= 1_048_576 &&
      (await settle({ ...dispatch, status: reply.statusCode, headers, body }).catch(() => false));
    if (!settled) {
      void reply.code(503);
      return JSON.stringify({
        code: 'plan_dispatch_uncertain',
        detail:
          'The request may have completed, but its receipt could not be confirmed. Inspect Nix before retrying.',
      });
    }
    return payload;
  });
}

export function createPlanDispatchAuthorizer(options: {
  coreBaseUrl: string;
  internalSecret: string;
  fetch?: typeof fetch;
}): PlanDispatchAuthorizer {
  return async (request) => {
    try {
      const response = await (options.fetch ?? fetch)(
        `${options.coreBaseUrl}/internal/pet-plans/requests/consume`,
        {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
          headers: {
            'Content-Type': 'application/json',
            'X-Nix-Internal-Secret': options.internalSecret,
          },
          body: JSON.stringify(request),
        },
      );
      if (!response.ok || response.body === null) {
        void response.body?.cancel();
        return false;
      }
      const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
      let text = '';
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          if (part.value.byteLength + Buffer.byteLength(text) > 1024) return false;
          text += Buffer.from(part.value).toString('utf8');
        }
      } finally {
        await reader.cancel();
      }
      const value: unknown = JSON.parse(text);
      return (
        typeof value === 'object' &&
        value !== null &&
        Object.keys(value).length === 1 &&
        'allowed' in value &&
        value.allowed === true
      );
    } catch {
      return false;
    }
  };
}

export function createPlanDispatchSettler(options: {
  coreBaseUrl: string;
  internalSecret: string;
  fetch?: typeof fetch;
}): PlanDispatchSettler {
  return async (result) => {
    try {
      const response = await (options.fetch ?? fetch)(
        `${options.coreBaseUrl}/internal/pet-plans/requests/settle`,
        {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
          headers: {
            'Content-Type': 'application/json',
            'X-Nix-Internal-Secret': options.internalSecret,
          },
          body: JSON.stringify(result),
        },
      );
      void response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  };
}
