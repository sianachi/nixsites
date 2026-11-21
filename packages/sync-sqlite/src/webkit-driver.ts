import { fromByteArray, toByteArray } from '@nix/sync-core/base64';
import type {
  SqliteConnection,
  SqliteDriver,
  SqliteStatement,
  SqliteTransaction,
  SqliteValue,
} from './driver.js';

// Client for the iOS shell's `nixStore` message handler (and the Android shell's WebMessageListener, same messages); the wire contract is the
// "nixStore protocol" table in docs/plans/full-sync.md.

type WireValue = null | number | string | { $b64: string };
type WireRow = Record<string, WireValue>;

type Request =
  | { op: 'begin' }
  | { op: 'execute'; sql: string; params?: WireValue[]; tx?: string }
  | { op: 'commit'; tx: string }
  | { op: 'rollback'; tx: string }
  | { op: 'batch'; statements: { sql: string; params: WireValue[][] }[] }
  | { op: 'fileDownload'; key: string; url: string }
  | { op: 'fileGet'; key: string }
  | { op: 'fileDelete'; key: string }
  | { op: 'usage' }
  | { op: 'wipe' }
  | { op: 'keepAwake'; running: boolean }
  | { op: 'notify'; title?: string; body?: string };

/** Sends one request and resolves with the native reply; a native error string rejects. */
export type NixStorePost = (request: Request) => Promise<unknown>;

interface WebkitWindow {
  webkit?: {
    messageHandlers?: { nixStore?: { postMessage(message: unknown): Promise<unknown> } };
  };
}

/**
 * The Android shell's channel: a WebMessageListener object whose `postMessage` takes a string and
 * whose `onmessage` receives the replies, matched to requests by `id`. A native error string rejects.
 */
interface AndroidChannel {
  postMessage(message: string): void;
  onmessage: ((event: { data: string }) => void) | null;
}

const androidPosts = new WeakMap<AndroidChannel, (request: unknown) => Promise<unknown>>();

/** The shell's channel as a promise-returning post, or undefined outside the Android shell. */
export function androidChannelPost(
  name: string,
): ((request: unknown) => Promise<unknown>) | undefined {
  const channel = (globalThis as unknown as Record<string, AndroidChannel | undefined>)[name];
  if (typeof channel?.postMessage !== 'function') return undefined;
  let post = androidPosts.get(channel);
  if (!post) {
    const pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();
    let nextId = 0;
    channel.onmessage = (event) => {
      const { id, result, error } = JSON.parse(event.data) as {
        id: number;
        result?: unknown;
        error?: unknown;
      };
      const waiting = pending.get(id);
      pending.delete(id);
      if (error !== undefined) waiting?.reject(error);
      else waiting?.resolve(result);
    };
    post = (request) =>
      new Promise((resolve, reject) => {
        pending.set(++nextId, { resolve, reject });
        channel.postMessage(JSON.stringify({ ...(request as object), id: nextId }));
      });
    androidPosts.set(channel, post);
  }
  return post;
}

export function windowNixStorePost(): NixStorePost {
  const handler: { postMessage(message: unknown): Promise<unknown> } | undefined =
    (globalThis as unknown as WebkitWindow).webkit?.messageHandlers?.nixStore ??
    (() => {
      const post = androidChannelPost('nixStoreAndroid');
      return post && { postMessage: post };
    })();
  if (!handler) throw new Error('The nixStore message handler is not available');
  return async (request) => {
    try {
      return await handler.postMessage(request);
    } catch (error) {
      // WebKit rejects with the native error string, not an Error.
      throw error instanceof Error ? error : new Error(`nixStore ${request.op}: ${String(error)}`);
    }
  };
}

function encode(value: SqliteValue): WireValue {
  return value instanceof Uint8Array ? { $b64: fromByteArray(value) } : value;
}

function decode(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && '$b64' in value) {
    const encoded: unknown = value.$b64;
    if (typeof encoded !== 'string') throw new Error('nixStore returned a malformed blob');
    return toByteArray(encoded);
  }
  return value;
}

function reply<T extends object>(value: unknown, op: string): Partial<T> {
  if (value === null || typeof value !== 'object') throw new Error(`nixStore ${op}: empty reply`);
  return value;
}

function decodeRows(value: unknown): Record<string, unknown>[] {
  const { rows } = reply<{ rows?: WireRow[] }>(value, 'execute');
  if (!Array.isArray(rows)) throw new Error('nixStore execute: reply has no rows');
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, cell]) => [key, decode(cell)])),
  );
}

export function createWebkitSqliteDriver(post?: NixStorePost): SqliteDriver {
  return {
    open(): SqliteConnection {
      const send = post ?? windowNixStorePost();
      const run =
        (tx?: string) =>
        async (sql: string, parameters: SqliteValue[] = []) =>
          decodeRows(
            await send({
              op: 'execute',
              sql,
              params: parameters.map(encode),
              ...(tx === undefined ? {} : { tx }),
            }),
          );
      return {
        execute: run(),
        async executeBatch(statements: SqliteStatement[]) {
          await send({
            op: 'batch',
            statements: statements.map(({ sql, parameters }) => ({
              sql,
              params: parameters.map((row) => row.map(encode)),
            })),
          });
        },
        async transaction<T>(work: (transaction: SqliteTransaction) => Promise<T>): Promise<T> {
          const { tx } = reply<{ tx?: string }>(await send({ op: 'begin' }), 'begin');
          if (typeof tx !== 'string') throw new Error('nixStore begin: reply has no transaction');
          let value: T;
          try {
            value = await work({ execute: run(tx) });
          } catch (error) {
            // The native side also rolls back an idle transaction after 30 s.
            await send({ op: 'rollback', tx }).catch(() => undefined);
            throw error;
          }
          await send({ op: 'commit', tx });
          return value;
        },
        close() {
          // Native owns the connection for the origin; nothing to release here.
        },
        async delete() {
          await send({ op: 'wipe' });
        },
      };
    },
  };
}

export async function fileDownload(
  key: string,
  url: string,
  post: NixStorePost = windowNixStorePost(),
): Promise<{ bytes: number; sha256: string }> {
  const { bytes, sha256 } = reply<{ bytes?: number; sha256?: string }>(
    await post({ op: 'fileDownload', key, url }),
    'fileDownload',
  );
  if (typeof bytes !== 'number' || typeof sha256 !== 'string')
    throw new Error('nixStore fileDownload: reply has no byte count or digest');
  return { bytes, sha256 };
}

export async function fileGet(
  key: string,
  post: NixStorePost = windowNixStorePost(),
): Promise<Uint8Array | null> {
  const { data } = reply<{ data?: string | null }>(await post({ op: 'fileGet', key }), 'fileGet');
  return typeof data === 'string' ? toByteArray(data) : null;
}

export async function fileDelete(
  key: string,
  post: NixStorePost = windowNixStorePost(),
): Promise<void> {
  await post({ op: 'fileDelete', key });
}

export async function usage(
  post: NixStorePost = windowNixStorePost(),
): Promise<{ databaseBytes: number; fileBytes: number }> {
  const { databaseBytes, fileBytes } = reply<{ databaseBytes?: number; fileBytes?: number }>(
    await post({ op: 'usage' }),
    'usage',
  );
  if (typeof databaseBytes !== 'number' || typeof fileBytes !== 'number')
    throw new Error('nixStore usage: malformed reply');
  return { databaseBytes, fileBytes };
}

/** Closes and deletes this origin's database and files. */
export async function wipe(post: NixStorePost = windowNixStorePost()): Promise<void> {
  await post({ op: 'wipe' });
}
