import type { ScopedQuery } from './tenant-scope.ts';

/**
 * The content tables, as this service reads and writes them.
 *
 * Hand-written SQL rather than an ORM, for the same reason Core writes the closure by
 * hand: these run on every keystroke's worth of traffic and their plans should be legible.
 * Every statement is tenant-parameterised as well as relying on the isolation policies -
 * defence in depth, and a predicate the planner can turn into an index condition.
 */

export interface ContentDocRow extends Record<string, unknown> {
  readonly doc_id: string;
  readonly item_id: string;
  readonly workspace_id: string;
  readonly schema_version: number;
  readonly head_seq: string;
}

export interface UpdateRow extends Record<string, unknown> {
  readonly seq: string;
  readonly update_bytes: Buffer;
  readonly actor_id: string | null;
  readonly client_id: string;
  readonly created_at: Date;
}

export interface SnapshotRow extends Record<string, unknown> {
  readonly seq: string;
  readonly yjs_state: Buffer;
}

/** Finds the document body attached to an item, if one has been created. */
export async function findDocByItem(
  sql: ScopedQuery,
  tenantId: string,
  itemId: string,
): Promise<ContentDocRow | null> {
  const { rows } = await sql.query<ContentDocRow>(
    `SELECT doc_id, item_id, workspace_id, schema_version, head_seq
     FROM content_doc
     WHERE tenant_id = $1 AND item_id = $2`,
    [tenantId, itemId],
  );

  return rows[0] ?? null;
}

/**
 * Creates the document body for an item.
 *
 * Bodies are created on first edit rather than with the item, so a folder of a thousand
 * notes nobody has opened stores a thousand rows fewer. `ON CONFLICT DO NOTHING` makes two
 * clients opening the same note at the same moment produce one document rather than an
 * error for whichever lost; the conflict target is the unique `(tenant_id, item_id)` index
 * that enforces one body per item.
 */
export async function createDoc(
  sql: ScopedQuery,
  input: {
    docId: string;
    tenantId: string;
    itemId: string;
    workspaceId: string;
    schemaVersion: number;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO content_doc
         (doc_id, tenant_id, item_id, workspace_id, schema_version, head_seq, created_at)
     VALUES ($1, $2, $3, $4, $5, 0, now())
     ON CONFLICT (tenant_id, item_id) DO NOTHING`,
    [input.docId, input.tenantId, input.itemId, input.workspaceId, input.schemaVersion],
  );
}

/**
 * Reads the updates after a sequence, in order.
 *
 * A range scan of `(doc_id, seq)`, which is the primary key, so catching up costs no
 * secondary index and no sort.
 */
export async function updatesAfter(
  sql: ScopedQuery,
  tenantId: string,
  docId: string,
  afterSeq: bigint,
  limit: number,
): Promise<UpdateRow[]> {
  const { rows } = await sql.query<UpdateRow>(
    `SELECT seq, update_bytes, actor_id, client_id, created_at
     FROM content_update
     WHERE tenant_id = $1 AND doc_id = $2 AND seq > $3
     ORDER BY seq
     LIMIT $4`,
    [tenantId, docId, afterSeq.toString(), limit],
  );

  return rows;
}

/** The newest snapshot at or before a sequence, if there is one. */
export async function snapshotAtOrBefore(
  sql: ScopedQuery,
  tenantId: string,
  docId: string,
  seq: bigint,
): Promise<SnapshotRow | null> {
  const { rows } = await sql.query<SnapshotRow>(
    `SELECT seq, yjs_state
     FROM content_snapshot
     WHERE tenant_id = $1 AND doc_id = $2 AND seq <= $3
     ORDER BY seq DESC
     LIMIT 1`,
    [tenantId, docId, seq.toString()],
  );

  return rows[0] ?? null;
}

/**
 * Appends one update and advances the document's head.
 *
 * **The sequence is allocated by the database, not by the caller.** `head_seq + 1` inside
 * an `UPDATE ... RETURNING` takes a row lock, so two concurrent appends serialise and
 * cannot be handed the same number. A number chosen in the service would collide the first
 * time two people typed at once, and the log would lose one of them.
 */
export async function appendUpdate(
  sql: ScopedQuery,
  input: {
    tenantId: string;
    docId: string;
    updateBytes: Uint8Array;
    actorId: string;
    clientId: string;
  },
): Promise<bigint> {
  const { rows } = await sql.query<{ head_seq: string }>(
    `UPDATE content_doc
     SET head_seq = head_seq + 1
     WHERE tenant_id = $1 AND doc_id = $2
     RETURNING head_seq`,
    [input.tenantId, input.docId],
  );

  const head = rows[0];
  if (head === undefined) {
    throw new Error(`No content_doc ${input.docId} is visible to this tenant.`);
  }

  const seq = BigInt(head.head_seq);

  await sql.query(
    `INSERT INTO content_update
         (doc_id, seq, tenant_id, update_bytes, actor_id, client_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [
      input.docId,
      seq.toString(),
      input.tenantId,
      Buffer.from(input.updateBytes),
      input.actorId,
      input.clientId,
    ],
  );

  return seq;
}

/** Rows per INSERT when appending a batch: far below the statement's parameter ceiling. */
const INSERT_CHUNK = 1_000;

/**
 * Appends a batch of updates in order and advances the document's head once.
 *
 * The batched shape of {@link appendUpdate}, for the flush path: a resident document
 * coalesces the updates of one flush window into one transaction, so the `head_seq` row
 * lock is taken once per window rather than once per keystroke burst - which is the
 * difference between the lock serialising flushes and the lock serialising typing.
 *
 * **One actor per batch, by construction.** `actor_id` is a per-row fact and the tenant
 * scope this runs under names one principal, so the caller splits mixed-principal queues
 * into runs before coming here rather than this function guessing.
 */
export async function appendUpdates(
  sql: ScopedQuery,
  input: {
    tenantId: string;
    docId: string;
    updates: readonly { bytes: Uint8Array; clientId: string }[];
    actorId: string;
  },
): Promise<{ firstSeq: bigint; lastSeq: bigint }> {
  if (input.updates.length === 0) {
    throw new Error('An empty batch has no sequences to allocate; do not flush nothing.');
  }

  const { rows } = await sql.query<{ head_seq: string }>(
    `UPDATE content_doc
     SET head_seq = head_seq + $3
     WHERE tenant_id = $1 AND doc_id = $2
     RETURNING head_seq`,
    [input.tenantId, input.docId, input.updates.length],
  );

  const head = rows[0];
  if (head === undefined) {
    throw new Error(`No content_doc ${input.docId} is visible to this tenant.`);
  }

  const lastSeq = BigInt(head.head_seq);
  const firstSeq = lastSeq - BigInt(input.updates.length - 1);

  // In chunks, inside the same transaction: three parameters a row against Postgres's 65,535 per
  // statement caps one INSERT near 21,800 rows, and a flush requeued through a long outage can
  // carry more than that.
  for (let start = 0; start < input.updates.length; start += INSERT_CHUNK) {
    const values: string[] = [];
    const parameters: unknown[] = [input.docId, input.tenantId, input.actorId];
    const chunk = input.updates.slice(start, start + INSERT_CHUNK);
    for (const [offset, update] of chunk.entries()) {
      const seqParam = parameters.push((firstSeq + BigInt(start + offset)).toString());
      // A view over the update's own memory rather than a copy of it.
      const bytesParam = parameters.push(
        Buffer.from(update.bytes.buffer, update.bytes.byteOffset, update.bytes.byteLength),
      );
      const clientParam = parameters.push(update.clientId);
      values.push(
        `($1, $${String(seqParam)}, $2, $${String(bytesParam)}, $3, $${String(clientParam)}, now())`,
      );
    }

    await sql.query(
      `INSERT INTO content_update
           (doc_id, seq, tenant_id, update_bytes, actor_id, client_id, created_at)
       VALUES ${values.join(', ')}`,
      parameters,
    );
  }

  return { firstSeq, lastSeq };
}

/**
 * Writes a snapshot.
 *
 * A materialisation of the log up to a sequence, never a source of truth: deleting every
 * snapshot loses nothing but the time it takes to replay. `ON CONFLICT DO NOTHING` because
 * two replicas crossing the same threshold would otherwise race to write identical rows.
 */
export async function writeSnapshot(
  sql: ScopedQuery,
  input: {
    tenantId: string;
    docId: string;
    seq: bigint;
    yjsState: Uint8Array;
    prosemirrorJson: unknown;
    plaintext: string;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO content_snapshot
         (doc_id, seq, tenant_id, yjs_state, prosemirror_json, plaintext, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, now())
     ON CONFLICT (doc_id, seq) DO NOTHING`,
    [
      input.docId,
      input.seq.toString(),
      input.tenantId,
      Buffer.from(input.yjsState),
      JSON.stringify(input.prosemirrorJson),
      input.plaintext,
    ],
  );
}

/**
 * Replaces an item's outgoing link edges with the ones just extracted.
 *
 * Two statements rather than a delete-then-insert, so an item whose links did not change is not
 * churned: the upsert carries every current edge forward at the new sequence, and the delete then
 * removes exactly the rows the new extraction did not touch, identified by their older sequence.
 *
 * **A target that does not exist is silently dropped, and that is the point.** `targetId` comes
 * out of a document, which means it comes from a browser: a reference can point at an item that
 * was deleted, or that never existed. Left to the foreign key, one such reference would abort the
 * transaction and take the snapshot with it - a document that stops saving because of a stale
 * link. The `EXISTS` filter is what keeps that a missing backlink instead. It is the only reason
 * this role holds `SELECT (tenant_id, id)` on `item`, and it reads nothing else.
 *
 * **Ordering.** Two processes holding the same document resident can snapshot concurrently.
 * `seq` decides: an older extraction never overwrites a newer one's counts. It can briefly
 * reinstate an edge a newer extraction had removed, because the guard is per row rather than per
 * document - the next snapshot deletes it again, which is the correct amount of effort to spend
 * on derived data that costs a panel row and nothing else.
 */
export async function replaceItemLinks(
  sql: ScopedQuery,
  input: {
    tenantId: string;
    sourceItemId: string;
    seq: bigint;
    links: ReadonlyMap<string, number>;
  },
): Promise<void> {
  const seq = input.seq.toString();

  if (input.links.size > 0) {
    await sql.query(
      `INSERT INTO item_link (tenant_id, source_item_id, target_item_id, occurrences, seq)
       SELECT $1, $2, edge.target_id, edge.occurrences, $3
         FROM unnest($4::uuid[], $5::int[]) AS edge(target_id, occurrences)
        WHERE EXISTS (SELECT 1 FROM item WHERE item.tenant_id = $1 AND item.id = edge.target_id)
       ON CONFLICT (tenant_id, source_item_id, target_item_id) DO UPDATE
          SET occurrences = EXCLUDED.occurrences, seq = EXCLUDED.seq
        WHERE item_link.seq < EXCLUDED.seq`,
      [input.tenantId, input.sourceItemId, seq, [...input.links.keys()], [...input.links.values()]],
    );
  }

  await sql.query(
    `DELETE FROM item_link
      WHERE tenant_id = $1 AND source_item_id = $2 AND seq < $3`,
    [input.tenantId, input.sourceItemId, seq],
  );
}

/**
 * Writes an item's searchable text.
 *
 * One row per item, replaced in place. `content_snapshot` keeps its history and this does not: a
 * search index of what a document used to say returns documents that no longer match.
 *
 * No `EXISTS` guard on the item, unlike the link edges above - the item is the one this document
 * belongs to, and `content_doc` already holds a foreign key to it, so it cannot be missing without
 * the row this was loaded from having been missing too.
 *
 * The dictionary is named here and in the migration and must agree; a vector built under one
 * configuration and searched under another stops matching without erroring.
 */
export async function writeItemSearchText(
  sql: ScopedQuery,
  input: { tenantId: string; itemId: string; seq: bigint; text: string },
): Promise<void> {
  await sql.query(
    `INSERT INTO item_search (tenant_id, item_id, seq, updated_at, body_text, body_vector)
     VALUES ($1, $2, $3, now(), $4, to_tsvector('english', $4))
     ON CONFLICT (tenant_id, item_id) DO UPDATE
        SET seq = EXCLUDED.seq,
            updated_at = EXCLUDED.updated_at,
            body_text = EXCLUDED.body_text,
            body_vector = EXCLUDED.body_vector
      WHERE item_search.seq < EXCLUDED.seq`,
    [input.tenantId, input.itemId, input.seq.toString(), input.text],
  );
}
