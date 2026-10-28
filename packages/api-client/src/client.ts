/**
 * The client: the four layers assembled into one object.
 *
 * Construction order is the request pipeline, innermost first: the axios
 * transport, then authentication (attach token, single-flight refresh on 401),
 * then error mapping (RFC 9457 to NixApiError, telemetry). Above that sits the
 * cache for reads, and boundary parsing on every payload that comes back.
 *
 * What a caller can do with this object is deliberately narrow. There is no
 * `request(method, url)` escape hatch, no axios instance to reach, and no
 * options bag of magic strings: every call is an endpoint descriptor whose
 * type determines the result type. Per-resource modules (`src/resources/`,
 * a later goal) are thin factories over `defineQuery` / `defineCommand`, so
 * the surface grows in typed methods rather than in options.
 *
 * Every call path takes an AbortSignal, including each page of a paginated
 * walk, so an unmounting view cancels the work it started.
 */

import {
  createServerCache,
  type CacheKey,
  type ServerCache,
  type ServerCacheOptions,
} from './cache.js';
import {
  type BinaryQueryEndpoint,
  type CommandEndpoint,
  type PagedQueryEndpoint,
  type QueryEndpoint,
  type QueryParameters,
} from './endpoints.js';
import {
  createHttpTransport,
  withErrorMapping,
  type HttpMethod,
  type HttpTransport,
} from './http.js';
import {
  createRefreshCoordinator,
  sendAuthenticated,
  withAuthentication,
  type TokenProvider,
} from './auth.js';
import { parseAtBoundary } from './parse.js';
import { CURSOR_PARAM, PAGE_SIZE_PARAM, cursorPageSchema } from './schemas/pagination.js';
import type { NixTelemetry } from './telemetry.js';
import type { CursorPage } from './schemas/pagination.js';
import { z } from 'zod';

export interface NixClientConfig {
  /** Absolute base URL of Core. Comes from validated boot configuration. */
  readonly baseUrl: string;
  /** Supplies access tokens; implemented by the OIDC layer. */
  readonly tokens: TokenProvider;
  readonly timeoutMs?: number | undefined;
  readonly defaultHeaders?: Readonly<Record<string, string>> | undefined;
  readonly telemetry?: NixTelemetry | undefined;
  readonly cache?: ServerCacheOptions | undefined;
  /** Answers requests in place of the global fetch; the web demo serves an in-memory workspace. */
  readonly fetch?: typeof fetch | undefined;
}

export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
  /** Refuse binary responses larger than this limit before materializing them. */
  readonly maxResponseBytes?: number | undefined;
  /** Ignore any cached value and go to Core. Still de-duplicated. */
  readonly forceRefresh?: boolean | undefined;
}

/** Options for walking cursor-paginated queries. */
interface PaginateOptions extends CallOptions {
  /** Stop after this many network pages, even when a cursor remains. */
  readonly maxPages?: number | undefined;
}

interface QueryResult<TData> {
  readonly data: TData;
  readonly servedFromCache: boolean;
  /**
   * Non-null when a stale value was served and a refresh is running behind it.
   * A view can render "showing cached data, refreshing" honestly instead of
   * pretending the value is current.
   */
  readonly revalidation: Promise<void> | null;
}

interface BinaryResult {
  readonly blob: Blob;
  readonly headers: Readonly<Record<string, string>>;
}

/** A POST whose response is read as it arrives rather than parsed whole. */
interface StreamRequest {
  /** Path relative to the base URL; must start with `/`. */
  readonly path: string;
  /** Serialised as JSON. */
  readonly body: unknown;
  /** Aborting it aborts the underlying request, which is how a cancel reaches the server. */
  readonly signal?: AbortSignal | undefined;
}

export interface NixClient {
  /** Server state, for subscription and for the invalidation channel. */
  readonly cache: ServerCache;
  /** Executes a read and returns the parsed result. */
  query<TResult>(endpoint: QueryEndpoint<TResult>, options?: CallOptions): Promise<TResult>;
  /** Same read, plus whether it came from cache and what is happening behind it. */
  queryResult<TResult>(
    endpoint: QueryEndpoint<TResult>,
    options?: CallOptions,
  ): Promise<QueryResult<TResult>>;
  /** Executes a write and applies its declared invalidations on success. */
  execute<TResult>(endpoint: CommandEndpoint<TResult>, options?: CallOptions): Promise<TResult>;
  /** Downloads an authenticated binary response through the same refusal and cancellation path. */
  download(endpoint: BinaryQueryEndpoint, options?: CallOptions): Promise<BinaryResult>;
  /**
   * Sends an authenticated POST and hands back the raw response without reading its body, for an
   * endpoint that answers with a stream. Any status comes back as-is - mapping a problem document
   * is the caller's, since only it knows to read the body incrementally on success. There is no
   * whole-request timeout: a stream's length is the server's, and the signal is the way out.
   */
  stream(request: StreamRequest): Promise<Response>;
  /** Walks a cursor-paginated collection item by item. */
  paginate<TItem>(
    endpoint: PagedQueryEndpoint<TItem>,
    options?: PaginateOptions,
  ): AsyncGenerator<TItem, void, undefined>;
  /** Marks every cache entry under this key prefix stale. */
  invalidate(prefix: CacheKey): void;
}

function requestCacheKey(
  operation: string,
  path: string,
  query: QueryParameters | undefined,
): CacheKey {
  if (query === undefined) return [operation, path];
  const canonical = Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${String(value)}`)
    .join('&');
  return canonical === '' ? [operation, path] : [operation, path, canonical];
}

export function createNixClient(config: NixClientConfig): NixClient {
  const telemetry = config.telemetry;
  // Shared by the request pipeline and `stream`, so a 401 seen by both collapses into one refresh.
  const coordinator = createRefreshCoordinator(() => config.tokens.refreshAccessToken());
  const transport: HttpTransport = withErrorMapping(
    withAuthentication(
      createHttpTransport({
        baseUrl: config.baseUrl,
        timeoutMs: config.timeoutMs,
        defaultHeaders: config.defaultHeaders,
        fetch: config.fetch,
      }),
      { tokens: config.tokens, coordinator },
    ),
    telemetry,
  );
  const cache = createServerCache({ ...config.cache, telemetry });

  async function sendAndParse<TResult>(
    method: HttpMethod,
    path: string,
    query: QueryParameters | undefined,
    body: unknown,
    schema: z.ZodType<TResult>,
    operation: string,
    signal: AbortSignal | undefined,
    headers: Readonly<Record<string, string>> | undefined,
    timeoutMs?: number,
  ): Promise<TResult> {
    const response = await transport.send({
      method,
      path,
      query,
      body,
      signal,
      headers,
      timeoutMs,
    });
    return parseAtBoundary(schema, response.body, {
      operation,
      status: response.status,
      telemetry,
    });
  }

  async function queryResult<TResult>(
    endpoint: QueryEndpoint<TResult>,
    options: CallOptions = {},
  ): Promise<QueryResult<TResult>> {
    const key =
      endpoint.cacheKey ?? requestCacheKey(endpoint.operation, endpoint.path, endpoint.query);
    return cache.read<TResult>(
      key,
      (signal) =>
        sendAndParse(
          'GET',
          endpoint.path,
          endpoint.query,
          undefined,
          endpoint.schema,
          endpoint.operation,
          signal,
          undefined,
          endpoint.timeoutMs,
        ),
      {
        signal: options.signal,
        forceRefresh: options.forceRefresh,
        staleAfterMs: endpoint.staleAfterMs,
      },
    );
  }

  return {
    cache,

    queryResult,

    async query<TResult>(
      endpoint: QueryEndpoint<TResult>,
      options: CallOptions = {},
    ): Promise<TResult> {
      const result = await queryResult(endpoint, options);
      return result.data;
    },

    async execute<TResult>(
      endpoint: CommandEndpoint<TResult>,
      options: CallOptions = {},
    ): Promise<TResult> {
      const result = await sendAndParse(
        endpoint.method,
        endpoint.path,
        endpoint.query,
        endpoint.body,
        endpoint.schema,
        endpoint.operation,
        options.signal,
        endpoint.headers,
      );
      for (const prefix of endpoint.invalidates) cache.invalidatePrefix(prefix);
      return result;
    },

    async download(
      endpoint: BinaryQueryEndpoint,
      options: CallOptions = {},
    ): Promise<BinaryResult> {
      const response = await transport.send({
        method: 'GET',
        path: endpoint.path,
        query: endpoint.query,
        responseType: 'blob',
        signal: options.signal,
        maxResponseBytes: options.maxResponseBytes,
      });
      const blob = parseAtBoundary(z.instanceof(Blob), response.body, {
        operation: endpoint.operation,
        status: response.status,
        telemetry,
      });
      return { blob, headers: response.headers };
    },

    async stream(request: StreamRequest): Promise<Response> {
      if (!request.path.startsWith('/')) {
        throw new TypeError(
          `Request path must be relative to the base URL and start with "/": ${request.path}`,
        );
      }
      const url = `${config.baseUrl.replace(/\/+$/, '')}${request.path}`;
      const body = JSON.stringify(request.body);
      return sendAuthenticated(
        (authorization) =>
          (config.fetch ?? fetch)(url, {
            method: 'POST',
            // Bearer tokens only, as the transport: no ambient cookies.
            credentials: 'omit',
            headers: {
              ...config.defaultHeaders,
              ...authorization,
              'Content-Type': 'application/json',
              Accept: 'text/event-stream, application/problem+json',
            },
            body,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          }),
        { tokens: config.tokens, coordinator },
      );
    },

    async *paginate<TItem>(
      endpoint: PagedQueryEndpoint<TItem>,
      options: PaginateOptions = {},
    ): AsyncGenerator<TItem, void, undefined> {
      const pageSchema = cursorPageSchema(endpoint.itemSchema) as unknown as z.ZodType<
        CursorPage<TItem>
      >;
      let cursor: string | null = null;
      let pageCount = 0;
      while (pageCount === 0 || cursor !== null) {
        if (options.maxPages !== undefined && pageCount >= options.maxPages) return;
        const page: CursorPage<TItem> = await sendAndParse(
          'GET',
          endpoint.path,
          {
            ...endpoint.query,
            [PAGE_SIZE_PARAM]: endpoint.pageSize,
            [CURSOR_PARAM]: cursor ?? undefined,
          },
          undefined,
          pageSchema,
          endpoint.operation,
          options.signal,
          undefined,
        );
        pageCount += 1;
        yield* page.items;
        cursor = page.nextCursor;
      }
    },

    invalidate(prefix: CacheKey): void {
      cache.invalidatePrefix(prefix);
    },
  };
}
