import { z } from 'zod';
import type { ConnectorAction } from './connector.ts';

const graphOrigin = 'https://graph.microsoft.com';
const graphVersion = '/v1.0';
const jsonLimit = 512 * 1024;

export type GraphInput = Parameters<ConnectorAction['execute']>[0];

export const graphId = z
  .string()
  .regex(/^[A-Za-z0-9_!@:.=~+/-]{1,512}$/u)
  .refine(
    (value) =>
      !value.split('/').some((part) => part === '.' || part === '..') &&
      !(value.includes(':') && value.includes('/')),
  );
export const graphPageSize = z.number().int().min(1).max(25).optional();

export function graphSegment(value: string): string {
  return encodeURIComponent(graphId.parse(value));
}

export function withGraphQuery(path: string, query: Record<string, string>): string {
  return `${path}?${new URLSearchParams(query).toString()}`;
}

export async function graphResponse(
  input: GraphInput,
  path: string,
  init: RequestInit = {},
  acceptRedirect = false,
): Promise<Response> {
  const url = new URL(`${graphOrigin}${graphVersion}${path}`);
  if (!path.startsWith('/') || url.origin !== graphOrigin || !url.pathname.startsWith('/v1.0/')) {
    throw new Error('Microsoft Graph request is outside the connection.');
  }
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${input.accessToken}`);
  const response = await input.fetch(url, {
    ...init,
    headers,
    redirect: 'manual',
    signal: input.signal,
  });
  if (response.ok || (acceptRedirect && [301, 302, 303, 307, 308].includes(response.status))) {
    return response;
  }
  await response.body?.cancel();
  throw new Error(`Microsoft Graph refused the action (HTTP ${String(response.status)}).`);
}

export async function graphText(response: Response, maximumBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let result = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return result + decoder.decode();
      const bytes: unknown = chunk.value;
      if (!(bytes instanceof Uint8Array)) throw new Error('Invalid Microsoft Graph response.');
      size += bytes.byteLength;
      if (size > maximumBytes) throw new Error('Microsoft Graph response exceeds the size limit.');
      result += decoder.decode(bytes, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function graphJson(
  input: GraphInput,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await graphResponse(input, path, init);
  const body: unknown = JSON.parse(await graphText(response, jsonLimit));
  return body;
}

export function writeJson(method: 'POST' | 'PATCH', payload: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

export function microsoftLink(value: string | undefined, hosts: readonly string[]): string | null {
  if (!value || value.length > 2_048) return null;
  const url = URL.parse(value);
  return url?.protocol === 'https:' && hosts.includes(url.host) && !url.username && !url.password
    ? url.href
    : null;
}
