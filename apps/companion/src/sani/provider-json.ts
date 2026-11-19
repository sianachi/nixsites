import { readBounded } from '../providers/provider-errors.ts';
import { assertScreened } from './vendor/screen.ts';

interface ProviderRequest {
  readonly accessToken: string;
  readonly fetch: typeof fetch;
  readonly signal: AbortSignal;
}

interface JsonRequest {
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

const origins = new Set(['https://api.github.com', 'https://api.linear.app', 'https://slack.com']);
const maxResponseBytes = 512 * 1024;

/** The Ops connectors use fixed HTTPS origins and never replay provider redirects. */
export async function providerJson(
  input: ProviderRequest,
  url: string | URL,
  request: JsonRequest = {},
): Promise<unknown> {
  const target = new URL(url);
  if (!origins.has(target.origin) || target.username || target.password || target.hash) {
    throw new Error('The connector destination is not allowed.');
  }
  const headers = new Headers(request.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  headers.set('Authorization', `Bearer ${input.accessToken}`);
  if (request.body !== undefined) headers.set('Content-Type', 'application/json');
  assertScreened([target.href, request.body ?? null], [input.accessToken]);
  const response = await input.fetch(target.href, {
    method: request.method ?? 'GET',
    headers,
    ...(request.body !== undefined && { body: JSON.stringify(request.body) }),
    redirect: 'error',
    signal: input.signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`The connector provider returned HTTP ${String(response.status)}.`);
  }
  try {
    const text = await readBounded(response, maxResponseBytes);
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new Error('The connector provider returned an invalid or unsafe response.');
  }
}
