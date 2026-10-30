import { createHash } from 'node:crypto';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryTokenStore } from '../auth.js';
import { createNixClient, type NixClient } from '../client.js';
import { server, TEST_BASE_URL, testUrl } from '../testing/server.js';
import { beginAndPreviewDocument, commitAndWaitDocumentImport } from './imports.js';

const IMPORT_ID = 'a1111111-1111-4111-8111-111111111111';
const OPERATION_ID = 'a2222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = 'a3333333-3333-4333-8333-333333333333';
const CAPABILITY = 'http://localhost:9444/import-plan';

const plan = JSON.stringify({
  version: 1,
  format: 'txt',
  title: 'Notes',
  sourceSha256: '1'.repeat(64),
  items: [
    {
      sourceId: 'root',
      parentSourceId: null,
      order: 0,
      title: 'Notes',
      itemType: 'note',
      finalLifecycleState: 'active',
      body: { encoding: 'plain_text', text: 'hello' },
    },
  ],
  loss: [],
  omissions: [],
});
const planSha256 = createHash('sha256').update(plan).digest('hex');

function durableOperation() {
  return {
    id: OPERATION_ID,
    kind: 'import.preview.txt',
    status: 'completed',
    result: null,
    errorCode: null,
    errorDetail: null,
    attempts: 1,
    cancellationRequested: false,
    createdAt: '2026-09-01T00:00:00Z',
    completedAt: '2026-09-01T00:00:01Z',
  };
}

function documentImport() {
  return {
    id: IMPORT_ID,
    workspaceId: WORKSPACE_ID,
    uploadId: 'a4444444-4444-4444-8444-444444444444',
    parentId: null,
    format: 'txt',
    title: 'Notes',
    status: 'preview_ready',
    previewOperationId: OPERATION_ID,
    commitOperationId: null,
    itemCount: 1,
    assetCount: 0,
    loss: [],
    omissions: [],
    rootItemId: null,
    failureCode: null,
    expiresAt: '2026-09-01T01:00:00Z',
    completedAt: null,
  };
}

let client: NixClient;

beforeEach(() => {
  client = createNixClient({
    baseUrl: TEST_BASE_URL,
    tokens: createInMemoryTokenStore({
      initialAccessToken: 'token',
      refresh: () => Promise.resolve(null),
    }),
  });
});

describe('the durable document import resource', () => {
  it('refreshes published items and their workspace after the commit worker finishes', async () => {
    const invalidations: string[][] = [];
    client.cache.subscribeInvalidation((prefix) => invalidations.push([...prefix]));
    server.use(
      http.post(testUrl(`/api/v1/imports/${IMPORT_ID}/commit`), () =>
        HttpResponse.json(
          { ...durableOperation(), status: 'queued', completedAt: null },
          { status: 202 },
        ),
      ),
      http.get(testUrl(`/api/v1/operations/${OPERATION_ID}`), () => {
        expect(invalidations).toEqual([['imports', IMPORT_ID]]);
        return HttpResponse.json(durableOperation());
      }),
      http.get(testUrl(`/api/v1/imports/${IMPORT_ID}`), () =>
        HttpResponse.json({ ...documentImport(), status: 'completed', rootItemId: IMPORT_ID }),
      ),
    );

    const published = await commitAndWaitDocumentImport(client, IMPORT_ID);

    expect(published.rootItemId).toBe(IMPORT_ID);
    expect(invalidations).toEqual([
      ['imports', IMPORT_ID],
      ['imports', IMPORT_ID],
      ['items'],
      ['workspaces', WORKSPACE_ID, 'items'],
    ]);
  });

  it('does not announce imported items when durable publication fails', async () => {
    const invalidations: string[][] = [];
    client.cache.subscribeInvalidation((prefix) => invalidations.push([...prefix]));
    server.use(
      http.post(testUrl(`/api/v1/imports/${IMPORT_ID}/commit`), () =>
        HttpResponse.json(durableOperation(), { status: 202 }),
      ),
      http.get(testUrl(`/api/v1/operations/${OPERATION_ID}`), () =>
        HttpResponse.json(durableOperation()),
      ),
      http.get(testUrl(`/api/v1/imports/${IMPORT_ID}`), () =>
        HttpResponse.json({
          ...documentImport(),
          status: 'failed',
          failureCode: 'import.commit_failed',
        }),
      ),
    );

    await expect(commitAndWaitDocumentImport(client, IMPORT_ID)).rejects.toThrow(
      'import.commit_failed',
    );
    expect(invalidations).toEqual([
      ['imports', IMPORT_ID],
      ['imports', IMPORT_ID],
    ]);
  });

  it('uploads through a capability, waits for RabbitMQ work, and verifies the plan', async () => {
    let uploaded = '';
    let uploadType: string | null = null;
    server.use(
      http.post(testUrl('/api/v1/imports'), () =>
        HttpResponse.json({
          id: IMPORT_ID,
          status: 'pending_upload',
          uploadUrl: 'http://localhost:9444/source',
          capabilityExpiresAt: '2026-09-01T00:10:00Z',
          expiresAt: '2026-09-01T01:00:00Z',
        }),
      ),
      http.put('http://localhost:9444/source', async ({ request }) => {
        uploaded = await request.text();
        uploadType = request.headers.get('content-type');
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(testUrl(`/api/v1/imports/${IMPORT_ID}/preview`), () =>
        HttpResponse.json(durableOperation(), { status: 202 }),
      ),
      http.get(testUrl(`/api/v1/operations/${OPERATION_ID}`), () =>
        HttpResponse.json(durableOperation()),
      ),
      http.get(testUrl(`/api/v1/imports/${IMPORT_ID}`), () => HttpResponse.json(documentImport())),
      http.get(testUrl(`/api/v1/imports/${IMPORT_ID}/preview`), () =>
        HttpResponse.json({
          url: CAPABILITY,
          expiresAt: '2026-09-01T00:10:00Z',
          sha256: planSha256,
          byteLength: Buffer.byteLength(plan),
        }),
      ),
      http.get(
        CAPABILITY,
        () => new HttpResponse(plan, { headers: { 'content-type': 'application/json' } }),
      ),
    );

    const result = await beginAndPreviewDocument(
      client,
      {
        workspaceId: WORKSPACE_ID,
        parentId: null,
        format: 'txt',
        title: 'Notes',
        fileName: 'notes.txt',
        mediaType: 'text/plain',
        byteLength: 5,
        idempotencyKey: 'test-import',
      },
      new Blob(['hello'], { type: 'text/plain' }),
    );

    expect(uploaded).toBe('hello');
    expect(uploadType).toBe('application/octet-stream');
    expect(result.operation.status).toBe('preview_ready');
    expect(result.plan.items).toHaveLength(1);
  });

  it('cancels durable state when a capability returns a changed plan', async () => {
    let cancelled = 0;
    server.use(
      http.post(testUrl('/api/v1/imports'), () =>
        HttpResponse.json({
          id: IMPORT_ID,
          status: 'pending_upload',
          uploadUrl: 'http://localhost:9444/source',
          capabilityExpiresAt: '2026-09-01T00:10:00Z',
          expiresAt: '2026-09-01T01:00:00Z',
        }),
      ),
      http.put('http://localhost:9444/source', () => new HttpResponse(null, { status: 200 })),
      http.post(testUrl(`/api/v1/imports/${IMPORT_ID}/preview`), () =>
        HttpResponse.json(durableOperation(), { status: 202 }),
      ),
      http.get(testUrl(`/api/v1/operations/${OPERATION_ID}`), () =>
        HttpResponse.json(durableOperation()),
      ),
      http.get(testUrl(`/api/v1/imports/${IMPORT_ID}`), () => HttpResponse.json(documentImport())),
      http.get(testUrl(`/api/v1/imports/${IMPORT_ID}/preview`), () =>
        HttpResponse.json({
          url: CAPABILITY,
          expiresAt: '2026-09-01T00:10:00Z',
          sha256: '0'.repeat(64),
          byteLength: Buffer.byteLength(plan),
        }),
      ),
      http.get(CAPABILITY, () => new HttpResponse(plan)),
      http.delete(testUrl(`/api/v1/imports/${IMPORT_ID}`), () => {
        cancelled += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await expect(
      beginAndPreviewDocument(
        client,
        {
          workspaceId: WORKSPACE_ID,
          parentId: null,
          format: 'txt',
          title: 'Notes',
          fileName: 'notes.txt',
          mediaType: 'text/plain',
          byteLength: 5,
          idempotencyKey: 'test-import',
        },
        new Blob(['hello'], { type: 'text/plain' }),
      ),
    ).rejects.toThrow('checksum');
    expect(cancelled).toBe(1);
  });
});
