import { describe, expect, it } from 'vitest';
import { templateApplicationRequestSchema } from '@nix/api-client';
import { createFakePorts } from '../testing/fake-ports.js';
import { applyTemplate } from './apply.js';
import { listTemplates } from './list.js';
import { readTemplate } from './read.js';

const workspace = '11111111-1111-4111-8111-111111111111';
const templateId = '22222222-2222-4222-8222-222222222222';
const parentId = '33333333-3333-4333-8333-333333333333';

function catalogWith(
  overrides: Partial<{
    id: string;
    title: string;
    description: string | null;
    origin: string;
    fieldCount: number;
    viewKinds: string[];
    childCount: number;
  }>,
) {
  return {
    templates: [
      {
        id: templateId,
        title: 'Reading log',
        description: 'Track books',
        origin: 'user',
        fieldCount: 3,
        viewKinds: ['board'],
        childCount: 2,
        ...overrides,
      },
    ],
    capabilities: { canManage: true },
  };
}

function templateDetail() {
  return {
    id: templateId,
    workspaceId: workspace,
    title: 'Reading log',
    description: 'Track books',
    origin: 'user',
    revision: 1,
    includeBody: true,
    includeChildren: true,
    fieldCount: 3,
    viewCount: 1,
    childCount: 2,
    viewKinds: ['board'],
    capabilities: { canEdit: true, canDelete: true, canExport: true, canApply: true },
    updatedAt: '2026-09-25T00:00:00.000Z',
    initialization: {
      version: 1,
      inputs: [{ key: 'due', label: 'Due date', type: 'date', required: true, defaultValue: null }],
      rules: [],
      references: [],
    },
    root: {
      sourceId: templateId,
      itemType: 'note',
      title: 'Reading log',
      seq: '1',
      properties: { status: 'Draft' },
      schema: {
        properties: [],
        declared: [{ key: 'status', label: 'Status', type: 'select' }],
        inherit: true,
      },
      views: { views: [{ id: 'board', kind: 'board' }], default: 'board' },
      hasBody: true,
      recurrence: null,
      children: [
        {
          sourceId: 'child-1',
          itemType: 'note',
          title: 'Sample: Dune',
          seq: '1',
          properties: null,
          schema: null,
          views: null,
          hasBody: false,
          recurrence: null,
          children: [],
        },
      ],
    },
  };
}

function queryByOperation(map: Record<string, unknown>) {
  return (endpoint: { operation: string }) => {
    if (!(endpoint.operation in map)) throw new Error(`unexpected query ${endpoint.operation}`);
    return Promise.resolve(map[endpoint.operation]);
  };
}

describe('list_templates', () => {
  it('filters and caps at 50', async () => {
    const { ports, query, signal } = createFakePorts();
    query.mockImplementation(
      queryByOperation({
        'templates.list': {
          templates: Array.from({ length: 55 }, (_, index) => ({
            id: `id-${String(index)}`,
            title: index === 0 ? 'Reading log' : `Other ${String(index)}`,
            description: null,
            origin: 'user',
            fieldCount: 0,
            viewKinds: [],
            childCount: 0,
          })),
          capabilities: { canManage: true },
        },
      }),
    );
    const all = await listTemplates(ports, workspace, '', signal);
    expect(all.templates).toHaveLength(50);
    expect(all.truncated).toBe(true);

    const filtered = await listTemplates(ports, workspace, 'reading', signal);
    expect(filtered.templates).toHaveLength(1);
    expect(filtered.templates[0]?.title).toBe('Reading log');
    expect(filtered.truncated).toBe(false);
  });
});

describe('read_template', () => {
  it('refuses a template not in this workspace catalog', async () => {
    const { ports, query, signal } = createFakePorts();
    query.mockImplementation(
      queryByOperation({ 'templates.list': catalogWith({ id: 'not-this-one' }) }),
    );
    await expect(readTemplate(ports, workspace, templateId, signal)).rejects.toThrow('outside');
  });
  it('returns a bounded outline with no bodies or property values', async () => {
    const { ports, query, signal } = createFakePorts();
    query.mockImplementation(
      queryByOperation({
        'templates.list': catalogWith({}),
        'templates.get': templateDetail(),
      }),
    );
    const outline = await readTemplate(ports, workspace, templateId, signal);
    expect(outline.title).toBe('Reading log');
    expect(outline.inputs).toEqual([
      { key: 'due', label: 'Due date', type: 'date', required: true },
    ]);
    expect(outline.tree).toHaveLength(1);
    expect(outline.tree[0]?.fields).toEqual([{ key: 'status', type: 'select' }]);
    expect(outline.tree[0]?.viewKinds).toEqual(['board']);
    expect(outline.tree[0]?.children[0]?.title).toBe('Sample: Dune');
    expect(JSON.stringify(outline)).not.toContain('Draft');
    expect(JSON.stringify(outline)).not.toContain('hasBody');
  });
});

describe('apply_template', () => {
  it('never runs without toolId and claimId', async () => {
    const { ports, signal } = createFakePorts();
    await expect(
      applyTemplate(
        ports,
        workspace,
        { templateId, parentId: null, title: 'Reading log' },
        { toolId: undefined, claimId: undefined },
        signal,
      ),
    ).rejects.toThrow('A claimed tool id is required.');
  });
  it('runs preflight first and refuses on conflicts', async () => {
    const { ports, query, execute, signal } = createFakePorts();
    query.mockImplementation(queryByOperation({ 'templates.list': catalogWith({}) }));
    execute.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'templates.preflight') {
        return Promise.resolve({
          templateId,
          templateRevision: 1,
          mode: 'create',
          additions: { fields: 0, views: 0, items: 0 },
          conflicts: ['A field named Status already exists.'],
          canApply: false,
          initializationPreview: [],
          resolvedInputs: {},
          textBindings: {},
          referenceMappings: {},
        });
      }
      throw new Error(`unexpected execute ${endpoint.operation}`);
    });
    await expect(
      applyTemplate(
        ports,
        workspace,
        { templateId, parentId: null, title: 'Reading log' },
        { toolId: 'tool-1', claimId: 'claim-1' },
        signal,
      ),
    ).rejects.toThrow('cannot be applied here');
    expect(execute).toHaveBeenCalledOnce();
  });
  it('rejects a destination outside this workspace before preflight', async () => {
    const { ports, query, execute, signal } = createFakePorts();
    query.mockImplementation(
      queryByOperation({
        'templates.list': catalogWith({}),
        'items.get': { id: parentId, workspaceId: 'another-workspace', type: 'note' },
      }),
    );
    await expect(
      applyTemplate(
        ports,
        workspace,
        { templateId, parentId, title: 'Reading log' },
        { toolId: 'tool-1', claimId: 'claim-1' },
        signal,
      ),
    ).rejects.toThrow('outside this workspace');
    expect(execute).not.toHaveBeenCalled();
  });
  it('uses the pet idempotency key and reports alreadyApplied', async () => {
    const { ports, query, execute, signal } = createFakePorts();
    query.mockImplementation(
      queryByOperation({
        'templates.list': catalogWith({}),
        'items.get': { id: parentId, workspaceId: workspace, type: 'note' },
      }),
    );
    let capturedKey = '';
    execute.mockImplementation((endpoint: { operation: string; body?: unknown }) => {
      if (endpoint.operation === 'templates.preflight') {
        return Promise.resolve({
          templateId,
          templateRevision: 1,
          mode: 'create',
          additions: { fields: 0, views: 0, items: 0 },
          conflicts: [],
          canApply: true,
          initializationPreview: [],
          resolvedInputs: {},
          textBindings: {},
          referenceMappings: {},
        });
      }
      if (endpoint.operation === 'templates.apply') {
        const request = templateApplicationRequestSchema.parse(endpoint.body);
        capturedKey = request.idempotencyKey;
        expect(request.expectedRevision).toBe(1);
        return Promise.resolve({
          applicationId: '44444444-4444-4444-8444-444444444444',
          templateId,
          targetItemId: parentId,
          alreadyApplied: true,
          createdItems: [{ sourceId: templateId, itemId: parentId, itemType: 'note' }],
          resolvedInputs: {},
          textBindings: {},
          referenceMappings: {},
          writtenTargetItemIds: [],
        });
      }
      throw new Error(`unexpected execute ${endpoint.operation}`);
    });
    const result = await applyTemplate(
      ports,
      workspace,
      { templateId, parentId, title: 'Reading log' },
      { toolId: 'tool-1', claimId: 'claim-1' },
      signal,
    );
    expect(capturedKey).toMatch(/^pet:[0-9a-f]{64}$/);
    expect(capturedKey.length).toBeLessThan(160);
    expect(result).toEqual({ rootId: parentId, createdCount: 1, alreadyApplied: true });
  });
  it.each([undefined, 9])(
    'applies only the known reviewed preflight revision (%s)',
    async (expectedRevision) => {
      const { ports, query, execute, signal } = createFakePorts();
      query.mockImplementation(queryByOperation({ 'templates.list': catalogWith({}) }));
      let submittedRevision: number | undefined;
      execute.mockImplementation((endpoint: { operation: string; body?: unknown }) => {
        if (endpoint.operation !== 'templates.apply')
          throw new Error('A reviewed template must not be preflighted again.');
        submittedRevision = templateApplicationRequestSchema.parse(endpoint.body).expectedRevision;
        return Promise.resolve({
          applicationId: '44444444-4444-4444-8444-444444444444',
          templateId,
          targetItemId: parentId,
          alreadyApplied: false,
          createdItems: [],
          resolvedInputs: {},
          textBindings: {},
          referenceMappings: {},
          writtenTargetItemIds: [],
        });
      });
      await applyTemplate(
        ports,
        workspace,
        { templateId, parentId: null, title: 'Reading log' },
        { toolId: 'tool-1', claimId: 'claim-1' },
        signal,
        {
          templateId,
          templateRevision: 7,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
          mode: 'create',
          additions: { fields: 0, views: 0, items: 0 },
          conflicts: [],
          canApply: true,
          initializationPreview: [],
          resolvedInputs: {},
          textBindings: {},
          referenceMappings: {},
        },
      );
      expect(submittedRevision).toBe(expectedRevision ?? 7);
      expect(execute).toHaveBeenCalledOnce();
    },
  );
  it('refuses a template not in this workspace catalog before any preflight or apply call', async () => {
    const { ports, query, execute, signal } = createFakePorts();
    query.mockImplementation(
      queryByOperation({ 'templates.list': catalogWith({ id: 'not-this-one' }) }),
    );
    await expect(
      applyTemplate(
        ports,
        workspace,
        { templateId, parentId: null, title: 'Reading log' },
        { toolId: 'tool-1', claimId: 'claim-1' },
        signal,
      ),
    ).rejects.toThrow('outside this workspace');
    expect(execute).not.toHaveBeenCalled();
  });
  it('resumes a pending file transfer and reports the completed result', async () => {
    const { ports, query, execute, signal } = createFakePorts();
    query.mockImplementation(
      queryByOperation({
        'templates.list': catalogWith({}),
        'operations.get': { id: 'job-1', status: 'completed' },
      }),
    );
    let applyCalls = 0;
    execute.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'templates.preflight') {
        return Promise.resolve({
          templateId,
          templateRevision: 1,
          mode: 'create',
          additions: { fields: 0, views: 0, items: 0 },
          conflicts: [],
          canApply: true,
          initializationPreview: [],
          resolvedInputs: {},
          textBindings: {},
          referenceMappings: {},
        });
      }
      if (endpoint.operation === 'templates.apply') {
        applyCalls++;
        return Promise.resolve(
          applyCalls === 1
            ? {
                applicationId: '44444444-4444-4444-8444-444444444444',
                templateId,
                targetItemId: parentId,
                alreadyApplied: false,
                createdItems: [],
                resolvedInputs: {},
                textBindings: {},
                referenceMappings: {},
                writtenTargetItemIds: [],
                fileTransferJobId: 'job-1',
                fileTransferPending: true,
              }
            : {
                applicationId: '44444444-4444-4444-8444-444444444444',
                templateId,
                targetItemId: parentId,
                alreadyApplied: false,
                createdItems: [{ sourceId: templateId, itemId: parentId, itemType: 'note' }],
                resolvedInputs: {},
                textBindings: {},
                referenceMappings: {},
                writtenTargetItemIds: [],
                fileTransferPending: false,
              },
        );
      }
      throw new Error(`unexpected execute ${endpoint.operation}`);
    });
    const result = await applyTemplate(
      ports,
      workspace,
      { templateId, parentId: null, title: 'Reading log' },
      { toolId: 'tool-1', claimId: 'claim-1' },
      signal,
    );
    expect(applyCalls).toBe(2);
    expect(result).toEqual({ rootId: parentId, createdCount: 1, alreadyApplied: false });
  });
  it('does not report success when the file-transfer job fails', async () => {
    const { ports, query, execute, signal } = createFakePorts();
    query.mockImplementation(
      queryByOperation({
        'templates.list': catalogWith({}),
        'operations.get': { id: 'job-1', status: 'failed', errorDetail: 'copy failed' },
      }),
    );
    execute.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'templates.preflight') {
        return Promise.resolve({
          templateId,
          templateRevision: 1,
          mode: 'create',
          additions: { fields: 0, views: 0, items: 0 },
          conflicts: [],
          canApply: true,
          initializationPreview: [],
          resolvedInputs: {},
          textBindings: {},
          referenceMappings: {},
        });
      }
      if (endpoint.operation === 'templates.apply') {
        return Promise.resolve({
          applicationId: '44444444-4444-4444-8444-444444444444',
          templateId,
          targetItemId: parentId,
          alreadyApplied: false,
          createdItems: [],
          resolvedInputs: {},
          textBindings: {},
          referenceMappings: {},
          writtenTargetItemIds: [],
          fileTransferJobId: 'job-1',
          fileTransferPending: true,
        });
      }
      throw new Error(`unexpected execute ${endpoint.operation}`);
    });
    await expect(
      applyTemplate(
        ports,
        workspace,
        { templateId, parentId: null, title: 'Reading log' },
        { toolId: 'tool-1', claimId: 'claim-1' },
        signal,
      ),
    ).rejects.toThrow('copy failed');
  });
});
