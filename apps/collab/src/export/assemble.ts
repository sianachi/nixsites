import { expandEmbeddedSections } from './embedded-sections.ts';
import { SCHEMA_VERSION } from '@nix/editor-schema';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  type ArchiveManifest,
  type ItemBundle,
  type Omission,
  type SchemaSnapshot,
  type ViewRowSnapshot,
  type ViewsSnapshot,
} from '@nix/export';

import {
  canvasStrategy,
  noteStrategy,
  sheetStrategy,
  strategyFor,
} from '../documents/body-kinds.ts';
import { findDocByItem } from '../db/documents.ts';
import { lockedAmong } from '../db/locks.ts';
import type { ScopedQuery } from '../db/tenant-scope.ts';
import { stateAt } from '../db/history.ts';
import { loadDocument } from '../documents/service.ts';
import type { CoreClient, CoreItem } from '../core/client.ts';

/**
 * What one synchronous export may cost.
 *
 * **A request must not be able to walk an unbounded tree.** Every item costs two Core reads for its
 * schema and views plus a log replay for its body, so an export of everything would be a request
 * that holds a connection for minutes and a Core that spends the whole time answering it. The cap
 * is stated in the archive rather than silently applied: what was left out appears in `omitted`
 * with `limit-reached`, so a truncated export cannot be mistaken for a complete one.
 *
 * The fix when a workspace-sized export is wanted is MVP-6.5's E9 shape - a job, object storage and
 * a bulk read in Core - not a bigger number here.
 */
export const EXPORT_LIMITS = {
  maxItems: 200,
  maxDepth: 32,
  /** Concurrent Core reads while gathering schemas and views. */
  concurrency: 6,
} as const;

export type ExportScope = 'item' | 'subtree';

export interface ExportRequest {
  readonly token: string;
  readonly root: CoreItem;
  readonly scope: ExportScope;
  readonly includeDeleted: boolean;
}

export interface EnumeratedTree {
  readonly items: readonly CoreItem[];
  readonly omitted: readonly Omission[];
}

/**
 * Walks the subtree the caller asked for, parents before children, siblings in `seq` order.
 *
 * Pre-order because an import has to create a parent before the children that name it, and the
 * manifest's `items` array is what an import replays. Sorting is Core's - a listing already returns
 * siblings in position order - so nothing here re-derives it.
 *
 * **Soft-deleted children are listed and then excluded**, rather than never asked for. Asking Core
 * to hide them would leave this with no way to say they existed, and an archive that quietly omits
 * a branch is the failure ADR-0017 names outright.
 */
export async function enumerateSubtree(
  core: CoreClient,
  request: ExportRequest,
): Promise<EnumeratedTree> {
  const items: CoreItem[] = [request.root];
  const omitted: Omission[] = [];
  let remainingListings = EXPORT_LIMITS.maxItems - 1;
  let limitReported = false;

  if (request.scope === 'item') {
    return { items, omitted };
  }

  // Recursive rather than a worklist, because the order has to be depth-first *in `items`*, not
  // merely in the order branches are visited. A queue appends a parent's whole child list at once,
  // which puts every uncle before the first grandchild - still importable, since parents precede
  // children either way, but it reads as scrambled to anybody opening the archive. Recursion depth
  // is bounded by `maxDepth`.
  async function visit(parent: CoreItem, depth: number): Promise<void> {
    if (!parent.hasChildren || limitReported) {
      return;
    }

    if (depth >= EXPORT_LIMITS.maxDepth) {
      omitted.push({
        id: null,
        parentId: parent.id,
        reason: 'limit-reached',
        detail: `Descendants below depth ${String(EXPORT_LIMITS.maxDepth)} were not exported.`,
      });
      return;
    }

    if (remainingListings <= 0) {
      reportLimit(parent.id);
      return;
    }
    const listing = await listChildrenWithinBudget(
      core,
      request.token,
      parent,
      omitted,
      remainingListings,
    );
    remainingListings -= listing.read;

    for (const child of listing.children) {
      if (child.lifecycleState !== 'active' && !request.includeDeleted) {
        omitted.push({
          id: child.id,
          parentId: parent.id,
          reason: 'soft-deleted',
          detail: `"${child.title}" is deleted and was not included.`,
        });
        continue;
      }

      if (items.length >= EXPORT_LIMITS.maxItems) {
        reportLimit(parent.id);
        return;
      }

      items.push(child);
      await visit(child, depth + 1);
      if (hasReachedItemLimit()) return;
    }

    if (listing.truncated) reportLimit(parent.id);
  }

  function reportLimit(parentId: string): void {
    if (limitReported) return;
    limitReported = true;
    omitted.push({
      id: null,
      parentId,
      reason: 'limit-reached',
      detail: `This export stops after reading ${String(EXPORT_LIMITS.maxItems)} items.`,
    });
  }

  function hasReachedItemLimit(): boolean {
    return limitReported;
  }

  await visit(request.root, 0);

  return { items, omitted };
}

/** Every page of one item's children, or as many as could be read. */
async function listChildrenWithinBudget(
  core: CoreClient,
  token: string,
  parent: CoreItem,
  omitted: Omission[],
  budget: number,
): Promise<{ children: CoreItem[]; read: number; truncated: boolean }> {
  const children: CoreItem[] = [];
  let cursor: string | null = null;
  let remaining = budget;

  for (;;) {
    const page = await core.listChildren(
      token,
      parent.workspaceId,
      parent.id,
      cursor,
      Math.min(200, remaining),
    );

    if (page === null) {
      omitted.push({
        id: null,
        parentId: parent.id,
        reason: 'not-readable',
        detail: 'The children of this item could not be listed.',
      });
      return { children, read: budget - remaining, truncated: false };
    }

    const accepted = page.items.slice(0, remaining);
    children.push(...accepted);
    remaining -= accepted.length;
    cursor = page.nextCursor;

    if (cursor === null) {
      return {
        children,
        read: budget - remaining,
        truncated: page.items.length > accepted.length,
      };
    }
    if (remaining === 0) {
      return { children, read: budget, truncated: true };
    }
  }
}

export interface GatheredMetadata {
  readonly schemas: ReadonlyMap<string, SchemaSnapshot | null>;
  readonly views: ReadonlyMap<string, ViewsSnapshot | null>;

  /** The children an item's views draw, for the items that have views. See {@link gatherViewRows}. */
  readonly viewRows: ReadonlyMap<string, ViewRows>;
}

export interface ViewRows {
  readonly rows: readonly ViewRowSnapshot[];
  readonly truncated: boolean;
}

/**
 * How many children one item's views carry into an export.
 *
 * A drawing stops being readable long before this, and the ceiling exists to bound the *reads*:
 * every row here is a listing page against Core, and an item with ten thousand children would
 * otherwise turn one export into a crawl of the workspace.
 */
export const VIEW_ROW_LIMIT = 200;

/**
 * Reads every exported item's declared schema and view set.
 *
 * Held in full rather than streamed: this is small, bounded by {@link EXPORT_LIMITS}, and having it
 * up front is what lets the manifest be written before the first body. The bodies are the large
 * thing and they stay streamed.
 */
export async function gatherMetadata(
  core: CoreClient,
  token: string,
  items: readonly CoreItem[],
): Promise<GatheredMetadata> {
  const schemas = new Map<string, SchemaSnapshot | null>();
  const views = new Map<string, ViewsSnapshot | null>();

  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;

      const item = items[index];
      if (item === undefined) {
        return;
      }

      const [schema, viewSet] = await Promise.all([
        core.getSchema(token, item.id),
        core.getViews(token, item.id),
      ]);

      schemas.set(item.id, schema);
      views.set(item.id, viewSet);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(EXPORT_LIMITS.concurrency, items.length) }, () => worker()),
  );

  const viewRows = await gatherViewRows(core, token, items, views);

  return { schemas, views, viewRows };
}

/**
 * The children an item's views draw.
 *
 * **Only for items that actually offer a view**, and read as the caller: a view of children the
 * caller cannot see must not become a picture of them. This is the same listing the tree walk uses,
 * which is why an item already exported as a subtree pays for it twice - accepted, because the
 * alternative is a drawing that works in one scope and silently does not in the other.
 *
 * A listing that fails produces no rows rather than failing the export. The view then draws empty
 * and says so, which is a better answer than losing the whole document over one unreadable branch.
 */
export async function gatherViewRows(
  core: CoreClient,
  token: string,
  items: readonly CoreItem[],
  views: ReadonlyMap<string, ViewsSnapshot | null>,
): Promise<ReadonlyMap<string, ViewRows>> {
  const drawn = items.filter((item) => (views.get(item.id)?.views.length ?? 0) > 0);
  const rows = new Map<string, ViewRows>();

  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;

      const item = drawn[index];
      if (item === undefined) {
        return;
      }

      rows.set(item.id, await readRows(core, token, item));
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(EXPORT_LIMITS.concurrency, drawn.length) }, () => worker()),
  );

  return rows;
}

async function readRows(core: CoreClient, token: string, parent: CoreItem): Promise<ViewRows> {
  const rows: ViewRowSnapshot[] = [];
  let cursor: string | null = null;
  let remainingReads = VIEW_ROW_LIMIT;

  for (;;) {
    const page = await core.listChildren(
      token,
      parent.workspaceId,
      parent.id,
      cursor,
      remainingReads,
    );

    if (page === null) {
      return { rows, truncated: true };
    }

    const accepted = page.items.slice(0, remainingReads);
    remainingReads -= accepted.length;
    for (const child of accepted) {
      if (child.lifecycleState !== 'active') {
        continue;
      }

      rows.push({ id: child.id, title: child.title, properties: child.properties });
    }

    cursor = page.nextCursor;

    if (cursor === null) {
      return { rows, truncated: page.items.length > accepted.length };
    }
    if (remainingReads === 0) {
      return { rows, truncated: true };
    }
  }
}

export function buildManifest(input: {
  readonly root: CoreItem;
  readonly tree: EnumeratedTree;
  readonly metadata: GatheredMetadata;
  readonly includeDeleted: boolean;
  readonly exportedAt: Date;
  /** Items whose bodies are locked, and so are exported without one. See {@link lockedOmissions}. */
  readonly locked?: ReadonlySet<string> | undefined;
}): ArchiveManifest {
  const { root, tree, metadata, includeDeleted, exportedAt } = input;

  return {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: exportedAt.toISOString(),
    root: root.id,
    // The merged result at the root, not just what the root declares. The cascade reaches past the
    // export boundary, so without this an import lands items carrying values no schema declares.
    rootEffectiveSchema: metadata.schemas.get(root.id) ?? null,
    includesDeleted: includeDeleted,
    items: tree.items.map((item) => ({
      id: item.id,
      parentId: item.parentId,
      seq: item.seq,
      title: item.title,
      type: item.type,
    })),
    omitted: [...tree.omitted, ...lockedOmissions(tree.items, input.locked)],
    // Empty, and that emptiness is the claim: `.nix` is the lossless format, so an entry here would
    // be a bug rather than a note.
    loss: [],
  };
}

/**
 * Names every locked body the export leaves out.
 *
 * The item itself is exported - its title, properties and place in the tree are outside the lock -
 * but its body is not, and an archive that calls itself lossless must say so rather than carry a
 * `null` body that reads the same as a note nobody has opened. `id` is null and `parentId` names
 * the locked item, the same shape as "this item had more than the export took": what is missing is
 * *under* the item, not the item.
 */
function lockedOmissions(
  items: readonly CoreItem[],
  locked: ReadonlySet<string> | undefined,
): Omission[] {
  if (locked === undefined || locked.size === 0) return [];
  return items
    .filter((item) => locked.has(item.id))
    .map((item) => ({
      id: null,
      parentId: item.id,
      reason: 'not-readable' as const,
      detail: `The body of "${item.title}" is locked and was not included.`,
    }));
}

/**
 * Thrown when a body was asked for at a content position that cannot be reconstructed: it is past
 * the head, or the snapshot and updates that reach it were pruned. The route answers 409
 * `content_position_unavailable`, so a site build fails rather than publishing a different body.
 */
export class ContentPositionUnavailableError extends Error {
  readonly seq: number;

  constructor(seq: number) {
    super(`The content at position ${String(seq)} cannot be reconstructed.`);
    this.seq = seq;
    this.name = 'ContentPositionUnavailableError';
  }
}

/**
 * Produces one bundle per item, reading each body from the content log as it goes.
 *
 * One document is materialised at a time and released before the next, so the memory this costs is
 * one item's Yjs state rather than the whole export's.
 */
export async function* streamBundles(input: {
  readonly sql: ScopedQuery;
  readonly tenantId: string;
  readonly items: readonly CoreItem[];
  readonly metadata: GatheredMetadata;
  readonly resolveEmbeddedItem?: ((id: string) => Promise<CoreItem | null>) | undefined;
  /** Read each body as it stood after this log position instead of at the head. One item only. */
  readonly atSeq?: number | undefined;
}): AsyncGenerator<ItemBundle> {
  const { sql, tenantId, items, metadata } = input;

  // Read inside the scope the bodies are read in, rather than trusted from whatever the manifest
  // was built with: an item locked between the two must still leave without its body. One query
  // for the whole tree; an embedded source outside it is looked up once and remembered.
  const inTree = new Set(items.map((item) => item.id));
  const locked = new Set(await lockedAmong(sql, tenantId, [...inTree]));
  const checkedOutside = new Set<string>();
  async function isLocked(id: string): Promise<boolean> {
    if (!inTree.has(id) && !checkedOutside.has(id)) {
      checkedOutside.add(id);
      for (const found of await lockedAmong(sql, tenantId, [id])) locked.add(found);
    }
    return locked.has(id);
  }
  const readUnlocked = async (source: CoreItem): Promise<ItemBundle['body']> =>
    (await isLocked(source.id)) ? null : readBody(sql, tenantId, source, input.atSeq);

  for (const item of items) {
    yield {
      id: item.id,
      parentId: item.parentId,
      workspaceId: item.workspaceId,
      type: item.type,
      title: item.title,
      seq: item.seq,
      lifecycleState: item.lifecycleState,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      properties: item.properties,
      schema: metadata.schemas.get(item.id) ?? null,
      views: metadata.views.get(item.id) ?? null,
      viewRows: metadata.viewRows.get(item.id)?.rows ?? [],
      viewRowsTruncated: metadata.viewRows.get(item.id)?.truncated ?? false,
      body:
        input.resolveEmbeddedItem === undefined
          ? await readUnlocked(item)
          : await expandEmbeddedSections(await readUnlocked(item), async (id) => {
              const source = await input.resolveEmbeddedItem?.(id);
              if (source?.type !== 'note' || source.lifecycleState !== 'active') return null;
              // An embedded section is the source's body copied into this one, so a locked source
              // stays out exactly as it would on its own.
              const body = await readUnlocked(source);
              return body === null ? null : { title: source.title, body };
            }),
    };
  }
}

/**
 * An item's document body, or null when it has never been opened.
 *
 * **Deliberately not `openDocument`.** That creates the row on first use, which is right for an
 * editor arriving to type and wrong for an export: a read must not write, and a note nobody has
 * opened has no body rather than an empty one.
 *
 * **Every body kind gets its own branch, and a missing one is a silent data loss rather than a
 * degraded render.** A canvas fell through to the prose branch until 2026-08-13: its ProseMirror
 * fragment is empty, so `materialize` returned null, so the bundle carried `body: null` - the same
 * answer as a note nobody had opened. The scene was absent from the archive that calls itself
 * lossless, with nothing anywhere saying so. That is why the dispatch below is exhaustive over the
 * strategies rather than "sheet, or else prose".
 */
async function readBody(
  sql: ScopedQuery,
  tenantId: string,
  item: CoreItem,
  atSeq?: number,
): Promise<ItemBundle['body']> {
  const doc = await findDocByItem(sql, tenantId, item.id);
  if (doc === null) {
    return null;
  }

  const state =
    atSeq === undefined
      ? await loadDocument(sql, tenantId, doc)
      : await stateAt(sql, tenantId, doc.doc_id, atSeq);
  if (state === null) {
    throw new ContentPositionUnavailableError(atSeq ?? -1);
  }

  try {
    // The item's type chooses how the body is read, on the same axis that
    // chooses its editor and the same one the collaboration service itself
    // dispatches on. A sheet read as prose would export an empty fragment
    // and quietly lose the grid.
    const strategy = strategyFor(item.type);

    if (strategy.kind === sheetStrategy.kind) {
      return { schemaVersion: doc.schema_version, sheet: sheetStrategy.materialize(state).json };
    }

    if (strategy.kind === canvasStrategy.kind) {
      // `materialize` returns `{ elements }` for an empty scene as readily as a full one, so
      // unlike prose there is no null to check: a canvas that exists has a body, even an empty one.
      return { schemaVersion: doc.schema_version, canvas: canvasStrategy.materialize(state).json };
    }

    // Prose is the fallback for every kind this build has not heard of, which is `strategyFor`'s
    // own rule (ADR-0009) rather than a second one invented here.
    const materialized = noteStrategy.materialize(state);
    if (materialized.json === null) {
      return null;
    }

    return { schemaVersion: doc.schema_version, prosemirror: materialized.json };
  } finally {
    // Released before the next item is read, so a subtree export's ceiling is one document rather
    // than all of them.
    state.destroy();
  }
}
