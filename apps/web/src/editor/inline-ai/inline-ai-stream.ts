import type { NixClient } from '@nix/api-client';

import { readSse } from '@nix/web-foundation/lib/sse';
import { isRecord } from '@nix/web-foundation/lib/guards';

/**
 * The inline writing request, as the Core endpoint defines it: one POST that answers with a
 * stream of events. The note text in `selection` goes to this endpoint and nowhere else, and is
 * never written to a log, an error message or telemetry from here.
 */

export type InlineKind =
  'continue' | 'summarise' | 'improve' | 'fix' | 'translate' | 'action_items' | 'custom';

export interface InlineRequest {
  readonly workspaceId: string;
  readonly itemId: string;
  /** One per attempt, so Core can tell a retry from a repeat. */
  readonly requestId: string;
  readonly kind: InlineKind;
  /** The person's own words; required for `custom`. */
  readonly instruction?: string | undefined;
  /** The material to work on. May be empty only for `continue` and `custom`. */
  readonly selection: string;
  readonly context?: string | undefined;
  /** Required for `translate`. */
  readonly language?: string | undefined;
}

export const INLINE_ENDPOINT = '/api/v1/me/pets/inline';

/** Limits the server enforces; checked here too so an over-long ask fails before it is sent. */
export const MAX_INSTRUCTION_CHARS = 2_000;
export const MAX_SELECTION_CHARS = 16_000;
/** Matches the worker output bound; delta aggregation is checked before it enters React state. */
export const MAX_INLINE_OUTPUT_BYTES = 24_000;

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Truncate at a Unicode code point boundary while respecting Core's byte limit. */
export function truncateUtf8(text: string, maxBytes: number, fromEnd = false): string {
  const points = Array.from(text);
  let bytes = 0;
  let count = 0;
  for (const point of fromEnd ? [...points].reverse() : points) {
    const next = utf8Length(point);
    if (bytes + next > maxBytes) break;
    bytes += next;
    count += 1;
  }
  return (fromEnd ? points.slice(points.length - count) : points.slice(0, count)).join('');
}

/**
 * Why a request failed, as the stable code Core (or this client) gives it.
 *
 * Core's own codes - `pets.inline_disabled`, `inline.timeout` and the rest - pass through
 * unchanged. Two are minted here for failures that have no server word: `inline.offline` when the
 * request never reached Core, and `inline.interrupted` when a stream began and then ended or broke
 * without finishing.
 */
export class InlineAiError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(code: string, status?: number) {
    super(code);
    this.name = 'InlineAiError';
    this.code = code;
    this.status = status;
  }
}

export interface StreamInlineOptions {
  /** Aborting it aborts the request, which is how a cancel reaches the server. */
  readonly signal: AbortSignal;
  readonly onDelta: (piece: string) => void;
}

/** The `code` of an RFC 9457 problem body, or a status-shaped stand-in when there is none. */
async function problemCode(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.code === 'string') return body.code;
  } catch {
    // Not JSON, or cut short: the status alone has to do.
  }
  return `http.${String(response.status)}`;
}

function parseText(raw: string): string {
  try {
    const body: unknown = JSON.parse(raw);
    if (isRecord(body) && typeof body.text === 'string') return body.text;
  } catch {
    // Falls through to the failure below.
  }
  throw new InlineAiError('inline.interrupted');
}

function parseErrorCode(raw: string): string {
  try {
    const body: unknown = JSON.parse(raw);
    if (isRecord(body) && typeof body.code === 'string') return body.code;
  } catch {
    // An error event whose body cannot be read is still an error.
  }
  return 'inline.provider_failed';
}

export async function streamInline(
  client: NixClient,
  request: InlineRequest,
  options: StreamInlineOptions,
): Promise<{ readonly text: string }> {
  let response: Response;
  try {
    response = await client.stream({
      path: INLINE_ENDPOINT,
      body: request,
      signal: options.signal,
    });
  } catch (cause) {
    // A cancel is the caller's own doing; it tells it apart by its signal.
    if (options.signal.aborted) throw cause;
    throw new InlineAiError('inline.offline');
  }

  if (!response.ok) throw new InlineAiError(await problemCode(response), response.status);
  if (response.body === null) throw new InlineAiError('inline.interrupted');

  let receivedBytes = 0;
  try {
    for await (const record of readSse(response.body)) {
      if (record.event === 'delta') {
        const text = parseText(record.data);
        receivedBytes += utf8Length(text);
        if (receivedBytes > MAX_INLINE_OUTPUT_BYTES) throw new InlineAiError('inline.interrupted');
        options.onDelta(text);
      } else if (record.event === 'done') {
        const text = parseText(record.data);
        if (utf8Length(text) > MAX_INLINE_OUTPUT_BYTES)
          throw new InlineAiError('inline.interrupted');
        return { text };
      } else if (record.event === 'error') {
        throw new InlineAiError(parseErrorCode(record.data));
      }
    }
  } catch (cause) {
    if (cause instanceof InlineAiError || options.signal.aborted) throw cause;
    // The connection broke after it had begun: what arrived is the caller's to keep.
    throw new InlineAiError('inline.interrupted');
  }
  throw new InlineAiError('inline.interrupted');
}
