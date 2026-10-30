import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { outputOptions } from '../output.ts';
import { runImport } from './import.ts';
import { captureJson, makeProfile } from './cli.test-helper.ts';

const API = 'http://nix.test';
const COLLAB = 'http://nix.test:8100';
const WS = '22222222-2222-4222-8222-222222222222';

let nextId = 0;

/** A full ItemResponse, so the client's item schema parses each create. */
function itemFrom(body: {
  type?: string;
  title?: string;
  parentId?: string | null;
}): Record<string, unknown> {
  nextId += 1;
  const id = `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`;
  return {
    id,
    workspaceId: WS,
    parentId: body.parentId ?? null,
    type: body.type ?? 'note',
    title: body.title ?? 'x',
    hasChildren: false,
    seq: '1',
    lifecycleState: 'active',
    properties: {},
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

const server = setupServer(
  http.post(`${API}/public/v1/auth/token`, () =>
    HttpResponse.json({ accessToken: 'jwt-1', tokenType: 'Bearer', expiresInSeconds: 600 }),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
  nextId = 0;
  // The command reports partial imports through the exit code; a test must not leak that into the
  // runner's own exit.
  process.exitCode = 0;
});
afterAll(() => {
  server.close();
});

const withProfile = () => makeProfile({ apiUrl: API, token: 'nixpat_abc', collabUrl: COLLAB });

/** A source tree: two notes (one with front matter), a non-Markdown file, and a nested folder. */
async function withSourceTree(): Promise<{ dir: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'nixctl-import-src-'));
  await writeFile(
    join(dir, 'a-first.md'),
    '---\ntitle: First Note\nstatus: done\ncount: 5\n- a list item\n---\n' +
      'Hello **world**, a [[Wiki Link]], an ![[Embedded note]], a local image ![pic](./img.png) and an inline remote one ![web](https://example.test/a.png).\n',
    'utf8',
  );
  await writeFile(join(dir, 'notes.txt'), 'not markdown', 'utf8');
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'sub', 'nested.md'), 'Nested body.\n', 'utf8');
  return { dir, done: () => rm(dir, { recursive: true, force: true }) };
}

/** The handlers a fully-green import needs; individual tests override the parts they break. */
function greenHandlers(record: {
  parents?: (string | null)[];
  propertyPatches?: Record<string, unknown>[];
  bodyWrites?: { count: number };
}): Parameters<typeof server.use> {
  return [
    http.post(`${API}/api/v1/workspaces/:workspaceId/items`, async ({ request }) => {
      const body = (await request.json()) as {
        type?: string;
        title?: string;
        parentId?: string | null;
      };
      record.parents?.push(body.parentId ?? null);
      return HttpResponse.json(itemFrom(body));
    }),
    http.post(`${COLLAB}/documents/:itemId/updates`, () => {
      if (record.bodyWrites !== undefined) {
        record.bodyWrites.count += 1;
      }
      return HttpResponse.json({ seq: 's1' });
    }),
    http.patch(`${API}/api/v1/items/:itemId/properties`, async ({ request }) => {
      const body = (await request.json()) as { properties: Record<string, unknown> };
      record.propertyPatches?.push(body.properties);
      return HttpResponse.json(itemFrom({}));
    }),
  ];
}

// `splitFrontMatter` and `parseScalar` live in `@nix/markdown` (shared with the web import) and
// are tested there; these tests cover what the CLI does with their output.

describe('nixctl import --dry-run', () => {
  it('previews the mapping - titles, properties, declared losses, skips - without touching the network', async () => {
    const { env, done } = await withProfile();
    const { dir, done: dropTree } = await withSourceTree();

    // No handlers beyond the token exchange are registered, and unhandled requests error: a dry
    // run that reached the network would fail this test by construction. It does not even need
    // the token.
    const printed = (await captureJson((json) =>
      runImport(
        'default',
        { path: dir, workspaceId: WS, parentId: undefined, dryRun: true },
        json,
        { env },
      ),
    )) as {
      dryRun: boolean;
      planned: {
        path: string;
        kind: string;
        title: string;
        properties: string[];
        sourceBytes: number;
        unresolvedWikiLinks: number;
        unresolvedObsidianEmbeds: number;
        unresolvedLocalImages: number;
        unsupportedImageAddresses: number;
        inlineImagesFlattened: number;
      }[];
      skipped: { path: string; reason: string }[];
      failed: unknown[];
    };

    expect(printed.dryRun).toBe(true);
    expect(printed.planned.map((entry) => entry.title)).toEqual([
      basename(dir),
      'First Note',
      'sub',
      'nested',
    ]);
    const first = printed.planned[1];
    expect(first?.properties).toEqual(['status', 'count']);
    expect(first?.sourceBytes).toBeGreaterThan(0);
    expect(first?.unresolvedWikiLinks).toBe(1);
    expect(first?.unresolvedObsidianEmbeds).toBe(1);
    // The local image is unresolved; the inline https image becomes a recoverable link.
    expect(first?.unresolvedLocalImages).toBe(1);
    expect(first?.unsupportedImageAddresses).toBe(0);
    expect(first?.inlineImagesFlattened).toBe(1);
    expect(printed.skipped).toEqual([
      { path: join(dir, 'notes.txt'), reason: 'not a Markdown file' },
    ]);
    expect(printed.failed).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
    await dropTree();
    await done();
  });

  it('orders source names by code unit independently of the host locale', async () => {
    const { env, done } = await withProfile();
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-import-order-'));
    await writeFile(join(dir, 'ä.md'), 'A.', 'utf8');
    await writeFile(join(dir, 'a.md'), 'A.', 'utf8');
    await writeFile(join(dir, 'Z.md'), 'Z.', 'utf8');

    const printed = (await captureJson((json) =>
      runImport(
        'default',
        { path: dir, workspaceId: WS, parentId: undefined, dryRun: true },
        json,
        { env },
      ),
    )) as { planned: { title: string }[] };

    expect(printed.planned.map((entry) => entry.title)).toEqual([basename(dir), 'Z', 'a', 'ä']);
    await rm(dir, { recursive: true, force: true });
    await done();
  });
});

describe('nixctl import', () => {
  it('returns a resumable worker receipt without waiting, committing, or cancelling', async () => {
    const { env, done } = await withProfile();
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-import-no-wait-'));
    const file = join(dir, 'resume.txt');
    await writeFile(file, 'Resume me.\n', 'utf8');
    const importId = 'a1111111-1111-4111-8111-111111111111';
    const operationId = 'a2222222-2222-4222-8222-222222222222';
    let uploadUrlSeen = false;
    let uploadType: string | null = null;
    let operationRead = false;
    let commitSeen = false;
    let cancelSeen = false;
    server.use(
      http.post(`${API}/api/v1/imports`, () =>
        HttpResponse.json({
          id: importId,
          status: 'pending_upload',
          uploadUrl: 'http://127.0.0.1:9445/private-capability?signature=secret',
          capabilityExpiresAt: '2026-09-01T00:10:00Z',
          expiresAt: '2026-09-01T01:00:00Z',
        }),
      ),
      http.put('http://127.0.0.1:9445/private-capability', ({ request }) => {
        uploadUrlSeen = true;
        uploadType = request.headers.get('content-type');
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(`${API}/api/v1/imports/${importId}/preview`, () =>
        HttpResponse.json(
          {
            id: operationId,
            kind: 'import.preview.txt',
            status: 'queued',
            result: null,
            errorCode: null,
            errorDetail: null,
            attempts: 0,
            cancellationRequested: false,
            createdAt: '2026-09-01T00:00:00Z',
            completedAt: null,
          },
          { status: 202 },
        ),
      ),
      http.get(`${API}/api/v1/operations/:operationId`, () => {
        operationRead = true;
        return HttpResponse.json({});
      }),
      http.post(`${API}/api/v1/imports/${importId}/commit`, () => {
        commitSeen = true;
        return HttpResponse.json({});
      }),
      http.delete(`${API}/api/v1/imports/${importId}`, () => {
        cancelSeen = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const stderr: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stderr.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        return true;
      });
    try {
      const printed = (await captureJson((json) =>
        runImport('default', { path: file, workspaceId: WS, dryRun: false, noWait: true }, json, {
          env,
        }),
      )) as Record<string, unknown>;
      expect(printed).toMatchObject({
        importId,
        operationId,
        phase: 'preview',
        operationStatus: 'queued',
      });
      expect(uploadUrlSeen).toBe(true);
      expect(uploadType).toBe('application/octet-stream');
      expect(operationRead).toBe(false);
      expect(commitSeen).toBe(false);
      expect(cancelSeen).toBe(false);
      expect(JSON.stringify(printed)).not.toContain('signature');
      expect(stderr.join('')).toContain(`importId=${importId}`);
      expect(stderr.join('')).not.toContain('uploadUrl');
    } finally {
      stderrSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
      await done();
    }
  });

  it('rejects incompatible no-wait flags before resolving a session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-import-no-wait-flags-'));
    const file = join(dir, 'notes.txt');
    const markdown = join(dir, 'notes.md');
    await writeFile(file, 'text', 'utf8');
    await writeFile(markdown, 'text', 'utf8');
    const env = { XDG_CONFIG_HOME: join(dir, 'missing-config') };
    await expect(
      runImport(
        'default',
        { path: file, workspaceId: WS, dryRun: true, noWait: true },
        outputOptions(true),
        { env },
      ),
    ).rejects.toThrow('--no-wait cannot be combined with --dry-run');
    await expect(
      runImport(
        'default',
        { path: markdown, workspaceId: WS, dryRun: false, noWait: true },
        outputOptions(true),
        { env },
      ),
    ).rejects.toThrow('--no-wait is available only');
    await rm(dir, { recursive: true, force: true });
  });

  it('streams a TXT document through the durable worker and publishes its subtree atomically', async () => {
    const { env, done } = await withProfile();
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-import-document-'));
    const file = join(dir, 'notes.txt');
    const source = 'Hello from a worker.\n';
    await writeFile(file, source, 'utf8');
    const importId = 'a1111111-1111-4111-8111-111111111111';
    const previewId = 'a2222222-2222-4222-8222-222222222222';
    const commitId = 'a3333333-3333-4333-8333-333333333333';
    const rootId = 'a4444444-4444-4444-8444-444444444444';
    const sourceSha256 = createHash('sha256').update(source).digest('hex');
    const plan = JSON.stringify({
      version: 1,
      format: 'txt',
      title: 'notes',
      sourceSha256,
      items: [
        {
          sourceId: 'root',
          parentSourceId: null,
          order: 0,
          title: 'notes',
          itemType: 'note',
          finalLifecycleState: 'active',
          body: { encoding: 'plain_text', text: source },
        },
        {
          sourceId: 'original',
          parentSourceId: 'root',
          order: 0,
          title: 'notes.txt',
          itemType: 'file',
          finalLifecycleState: 'active',
          file: {
            sourceKind: 'source',
            fileName: 'notes.txt',
            mediaType: 'text/plain',
            byteLength: Buffer.byteLength(source),
            sha256: sourceSha256,
            previewable: false,
          },
        },
      ],
      loss: [],
      omissions: [],
    });
    const planSha256 = createHash('sha256').update(plan).digest('hex');
    let uploaded = '';
    let importReads = 0;
    const operation = (id: string, kind: string) => ({
      id,
      kind,
      status: 'completed',
      result: null,
      errorCode: null,
      errorDetail: null,
      attempts: 1,
      cancellationRequested: false,
      createdAt: '2026-09-01T00:00:00Z',
      completedAt: '2026-09-01T00:00:01Z',
    });
    server.use(
      http.post(`${API}/api/v1/imports`, () =>
        HttpResponse.json({
          id: importId,
          status: 'pending_upload',
          uploadUrl: 'http://127.0.0.1:9445/source',
          capabilityExpiresAt: '2026-09-01T00:10:00Z',
          expiresAt: '2026-09-01T01:00:00Z',
        }),
      ),
      http.put('http://127.0.0.1:9445/source', async ({ request }) => {
        uploaded = await request.text();
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(`${API}/api/v1/imports/${importId}/preview`, () =>
        HttpResponse.json(operation(previewId, 'import.preview.txt'), { status: 202 }),
      ),
      http.get(`${API}/api/v1/operations/${previewId}`, () =>
        HttpResponse.json(operation(previewId, 'import.preview.txt')),
      ),
      http.get(`${API}/api/v1/imports/${importId}`, () => {
        importReads += 1;
        const completed = importReads > 1;
        return HttpResponse.json({
          id: importId,
          workspaceId: WS,
          uploadId: 'a5555555-5555-4555-8555-555555555555',
          parentId: null,
          format: 'txt',
          title: 'notes',
          status: completed ? 'completed' : 'preview_ready',
          previewOperationId: previewId,
          commitOperationId: completed ? commitId : null,
          itemCount: 2,
          assetCount: 0,
          loss: [],
          omissions: [],
          rootItemId: completed ? rootId : null,
          failureCode: null,
          expiresAt: '2026-09-01T01:00:00Z',
          completedAt: completed ? '2026-09-01T00:00:02Z' : null,
        });
      }),
      http.get(`${API}/api/v1/imports/${importId}/preview`, () =>
        HttpResponse.json({
          url: 'http://127.0.0.1:9445/plan',
          expiresAt: '2026-09-01T00:10:00Z',
          sha256: planSha256,
          byteLength: Buffer.byteLength(plan),
        }),
      ),
      http.get('http://127.0.0.1:9445/plan', () => new HttpResponse(plan)),
      http.post(`${API}/api/v1/imports/${importId}/commit`, () =>
        HttpResponse.json(operation(commitId, 'import.commit'), { status: 202 }),
      ),
      http.get(`${API}/api/v1/operations/${commitId}`, () =>
        HttpResponse.json(operation(commitId, 'import.commit')),
      ),
    );

    const printed = (await captureJson((json) =>
      runImport(
        'default',
        { path: file, workspaceId: WS, parentId: undefined, dryRun: false },
        json,
        { env },
      ),
    )) as {
      atomic: boolean;
      rootItemId: string;
      createdCount: number;
      status: string;
    };

    expect(uploaded).toBe(source);
    expect(printed).toMatchObject({
      atomic: true,
      rootItemId: rootId,
      createdCount: 2,
      status: 'completed',
    });
    expect(process.exitCode ?? 0).toBe(0);
    await rm(dir, { recursive: true, force: true });
    await done();
  });

  it('imports a folder tree as a coherent item tree with bodies and properties', async () => {
    const { env, done } = await withProfile();
    const { dir, done: dropTree } = await withSourceTree();

    const parents: (string | null)[] = [];
    const propertyPatches: Record<string, unknown>[] = [];
    const bodyWrites = { count: 0 };
    server.use(...greenHandlers({ parents, propertyPatches, bodyWrites }));

    const printed = (await captureJson((json) =>
      runImport(
        'default',
        { path: dir, workspaceId: WS, parentId: undefined, dryRun: false },
        json,
        { env },
      ),
    )) as {
      rootItemId: string;
      createdCount: number;
      stoppedEarly: boolean;
      notAttempted: unknown[];
      created: {
        path: string;
        itemId: string;
        title: string;
        properties: string[];
        bodyBytes: number;
        unresolvedWikiLinks: number;
        unresolvedObsidianEmbeds: number;
        unresolvedLocalImages: number;
        unsupportedImageAddresses: number;
        inlineImagesFlattened: number;
      }[];
    };

    expect(printed.createdCount).toBe(4);
    expect(printed.stoppedEarly).toBe(false);
    expect(printed.notAttempted).toEqual([]);
    // The tree is coherent: the folder is the root, both notes and the subfolder hang beneath it.
    expect(parents[0]).toBeNull();
    expect(parents[1]).toBe(printed.rootItemId);
    expect(parents[2]).toBe(printed.rootItemId);
    const sub = printed.created.find((entry) => entry.title === 'sub');
    expect(parents[3]).toBe(sub?.itemId);
    // Both note bodies were written; the front matter became one property patch, title excluded.
    expect(bodyWrites.count).toBe(2);
    expect(propertyPatches).toEqual([{ status: 'done', count: 5 }]);
    const first = printed.created.find((entry) => entry.title === 'First Note');
    expect(first?.bodyBytes).toBeGreaterThan(0);
    expect(first).toMatchObject({
      unresolvedWikiLinks: 1,
      unresolvedObsidianEmbeds: 1,
      unresolvedLocalImages: 1,
      unsupportedImageAddresses: 0,
      inlineImagesFlattened: 1,
    });
    // A whole import is a success a script can branch on.
    expect(process.exitCode ?? 0).toBe(0);
    await done();
    await dropTree();
  });

  it('imports under the named parent when --parent is given', async () => {
    const { env, done } = await withProfile();
    const parent = '11111111-1111-4111-8111-111111111111';
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-import-one-'));
    const file = join(dir, 'solo.md');
    await writeFile(file, 'Solo body.\n', 'utf8');

    const parents: (string | null)[] = [];
    server.use(...greenHandlers({ parents }));

    await captureJson((json) =>
      runImport('default', { path: file, workspaceId: WS, parentId: parent, dryRun: false }, json, {
        env,
      }),
    );

    expect(parents).toEqual([parent]);
    await rm(dir, { recursive: true, force: true });
    await done();
  });

  it('puts the subtree of a failed container in notAttempted, keeps the refusal verbatim, and exits non-zero', async () => {
    const { env, done } = await withProfile();
    const { dir, done: dropTree } = await withSourceTree();

    server.use(...greenHandlers({}));
    server.use(
      http.post(`${API}/api/v1/workspaces/:workspaceId/items`, async ({ request }) => {
        const body = (await request.json()) as {
          type?: string;
          title?: string;
          parentId?: string | null;
        };
        if (body.title === 'sub') {
          return HttpResponse.json(
            {
              type: 'about:blank',
              title: 'Server error',
              status: 500,
              detail: 'boom',
              code: 'server.error',
            },
            { status: 500, headers: { 'content-type': 'application/problem+json' } },
          );
        }
        return HttpResponse.json(itemFrom(body));
      }),
    );

    const printed = (await captureJson((json) =>
      runImport(
        'default',
        { path: dir, workspaceId: WS, parentId: undefined, dryRun: false },
        json,
        { env },
      ),
    )) as {
      createdCount: number;
      failed: { path: string; reason: string }[];
      notAttempted: { path: string; reason: string }[];
    };

    // Root and the first note made it; `sub` failed with the service's own words; `nested.md` is
    // accounted for rather than vanishing.
    expect(printed.createdCount).toBe(2);
    expect(printed.failed).toEqual([{ path: join(dir, 'sub'), reason: 'boom' }]);
    expect(printed.notAttempted).toEqual([
      { path: join(dir, 'sub', 'nested.md'), reason: 'its parent was not imported' },
    ]);
    expect(process.exitCode).toBe(1);
    await dropTree();
    await done();
  });

  it('reports an item whose body write was refused as created-with-a-loss, keeping its id', async () => {
    const { env, done } = await withProfile();
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-import-body-'));
    await writeFile(join(dir, 'note.md'), 'A body.\n', 'utf8');

    server.use(...greenHandlers({}));
    server.use(
      http.post(`${COLLAB}/documents/:itemId/updates`, () =>
        HttpResponse.json({ detail: 'collab refused the body' }, { status: 503 }),
      ),
    );

    const printed = (await captureJson((json) =>
      runImport(
        'default',
        { path: dir, workspaceId: WS, parentId: undefined, dryRun: false },
        json,
        { env },
      ),
    )) as {
      created: { title: string; itemId: string; bodyBytes: number; bodyError?: string }[];
      failed: unknown[];
    };

    // The item exists in the workspace, so the report says so and hands over its id; the loss is
    // declared on the row rather than the row pretending nothing was made.
    const note = printed.created.find((entry) => entry.title === 'note');
    expect(note?.itemId).toBeDefined();
    expect(note?.bodyBytes).toBe(0);
    expect(note?.bodyError).toBe('collab refused the body');
    expect(printed.failed).toEqual([]);
    expect(process.exitCode).toBe(1);
    await rm(dir, { recursive: true, force: true });
    await done();
  });

  it('reports an item whose property patch was refused as created-with-a-loss', async () => {
    const { env, done } = await withProfile();
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-import-props-'));
    await writeFile(join(dir, 'note.md'), '---\nstatus: done\n---\nA body.\n', 'utf8');

    server.use(...greenHandlers({}));
    server.use(
      http.patch(`${API}/api/v1/items/:itemId/properties`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Invalid',
            status: 422,
            detail: 'no such property',
            code: 'schema.unknown_property',
          },
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    const printed = (await captureJson((json) =>
      runImport(
        'default',
        { path: dir, workspaceId: WS, parentId: undefined, dryRun: false },
        json,
        { env },
      ),
    )) as { created: { title: string; propertiesError?: string }[] };

    const note = printed.created.find((entry) => entry.title === 'note');
    expect(note?.propertiesError).toBe('no such property');
    expect(process.exitCode).toBe(1);
    await rm(dir, { recursive: true, force: true });
    await done();
  });

  it('stops honestly at the write rate limit: keeps what it made, lists the rest, and does not promise a resume', async () => {
    const { env, done } = await withProfile();
    const { dir, done: dropTree } = await withSourceTree();

    let creates = 0;
    server.use(...greenHandlers({}));
    server.use(
      http.post(`${API}/api/v1/workspaces/:workspaceId/items`, async ({ request }) => {
        creates += 1;
        if (creates >= 2) {
          return HttpResponse.json(
            { code: 'rate.limited', detail: 'Too many writes.' },
            { status: 429 },
          );
        }
        const body = (await request.json()) as {
          type?: string;
          title?: string;
          parentId?: string | null;
        };
        return HttpResponse.json(itemFrom(body));
      }),
    );

    const printed = (await captureJson((json) =>
      runImport(
        'default',
        { path: dir, workspaceId: WS, parentId: undefined, dryRun: false },
        json,
        { env },
      ),
    )) as {
      createdCount: number;
      stoppedEarly: boolean;
      reason: string;
      rootItemId: string;
      notAttempted: { path: string; reason: string }[];
    };

    expect(printed.stoppedEarly).toBe(true);
    expect(printed.createdCount).toBe(1);
    // The one handle that removes the partial import is reported, and the advice names it rather
    // than suggesting a re-run the command cannot deduplicate.
    expect(printed.rootItemId).toBe('00000000-0000-4000-8000-000000000001');
    expect(printed.reason).toContain('Nix__RateLimits__WritesPerMinute');
    expect(printed.reason).toContain('nixctl item rm');
    expect(printed.reason).not.toContain('re-run against what remains');
    // Everything the stop abandoned is accounted for.
    expect(printed.notAttempted.map((entry) => entry.path).sort()).toEqual(
      [join(dir, 'a-first.md'), join(dir, 'sub'), join(dir, 'sub', 'nested.md')].sort(),
    );
    expect(
      printed.notAttempted.every((entry) => entry.reason === 'stopped at the write rate limit'),
    ).toBe(true);
    expect(process.exitCode).toBe(1);
    await dropTree();
    await done();
  });

  it('refuses a single file that is not Markdown, naming the reason', async () => {
    const { env, done } = await withProfile();
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-import-txt-'));
    const file = join(dir, 'notes.bin');
    await writeFile(file, 'plain text', 'utf8');

    await expect(
      captureJson((json) =>
        runImport(
          'default',
          { path: file, workspaceId: WS, parentId: undefined, dryRun: false },
          json,
          { env },
        ),
      ),
    ).rejects.toThrow(/not a Markdown file/);

    await rm(dir, { recursive: true, force: true });
    await done();
  });

  it('does not follow a symbolic link and skips hidden directories, reporting both', async () => {
    const { env, done } = await withProfile();
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-import-link-'));
    await writeFile(join(dir, 'real.md'), 'Real.\n', 'utf8');
    // A cycle: the link points back at the folder that contains it. And a vault's private space.
    await symlink(dir, join(dir, 'loop'));
    await mkdir(join(dir, '.obsidian'));
    await writeFile(join(dir, '.obsidian', 'config.md'), 'tool config', 'utf8');

    const printed = (await captureJson((json) =>
      runImport(
        'default',
        { path: dir, workspaceId: WS, parentId: undefined, dryRun: true },
        json,
        { env },
      ),
    )) as { planned: { title: string }[]; skipped: { path: string; reason: string }[] };

    expect(printed.planned.map((entry) => entry.title)).toEqual([basename(dir), 'real']);
    expect(printed.skipped).toEqual([
      { path: join(dir, '.obsidian'), reason: 'hidden directory, not imported' },
      { path: join(dir, 'loop'), reason: 'symbolic link, not followed' },
    ]);
    await rm(dir, { recursive: true, force: true });
    await done();
  });
});
