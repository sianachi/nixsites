import { vi } from 'vitest';
import { requestUrl } from '../../request-url';

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

type Handler = (call: Call) => Response | undefined;

/** Layers canned answers for routes the shared Core stub does not know over `stubCoreApi`'s fetch. */
export function layerRoutes(handler: Handler): Call[] {
  const inner = globalThis.fetch;
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = requestUrl(input);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const path = new URL(url, globalThis.location.origin).pathname;
    const raw =
      init?.body ??
      (request === null || method === 'GET' ? undefined : await request.clone().text());
    const call = {
      method,
      path,
      body: typeof raw === 'string' && raw !== '' ? (JSON.parse(raw) as unknown) : null,
    };
    const response = handler(call);
    if (response !== undefined) {
      calls.push(call);
      return response;
    }
    return inner(input, init);
  });
  return calls;
}

export function reply(body: unknown, status = 200): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(
    JSON.stringify(status >= 400 ? { title: 'Refused', status, ...(body as object) } : body),
    {
      status,
      headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
    },
  );
}
