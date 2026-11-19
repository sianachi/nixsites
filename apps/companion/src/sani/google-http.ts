import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import type { ConnectorAction } from './connector.ts';

export type GoogleCall = Parameters<ConnectorAction['execute']>[0];

export const googleId = z
  .string()
  .max(256)
  .regex(/^[\w-]+$/u);
export const googlePageToken = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^\P{Cc}+$/u);
export const googlePageCursor = z
  .string()
  .max(2800)
  .regex(/^[\w-]+\.[\w-]{43}$/u);

function pageTokenMac(call: GoogleCall, selector: readonly unknown[], contents: string): Buffer {
  return createHmac('sha256', call.accessToken)
    .update(JSON.stringify(['google-page', call.resourceId, selector, contents]))
    .digest();
}

export function encodePageToken(
  call: GoogleCall,
  selector: readonly unknown[],
  token: string | undefined,
): string | undefined {
  if (token === undefined) return undefined;
  const contents = Buffer.from(token).toString('base64url');
  return `${contents}.${pageTokenMac(call, selector, contents).toString('base64url')}`;
}

export function decodePageToken(
  call: GoogleCall,
  selector: readonly unknown[],
  cursor: string | undefined,
): string | undefined {
  if (cursor === undefined) return undefined;
  const period = cursor.indexOf('.');
  const contents = cursor.slice(0, period);
  const mac = Buffer.from(cursor.slice(period + 1), 'base64url');
  const expected = pageTokenMac(call, selector, contents);
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    throw new Error('The Google page belongs to a different request or needs to be refreshed.');
  }
  return googlePageToken.parse(Buffer.from(contents, 'base64url').toString());
}

const origins = new Set(['https://gmail.googleapis.com', 'https://www.googleapis.com']);
const maxResponseBytes = 512 * 1024;

export class GoogleResponseError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Google refused the request (HTTP ${String(status)}).`);
    this.status = status;
  }
}

export async function googleRequest(
  call: GoogleCall,
  url: URL,
  init: RequestInit = {},
): Promise<Response> {
  if (!origins.has(url.origin) || url.username || url.password || url.hash) {
    throw new Error('Google destination is outside the registered API.');
  }

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${call.accessToken}`);
  const response = await call.fetch(url, {
    ...init,
    headers,
    redirect: 'error',
    signal: call.signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GoogleResponseError(response.status);
  }
  return response;
}

export async function googleText(response: Response): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const entry = await reader.read();
      if (entry.done) return text + decoder.decode();
      const bytes: unknown = entry.value;
      if (!(bytes instanceof Uint8Array)) throw new Error('Invalid Google response stream.');
      size += bytes.byteLength;
      if (size > maxResponseBytes) throw new Error('Google response exceeds the receipt limit.');
      text += decoder.decode(bytes, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function googleJson<T>(
  call: GoogleCall,
  url: URL,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  return schema.parse(JSON.parse(await googleText(await googleRequest(call, url, init))));
}

export function googleJsonBody(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
