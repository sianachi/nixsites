import { Pool } from 'pg';

/**
 * The database the integration suite runs against.
 *
 * Set `NIX_COLLAB_TEST_DATABASE_URL` to point elsewhere. The default is the development
 * stack from `deploy/compose.dev.yml`, connected as the collaboration role - the same role
 * the service uses, deliberately, because a test that connected as the migrator would prove
 * nothing about isolation: that role can bypass it.
 */
export const TEST_DATABASE_URL =
  process.env.NIX_COLLAB_TEST_DATABASE_URL ??
  'postgresql://nix_collab:nix-dev-collab@localhost:5433/nix';

/**
 * The same database, connected as a role that is not subject to the isolation policies.
 *
 * For setup, teardown, and the one test subject that legitimately reads across tenants - the
 * document schema migrator, which cannot enumerate the corpus from inside a tenant scope.
 * Never for an assertion about isolation: a role that bypasses the policies would pass one
 * whatever the policies said.
 */
export const TEST_ADMIN_DATABASE_URL =
  process.env.NIX_COLLAB_TEST_ADMIN_DATABASE_URL ??
  'postgresql://postgres:nix-dev-superuser@localhost:5433/nix';

export function adminPool(): Pool {
  return new Pool({ connectionString: TEST_ADMIN_DATABASE_URL, max: 2 });
}

/**
 * Whether the integration suite should run.
 *
 * Set `NIX_COLLAB_SKIP_DB_TESTS=1` to skip it - which is for a laptop with no stack up, not
 * for CI. CI brings Postgres up, applies the migrations and leaves this unset, because a
 * suite that quietly skips its only isolation proof is worse than no suite.
 */
export const DB_TESTS_ENABLED = process.env.NIX_COLLAB_SKIP_DB_TESTS !== '1';

/**
 * Two tenants, always.
 *
 * A single-tenant isolation test proves nothing: a mechanism that returns every row in the
 * table passes it. Every test here seeds both and asserts from both sides.
 */
export const TENANTS: { readonly alpha: TestTenant; readonly beta: TestTenant } = {
  alpha: {
    tenantId: 'c1000000-0000-4000-8000-000000000001',
    workspaceId: 'c1000000-0000-4000-8000-000000000011',
    principalId: 'c1000000-0000-4000-8000-000000000021',
    itemId: 'c1000000-0000-4000-8000-000000000031',
    targetItemId: 'c1000000-0000-4000-8000-000000000051',
    docId: 'c1000000-0000-4000-8000-000000000041',
    slug: 'collab-alpha',
  },
  beta: {
    tenantId: 'c2000000-0000-4000-8000-000000000002',
    workspaceId: 'c2000000-0000-4000-8000-000000000012',
    principalId: 'c2000000-0000-4000-8000-000000000022',
    itemId: 'c2000000-0000-4000-8000-000000000032',
    targetItemId: 'c2000000-0000-4000-8000-000000000052',
    docId: 'c2000000-0000-4000-8000-000000000042',
    slug: 'collab-beta',
  },
};

/**
 * One tenant's identifiers.
 *
 * Declared as an interface rather than inferred from `TENANTS.alpha`, so a helper that takes a
 * tenant accepts either of them - inference would pin the parameter to alpha's literal types
 * and make every assertion from beta's side a type error.
 */
export interface TestTenant {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly itemId: string;

  /** A second item in the same workspace, for a document to point at. */
  readonly targetItemId: string;

  readonly docId: string;
  readonly slug: string;
}

export function collabPool(): Pool {
  return new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
}

/**
 * Seeds both tenants' rows, as an owner that can see both.
 *
 * Seeding through the service's own role would need two scopes and would make the setup
 * depend on the mechanism under test, so it runs as the superuser the compose stack exposes.
 * The service's role is used for every assertion.
 */
export async function seedTenants(): Promise<void> {
  const admin = adminPool();

  try {
    for (const tenant of [TENANTS.alpha, TENANTS.beta]) {
      await admin.query(
        `INSERT INTO tenant (tenant_id, name, isolation_mode, created_at)
         VALUES ($1, $2, 'shared', now())
         ON CONFLICT (tenant_id) DO NOTHING`,
        [tenant.tenantId, tenant.slug],
      );

      await admin.query(
        `INSERT INTO workspace
             (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
              storage_quota_bytes, created_at)
         VALUES ($1, $2, $3, 30, 10, 1073741824, now())
         ON CONFLICT (workspace_id) DO NOTHING`,
        [tenant.workspaceId, tenant.tenantId, `${tenant.slug} workspace`],
      );

      await admin.query(
        `INSERT INTO principal
             (principal_id, tenant_id, external_subject, kind, display_name, email, status,
              deprovisioned_at)
         VALUES ($1, $2, $3, 'user', $4, NULL, 'active', NULL)
         ON CONFLICT (principal_id) DO NOTHING`,
        [tenant.principalId, tenant.tenantId, `${tenant.slug}-subject`, `${tenant.slug} user`],
      );

      // Two items: the one documents are opened on, and one for a document to point at.
      for (const [itemId, title] of [
        [tenant.itemId, `${tenant.slug} note`],
        [tenant.targetItemId, `${tenant.slug} target`],
      ] as const) {
        await admin.query(
          `INSERT INTO item
               (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                purge_after, created_by, last_modified_by, created_at, last_modified_at)
           VALUES ($1, $2, $3, 'note', NULL, 1000, $5::jsonb, 'active', NULL, $4, $4, now(), now())
           ON CONFLICT (id) DO NOTHING`,
          [
            itemId,
            tenant.tenantId,
            tenant.workspaceId,
            tenant.principalId,
            JSON.stringify({ title }),
          ],
        );

        await admin.query(
          `INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
           VALUES ($1, $1, $2, $3, 0)
           ON CONFLICT DO NOTHING`,
          [itemId, tenant.tenantId, tenant.workspaceId],
        );
      }
    }
  } finally {
    await admin.end();
  }
}

/** Removes everything the suite created, so a rerun starts from the same place. */
export async function clearContent(): Promise<void> {
  const admin = adminPool();

  try {
    const tenants = [TENANTS.alpha.tenantId, TENANTS.beta.tenantId];

    // Cascades to updates and snapshots through their composite foreign keys.
    await admin.query('DELETE FROM content_doc WHERE tenant_id = ANY($1)', [tenants]);

    // Not reached by that cascade: these hang off `item`, which the suite does not delete,
    // because the items are seeded once and shared by every test.
    await admin.query('DELETE FROM item_link WHERE tenant_id = ANY($1)', [tenants]);
    await admin.query('DELETE FROM item_search WHERE tenant_id = ANY($1)', [tenants]);
    await admin.query('DELETE FROM item_chunk WHERE tenant_id = ANY($1)', [tenants]);
  } finally {
    await admin.end();
  }
}

/** The tenant scope a test opens for one of the seeded tenants. */
export function scopeOf(tenant: TestTenant): { tenantId: string; principalId: string } {
  return { tenantId: tenant.tenantId, principalId: tenant.principalId };
}
