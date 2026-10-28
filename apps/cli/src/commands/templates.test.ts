import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveProfile } from '../config.ts';
import { outputOptions } from '../output.ts';
import { openSession } from '../session.ts';
import { resolveSession } from './shared.ts';
import { executeOperationGet } from './operations.ts';
import { makeProfile } from './cli.test-helper.ts';
import {
  applyTemplate,
  captureTemplate,
  executeTemplateApply,
  executeTemplateImportGet,
  executeTemplateImportCancel,
  executeTemplateInitializationUpdate,
  executeTemplateOperationResume,
  executeTemplateArchivePreview,
  listTemplates,
} from './templates.ts';

const CORE = 'http://core.nix.test';
const COLLAB = 'http://collab.nix.test';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const ITEM = '11111111-1111-4111-8111-111111111111';
const TEMPLATE = '33333333-3333-4333-8333-333333333333';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const APPLICATION = '55555555-5555-4555-8555-555555555555';

const server = setupServer(
  http.post(`${CORE}/public/v1/auth/token`, () =>
    HttpResponse.json({ accessToken: 'jwt-1', tokenType: 'Bearer', expiresInSeconds: 600 }),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

async function capture(
  body: (json: ReturnType<typeof outputOptions>) => Promise<void>,
): Promise<unknown> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  });
  try {
    await body(outputOptions(true, { isTTY: false }));
    return JSON.parse(lines.join(''));
  } finally {
    spy.mockRestore();
  }
}

const withProfile = () => makeProfile({ apiUrl: CORE, collabUrl: COLLAB, token: 'nixpat_abc' });

function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TEMPLATE,
    workspaceId: WORKSPACE,
    title: 'Project seed',
    description: null,
    origin: 'user',
    revision: 7,
    includeBody: false,
    includeChildren: false,
    fieldCount: 0,
    viewCount: 0,
    childCount: 0,
    viewKinds: [],
    capabilities: { canEdit: true, canDelete: true, canExport: true, canApply: true },
    updatedAt: '2026-09-20T09:00:00Z',
    initialization: {
      version: 1,
      inputs: [{ key: 'project_name', label: 'Project name', type: 'text', required: true }],
      rules: [],
      references: [],
    },
    root: {
      sourceId: ITEM,
      itemType: 'note',
      title: 'Project seed',
      seq: '1',
      properties: {},
      schema: { properties: [], declared: [], inherit: false },
      views: null,
      hasBody: false,
      recurrence: null,
      children: [],
    },
    ...overrides,
  };
}

describe('the template commands use Core and Collab at their configured origins', () => {
  it('reads durable operation and template import state through the authorized Core client', async () => {
    const { env, done } = await withProfile();
    const operation = {
      id: OPERATION,
      kind: 'template.commit',
      status: 'running',
      result: null,
      errorCode: null,
      errorDetail: null,
      attempts: 1,
      cancellationRequested: false,
      createdAt: '2026-09-20T09:00:00Z',
      completedAt: null,
    };
    const templateImport = {
      id: OPERATION,
      workspaceId: WORKSPACE,
      status: 'preview_ready',
      previewOperationId: null,
      commitOperationId: null,
      preview: {
        profile: {
          kind: 'template',
          version: 1,
          key: 'user.test',
          name: 'Test template',
          description: '',
          includeBody: false,
          includeChildren: false,
        },
        digest: 'a'.repeat(64),
        rootItemType: 'note',
        itemCount: 1,
        bodyCount: 0,
        viewCount: 0,
      },
      result: null,
      failureCode: null,
      expiresAt: '2026-09-20T10:00:00Z',
      completedAt: null,
    };
    server.use(
      http.get(`${CORE}/api/v1/operations/${OPERATION}`, () => HttpResponse.json(operation)),
      http.get(`${CORE}/api/v1/template-imports/${OPERATION}`, () =>
        HttpResponse.json(templateImport),
      ),
    );
    const session = await resolveSession('default', { env });
    expect(await executeOperationGet(session, OPERATION)).toEqual(operation);
    expect(await executeTemplateImportGet(session, OPERATION)).toEqual(templateImport);
    await done();
  });

  it('cancels only through the current principal bearer session', async () => {
    const { env, done } = await withProfile();
    let authorization: string | null = null;
    server.use(
      http.delete(`${CORE}/api/v1/template-imports/${OPERATION}`, ({ request }) => {
        authorization = request.headers.get('authorization');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const session = await resolveSession('default', {
      env: { ...env, NIX_SESSION_TOKEN: 'service-session-token' },
    });
    expect(await executeTemplateImportCancel(session, OPERATION)).toEqual({
      canceled: true,
      importId: OPERATION,
    });
    expect(authorization).toBe('Bearer service-session-token');
    await done();
  });

  it('uses NIX_SESSION_TOKEN from process.env when commands receive no injected env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-session-token-'));
    await saveProfile(
      'default',
      { apiUrl: CORE, collabUrl: COLLAB, token: 'nixpat_abc' },
      { makeDefault: true, env: { XDG_CONFIG_HOME: dir } },
    );
    let authorization: string | null = null;
    server.use(
      http.delete(`${CORE}/api/v1/template-imports/${OPERATION}`, ({ request }) => {
        authorization = request.headers.get('authorization');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    vi.stubEnv('XDG_CONFIG_HOME', dir);
    vi.stubEnv('NIX_SESSION_TOKEN', 'process-session-token');
    try {
      const session = await resolveSession('default');
      await executeTemplateImportCancel(session, OPERATION);
      expect(authorization).toBe('Bearer process-session-token');
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses oversized template archives before reading or uploading them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-templates-'));
    const path = join(dir, 'oversized.nix');
    await writeFile(path, 'x');
    await truncate(path, 64 * 1024 * 1024 + 1);
    try {
      await expect(
        executeTemplateArchivePreview({} as never, WORKSPACE, path, 'oversized-key'),
      ).rejects.toThrow('Template archives must be between 1 byte and 64 MiB.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists templates through Core', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${CORE}/api/v1/workspaces/${WORKSPACE}/templates`, () =>
        HttpResponse.json({ templates: [], capabilities: { canManage: true } }),
      ),
    );
    const printed = await capture((json) => listTemplates('default', WORKSPACE, json, { env }));
    expect(printed).toEqual({ templates: [], capabilities: { canManage: true } });
    await done();
  });

  it('captures through the separately configured Collab origin', async () => {
    const { env, done } = await withProfile();
    let captureRequest: Record<string, unknown> | null = null;
    server.use(
      http.post(`${COLLAB}/templates/captures`, async ({ request }) => {
        captureRequest = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          templateId: TEMPLATE,
          operationId: OPERATION,
          writtenTargetItemIds: [],
        });
      }),
    );
    const printed = await capture((json) =>
      captureTemplate(
        'default',
        {
          workspaceId: WORKSPACE,
          sourceItemId: ITEM,
          title: 'Project seed',
          includeBody: false,
          includeChildren: true,
        },
        json,
        { env },
        () => 'capture-key',
      ),
    );
    expect(captureRequest).toMatchObject({
      workspaceId: WORKSPACE,
      sourceItemId: ITEM,
      includeChildren: true,
    });
    expect(printed).toMatchObject({
      capture: { templateId: TEMPLATE, operationId: OPERATION },
    });
    expect(typeof (printed as { resume: { idempotencyKey: unknown } }).resume.idempotencyKey).toBe(
      'string',
    );
    await done();
  });

  it('waits for the Core file-copy job and replays capture with the identical request', async () => {
    const { env, done } = await withProfile();
    const requests: Record<string, unknown>[] = [];
    let captureCalls = 0;
    server.use(
      http.post(`${COLLAB}/templates/captures`, async ({ request }) => {
        requests.push((await request.json()) as Record<string, unknown>);
        captureCalls += 1;
        return HttpResponse.json({
          templateId: TEMPLATE,
          operationId: OPERATION,
          fileTransferJobId: captureCalls === 1 ? APPLICATION : null,
          fileTransferPending: captureCalls === 1,
          writtenTargetItemIds: [],
        });
      }),
      http.get(`${CORE}/api/v1/operations/${APPLICATION}`, () =>
        HttpResponse.json({
          id: APPLICATION,
          kind: 'template.files.copy',
          status: 'completed',
          result: null,
          errorCode: null,
          errorDetail: null,
          attempts: 1,
          cancellationRequested: false,
          createdAt: '2026-09-20T09:00:00Z',
          completedAt: '2026-09-20T09:00:01Z',
        }),
      ),
    );

    await capture((json) =>
      captureTemplate(
        'default',
        {
          workspaceId: WORKSPACE,
          sourceItemId: ITEM,
          title: 'Project seed',
          includeBody: true,
          includeChildren: true,
          idempotencyKey: 'resume-capture',
        },
        json,
        { env },
      ),
    );
    expect(captureCalls).toBe(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]).toMatchObject({ idempotencyKey: 'resume-capture' });
    await done();
  });

  it('preflights on Core, passes empty optional answers, then applies through Collab', async () => {
    const { env, done } = await withProfile();
    let preflightBody: Record<string, unknown> | null = null;
    let applyBody: Record<string, unknown> | null = null;
    server.use(
      http.get(`${CORE}/api/v1/templates/${TEMPLATE}`, () => HttpResponse.json(detail())),
      http.post(`${CORE}/api/v1/templates/${TEMPLATE}/preflight`, async ({ request }) => {
        preflightBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          templateId: TEMPLATE,
          templateRevision: 8,
          mode: 'create',
          additions: { fields: 0, views: 0, items: 1 },
          conflicts: [],
          canApply: true,
          initializationPreview: [{ sourceId: ITEM, title: '', properties: {}, recurrence: null }],
          resolvedInputs: {},
          textBindings: { project_name: '' },
          referenceMappings: {},
        });
      }),
      http.post(`${COLLAB}/templates/applications`, async ({ request }) => {
        applyBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          applicationId: APPLICATION,
          templateId: TEMPLATE,
          targetItemId: ITEM,
          alreadyApplied: false,
          createdItems: [{ sourceId: ITEM, itemId: ITEM, itemType: 'note' }],
          resolvedInputs: {},
          textBindings: { project_name: '' },
          referenceMappings: {},
          writtenTargetItemIds: [],
          operationId: OPERATION,
        });
      }),
    );

    const printed = await capture((json) =>
      applyTemplate(
        'default',
        { templateId: TEMPLATE, mode: 'create', parentItemId: null, inputs: { project_name: '' } },
        json,
        { env },
      ),
    );
    expect(preflightBody).toMatchObject({
      mode: 'create',
      expectedRevision: 7,
      inputs: { project_name: '' },
    });
    expect(applyBody).toMatchObject({
      mode: 'create',
      expectedRevision: 8,
      inputs: { project_name: '' },
    });
    expect(printed).toMatchObject({
      application: { applicationId: APPLICATION },
      resume: { expectedRevision: 8 },
    });
    await done();
  });

  it('returns a durable apply receipt and resumes against the original revision after catalog changes', async () => {
    const { env, done } = await withProfile();
    let details = 0;
    let preflights = 0;
    const applyBodies: Record<string, unknown>[] = [];
    server.use(
      http.get(`${CORE}/api/v1/templates/${TEMPLATE}`, () => {
        details += 1;
        return HttpResponse.json(detail({ revision: details === 1 ? 7 : 9 }));
      }),
      http.post(`${CORE}/api/v1/templates/${TEMPLATE}/preflight`, async ({ request }) => {
        preflights += 1;
        expect(await request.json()).toMatchObject({ expectedRevision: 7 });
        return HttpResponse.json({
          templateId: TEMPLATE,
          templateRevision: 8,
          mode: 'create',
          additions: { fields: 0, views: 0, items: 1 },
          conflicts: [],
          canApply: true,
          initializationPreview: [],
          resolvedInputs: {},
          textBindings: {},
          referenceMappings: {},
        });
      }),
      http.post(`${COLLAB}/templates/applications`, async ({ request }) => {
        applyBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({
          applicationId: APPLICATION,
          templateId: TEMPLATE,
          targetItemId: ITEM,
          alreadyApplied: false,
          createdItems: [],
          resolvedInputs: {},
          textBindings: {},
          referenceMappings: {},
          fileTransferJobId: applyBodies.length === 1 ? OPERATION : null,
          fileTransferPending: applyBodies.length === 1,
          writtenTargetItemIds: [],
          operationId: APPLICATION,
        });
      }),
      http.get(`${CORE}/api/v1/operations/${OPERATION}`, () =>
        HttpResponse.json({
          id: OPERATION,
          kind: 'template.files.copy',
          status: 'completed',
          result: null,
          errorCode: null,
          errorDetail: null,
          attempts: 1,
          cancellationRequested: false,
          createdAt: '2026-09-20T09:00:00Z',
          completedAt: '2026-09-20T09:00:01Z',
        }),
      ),
    );
    const resolved = await import('../config.ts').then(({ resolveProfile }) =>
      resolveProfile('default', env),
    );
    if (resolved === null) throw new Error('Expected the local test profile.');
    const { openSession } = await import('../session.ts');
    const session = openSession({
      profile: resolved.profile,
      fetchImpl: () =>
        Promise.resolve(
          Response.json({ accessToken: 'jwt-1', tokenType: 'Bearer', expiresInSeconds: 600 }),
        ),
    });
    const started = (await executeTemplateApply(
      session,
      { templateId: TEMPLATE, mode: 'create', parentItemId: WORKSPACE },
      () => 'apply-resume-key',
      { waitForFileTransfer: false },
    )) as { resume: { kind: 'apply'; jobId: string; request: unknown; expectedRevision: number } };
    expect(started.resume).toMatchObject({ kind: 'apply', jobId: OPERATION, expectedRevision: 8 });

    await executeTemplateOperationResume(session, {
      kind: started.resume.kind,
      jobId: started.resume.jobId,
      request: started.resume.request,
    });
    expect(details).toBe(1);
    expect(preflights).toBe(1);
    expect(applyBodies).toHaveLength(2);
    expect(applyBodies[1]).toEqual(applyBodies[0]);
    expect(applyBodies[1]).toMatchObject({
      expectedRevision: 8,
      idempotencyKey: 'nixctl-template-apply:33333333-3333-4333-8333-333333333333:apply-resume-key',
    });
    await done();
  });

  it('opens, updates, and saves initialization drafts at direct Collab routes', async () => {
    const { env, done } = await withProfile();
    const urls: string[] = [];
    const initialization = {
      version: 1 as const,
      inputs: [
        {
          key: 'project_name',
          label: 'Project name',
          type: 'text' as const,
          required: true,
          defaultValue: null,
        },
      ],
      rules: [],
      references: [],
    };
    const draft = {
      operationId: OPERATION,
      templateId: TEMPLATE,
      title: 'Project seed',
      description: null,
      initialization,
      expiresAt: '2026-09-20T10:00:00Z',
      root: {
        sourceId: ITEM,
        itemType: 'note',
        title: 'Project seed',
        seq: '1',
        properties: {},
        schema: { properties: [], declared: [], inherit: false },
        views: null,
        hasBody: false,
        recurrence: null,
        children: [],
      },
      itemMappings: [],
      bodyCopies: [],
    };
    server.use(
      http.get(`${CORE}/api/v1/templates/${TEMPLATE}`, () => HttpResponse.json(detail())),
      http.post(`${COLLAB}/templates/${TEMPLATE}/drafts`, ({ request }) => {
        urls.push(new URL(request.url).pathname);
        return HttpResponse.json(draft, { status: 201 });
      }),
      http.patch(`${COLLAB}/templates/${TEMPLATE}/drafts/${OPERATION}`, ({ request }) => {
        urls.push(new URL(request.url).pathname);
        return HttpResponse.json(draft);
      }),
      http.post(`${COLLAB}/templates/${TEMPLATE}/drafts/${OPERATION}/save`, ({ request }) => {
        urls.push(new URL(request.url).pathname);
        return HttpResponse.json({ templateId: TEMPLATE });
      }),
    );
    const { resolveProfile } = await import('../config.ts');
    const resolved = await resolveProfile('default', env);
    expect(resolved).not.toBeNull();
    if (resolved === null) return;
    const { openSession } = await import('../session.ts');
    const session = openSession({
      profile: resolved.profile,
      fetchImpl: () =>
        Promise.resolve(
          Response.json({ accessToken: 'jwt-1', tokenType: 'Bearer', expiresInSeconds: 600 }),
        ),
    });

    const result = await executeTemplateInitializationUpdate(
      session,
      TEMPLATE,
      initialization,
      {},
      () => 'edit-key',
    );
    expect(urls).toEqual([
      `/templates/${TEMPLATE}/drafts`,
      `/templates/${TEMPLATE}/drafts/${OPERATION}`,
      `/templates/${TEMPLATE}/drafts/${OPERATION}/save`,
    ]);
    expect(result).toMatchObject({
      template: { revision: 7 },
      resume: { idempotencyKey: `nixctl-template-edit:${TEMPLATE}:edit-key` },
    });
    await done();
  });

  it('refuses ambiguous resume keys without re-preflighting a changed catalog', async () => {
    await expect(
      executeTemplateApply(
        openSession({
          profile: { apiUrl: CORE, collabUrl: COLLAB, token: 'nixpat_abc' },
          fetchImpl: () =>
            Promise.resolve(
              Response.json({ accessToken: 'jwt-1', tokenType: 'Bearer', expiresInSeconds: 600 }),
            ),
        }),
        { templateId: TEMPLATE, mode: 'create', idempotencyKey: 'retry-key' },
      ),
    ).rejects.toThrow(/original expected revision/i);
  });
});
