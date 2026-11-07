import type { FetchImpl } from '../session.ts';

export const API = 'http://nix.test';
export const WORKSPACE = '22222222-2222-4222-8222-222222222222';
export const ITEM = '11111111-1111-4111-8111-111111111111';
export const OTHER = '33333333-3333-4333-8333-333333333333';
export const VERSION = '44444444-4444-4444-8444-444444444444';
export const UPLOAD = '55555555-5555-4555-8555-555555555555';
export const OPERATION = '66666666-6666-4666-8666-666666666666';
export const EXPORT = '77777777-7777-4777-8777-777777777777';

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ITEM,
    workspaceId: WORKSPACE,
    parentId: null,
    type: 'note',
    title: 'Record',
    hasChildren: false,
    seq: 1000,
    lifecycleState: 'active',
    properties: { url: 'https://example.com/a' },
    createdAt: '2026-08-19T09:00:00.000Z',
    updatedAt: '2026-08-19T09:00:00.000Z',
    ...overrides,
  };
}

export function exportRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EXPORT,
    itemId: ITEM,
    workspaceId: WORKSPACE,
    format: 'pdf',
    scope: 'item',
    fileName: 'note.pdf',
    mediaType: 'application/pdf',
    status: 'completed',
    itemCount: 1,
    omittedCount: 0,
    byteLength: 10,
    sha256: 'a'.repeat(64),
    loss: [],
    omissions: [],
    failureCode: null,
    failureDetail: null,
    cancellationRequested: false,
    downloadReady: false,
    createdAt: '2026-09-01T09:00:00+00:00',
    completedAt: '2026-09-01T09:00:02+00:00',
    expiresAt: null,
    uploadId: UPLOAD,
    ...overrides,
  };
}

/** Answers each route with a plausible body and records the request. */
export function fakeApi(calls: Call[]): FetchImpl {
  return (input, init) => Promise.resolve(answer(calls, input, init));
}

function answer(
  calls: Call[],
  input: Parameters<FetchImpl>[0],
  init: Parameters<FetchImpl>[1],
): Response {
  {
    const url = new URL(input);
    if (url.pathname.endsWith('/public/v1/auth/token'))
      return Response.json({ accessToken: 'jwt', tokenType: 'Bearer', expiresInSeconds: 600 });
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
    });
    const path = url.pathname;
    if (path.endsWith('/lookup'))
      return Response.json({ matches: [{ item: item(), trashed: false }] });
    if (path.endsWith('/records/upsert'))
      return Response.json({ outcome: 'created', item: item() });
    if (path.endsWith('/records/batch'))
      return Response.json({
        rows: [
          { index: 0, status: 'created', item: item() },
          {
            index: 1,
            status: 'error',
            error: { code: 'record.conflict', message: 'duplicate url' },
          },
        ],
        created: 1,
        updated: 0,
        unchanged: 0,
        failed: 1,
      });
    if (path.endsWith('/query'))
      return Response.json({ rows: [], groups: [], truncated: false, limit: 100 });
    if (path.endsWith('/schema'))
      return Response.json({ properties: [], declared: [], inherit: true });
    if (path.endsWith('/references') && method === 'POST')
      return Response.json({ id: OTHER, targetItemId: OTHER });
    if (path.includes('/references/') && method === 'DELETE')
      return new Response(null, { status: 204 });
    if (
      path.endsWith('/references') ||
      path.endsWith('/referenced-by') ||
      path.endsWith('/attachments')
    )
      return Response.json({ items: [], nextCursor: null });
    if (path.endsWith('/backlinks')) return Response.json({ items: [], truncated: false });
    if (path.endsWith('/state')) return Response.json({ id: VERSION, state: 'approved' });
    if (path === '/api/v1/exports') return Response.json(exportRow());
    if (path === '/api/v1/files/uploads' && method === 'POST')
      return Response.json({
        id: UPLOAD,
        status: 'pending',
        uploadUrl: 'https://store.example.com/put?sig=1',
        capabilityExpiresAt: '2026-09-01T09:10:00+00:00',
        expiresAt: '2026-09-01T10:00:00+00:00',
        itemId: null,
        failureCode: null,
      });
    if (path.endsWith('/complete'))
      return Response.json({
        id: OPERATION,
        kind: 'file.publish',
        status: 'completed',
        result: null,
        errorCode: null,
        errorDetail: null,
        attempts: 1,
        cancellationRequested: false,
        createdAt: '2026-09-01T09:00:00+00:00',
        completedAt: '2026-09-01T09:00:01+00:00',
      });
    if (path.startsWith('/api/v1/operations/'))
      return Response.json({
        id: OPERATION,
        kind: 'file.publish',
        status: 'completed',
        result: null,
        errorCode: null,
        errorDetail: null,
        attempts: 1,
        cancellationRequested: false,
        createdAt: '2026-09-01T09:00:00+00:00',
        completedAt: '2026-09-01T09:00:01+00:00',
      });
    if (path === `/api/v1/files/uploads/${UPLOAD}`)
      return Response.json({
        id: UPLOAD,
        status: 'completed',
        expiresAt: '2026-09-01T10:00:00+00:00',
        itemId: ITEM,
        failureCode: null,
        publishedVersionId: VERSION,
      });
    if (path.endsWith('/file/download'))
      return Response.json({
        url: 'https://store.example.com/get?sig=1',
        expiresAt: '2026-09-01T09:05:00+00:00',
        fileName: 'a.pdf',
        mediaType: 'application/pdf',
        byteLength: 10,
        sha256: 'a'.repeat(64),
        inline: false,
        unscanned: true,
        noSniff: true,
      });
    if (path.endsWith('/public-link') && method === 'DELETE')
      return new Response(null, { status: 204 });
    if (path.endsWith('/public-link'))
      return Response.json({
        url: 'https://links.example.com/p/abc',
        itemId: ITEM,
        versionId: VERSION,
        versionState: 'approved',
        createdBy: '00000000-0000-4000-8000-000000000001',
        createdAt: '2026-09-01T09:00:00+00:00',
        withheldFiles: [],
      });
    if (path.endsWith('/properties')) return Response.json(item());
    if (path === '/api/v1/items' || path.endsWith('/items')) return Response.json(item());
    return Response.json({ title: 'unexpected', status: 404 }, { status: 404 });
  }
}
