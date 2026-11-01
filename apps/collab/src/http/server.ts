import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { LIMITS, RateWindow } from '../documents/limits.ts';
import { describeSchema } from '../documents/service.ts';
import { createHandshakeHub } from '../ws/handshake-hub.ts';
import { CLOSE_CODES } from '../ws/protocol.ts';
import { attachWebSocketServer } from '../ws/server.ts';
import type { RouteDependencies, ServerDependencies } from './context.ts';
import { registerConversationBodyRoutes } from './routes/conversation-bodies.ts';
import { registerExportRoutes } from './routes/exports.ts';
import { registerHistoryRoutes } from './routes/history.ts';
import { registerInternalImportRoutes } from './routes/internal-imports.ts';
import { registerMarkdownRoutes } from './routes/markdown.ts';
import { registerSyncRoutes } from './routes/sync.ts';
import { registerTemplateRoutes } from './routes/templates.ts';
import { registerUpdateRoutes } from './routes/updates.ts';

export type { ServerDependencies } from './context.ts';

/**
 * The collaboration service's HTTP surface and the WebSocket endpoint it hosts.
 *
 * This file owns the Fastify instance, the socket attachment and shutdown; each route group
 * lives under `routes/`. **Every document route is authorized by Core**, through `establish`
 * in `context.ts`: nothing here decides who may read or write a document; it forwards the
 * caller's token and believes the answer, which keeps one authorization code path in the
 * system. `/healthz` and `/metrics` are open. The internal routes are gated by the service
 * secret (`internalCaller` in `auth.ts`). User operations forward their token; durable
 * conversation reads reauthorize the persisted turn and its actor through Core.
 */
export function createServer(deps: ServerDependencies): FastifyInstance {
  const app = Fastify({
    // Fastify's default is 1 MiB, which is exactly the update ceiling - leaving no room for
    // the JSON envelope around the payload. The refusal for an oversized update should be
    // this service's, with a code a client can act on, not the framework's generic one.
    bodyLimit: LIMITS.updateBytes * 2,
    // Silent under test: a suite whose assertions are buried in request logs is a suite
    // nobody reads the output of.
    logger:
      process.env.NODE_ENV === 'test'
        ? false
        : { level: process.env.NIX_COLLAB_LOG_LEVEL ?? 'info' },
  });

  const rateWindow = deps.rateWindow ?? new RateWindow();
  const newDocId = deps.newDocId ?? randomUUID;

  // The window and cache maps would otherwise grow by one entry per principal per document
  // for the process's lifetime. unref so a sweep timer never keeps the process alive.
  const sweeper = setInterval(() => {
    rateWindow.sweep();
    deps.sessions.sweep();
    deps.metrics?.authCacheSize.set(deps.sessions.size);
  }, LIMITS.windowMs);
  sweeper.unref();

  const hub = deps.hub ?? createHandshakeHub({ pool: deps.pool, newDocId });
  const wss = attachWebSocketServer(app.server, {
    sessions: deps.sessions,
    hub,
    reauthMs: deps.reauthMs ?? 60_000,
    // The same headroom the HTTP body limit gives: the update ceiling plus its envelope, so an
    // oversized update still reaches the refusal that names the limit.
    maxPayloadBytes: LIMITS.updateBytes * 2,
    metrics: deps.metrics,
    log: (message) => {
      app.log.warn(message);
    },
  });

  // preClose, not onClose: Fastify only runs onClose once the HTTP server has closed its
  // connections, and an open WebSocket is one of those connections - draining there would
  // deadlock the shutdown against the very sockets it is trying to drain.
  app.addHook('preClose', async () => {
    clearInterval(sweeper);
    // Every client is told the truth - the server is going away - rather than watching a
    // socket die. 1012 is "service restarting", which tells a client to reconnect. The
    // hub drains after the sockets are told, which is the preStop story: final flushes
    // and snapshots land inside the termination grace period, not never.
    for (const client of wss.clients) {
      client.close(CLOSE_CODES.draining, 'The server is shutting down.');
    }
    await hub.shutdown?.();
    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve();
      });
    });
  });

  app.get('/healthz', () => ({ status: 'healthy', schema: describeSchema() }));

  const routes: RouteDependencies = { ...deps, rateWindow, newDocId, hub };

  registerInternalImportRoutes(app, routes);

  if (deps.metrics !== undefined) {
    const metrics = deps.metrics;
    app.get('/metrics', async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
    });
  }

  if (deps.templates !== undefined) {
    registerTemplateRoutes(app, routes, deps.templates);
  }

  registerConversationBodyRoutes(app, routes);
  registerExportRoutes(app, routes);
  registerUpdateRoutes(app, routes);
  registerMarkdownRoutes(app, routes);
  registerSyncRoutes(app, routes);
  registerHistoryRoutes(app, routes);

  return app;
}
