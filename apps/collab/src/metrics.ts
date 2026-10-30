import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';

/**
 * The service's operational signals, named for the questions they answer.
 *
 * A resident-document server has exactly two ways to die - out of memory, and behind on
 * flushes - and both are visible here before they happen. That is the bar for adding a
 * metric: it must inform eviction tuning, capacity refusal, or an alert someone would act
 * on. Per-document label cardinality is deliberately avoided; totals and distributions
 * answer the operational questions without turning the registry into a second copy of the
 * document table.
 */
export interface CollabMetrics {
  readonly registry: Registry;

  /** Sockets accepted, by outcome of the handshake. */
  readonly connectionsTotal: Counter<'outcome'>;

  /** Handshakes refused, by close code. */
  readonly refusalsTotal: Counter<'code'>;

  /** Sockets currently open. */
  readonly openSockets: Gauge;

  /** Documents currently resident in memory. */
  readonly loadedDocuments: Gauge;

  /** Estimated bytes of resident document state, all documents together. */
  readonly residentBytes: Gauge;

  /** How long a flush takes, queue to committed. */
  readonly flushSeconds: Histogram;

  /** Flushes whose append failed and whose updates went back on the queue. */
  readonly flushFailuresTotal: Counter;

  /** Updates appended to the log, socket and HTTP paths alike. */
  readonly updatesAppendedTotal: Counter;

  /** Cached session authorizations, so a leak here is a graph rather than a surprise. */
  readonly authCacheSize: Gauge;

  /** Rows the retention sweep has deleted, by kind: update or snapshot. */
  readonly retentionDeletedTotal: Counter<'kind'>;

  /** Documents the retention sweep could not prune, logged and skipped rather than fatal. */
  readonly retentionFailuresTotal: Counter;
}

export function createMetrics(): CollabMetrics {
  const registry = new Registry();

  return {
    registry,
    connectionsTotal: new Counter({
      name: 'nix_collab_connections_total',
      help: 'WebSocket handshakes, by outcome.',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    refusalsTotal: new Counter({
      name: 'nix_collab_refusals_total',
      help: 'WebSocket refusals, by close code.',
      labelNames: ['code'],
      registers: [registry],
    }),
    openSockets: new Gauge({
      name: 'nix_collab_open_sockets',
      help: 'Sockets currently open.',
      registers: [registry],
    }),
    loadedDocuments: new Gauge({
      name: 'nix_collab_loaded_documents',
      help: 'Documents currently resident in memory.',
      registers: [registry],
    }),
    residentBytes: new Gauge({
      name: 'nix_collab_resident_bytes',
      help: 'Estimated bytes of resident document state, all documents together.',
      registers: [registry],
    }),
    flushSeconds: new Histogram({
      name: 'nix_collab_flush_seconds',
      help: 'Flush duration, queue to committed.',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [registry],
    }),
    flushFailuresTotal: new Counter({
      name: 'nix_collab_flush_failures_total',
      help: 'Flushes whose append to the log failed; their updates were queued again for retry.',
      registers: [registry],
    }),
    updatesAppendedTotal: new Counter({
      name: 'nix_collab_updates_appended_total',
      help: 'Updates appended to the log, socket and HTTP paths alike.',
      registers: [registry],
    }),
    authCacheSize: new Gauge({
      name: 'nix_collab_auth_cache_entries',
      help: 'Cached session authorizations.',
      registers: [registry],
    }),
    retentionDeletedTotal: new Counter({
      name: 'nix_collab_retention_deleted_total',
      help: 'Rows the retention sweep has deleted, by kind.',
      labelNames: ['kind'],
      registers: [registry],
    }),
    retentionFailuresTotal: new Counter({
      name: 'nix_collab_retention_failures_total',
      help: 'Documents the retention sweep could not prune.',
      registers: [registry],
    }),
  };
}
