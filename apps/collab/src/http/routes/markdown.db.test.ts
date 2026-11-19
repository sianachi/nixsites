import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { clearContent, DB_TESTS_ENABLED, seedTenants, TENANTS } from '../../db/testing.ts';
import {
  adminPool,
  connectTestClient,
  countUpdates,
  startLiveServer,
  textOf,
  typeParagraph,
  until,
  type LiveHarness,
  type TestClient,
} from '../../documents/testing-live.ts';

/**
 * Markdown writes against Postgres and a live editor.
 *
 * The unit tests cover the diff. What they cannot see is that the update is the one the log
 * stores, that search hears about it, and that a person who already has the note open receives it.
 */

describe.runIf(DB_TESTS_ENABLED)('note body Markdown, against Postgres', () => {
  const harnesses: LiveHarness[] = [];
  const clients: TestClient[] = [];
  let verify: Pool;

  beforeAll(async () => {
    await seedTenants();
    verify = adminPool();
  });

  afterAll(async () => {
    await verify.end();
  });

  beforeEach(async () => {
    await clearContent();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  function open(url: string, itemId: string): TestClient {
    const client = connectTestClient(url, itemId, 'anyone');
    clients.push(client);
    return client;
  }

  it('replaces and appends Markdown, and an open editor sees both', async () => {
    const harness = await startLiveServer(TENANTS.alpha);
    harnesses.push(harness);
    const base = harness.url.replace('ws://', 'http://');
    const editor = open(harness.url, TENANTS.alpha.itemId);
    await editor.ready;
    typeParagraph(editor.doc, 'Kept in the editor.');
    await until(async () => (await countUpdates(verify, TENANTS.alpha)) >= 1, 'the editor flush');

    const appended = await fetch(`${base}/documents/${TENANTS.alpha.itemId}/markdown`, {
      method: 'POST',
      headers: { authorization: 'Bearer anyone', 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: 'Added by the API.' }),
    });
    expect(appended.status).toBe(200);
    const appendBody = (await appended.json()) as { seq: string; updateBytes: number };
    expect(appendBody.seq).toMatch(/^\d+$/);
    expect(appendBody.updateBytes).toBeGreaterThan(0);

    await until(
      () =>
        textOf(editor.doc).includes('Kept in the editor.') &&
        textOf(editor.doc).includes('Added by the API.'),
      'the open editor to receive the append',
    );

    const replaced = await fetch(`${base}/documents/${TENANTS.alpha.itemId}/markdown`, {
      method: 'PUT',
      headers: { authorization: 'Bearer anyone', 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: '# Replaced\n\nOnly this remains.' }),
    });
    expect(replaced.status).toBe(200);

    await until(
      () =>
        textOf(editor.doc).includes('Only this remains.') &&
        !textOf(editor.doc).includes('Kept in the editor.'),
      'the open editor to receive the replacement',
    );

    const read = await fetch(`${base}/documents/${TENANTS.alpha.itemId}/markdown`, {
      headers: { authorization: 'Bearer anyone' },
    });
    expect(read.status).toBe(200);
    const body = (await read.json()) as { markdown: string; empty: boolean };
    expect(body.empty).toBe(false);
    expect(body.markdown).toContain('Replaced');
    expect(body.markdown).toContain('Only this remains.');
    expect(body.markdown).not.toContain('Kept in the editor.');

    const { rows } = await verify.query<{ matches: boolean }>(
      `SELECT body_vector @@ plainto_tsquery('english', 'remains') AS matches
         FROM item_search
         WHERE tenant_id = $1 AND item_id = $2`,
      [TENANTS.alpha.tenantId, TENANTS.alpha.itemId],
    );
    expect(rows[0]?.matches).toBe(true);
  });

  it('rejects a reviewed note change after a collaborator edits the body', async () => {
    const harness = await startLiveServer(TENANTS.alpha);
    harnesses.push(harness);
    const url = `${harness.url.replace('ws://', 'http://')}/documents/${TENANTS.alpha.itemId}/markdown`;
    const headers = { authorization: 'Bearer anyone', 'content-type': 'application/json' };
    const preview = await fetch(`${url}?revision=true`, { headers });
    expect(preview.status).toBe(200);
    const { revision } = (await preview.json()) as {
      revision: { documentId: string; headSeq: string };
    };
    const reviewedChange = {
      markdown: 'Text from the pet.',
      expectedDocumentId: revision.documentId,
      expectedHeadSeq: revision.headSeq,
    };

    const editor = open(harness.url, TENANTS.alpha.itemId);
    await editor.ready;
    typeParagraph(editor.doc, 'A collaborator just changed the note.');
    await until(async () => (await countUpdates(verify, TENANTS.alpha)) >= 1, 'the editor flush');

    const stale = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(reviewedChange),
    });
    expect(stale.status).toBe(409);
    const current = await fetch(url, { headers });
    expect(current.status).toBe(200);
    const { markdown } = (await current.json()) as { markdown: string };
    expect(markdown.trim()).toBe('A collaborator just changed the note.');
  });
});
