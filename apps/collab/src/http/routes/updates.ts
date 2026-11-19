import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  findUpdateReceipt,
  lockDocByItem,
  snapshotAtOrBefore,
  updatesAfter,
} from '../../db/documents.ts';
import { lockedAmong } from '../../db/locks.ts';
import { withTenantScope } from '../../db/tenant-scope.ts';
import { strategyFor } from '../../documents/body-kinds.ts';
import { LIMITS, rejection } from '../../documents/limits.ts';
import { CATCH_UP_LIMIT, applyUpdate, openDocument } from '../../documents/service.ts';
import { establish, refreshResident, type RouteDependencies } from '../context.ts';
import { decodeBase64, isUuid, parseAfterCursor } from '../params.ts';
import { problem } from '../replies.ts';

/** The update log over plain HTTP: catch up from a sequence, and append one update. */
export function registerUpdateRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const { rateWindow, newDocId } = deps;

  app.get('/documents/:itemId/updates', async (request: FastifyRequest, reply: FastifyReply) => {
    const context = await establish(request, reply, deps);
    if (context === null) {
      return reply;
    }

    const { after, fromCheckpoint } = request.query as {
      after?: string;
      fromCheckpoint?: string;
    };
    const afterSeq = parseAfterCursor(after);
    if (afterSeq === null) {
      return problem(reply, 400, 'invalid_cursor', "'after' must be a non-negative integer.");
    }

    return await withTenantScope(deps.pool, context.scope, async (sql) => {
      const doc = await openDocument(
        sql,
        context.scope.tenantId,
        context.itemId,
        context.workspaceId,
        newDocId,
      );

      if (doc === null) {
        return problem(reply, 404, 'document_not_found', 'No document body is visible.');
      }

      const checkpoint =
        afterSeq === 0n
          ? await snapshotAtOrBefore(sql, context.scope.tenantId, doc.doc_id, BigInt(doc.head_seq))
          : null;
      const rows = await updatesAfter(
        sql,
        context.scope.tenantId,
        doc.doc_id,
        fromCheckpoint === 'true' && checkpoint !== null ? BigInt(checkpoint.seq) : afterSeq,
        CATCH_UP_LIMIT,
      );

      return reply.send({
        docId: doc.doc_id,
        headSeq: doc.head_seq,
        schemaVersion: doc.schema_version,
        canWrite: context.canWrite,
        // Retained checkpoints cover pruned log rows; keep the legacy update page for older readers.
        ...(checkpoint === null
          ? {}
          : {
              checkpoint: {
                seq: checkpoint.seq,
                update: Buffer.from(checkpoint.yjs_state).toString('base64'),
              },
            }),
        // Base64 rather than a binary body, because a catch-up returns many updates and a
        // multipart response would be a bespoke framing for both sides to get wrong.
        updates: rows.map((row) => ({
          seq: row.seq,
          clientId: row.client_id,
          update: Buffer.from(row.update_bytes).toString('base64'),
        })),
        // A full page means there is probably more; the client asks again from the last
        // sequence rather than assuming it has caught up.
        hasMore: rows.length === CATCH_UP_LIMIT,
      });
    });
  });

  app.post('/documents/:itemId/updates', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as
      | { update?: unknown; clientId?: unknown; expectedDocId?: unknown; expectedHeadSeq?: unknown }
      | undefined;
    const guarded = body?.expectedHeadSeq !== undefined;
    const context = await establish(request, reply, deps, guarded);
    if (context === null) {
      return reply;
    }

    if (!context.canWrite) {
      // The permission gap the internal surface closed: reading an item never implied
      // writing its body, and now the answer that says so is enforced where the write lands.
      const refusal = rejection('read_only', 'You may read this document but not change it.');
      return problem(reply, refusal.status, refusal.code, refusal.detail);
    }

    if (typeof body?.update !== 'string' || typeof body.clientId !== 'string') {
      return problem(
        reply,
        400,
        'invalid_body',
        'Expected { update: base64 string, clientId: string }.',
      );
    }

    if (
      body.expectedDocId !== undefined &&
      (typeof body.expectedDocId !== 'string' || !isUuid(body.expectedDocId))
    ) {
      return problem(reply, 400, 'invalid_body', "'expectedDocId' must be a UUID.");
    }
    const expectedDocId = body.expectedDocId?.toLowerCase();
    const expectedHead =
      typeof body.expectedHeadSeq === 'string' && body.expectedHeadSeq.length <= 19
        ? parseAfterCursor(body.expectedHeadSeq)
        : null;
    if (guarded && (expectedDocId === undefined || expectedHead === null)) {
      return problem(
        reply,
        400,
        'invalid_body',
        "'expectedHeadSeq' must be a non-negative sequence string and requires 'expectedDocId'.",
      );
    }

    // Applied before any database work: backpressure that costs a round trip is not much
    // backpressure.
    if (rateWindow.exceeded(context.scope.principalId, context.itemId)) {
      const refusal = rejection(
        'rate_limited',
        `At most ${String(LIMITS.updatesPerWindow)} updates per document per minute.`,
      );
      return problem(reply, refusal.status, refusal.code, refusal.detail);
    }

    const updateBytes = decodeBase64(body.update);
    if (updateBytes === null) {
      return problem(reply, 400, 'invalid_body', "'update' is not valid base64.");
    }

    const { tenantId, principalId } = context.scope;
    const { clientId } = body;
    const outcome = await withTenantScope(deps.pool, context.scope, async (sql) => {
      if (expectedHead !== null) {
        // Core's lock and move writers hold this workspace key exclusively.
        await sql.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
          `finance-workspace:${context.workspaceId.toLowerCase()}`,
        ]);
        if ((await lockedAmong(sql, tenantId, [context.itemId])).size !== 0) {
          return { kind: 'body_locked' } as const;
        }
      }

      const doc =
        expectedHead === null
          ? await openDocument(sql, tenantId, context.itemId, context.workspaceId, newDocId)
          : await lockDocByItem(sql, tenantId, context.itemId);
      if (doc?.workspace_id !== context.workspaceId) {
        return null;
      }

      if (expectedDocId !== undefined && expectedDocId !== doc.doc_id) {
        return { kind: 'document_changed' } as const;
      }

      if (expectedHead !== null && expectedHead !== BigInt(doc.head_seq)) {
        const receipt =
          expectedHead < BigInt(doc.head_seq)
            ? await findUpdateReceipt(sql, {
                tenantId,
                docId: doc.doc_id,
                seq: expectedHead + 1n,
                actorId: principalId,
                clientId,
                updateBytes,
              })
            : null;
        return receipt === null
          ? ({ kind: 'revision_changed' } as const)
          : ({ kind: 'replayed', docId: doc.doc_id, receipt } as const);
      }

      const applied = await applyUpdate(sql, {
        tenantId,
        doc,
        updateBytes,
        actorId: principalId,
        clientId,
        // Publish on every REST write, not on the resident cadence. A socket session snapshots
        // when the last editor detaches - "exactly when they are owed" - because the snapshot is
        // what publishes a document's searchable text and its link edges. A stateless request has
        // no session, no idle clock and no eviction, so the moment its update lands is the only
        // moment it can ever publish: with the cadence applied here, a body written once through
        // this path (nixctl note write, an import) stayed invisible to search and backlinks until
        // someone happened to open it in the editor. Found live, 2026-08-21, importing 10k notes.
        snapshotEvery: 1,
        strategy: strategyFor(context.bodyKind),
      });

      return { kind: 'applied', docId: doc.doc_id, applied } as const;
    });

    if (outcome === null) {
      return problem(reply, 404, 'document_not_found', 'No document body is visible.');
    }
    if (outcome.kind === 'document_changed') {
      return problem(
        reply,
        409,
        'document_changed',
        'The document body changed before this upload.',
      );
    }
    if (outcome.kind === 'body_locked') {
      return problem(reply, 403, 'body_locked', 'This item is locked.');
    }
    if (outcome.kind === 'revision_changed') {
      return problem(
        reply,
        409,
        'revision_changed',
        'The document changed after the edit was prepared.',
      );
    }
    if (outcome.kind === 'replayed') {
      await refreshResident(request, deps, context.itemId);
      return reply.code(202).send({ docId: outcome.docId, ...outcome.receipt });
    }
    const { docId, applied } = outcome;
    if (!applied.ok) {
      return problem(reply, applied.error.status, applied.error.code, applied.error.detail);
    }

    // After the commit, never inside it: a session reading the log from within this transaction's
    // lifetime would not see the row yet.
    await refreshResident(request, deps, context.itemId);

    return reply.code(202).send({
      docId,
      seq: applied.value.seq.toString(),
      snapshotWritten: applied.value.snapshotWritten,
    });
  });
}
