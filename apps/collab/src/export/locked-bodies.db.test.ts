import type { Pool } from 'pg';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { lockedAmong } from '../db/locks.ts';
import {
  DB_TESTS_ENABLED,
  TENANTS,
  adminPool,
  clearContent,
  collabPool,
  seedTenants,
  scopeOf,
  type TestTenant,
} from '../db/testing.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import { sheetStrategy } from '../documents/body-kinds.ts';
import { applyUpdate, openDocument } from '../documents/service.ts';
import type { CoreItem } from '../core/client.ts';
import { streamBundles } from './assemble.ts';

/**
 * A subtree export reads its descendants' bodies straight from the content tables, below the one
 * item Core authorized - so it has to leave locked bodies out on its own.
 *
 * Core refuses to start an export that contains a locked item. This is the backstop for an item
 * locked while an export is already running, and it has to hold in the same tenant scope the
 * bodies are read in.
 */
describe.skipIf(!DB_TESTS_ENABLED)('locked bodies in an export', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = collabPool();
    await seedTenants();
  });

  afterAll(async () => {
    await unlockAll();
    await clearContent();
    await pool.end();
  });

  beforeEach(async () => {
    await clearContent();
  });

  afterEach(async () => {
    await unlockAll();
  });

  function itemOf(tenant: TestTenant): CoreItem {
    return {
      id: tenant.itemId,
      parentId: null,
      workspaceId: tenant.workspaceId,
      type: 'spreadsheet',
      title: 'a sheet',
      seq: '1000',
      lifecycleState: 'active',
      createdAt: '2026-09-22T00:00:00Z',
      updatedAt: '2026-09-22T00:00:00Z',
      properties: {},
      hasChildren: false,
    };
  }

  async function lock(tenant: TestTenant, itemId: string = tenant.itemId): Promise<void> {
    const admin = adminPool();
    try {
      await admin.query(
        `INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
         VALUES ($1, $2, $3, $4, now())`,
        [
          itemId,
          tenant.tenantId,
          'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          tenant.principalId,
        ],
      );
    } finally {
      await admin.end();
    }
  }

  async function unlockAll(): Promise<void> {
    const admin = adminPool();
    try {
      await admin.query('DELETE FROM item_lock WHERE tenant_id = ANY($1)', [
        [TENANTS.alpha.tenantId, TENANTS.beta.tenantId],
      ]);
      await admin.query('DELETE FROM item_closure WHERE tenant_id = ANY($1) AND depth > 0', [
        [TENANTS.alpha.tenantId, TENANTS.beta.tenantId],
      ]);
    } finally {
      await admin.end();
    }
  }

  /** Writes a one-cell sheet and returns the body an export of the item would carry. */
  async function exportedBody(tenant: TestTenant): Promise<unknown> {
    const state = new Y.Doc();
    state.getMap('cells').set('A1', { input: 'secret' });
    const update = Y.encodeStateAsUpdate(state);
    state.destroy();

    return await withTenantScope(pool, scopeOf(tenant), async (sql) => {
      const doc = await openDocument(
        sql,
        tenant.tenantId,
        tenant.itemId,
        tenant.workspaceId,
        () => tenant.docId,
      );
      if (doc === null) throw new Error('The document was not created.');

      const applied = await applyUpdate(sql, {
        tenantId: tenant.tenantId,
        doc,
        updateBytes: update,
        actorId: tenant.principalId,
        clientId: 'lock-test',
        snapshotEvery: 1,
        strategy: sheetStrategy,
      });
      if (!applied.ok) throw new Error(`The update was refused: ${applied.error.detail}`);

      for await (const bundle of streamBundles({
        sql,
        tenantId: tenant.tenantId,
        items: [itemOf(tenant)],
        metadata: { schemas: new Map(), views: new Map(), viewRows: new Map() },
      })) {
        return bundle.body;
      }
      throw new Error('No bundle was produced.');
    });
  }

  it('carries the body of an item that is not locked', async () => {
    expect(await exportedBody(TENANTS.alpha)).toHaveProperty('sheet');
  });

  it('carries no body for a locked item, though the item itself is still exported', async () => {
    await lock(TENANTS.alpha);

    expect(await exportedBody(TENANTS.alpha)).toBeNull();
  });

  it('carries no body for an item under a locked ancestor, which has no lock of its own', async () => {
    // The seeded target stands in for a locked folder above the exported item. Only the closure
    // edge matters here: it is what the lock check walks.
    const admin = adminPool();
    try {
      await admin.query(
        `INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
         VALUES ($1, $2, $3, $4, 1)`,
        [
          TENANTS.alpha.itemId,
          TENANTS.alpha.targetItemId,
          TENANTS.alpha.tenantId,
          TENANTS.alpha.workspaceId,
        ],
      );
    } finally {
      await admin.end();
    }
    await lock(TENANTS.alpha, TENANTS.alpha.targetItemId);

    expect(await exportedBody(TENANTS.alpha)).toBeNull();
  });

  it("sees only its own tenant's locks", async () => {
    await lock(TENANTS.beta);

    const alphaView = await withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
      lockedAmong(sql, TENANTS.alpha.tenantId, [TENANTS.alpha.itemId, TENANTS.beta.itemId]),
    );
    const betaView = await withTenantScope(pool, scopeOf(TENANTS.beta), (sql) =>
      lockedAmong(sql, TENANTS.beta.tenantId, [TENANTS.beta.itemId]),
    );

    expect([...alphaView]).toEqual([]);
    expect([...betaView]).toEqual([TENANTS.beta.itemId]);
  });

  it('cannot read the verifier, only which items are locked', async () => {
    await lock(TENANTS.alpha);

    await expect(
      withTenantScope(pool, scopeOf(TENANTS.alpha), (sql) =>
        sql.query('SELECT password_hash FROM item_lock'),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
