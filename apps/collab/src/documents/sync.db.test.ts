import { nixSchema } from '@nix/editor-schema';
import type { Pool } from 'pg';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { findDocByItem, updatesAfter } from '../db/documents.ts';
import {
  DB_TESTS_ENABLED,
  TENANTS,
  adminPool,
  clearContent,
  collabPool,
  seedTenants,
} from '../db/testing.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import { FRAGMENT_NAME, openDocument } from './service.ts';
import { syncDocument } from './sync.ts';

describe.skipIf(!DB_TESTS_ENABLED)('native body synchronization against Postgres', () => {
  let pool: Pool;
  const tenant = TENANTS.alpha;
  const scope = { tenantId: tenant.tenantId, principalId: tenant.principalId };

  beforeAll(async () => {
    pool = collabPool();
    await seedTenants();
  });
  beforeEach(async () => {
    await clearContent();
  });
  afterAll(async () => {
    await clearContent();
    await pool.end();
  });

  function input(update?: Uint8Array) {
    return {
      document: {
        itemId: tenant.itemId,
        ...(update === undefined ? {} : { expectedDocId: tenant.docId }),
        stateVector: new Uint8Array([0]),
        updates: update === undefined ? [] : [{ clientId: 'native-pending', update }],
      },
      ...scope,
      workspaceId: tenant.workspaceId,
      canWrite: true,
      bodyKind: 'note',
      newDocId: () => tenant.docId,
      responseBytesAvailable: 1024 * 1024,
    };
  }

  it('commits a pending update and reconstructs it under the runtime tenant role', async () => {
    await withTenantScope(pool, scope, (sql) =>
      openDocument(sql, tenant.tenantId, tenant.itemId, tenant.workspaceId, () => tenant.docId),
    );
    const local = new Y.Doc();
    prosemirrorJSONToYXmlFragment(
      nixSchema,
      {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Saved on a phone' }] }],
      },
      local.getXmlFragment(FRAGMENT_NAME),
    );
    const update = Y.encodeStateAsUpdate(local);
    local.destroy();
    const result = await withTenantScope(pool, scope, (sql) => syncDocument(sql, input(update)));
    expect(result.acknowledgedClientIds).toEqual(['native-pending']);
    expect(result.headSeq).toBe('1');
    const saved = await withTenantScope(pool, scope, (sql) =>
      updatesAfter(sql, tenant.tenantId, tenant.docId, 0n, 10),
    );
    expect(saved.map((row) => row.update_bytes)).toEqual([Buffer.from(update)]);
    const client = new Y.Doc();
    try {
      Y.applyUpdate(client, Buffer.from(result.update, 'base64'));
      expect(client.getXmlFragment(FRAGMENT_NAME).toJSON()).toContain('Saved on a phone');
    } finally {
      client.destroy();
    }
  });

  it('holds Core lock and move writers out until the body sync transaction commits', async () => {
    const admin = adminPool();
    try {
      await withTenantScope(pool, scope, async (sql) => {
        await syncDocument(sql, input());
        const result = await admin.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
          [`finance-workspace:${tenant.workspaceId}`],
        );
        expect(result.rows[0]?.acquired).toBe(false);
      });
      const result = await admin.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
        [`finance-workspace:${tenant.workspaceId}`],
      );
      expect(result.rows[0]?.acquired).toBe(true);
      await admin.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
        `finance-workspace:${tenant.workspaceId}`,
      ]);
    } finally {
      await admin.end();
    }
  });

  it('does not create a foreign tenant body from a mismatched authorized workspace', async () => {
    await expect(
      withTenantScope(pool, scope, (sql) =>
        syncDocument(sql, {
          ...input(),
          document: { ...input().document, itemId: TENANTS.beta.itemId },
        }),
      ),
    ).rejects.toBeDefined();
    expect(
      await withTenantScope(pool, scope, (sql) =>
        findDocByItem(sql, tenant.tenantId, TENANTS.beta.itemId),
      ),
    ).toBeNull();
  });
});
