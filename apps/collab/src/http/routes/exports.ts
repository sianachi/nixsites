import { Readable } from 'node:stream';

import { exportFileName, writeArchive, type ItemBundle } from '@nix/export';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ContentPositionUnavailableError } from '../../export/assemble.ts';
import { STREAM_MEDIA_TYPE, writeBundleStream } from '../../export/ndjson.ts';
import {
  prepareExport,
  readAtSeq,
  readExportedAt,
  readScope,
  type PreparedExport,
} from '../../export/prepare.ts';
import { establish, type RouteDependencies } from '../context.ts';
import { internalCaller } from '../auth.ts';
import { problem } from '../replies.ts';

export function registerExportRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  /**
   * The `.nix` archive: the lossless native format, served by the service that holds the bodies.
   *
   * **Collaboration's, not a converter's.** The lossless path must not depend on a lossy format
   * depend on an extension seam, and this process is the only one with both the document log and a
   * database credential - routing it through a converter service would copy every body over the
   * wire so a second process could re-zip it.
   */
  app.get('/documents/:itemId/export', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { scope?: string; format?: string };

    if (query.format !== undefined && query.format !== 'nix') {
      // A sentence rather than a 404: a client that asked the wrong service should be told which
      // one to ask, not left to guess whether the item exists.
      return problem(
        reply,
        400,
        'unsupported_format',
        'This service produces the .nix archive. PDF, Word, and Markdown exports are durable Go worker jobs started through Nix.Api.',
      );
    }

    const prepared = await establishExport(request, reply, deps, query.scope);
    if (prepared === null) {
      return reply;
    }

    const name = exportFileName(prepared.root.title, 'nix');

    return exportHeaders(reply, prepared, 'application/zip', name).send(
      Readable.from(writeArchive({ manifest: prepared.manifest, bundles: prepared.bundles })),
    );
  });

  /**
   * The same export, as bundles, for a converter in another process. [SEC]
   *
   * **Two facts authorize this, and both are required.** The shared secret says which service is
   * calling; the forwarded bearer says on whose behalf, and it goes through the same `establish`
   * every other route uses - so the Go export worker holds no authority of its own and there is still
   * one authorization code path. A wrong or missing secret answers 404 rather than 403, matching
   * Core's internal surface: a browser that stumbles onto this URL learns nothing from it.
   */
  app.get('/documents/:itemId/bundles', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!internalCaller(request, deps.internalSecret)) {
      return problem(reply, 404, 'document_not_found', 'No such item.');
    }

    const query = request.query as {
      scope?: string;
      exportedAt?: string;
      expandEmbeds?: string;
      includeComments?: string;
      atSeq?: string;
    };

    // A pinned content position is for site builds, which read one page at a time.
    let atSeq: number | undefined;
    if (query.atSeq !== undefined) {
      const parsed = readAtSeq(query.atSeq);
      if (parsed === null || (query.scope ?? 'item') !== 'item') {
        return problem(
          reply,
          400,
          'invalid_at_seq',
          "'atSeq' must be a non-negative integer and is allowed only with scope=item.",
        );
      }
      atSeq = parsed;
    }

    const prepared = await establishExport(
      request,
      reply,
      deps,
      query.scope,
      query.exportedAt,
      query.expandEmbeds === 'true',
      atSeq,
      query.includeComments === 'true',
    );
    if (prepared === null) {
      return reply;
    }

    if (atSeq !== undefined) {
      // The one body is read before the first byte is sent, so a pruned position is a 409 rather
      // than a stream that stops after the manifest.
      const collected: ItemBundle[] = [];
      try {
        for await (const bundle of prepared.bundles) collected.push(bundle);
      } catch (error) {
        if (error instanceof ContentPositionUnavailableError) {
          return problem(
            reply,
            409,
            'content_position_unavailable',
            'The body at that content position is no longer available.',
          );
        }
        throw error;
      }
      return exportHeaders(reply, prepared, STREAM_MEDIA_TYPE, null).send(
        Readable.from(
          writeBundleStream({
            manifest: prepared.manifest,
            bundles: Readable.from(collected),
          }),
        ),
      );
    }

    return exportHeaders(reply, prepared, STREAM_MEDIA_TYPE, null).send(
      Readable.from(writeBundleStream({ manifest: prepared.manifest, bundles: prepared.bundles })),
    );
  });
}

/**
 * Authorizes an export and walks its tree, or writes the refusal and returns null.
 *
 * Shared by both export routes so the two can never disagree about who may export what, or about
 * what an export of one item contains.
 */
async function establishExport(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: RouteDependencies,
  rawScope: string | undefined,
  rawExportedAt?: string,
  expandEmbeds = false,
  atSeq?: number,
  includeComments = false,
): Promise<PreparedExport | null> {
  const context = await establish(request, reply, deps);
  if (context === null) {
    return null;
  }

  const scope = readScope(rawScope ?? 'item');
  if (scope === null) {
    problem(reply, 400, 'invalid_scope', "'scope' must be 'item' or 'subtree'.");
    return null;
  }

  const exportedAt =
    rawExportedAt === undefined ? (deps.now?.() ?? new Date()) : readExportedAt(rawExportedAt);
  if (exportedAt === null) {
    problem(
      reply,
      400,
      'invalid_exported_at',
      "'exportedAt' must be a bounded RFC 3339 timestamp.",
    );
    return null;
  }

  // No tenant scope is opened here. The tree is walked against Core, as the caller, and the scope
  // is opened by the bundle stream itself and held for as long as it is being read - so a refused
  // export never reaches the database, and no transaction is held open across a Core round trip.
  const prepared = await prepareExport({
    core: deps.core,
    pool: deps.pool,
    tenant: context.scope,
    token: context.token,
    itemId: context.itemId,
    scope,
    includeDeleted: false,
    expandEmbeds,
    includeComments,
    atSeq,
    exportedAt,
  });

  if (prepared === null) {
    problem(reply, 404, 'document_not_found', 'No such item.');
    return null;
  }

  return prepared;
}

/**
 * The headers an export answers with, set before the first byte.
 *
 * The counts come from the manifest, which is complete before any body is read - so a client knows
 * how much it is getting and how much was left out without unpacking what it is about to save.
 */
function exportHeaders(
  reply: FastifyReply,
  prepared: PreparedExport,
  mediaType: string,
  fileName: string | null,
): FastifyReply {
  const withCounts = reply
    .type(mediaType)
    .header('x-nix-export-items', String(prepared.manifest.items.length))
    .header('x-nix-export-omitted', String(prepared.manifest.omitted.length))
    // Zero, and the zero is the claim: `.nix` is the lossless format, and a bundle stream has lost
    // nothing either - whatever the converter reading it goes on to lose is its own to declare.
    .header('x-nix-export-loss', '0');

  return fileName === null
    ? withCounts
    : withCounts.header('content-disposition', `attachment; filename="${fileName}"`);
}
