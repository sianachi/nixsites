import { files as fileResources, NixApiError, NixErrorKind, type NixClient } from '@nix/api-client';
import { EMPTY_MARKDOWN_IMPORT_SCAN } from '@nix/markdown/scan';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runImportPlan } from '../../import/import-run';
import type { PlannedNode } from '../../import/import-plan';

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

/** A minimal body the editor schema accepts, so the real writer can encode it. */
const DOC = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
};

function note(path: string, title: string, overrides: Partial<PlannedNode> = {}): PlannedNode {
  return {
    path,
    kind: 'note',
    title,
    properties: {},
    doc: DOC,
    droppedFrontMatter: [],
    scan: EMPTY_MARKDOWN_IMPORT_SCAN,
    children: [],
    ...overrides,
  };
}

function container(path: string, title: string, children: readonly PlannedNode[]): PlannedNode {
  return note(path, title, { kind: 'container', doc: null, children });
}

function attachment(path: string, file: File): PlannedNode {
  return {
    path,
    kind: 'attachment',
    title: file.name,
    properties: {},
    doc: null,
    droppedFrontMatter: [],
    scan: EMPTY_MARKDOWN_IMPORT_SCAN,
    file,
    children: [],
  };
}

/** A client whose `execute` runs the given script, one answer per call. */
function clientOf(script: (operation: string, body: unknown) => unknown): {
  client: NixClient;
  calls: { operation: string; body: unknown }[];
} {
  const calls: { operation: string; body: unknown }[] = [];
  const client = {
    execute: (endpoint: { operation: string; body?: unknown }) => {
      calls.push({ operation: endpoint.operation, body: endpoint.body });
      const answer = script(endpoint.operation, endpoint.body);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  } as unknown as NixClient;
  return { client, calls };
}

/** The collab side, driven through the writer's own fetch seam rather than a mock of our module. */
function collabOf(answer: () => Response): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  posts: string[];
} {
  const posts: string[] = [];
  return {
    posts,
    fetchImpl: (url: string) => {
      posts.push(url);
      return Promise.resolve(answer());
    },
  };
}

const collabOk = (): Response => new Response(JSON.stringify({ seq: 's1' }), { status: 200 });

let created = 0;
function item(): { id: string } {
  created += 1;
  return { id: `00000000-0000-4000-8000-${String(created).padStart(12, '0')}` };
}

function rateLimit(): NixApiError {
  return new NixApiError({
    kind: NixErrorKind.Problem,
    code: 'rate.limited',
    message: 'Too many writes.',
    status: 429,
    detail: 'Too many writes.',
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  created = 0;
});

describe('running an import plan', () => {
  it('uploads an attachment under its planned parent without reading it as a note', async () => {
    const { client, calls } = clientOf((operation) =>
      operation === 'files.upload.begin' ? { id: 'upload-id' } : item(),
    );
    vi.spyOn(fileResources, 'uploadAndCompleteFile').mockResolvedValue({
      itemId: '00000000-0000-4000-8000-000000000099',
    } as never);

    const report = await runImportPlan({
      workspaceId: WORKSPACE_ID,
      plan: container('vault', 'vault', [
        attachment('vault/photo.png', new File(['pixels'], 'photo.png', { type: 'image/png' })),
      ]),
      parentId: null,
      client,
      getAccessToken: () => Promise.resolve('token'),
    });

    expect(calls.map((call) => call.operation)).toEqual(['items.create', 'files.upload.begin']);
    expect(calls[1]?.body).toMatchObject({ parentId: report.rootItemId, fileName: 'photo.png' });
    expect(report.created.map((row) => row.title)).toEqual(['vault', 'photo.png']);
  });

  it('creates parents before children, writes each body once, and reports every created row', async () => {
    const { client, calls } = clientOf(() => item());
    const collab = collabOf(collabOk);

    const plan = container('vault', 'vault', [
      note('vault/a.md', 'a', { properties: { status: 'done' } }),
      container('vault/sub', 'sub', [note('vault/sub/deep.md', 'deep')]),
    ]);

    const report = await runImportPlan({
      workspaceId: WORKSPACE_ID,
      plan,
      parentId: 'p1000000-0000-4000-8000-000000000001',
      client,
      getAccessToken: () => Promise.resolve('token'),
      fetchImpl: collab.fetchImpl,
    });

    expect(report.created.map((row) => row.title)).toEqual(['vault', 'a', 'sub', 'deep']);
    expect(report.rootItemId).toBe(report.created[0]?.itemId ?? null);
    expect(report.failed).toEqual([]);
    expect(report.notAttempted).toEqual([]);
    expect(report.stoppedEarly).toBe(false);
    // One body write per note, none for the containers; one property patch for the front matter.
    expect(collab.posts).toHaveLength(2);
    expect(calls.filter((call) => call.operation === 'properties.set')).toHaveLength(1);
  });

  it('reports a refused body write on the created row rather than hiding the item', async () => {
    const { client } = clientOf(() => item());
    const collab = collabOf(
      () => new Response(JSON.stringify({ detail: 'collab refused the body' }), { status: 503 }),
    );

    const report = await runImportPlan({
      workspaceId: WORKSPACE_ID,
      plan: container('x', 'x', [note('x/a.md', 'a')]),
      parentId: null,
      client,
      getAccessToken: () => Promise.resolve('token'),
      fetchImpl: collab.fetchImpl,
    });

    const row = report.created.find((entry) => entry.title === 'a');
    expect(row?.itemId).toBeDefined();
    expect(row?.bodyError).toBe('collab refused the body');
    expect(report.failed).toEqual([]);
  });

  it('sends the subtree of a failed container to notAttempted, with the refusal verbatim', async () => {
    const { client } = clientOf((operation, body) => {
      const title = (body as { title?: string }).title;
      if (operation === 'items.create' && title === 'sub') {
        return new NixApiError({
          kind: NixErrorKind.Problem,
          code: 'server.error',
          message: 'Server error',
          status: 500,
          detail: 'boom',
        });
      }
      return item();
    });

    const report = await runImportPlan({
      workspaceId: WORKSPACE_ID,
      plan: container('x', 'x', [container('x/sub', 'sub', [note('x/sub/deep.md', 'deep')])]),
      parentId: null,
      client,
      getAccessToken: () => Promise.resolve('token'),
      fetchImpl: collabOf(collabOk).fetchImpl,
    });

    expect(report.failed).toEqual([{ path: 'x/sub', reason: 'boom' }]);
    expect(report.notAttempted).toEqual([
      { path: 'x/sub/deep.md', reason: 'its parent was not imported' },
    ]);
  });

  it('stops at the write rate limit on a create, keeps what it made, and accounts for the rest', async () => {
    let creates = 0;
    const { client } = clientOf((operation) => {
      if (operation === 'items.create') {
        creates += 1;
        if (creates >= 2) {
          return rateLimit();
        }
      }
      return item();
    });

    const report = await runImportPlan({
      workspaceId: WORKSPACE_ID,
      plan: container('x', 'x', [note('x/a.md', 'a'), note('x/b.md', 'b')]),
      parentId: null,
      client,
      getAccessToken: () => Promise.resolve('token'),
      fetchImpl: collabOf(collabOk).fetchImpl,
    });

    expect(report.stoppedEarly).toBe(true);
    expect(report.created).toHaveLength(1);
    expect(report.rootItemId).not.toBeNull();
    expect(report.notAttempted.map((row) => row.path).sort()).toEqual(['x/a.md', 'x/b.md']);
    expect(
      report.notAttempted.every((row) => row.reason === 'stopped at the write rate limit'),
    ).toBe(true);
  });

  it('stops at the write rate limit on a property patch too, declaring the loss on the row', async () => {
    const { client } = clientOf((operation) =>
      operation === 'properties.set' ? rateLimit() : item(),
    );

    const report = await runImportPlan({
      workspaceId: WORKSPACE_ID,
      plan: container('x', 'x', [
        note('x/a.md', 'a', { properties: { status: 'done' } }),
        note('x/b.md', 'b'),
      ]),
      parentId: null,
      client,
      getAccessToken: () => Promise.resolve('token'),
      fetchImpl: collabOf(collabOk).fetchImpl,
    });

    expect(report.stoppedEarly).toBe(true);
    const row = report.created.find((entry) => entry.title === 'a');
    expect(row?.propertiesError).toBe('Too many writes.');
    expect(report.notAttempted).toEqual([
      { path: 'x/b.md', reason: 'stopped at the write rate limit' },
    ]);
  });

  it('stops between items when cancelled, reporting the rest as not attempted', async () => {
    const controller = new AbortController();
    const { client } = clientOf((operation) => {
      if (operation === 'items.create') {
        // The person presses Stop while the first item is in flight.
        controller.abort();
      }
      return item();
    });

    const report = await runImportPlan({
      workspaceId: WORKSPACE_ID,
      plan: container('x', 'x', [note('x/a.md', 'a'), note('x/b.md', 'b')]),
      parentId: null,
      client,
      getAccessToken: () => Promise.resolve('token'),
      signal: controller.signal,
      fetchImpl: collabOf(collabOk).fetchImpl,
    });

    expect(report.stoppedEarly).toBe(true);
    expect(report.stopReason).toBe('The import was cancelled.');
    expect(report.created).toHaveLength(1);
    expect(report.notAttempted.map((row) => row.path).sort()).toEqual(['x/a.md', 'x/b.md']);
    expect(report.notAttempted.every((row) => row.reason === 'cancelled')).toBe(true);
  });

  it('refuses to run without a session as its own case, not a file failure', async () => {
    const { client, calls } = clientOf(() => item());

    const report = await runImportPlan({
      workspaceId: WORKSPACE_ID,
      plan: container('x', 'x', []),
      parentId: null,
      client,
      getAccessToken: () => Promise.resolve(null),
    });

    expect(report.rootItemId).toBeNull();
    expect(report.couldNotStart).toContain('session has expired');
    expect(report.failed).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('treats a session read that throws the same as no session', async () => {
    const { client, calls } = clientOf(() => item());

    const report = await runImportPlan({
      workspaceId: WORKSPACE_ID,
      plan: container('x', 'x', []),
      parentId: null,
      client,
      getAccessToken: () => Promise.reject(new Error('storage exploded')),
    });

    expect(report.couldNotStart).toContain('session has expired');
    expect(calls).toEqual([]);
  });
});
