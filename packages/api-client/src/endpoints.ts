/**
 * Endpoint descriptors: the typed seam between transport and resources.
 *
 * A resource method does not build a URL and hand it to a generic `request`
 * function - that is how stringly-typed clients happen. It builds a descriptor
 * that carries its own response schema, its cache identity and its
 * invalidation consequences, and the client executes it. The type parameter on
 * the descriptor is what makes `client.query(itemById(id))` return `Item`
 * without a cast anywhere.
 *
 * There are three kinds and they cannot be confused for one another:
 *
 *   - a query is a GET, is always de-duplicated and cached, and never mutates;
 *   - a command is a write, is never cached, and declares which cache keys it
 *     invalidates;
 *   - a paged query is a cursor-paginated GET, consumed as an async iterator.
 *
 * When Core's OpenAPI document is generated into `src/generated/`, the
 * per-resource modules that land in `src/resources/` are the only place path
 * strings appear; they build these descriptors from generated path and schema
 * types, and nothing above them ever sees a URL.
 */

import type { z } from 'zod';
import type { CacheKey } from './cache.js';
import type { QueryValue } from './http.js';

export type QueryParameters = Readonly<Record<string, QueryValue | undefined>>;

/** Write methods. GET is deliberately absent: reads are queries. */
type CommandMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface BinaryQueryEndpoint {
  readonly kind: 'binary-query';
  readonly operation: string;
  readonly path: string;
  readonly query: QueryParameters | undefined;
}

export interface BinaryQuerySpec {
  readonly operation: string;
  readonly path: string;
  readonly query?: QueryParameters | undefined;
}

export function defineBinaryQuery(spec: BinaryQuerySpec): BinaryQueryEndpoint {
  return {
    kind: 'binary-query',
    operation: spec.operation,
    path: spec.path,
    query: spec.query,
  };
}

export interface QueryEndpoint<TResult> {
  readonly kind: 'query';
  /** Stable label used in telemetry and cache keys, e.g. `items.get`. */
  readonly operation: string;
  readonly path: string;
  readonly query: QueryParameters | undefined;
  readonly schema: z.ZodType<TResult>;
  /** Cache identity. Defaults to the request itself when not supplied. */
  readonly cacheKey: CacheKey | undefined;
  readonly staleAfterMs: number | undefined;
  /** Budget for a deliberately long poll; ordinary reads use the client default. */
  readonly timeoutMs?: number | undefined;
}

export interface QuerySpec<TResult> {
  readonly operation: string;
  readonly path: string;
  readonly schema: z.ZodType<TResult>;
  readonly query?: QueryParameters | undefined;
  readonly cacheKey?: CacheKey | undefined;
  readonly staleAfterMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

export function defineQuery<TResult>(spec: QuerySpec<TResult>): QueryEndpoint<TResult> {
  return {
    kind: 'query',
    operation: spec.operation,
    path: spec.path,
    query: spec.query,
    schema: spec.schema,
    cacheKey: spec.cacheKey,
    staleAfterMs: spec.staleAfterMs,
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
  };
}

export interface CommandEndpoint<TResult> {
  readonly kind: 'command';
  readonly operation: string;
  readonly method: CommandMethod;
  readonly path: string;
  readonly query: QueryParameters | undefined;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly schema: z.ZodType<TResult>;
  /** Cache key prefixes marked stale once the command succeeds. */
  readonly invalidates: readonly CacheKey[];
}

export interface CommandSpec<TResult> {
  readonly operation: string;
  readonly method: CommandMethod;
  readonly path: string;
  readonly schema: z.ZodType<TResult>;
  readonly query?: QueryParameters | undefined;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly invalidates?: readonly CacheKey[] | undefined;
}

export function defineCommand<TResult>(spec: CommandSpec<TResult>): CommandEndpoint<TResult> {
  return {
    kind: 'command',
    operation: spec.operation,
    method: spec.method,
    path: spec.path,
    query: spec.query,
    body: spec.body,
    headers: spec.headers,
    schema: spec.schema,
    invalidates: spec.invalidates ?? [],
  };
}

export interface PagedQueryEndpoint<TItem> {
  readonly kind: 'paged-query';
  readonly operation: string;
  readonly path: string;
  readonly query: QueryParameters | undefined;
  readonly itemSchema: z.ZodType<TItem>;
  /** Items requested per page; Core decides what it actually returns. */
  readonly pageSize: number | undefined;
}

export interface PagedQuerySpec<TItem> {
  readonly operation: string;
  readonly path: string;
  readonly itemSchema: z.ZodType<TItem>;
  readonly query?: QueryParameters | undefined;
  readonly pageSize?: number | undefined;
}

export function definePagedQuery<TItem>(spec: PagedQuerySpec<TItem>): PagedQueryEndpoint<TItem> {
  return {
    kind: 'paged-query',
    operation: spec.operation,
    path: spec.path,
    query: spec.query,
    itemSchema: spec.itemSchema,
    pageSize: spec.pageSize,
  };
}
