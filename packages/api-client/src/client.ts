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
import { NixApiError } from './errors.js';
import type { PetPlanClientIntent } from './resources/pet-plans.js';

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
  /** Dispatches one Core-prepared exact request under its one-use plan permit. No mutation retry is automatic. */
  dispatchPlanIntent(
    intent: PetPlanClientIntent,
    options?: Pick<CallOptions, 'signal'>,
  ): Promise<PetPlanClientIoResult>;
  /** Walks a cursor-paginated collection item by item. */
  paginate<TItem>(
    endpoint: PagedQueryEndpoint<TItem>,
    options?: PaginateOptions,
  ): AsyncGenerator<TItem, void, undefined>;
  /** Marks every cache entry under this key prefix stale. */
  invalidate(prefix: CacheKey): void;
}

export interface PetPlanClientIoResult {
  readonly requestId: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
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
  return createClient(config, 'core');
}

function createClient(config: NixClientConfig, destination: 'core' | 'collab'): NixClient {
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
        retain: endpoint.retain,
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
        endpoint.timeoutMs,
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

    async dispatchPlanIntent(intent, options = {}): Promise<PetPlanClientIoResult> {
      const base = new URL(config.baseUrl);
      const target = intent.target;
      const servicePrefix = destination === 'collab' ? base.pathname.replace(/\/+$/u, '') : '';
      if (
        base.username.length > 0 ||
        base.password.length > 0 ||
        base.search.length > 0 ||
        base.hash.length > 0 ||
        (destination === 'collab' && servicePrefix !== '' && servicePrefix !== '/collab') ||
        intent.destination !== destination ||
        !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(intent.method) ||
        !target.startsWith('/') ||
        target.startsWith('//') ||
        target.includes('\\') ||
        target.includes('#') ||
        Array.from(target).some(
          (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
        ) ||
        target.length > 8192 ||
        !intent.dispatchPermit ||
        intent.dispatchPermit.length > 2048 ||
        (destination === 'core' && !target.startsWith('/api/v1/'))
      )
        throw new TypeError('The prepared plan request does not match this configured service.');
      const url = new URL(target, base);
      if (url.origin !== base.origin || url.pathname + url.search !== target)
        throw new TypeError('The prepared plan request target must be an exact relative path.');
      const dispatchUrl = `${base.origin}${servicePrefix}${target}`;
      const headers = new Headers();
      for (const [name, value] of Object.entries(intent.headers)) {
        if (
          ![
            'content-type',
            'if-match',
            'idempotency-key',
            'x-nix-idempotency-key',
            'x-nix-pet-item-revisions',
          ].includes(name.toLowerCase()) ||
          value.length > 4096 ||
          /[\r\n]/u.test(value)
        )
          throw new TypeError('The prepared plan request contains a forbidden header.');
        headers.set(name, value);
      }
      if (new TextEncoder().encode(intent.body ?? '').byteLength > 131072)
        throw new TypeError('The prepared plan request exceeds the body limit.');
      headers.set('X-Nix-Pet-Plan-Request', intent.dispatchPermit);
      let token = await config.tokens.getAccessToken();
      token ??= await coordinator.refresh();
      if (token === null) throw NixApiError.fromStatus(401);
      headers.set('Authorization', `Bearer ${token}`);
      const deadline = AbortSignal.timeout(config.timeoutMs ?? 15_000);
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      let response: Response;
      try {
        response = await (config.fetch ?? fetch)(dispatchUrl, {
          method: intent.method,
          headers,
          body: intent.body ?? null,
          credentials: 'same-origin',
          redirect: 'error',
          signal,
        });
      } catch {
        if (options.signal?.aborted) throw NixApiError.canceled();
        throw NixApiError.operation(
          'pet_plans.dispatch_uncertain',
          'The request outcome is uncertain. Inspect its receipt before retrying.',
          false,
        );
      }
      if (response.status === 401) await coordinator.refresh();
      const limit = 64_000;
      const length = response.headers.get('content-length');
      if (length !== null && Number(length) > limit) {
        await response.body?.cancel();
        throw NixApiError.operation(
          'pet_plans.response_too_large',
          'The plan request response exceeded its receipt limit. Inspect the result before retrying.',
          false,
        );
      }
      const reader = response.body?.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let body = '';
      let bytes = 0;
      try {
        while (reader) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > limit) {
            await reader.cancel();
            throw NixApiError.operation(
              'pet_plans.response_too_large',
              'The plan request response exceeded its receipt limit. Inspect the result before retrying.',
              false,
            );
          }
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
      } catch (error) {
        if (error instanceof NixApiError) throw error;
        if (options.signal?.aborted) throw NixApiError.canceled();
        throw NixApiError.operation(
          'pet_plans.dispatch_uncertain',
          'The request outcome is uncertain. Inspect its receipt before retrying.',
          false,
        );
      } finally {
        reader?.releaseLock();
      }
      const resultHeaders: Record<string, string> = {};
      for (const name of [
        'content-type',
        'etag',
        'last-modified',
        'x-nix-revisions',
        'x-nix-item-revisions',
      ]) {
        const value = response.headers.get(name);
        if (value !== null && value.length <= 4096) resultHeaders[name] = value;
      }
      return { requestId: intent.requestId, status: response.status, headers: resultHeaders, body };
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

/**
 * A client for Collab's own origin: Core's contract spells collab routes `/collab/...`, which only
 * the shared ingress understands, so the prefix is dropped for a direct call.
 */
export function createDirectCollabClient(config: NixClientConfig): NixClient {
  const transport = createClient(config, 'collab');
  const strip = (path: string) => path.replace(/^\/collab(?=\/)/, '');
  const direct = <T extends { readonly path: string }>(endpoint: T): T => ({
    ...endpoint,
    path: strip(endpoint.path),
  });
  return {
    cache: transport.cache,
    query: (endpoint, options) => transport.query(direct(endpoint), options),
    queryResult: (endpoint, options) => transport.queryResult(direct(endpoint), options),
    execute: (endpoint, options) => transport.execute(direct(endpoint), options),
    stream: (request) => transport.stream({ ...request, path: strip(request.path) }),
    dispatchPlanIntent: (intent, options) => transport.dispatchPlanIntent(intent, options),
    download: (endpoint, options) => transport.download(direct(endpoint), options),
    async *paginate(endpoint, options) {
      yield* transport.paginate(direct(endpoint), options);
    },
    invalidate: (prefix) => {
      transport.invalidate(prefix);
    },
  };
}
