import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { lockDocByItem } from '../../db/documents.ts';
import { withTenantScope } from '../../db/tenant-scope.ts';
import { noteStrategy, strategyFor } from '../../documents/body-kinds.ts';
import { LIMITS, rejection } from '../../documents/limits.ts';
import {
  applyPreparedMarkdown,
  prepareMarkdown,
  readMarkdown,
  type MarkdownWriteMode,
} from '../../documents/markdown-body.ts';
import { applyUpdate, loadDocument, openDocument } from '../../documents/service.ts';
import { establish, refreshResident, type RouteDependencies } from '../context.ts';
import { problem } from '../replies.ts';

/**
 * A note body as Markdown.
 *
 * The update log stays the storage. These routes parse Markdown with the same mapping `nixctl`
 * and the editor use, append one Yjs update, and refresh any open session so a collaborator
 * sees the change without reloading. Authorization is Core's answer, through {@link establish}:
 * nothing here decides who may read or write.
 */
export function registerMarkdownRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  app.get('/documents/:itemId/markdown', async (request, reply) => readRoute(request, reply, deps));

  app.put('/documents/:itemId/markdown', async (request, reply) =>
    writeRoute(request, reply, deps, 'replace'),
  );

  app.post('/documents/:itemId/markdown', async (request, reply) =>
    writeRoute(request, reply, deps, 'append'),
  );
}

async function readRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: RouteDependencies,
): Promise<FastifyReply> {
  const context = await establish(request, reply, deps);
  if (context === null) {
    return reply;
  }
  if (!prose(context.bodyKind)) {
    return notProse(reply, context.bodyKind);
  }

  const revision = (request.query as { revision?: string } | undefined)?.revision === 'true';
  const read = await withTenantScope(deps.pool, context.scope, async (sql) => {
    const opened = await openDocument(
      sql,
      context.scope.tenantId,
      context.itemId,
      context.workspaceId,
      deps.newDocId,
    );
    if (opened === null) {
      return null;
    }
    const doc = revision
      ? await lockDocByItem(sql, context.scope.tenantId, context.itemId)
      : opened;
    if (doc?.workspace_id !== context.workspaceId) return null;
    const state = await loadDocument(sql, context.scope.tenantId, doc);
    try {
      return {
        schemaVersion: doc.schema_version,
        body: readMarkdown(state),
        ...(revision ? { revision: { documentId: doc.doc_id, headSeq: doc.head_seq } } : {}),
      };
    } finally {
      state.destroy();
    }
  });

  if (read === null) {
    return problem(reply, 404, 'document_not_found', 'No document body is visible.');
  }

  return reply.send({
    markdown: read.body.markdown,
    schemaVersion: read.schemaVersion,
    empty: read.body.empty,
    losses: read.body.losses,
    ...(read.revision === undefined ? {} : { revision: read.revision }),
  });
}

async function writeRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: RouteDependencies,
  mode: MarkdownWriteMode,
): Promise<FastifyReply> {
  const context = await establish(request, reply, deps);
  if (context === null) {
    return reply;
  }

  if (!context.canWrite) {
    const refusal = rejection('read_only', 'You may read this document but not change it.');
    return problem(reply, refusal.status, refusal.code, refusal.detail);
  }
  if (!prose(context.bodyKind)) {
    return notProse(reply, context.bodyKind);
  }

  const markdown = markdownOf(request.body);
  if (markdown === null) {
    return problem(reply, 400, 'invalid_body', 'Expected { markdown: string }.');
  }
  const body = request.body as { expectedDocumentId?: unknown; expectedHeadSeq?: unknown };
  const guarded = body.expectedDocumentId !== undefined || body.expectedHeadSeq !== undefined;
  if (
    guarded &&
    (typeof body.expectedDocumentId !== 'string' ||
      typeof body.expectedHeadSeq !== 'string' ||
      !/^\d{1,19}$/.test(body.expectedHeadSeq))
  ) {
    return problem(reply, 400, 'invalid_body', 'Expected a document ID and head sequence.');
  }

  // Bound and parse before the document is opened, so a body that cannot be applied never
  // spends a database round trip or creates an empty document row.
  const prepared = prepareMarkdown(markdown, mode);
  if (!prepared.ok) {
    return prepared.tooLong === true
      ? problem(reply, 413, 'markdown_too_large', prepared.reason)
      : problem(reply, 422, 'markdown_invalid', prepared.reason);
  }

  if (deps.rateWindow.exceeded(context.scope.principalId, context.itemId)) {
    const refusal = rejection(
      'rate_limited',
      `At most ${String(LIMITS.updatesPerWindow)} updates per document per minute.`,
    );
    return problem(reply, refusal.status, refusal.code, refusal.detail);
  }

  const outcome = await withTenantScope(deps.pool, context.scope, async (sql) => {
    const opened = await openDocument(
      sql,
      context.scope.tenantId,
      context.itemId,
      context.workspaceId,
      deps.newDocId,
    );
    if (opened === null) {
      return null;
    }
    const doc = guarded ? await lockDocByItem(sql, context.scope.tenantId, context.itemId) : opened;
    if (doc?.workspace_id !== context.workspaceId) return null;
    if (
      guarded &&
      (doc.doc_id !== body.expectedDocumentId || doc.head_seq !== body.expectedHeadSeq)
    ) {
      return { kind: 'stale' as const };
    }

    const state = await loadDocument(sql, context.scope.tenantId, doc);
    try {
      const delta = applyPreparedMarkdown(state, prepared, mode);
      if (!delta.ok) {
        return { kind: 'rejected' as const, reason: delta.reason, tooLong: delta.tooLong === true };
      }

      const applied = await applyUpdate(sql, {
        tenantId: context.scope.tenantId,
        doc,
        updateBytes: delta.update,
        actorId: context.scope.principalId,
        clientId: `api-markdown-${randomUUID()}`,
        // A stateless write has no session to snapshot later. Publish now, as the raw update
        // route does, so search and backlinks see the text without someone opening the note.
        snapshotEvery: 1,
        strategy: strategyFor(context.bodyKind),
      });
      return {
        kind: 'applied' as const,
        docId: doc.doc_id,
        applied,
        bytes: delta.update.byteLength,
        scan: delta.scan,
      };
    } finally {
      state.destroy();
    }
  });

  if (outcome === null) {
    return problem(reply, 404, 'document_not_found', 'No document body is visible.');
  }
  if (outcome.kind === 'stale') {
    return problem(
      reply,
      409,
      'document_changed',
      'The note changed after review. Create a new preview.',
    );
  }
  if (outcome.kind === 'rejected') {
    return outcome.tooLong
      ? problem(reply, 413, 'markdown_too_large', outcome.reason)
      : problem(reply, 422, 'markdown_invalid', outcome.reason);
  }
  if (!outcome.applied.ok) {
    const error = outcome.applied.error;
    return problem(reply, error.status, error.code, error.detail);
  }

  await refreshResident(request, deps, context.itemId);

  return reply.send({
    docId: outcome.docId,
    seq: outcome.applied.value.seq.toString(),
    snapshotWritten: outcome.applied.value.snapshotWritten,
    updateBytes: outcome.bytes,
    markdownChanges: outcome.scan,
  });
}

function prose(bodyKind: string): boolean {
  // Unknown kinds fall through to the prose strategy (ADR-0009). Only the kinds that strategy
  // dispatches away from prose are refused; a new prose kind is written best-effort.
  return strategyFor(bodyKind).kind === noteStrategy.kind;
}

function notProse(reply: FastifyReply, bodyKind: string): FastifyReply {
  return problem(
    reply,
    422,
    'body_not_prose',
    `This item is a ${bodyKind}, which Markdown cannot carry.`,
  );
}

function markdownOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const markdown = (body as { markdown?: unknown }).markdown;
  return typeof markdown === 'string' ? markdown : null;
}
