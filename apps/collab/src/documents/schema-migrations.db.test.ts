import {
  FIXTURE_DOCUMENT,
  SCHEMA_VERSION,
  VERSION_1_DOCUMENT,
  nixSchema,
} from '@nix/editor-schema';
import type { Pool } from 'pg';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { findDocByItem } from '../db/documents.ts';
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
import { migrateAllDocuments } from '../migrate-documents.ts';
import { CLOSE_CODES } from '../ws/protocol.ts';
import { createDocumentRegistry, type DocumentHub } from './registry.ts';
import { FRAGMENT_NAME, applyUpdate, openDocument } from './service.ts';

/**
 * Raising a document's schema pin, against real Postgres.
 *
 * **The next version is simulated by migrating to `SCHEMA_VERSION + 1`.** At version 1 there
 * is no valid pin below the current one - a document pinned at 0 could not legitimately hold
 * a version-1 document, and the pin check correctly refuses to write one into it - so the
 * migrator is exercised in the only direction that exists yet: forward, to a version this
 * build does not itself speak. That is exactly the shape of a real bump, where the job runs
 * with a build newer than the corpus.
 *
 * The complementary claim - that a document pinned *below* the running build stays writable,
 * which is what the original exact-inequality check would have broken - is covered by
 * `schema-migrations.test.ts`, where a stub strategy can report a version the real schema
 * cannot yet produce. It becomes expressible here the moment the node set gains its first
 * version-2 entry.
 *
 * Requires the development stack, like every other `.db.test.ts` here.
 */
describe.skipIf(!DB_TESTS_ENABLED)('raising a document schema pin, against Postgres', () => {
  /** The version the migrator is asked to reach: one past what this build speaks. */
  const NEXT_VERSION = SCHEMA_VERSION + 1;

  let pool: Pool;

  beforeAll(async () => {
    pool = collabPool();
    await seedTenants();
  });

  afterAll(async () => {
    await clearContent();
    await pool.end();
  });

  beforeEach(async () => {
    await clearContent();
  });

  async function open(tenant: TestTenant): Promise<void> {
    await withTenantScope(pool, scopeOf(tenant), async (sql) => {
      const doc = await openDocument(
        sql,
        tenant.tenantId,
        tenant.itemId,
        tenant.workspaceId,
        () => tenant.docId,
      );
      if (doc === null) throw new Error('The document was not created.');
    });
  }

  /** Forces a document's stored pin, as the only role permitted to move it. */
  async function setPin(tenant: TestTenant, pin: number): Promise<void> {
    const admin = adminPool();
    try {
      await admin.query(
        'UPDATE content_doc SET schema_version = $3 WHERE tenant_id = $1 AND doc_id = $2',
        [tenant.tenantId, tenant.docId, pin],
      );
    } finally {
      await admin.end();
    }
  }

  async function pinOf(tenant: TestTenant): Promise<number> {
    return await withTenantScope(pool, scopeOf(tenant), async (sql) => {
      const doc = await findDocByItem(sql, tenant.tenantId, tenant.itemId);
      if (doc === null) throw new Error('The document is gone.');
      return doc.schema_version;
    });
  }

  /** An update that puts a document into the fragment. */
  function documentUpdate(json: unknown): Uint8Array {
    const state = new Y.Doc();
    prosemirrorJSONToYXmlFragment(nixSchema, json, state.getXmlFragment(FRAGMENT_NAME));
    const update = Y.encodeStateAsUpdate(state);
    state.destroy();
    return update;
  }

  /** The shipped fixture, which uses everything version 2 added. */
  function fixtureUpdate(): Uint8Array {
    return documentUpdate(FIXTURE_DOCUMENT);
  }

  function fileImageUpdate(): Uint8Array {
    return documentUpdate({
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: '', fileItemId: '11111111-1111-4111-8111-111111111111' } },
      ],
    });
  }

  /** A document as version 1 could produce it, using nothing newer. */
  function versionOneUpdate(): Uint8Array {
    return documentUpdate(VERSION_1_DOCUMENT);
  }

  /**
   * An update that puts an element the schema has never heard of into the fragment.
   *
   * This is what an unopenable document looks like from the storage side: bytes that merge
   * cleanly as Yjs and produce something `yXmlFragmentToProseMirrorRootNode` throws on. It
   * cannot be written through the service - refusing exactly this is what validation is for -
   * so it goes straight into the log, which is also how one would arrive in reality: an older
   * build, a bad merge, or a bug since fixed.
   */
  function unopenableUpdate(): Uint8Array {
    const state = new Y.Doc();
    state
      .getXmlFragment(FRAGMENT_NAME)
      .insert(0, [new Y.XmlElement('nodeThisBuildHasNeverHeardOf')]);
    const update = Y.encodeStateAsUpdate(state);
    state.destroy();
    return update;
  }

  async function write(tenant: TestTenant, update: Uint8Array) {
    return await withTenantScope(pool, scopeOf(tenant), async (sql) => {
      const doc = await findDocByItem(sql, tenant.tenantId, tenant.itemId);
      if (doc === null) throw new Error('The document is gone.');

      return await applyUpdate(sql, {
        tenantId: tenant.tenantId,
        doc,
        updateBytes: update,
        actorId: tenant.principalId,
        clientId: 'test-client',
        snapshotEvery: 0,
      });
    });
  }

  /** The minimum a socket has to be for the registry to judge a join. */
  function socketFor(tenant: TestTenant, clientSchemaVersion: number) {
    return {
      itemId: tenant.itemId,
      clientSchemaVersion,
      authorization: {
        tenantId: tenant.tenantId,
        principalId: tenant.principalId,
        workspaceId: tenant.workspaceId,
        bodyKind: 'note',
      },
    } as unknown as Parameters<DocumentHub['join']>[0];
  }

  /** Writes bytes straight into the log, bypassing validation, and advances the head. */
  async function forceIntoLog(tenant: TestTenant, update: Uint8Array): Promise<void> {
    const admin = adminPool();
    try {
      await admin.query(
        'UPDATE content_doc SET head_seq = head_seq + 1 WHERE tenant_id = $1 AND doc_id = $2',
        [tenant.tenantId, tenant.docId],
      );
      await admin.query(
        `INSERT INTO content_update
             (doc_id, seq, tenant_id, update_bytes, actor_id, client_id, created_at)
         SELECT $1, head_seq, $2, $3, $4, 'forced', now()
         FROM content_doc WHERE tenant_id = $2 AND doc_id = $1`,
        [tenant.docId, tenant.tenantId, Buffer.from(update), tenant.principalId],
      );
    } finally {
      await admin.end();
    }
  }

  /**
   * Runs the migrator over one tenant only.
   *
   * Scoped deliberately. The job's whole point is that it reads across tenants, and running
   * it unfiltered against a shared development database would raise the pin on every document
   * a developer had - putting them all above the running build, which then refuses to write
   * them. A test must not leave the machine it ran on in a worse state than it found it.
   */
  async function migrate(tenant: TestTenant, target: number) {
    const admin = adminPool();
    try {
      return await migrateAllDocuments(admin, { target, onlyTenantIds: [tenant.tenantId] });
    } finally {
      await admin.end();
    }
  }

  it('raises the pin on a document that opens, and reports it', async () => {
    await open(TENANTS.alpha);
    await write(TENANTS.alpha, fixtureUpdate());

    const report = await migrate(TENANTS.alpha, NEXT_VERSION);

    // Asserted on this tenant's document, never on the run's totals. The job reads the whole
    // corpus by design, so a shared development database contributes rows this suite did not
    // create, and a count assertion would be testing the database's contents rather than the
    // code's behaviour.
    expect(report.unparseable).not.toContain(TENANTS.alpha.docId);
    expect(await pinOf(TENANTS.alpha)).toBe(NEXT_VERSION);
  });

  it('leaves a document that does not open at its old pin, and names it', async () => {
    await open(TENANTS.alpha);
    await forceIntoLog(TENANTS.alpha, unopenableUpdate());

    const report = await migrate(TENANTS.alpha, NEXT_VERSION);

    expect(report.unparseable).toContain(TENANTS.alpha.docId);
    // Still readable by whatever build could open it before. Force-bumping would have moved
    // it from openable-by-an-old-build to broken everywhere, which is not recoverable.
    expect(await pinOf(TENANTS.alpha)).toBe(SCHEMA_VERSION);
  });

  it('migrates across tenants in one run, which no tenant scope could do', async () => {
    await open(TENANTS.alpha);
    await open(TENANTS.beta);
    await write(TENANTS.alpha, fixtureUpdate());
    await write(TENANTS.beta, fixtureUpdate());

    // Two tenants in the filter rather than none. Reading past a tenant boundary is the claim,
    // and two boundaries prove it exactly as well as all of them - while an unfiltered run
    // against a shared development database would raise every document a developer owns above
    // the build they are running, and restoring them afterwards from memory only works if the
    // process lives long enough to do it.
    const admin = adminPool();
    try {
      const report = await migrateAllDocuments(admin, {
        target: NEXT_VERSION,
        onlyTenantIds: [TENANTS.alpha.tenantId, TENANTS.beta.tenantId],
      });

      expect(report.migrated).toBe(2);
      expect(report.unparseable).toHaveLength(0);
    } finally {
      await admin.end();
    }

    expect(await pinOf(TENANTS.alpha)).toBe(NEXT_VERSION);
    expect(await pinOf(TENANTS.beta)).toBe(NEXT_VERSION);
  });

  it('migrates a document nobody has typed into yet', async () => {
    // The common case in any real corpus, and the one that would have failed: a row is created
    // the moment somebody opens an item, its Yjs fragment is empty until the first keystroke,
    // and an empty fragment does not parse - `doc` requires `block+`. Checking before noticing
    // there is nothing to check would have reported every untouched document as broken.
    await open(TENANTS.alpha);

    const report = await migrate(TENANTS.alpha, NEXT_VERSION);

    expect(report.unparseable).not.toContain(TENANTS.alpha.docId);
    expect(await pinOf(TENANTS.alpha)).toBe(NEXT_VERSION);
  });

  it('is idempotent: a second run reports every document already current', async () => {
    await open(TENANTS.alpha);
    await write(TENANTS.alpha, fixtureUpdate());
    await migrate(TENANTS.alpha, NEXT_VERSION);

    const second = await migrate(TENANTS.alpha, NEXT_VERSION);

    // This document is not looked at again at all: the page query selects on
    // `schema_version < target`, so a migrated document leaves the working set entirely.
    expect(second.unparseable).not.toContain(TENANTS.alpha.docId);
    expect(await pinOf(TENANTS.alpha)).toBe(NEXT_VERSION);
  });

  it('refuses a write to a document pinned above this build', async () => {
    // What a stale replica meets after a deploy has migrated the corpus past it: the document
    // is fine, this build is behind, and reinterpreting it would be worse than refusing.
    await open(TENANTS.alpha);
    await setPin(TENANTS.alpha, NEXT_VERSION);

    const result = await write(TENANTS.alpha, fixtureUpdate());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('schema_version_mismatch');
    expect(result.error.status).toBe(409);
  });

  it('accepts a write to a document pinned exactly at this build', async () => {
    await open(TENANTS.alpha);

    expect((await write(TENANTS.alpha, fixtureUpdate())).ok).toBe(true);
  });

  it('refuses a socket joining a document pinned above this build', async () => {
    // The socket counterpart to the HTTP refusal above. Until this goal the two disagreed: the
    // same stale replica accepted the write over WebSocket and refused it over HTTP.
    await open(TENANTS.alpha);
    await setPin(TENANTS.alpha, NEXT_VERSION);

    const hub = createDocumentRegistry({
      pool,
      locks: {
        acquire: () => Promise.resolve(true),
        release: () => Promise.resolve(),
        close: () => Promise.resolve(),
      },
      config: {
        flushMs: 50,
        flushBytes: 4096,
        snapshotEvery: 0,
        snapshotIntervalMs: 60_000,
        idleEvictMs: 60_000,
        maxDocs: 8,
        maxResidentBytes: 64 * 1024 * 1024,
        sweepMs: 60_000,
      },
    });

    try {
      const result = await hub.join(socketFor(TENANTS.alpha, NEXT_VERSION));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.closeCode).toBe(CLOSE_CODES.schemaMismatch);
      expect(result.reason).toContain('this server speaks');
    } finally {
      await hub.shutdown();
    }
  });

  it('accepts a write to a document pinned below this build', async () => {
    // The regression this whole mechanism was built around, and expressible for the first time
    // now that a version below the current one exists. Under the original exact-inequality
    // check this refused with `schema_version_mismatch`, which would have made the version-2
    // deploy an outage: every stored document read-only until the pin migration finished.
    await open(TENANTS.alpha);
    await setPin(TENANTS.alpha, SCHEMA_VERSION - 1);

    const result = await write(TENANTS.alpha, versionOneUpdate());

    expect(result.ok).toBe(true);
  });

  it('refuses a write that would need a version above the document pin', async () => {
    // The other half: a document pinned at 1 is writable, but not with version-2 nodes in it.
    // Every client speaking version 1 has been told this document opens for them, and it has
    // to keep being true until the migration says otherwise.
    await open(TENANTS.alpha);
    await setPin(TENANTS.alpha, 2);

    const result = await write(TENANTS.alpha, fileImageUpdate());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('document_above_schema_pin');
    expect(result.error.status).toBe(409);
    expect(result.error.detail).toContain('Run the document schema migration');
  });

  it('accepts that same write once the migration has raised the pin', async () => {
    // The deploy, end to end: ship the build, documents sit at the old pin and hold to the old
    // node set, the job runs, and the new nodes become writable.
    await open(TENANTS.alpha);
    await setPin(TENANTS.alpha, 2);
    expect((await write(TENANTS.alpha, fileImageUpdate())).ok).toBe(false);

    await migrate(TENANTS.alpha, SCHEMA_VERSION);

    expect(await pinOf(TENANTS.alpha)).toBe(SCHEMA_VERSION);
    expect((await write(TENANTS.alpha, fileImageUpdate())).ok).toBe(true);
  });

  it('refuses to run as a role that row-level security applies to', async () => {
    // The collaboration role sees nothing outside a scope, so a run under it would report a
    // clean sweep over an untouched database - the worst possible way for this to fail.
    await expect(migrateAllDocuments(pool)).rejects.toThrow(/row-level security/);
  });
});
