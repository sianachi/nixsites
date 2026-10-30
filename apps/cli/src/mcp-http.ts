import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createNixClient } from '@nix/api-client';
import { createWorkspaceMcpServer } from './mcp.ts';
import { openSession, type FetchImpl, type Session } from './session.ts';

/**
 * The remote MCP endpoint (requirement 9): the workspace tools served over Streamable HTTP,
 * one `Authorization: Bearer nixpat_...` per request. Host filesystem tools remain stdio-only.
 *
 * Core stays the only authority. Every request opens (or reuses) a session for exactly the token
 * it carries, so a tool call reaches Core as that principal with that token's scopes and nothing
 * more; the process holds no profile, no shared credential and no state between requests beyond a
 * bounded cache of token providers keyed by a hash of the token, which exists only so Core's PAT exchange
 * is not repeated on every call. A missing bearer is refused before any server is built. The token
 * itself is never logged or echoed.
 *
 * shortcut: header-bearer clients only (Claude Code, Cursor, Claude Desktop via mcp-remote); the
 * OAuth discovery that hosted claude.ai connectors require is deferred and documented.
 */
export interface McpHttpOptions {
  readonly apiUrl: string;
  readonly collabUrl?: string | undefined;
  /** The request path the endpoint answers on; everything else is 404. */
  readonly path?: string;
  readonly fetchImpl?: FetchImpl | undefined;
  /** How many distinct tokens keep a warm session; the least recently used is dropped past it. */
  readonly sessionCacheSize?: number;
  /** Test seam: builds the tool server for a session. */
  readonly createServer?: (session: () => Promise<Session>) => Promise<McpServer>;
}

const BEARER = /^Bearer\s+(nixpat_[A-Za-z0-9._~+/=-]+)$/i;

export function createMcpHttpHandler(
  options: McpHttpOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const path = options.path ?? '/mcp';
  const cacheSize = options.sessionCacheSize ?? 64;
  const sessions = new Map<string, Omit<Session, 'client'>>();

  const sessionFor = (token: string): Session => {
    const key = createHash('sha256').update(token).digest('hex');
    const cached = sessions.get(key);
    if (cached !== undefined) {
      // Re-insert to mark it most recently used.
      sessions.delete(key);
      sessions.set(key, cached);
      // Keep the bearer warm, but every HTTP request must get fresh authorization and data.
      return {
        ...cached,
        client: createNixClient({ baseUrl: cached.endpoints.apiUrl, tokens: cached.tokens }),
      };
    }
    const session = openSession({
      profile: {
        apiUrl: options.apiUrl,
        token,
        ...(options.collabUrl === undefined ? {} : { collabUrl: options.collabUrl }),
      },
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    sessions.set(key, { tokens: session.tokens, endpoints: session.endpoints });
    if (sessions.size > cacheSize) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    return session;
  };

  const build =
    options.createServer ??
    ((session: () => Promise<Session>) =>
      createWorkspaceMcpServer({ resolve: session, transport: 'http' }));

  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (url.pathname !== path) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const match = BEARER.exec(request.headers.authorization ?? '');
    if (match?.[1] === undefined) {
      response
        .writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer realm="nix", error="invalid_token"',
        })
        .end(
          JSON.stringify({
            error: 'A personal access token is required: Authorization: Bearer nixpat_...',
          }),
        );
      return;
    }
    const session = sessionFor(match[1]);
    const { StreamableHTTPServerTransport } =
      await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    // Stateless: no session ids, so nothing lives between requests but the token's warm session,
    // and a load balancer or restart loses nothing a client has to re-establish.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = await build(() => Promise.resolve(session));
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      // The SDK's own transport, typed with optional setters this project's strictness refuses.
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: error instanceof Error ? error.message : 'MCP request failed.',
          }),
        );
      }
    }
  };
}

/** Listens on `listen` (host:port) and answers MCP over HTTP until the process ends. */
export function startMcpHttpServer(
  options: McpHttpOptions & { readonly listen: string },
): Promise<Server> {
  const handler = createMcpHttpHandler(options);
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  const separator = options.listen.lastIndexOf(':');
  const host = separator <= 0 ? '127.0.0.1' : options.listen.slice(0, separator);
  const port = Number(options.listen.slice(separator + 1));
  if (!Number.isInteger(port) || port <= 0)
    throw new Error(`Cannot listen on '${options.listen}'.`);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      // Diagnostics go to stderr by the stdio server's rule; here stdout is free, but the habit holds.
      process.stderr.write(
        `nixctl mcp listening on http://${host}:${String(port)}${options.path ?? '/mcp'}\n`,
      );
      resolve(server);
    });
  });
}
