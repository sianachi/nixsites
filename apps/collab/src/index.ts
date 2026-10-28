import { Pool } from 'pg';

import { createAuthorizer } from './auth/authorize.ts';
import { createTokenValidator } from './auth/token.ts';
import { readConfig } from './config.ts';
import { createCoreClient } from './core/client.ts';
import { createTouchedNotifier } from './core/touched.ts';
import { createCoreTemplateClient } from './templates/core.ts';
import { createTemplateService } from './templates/service.ts';
import { connectDocumentLocks } from './db/advisory-lock.ts';
import type { TenantScope } from './db/tenant-scope.ts';
import { RateWindow } from './documents/limits.ts';
import { createDocumentRegistry, type DocumentHub } from './documents/registry.ts';
import { startChunkBackfill } from './documents/chunk-backfill.ts';
import { startRetentionSweep } from './documents/retention.ts';
import { createConversationBodyAuthorizer } from './http/routes/conversation-bodies.ts';
import { createServer } from './http/server.ts';
import { createImportBodyService } from './imports/bodies.ts';
import { createCoreImportClient } from './imports/core.ts';
import { createMetrics } from './metrics.ts';
import { createTemplateImportBodyService } from './template-imports/bodies.ts';
import { createCoreTemplateImportClient } from './template-imports/core.ts';
import { createSessionAuthenticator } from './ws/session-auth.ts';

/**
 * The collaboration service's entry point.
 *
 * Configuration is read and checked first, before a socket is opened: a process that starts
 * happily and refuses every request when somebody finally opens a document is harder to
 * diagnose than one that never starts.
 */
const config = readConfig(process.env);

const pool = new Pool({
  connectionString: config.databaseUrl,
  // Small on purpose. Every request holds a connection for one transaction, and a pool
  // larger than the database's own limit turns a busy moment into a connection storm.
  max: Number(process.env.NIX_COLLAB_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
});

const metrics = createMetrics();

const coreTemplates = createCoreTemplateClient({
  coreBaseUrl: config.coreBaseUrl,
  internalSecret: config.internalSecret,
});

const sessions = createSessionAuthenticator({
  tokens: createTokenValidator({ issuers: config.oidcIssuers, audiences: config.oidcAudiences }),
  authorizer: createAuthorizer({
    coreBaseUrl: config.coreBaseUrl,
    internalSecret: config.internalSecret,
  }),
  templateItems: {
    authorize: (token, templateId, sourceId) =>
      coreTemplates.authorizeTemplateItem(token, templateId, sourceId),
  },
  draftItems: {
    authorize: (token, templateId, operationId, sourceId) =>
      coreTemplates.authorizeDraftItem(token, templateId, operationId, sourceId),
  },
});

// One dedicated connection carries every ownership claim. Losing it means every claim is
// already released on the Postgres side, so the only honest reaction is to drop every
// resident document and let clients re-route to whichever instance owns them next.
let registry: DocumentHub | null = null;
const locks = await connectDocumentLocks({
  databaseUrl: config.databaseUrl,
  onSessionLost: () => {
    // Then exit: nothing reconnects this client, so every later join would fail while /healthz
    // still said healthy. The supervisor restarts the process with a fresh session.
    void (registry?.dropAll() ?? Promise.resolve())
      .catch((cause: unknown) => {
        logHolder.write(
          `Could not drop resident documents after losing the lock session: ${String(cause)}`,
        );
      })
      .finally(() => {
        logHolder.write(
          'Lost the document lock session; exiting so the supervisor restarts collab.',
        );
        process.exit(1);
      });
  },
});

// One rate window for both transports: a principal's budget must not double because they
// opened a socket alongside a polling tab.
const rateWindow = new RateWindow();

// The registry logs through the server's logger, which exists only after createServer;
// the holder breaks the construction cycle without making either depend on the other.
const logHolder: { write: (message: string) => void } = { write: () => undefined };

registry = createDocumentRegistry({
  pool,
  locks,
  rateWindow,
  log: (message) => {
    logHolder.write(message);
  },
  config: {
    flushMs: config.flushMs,
    flushBytes: config.flushBytes,
    snapshotEvery: config.snapshotEvery,
    snapshotIntervalMs: config.snapshotIntervalMs,
    idleEvictMs: config.idleEvictMs,
    maxDocs: config.maxDocs,
    maxResidentBytes: config.maxResidentBytes,
    sweepMs: 60_000,
  },
  metrics,
  onFlushed: createTouchedNotifier({
    coreBaseUrl: config.coreBaseUrl,
    internalSecret: config.internalSecret,
  }),
});

// The tenants this process has actually authorized a request for, since it started. The
// retention sweep below reads this on every tick rather than enumerating tenants itself - a
// per-tenant connection cannot see past its own tenant under row-level security, and this
// service holds no role that bypasses it. See documents/retention.ts for the full reasoning.
const activeScopes = new Map<string, TenantScope>();

const app = createServer({
  conversationBodyAuthorizer: createConversationBodyAuthorizer(config),
  pool,
  sessions,
  core: createCoreClient({ coreBaseUrl: config.coreBaseUrl }),
  internalSecret: config.internalSecret,
  reauthMs: config.reauthSeconds * 1000,
  metrics,
  hub: registry,
  rateWindow,
  onTenantSeen: (scope) => {
    activeScopes.set(scope.tenantId, scope);
  },
  templates: createTemplateService({
    pool,
    core: coreTemplates,
    sealItems: (itemIds) => registry.sealItems(itemIds),
    invalidateItems: (itemIds) => registry.invalidateItems(itemIds),
    blockDraftAuthorization: (operationId) => {
      sessions.blockDraftOperation(operationId);
    },
    completeDraftAuthorization: (operationId) => {
      sessions.completeDraftOperation(operationId);
    },
    releaseDraftAuthorization: (operationId) => {
      sessions.releaseDraftOperation(operationId);
    },
  }),
  importBodies: createImportBodyService({
    pool,
    core: createCoreImportClient({
      coreBaseUrl: config.coreBaseUrl,
      internalSecret: config.internalSecret,
    }),
  }),
  templateImportBodies: createTemplateImportBodyService({
    pool,
    core: createCoreTemplateImportClient({
      coreBaseUrl: config.coreBaseUrl,
      internalSecret: config.internalSecret,
    }),
  }),
});

logHolder.write = (message) => {
  app.log.warn(message);
};

const retention = startRetentionSweep({
  pool,
  activeScopes: () => [...activeScopes.values()],
  intervalMs: config.retentionSweepMs,
  metrics,
  log: (message) => {
    app.log.info(message);
  },
});

const chunkBackfill = startChunkBackfill({
  pool,
  activeScopes: () => [...activeScopes.values()],
  intervalMs: 60_000,
  log: (message) => {
    app.log.info(message);
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // Close order is the drain order: stop accepting and tell every socket, drain the
    // registry (final flushes and snapshots), then release the pool and the lock session.
    // Dropping a connection mid-append would roll it back, which is correct but loses an
    // edit somebody had already seen applied locally. The retention timer stops first -
    // it holds nothing that needs draining, only a clock that must not fire into a pool
    // that is about to close.
    retention.stop();
    chunkBackfill.stop();
    app
      .close()
      .then(() => locks.close())
      .then(() => pool.end())
      .then(
        () => process.exit(0),
        (cause: unknown) => {
          // Still exit, and say so: a shutdown that fails half-way must not leave a process that
          // no longer serves anything and never ends.
          app.log.error({ err: cause }, 'Shutdown did not complete cleanly.');
          process.exit(1);
        },
      );
  });
}

await app.listen({ port: config.port, host: config.host });
