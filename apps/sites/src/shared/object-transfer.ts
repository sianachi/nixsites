import { createHash } from 'node:crypto';

/**
 * Moves bytes through capability URLs, and nowhere else.
 *
 * Mirrors the Go `objecttransfer` client: a URL is used only when its origin is on the allowlist
 * (an empty allowlist admits loopback only), redirects are never followed, a download stops at its
 * byte bound, and errors never carry the URL because a capability query is a credential.
 */

export class TransferError extends Error {
  override readonly name = 'TransferError';
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

export type PutOutcome = 'created' | 'exists';

export interface ObjectTransferOptions {
  /** Origins (`scheme://host[:port]`) capabilities may point at. Empty admits loopback only. */
  readonly origins: readonly string[];
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
      return null;
    }
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

// Duplicated with apps/cli/src/cli-auth.ts: the CLI and the sites app share no package.
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export class ObjectTransfer {
  private readonly allowed: ReadonlySet<string>;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(options: ObjectTransferOptions) {
    this.allowed = new Set(
      options.origins.map((origin) => originOf(origin)).filter((o): o is string => o !== null),
    );
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.doFetch = options.fetch ?? globalThis.fetch;
  }

  /** Whether a URL may be fetched at all. Exposed so callers can pin other origins the same way. */
  permits(rawUrl: string): boolean {
    const origin = originOf(rawUrl);
    if (origin === null) return false;
    if (this.allowed.size === 0) return isLoopback(new URL(rawUrl).hostname);
    return this.allowed.has(origin);
  }

  async download(
    rawUrl: string,
    maxBytes: number,
    signal?: AbortSignal,
    headers?: Readonly<Record<string, string>>,
  ): Promise<Uint8Array> {
    const response = await this.send(rawUrl, { method: 'GET', headers }, signal);
    if (!response.ok) {
      throw new TransferError(
        `The source download returned ${String(response.status)}.`,
        response.status,
      );
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      await response.body?.cancel();
      throw new TransferError('The source object exceeds the configured byte limit.');
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for await (const chunk of (response.body ?? []) as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          throw new TransferError('The source object exceeds the configured byte limit.');
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof TransferError) throw error;
      throw new TransferError('The source download was interrupted.');
    }
    return Buffer.concat(chunks, total);
  }

  /** A create-only, checksum-bound write. An object that is already there counts as written. */
  async putCreateOnly(
    rawUrl: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<PutOutcome> {
    return this.put(rawUrl, bytes, true, signal);
  }

  /** A checksum-bound write that replaces what is there (a host manifest). */
  async putReplacing(rawUrl: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.put(rawUrl, bytes, false, signal);
  }

  async delete(rawUrl: string, signal?: AbortSignal): Promise<void> {
    const response = await this.send(rawUrl, { method: 'DELETE' }, signal);
    if (!response.ok && response.status !== 404) {
      throw new TransferError(
        `The object deletion returned ${String(response.status)}.`,
        response.status,
      );
    }
  }

  private async put(
    rawUrl: string,
    bytes: Uint8Array,
    createOnly: boolean,
    signal: AbortSignal | undefined,
  ): Promise<PutOutcome> {
    // The signed headers are exactly content-length, the base64 checksum and (for create-only)
    // if-none-match; fetch derives content-length from the body.
    const headers: Record<string, string> = {
      'x-amz-checksum-sha256': createHash('sha256').update(bytes).digest('base64'),
    };
    if (createOnly) headers['if-none-match'] = '*';
    const response = await this.send(rawUrl, { method: 'PUT', headers, body: bytes }, signal);
    if (createOnly && (response.status === 412 || response.status === 409)) return 'exists';
    if (!response.ok) {
      throw new TransferError(
        `The destination upload returned ${String(response.status)}.`,
        response.status,
      );
    }
    return 'created';
  }

  private async send(
    rawUrl: string,
    init: {
      method: string;
      headers?: Readonly<Record<string, string>> | undefined;
      body?: Uint8Array;
    },
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    if (!this.permits(rawUrl)) {
      throw new TransferError('The object capability origin is not allowed.');
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.doFetch(rawUrl, {
        method: init.method,
        ...(init.headers === undefined ? {} : { headers: { ...init.headers } }),
        ...(init.body === undefined ? {} : { body: init.body as NonNullable<RequestInit['body']> }),
        redirect: 'manual',
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
      if (response.status >= 300 && response.status < 400) {
        throw new TransferError('A redirect from object storage was refused.');
      }
      return response;
    } catch (error) {
      if (error instanceof TransferError) throw error;
      if (signal?.aborted === true) throw error;
      // Name the failure, never the URL: its query is a credential.
      throw new TransferError('The object storage request failed.');
    }
  }
}
