import { describe, expect, it } from 'vitest';
import { NixApiError, type TemplateDetail } from '@nix/api-client';
import { saveSpecSchema } from '@nix/structure-spec';
import { createFakePorts } from '../testing/fake-ports.js';
import { saveAsTemplate } from './save.js';
import { loadPreviewContext } from '../context.js';
import { describeToolCall } from '../preview.js';
import { workspaceToolSchema } from '../tool-args.js';

const workspace = '11111111-1111-4111-8111-111111111111';
const rootId = '22222222-2222-4222-8222-222222222222';
const regularId = '33333333-3333-4333-8333-333333333333';
const sampleId = '44444444-4444-4444-8444-444444444444';
const sampleChildId = '55555555-5555-4555-8555-555555555555';
const templateId = '66666666-6666-4666-8666-666666666666';
const fullFingerprint = 'a'.repeat(64);
const projectedFingerprint = 'b'.repeat(64);

function capturePreview(endpoint: { path?: string }) {
  const excluded = endpoint.path?.includes('excludeSampleDescendants=true') ?? false;
  return {
    fingerprint: fullFingerprint,
    captureFingerprint: excluded ? projectedFingerprint : fullFingerprint,
    sourceTitle: 'Plan',
    itemCount: excluded ? 2 : 4,
  };
}

function item(id: string, title: string, parentId: string | null, seq: string) {
  return { id, workspaceId: workspace, title, parentId, seq, type: 'note', hasChildren: false };
}

function detail(): TemplateDetail {
  return {
    id: templateId,
    workspaceId: workspace,
    title: 'Captured plan',
    description: null,
    origin: 'user',
    revision: 1,
    includeBody: true,
    includeChildren: true,
    fieldCount: 0,
    viewCount: 0,
    childCount: 1,
    viewKinds: [],
    capabilities: { canEdit: true, canDelete: true, canExport: true, canApply: true },
    updatedAt: '2026-09-26T00:00:00Z',
    initialization: { version: 1, inputs: [], rules: [], references: [] },
    root: {
      sourceId: rootId,
      itemType: 'note',
      title: 'Captured plan',
      seq: '1',
      properties: null,
      schema: null,
      views: null,
      hasBody: true,
      recurrence: null,
      children: [
        {
          sourceId: regularId,
          itemType: 'note',
          title: 'Prepare',
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

function setup(
  preview: (endpoint: { path?: string }) => ReturnType<typeof capturePreview> = capturePreview,
) {
  const fake = createFakePorts();
  const rows = new Map([
    [rootId, item(rootId, 'Plan', null, '1')],
    [regularId, item(regularId, 'Prepare', rootId, '1')],
    [sampleId, item(sampleId, 'Sample: example', rootId, '2')],
    [sampleChildId, item(sampleChildId, 'Nested sample', sampleId, '1')],
  ]);
  const calls: string[] = [];
  let captureBody: unknown;
  fake.query.mockImplementation((endpoint: { operation: string; path?: string }) => {
    if (endpoint.operation === 'templates.capture.preview')
      return Promise.resolve(preview(endpoint));
    if (endpoint.operation === 'items.get')
      return Promise.resolve(
        [...rows.values()].find((row) => endpoint.path?.includes(row.id)) ?? rows.get(rootId),
      );
    if (endpoint.operation === 'locks.get')
      return Promise.resolve({
        locked: false,
        unlockedUntil: null,
        lockItemId: null,
        selfLocked: false,
      });
    if (endpoint.operation === 'templates.get') return Promise.resolve(detail());
    throw new Error(`unexpected query ${endpoint.operation}`);
  });
  fake.paginate.mockImplementation(
    (endpoint: { operation: string; query?: { parentId?: string } }) => {
      const parent = endpoint.query?.parentId;
      const children = [...rows.values()].filter((row) => row.parentId === parent);
      return {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield* children;
        },
      };
    },
  );
  fake.execute.mockImplementation(
    (endpoint: { operation: string; body?: unknown; path?: string }) => {
      const id = [...rows.keys()].find((rowId) => endpoint.path?.includes(rowId));
      calls.push(endpoint.operation + (id ? `:${id}` : ''));
      if (endpoint.operation === 'items.delete') return Promise.resolve({});
      if (endpoint.operation === 'items.restore') return Promise.resolve({});
      if (endpoint.operation === 'templates.capture') {
        captureBody = endpoint.body;
        return Promise.resolve({
          templateId,
          operationId: '77777777-7777-4777-8777-777777777777',
          writtenTargetItemIds: [],
        });
      }
      throw new Error(`unexpected execute ${endpoint.operation}`);
    },
  );
  return { ...fake, calls, getCaptureBody: () => captureBody };
}

describe('save_as_template', () => {
  it('accepts an empty specJson and previews default sample exclusion', async () => {
    const fake = setup();
    const args = workspaceToolSchema.parse({
      operation: 'save_as_template',
      itemId: rootId,
      parentId: '',
      title: 'Captured plan',
      markdown: '',
      query: '',
      propertiesJson: '',
      specJson: '',
    });
    const preview = await loadPreviewContext(fake.ports, workspace, args, fake.signal);
    expect(preview.sourceItemCount).toBe(2);
    expect(preview.sampleCount).toBe(2);
    expect(preview.captureFingerprint).toBe(projectedFingerprint);
    expect(describeToolCall(args, preview).headline).toContain('2 example entries are left out');
    expect(() => workspaceToolSchema.parse({ ...args, itemId: '' })).toThrow();
  });

  it.each([
    [{}, 2],
    [{ includeSamples: true }, 4],
  ])('previews the actual item count for sample setting %j', async (spec, expected) => {
    const fake = setup();
    const preview = await loadPreviewContext(
      fake.ports,
      workspace,
      workspaceToolSchema.parse({
        operation: 'save_as_template',
        itemId: rootId,
        parentId: '',
        title: 'Captured plan',
        markdown: '',
        query: '',
        propertiesJson: '',
        specJson: JSON.stringify(spec),
      }),
      fake.signal,
    );
    expect(preview.sourceItemCount).toBe(expected);
    expect(preview.sampleCount).toBe(2);
    expect(preview.fingerprint).toBe(fullFingerprint);
    expect(preview.captureFingerprint).toBe(
      'includeSamples' in spec && spec.includeSamples ? fullFingerprint : projectedFingerprint,
    );
  });
  it('refuses a preview assembled from two different source snapshots', async () => {
    const fake = setup((endpoint) => ({
      ...capturePreview(endpoint),
      fingerprint: endpoint.path?.includes('excludeSampleDescendants=true')
        ? 'c'.repeat(64)
        : fullFingerprint,
    }));
    await expect(
      loadPreviewContext(
        fake.ports,
        workspace,
        workspaceToolSchema.parse({
          operation: 'save_as_template',
          itemId: rootId,
          parentId: '',
          title: 'Captured plan',
          markdown: '',
          query: '',
          propertiesJson: '',
          specJson: '{}',
        }),
        fake.signal,
      ),
    ).rejects.toThrow('source changed');
  });
  it('trashes sample descendants before capture, restores parent first, and uses the pet key', async () => {
    const fake = setup();
    const result = await saveAsTemplate(
      fake.ports,
      workspace,
      { itemId: rootId, title: 'Captured plan', spec: saveSpecSchema.parse({}) },
      {
        toolId: 'tool-1',
        claimId: 'claim-1',
        approvedFingerprint: fullFingerprint,
        captureFingerprint: projectedFingerprint,
      },
      fake.signal,
    );
    const captureIndex = fake.calls.indexOf('templates.capture');
    expect(fake.calls.indexOf(`items.delete:${sampleChildId}`)).toBeLessThan(
      fake.calls.indexOf(`items.delete:${sampleId}`),
    );
    expect(fake.calls.indexOf(`items.delete:${sampleId}`)).toBeLessThan(captureIndex);
    expect(fake.calls.indexOf(`items.restore:${sampleId}`)).toBeGreaterThan(captureIndex);
    expect(fake.calls.indexOf(`items.restore:${sampleId}`)).toBeLessThan(
      fake.calls.indexOf(`items.restore:${sampleChildId}`),
    );
    expect((fake.getCaptureBody() as { idempotencyKey: string }).idempotencyKey).toBe(
      'pet:tool-1:claim-1',
    );
    expect(fake.getCaptureBody()).toMatchObject({ expectedFingerprint: projectedFingerprint });
    expect(result).toMatchObject({
      templateId,
      itemCount: 2,
      includedSamples: false,
      savedWithInputs: false,
    });
  });

  it('captures a plain include-samples save from the preview without walking children', async () => {
    const fake = setup();
    const result = await saveAsTemplate(
      fake.ports,
      workspace,
      {
        itemId: rootId,
        title: 'Captured plan',
        spec: saveSpecSchema.parse({ includeSamples: true }),
      },
      {
        toolId: 'tool-1',
        claimId: 'claim-1',
        approvedFingerprint: fullFingerprint,
        captureFingerprint: fullFingerprint,
      },
      fake.signal,
    );
    expect(fake.paginate).not.toHaveBeenCalled();
    expect(fake.calls).not.toContain(`items.delete:${sampleId}`);
    expect(fake.getCaptureBody()).toMatchObject({ expectedFingerprint: fullFingerprint });
    expect(result).toMatchObject({ templateId, includedSamples: true, savedWithInputs: false });
  });

  it('refuses a changed Sample descendant before trash or capture', async () => {
    const fake = setup((endpoint) => ({
      ...capturePreview(endpoint),
      fingerprint: 'c'.repeat(64),
    }));
    await expect(
      saveAsTemplate(
        fake.ports,
        workspace,
        { itemId: rootId, title: 'Captured plan', spec: saveSpecSchema.parse({}) },
        {
          toolId: 'tool-1',
          claimId: 'claim-1',
          approvedFingerprint: fullFingerprint,
          captureFingerprint: projectedFingerprint,
        },
        fake.signal,
      ),
    ).rejects.toThrow('source changed');
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('refuses a changed projected capture before trash or capture', async () => {
    const fake = setup((endpoint) => ({
      ...capturePreview(endpoint),
      captureFingerprint: 'c'.repeat(64),
    }));
    await expect(
      saveAsTemplate(
        fake.ports,
        workspace,
        { itemId: rootId, title: 'Captured plan', spec: saveSpecSchema.parse({}) },
        {
          toolId: 'tool-1',
          claimId: 'claim-1',
          approvedFingerprint: fullFingerprint,
          captureFingerprint: projectedFingerprint,
        },
        fake.signal,
      ),
    ).rejects.toThrow('source changed');
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('includes samples when approved and pins the full capture fingerprint', async () => {
    const fake = setup();
    const result = await saveAsTemplate(
      fake.ports,
      workspace,
      {
        itemId: rootId,
        title: 'Captured plan',
        spec: saveSpecSchema.parse({ includeSamples: true }),
      },
      {
        toolId: 'tool-1',
        claimId: 'claim-1',
        approvedFingerprint: fullFingerprint,
        captureFingerprint: fullFingerprint,
      },
      fake.signal,
    );
    expect(fake.calls).not.toContain('items.delete');
    expect(fake.getCaptureBody()).toMatchObject({ expectedFingerprint: fullFingerprint });
    expect(result).toMatchObject({ includedSamples: true });
  });

  it('reports failed restorations and never retries them', async () => {
    const fake = setup();
    fake.execute.mockImplementation(
      (endpoint: { operation: string; body?: unknown; path?: string }) => {
        const id = [rootId, regularId, sampleId, sampleChildId].find((rowId) =>
          endpoint.path?.includes(rowId),
        );
        fake.calls.push(endpoint.operation + (id ? `:${id}` : ''));
        if (endpoint.operation === 'items.delete') return Promise.resolve({});
        if (endpoint.operation === 'items.restore' && endpoint.path?.includes(sampleId))
          throw new Error('restore failed');
        if (endpoint.operation === 'items.restore') return Promise.resolve({});
        if (endpoint.operation === 'templates.capture')
          return Promise.resolve({
            templateId,
            operationId: '77777777-7777-4777-8777-777777777777',
            writtenTargetItemIds: [],
          });
        throw new Error(`unexpected execute ${endpoint.operation}`);
      },
    );
    const result = await saveAsTemplate(
      fake.ports,
      workspace,
      { itemId: rootId, title: 'Captured plan', spec: saveSpecSchema.parse({}) },
      {
        toolId: 'tool-1',
        claimId: 'claim-1',
        approvedFingerprint: fullFingerprint,
        captureFingerprint: projectedFingerprint,
      },
      fake.signal,
    );
    expect(result.restoreFailures).toEqual([sampleId]);
    expect(fake.calls.filter((call) => call === `items.restore:${sampleId}`)).toHaveLength(1);
  });

  it('restores an item when trash committed but its response failed', async () => {
    const fake = setup();
    const deleteFailure = new Error('connection dropped after delete committed');
    fake.execute.mockImplementation((endpoint: { operation: string; path?: string }) => {
      const id = [sampleId, sampleChildId].find((rowId) => endpoint.path?.includes(rowId));
      fake.calls.push(endpoint.operation + (id ? `:${id}` : ''));
      if (endpoint.operation === 'items.delete') throw deleteFailure;
      if (endpoint.operation === 'items.restore') return Promise.resolve({});
      throw new Error(`unexpected execute ${endpoint.operation}`);
    });
    await expect(
      saveAsTemplate(
        fake.ports,
        workspace,
        { itemId: rootId, title: 'Captured plan', spec: saveSpecSchema.parse({}) },
        {
          toolId: 'tool-1',
          claimId: 'claim-1',
          approvedFingerprint: fullFingerprint,
          captureFingerprint: projectedFingerprint,
        },
        fake.signal,
      ),
    ).rejects.toBe(deleteFailure);
    expect(fake.calls).toContain(`items.restore:${sampleChildId}`);
    expect(fake.calls.filter((call) => call === `items.restore:${sampleChildId}`)).toHaveLength(1);
    expect(fake.calls).not.toContain('templates.capture');
  });

  it('surfaces the Core lock refusal message verbatim after restoring samples', async () => {
    const fake = setup();
    const locked = NixApiError.operation(
      'templates.source_locked',
      'This item or something under it is locked. Remove the lock before saving it as a template.',
      false,
    );
    fake.execute.mockImplementation((endpoint: { operation: string; path?: string }) => {
      if (endpoint.operation === 'items.delete') return Promise.resolve({});
      if (endpoint.operation === 'items.restore') return Promise.resolve({});
      if (endpoint.operation === 'templates.capture') throw locked;
      throw new Error(`unexpected execute ${endpoint.operation}`);
    });
    await expect(
      saveAsTemplate(
        fake.ports,
        workspace,
        { itemId: rootId, title: 'Captured plan', spec: saveSpecSchema.parse({}) },
        {
          toolId: 'tool-1',
          claimId: 'claim-1',
          approvedFingerprint: fullFingerprint,
          captureFingerprint: projectedFingerprint,
        },
        fake.signal,
      ),
    ).rejects.toThrow(locked.message);
  });

  it('reports a pinned snapshot conflict after restoring excluded samples', async () => {
    const fake = setup();
    const conflict = NixApiError.operation(
      'templates.conflict',
      'The approved source snapshot changed. No template was saved.',
      false,
    );
    fake.execute.mockImplementation((endpoint: { operation: string }) => {
      fake.calls.push(endpoint.operation);
      if (endpoint.operation === 'items.delete' || endpoint.operation === 'items.restore')
        return Promise.resolve({});
      if (endpoint.operation === 'templates.capture') throw conflict;
      throw new Error(`unexpected execute ${endpoint.operation}`);
    });
    await expect(
      saveAsTemplate(
        fake.ports,
        workspace,
        { itemId: rootId, title: 'Captured plan', spec: saveSpecSchema.parse({}) },
        {
          toolId: 'tool-1',
          claimId: 'claim-1',
          approvedFingerprint: fullFingerprint,
          captureFingerprint: projectedFingerprint,
        },
        fake.signal,
      ),
    ).rejects.toThrow(conflict.message);
    expect(fake.calls.filter((call) => call === 'items.restore')).toHaveLength(2);
  });

  it('refuses a locked Sample subtree before temporary trash can hide it from Core', async () => {
    const fake = setup();
    fake.query.mockImplementation((endpoint: { operation: string; path?: string }) => {
      if (endpoint.operation === 'templates.capture.preview')
        return Promise.resolve(capturePreview(endpoint));
      if (endpoint.operation === 'items.get')
        return Promise.resolve(
          endpoint.path?.includes(rootId)
            ? item(rootId, 'Plan', null, '1')
            : item(sampleId, 'Sample: example', rootId, '2'),
        );
      if (endpoint.operation === 'locks.get')
        return Promise.resolve({
          locked: true,
          unlockedUntil: null,
          lockItemId: sampleId,
          selfLocked: endpoint.path?.includes(sampleId) ?? false,
        });
      throw new Error(`unexpected query ${endpoint.operation}`);
    });
    await expect(
      saveAsTemplate(
        fake.ports,
        workspace,
        { itemId: rootId, title: 'Captured plan', spec: saveSpecSchema.parse({}) },
        {
          toolId: 'tool-1',
          claimId: 'claim-1',
          approvedFingerprint: fullFingerprint,
          captureFingerprint: projectedFingerprint,
        },
        fake.signal,
      ),
    ).rejects.toThrow(
      'This item or something under it is locked. Remove the lock before saving it as a template.',
    );
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('maps blueprint node ids to captured source ids by tree position and saves initialization', async () => {
    const fake = setup();
    const capturedDetail = detail();
    const firstChild = capturedDetail.root.children[0];
    if (firstChild === undefined) throw new Error('missing test child');
    firstChild.schema = {
      properties: [
        {
          key: 'due',
          label: 'Due date',
          type: 'date',
          options: [],
          required: false,
          expression: null,
          aggregate: null,
          source: null,
          choiceSource: null,
        },
      ],
      declared: [
        {
          key: 'due',
          label: 'Due date',
          type: 'date',
          options: [],
          required: false,
          expression: null,
          aggregate: null,
          source: null,
          choiceSource: null,
        },
      ],
      inherit: true,
    };
    fake.query.mockImplementation((endpoint: { operation: string; path?: string }) => {
      if (endpoint.operation === 'templates.capture.preview')
        return Promise.resolve(capturePreview(endpoint));
      if (endpoint.operation === 'items.get')
        return Promise.resolve(item(rootId, 'Plan', null, '1'));
      if (endpoint.operation === 'locks.get')
        return Promise.resolve({
          locked: false,
          unlockedUntil: null,
          lockItemId: null,
          selfLocked: false,
        });
      if (endpoint.operation === 'templates.get') return Promise.resolve(capturedDetail);
      throw new Error(`unexpected query ${endpoint.operation}`);
    });
    const bodies: { operation: string; body?: unknown }[] = [];
    fake.execute.mockImplementation((endpoint: { operation: string; body?: unknown }) => {
      bodies.push(endpoint);
      if (endpoint.operation === 'templates.capture')
        return Promise.resolve({
          templateId,
          operationId: '77777777-7777-4777-8777-777777777777',
          writtenTargetItemIds: [],
        });
      if (endpoint.operation === 'templates.drafts.begin')
        return Promise.resolve({ operationId: '88888888-8888-4888-8888-888888888888' });
      return Promise.resolve({});
    });
    const result = await saveAsTemplate(
      fake.ports,
      workspace,
      {
        itemId: rootId,
        title: 'Captured plan',
        spec: saveSpecSchema.parse({
          inputs: [{ key: 'due', label: 'Due date', type: 'date' }],
          rules: [{ node: 'task', field: 'due', kind: 'input', input: 'due' }],
        }),
      },
      {
        toolId: 'tool-1',
        claimId: 'claim-1',
        approvedFingerprint: fullFingerprint,
        captureFingerprint: projectedFingerprint,
        buildLedger: [{ nodeId: 'task', itemId: regularId, status: 'created' }],
      },
      fake.signal,
    );
    const update = bodies.find((entry) => entry.operation === 'templates.drafts.update')?.body as {
      initialization: { rules: { sourceId: string; propertyKey: string }[] };
    };
    expect(result.reason).toBeUndefined();
    expect(update.initialization.rules).toEqual([
      { sourceId: regularId, propertyKey: 'due', kind: 'input', inputKey: 'due' },
    ]);
    expect(bodies.some((entry) => entry.operation === 'templates.drafts.save')).toBe(true);
    expect(result.savedWithInputs).toBe(true);
  });

  it('discards the draft and reports a positional mismatch without losing the captured template', async () => {
    const fake = setup();
    const capturedDetail = detail();
    const firstChild = capturedDetail.root.children[0];
    if (firstChild === undefined) throw new Error('missing test child');
    firstChild.title = 'Different position';
    fake.query.mockImplementation((endpoint: { operation: string; path?: string }) => {
      if (endpoint.operation === 'templates.capture.preview')
        return Promise.resolve(capturePreview(endpoint));
      if (endpoint.operation === 'items.get')
        return Promise.resolve(item(rootId, 'Plan', null, '1'));
      if (endpoint.operation === 'locks.get')
        return Promise.resolve({
          locked: false,
          unlockedUntil: null,
          lockItemId: null,
          selfLocked: false,
        });
      if (endpoint.operation === 'templates.get') return Promise.resolve(capturedDetail);
      throw new Error(`unexpected query ${endpoint.operation}`);
    });
    const operations: string[] = [];
    fake.execute.mockImplementation((endpoint: { operation: string }) => {
      operations.push(endpoint.operation);
      if (endpoint.operation === 'templates.capture')
        return Promise.resolve({
          templateId,
          operationId: '77777777-7777-4777-8777-777777777777',
          writtenTargetItemIds: [],
        });
      if (endpoint.operation === 'templates.drafts.begin')
        return Promise.resolve({ operationId: '88888888-8888-4888-8888-888888888888' });
      return Promise.resolve({});
    });
    const result = await saveAsTemplate(
      fake.ports,
      workspace,
      {
        itemId: rootId,
        title: 'Captured plan',
        spec: saveSpecSchema.parse({ inputs: [{ key: 'due', label: 'Due date', type: 'date' }] }),
      },
      {
        toolId: 'tool-1',
        claimId: 'claim-1',
        approvedFingerprint: fullFingerprint,
        captureFingerprint: projectedFingerprint,
      },
      fake.signal,
    );
    expect(operations).toContain('templates.drafts.discard');
    expect(operations).not.toContain('templates.drafts.save');
    expect(result).toMatchObject({ templateId, savedWithInputs: false });
    expect(result.reason).toContain('mismatch');
  });
});
