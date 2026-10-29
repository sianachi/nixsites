import type { ArchiveManifest, ItemBundle } from '@nix/export';

import type { Pool } from 'pg';

import type { CoreClient, CoreItem } from '../core/client.ts';
import { lockedAmong } from '../db/locks.ts';
import { streamInTenantScope, withTenantScope, type TenantScope } from '../db/tenant-scope.ts';
import {
  buildManifest,
  enumerateSubtree,
  gatherMetadata,
  streamBundles,
  type ExportScope,
} from './assemble.ts';

/**
 * Everything an export needs, gathered once and shared by every format.
 *
 * **The traversal has two consumers and only the sink differs.** `.nix` pipes what this returns
 * into `writeArchive`; the bundles endpoint pipes it into NDJSON for the Go export worker to convert.
 * Walking the tree twice, or letting each route assemble its own manifest, is how the two would
 * start disagreeing about what an export contains - and the manifest is the thing both an archive
 * reader and an import report are read against.
 *
 * The bundles generator is returned unstarted. Enumerating the tree and gathering schemas is
 * metadata-only and bounded by `EXPORT_LIMITS`; reading bodies is neither, and keeping it lazy is
 * what holds the memory ceiling at one document rather than at the whole subtree.
 */

export interface PreparedExport {
  readonly root: CoreItem;
  readonly manifest: ArchiveManifest;
  readonly bundles: AsyncGenerator<ItemBundle>;
}

export interface PrepareRequest {
  readonly core: CoreClient;

  /**
   * The pool, not a scope.
   *
   * The tenant scope is opened by the bundle stream and held for its lifetime, so the database is
   * not touched at all for an export that is refused - and no transaction is held open across the
   * Core round trips that decide what the export contains.
   */
  readonly pool: Pool;

  /** Whose tenant the bodies are read as. Named apart from `scope`, which is what to export. */
  readonly tenant: TenantScope;

  readonly token: string;
  readonly itemId: string;
  readonly scope: ExportScope;
  readonly includeDeleted: boolean;
  readonly expandEmbeds?: boolean | undefined;
  readonly includeComments?: boolean | undefined;

  /** Read the body at this content position; only meaningful for `scope: 'item'`. */
  readonly atSeq?: number | undefined;

  /** Injected, so an export of unchanged content is byte-identical to the last one. */
  readonly exportedAt: Date;
}

/**
 * Prepares an export, or returns null when the caller cannot read its root.
 *
 * Null rather than a thrown error: "you may not see this item" is an answer, and the two routes
 * both turn it into the same 404 Core would have given. A permission failure is not exceptional
 * here - it is the ordinary result of asking for somebody else's document.
 */
export async function prepareExport(request: PrepareRequest): Promise<PreparedExport | null> {
  const root = await request.core.getItem(request.token, request.itemId);
  if (root === null) {
    return null;
  }

  const tree = await enumerateSubtree(request.core, {
    token: request.token,
    root,
    scope: request.scope,
    includeDeleted: request.includeDeleted,
  });

  const metadata = await gatherMetadata(
    request.core,
    request.token,
    tree.items,
    request.includeComments === true,
  );

  // For the manifest's account of what is missing. The bundle stream checks again in its own scope
  // and is what actually withholds a body; this read only lets the archive say so up front.
  const locked = await withTenantScope(request.pool, request.tenant, (sql) =>
    lockedAmong(
      sql,
      request.tenant.tenantId,
      tree.items.map((item) => item.id),
    ),
  );

  const manifest = buildManifest({
    root,
    tree,
    metadata,
    includeDeleted: request.includeDeleted,
    exportedAt: request.exportedAt,
    locked,
  });

  return {
    root,
    manifest,
    // Unstarted, and it opens its own tenant scope when the first bundle is pulled - so the scope
    // lives exactly as long as the reading does.
    bundles: streamInTenantScope(request.pool, request.tenant, (sql) =>
      streamBundles({
        sql,
        tenantId: request.tenant.tenantId,
        items: tree.items,
        metadata,
        atSeq: request.atSeq,
        resolveEmbeddedItem:
          request.expandEmbeds === true
            ? async (id) => {
                // Keep the signed worker delegation boundary. Outside-scope dependencies need a
                // dedicated capability before they can be fetched, even if the user can read them.
                if (!tree.items.some((item) => item.id === id)) return null;
                return request.core.getItem(request.token, id);
              }
            : undefined,
      }),
    ),
  };
}

/** Whether a query-string scope is one of the two this service serves. */
export function readScope(value: unknown): ExportScope | null {
  return value === 'item' || value === 'subtree' ? value : null;
}

/** A non-negative safe integer log position, or null. */
export function readAtSeq(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

/** Parses the durable job timestamp used to keep retries byte-stable where the format permits. */
export function readExportedAt(value: unknown): Date | null {
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
