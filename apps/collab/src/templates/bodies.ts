import { randomUUID } from 'node:crypto';

import { SCHEMA_VERSION, nixSchema } from '@nix/editor-schema';
import type { ItemBody } from '@nix/export';
import { SHEET_CELLS_KEY, SHEET_ITEM_TYPE, SHEET_META_KEY } from '@nix/sheet';
import type { Pool } from 'pg';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import * as Y from 'yjs';

import type { ContentDocRow } from '../db/documents.ts';
import { withTenantScope, type ScopedQuery, type TenantScope } from '../db/tenant-scope.ts';
import { lockedAmong } from '../db/locks.ts';
import { workerExecutionHeld, type WorkerExecutionFence } from '../db/worker-executions.ts';
import { CANVAS_ELEMENTS, FRAGMENT_NAME, strategyFor } from '../documents/body-kinds.ts';
import { checkMergedDocument } from '../documents/service.ts';
import { LIMITS } from '../documents/limits.ts';
import { boundSearchText } from '../documents/links.ts';
import { isRecord } from '../is-record.ts';

export interface OperationItemAuthorization {
  readonly tenantId: string;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly itemType: string;
  readonly canWrite: boolean;
}

export interface BodyCopy {
  readonly sourceItemId: string;
  readonly targetItemId: string;
  readonly itemType: string;
  readonly checkHead?: boolean;
  readonly expectedDocId?: string | null;
  readonly expectedHeadSeq?: number | null;
}

export type { WorkerExecutionFence };

export interface TemplateBodyBindings {
  readonly textBindings?: Readonly<Record<string, string>> | undefined;
  readonly referenceMappings?: ReadonlyMap<string, string | null> | undefined;
  readonly stubUnknown?: boolean | undefined;
  readonly onReferenceInventory?:
    | ((inventory: {
        sourceItemId: string;
        targetItemId: string;
        externalTargetIds: readonly string[];
      }) => void)
    | undefined;
}

const TEMPLATE_INPUT_KEY = /^[a-z][a-z0-9_-]{0,63}$/;
const TEMPLATE_TEXT_EXPANSION_BYTES = 100_000;

/** Applies the exact Collab materialization and durable-update ceilings used during commit. */
export function validateArchiveBodies(
  bundles: readonly Pick<
    { readonly id: string; readonly type: string; readonly body: ItemBody | null },
    'id' | 'type' | 'body'
  >[],
): void {
  for (const bundle of bundles) {
    if (bundle.body === null) continue;
    const state = documentFromArchiveBody(bundle.type, bundle.body);
    try {
      const strategy = strategyFor(bundle.type);
      const refusal = checkMergedDocument(state, { strategy, pin: SCHEMA_VERSION });
      if (refusal !== null) {
        throw new TemplateBodyError(`template.${refusal.code}`, refusal.detail);
      }
      if (Y.encodeStateAsUpdate(state).byteLength > LIMITS.updateBytes) {
        throw new TemplateBodyError(
          'template.body_update_too_large',
          `The body for ${bundle.id} expands beyond the collaboration update ceiling.`,
        );
      }
    } finally {
      state.destroy();
    }
  }
}

/** Copies staged bodies as fresh Yjs histories and preserves external identities for policy review. */
export async function copyBodies(
  pool: Pool,
  authorization: OperationItemAuthorization,
  copies: readonly BodyCopy[],
  itemMappings: ReadonlyMap<string, string>,
  options: TemplateBodyBindings = {},
): Promise<readonly string[]> {
  assertStagedWrite(authorization);
  return await withTenantScope(pool, scopeOf(authorization), async (sql) => {
    // A template is a copy of its sources' bodies that outlives them and is applied by whoever may
    // use the template, so a locked source would leave its lock behind. Refused rather than copied
    // empty: a template that silently lost a note's text is worse than one that says why it cannot
    // be made. Checked in the same scope the bodies are read in.
    const locked = await lockedAmong(
      sql,
      authorization.tenantId,
      copies.map((copy) => copy.sourceItemId),
    );
    if (locked.size > 0) {
      throw new TemplateBodyError(
        'template.source_locked',
        'A locked item cannot be copied. Remove its lock first.',
      );
    }
    const sourceStates = await loadSourceStates(
      sql,
      authorization.tenantId,
      copies.flatMap((copy) => [copy.sourceItemId, copy.targetItemId]),
      copies,
    );
    const fresh: FreshState[] = [];
    try {
      for (const copy of copies) {
        const staged = sourceStates.get(copy.targetItemId);
        if (staged !== undefined) {
          const stagedBody = strategyFor(copy.itemType).materialize(staged).json;
          options.onReferenceInventory?.({
            sourceItemId: copy.sourceItemId,
            targetItemId: copy.targetItemId,
            externalTargetIds: inventoryItemReferences(stagedBody).filter(
              (targetId) => !isMappedItem(targetId, itemMappings),
            ),
          });
          continue;
        }
        const source = sourceStates.get(copy.sourceItemId);
        if (source === undefined) {
          throw new TemplateBodyError(
            'template.source_body_missing',
            `The source body for ${copy.sourceItemId} disappeared before it could be copied.`,
          );
        }
        const body = strategyFor(copy.itemType).materialize(source).json;
        options.onReferenceInventory?.({
          sourceItemId: copy.sourceItemId,
          targetItemId: copy.targetItemId,
          externalTargetIds: inventoryItemReferences(body).filter(
            (targetId) => !isMappedItem(targetId, itemMappings),
          ),
        });
        fresh.push({
          targetItemId: copy.targetItemId,
          itemType: copy.itemType,
          state: fromMaterialized(
            copy.itemType,
            transformTemplateBody(copy.itemType, body, itemMappings, options),
          ),
        });
      }
      await persistFreshStates(sql, authorization, fresh);
      return copies.map((copy) => copy.targetItemId);
    } finally {
      for (const state of sourceStates.values()) state.destroy();
      for (const entry of fresh) entry.state.destroy();
    }
  });
}

/** Writes archive bodies into new staged envelopes. Existing document histories are never merged. */
export async function writeArchiveBodies(
  pool: Pool,
  authorization: OperationItemAuthorization,
  writes: readonly { sourceId: string; targetItemId: string; itemType: string; body: ItemBody }[],
  itemMappings: ReadonlyMap<string, string>,
  fence?: WorkerExecutionFence,
): Promise<readonly string[]> {
  assertStagedWrite(authorization);
  return await withTenantScope(pool, scopeOf(authorization), async (sql) => {
    if (fence !== undefined) await assertWorkerExecution(sql, authorization, fence);
    const fresh = writes.map((write) => ({
      targetItemId: write.targetItemId,
      itemType: write.itemType,
      state: documentFromArchiveBody(write.itemType, remapBody(write.body, itemMappings, false)),
    }));
    try {
      await persistFreshStates(sql, authorization, fresh);
      return writes.map((write) => write.targetItemId);
    } finally {
      for (const entry of fresh) entry.state.destroy();
    }
  });
}

async function assertWorkerExecution(
  sql: ScopedQuery,
  authorization: OperationItemAuthorization,
  fence: WorkerExecutionFence,
): Promise<void> {
  if (!(await workerExecutionHeld(sql, authorization, fence))) {
    throw new TemplateBodyError(
      'template.execution_lost',
      'The worker no longer owns this body-write execution.',
    );
  }
}

export class TemplateBodyError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'TemplateBodyError';
    this.code = code;
  }
}

interface FreshState {
  readonly targetItemId: string;
  readonly itemType: string;
  readonly state: Y.Doc;
}

interface PreparedFreshState extends FreshState {
  readonly docId: string;
  readonly update: Uint8Array;
  readonly materialized: { json: unknown; plaintext: string };
  readonly links: ReadonlyMap<string, number> | null;
}

async function persistFreshStates(
  sql: ScopedQuery,
  authorization: OperationItemAuthorization,
  inputs: readonly FreshState[],
): Promise<void> {
  if (inputs.length === 0) return;
  const targetIds = inputs.map((input) => input.targetItemId);
  const existing = await sql.query<{ item_id: string }>(
    `SELECT item_id
       FROM content_doc
      WHERE tenant_id = $1 AND item_id = ANY($2::uuid[])`,
    [authorization.tenantId, targetIds],
  );
  const existingIds = new Set(existing.rows.map((row) => row.item_id));
  const prepared: PreparedFreshState[] = [];
  for (const input of inputs) {
    // Operation target rows are fresh and hidden. An existing document means a prior idempotent
    // attempt already initialized it; never rewrite a body that may since have been activated.
    if (existingIds.has(input.targetItemId)) continue;
    const strategy = strategyFor(input.itemType);
    const refusal = checkMergedDocument(input.state, { strategy, pin: SCHEMA_VERSION });
    if (refusal !== null) {
      throw new TemplateBodyError(`template.${refusal.code}`, refusal.detail);
    }
    const update = Y.encodeStateAsUpdate(input.state);
    if (update.byteLength > LIMITS.updateBytes) {
      throw new TemplateBodyError(
        'template.body_update_too_large',
        'A template body expands beyond the collaboration update ceiling.',
      );
    }
    const materialized = strategy.materialize(input.state);
    prepared.push({
      ...input,
      docId: randomUUID(),
      update,
      materialized,
      links: strategy.extractLinks?.(materialized.json, input.targetItemId) ?? null,
    });
  }
  if (prepared.length === 0) return;

  const inserted = await insertDocuments(sql, authorization, prepared);
  const toWrite = prepared.filter((entry) => inserted.has(entry.targetItemId));
  if (toWrite.length === 0) return;
  await insertInitialUpdates(sql, authorization, toWrite);
  await insertInitialSnapshots(sql, authorization, toWrite);
  await insertInitialSearch(sql, authorization, toWrite);
  await insertInitialLinks(sql, authorization, toWrite);
}

interface SourceDocumentRow extends ContentDocRow {
  readonly snapshot_seq: string | null;
  readonly yjs_state: Buffer | null;
}

interface SourceUpdateRow extends Record<string, unknown> {
  readonly doc_id: string;
  readonly update_bytes: Buffer;
}

async function loadSourceStates(
  sql: ScopedQuery,
  tenantId: string,
  itemIds: readonly string[],
  copies: readonly BodyCopy[],
): Promise<ReadonlyMap<string, Y.Doc>> {
  if (itemIds.length === 0) return new Map();
  // Hold each visible document row through materialization so an update cannot advance its
  // head after the pin check but before its bounded update history is read.
  const documents = await sql.query<SourceDocumentRow>(
    `SELECT d.doc_id, d.item_id, d.workspace_id, d.schema_version, d.head_seq,
            snapshot.seq AS snapshot_seq, snapshot.yjs_state
       FROM content_doc d
       LEFT JOIN LATERAL (
         SELECT s.seq, s.yjs_state
           FROM content_snapshot s
          WHERE s.tenant_id = d.tenant_id
            AND s.doc_id = d.doc_id
            AND s.seq <= d.head_seq
          ORDER BY s.seq DESC
          LIMIT 1
       ) snapshot ON TRUE
      WHERE d.tenant_id = $1 AND d.item_id = ANY($2::uuid[])
      FOR SHARE OF d`,
    [tenantId, [...new Set(itemIds)]],
  );
  const heads = new Map(
    documents.rows.map((row) => [row.item_id, { docId: row.doc_id, headSeq: row.head_seq }]),
  );
  for (const copy of copies) {
    if (copy.checkHead !== true) continue;
    if (copy.expectedDocId === undefined || copy.expectedHeadSeq === undefined)
      throw new TemplateBodyError(
        'template.capture_pin_missing',
        'Core did not pin a source body.',
      );
    const actual = heads.get(copy.sourceItemId) ?? null;
    const matches =
      actual === null
        ? copy.expectedDocId === null && copy.expectedHeadSeq === null
        : copy.expectedDocId?.toLowerCase() === actual.docId.toLowerCase() &&
          copy.expectedHeadSeq !== null &&
          BigInt(actual.headSeq) === BigInt(copy.expectedHeadSeq);
    if (!matches)
      throw new TemplateBodyError(
        'templates.conflict',
        `The source body for ${copy.sourceItemId} changed since template capture began. Review it before retrying.`,
      );
  }
  const byItem = new Map<string, Y.Doc>();
  const byDoc = new Map<string, Y.Doc>();
  for (const row of documents.rows) {
    const state = new Y.Doc();
    if (row.yjs_state !== null) Y.applyUpdate(state, new Uint8Array(row.yjs_state));
    byItem.set(row.item_id, state);
    byDoc.set(row.doc_id, state);
  }
  if (documents.rows.length === 0) return byItem;

  const updates = await sql.query<SourceUpdateRow>(
    `WITH wanted AS (
       SELECT *
         FROM unnest($2::uuid[], $3::bigint[], $4::bigint[])
              AS source(doc_id, after_seq, head_seq)
     )
     SELECT stored.doc_id, stored.update_bytes
       FROM content_update stored
       JOIN wanted ON wanted.doc_id = stored.doc_id
      WHERE stored.tenant_id = $1
        AND stored.seq > wanted.after_seq
        AND stored.seq <= wanted.head_seq
      ORDER BY stored.doc_id, stored.seq`,
    [
      tenantId,
      documents.rows.map((row) => row.doc_id),
      documents.rows.map((row) => row.snapshot_seq ?? '0'),
      documents.rows.map((row) => row.head_seq),
    ],
  );
  for (const row of updates.rows) {
    const state = byDoc.get(row.doc_id);
    if (state !== undefined) Y.applyUpdate(state, new Uint8Array(row.update_bytes));
  }
  return byItem;
}

async function insertDocuments(
  sql: ScopedQuery,
  authorization: OperationItemAuthorization,
  prepared: readonly PreparedFreshState[],
): Promise<ReadonlySet<string>> {
  const result = await sql.query<{ item_id: string }>(
    `INSERT INTO content_doc
         (doc_id, tenant_id, item_id, workspace_id, schema_version, head_seq, created_at)
     SELECT input.doc_id, $1, input.item_id, $2, $3, 1, now()
       FROM unnest($4::uuid[], $5::uuid[]) AS input(doc_id, item_id)
     ON CONFLICT (tenant_id, item_id) DO NOTHING
     RETURNING item_id`,
    [
      authorization.tenantId,
      authorization.workspaceId,
      SCHEMA_VERSION,
      prepared.map((entry) => entry.docId),
      prepared.map((entry) => entry.targetItemId),
    ],
  );
  return new Set(result.rows.map((row) => row.item_id));
}

async function insertInitialUpdates(
  sql: ScopedQuery,
  authorization: OperationItemAuthorization,
  prepared: readonly PreparedFreshState[],
): Promise<void> {
  const values: string[] = [];
  const parameters: unknown[] = [authorization.tenantId, authorization.principalId];
  for (const entry of prepared) {
    const doc = parameters.push(entry.docId);
    const update = parameters.push(Buffer.from(entry.update));
    values.push(`($${String(doc)}, 1, $1, $${String(update)}, $2, 'template-operation', now())`);
  }
  await sql.query(
    `INSERT INTO content_update
         (doc_id, seq, tenant_id, update_bytes, actor_id, client_id, created_at)
     VALUES ${values.join(', ')}`,
    parameters,
  );
}

async function insertInitialSnapshots(
  sql: ScopedQuery,
  authorization: OperationItemAuthorization,
  prepared: readonly PreparedFreshState[],
): Promise<void> {
  const values: string[] = [];
  const parameters: unknown[] = [authorization.tenantId];
  for (const entry of prepared) {
    const doc = parameters.push(entry.docId);
    const state = parameters.push(Buffer.from(entry.update));
    const json = parameters.push(JSON.stringify(entry.materialized.json));
    const plaintext = parameters.push(entry.materialized.plaintext);
    values.push(
      `($${String(doc)}, 1, $1, $${String(state)}, $${String(json)}::jsonb, ` +
        `$${String(plaintext)}, now())`,
    );
  }
  await sql.query(
    `INSERT INTO content_snapshot
         (doc_id, seq, tenant_id, yjs_state, prosemirror_json, plaintext, created_at)
     VALUES ${values.join(', ')}`,
    parameters,
  );
}

async function insertInitialSearch(
  sql: ScopedQuery,
  authorization: OperationItemAuthorization,
  prepared: readonly PreparedFreshState[],
): Promise<void> {
  const values: string[] = [];
  const parameters: unknown[] = [authorization.tenantId];
  for (const entry of prepared) {
    const item = parameters.push(entry.targetItemId);
    const plaintext = parameters.push(boundSearchText(entry.materialized.plaintext));
    values.push(
      `($1, $${String(item)}, 1, now(), $${String(plaintext)}, ` +
        `to_tsvector('english', $${String(plaintext)}))`,
    );
  }
  await sql.query(
    `INSERT INTO item_search (tenant_id, item_id, seq, updated_at, body_text, body_vector)
     VALUES ${values.join(', ')}`,
    parameters,
  );
}

async function insertInitialLinks(
  sql: ScopedQuery,
  authorization: OperationItemAuthorization,
  prepared: readonly PreparedFreshState[],
): Promise<void> {
  const sources: string[] = [];
  const targets: string[] = [];
  const occurrences: number[] = [];
  for (const entry of prepared) {
    if (entry.links === null) continue;
    for (const [target, count] of entry.links) {
      sources.push(entry.targetItemId);
      targets.push(target);
      occurrences.push(count);
    }
  }
  if (sources.length === 0) return;
  await sql.query(
    `INSERT INTO item_link (tenant_id, source_item_id, target_item_id, occurrences, seq)
     SELECT $1, edge.source_id, edge.target_id, edge.occurrences, 1
       FROM unnest($2::uuid[], $3::uuid[], $4::int[])
            AS edge(source_id, target_id, occurrences)
      WHERE EXISTS (
        SELECT 1 FROM item WHERE item.tenant_id = $1 AND item.id = edge.target_id
      )`,
    [authorization.tenantId, sources, targets, occurrences],
  );
}

export function documentFromArchiveBody(itemType: string, body: ItemBody): Y.Doc {
  if (itemType === 'canvas' && 'canvas' in body) {
    return fromMaterialized(itemType, body.canvas);
  }
  if (isSheetItemType(itemType) && 'sheet' in body) {
    return fromMaterialized(itemType, body.sheet);
  }
  if ('prosemirror' in body) {
    return prosemirrorJSONToYDoc(nixSchema, body.prosemirror, FRAGMENT_NAME);
  }
  throw new TemplateBodyError(
    'template.body_kind_mismatch',
    `The archived body does not match item type "${itemType}".`,
  );
}

function fromMaterialized(itemType: string, value: unknown): Y.Doc {
  if (itemType === 'canvas') {
    const elements = nestedRecord(value, 'elements');
    const state = new Y.Doc();
    const scene = state.getMap(CANVAS_ELEMENTS);
    for (const [id, element] of Object.entries(elements)) scene.set(id, element);
    return state;
  }
  if (isSheetItemType(itemType)) {
    const sheet = record(value);
    const cells = record(sheet.cells);
    const meta = record(sheet.meta);
    const state = new Y.Doc();
    const cellMap = state.getMap(SHEET_CELLS_KEY);
    for (const [key, raw] of Object.entries(cells)) {
      if (typeof raw === 'string') cellMap.set(key, { raw });
    }
    const metaMap = state.getMap(SHEET_META_KEY);
    if (typeof meta.rows === 'number') metaMap.set('rows', meta.rows);
    if (typeof meta.cols === 'number') metaMap.set('cols', meta.cols);
    if (isRecord(meta.colWidths)) metaMap.set('colWidths', { ...meta.colWidths });
    return state;
  }
  return prosemirrorJSONToYDoc(nixSchema, value, FRAGMENT_NAME);
}

function isSheetItemType(itemType: string): boolean {
  return itemType === SHEET_ITEM_TYPE || itemType === 'sheet';
}

function remapBody(
  body: ItemBody,
  mappings: ReadonlyMap<string, string>,
  stubUnknown: boolean,
): ItemBody {
  if ('prosemirror' in body) {
    return { ...body, prosemirror: remapItemReferences(body.prosemirror, mappings, stubUnknown) };
  }
  if ('canvas' in body) {
    return { ...body, canvas: remapItemReferences(body.canvas, mappings, stubUnknown) };
  }
  return { ...body, sheet: remapItemReferences(body.sheet, mappings, stubUnknown) };
}

/** Remaps declared Nix item/file references and leaves arbitrary UUID-valued user data untouched. */
export function remapItemReferences(
  value: unknown,
  mappings: ReadonlyMap<string, string>,
  stubUnknown = false,
  referenceMappings: ReadonlyMap<string, string | null> = new Map(),
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      remapItemReferences(entry, mappings, stubUnknown, referenceMappings),
    );
  }
  if (!isRecord(value)) return value;

  const mapped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'marks' && Array.isArray(child)) {
      mapped[key] = child.flatMap((mark) => {
        if (!isRecord(mark) || mark.type !== 'link' || !isRecord(mark.attrs)) {
          return [remapItemReferences(mark, mappings, stubUnknown, referenceMappings)];
        }
        const href = mark.attrs.href;
        if (!isNixItemLink(href)) {
          return [remapItemReferences(mark, mappings, stubUnknown, referenceMappings)];
        }
        const itemId = nixItemId(href);
        if (itemId === null)
          return [remapItemReferences(mark, mappings, stubUnknown, referenceMappings)];
        const hasMapping = mappings.has(itemId) || referenceMappings.has(itemId);
        const replacement = mappings.has(itemId)
          ? mappings.get(itemId)
          : referenceMappings.get(itemId);
        if (replacement === null || (!hasMapping && stubUnknown)) return [];
        if (replacement !== undefined) {
          return [
            {
              ...mark,
              attrs: { ...mark.attrs, href: nixItemLink(replacement) },
            },
          ];
        }
        return [remapItemReferences(mark, mappings, stubUnknown, referenceMappings)];
      });
    } else {
      mapped[key] = remapItemReferences(child, mappings, stubUnknown, referenceMappings);
    }
  }
  if (
    (value.type === 'itemBlock' || value.type === 'reference') &&
    isRecord(value.attrs) &&
    (value.type === 'itemBlock' || value.attrs.kind === 'item')
  ) {
    const target = value.attrs.targetId;
    if (typeof target === 'string') {
      const hasMapping = mappings.has(target) || referenceMappings.has(target);
      const replacement = mappings.has(target)
        ? mappings.get(target)
        : referenceMappings.get(target);
      mapped.attrs = {
        ...record(mapped.attrs),
        targetId: hasMapping ? (replacement ?? null) : stubUnknown ? null : target,
      };
    }
  }
  if (value.type === 'image' && isRecord(value.attrs)) {
    const source = value.attrs.src;
    if (typeof source === 'string' && source.startsWith('nix-file:')) {
      const replacement = mappings.get(source.slice('nix-file:'.length));
      mapped.attrs = {
        ...record(mapped.attrs),
        src: replacement === undefined ? '' : `nix-file:${replacement}`,
      };
    }
  }

  remapCanvasMarker(value, mapped, mappings, stubUnknown, referenceMappings);
  remapTransitionalCanvasReference(value, mapped, mappings, stubUnknown, referenceMappings);
  return mapped;
}

/** Finds declared external item links while their original ids are still present in the body. */
export function inventoryItemReferences(value: unknown): readonly string[] {
  const found = new Set<string>();
  visitRecords(value, (recordValue) => {
    if (
      (recordValue.type === 'itemBlock' || recordValue.type === 'reference') &&
      isRecord(recordValue.attrs) &&
      (recordValue.type === 'itemBlock' || recordValue.attrs.kind === 'item') &&
      typeof recordValue.attrs.targetId === 'string'
    ) {
      found.add(recordValue.attrs.targetId);
    }
    if (Array.isArray(recordValue.marks)) {
      for (const mark of recordValue.marks) {
        if (
          isRecord(mark) &&
          mark.type === 'link' &&
          isRecord(mark.attrs) &&
          isNixItemLink(mark.attrs.href)
        ) {
          const itemId = nixItemId(mark.attrs.href);
          if (itemId !== null) found.add(itemId);
        }
      }
    }
    if (
      isRecord(recordValue.customData) &&
      isRecord(recordValue.customData.nix) &&
      recordValue.customData.nix.kind === 'item' &&
      typeof recordValue.customData.nix.itemId === 'string'
    ) {
      found.add(recordValue.customData.nix.itemId);
    }
    if (
      recordValue.type === 'card' &&
      typeof recordValue.itemId === 'string' &&
      !hasCanonicalCanvasMarker(recordValue, 'item')
    ) {
      found.add(recordValue.itemId);
    }
  });
  return [...found];
}

/** Applies Core-resolved plain-text bindings and item-reference policy before a body is staged. */
export function transformTemplateBody(
  itemType: string,
  value: unknown,
  itemMappings: ReadonlyMap<string, string>,
  options: TemplateBodyBindings = {},
): unknown {
  // Capture, editing, and archive hydration preserve unresolved markers. Core supplies a bindings
  // map only for application, where every marker must resolve before the body is materialized.
  const withText =
    options.textBindings === undefined
      ? value
      : substituteTemplateBodyText(itemType, value, options.textBindings);
  return remapItemReferences(
    withText,
    itemMappings,
    options.stubUnknown ?? true,
    options.referenceMappings ?? new Map(),
  );
}

/** Replaces only explicit prose, canvas text and literal sheet cells. */
export function substituteTemplateBodyText(
  itemType: string,
  value: unknown,
  bindings: Readonly<Record<string, string>>,
): unknown {
  const expanded = { bytes: 0 };
  if (itemType === 'canvas') return substituteCanvasText(value, bindings, expanded);
  if (itemType === 'spreadsheet' || itemType === 'sheet') {
    return substituteSheetText(value, bindings, expanded);
  }
  return substituteProseMirrorText(value, bindings, expanded, false);
}

/**
 * Rewrites the explicit marker carried by a Nix-aware Excalidraw element.
 *
 * `fileId` is otherwise an opaque Excalidraw identifier and may look like a UUID by accident, so
 * it is rewritten only when the adjacent marker declares that it is a durable Nix file item.
 */
function remapCanvasMarker(
  value: Record<string, unknown>,
  mapped: Record<string, unknown>,
  mappings: ReadonlyMap<string, string>,
  stubUnknown: boolean,
  referenceMappings: ReadonlyMap<string, string | null>,
): void {
  if (!isRecord(value.customData) || !isRecord(value.customData.nix)) return;
  const marker = value.customData.nix;
  if ((marker.kind !== 'item' && marker.kind !== 'file') || typeof marker.itemId !== 'string') {
    return;
  }

  const replacement =
    marker.kind === 'item' && !mappings.has(marker.itemId)
      ? referenceMappings.get(marker.itemId)
      : mappings.get(marker.itemId);
  if (replacement === undefined && !stubUnknown) return;

  const customData = record(mapped.customData);
  mapped.customData = {
    ...customData,
    nix: {
      ...record(customData.nix),
      itemId: replacement ?? null,
    },
  };

  if (marker.kind === 'item' && isNixItemLink(value.link)) {
    mapped.link =
      replacement === undefined || replacement === null ? null : nixItemLink(replacement);
  }
  if (marker.kind === 'item' && value.type === 'card' && typeof value.itemId === 'string') {
    mapped.itemId = replacement ?? '';
  }

  if (marker.kind === 'file' && value.type === 'image') {
    mapped.fileId = replacement ?? null;
    if (replacement === undefined) mapped.status = 'error';
    if (typeof value.imageItemId === 'string') {
      if (replacement === undefined) delete mapped.imageItemId;
      else mapped.imageItemId = replacement;
    }
  }
}

/** Keeps documents written by the temporary native canvas portable while they migrate. */
function remapTransitionalCanvasReference(
  value: Record<string, unknown>,
  mapped: Record<string, unknown>,
  mappings: ReadonlyMap<string, string>,
  stubUnknown: boolean,
  referenceMappings: ReadonlyMap<string, string | null>,
): void {
  if (
    value.type === 'card' &&
    typeof value.itemId === 'string' &&
    !hasCanonicalCanvasMarker(value, 'item')
  ) {
    const replacement = mappings.has(value.itemId)
      ? mappings.get(value.itemId)
      : referenceMappings.get(value.itemId);
    if (replacement !== undefined && replacement !== null) mapped.itemId = replacement;
    else if (stubUnknown) mapped.itemId = '';
    if (isNixItemLink(value.link)) {
      if (replacement !== undefined && replacement !== null) mapped.link = nixItemLink(replacement);
      else if (stubUnknown) mapped.link = null;
    }
  }

  if (
    value.type === 'image' &&
    typeof value.imageItemId === 'string' &&
    !hasCanonicalCanvasMarker(value, 'file')
  ) {
    const replacement = mappings.get(value.imageItemId);
    if (replacement !== undefined) mapped.imageItemId = replacement;
    else if (stubUnknown) delete mapped.imageItemId;
  }
}

function hasCanonicalCanvasMarker(value: Record<string, unknown>, kind: 'item' | 'file'): boolean {
  return (
    isRecord(value.customData) &&
    isRecord(value.customData.nix) &&
    value.customData.nix.kind === kind
  );
}

function isNixItemLink(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('nix://item/');
}

function nixItemId(href: string): string | null {
  try {
    const itemId = decodeURIComponent(href.slice('nix://item/'.length));
    return itemId.length === 0 ? null : itemId;
  } catch {
    return null;
  }
}

function nixItemLink(itemId: string): string {
  return `nix://item/${encodeURIComponent(itemId)}`;
}

function substituteProseMirrorText(
  value: unknown,
  bindings: Readonly<Record<string, string>>,
  expanded: { bytes: number },
  insideCode: boolean,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => substituteProseMirrorText(entry, bindings, expanded, insideCode));
  }
  if (!isRecord(value)) return value;
  const nodeType = typeof value.type === 'string' ? value.type : '';
  const code = insideCode || nodeType === 'codeBlock' || nodeType === 'code';
  const mapped: Record<string, unknown> = { ...value };
  if (
    nodeType === 'text' &&
    !code &&
    typeof value.text === 'string' &&
    !hasProtectedTextMark(value)
  ) {
    mapped.text = expandTemplateText(value.text, bindings, expanded);
    return mapped;
  }
  if (Array.isArray(value.content)) {
    mapped.content = value.content.map((entry) =>
      substituteProseMirrorText(entry, bindings, expanded, code),
    );
  }
  return mapped;
}

function hasProtectedTextMark(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.marks) &&
    value.marks.some((mark) => isRecord(mark) && (mark.type === 'link' || mark.type === 'code'))
  );
}

function substituteCanvasText(
  value: unknown,
  bindings: Readonly<Record<string, string>>,
  expanded: { bytes: number },
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => substituteCanvasText(entry, bindings, expanded));
  }
  if (!isRecord(value)) return value;
  const mapped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    mapped[key] = substituteCanvasText(child, bindings, expanded);
  }
  if (value.type === 'text') {
    for (const key of ['text', 'originalText'] as const) {
      if (typeof value[key] === 'string') {
        mapped[key] = expandTemplateText(value[key], bindings, expanded);
      }
    }
  }
  return mapped;
}

function substituteSheetText(
  value: unknown,
  bindings: Readonly<Record<string, string>>,
  expanded: { bytes: number },
): unknown {
  if (!isRecord(value) || !isRecord(value.cells)) return value;
  const cells: Record<string, unknown> = { ...value.cells };
  for (const [cell, rawCell] of Object.entries(value.cells)) {
    if (typeof rawCell !== 'string' || rawCell.startsWith('=')) continue;
    const raw = expandTemplateText(rawCell, bindings, expanded);
    cells[cell] = raw.startsWith('=') ? `'${raw}` : raw;
  }
  return { ...value, cells };
}

function expandTemplateText(
  text: string,
  bindings: Readonly<Record<string, string>>,
  expanded: { bytes: number },
): string {
  const output: string[] = [];
  let cursor = 0;
  let addedBytes = 0;
  while (cursor < text.length) {
    const open = text.indexOf('{{', cursor);
    const closeWithoutOpen = text.indexOf('}}', cursor);
    if (closeWithoutOpen >= 0 && (open < 0 || closeWithoutOpen < open)) {
      throw new TemplateBodyError(
        'template.input_binding_invalid',
        'A template text field contains an unmatched closing input marker.',
      );
    }
    if (open < 0) {
      output.push(text.slice(cursor));
      break;
    }
    output.push(text.slice(cursor, open));
    const close = text.indexOf('}}', open + 2);
    if (close < 0) {
      throw new TemplateBodyError(
        'template.input_binding_invalid',
        'A template text field contains an unclosed input marker.',
      );
    }
    const key = text.slice(open + 2, close);
    if (!TEMPLATE_INPUT_KEY.test(key)) {
      throw new TemplateBodyError(
        'template.input_binding_invalid',
        'A template text field contains an invalid input key.',
      );
    }
    const replacement = Object.hasOwn(bindings, key) ? bindings[key] : undefined;
    if (typeof replacement !== 'string') {
      throw new TemplateBodyError(
        'template.input_binding_missing',
        `The template body uses input "${key}" but Core did not resolve it.`,
      );
    }
    addedBytes += Math.max(
      0,
      Buffer.byteLength(replacement, 'utf8') -
        Buffer.byteLength(text.slice(open, close + 2), 'utf8'),
    );
    output.push(replacement);
    cursor = close + 2;
  }
  const result = output.join('');
  expanded.bytes += addedBytes;
  if (expanded.bytes > TEMPLATE_TEXT_EXPANSION_BYTES) {
    throw new TemplateBodyError(
      'template.text_expansion_too_large',
      'Template text substitutions exceed the supported body expansion size.',
    );
  }
  return result;
}

function isMappedItem(targetId: string, mappings: ReadonlyMap<string, string>): boolean {
  if (mappings.has(targetId)) return true;
  for (const mappedTarget of mappings.values()) {
    if (mappedTarget === targetId) return true;
  }
  return false;
}

function visitRecords(
  value: unknown,
  visitor: (recordValue: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) visitRecords(entry, visitor);
    return;
  }
  if (!isRecord(value)) return;
  visitor(value);
  for (const entry of Object.values(value)) visitRecords(entry, visitor);
}

function scopeOf(authorization: OperationItemAuthorization): TenantScope {
  return { tenantId: authorization.tenantId, principalId: authorization.principalId };
}

function assertStagedWrite(authorization: OperationItemAuthorization): void {
  if (!authorization.canWrite) {
    throw new TemplateBodyError(
      'template.operation_read_only',
      'Core did not authorize this staged template body write.',
    );
  }
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> {
  const outer = record(value);
  return record(outer[key]);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
